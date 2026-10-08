import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import { createServices, parseWalletSms, refHash, normDigits } from './services.js';
import { buildXlsx } from './xlsx.js';
import { anthropicAnalyzer, ruleBasedAnalyzer, normalizeCard } from './copilot.js';
import { createBackup, listBackups, isBackupName } from './backup.js';
import { Router, HttpError, bad, forbidden, notFound, readJson, signToken, verifyToken, hashSecret, checkSecret, encrypt, decrypt, sha256, rateLimiter } from './util.js';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createApp(opts = {}) {
  const db = opts.db ?? openDb(opts.dbPath ?? ':memory:');
  const secret = opts.secret ?? crypto.randomBytes(32).toString('hex');
  const encKey = opts.encKey ?? crypto.randomBytes(32);
  const sender = opts.whatsapp ?? { async send(phone, text) { console.log(`[whatsapp:stub] -> ${phone}: ${text}`); } };
  const backupDir = opts.backupDir ?? null;
  const supportPhone = opts.supportPhone ?? null;
  const ingestKey = opts.ingestKey ?? null;
  const devOtp = opts.devOtp ?? false;
  const adminPhone = opts.adminPhone ?? null;
  const now = opts.now ?? (() => new Date());
  const corsOrigins = ['https://localhost', 'capacitor://localhost', ...(opts.corsOrigins ?? [])];
  db.exec('CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, kind TEXT, target INTEGER, text TEXT, at TEXT DEFAULT (datetime(\'now\')))');
  const notify = (kind, target, text) => db.prepare('INSERT INTO outbox(kind,target,text) VALUES(?,?,?)').run(kind, target, text);
  const S = createServices({ db, now, notify });
  const router = new Router();
  const otpLimit = rateLimiter(opts.otpLimit ?? 5, 10 * 60 * 1000), vaultLimit = rateLimiter(8, 15 * 60 * 1000);
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const intOf = (v, name) => { const n = Number(normDigits(v)); if (!Number.isInteger(n) || n < 0) throw bad(`${name} غير صالح`); return n; };
  const R = (method, p, role, handler) => router.add(method, p, handler, { role });

  // ================= Auth =================
  R('POST', '/api/auth/request-otp', null, async ({ body }) => {
    const phone = String(body.phone || '').replace(/\s/g, '');
    if (!/^\+?\d{8,15}$/.test(phone)) throw bad('رقم هاتف غير صالح');
    if (!otpLimit(phone)) throw new HttpError(429, 'محاولات كثيرة، حاول لاحقاً');
    const code = String(crypto.randomInt(100000, 999999));
    run('INSERT INTO otps(phone,code_hash,expires,attempts) VALUES(?,?,?,0) ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, attempts=0', phone, sha256(code), now().getTime() + 5 * 60000);
    await sender.send(phone, `رمز التحقق الخاص بك: ${code}`);
    return devOtp ? { sent: true, dev_code: code } : { sent: true };
  });
  R('POST', '/api/auth/verify', null, ({ body }) => {
    const phone = String(body.phone || '').replace(/\s/g, '');
    const o = one('SELECT * FROM otps WHERE phone=?', phone);
    if (!o || o.expires < now().getTime()) throw bad('انتهت صلاحية الرمز');
    if (o.attempts >= 5) throw new HttpError(429, 'تجاوزت عدد المحاولات');
    if (sha256(String(body.code)) !== o.code_hash) { run('UPDATE otps SET attempts=attempts+1 WHERE phone=?', phone); throw bad('رمز غير صحيح'); }
    run('DELETE FROM otps WHERE phone=?', phone);
    let u = one('SELECT * FROM users WHERE phone=?', phone);
    if (!u) {
      const name = String(body.name || '').trim();
      if (name.split(/\s+/).length < 4) throw bad('أدخل الاسم الرباعي');
      const role = adminPhone && phone === adminPhone ? 'admin' : 'customer';
      const r = run('INSERT INTO users(name,phone,role) VALUES(?,?,?)', name, phone, role);
      u = one('SELECT * FROM users WHERE id=?', r.lastInsertRowid);
      S.audit(u.id, 'user.register', { phone });
    }
    return { token: signToken({ uid: u.id }, secret), user: { id: u.id, name: u.name, role: u.role } };
  });
  R('GET', '/api/me', 'any', ({ user }) => ({ ...user, balance: one('SELECT balance FROM users WHERE id=?', user.id).balance }));

  // ================= Public catalog =================
  R('GET', '/api/features', null, () => q('SELECT key, enabled, label FROM features'));
  R('GET', '/api/zones', null, () => q('SELECT * FROM zones ORDER BY name'));
  R('GET', '/api/products', null, () => q("SELECT p.id,p.name,p.price,p.stock,p.cod_mode,p.variants,p.image,v.shop_name FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id WHERE p.hidden=0 AND (p.vendor_id IS NULL OR v.status='active') ORDER BY p.id DESC"));
  R('GET', '/api/announcements', null, () => (S.featureOn('announcements') ? q('SELECT * FROM announcements WHERE active=1') : []));
  R('GET', '/api/track/:token', null, ({ params }) => {
    S.requireFeature('live_tracking');
    const o = one('SELECT id,status,driver_id FROM orders WHERE track_token=?', params.token);
    if (!o) throw notFound();
    const loc = o.driver_id && o.status === 'out_for_delivery' ? one('SELECT lat,lng,at FROM driver_locations WHERE driver_id=?', o.driver_id) : null;
    return { order: o.id, status: o.status, driver_location: loc ?? null };
  });
  // offline-first sync: clients pull changes since a cursor
  R('GET', '/api/sync', null, ({ query }) => {
    const since = Number(query.get('since') || 0);
    const seq = one('SELECT COALESCE(MAX(seq),0) m FROM changes').m;
    const rows = q('SELECT DISTINCT entity, entity_id, op FROM changes WHERE seq>?', since);
    const out = { seq, products: [], zones: [], features: since === 0 ? q('SELECT key, enabled, label FROM features') : [], deleted: [] };
    const VIS = "hidden=0 AND (vendor_id IS NULL OR vendor_id IN (SELECT id FROM vendors WHERE status='active'))";
    if (since === 0) { out.products = q(`SELECT id,name,price,stock,cod_mode,variants,image,hidden FROM products WHERE ${VIS}`); out.zones = q('SELECT * FROM zones'); return out; }
    for (const r of rows) {
      if (r.op === 'delete') { out.deleted.push({ entity: r.entity, id: r.entity_id }); continue; }
      if (r.entity === 'products') { const p = one(`SELECT id,name,price,stock,cod_mode,variants,image,hidden FROM products WHERE id=? AND ${VIS}`, r.entity_id); if (p) out.products.push(p); else out.deleted.push({ entity: 'products', id: r.entity_id }); }
      if (r.entity === 'zones') { const z = one('SELECT * FROM zones WHERE id=?', r.entity_id); if (z) out.zones.push(z); }
      if (r.entity === 'features') out.features = q('SELECT key, enabled, label FROM features');
    }
    return out;
  });

  // ================= Customer =================
  R('POST', '/api/addresses', 'any', ({ user, body }) => {
    if (!body.label) throw bad('سمِّ العنوان');
    const lat = body.lat == null ? null : Number(body.lat), lng = body.lng == null ? null : Number(body.lng);
    if ((lat != null && Math.abs(lat) > 90) || (lng != null && Math.abs(lng) > 180)) throw bad('إحداثيات غير صالحة');
    if (body.zone_id && !one('SELECT id FROM zones WHERE id=?', body.zone_id)) throw bad('منطقة غير موجودة');
    const r = run('INSERT INTO addresses(user_id,label,lat,lng,zone_id,details) VALUES(?,?,?,?,?,?)', user.id, body.label, lat, lng, body.zone_id ?? null, body.details ?? null);
    return { id: r.lastInsertRowid };
  });
  R('GET', '/api/addresses', 'any', ({ user }) => q('SELECT * FROM addresses WHERE user_id=?', user.id));
  R('POST', '/api/quote', 'any', ({ user, body }) => {
    const addr = one('SELECT * FROM addresses WHERE id=? AND user_id=?', body.address_id, user.id);
    const zone = addr?.zone_id ? one('SELECT * FROM zones WHERE id=?', addr.zone_id) : null;
    if (!zone) throw bad('اختر منطقة التوصيل');
    let subtotal = 0;
    for (const it of body.items || []) { const p = one('SELECT price FROM products WHERE id=? AND hidden=0', it.product_id); if (!p) throw bad('منتج غير متاح'); subtotal += p.price * Number(it.qty); }
    const shipping = zone.free ? 0 : zone.fee;
    return { subtotal, shipping, total: subtotal + shipping };
  });
  R('POST', '/api/orders', 'any', ({ user, body }) => S.placeOrder(user, body));
  R('GET', '/api/orders', 'any', ({ user }) => q('SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC', user.id));
  R('GET', '/api/orders/:id/invoice', 'any', ({ user, params }) => {
    const o = one('SELECT * FROM orders WHERE id=?', params.id);
    if (!o || (o.customer_id !== user.id && !['admin', 'staff'].includes(user.role))) throw notFound();
    const items = q('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?', o.id);
    return { brand: 'ثقافة وطن للمستلزمات العسكرية', order: o, items, delivery_zone: one('SELECT name FROM zones WHERE id=?', o.zone_id)?.name };
  });
  R('POST', '/api/vendors/:id/follow', 'any', ({ user, params }) => { run('INSERT OR IGNORE INTO vendor_follows VALUES(?,?)', user.id, params.id); return { ok: true }; });
  R('POST', '/api/returns', 'any', ({ user, body }) => {
    const it = one('SELECT oi.*, o.customer_id, o.status FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=?', body.order_item_id);
    if (!it || it.customer_id !== user.id) throw notFound();
    if (it.status !== 'delivered') throw bad('يمكن الإرجاع بعد التسليم فقط');
    if (!['return', 'replace'].includes(body.kind)) throw bad('نوع الطلب غير صالح');
    if (one("SELECT id FROM returns WHERE order_item_id=? AND status IN ('requested','approved')", it.id)) throw bad('يوجد طلب سابق لهذا الصنف');
    const r = run('INSERT INTO returns(order_item_id,customer_id,kind,reason) VALUES(?,?,?,?)', it.id, user.id, body.kind, body.reason ?? null);
    return { id: r.lastInsertRowid };
  });

  // ---- wallet top-up with auto-matching + manual fallback ----
  R('POST', '/api/transfers', 'any', async ({ user, body }) => {
    const amount = intOf(body.amount, 'المبلغ');
    if (amount < 1) throw bad('المبلغ مطلوب');
    const ref = body.ref ? String(body.ref).trim() : null;
    const proof = body.proof_base64 ? Buffer.from(String(body.proof_base64), 'base64') : null;
    if (!ref && !proof) throw bad('أدخل رقم العملية أو أرفق صورة السند');
    const rh = refHash(ref), ph = proof ? sha256(proof.toString('hex')) : null;
    if (rh && one('SELECT id FROM transfers WHERE ref_hash=?', rh)) throw new HttpError(409, 'تم استخدام رقم العملية سابقاً');
    if (ph && one('SELECT id FROM transfers WHERE proof_hash=?', ph)) throw new HttpError(409, 'تم رفع هذا السند سابقاً');
    const r = run('INSERT INTO transfers(user_id,amount,ref,ref_hash,proof_hash,proof_enc) VALUES(?,?,?,?,?,?)', user.id, amount, ref, rh, ph, proof ? encrypt(proof.toString('base64'), encKey) : null);
    S.matchSmsToTransfers();
    const t = one('SELECT id,amount,status FROM transfers WHERE id=?', r.lastInsertRowid);
    if (t.status === 'pending' && supportPhone) await sender.send(supportPhone, `سند تحويل جديد #${t.id} من المستخدم ${user.id} بمبلغ ${amount} — بانتظار الموافقة`);
    return t;
  });
  R('POST', '/api/sms/ingest', null, ({ body, headers }) => {
    if (!ingestKey || headers['x-ingest-key'] !== ingestKey) throw forbidden();
    const p = parseWalletSms(body.text);
    if (!p.credit || !p.amount) return { parsed: false };
    const r = run('INSERT INTO sms_log(body,amount,ref) VALUES(?,?,?)', String(body.text).slice(0, 500), p.amount, p.ref);
    return { parsed: true, matched: S.matchSmsToTransfers(), id: r.lastInsertRowid };
  });
  R('GET', '/api/wallet', 'any', ({ user }) => ({ balance: one('SELECT balance FROM users WHERE id=?', user.id).balance, history: q('SELECT type,amount,ref,at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100', user.id) }));

  // ================= Vendors =================
  R('POST', '/api/vendors/register', 'any', ({ user, body }) => {
    S.requireFeature('vendors');
    const c = body.contract || {};
    for (const k of ['full_name', 'shop_name', 'signature', 'id_number', 'id_front_b64', 'id_back_b64']) if (!c[k]) throw bad(`حقل العقد مطلوب: ${k}`);
    if (one('SELECT id FROM vendors WHERE user_id=?', user.id)) throw bad('لديك حساب تاجر مسبقاً');
    const r = tx(db, () => {
      const v = run('INSERT INTO vendors(user_id,shop_name) VALUES(?,?)', user.id, c.shop_name);
      run('INSERT INTO contracts(vendor_id,data_enc) VALUES(?,?)', v.lastInsertRowid, encrypt(JSON.stringify(c), encKey));
      return v.lastInsertRowid;
    });
    notify('admin', 0, `عقد تاجر جديد للمراجعة: ${c.shop_name}`);
    S.audit(user.id, 'vendor.contract.submit', { vendor: r });
    return { vendor_id: r, status: 'pending' };
  });
  const vendorOf = (user) => { const v = one("SELECT * FROM vendors WHERE user_id=? AND status='active'", user.id); if (!v) throw forbidden('حساب التاجر غير مفعّل'); return v; };
  R('GET', '/api/vendor/me', 'any', ({ user }) => { const v = one('SELECT id,shop_name,status FROM vendors WHERE user_id=?', user.id); return v ?? { status: 'none' }; });
  R('PUT', '/api/vendor/accounts', 'any', ({ user, body }) => {
    const v = vendorOf(user);
    const accs = (body.accounts || []).map((a) => ({ provider: String(a.provider), number: String(a.number) }));
    run('UPDATE vendors SET wallet_accounts=? WHERE id=?', JSON.stringify(accs), v.id);
    S.audit(user.id, 'vendor.accounts.update', { vendor: v.id });
    return { ok: true };
  });
  R('GET', '/api/vendor/statement', 'any', ({ user }) => {
    const v = vendorOf(user);
    return { vendor: { id: v.id, shop_name: v.shop_name, available: v.available, pending: v.pending, wallet_accounts: JSON.parse(v.wallet_accounts) }, escrow: q('SELECT * FROM escrow WHERE vendor_id=? ORDER BY id DESC', v.id), withdrawals: q('SELECT * FROM withdrawals WHERE vendor_id=? ORDER BY id DESC', v.id) };
  });
  R('POST', '/api/vendor/withdraw', 'any', ({ user, body }) => {
    const v = vendorOf(user);
    const accs = JSON.parse(v.wallet_accounts);
    const acc = accs.find((a) => a.number === String(body.account));
    if (!acc) throw bad('اختر حساباً من حساباتك المسجلة');
    return { id: S.queueWithdrawal(v.id, intOf(body.amount, 'المبلغ'), `${acc.provider}:${acc.number}`, user.id) };
  });
  R('POST', '/api/vendor/products', 'any', ({ user, body }) => {
    const v = vendorOf(user);
    return { id: createProduct(user, v.id, body) };
  });
  function createProduct(user, vendorId, b) {
    if (!b.name) throw bad('اسم المنتج مطلوب');
    if (b.variants?.length) S.requireFeature('variants');
    if (b.image != null && b.image !== '' && !(typeof b.image === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.image) && b.image.length <= 600_000)) throw bad('صورة غير صالحة (jpeg/png/webp، حتى 400KB تقريباً)');
    if (intOf(b.price, 'السعر') < 1) throw bad('السعر يجب أن يكون أكبر من صفر');
    const cod = b.cod_mode ?? 'none';
    if (!['none', 'partial', 'full'].includes(cod)) throw bad('cod_mode غير صالح');
    const r = run('INSERT INTO products(vendor_id,name,price,stock,cod_mode,variants,image) VALUES(?,?,?,?,?,?,?)', vendorId, b.name, intOf(b.price, 'السعر'), intOf(b.stock ?? 0, 'المخزون'), cod, JSON.stringify(b.variants ?? []), b.image || null);
    S.change('products', r.lastInsertRowid);
    S.audit(user.id, 'product.create', { id: r.lastInsertRowid });
    if (vendorId) {
      const shop = one('SELECT shop_name FROM vendors WHERE id=?', vendorId)?.shop_name;
      for (const f of q('SELECT user_id FROM vendor_follows WHERE vendor_id=?', vendorId)) notify('user', f.user_id, `منتج جديد من ${shop}: ${b.name}`);
    }
    return r.lastInsertRowid;
  }

  // ================= Admin =================
  const ADMIN = 'staff';
  R('POST', '/api/admin/products', ADMIN, ({ user, body }) => ({ id: createProduct(user, body.vendor_id ?? null, body) }));
  R('PUT', '/api/admin/products/:id', ADMIN, ({ user, params, body }) => {
    const p = one('SELECT * FROM products WHERE id=?', params.id); if (!p) throw notFound();
    const n = { name: body.name ?? p.name, price: body.price != null ? intOf(body.price, 'السعر') : p.price, stock: body.stock != null ? intOf(body.stock, 'المخزون') : p.stock, cod_mode: body.cod_mode ?? p.cod_mode, hidden: body.hidden != null ? (body.hidden ? 1 : 0) : p.hidden };
    if (!['none', 'partial', 'full'].includes(n.cod_mode)) throw bad('cod_mode غير صالح');
    run('UPDATE products SET name=?,price=?,stock=?,cod_mode=?,hidden=? WHERE id=?', n.name, n.price, n.stock, n.cod_mode, n.hidden, p.id);
    S.change('products', p.id); S.audit(user.id, 'product.update', { id: p.id, ...body });
    return { ok: true };
  });
  R('DELETE', '/api/admin/products/:id', ADMIN, ({ user, params }) => { run('UPDATE products SET hidden=1, stock=0 WHERE id=?', params.id); S.change('products', Number(params.id), 'delete'); S.audit(user.id, 'product.delete', { id: params.id }); return { ok: true }; });
  R('POST', '/api/admin/zones', ADMIN, ({ user, body }) => {
    if (!body.name) throw bad('اسم المنطقة مطلوب');
    const r = run('INSERT INTO zones(name,fee,free) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET fee=excluded.fee, free=excluded.free', body.name, body.free ? 0 : intOf(body.fee ?? 0, 'السعر'), body.free ? 1 : 0);
    const id = one('SELECT id FROM zones WHERE name=?', body.name).id; S.change('zones', id); S.audit(user.id, 'zone.upsert', body); return { id };
  });
  R('PUT', '/api/admin/features/:key', ADMIN, ({ user, params, body }) => {
    if (!one('SELECT key FROM features WHERE key=?', params.key)) throw notFound();
    run('UPDATE features SET enabled=? WHERE key=?', body.enabled ? 1 : 0, params.key);
    S.change('features', 0); S.audit(user.id, 'feature.toggle', { key: params.key, enabled: !!body.enabled }); return { ok: true };
  });
  R('POST', '/api/admin/announcements', ADMIN, ({ user, body }) => { S.requireFeature('announcements'); const r = run('INSERT INTO announcements(text,placement) VALUES(?,?)', body.text, body.placement ?? 'home'); S.audit(user.id, 'announcement.create', body); return { id: r.lastInsertRowid }; });
  R('PUT', '/api/admin/settings', 'admin', ({ user, body }) => {
    const allowed = ['commission_pct', 'escrow_days', 'withdraw_daily_limit', 'withdraw_monthly_limit', 'vendor_monthly_fee', 'sms_amount_only_match'];
    for (const [k, v] of Object.entries(body)) { if (!allowed.includes(k)) throw bad(`إعداد غير معروف: ${k}`); S.setSetting(k, intOf(v, k)); }
    S.audit(user.id, 'settings.update', body); return { ok: true };
  });
  R('GET', '/api/admin/vendors', ADMIN, () => q('SELECT id,user_id,shop_name,status,available,pending,paid_until,created_at,(SELECT id FROM contracts WHERE vendor_id=vendors.id ORDER BY id DESC LIMIT 1) contract_id FROM vendors'));
  R('GET', '/api/admin/contracts/:id', 'admin', ({ user, params }) => { const c = one('SELECT * FROM contracts WHERE id=?', params.id); if (!c) throw notFound(); S.audit(user.id, 'contract.view', { id: c.id }); return { ...c, data_enc: undefined, data: JSON.parse(decrypt(c.data_enc, encKey)) }; });
  R('POST', '/api/admin/vendors/:id/status', ADMIN, ({ user, params, body }) => {
    if (!['active', 'pending', 'suspended', 'deleted'].includes(body.status)) throw bad('حالة غير صالحة');
    const v = one('SELECT * FROM vendors WHERE id=?', params.id); if (!v) throw notFound();
    tx(db, () => {
      run('UPDATE vendors SET status=? WHERE id=?', body.status, v.id);
      if (body.status === 'active') run("UPDATE users SET role='vendor' WHERE id=? AND role='customer'", v.user_id);
      if (body.status === 'deleted') { run('UPDATE products SET hidden=1 WHERE vendor_id=?', v.id); }
      for (const p of q('SELECT id FROM products WHERE vendor_id=?', v.id)) S.change('products', p.id);
    });
    S.audit(user.id, 'vendor.status', { id: v.id, status: body.status }); return { ok: true };
  });
  R('POST', '/api/admin/vendors/:id/subscription', ADMIN, ({ user, params, body }) => {
    S.requireFeature('vendors');
    const v = one('SELECT * FROM vendors WHERE id=?', params.id); if (!v) throw notFound();
    const months = intOf(body.months ?? 1, 'الأشهر'); if (months < 1 || months > 24) throw bad('عدد الأشهر غير صالح');
    const amount = months * Number(S.setting('vendor_monthly_fee'));
    const base = v.paid_until && new Date(v.paid_until) > now() ? new Date(v.paid_until) : now();
    const until = new Date(base.getTime() + months * 30 * 86400000).toISOString();
    tx(db, () => { run('UPDATE vendors SET paid_until=? WHERE id=?', until, v.id); S.ledger(0, 'vendor_fee', amount, `vendor:${v.id}`); });
    S.audit(user.id, 'vendor.subscription', { id: v.id, months, amount }); return { paid_until: until, amount };
  });
  R('POST', '/api/admin/social/:id/stats', ADMIN, ({ user, params, body }) => {
    if (!one('SELECT id FROM social_posts WHERE id=?', params.id)) throw notFound();
    run('UPDATE social_posts SET views=?, likes=?, comments=? WHERE id=?', intOf(body.views ?? 0, 'views'), intOf(body.likes ?? 0, 'likes'), intOf(body.comments ?? 0, 'comments'), params.id);
    S.audit(user.id, 'social.stats', { id: params.id, ...body }); return { ok: true };
  });
  R('GET', '/api/notifications', 'any', ({ user }) => q("SELECT id,text,at FROM outbox WHERE kind='user' AND target=? ORDER BY id DESC LIMIT 50", user.id));
  R('GET', '/api/vendor/notifications', 'any', ({ user }) => { const v = vendorOf(user); return q("SELECT id,text,at FROM outbox WHERE kind='vendor' AND target=? ORDER BY id DESC LIMIT 50", v.id); });
  R('POST', '/api/admin/orders/:id/assign', ADMIN, async ({ user, params, body }) => {
    const o = one('SELECT * FROM orders WHERE id=?', params.id); if (!o) throw notFound();
    const d = one("SELECT id FROM users WHERE id=? AND role='driver'", body.driver_id); if (!d) throw bad('مندوب غير صالح');
    run("UPDATE orders SET driver_id=?, status='out_for_delivery' WHERE id=?", d.id, o.id);
    const cust = one('SELECT phone FROM users WHERE id=?', o.customer_id);
    if (S.featureOn('live_tracking')) await sender.send(cust.phone, `طلبك #${o.id} في الطريق. تتبع المندوب: /track/${o.track_token}`);
    S.audit(user.id, 'order.assign', { id: o.id, driver: d.id }); return { ok: true };
  });
  R('POST', '/api/admin/users/:id/role', 'admin', ({ user, params, body }) => {
    if (!['customer', 'driver', 'staff', 'admin'].includes(body.role)) throw bad('دور غير صالح');
    run('UPDATE users SET role=? WHERE id=?', body.role, params.id); S.audit(user.id, 'user.role', { id: params.id, role: body.role }); return { ok: true };
  });
  R('GET', '/api/admin/transfers', ADMIN, ({ query }) => q('SELECT id,user_id,amount,ref,status,source,created_at FROM transfers WHERE status=? ORDER BY id', query.get('status') || 'pending'));
  R('POST', '/api/admin/transfers/:id/approve', ADMIN, ({ user, params }) => S.creditTransfer(Number(params.id), 'manual', user.id));
  R('POST', '/api/admin/transfers/:id/reject', ADMIN, ({ user, params }) => { run("UPDATE transfers SET status='rejected' WHERE id=? AND status='pending'", params.id); S.audit(user.id, 'transfer.reject', { id: params.id }); return { ok: true }; });
  R('GET', '/api/admin/returns', ADMIN, () => q('SELECT * FROM returns ORDER BY id DESC'));
  R('POST', '/api/admin/returns/:id/approve', ADMIN, ({ user, params }) => { S.approveReturn(Number(params.id), user.id); return { ok: true }; });
  R('POST', '/api/admin/escrow/release', 'admin', ({ user }) => { const n = S.releaseDue(); S.audit(user.id, 'escrow.release', { n }); return { released: n }; });
  R('GET', '/api/admin/audit', 'admin', ({ query }) => q('SELECT * FROM audit ORDER BY id DESC LIMIT ?', Math.min(Number(query.get('limit') || 100), 500)));
  R('GET', '/api/admin/delivery-export', ADMIN, ({ query }) => {
    const date = query.get('date') || now().toISOString().slice(0, 10);
    const rows = q(`SELECT o.id, u.name, u.phone, z.name zone, a.label, a.details, a.lat, a.lng, o.total, o.cod_due FROM orders o JOIN users u ON u.id=o.customer_id LEFT JOIN addresses a ON a.id=o.address_id LEFT JOIN zones z ON z.id=o.zone_id WHERE substr(o.created_at,1,10)=? AND o.status IN ('new','out_for_delivery') ORDER BY z.name, o.id`, date);
    const sheet = [['رقم الطلب', 'العميل', 'الهاتف', 'المنطقة', 'العنوان', 'التفاصيل', 'خط العرض', 'خط الطول', 'الإجمالي', 'المطلوب عند الاستلام']];
    for (const r of rows) sheet.push([r.id, r.name, r.phone, r.zone ?? '', r.label ?? '', r.details ?? '', r.lat ?? '', r.lng ?? '', r.total, r.cod_due]);
    return { __file: buildXlsx(sheet, 'التوصيل'), name: `delivery-${date}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  });
  R('GET', '/api/admin/reports', ADMIN, () => {
    const d30 = new Date(now().getTime() - 30 * 86400000).toISOString(), d7 = new Date(now().getTime() - 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    return {
      users: { total: one('SELECT COUNT(*) c FROM users').c, active_30d: one('SELECT COUNT(DISTINCT customer_id) c FROM orders WHERE created_at>=?', d30).c, new_7d: one('SELECT COUNT(*) c FROM users WHERE created_at>=?', d7).c },
      vendors: { active: one("SELECT COUNT(*) c FROM vendors WHERE status='active'").c, pending: one("SELECT COUNT(*) c FROM vendors WHERE status='pending'").c, top: q("SELECT v.shop_name, SUM(oi.qty*oi.price) sales FROM order_items oi JOIN vendors v ON v.id=oi.vendor_id GROUP BY v.id ORDER BY sales DESC LIMIT 5") },
      inventory: { listed: one('SELECT COUNT(*) c FROM products WHERE hidden=0').c, units: one('SELECT COALESCE(SUM(stock),0) s FROM products WHERE hidden=0').s, low: q('SELECT id,name,stock FROM products WHERE hidden=0 AND stock BETWEEN 1 AND 5'), out: q('SELECT id,name FROM products WHERE hidden=0 AND stock=0') },
      social: one('SELECT COUNT(*) posts, COALESCE(SUM(views),0) views, COALESCE(SUM(likes),0) likes, COALESCE(SUM(comments),0) comments FROM social_posts'),
    };
  });
  R('GET', '/api/admin/health', ADMIN, () => S.health());
  R('POST', '/api/admin/health/repair', 'admin', ({ user }) => ({ fixed: S.repairBalances(user.id), health: S.health() }));
  R('POST', '/api/admin/social/publish', ADMIN, ({ user, body }) => {
    S.requireFeature('social_broadcast');
    const p = one('SELECT id FROM products WHERE id=?', body.product_id); if (!p) throw notFound();
    // Official platform APIs only. Without configured credentials the post stays queued.
    const out = (body.channels || []).map((c) => ({ id: run('INSERT INTO social_posts(product_id,channel,status) VALUES(?,?,?)', p.id, c, opts.social?.[c] ? 'published' : 'not_configured').lastInsertRowid, channel: c, status: opts.social?.[c] ? 'published' : 'not_configured' }));
    S.audit(user.id, 'social.publish', body); return out;
  });
  R('POST', '/api/admin/copilot', 'admin', async ({ user, body }) => {
    const request = String(body.request || '').trim();
    if (request.length < 8 || request.length > 2000) throw bad('اكتب وصفاً واضحاً للميزة');
    const feats = q('SELECT key,label FROM features');
    const analyze = opts.copilot ?? anthropicAnalyzer({ apiKey: opts.anthropicKey, model: opts.copilotModel }) ?? ruleBasedAnalyzer(feats);
    let card, engine = opts.copilot || opts.anthropicKey ? 'llm' : 'rules';
    try { card = normalizeCard(await analyze(request, feats.map((f) => f.label).join('، ')), request); }
    catch (e) { console.error('copilot failed:', e.message); engine = 'rules'; card = normalizeCard(await ruleBasedAnalyzer(feats)(request), request); }
    const r = run('INSERT INTO feature_requests(requester,request,card) VALUES(?,?,?)', user.id, request, JSON.stringify(card));
    S.audit(user.id, 'copilot.analyze', { id: r.lastInsertRowid, engine });
    return { id: r.lastInsertRowid, engine, card };
  });
  R('GET', '/api/admin/copilot', 'admin', () => q('SELECT id,request,card,status,at FROM feature_requests ORDER BY id DESC LIMIT 50').map((r) => ({ ...r, card: JSON.parse(r.card) })));
  R('POST', '/api/admin/copilot/:id/decision', 'admin', ({ user, params, body }) => {
    if (!['approved', 'rejected'].includes(body.decision)) throw bad('قرار غير صالح');
    const r = run("UPDATE feature_requests SET status=? WHERE id=? AND status='analyzed'", body.decision, params.id);
    if (!r.changes) throw bad('الطلب غير موجود أو تم البت فيه');
    S.audit(user.id, 'copilot.decision', { id: params.id, decision: body.decision });
    return { ok: true, note: body.decision === 'approved' ? 'سُجّل الطلب في قائمة التنفيذ؛ التنفيذ والنشر يتمان بمراجعة مطوّر.' : undefined };
  });

  R('GET', '/api/admin/backups', 'admin', () => { if (!backupDir) throw bad('النسخ الاحتياطي غير مفعّل'); return listBackups(backupDir); });
  R('POST', '/api/admin/backups', 'admin', async ({ user }) => { if (!backupDir) throw bad('النسخ الاحتياطي غير مفعّل'); const name = await createBackup(db, backupDir, opts.backupKeep ?? 14, now()); S.audit(user.id, 'backup.create', { name }); return { name }; });
  R('GET', '/api/admin/backups/:name', 'admin', ({ user, params }) => {
    if (!backupDir || !isBackupName(params.name) || !fs.existsSync(path.join(backupDir, params.name))) throw notFound();
    S.audit(user.id, 'backup.download', { name: params.name });
    return { __file: fs.readFileSync(path.join(backupDir, params.name)), name: params.name, type: 'application/octet-stream' };
  });

  // ================= Financial vault (two codes) =================
  const vaultGuard = (user, headers) => { const t = verifyToken(headers['x-vault-token'], secret); if (!t || t.uid !== user.id || t.scope !== 'vault') throw forbidden('الخزنة مقفلة'); };
  R('POST', '/api/vault/setup', 'admin', ({ user, body }) => {
    if (S.setting('vault_reset_hash')) throw forbidden('الخزنة مُعدّة مسبقاً');
    for (const k of ['reset_code', 'open_code']) if (!/^\d{10}$/.test(String(body[k] || ''))) throw bad('الرمز يجب أن يكون 10 أرقام');
    if (body.reset_code === body.open_code) throw bad('يجب أن يختلف الرمزان');
    S.setSetting('vault_reset_hash', hashSecret(body.reset_code)); S.setSetting('vault_open_hash', hashSecret(body.open_code));
    S.audit(user.id, 'vault.setup', {}); return { ok: true };
  });
  const lockCheck = (user) => { const l = Number(S.setting(`vault_lock_${user.id}`) || 0); if (l > now().getTime()) throw new HttpError(429, 'الخزنة مقفلة مؤقتاً'); };
  const fail = (user, what) => { const n = Number(S.setting(`vault_fail_${user.id}`) || 0) + 1; S.setSetting(`vault_fail_${user.id}`, n); S.audit(user.id, 'vault.fail', { what }); if (n >= 5) { S.setSetting(`vault_lock_${user.id}`, now().getTime() + 15 * 60000); S.setSetting(`vault_fail_${user.id}`, 0); } throw forbidden('رمز غير صحيح'); };
  R('POST', '/api/vault/recover', 'admin', ({ user, body }) => {
    lockCheck(user); if (!vaultLimit(`r${user.id}`)) throw new HttpError(429, 'محاولات كثيرة');
    if (!checkSecret(String(body.code), S.setting('vault_reset_hash'))) fail(user, 'recover');
    S.setSetting(`vault_fail_${user.id}`, 0);
    return { reset_token: signToken({ uid: user.id, scope: 'vault-reset' }, secret, 300) };
  });
  R('POST', '/api/vault/change-open-code', 'admin', ({ user, body }) => {
    const t = verifyToken(body.reset_token, secret);
    if (!t || t.uid !== user.id || t.scope !== 'vault-reset') throw forbidden();
    if (!/^\d{10}$/.test(String(body.new_code)) || body.new_code !== body.confirm_code) throw bad('الرمز غير مطابق أو غير صالح');
    S.setSetting('vault_open_hash', hashSecret(body.new_code)); S.audit(user.id, 'vault.open_code_changed', {}); return { ok: true };
  });
  R('POST', '/api/vault/open', 'admin', ({ user, body }) => {
    lockCheck(user); if (!vaultLimit(`o${user.id}`)) throw new HttpError(429, 'محاولات كثيرة');
    if (!checkSecret(String(body.code), S.setting('vault_open_hash'))) fail(user, 'open');
    S.setSetting(`vault_fail_${user.id}`, 0); S.audit(user.id, 'vault.open', {});
    return { vault_token: signToken({ uid: user.id, scope: 'vault' }, secret, 900) };
  });
  R('PUT', '/api/vault/store-profits', 'admin', ({ user, headers, body }) => {
    vaultGuard(user, headers);
    S.setSetting('profit_apple', intOf(body.apple ?? 0, 'apple')); S.setSetting('profit_google', intOf(body.google ?? 0, 'google')); S.audit(user.id, 'vault.store_profits', body); return { ok: true };
  });
  R('GET', '/api/vault/finance', 'admin', ({ user, headers }) => {
    vaultGuard(user, headers);
    const sum = (t) => one('SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE user_id=0 AND type=?', t).s;
    const apple = Number(S.setting('profit_apple') || 0), google = Number(S.setting('profit_google') || 0);
    return {
      stores: { apple, google },
      net_app_profit: sum('commission') + sum('commission_reversal') + sum('vendor_fee') + sum('platform_sale') + apple + google,
      from_vendors: { commissions: sum('commission') + sum('commission_reversal'), subscriptions: sum('vendor_fee'), active_vendors: one("SELECT COUNT(*) c FROM vendors WHERE status='active'").c },
      main_store: { direct_sales: sum('platform_sale'), stock_value: one('SELECT COALESCE(SUM(price*stock),0) s FROM products WHERE vendor_id IS NULL AND hidden=0').s },
      items: { listed: one('SELECT COUNT(*) c FROM products WHERE hidden=0').c, sold_units: one('SELECT COALESCE(SUM(qty),0) s FROM order_items WHERE returned=0').s, sold_out: one('SELECT COUNT(*) c FROM products WHERE stock=0 AND hidden=0').c },
    };
  });

  // ================= Driver =================
  R('GET', '/api/driver/route', 'driver', ({ user }) => {
    const loc = one('SELECT lat,lng FROM driver_locations WHERE driver_id=?', user.id);
    const stops = q(`SELECT o.id order_id, o.cod_due, u.name customer, u.phone, a.lat, a.lng, a.details FROM orders o JOIN users u ON u.id=o.customer_id LEFT JOIN addresses a ON a.id=o.address_id WHERE o.driver_id=? AND o.status='out_for_delivery'`, user.id);
    // nearest-neighbour ordering so the route can be cached and followed offline
    const ordered = []; let cur = loc ? { ...loc } : null; const rest = [...stops];
    while (rest.length) {
      let bi = 0;
      if (cur) { let bd = Infinity; rest.forEach((s, i) => { if (s.lat == null) return; const d = (s.lat - cur.lat) ** 2 + (s.lng - cur.lng) ** 2; if (d < bd) { bd = d; bi = i; } }); }
      const [n] = rest.splice(bi, 1); ordered.push(n); if (n.lat != null) cur = { lat: n.lat, lng: n.lng };
    }
    return { stops: ordered };
  });
  R('POST', '/api/driver/location', 'driver', ({ user, body }) => { run('INSERT INTO driver_locations(driver_id,lat,lng,at) VALUES(?,?,?,?) ON CONFLICT(driver_id) DO UPDATE SET lat=excluded.lat,lng=excluded.lng,at=excluded.at', user.id, Number(body.lat), Number(body.lng), now().toISOString()); return { ok: true }; });
  R('POST', '/api/driver/orders/:id/deliver', 'driver', ({ user, params }) => {
    const o = one('SELECT * FROM orders WHERE id=? AND driver_id=?', params.id, user.id); if (!o) throw notFound();
    return S.markDelivered(o.id, user.id);
  });

  // ================= HTTP glue =================
  const roleOk = (needed, role) => needed === 'any' || (needed === 'admin' && role === 'admin') || (needed === 'staff' && ['admin', 'staff'].includes(role)) || needed === role;
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    // CORS only for the packaged mobile app origins (and any extra origins configured)
    const origin = req.headers.origin;
    const cors = origin && corsOrigins.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type, x-vault-token', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', vary: 'Origin' } : {};
    const send = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...cors, ...headers }); res.end(JSON.stringify(data)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      const m = router.match(req.method, url.pathname);
      if (!m) return send(404, { error: 'مسار غير موجود' });
      let user = null;
      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ')) { const t = verifyToken(auth.slice(7), secret); if (t) user = one('SELECT id,name,phone,role FROM users WHERE id=?', t.uid) ?? null; }
      if (m.route.opts.role) { if (!user) throw new HttpError(401, 'يلزم تسجيل الدخول'); if (!roleOk(m.route.opts.role, user.role)) throw forbidden(); }
      S.releaseDue();
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJson(req) : {};
      const out = await m.route.handler({ user, params: m.params, query: url.searchParams, body, headers: req.headers });
      if (out?.__file) { res.writeHead(200, { ...cors, 'content-type': out.type, 'content-disposition': `attachment; filename="${out.name}"` }); return res.end(out.__file); }
      send(200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      if (String(e.message).includes('UNIQUE')) return send(409, { error: 'قيمة مكررة' });
      console.error(e); send(500, { error: 'خطأ داخلي' });
    }
  }
  function serveStatic(p, res) {
    let dec; try { dec = decodeURIComponent(p); } catch { res.writeHead(400); return res.end('bad request'); }
    let f = path.join(WEB_DIR, p === '/' ? 'index.html' : dec);
    if (!f.startsWith(WEB_DIR + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(WEB_DIR, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'" }); fs.createReadStream(f).pipe(res);
  }
  const server = http.createServer(handle);
  return { server, db, services: S, handle };
}
