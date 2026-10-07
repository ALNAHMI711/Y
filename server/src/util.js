import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (m) => new HttpError(400, m);
export const forbidden = (m = 'غير مصرح') => new HttpError(403, m);
export const notFound = (m = 'غير موجود') => new HttpError(404, m);

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- signed tokens (HMAC-SHA256), no external deps ----
export function signToken(payload, secret, ttlSec = 60 * 60 * 24 * 30) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Math.floor(Date.now() / 1000) ? p : null;
}

// ---- password-like secrets (vault codes) via scrypt ----
export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(secret, salt, 32);
  return `${salt.toString('hex')}:${h.toString('hex')}`;
}
export function checkSecret(secret, stored) {
  if (!stored) return false;
  const [s, h] = stored.split(':');
  const calc = crypto.scryptSync(secret, Buffer.from(s, 'hex'), 32);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}

// ---- AES-256-GCM encryption at rest for IDs / contracts ----
export function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(blob, key) {
  const raw = Buffer.from(blob, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ---- tiny router ----
export class Router {
  constructor() { this.routes = []; }
  add(method, path, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route: r, params };
      }
    }
    return null;
  }
}

export async function readJson(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'الطلب كبير جداً');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw bad('JSON غير صالح'); }
}

// simple in-memory rate limiter
export function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now); hits.set(key, arr);
    return arr.length <= max;
  };
}
