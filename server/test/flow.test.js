import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { parseWalletSms } from '../src/services.js';

let base, app, clock = new Date('2026-10-07T10:00:00Z');
const sent = [];
async function api(method, path, { token, body, headers } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}
async function login(phone, name = 'احمد محمد علي النهمي') {
  const o = await api('POST', '/api/auth/request-otp', { body: { phone } });
  const v = await api('POST', '/api/auth/verify', { body: { phone, code: o.data.dev_code, name } });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return v.data.token;
}
test.before(async () => {
  app = createApp({ otpLimit: 1000, devOtp: true, adminPhone: '967700000001', ingestKey: 'k', supportPhone: '967700000099', now: () => clock, whatsapp: { async send(p, t) { sent.push([p, t]); } } });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => app.server.close());

test('SMS parser handles Arabic digits and refs', () => {
  assert.deepEqual(parseWalletSms('اضيف ٣٠٠٠ ر.ي دفع مشتريات رقم العملية 889123'), { credit: true, amount: 3000, ref: '889123' });
  assert.equal(parseWalletSms('تم سحب 2000 ر.ي').credit, false);
});

test('full marketplace lifecycle', async () => {
  const admin = await login('967700000001', 'مدير النظام الاول الرئيسي');
  assert.equal((await api('GET', '/api/me', { token: admin })).data.role, 'admin');
  assert.equal((await api('GET', '/api/admin/health', { token: admin })).data.status, 'green');

  // auth guards
  assert.equal((await api('GET', '/api/admin/reports')).status, 401);
  const cust = await login('967711111111');
  assert.equal((await api('GET', '/api/admin/reports', { token: cust })).status, 403);
  assert.equal((await api('POST', '/api/auth/verify', { body: { phone: '967711111111', code: '000000' } })).status, 400);

  // zones + main-store product (COD allowed)
  const z = (await api('POST', '/api/admin/zones', { token: admin, body: { name: 'صنعاء', fee: 1000 } })).data.id;
  const pid = (await api('POST', '/api/admin/products', { token: admin, body: { name: 'حذاء عسكري', price: 20000, stock: 5, cod_mode: 'full' } })).data.id;
  const addr = (await api('POST', '/api/addresses', { token: cust, body: { label: 'المنزل', lat: 15.35, lng: 44.2, zone_id: z } })).data.id;
  const quote = (await api('POST', '/api/quote', { token: cust, body: { address_id: addr, items: [{ product_id: pid, qty: 1 }] } })).data;
  assert.deepEqual(quote, { subtotal: 20000, shipping: 1000, total: 21000 });

  // wallet top-up: duplicate protection, manual fallback and SMS auto-match
  let t1 = await api('POST', '/api/transfers', { token: cust, body: { amount: 5000, ref: 'R-1001' } });
  assert.equal(t1.status, 200);
  assert.equal((await api('POST', '/api/transfers', { token: cust, body: { amount: 5000, ref: 'r-1001' } })).status, 409);
  assert.ok(sent.some(([p]) => p === '967700000099'), 'support notified by fallback bot');
  assert.equal((await api('POST', '/api/sms/ingest', { body: { text: 'x' } })).status, 403);
  const ing = await api('POST', '/api/sms/ingest', { headers: { 'x-ingest-key': 'k' }, body: { text: 'تم إيداع مبلغ ٥٠٠٠ ر.ي رقم العملية R-1001' } });
  assert.equal(ing.data.matched, 1);
  assert.equal((await api('GET', '/api/wallet', { token: cust })).data.balance, 5000);
  const t2 = await api('POST', '/api/transfers', { token: cust, body: { amount: 2000, ref: 'MANUAL-1' } });
  assert.equal((await api('POST', `/api/admin/transfers/${t2.data.id}/approve`, { token: admin })).status, 200);
  assert.equal((await api('POST', `/api/admin/transfers/${t2.data.id}/approve`, { token: admin })).status, 200); // idempotent
  assert.equal((await api('GET', '/api/wallet', { token: cust })).data.balance, 7000);

  // order: wallet 7000 + COD remainder 14000
  const order = (await api('POST', '/api/orders', { token: cust, body: { client_id: 'c-1', address_id: addr, wallet_amount: 7000, items: [{ product_id: pid, qty: 1 }] } })).data;
  assert.equal(order.cod_due, 14000);
  assert.equal((await api('POST', '/api/orders', { token: cust, body: { client_id: 'c-1', address_id: addr, items: [{ product_id: pid, qty: 1 }] } })).data.id, order.id, 'idempotent by client_id');
  assert.equal((await api('GET', '/api/wallet', { token: cust })).data.balance, 0);

  // delivery export is a valid zip/xlsx
  const x = await api('GET', '/api/admin/delivery-export?date=2026-10-07', { token: admin });
  assert.equal(x.status, 200); assert.equal(x.data.subarray(0, 2).toString(), 'PK');

  // driver flow
  const drv = await login('967722222222', 'سائق توصيل اول محمد');
  const drvId = (await api('GET', '/api/me', { token: drv })).data.id;
  await api('POST', `/api/admin/users/${drvId}/role`, { token: admin, body: { role: 'driver' } });
  await api('POST', `/api/admin/orders/${order.id}/assign`, { token: admin, body: { driver_id: drvId } });
  await api('POST', '/api/driver/location', { token: drv, body: { lat: 15.3, lng: 44.1 } });
  assert.equal((await api('GET', '/api/driver/route', { token: drv })).data.stops.length, 1);
  const trk = order.track_token;
  assert.equal((await api('GET', `/api/track/${trk}`)).data.driver_location.lat, 15.3);
  assert.equal((await api('POST', `/api/driver/orders/${order.id}/deliver`, { token: drv })).data.status, 'delivered');

  // return refunds wallet and restocks
  const item = (await api('GET', `/api/orders/${order.id}/invoice`, { token: cust })).data.items[0];
  const ret = (await api('POST', '/api/returns', { token: cust, body: { order_item_id: item.id, kind: 'return', reason: 'مقاس' } })).data;
  await api('POST', `/api/admin/returns/${ret.id}/approve`, { token: admin });
  assert.equal((await api('GET', '/api/wallet', { token: cust })).data.balance, 20000);
  assert.equal((await api('GET', '/api/admin/health', { token: admin })).data.status, 'green');
});

test('vendor contract, escrow 35 days, auto payout and limits', async () => {
  const admin = await login('967700000001');
  const z = (await api('GET', '/api/zones')).data[0].id;
  const v = await login('967733333333', 'تاجر المحل الاول علي');
  const contract = { full_name: 'تاجر المحل الاول علي', shop_name: 'محل النخبة', signature: 'x', id_number: '123', id_front_b64: 'AAAA', id_back_b64: 'BBBB' };
  const reg = (await api('POST', '/api/vendors/register', { token: v, body: { contract } })).data;
  assert.equal((await api('POST', '/api/vendor/products', { token: v, body: { name: 'x', price: 1 } })).status, 403, 'pending vendor blocked');
  const c = await api('GET', '/api/admin/contracts/1', { token: admin });
  assert.equal(c.data.data.id_number, '123');
  // contract is encrypted at rest
  assert.ok(!JSON.stringify(app.db.prepare('SELECT data_enc FROM contracts').all()).includes('123'));
  await api('POST', `/api/admin/vendors/${reg.vendor_id}/status`, { token: admin, body: { status: 'active' } });
  await api('PUT', '/api/vendor/accounts', { token: v, body: { accounts: [{ provider: 'جيب', number: '777000111' }] } });
  const pid = (await api('POST', '/api/vendor/products', { token: v, body: { name: 'قبعة', price: 100000, stock: 10, cod_mode: 'none' } })).data.id;

  const cust = await login('967744444444', 'عميل مشتري ثاني علي');
  const addr = (await api('POST', '/api/addresses', { token: cust, body: { label: 'العمل', zone_id: z } })).data.id;
  // vendor items cannot use COD
  assert.equal((await api('POST', '/api/orders', { token: cust, body: { address_id: addr, items: [{ product_id: pid, qty: 1 }] } })).status, 400);
  app.db.prepare('UPDATE users SET balance=200000 WHERE id=(SELECT id FROM users WHERE phone=?)').run('967744444444');
  app.db.prepare("INSERT INTO ledger(user_id,type,amount) SELECT id,'topup',200000 FROM users WHERE phone='967744444444'").run();
  const o = (await api('POST', '/api/orders', { token: cust, body: { address_id: addr, wallet_amount: 101000, items: [{ product_id: pid, qty: 1 }] } })).data;
  app.services.markDelivered(o.id, null);
  let st = (await api('GET', '/api/vendor/statement', { token: v })).data.vendor;
  assert.deepEqual([st.pending, st.available], [90000, 0]); // 10% commission
  // withdrawal blocked while frozen
  assert.equal((await api('POST', '/api/vendor/withdraw', { token: v, body: { amount: 1000, account: '777000111' } })).status, 400);
  // before 35 days: nothing released; after: released and auto-queued within the daily limit (500000)
  clock = new Date('2026-11-05T09:00:00Z'); // day 29
  app.services.releaseDue(clock);
  assert.equal((await api('GET', '/api/vendor/statement', { token: v })).data.vendor.pending, 90000);
  clock = new Date('2026-11-12T10:00:00Z'); // day 36
  app.services.releaseDue(clock);
  const st2 = (await api('GET', '/api/vendor/statement', { token: v })).data;
  assert.equal(st2.vendor.pending, 0);
  assert.equal(st2.withdrawals[0].amount, 90000);
  assert.equal(st2.withdrawals[0].account, 'جيب:777000111');
  assert.equal((await api('GET', '/api/admin/health', { token: admin })).data.status, 'green');
  // daily limit enforced
  app.db.prepare('UPDATE vendors SET available=900000').run();
  assert.equal((await api('POST', '/api/vendor/withdraw', { token: v, body: { amount: 450000, account: '777000111' } })).status, 400);
});

test('financial vault: two codes, lockout, recovery', async () => {
  const admin = await login('967700000001');
  assert.equal((await api('POST', '/api/vault/setup', { token: admin, body: { reset_code: '1234567890', open_code: '1234567890' } })).status, 400);
  assert.equal((await api('POST', '/api/vault/setup', { token: admin, body: { reset_code: '1111111111', open_code: '2222222222' } })).status, 200);
  assert.equal((await api('POST', '/api/vault/setup', { token: admin, body: { reset_code: '1111111112', open_code: '2222222223' } })).status, 403);
  assert.equal((await api('GET', '/api/vault/finance', { token: admin })).status, 403);
  assert.equal((await api('POST', '/api/vault/open', { token: admin, body: { code: '1111111111' } })).status, 403, 'reset code does not open vault');
  const rec = await api('POST', '/api/vault/recover', { token: admin, body: { code: '1111111111' } });
  assert.equal((await api('POST', '/api/vault/change-open-code', { token: admin, body: { reset_token: rec.data.reset_token, new_code: '3333333333', confirm_code: '3333333333' } })).status, 200);
  const open = await api('POST', '/api/vault/open', { token: admin, body: { code: '3333333333' } });
  assert.equal(open.status, 200);
  const fin = await api('GET', '/api/vault/finance', { token: admin, headers: { 'x-vault-token': open.data.vault_token } });
  assert.equal(fin.status, 200);
  assert.ok(fin.data.from_vendors.commissions >= 10000);
  // lockout after 5 wrong codes
  for (let i = 0; i < 5; i++) await api('POST', '/api/vault/open', { token: admin, body: { code: '0000000000' } });
  assert.equal((await api('POST', '/api/vault/open', { token: admin, body: { code: '3333333333' } })).status, 429);
  const audit = (await api('GET', '/api/admin/audit?limit=500', { token: admin })).data;
  assert.ok(audit.some((a) => a.action === 'vault.fail') && audit.some((a) => a.action === 'order.deliver'));
});

test('feature switches and sync', async () => {
  const admin = await login('967700000001');
  const before = (await api('GET', '/api/sync?since=0')).data.seq;
  await api('PUT', '/api/admin/features/vendors', { token: admin, body: { enabled: false } });
  const u = await login('967755555555', 'مستخدم جديد رابع علي');
  assert.equal((await api('POST', '/api/vendors/register', { token: u, body: { contract: {} } })).status, 403);
  const pid = (await api('POST', '/api/admin/products', { token: admin, body: { name: 'جديد', price: 5, stock: 1 } })).data.id;
  const s = (await api('GET', `/api/sync?since=${before}`)).data;
  assert.ok(s.products.some((p) => p.id === pid) && s.features.find((f) => f.key === 'vendors').enabled === 0);
});

test('vendor subscription, follower notifications and social stats', async () => {
  const admin = await login('967700000001');
  await api('PUT', '/api/admin/features/vendors', { token: admin, body: { enabled: true } });
  const vendorId = app.db.prepare("SELECT id FROM vendors WHERE status='active'").get().id;
  const sub = await api('POST', `/api/admin/vendors/${vendorId}/subscription`, { token: admin, body: { months: 2 } });
  assert.equal(sub.data.amount, 10000);
  const again = await api('POST', `/api/admin/vendors/${vendorId}/subscription`, { token: admin, body: { months: 1 } });
  assert.ok(new Date(again.data.paid_until) > new Date(sub.data.paid_until), 'renewal extends from current expiry');
  const v = await login('967733333333');
  const f = await login('967766666666', 'متابع للمتجر خامس علي');
  await api('POST', `/api/vendors/${vendorId}/follow`, { token: f });
  await api('POST', '/api/vendor/products', { token: v, body: { name: 'حزام', price: 5000, stock: 3 } });
  const n = await api('GET', '/api/notifications', { token: f });
  assert.ok(n.data[0].text.includes('حزام'));
  const post = (await api('POST', '/api/admin/social/publish', { token: admin, body: { product_id: 1, channels: ['facebook'] } })).data[0];
  assert.equal(post.status, 'not_configured');
  await api('POST', `/api/admin/social/${post.id}/stats`, { token: admin, body: { views: 100, likes: 7, comments: 2 } });
  assert.equal((await api('GET', '/api/admin/reports', { token: admin })).data.social.views, 100);
});

test('CORS allows the mobile app origin only', async () => {
  const ok = await fetch(base + '/api/features', { headers: { origin: 'https://localhost' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://localhost');
  const pre = await fetch(base + '/api/orders', { method: 'OPTIONS', headers: { origin: 'https://localhost' } });
  assert.equal(pre.status, 204);
  const no = await fetch(base + '/api/features', { headers: { origin: 'https://evil.example' } });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('copilot: analysis card, normalisation, decision flow, rules fallback', async () => {
  const admin = await login('967700000001');
  assert.equal((await api('POST', '/api/admin/copilot', { token: admin, body: { request: 'قصير' } })).status, 400);
  const r = await api('POST', '/api/admin/copilot', { token: admin, body: { request: 'أريد إضافة السحب التلقائي للرصيد للعملاء' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.engine, 'rules');
  assert.ok(r.data.card.risks.length, 'money-related request flags risks');
  assert.equal((await api('POST', `/api/admin/copilot/${r.data.id}/decision`, { token: admin, body: { decision: 'approved' } })).status, 200);
  assert.equal((await api('POST', `/api/admin/copilot/${r.data.id}/decision`, { token: admin, body: { decision: 'rejected' } })).status, 400, 'decided once');
  const cust = await login('967711111111');
  assert.equal((await api('POST', '/api/admin/copilot', { token: cust, body: { request: 'طلب طويل بما يكفي' } })).status, 403);
});

test('copilot LLM output is validated and bad output falls back', async () => {
  const { normalizeCard, extractJson } = await import('../src/copilot.js');
  const c = normalizeCard(extractJson('نص {"summary":"s","feasibility":"WRONG","risks":"x","effort":"large"} نهاية'), 'req');
  assert.equal(c.feasibility, 'medium'); assert.deepEqual(c.risks, []); assert.equal(c.effort, 'large');
  const a2 = createApp({ otpLimit: 1000, devOtp: true, adminPhone: '967700000001', copilot: async () => { throw new Error('boom'); }, whatsapp: { async send() {} } });
  await new Promise((r) => a2.server.listen(0, r));
  const b = `http://127.0.0.1:${a2.server.address().port}`;
  const j = (m, p, t, body) => fetch(b + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const o = await j('POST', '/api/auth/request-otp', null, { phone: '967700000001' });
  const v = await j('POST', '/api/auth/verify', null, { phone: '967700000001', code: o.dev_code, name: 'مدير النظام الاول الرئيسي' });
  const out = await j('POST', '/api/admin/copilot', v.token, { request: 'إضافة تقييمات للمنتجات من العملاء' });
  assert.equal(out.engine, 'rules');
  a2.server.close();
});

test('OTP requests are rate limited by default', async () => {
  const a = createApp({ devOtp: true, whatsapp: { async send() {} } });
  await new Promise((r) => a.server.listen(0, r));
  const u = `http://127.0.0.1:${a.server.address().port}/api/auth/request-otp`;
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '967788888888' }) })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  a.server.close();
});

test('backups: create, list, download, restore, name safety', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twbk-'));
  const a = createApp({ otpLimit: 1000, devOtp: true, adminPhone: '967700000001', backupDir: dir, backupKeep: 2, whatsapp: { async send() {} } });
  await new Promise((r) => a.server.listen(0, r));
  const b = `http://127.0.0.1:${a.server.address().port}`;
  const J = async (m, p, t, body) => { const r = await fetch(b + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r; };
  const o = await (await J('POST', '/api/auth/request-otp', null, { phone: '967700000001' })).json();
  const t = (await (await J('POST', '/api/auth/verify', null, { phone: '967700000001', code: o.dev_code, name: 'مدير النظام الاول الرئيسي' })).json()).token;
  await J('POST', '/api/admin/zones', t, { name: 'تعز', fee: 500 });
  const made = await (await J('POST', '/api/admin/backups', t)).json();
  assert.match(made.name, /^app-\d{8}T\d{6}Z\.db$/);
  const file = Buffer.from(await (await J('GET', `/api/admin/backups/${made.name}`, t)).arrayBuffer());
  const restored = path.join(dir, 'restored.db'); fs.writeFileSync(restored, file);
  const rdb = new DatabaseSync(restored);
  assert.equal(rdb.prepare("SELECT fee FROM zones WHERE name='تعز'").get().fee, 500, 'backup contains data');
  rdb.close();
  assert.equal((await J('GET', '/api/admin/backups/..%2F..%2Fetc%2Fpasswd', t)).status, 404);
  assert.equal((await J('GET', '/api/admin/backups', null)).status, 401);
  for (let i = 0; i < 3; i++) await (await import('../src/backup.js')).createBackup(a.db, dir, 2, new Date(Date.now() + (i + 1) * 1000));
  assert.equal((await (await J('GET', '/api/admin/backups', t)).json()).length, 2, 'retention keeps newest N');
  a.server.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('hardening: sync hides hidden products, image/price validation, amount-only SMS is opt-in', async () => {
  const admin = await login('967700000001');
  const pid = (await api('POST', '/api/admin/products', { token: admin, body: { name: 'مخفي لاحقاً', price: 10, stock: 1 } })).data.id;
  await api('PUT', `/api/admin/products/${pid}`, { token: admin, body: { hidden: true } });
  const full = (await api('GET', '/api/sync?since=0')).data;
  assert.ok(!full.products.some((p) => p.id === pid), 'hidden product not in full sync');
  const delta = (await api('GET', `/api/sync?since=${full.seq - 1}`)).data;
  assert.ok(!delta.products.some((p) => p.id === pid));
  assert.equal((await api('POST', '/api/admin/products', { token: admin, body: { name: 'x', price: 0, stock: 1 } })).status, 400);
  assert.equal((await api('POST', '/api/admin/products', { token: admin, body: { name: 'x', price: 5, image: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await api('POST', '/api/admin/products', { token: admin, body: { name: 'x', price: 5, image: 'data:image/jpeg;base64,AAAA' } })).status, 200);
  // amount-only matching: off by default, so a ref-less transfer is NOT auto-credited by a ref-less SMS
  const u = await login('967799999999', 'مستخدم تحويل سادس علي');
  const t = (await api('POST', '/api/transfers', { token: u, body: { amount: 777, proof_base64: Buffer.from('proof-1').toString('base64') } })).data;
  await api('POST', '/api/sms/ingest', { headers: { 'x-ingest-key': 'k' }, body: { text: 'تم إيداع مبلغ 777 ر.ي' } });
  assert.equal(app.db.prepare('SELECT status FROM transfers WHERE id=?').get(t.id).status, 'pending');
  await api('PUT', '/api/admin/settings', { token: admin, body: { sms_amount_only_match: 1 } });
  await api('POST', '/api/sms/ingest', { headers: { 'x-ingest-key': 'k' }, body: { text: 'اضيف 777 ر.ي دفع مشتريات' } });
  assert.equal(app.db.prepare('SELECT status FROM transfers WHERE id=?').get(t.id).status, 'credited');
  const mal = await fetch(base + '/%E0%A4%A');
  assert.equal(mal.status, 400);
  const idx = await fetch(base + '/');
  assert.match(idx.headers.get('content-security-policy'), /script-src 'self'/);
});

test('vendor/me reports registration state', async () => {
  const u = await login('967788000001', 'مستخدم حالة تاجر رباعي');
  assert.equal((await api('GET', '/api/vendor/me', { token: u })).data.status, 'none');
  await api('POST', '/api/vendors/register', { token: u, body: { contract: { full_name: 'a b c d', shop_name: 'متجر حالة', signature: 'x', id_number: '1', id_front_b64: 'AA', id_back_b64: 'BB' } } });
  assert.deepEqual((await api('GET', '/api/vendor/me', { token: u })).data.status, 'pending');
  assert.equal((await api('GET', '/api/vendor/me')).status, 401);
});

test('backup targets: SSRF guard and off-site upload', async () => {
  const { assertPublicHttps, isPrivateIp } = await import('../src/targets.js');
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  const pub = async () => [{ address: '93.184.216.34' }];
  await assert.rejects(() => assertPublicHttps('http://example.com/x', pub), /https/);
  await assert.rejects(() => assertPublicHttps('https://user:pw@example.com/x', pub), /بيانات/);
  await assert.rejects(() => assertPublicHttps('https://localhost/x', async () => [{ address: '127.0.0.1' }]), /داخلي/);
  await assert.rejects(() => assertPublicHttps('https://rebind.example/x', async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }]), /داخلي/);
  await assert.rejects(() => assertPublicHttps('https://[::1]/x', pub), /داخلي/);
  await assertPublicHttps('https://backup.example.com/dir', pub);

  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twtg-')), got = [];
  const a = createApp({ otpLimit: 1000, devOtp: true, adminPhone: '967700000001', backupDir: dir, dnsLookup: pub, whatsapp: { async send() {} },
    uploader: async (t, name, body) => { if (t.url.includes('down')) throw new Error('HTTP 500'); got.push({ url: t.url, token: t.token, name, size: body.length }); } });
  await new Promise((r) => a.server.listen(0, r));
  const b = `http://127.0.0.1:${a.server.address().port}`;
  const J = async (m, p, t, body) => { const r = await fetch(b + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; };
  const o = (await J('POST', '/api/auth/request-otp', null, { phone: '967700000001' })).data;
  const t = (await J('POST', '/api/auth/verify', null, { phone: '967700000001', code: o.dev_code, name: 'مدير النظام الاول الرئيسي' })).data.token;
  assert.equal((await J('POST', '/api/admin/backup-targets', t, { name: 'x', url: 'http://insecure.example.com' })).status, 400);
  const ok1 = (await J('POST', '/api/admin/backup-targets', t, { name: 'سيرفري', url: 'https://backup.example.com/tw', token: 'secret-token' })).data.id;
  await J('POST', '/api/admin/backup-targets', t, { name: 'معطل', url: 'https://down.example.com/tw' });
  const list = (await J('GET', '/api/admin/backup-targets', t)).data;
  assert.equal(list.length, 2); assert.ok(!JSON.stringify(list).includes('secret-token'), 'token never returned'); assert.equal(list[0].has_token, 1);
  assert.ok(!JSON.stringify(a.db.prepare('SELECT token_enc FROM backup_targets').all()).includes('secret-token'), 'token encrypted at rest');
  const made = (await J('POST', '/api/admin/backups', t)).data;
  assert.equal(got.length, 1); assert.equal(got[0].token, 'secret-token'); assert.equal(got[0].name, made.name); assert.ok(got[0].size > 1000);
  assert.deepEqual(made.uploads.map((u) => u.status.startsWith('error') ? 'err' : u.status), ['ok', 'err']);
  assert.equal((await J('POST', `/api/admin/backup-targets/${ok1}/test`, t)).status, 200);
  const cust = (await J('POST', '/api/auth/request-otp', null, { phone: '967711234567' })).data;
  const ct = (await J('POST', '/api/auth/verify', null, { phone: '967711234567', code: cust.dev_code, name: 'عميل عادي رباعي الاسم' })).data.token;
  assert.equal((await J('GET', '/api/admin/backup-targets', ct)).status, 403);
  a.server.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('httpPutUploader builds the PUT request correctly and refuses redirects', async () => {
  const { httpPutUploader } = await import('../src/targets.js');
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200 }; };
  try {
    const pub = async () => [{ address: '93.184.216.34' }];
    await httpPutUploader({ url: 'https://store.example.com/backups', token: 'tok' }, 'app-20261010T000000Z.db', Buffer.from('data'), pub);
    assert.equal(calls[0].url, 'https://store.example.com/backups/app-20261010T000000Z.db');
    assert.equal(calls[0].init.method, 'PUT'); assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
    await httpPutUploader({ url: 'https://store.example.com/b/' }, 'x.db', Buffer.from('d'), pub);
    assert.equal(calls[1].url, 'https://store.example.com/b/x.db'); assert.equal(calls[1].init.headers.authorization, undefined);
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(() => httpPutUploader({ url: 'https://store.example.com/b' }, 'x.db', Buffer.from('d'), pub), /HTTP 403/);
    await assert.rejects(() => httpPutUploader({ url: 'https://store.example.com/b' }, 'x.db', Buffer.from('d'), async () => [{ address: '10.1.1.1' }]), /داخلي/);
  } finally { globalThis.fetch = real; }
});
