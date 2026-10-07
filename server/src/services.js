import { tx } from './db.js';
import { sha256, bad, forbidden, notFound, HttpError } from './util.js';

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const normDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d)).replace(/[,٬،]/g, '');

export function parseWalletSms(text) {
  const t = normDigits(text || '');
  const credit = /(اضيف|أضيف|إضافة|تم\s*إيداع|تم\s*ايداع|ايداع|إيداع|استلمت|تم\s*استلام|وصلك|received|credited)/i.test(t);
  const m = t.match(/(\d+(?:\.\d+)?)\s*(ر\.?\s?ي|ريال|YER|يمني)/i) || t.match(/(?:مبلغ|amount)\s*:?\s*(\d+(?:\.\d+)?)/i);
  const r = t.match(/(?:رقم\s*(?:العملية|المرجع|الحوالة)|مرجع|ref(?:erence)?\.?)\s*[:#]?\s*([A-Za-z0-9-]{5,})/i);
  return { credit, amount: m ? Math.round(parseFloat(m[1])) : null, ref: r ? r[1] : null };
}
export const refHash = (ref) => (ref ? sha256(String(ref).trim().toLowerCase()) : null);

export function createServices({ db, now = () => new Date(), notify = () => {} }) {
  const setting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
  const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const audit = (actor, action, detail) => db.prepare('INSERT INTO audit(actor, action, detail) VALUES(?,?,?)').run(actor ?? null, action, typeof detail === 'string' ? detail : JSON.stringify(detail ?? {}));
  const change = (entity, id, op = 'upsert') => db.prepare('INSERT INTO changes(entity, entity_id, op) VALUES(?,?,?)').run(entity, id, op);
  const featureOn = (key) => !!db.prepare('SELECT enabled FROM features WHERE key=?').get(key)?.enabled;
  const requireFeature = (key) => { if (!featureOn(key)) throw forbidden('هذه الميزة معطّلة حالياً'); };
  const ledger = (userId, type, amount, ref) => db.prepare('INSERT INTO ledger(user_id,type,amount,ref,at) VALUES(?,?,?,?,?)').run(userId, type, amount, ref ?? null, now().toISOString());

  // ---------- wallet top-ups ----------
  function creditTransfer(id, source, actor) {
    return tx(db, () => {
      const t = db.prepare('SELECT * FROM transfers WHERE id=?').get(id);
      if (!t) throw notFound();
      if (t.status === 'credited') return t;
      db.prepare("UPDATE transfers SET status='credited', source=? WHERE id=?").run(source, id);
      db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(t.amount, t.user_id);
      ledger(t.user_id, 'topup', t.amount, `transfer:${id}`);
      audit(actor, 'transfer.credit', { id, source, amount: t.amount });
      return { ...t, status: 'credited' };
    });
  }
  function matchSmsToTransfers() {
    const sms = db.prepare('SELECT * FROM sms_log WHERE matched_transfer IS NULL AND amount IS NOT NULL').all();
    let matched = 0;
    for (const s of sms) {
      const cands = db.prepare("SELECT * FROM transfers WHERE status='pending' AND amount=? ORDER BY id").all(s.amount);
      const hit = cands.find((c) => (s.ref && c.ref && refHash(c.ref) === refHash(s.ref))) || (!s.ref ? cands.find((c) => !c.ref) : null);
      if (hit) {
        creditTransfer(hit.id, 'auto', null);
        db.prepare('UPDATE sms_log SET matched_transfer=? WHERE id=?').run(hit.id, s.id);
        matched++;
      }
    }
    return matched;
  }

  // ---------- escrow / vendor payouts ----------
  function dayStart(d) { return d.toISOString().slice(0, 10); }
  function withdrawnSince(vendorId, sinceIso) {
    return db.prepare("SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE vendor_id=? AND status!='rejected' AND at>=?").get(vendorId, sinceIso).s;
  }
  function queueWithdrawal(vendorId, amount, account, actor) {
    return tx(db, () => {
      const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId);
      if (!v) throw notFound();
      if (!Number.isInteger(amount) || amount <= 0) throw bad('مبلغ غير صالح');
      if (amount > v.available) throw bad('الرصيد المتاح غير كافٍ');
      const d = now();
      const day = withdrawnSince(vendorId, dayStart(d));
      const month = withdrawnSince(vendorId, dayStart(d).slice(0, 7) + '-01');
      if (day + amount > Number(setting('withdraw_daily_limit'))) throw bad('تجاوز حد السحب اليومي');
      if (month + amount > Number(setting('withdraw_monthly_limit'))) throw bad('تجاوز حد السحب الشهري');
      db.prepare('UPDATE vendors SET available=available-? WHERE id=?').run(amount, vendorId);
      const r = db.prepare('INSERT INTO withdrawals(vendor_id, amount, account, at) VALUES(?,?,?,?)').run(vendorId, amount, account ?? null, d.toISOString());
      audit(actor, 'withdrawal.queue', { vendorId, amount, account });
      return r.lastInsertRowid;
    });
  }
  function releaseDue(at = now()) {
    const due = db.prepare("SELECT * FROM escrow WHERE status='held' AND release_at<=?").all(at.toISOString());
    const vendors = new Set();
    tx(db, () => {
      for (const e of due) {
        db.prepare("UPDATE escrow SET status='released' WHERE id=?").run(e.id);
        db.prepare('UPDATE vendors SET pending=pending-?, available=available+? WHERE id=?').run(e.amount, e.amount, e.vendor_id);
        vendors.add(e.vendor_id);
      }
    });
    // automatic payout to the vendor's own registered wallet accounts, within limits
    for (const id of vendors) {
      const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(id);
      const acc = JSON.parse(v.wallet_accounts || '[]')[0];
      if (!acc || v.status !== 'active' || v.available <= 0) continue;
      const room = Number(setting('withdraw_daily_limit')) - withdrawnSince(id, dayStart(at));
      const amt = Math.min(v.available, room);
      if (amt > 0) { try { queueWithdrawal(id, amt, `${acc.provider}:${acc.number}`, null); } catch { /* limits: stays available */ } }
    }
    return due.length;
  }

  // ---------- orders ----------
  function placeOrder(user, body) {
    const { items, address_id, wallet_amount = 0, client_id } = body;
    if (!Array.isArray(items) || !items.length) throw bad('السلة فارغة');
    if (client_id) { const ex = db.prepare('SELECT * FROM orders WHERE client_id=?').get(client_id); if (ex) return ex; }
    return tx(db, () => {
      const addr = db.prepare('SELECT * FROM addresses WHERE id=? AND user_id=?').get(address_id, user.id);
      if (!addr) throw bad('العنوان غير صالح');
      const zone = addr.zone_id ? db.prepare('SELECT * FROM zones WHERE id=?').get(addr.zone_id) : null;
      if (!zone) throw bad('اختر منطقة التوصيل للعنوان');
      let subtotal = 0, codModes = [];
      const lines = [];
      for (const it of items) {
        const p = db.prepare('SELECT p.*, v.status vstatus FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id WHERE p.id=?').get(it.product_id);
        const qty = Number(it.qty);
        if (!p || p.hidden || (p.vendor_id && p.vstatus !== 'active')) throw bad('منتج غير متاح');
        if (!Number.isInteger(qty) || qty < 1) throw bad('كمية غير صالحة');
        if (p.stock < qty) throw bad(`الكمية غير متوفرة: ${p.name}`);
        if (it.variant && !featureOn('variants')) throw bad('الخيارات غير مفعّلة');
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty, p.id);
        change('products', p.id);
        subtotal += p.price * qty; codModes.push(p.cod_mode);
        lines.push({ p, qty, variant: it.variant ? JSON.stringify(it.variant) : null });
      }
      const shipping = zone.free ? 0 : zone.fee;
      const total = subtotal + shipping;
      const user_ = db.prepare('SELECT balance FROM users WHERE id=?').get(user.id);
      const wallet = Math.min(Math.max(0, Math.floor(Number(wallet_amount) || 0)), user_.balance, total);
      const rest = total - wallet;
      if (rest > 0) {
        if (!featureOn('cod')) throw bad('الدفع عند الاستلام غير مفعّل؛ اشحن رصيدك');
        if (codModes.includes('none')) throw bad('أحد المنتجات لا يدعم الدفع عند الاستلام');
        if (wallet === 0 && !codModes.every((m) => m === 'full')) throw bad('الدفع الجزئي يتطلب دفع جزء من الرصيد مسبقاً');
      }
      const token = sha256(`${Math.random()}${Date.now()}`).slice(0, 24);
      const o = db.prepare('INSERT INTO orders(client_id,customer_id,address_id,zone_id,subtotal,shipping,total,paid_wallet,cod_due,track_token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(client_id ?? null, user.id, addr.id, zone.id, subtotal, shipping, total, wallet, rest, token, now().toISOString());
      for (const l of lines) db.prepare('INSERT INTO order_items(order_id,product_id,vendor_id,qty,price,variant) VALUES(?,?,?,?,?,?)').run(o.lastInsertRowid, l.p.id, l.p.vendor_id, l.qty, l.p.price, l.variant);
      if (wallet > 0) { db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(wallet, user.id); ledger(user.id, 'order_payment', -wallet, `order:${o.lastInsertRowid}`); }
      for (const vid of new Set(lines.map((l) => l.p.vendor_id).filter(Boolean))) notify('vendor', vid, `طلب جديد #${o.lastInsertRowid}`);
      audit(user.id, 'order.create', { id: o.lastInsertRowid, total });
      return db.prepare('SELECT * FROM orders WHERE id=?').get(o.lastInsertRowid);
    });
  }

  function markDelivered(orderId, actor) {
    return tx(db, () => {
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) throw notFound();
      if (o.status === 'delivered') return o;
      const d = now();
      db.prepare("UPDATE orders SET status='delivered', delivered_at=? WHERE id=?").run(d.toISOString(), orderId);
      const pct = Number(setting('commission_pct')), days = Number(setting('escrow_days'));
      const release = new Date(d.getTime() + days * 86400000).toISOString();
      for (const it of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId)) {
        const gross = it.qty * it.price;
        if (!it.vendor_id) { ledger(0, 'platform_sale', gross, `order:${orderId}`); continue; }
        const fee = Math.floor((gross * pct) / 100), net = gross - fee;
        ledger(0, 'commission', fee, `order:${orderId}`);
        db.prepare('INSERT INTO escrow(vendor_id,order_id,item_id,amount,release_at) VALUES(?,?,?,?,?)').run(it.vendor_id, orderId, it.id, net, release);
        db.prepare('UPDATE vendors SET pending=pending+? WHERE id=?').run(net, it.vendor_id);
      }
      if (o.cod_due > 0) ledger(o.customer_id, 'cod_collected', 0, `order:${orderId}:${o.cod_due}`);
      audit(actor, 'order.deliver', { orderId });
      return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    });
  }

  function approveReturn(returnId, actor) {
    return tx(db, () => {
      const r = db.prepare('SELECT * FROM returns WHERE id=?').get(returnId);
      if (!r) throw notFound();
      if (r.status !== 'requested') throw bad('تمت معالجة الطلب');
      const it = db.prepare('SELECT * FROM order_items WHERE id=?').get(r.order_item_id);
      const gross = it.qty * it.price;
      if (r.kind === 'return') {
        db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(gross, r.customer_id);
        ledger(r.customer_id, 'refund', gross, `return:${returnId}`);
        db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(it.qty, it.product_id);
        change('products', it.product_id);
        db.prepare('UPDATE order_items SET returned=1 WHERE id=?').run(it.id);
        if (it.vendor_id) {
          const e = db.prepare('SELECT * FROM escrow WHERE item_id=?').get(it.id);
          if (e && e.status === 'held') {
            db.prepare("UPDATE escrow SET status='cancelled' WHERE id=?").run(e.id);
            db.prepare('UPDATE vendors SET pending=pending-? WHERE id=?').run(e.amount, it.vendor_id);
          } else if (e) db.prepare('UPDATE vendors SET available=available-? WHERE id=?').run(e.amount, it.vendor_id);
          const pct = Number(setting('commission_pct'));
          ledger(0, 'commission_reversal', -Math.floor((gross * pct) / 100), `return:${returnId}`);
        } else ledger(0, 'platform_sale', -gross, `return:${returnId}`);
      } else {
        db.prepare('UPDATE products SET stock=MAX(0, stock-?) WHERE id=?').run(it.qty, it.product_id);
        change('products', it.product_id);
      }
      db.prepare("UPDATE returns SET status='approved' WHERE id=?").run(returnId);
      audit(actor, 'return.approve', { returnId });
    });
  }

  // ---------- health ----------
  function health() {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail: ok ? null : detail });
    const bal = db.prepare(`SELECT u.id, u.balance, COALESCE((SELECT SUM(amount) FROM ledger WHERE user_id=u.id),0) l FROM users u WHERE u.role!='admin' OR 1`).all().filter((r) => r.balance !== r.l);
    add('wallet_ledger_consistency', !bal.length, `${bal.length} حساب غير متطابق مع السجل`);
    const pend = db.prepare('SELECT COALESCE(SUM(pending),0) a FROM vendors').get().a;
    const held = db.prepare("SELECT COALESCE(SUM(amount),0) a FROM escrow WHERE status='held'").get().a;
    add('escrow_consistency', pend === held, `المعلّق ${pend} ≠ المحجوز ${held}`);
    const neg = db.prepare('SELECT COUNT(*) c FROM products WHERE stock<0').get().c;
    add('stock_non_negative', neg === 0, `${neg} منتج بمخزون سالب`);
    const negBal = db.prepare('SELECT COUNT(*) c FROM users WHERE balance<0').get().c;
    add('no_negative_balances', negBal === 0, `${negBal} رصيد سالب`);
    const failed = checks.filter((c) => !c.ok).length;
    return { score: Math.round(((checks.length - failed) / checks.length) * 100), status: failed ? 'red' : 'green', checks, repairable: bal.length > 0 };
  }
  function repairBalances(actor) {
    return tx(db, () => {
      const rows = db.prepare('SELECT id FROM users').all();
      let fixed = 0;
      for (const { id } of rows) {
        const l = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE user_id=?').get(id).s;
        const r = db.prepare('UPDATE users SET balance=? WHERE id=? AND balance!=?').run(l, id, l);
        fixed += r.changes;
      }
      audit(actor, 'health.repair', { fixed });
      return fixed;
    });
  }

  return { setting, setSetting, audit, change, featureOn, requireFeature, ledger, creditTransfer, matchSmsToTransfers, queueWithdrawal, releaseDue, placeOrder, markDelivered, approveReturn, health, repairBalances, now };
}
