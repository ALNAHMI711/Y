// Off-site backup targets: the owner registers an HTTPS endpoint that accepts PUT (S3 pre-signed URL prefix,
// WebDAV, Nextcloud, a private storage server...). Every backup is uploaded to all enabled targets.
// SSRF guard: https only, no credentials in URL, and the host must resolve to PUBLIC addresses only.
import dns from 'node:dns/promises';
import net from 'node:net';
import { bad } from './util.js';

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  return true; // unknown format: refuse
}

export async function assertPublicHttps(urlStr, lookup = (h) => dns.lookup(h, { all: true })) {
  let u;
  try { u = new URL(urlStr); } catch { throw bad('رابط غير صالح'); }
  if (u.protocol !== 'https:') throw bad('يجب أن يبدأ الرابط بـ https');
  if (u.username || u.password) throw bad('لا تضع بيانات الدخول داخل الرابط؛ استخدم حقل الرمز');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host).catch(() => { throw bad('تعذر العثور على الخادم'); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw bad('العنوان داخلي أو غير مسموح');
  return u;
}

export async function httpPutUploader({ url, token }, name, body, lookup) {
  const base = await assertPublicHttps(url, lookup); // re-check at upload time
  const target = new URL(encodeURIComponent(name), base.href.endsWith('/') ? base.href : base.href + '/');
  const r = await fetch(target, { method: 'PUT', body, redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
