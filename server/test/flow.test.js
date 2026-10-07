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
  app = createApp({ devOtp: true, adminPhone: '967700000001', ingestKey: 'k', supportPhone: '967700000099', now: () => clock, whatsapp: { async send(p, t) { sent.push([p, t]); } } });
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
