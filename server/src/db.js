import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer', balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY, code_hash TEXT, expires INTEGER, attempts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS zones(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, fee INTEGER NOT NULL DEFAULT 0, free INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS addresses(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL,
  lat REAL, lng REAL, zone_id INTEGER REFERENCES zones(id), details TEXT);
CREATE TABLE IF NOT EXISTS vendors(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), shop_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', wallet_accounts TEXT DEFAULT '[]',
  available INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, paid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS vendor_follows(user_id INTEGER, vendor_id INTEGER, PRIMARY KEY(user_id, vendor_id));
CREATE TABLE IF NOT EXISTS contracts(
  id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  data_enc TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'submitted', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY, vendor_id INTEGER REFERENCES vendors(id), name TEXT NOT NULL,
  price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, cod_mode TEXT NOT NULL DEFAULT 'none',
  variants TEXT DEFAULT '[]', hidden INTEGER NOT NULL DEFAULT 0, image TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, client_id TEXT UNIQUE, customer_id INTEGER NOT NULL REFERENCES users(id),
  address_id INTEGER REFERENCES addresses(id), zone_id INTEGER, subtotal INTEGER NOT NULL,
  shipping INTEGER NOT NULL, total INTEGER NOT NULL, paid_wallet INTEGER NOT NULL DEFAULT 0,
  cod_due INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', driver_id INTEGER,
  track_token TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL,
  vendor_id INTEGER, qty INTEGER NOT NULL, price INTEGER NOT NULL, variant TEXT, returned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL,
  ref TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS escrow(
  id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL, order_id INTEGER NOT NULL, item_id INTEGER,
  amount INTEGER NOT NULL, release_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'held');
CREATE TABLE IF NOT EXISTS withdrawals(
  id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL, amount INTEGER NOT NULL, account TEXT,
  status TEXT NOT NULL DEFAULT 'queued', at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS transfers(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, ref TEXT, ref_hash TEXT UNIQUE,
  proof_hash TEXT UNIQUE, proof_enc TEXT, status TEXT NOT NULL DEFAULT 'pending', source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sms_log(
  id INTEGER PRIMARY KEY, body TEXT, amount INTEGER, ref TEXT, matched_transfer INTEGER,
  at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS returns(
  id INTEGER PRIMARY KEY, order_item_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, kind TEXT NOT NULL,
  reason TEXT, status TEXT NOT NULL DEFAULT 'requested', at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS features(key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, label TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY, text TEXT NOT NULL, placement TEXT DEFAULT 'home', active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS social_posts(
  id INTEGER PRIMARY KEY, product_id INTEGER, channel TEXT, status TEXT, views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS driver_locations(driver_id INTEGER PRIMARY KEY, lat REAL, lng REAL, at TEXT);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, actor INTEGER, action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')));
CREATE TABLE IF NOT EXISTS feature_requests(
  id INTEGER PRIMARY KEY, requester INTEGER, request TEXT NOT NULL, card TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'analyzed', at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS changes(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id INTEGER, op TEXT NOT NULL);
`;

export const DEFAULT_FEATURES = [
  ['vendors', 'نظام التجار المتعددين'],
  ['fulfillment', 'خدمة التخزين الداخلي'],
  ['image_processor', 'معالج الصور الآلي'],
  ['variants', 'خيارات المنتج (ألوان/مقاسات)'],
  ['cod', 'الدفع عند الاستلام'],
  ['social_broadcast', 'النشر عبر وسائل التواصل'],
  ['announcements', 'الإعلانات والشريط الإخباري'],
  ['live_tracking', 'تتبع المندوب الحي'],
];

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE vendors ADD COLUMN paid_until TEXT'); } catch { /* already present */ }
  const f = db.prepare('INSERT OR IGNORE INTO features(key, enabled, label) VALUES(?, 1, ?)');
  for (const [k, l] of DEFAULT_FEATURES) f.run(k, l);
  const s = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)');
  s.run('commission_pct', '10');
  s.run('escrow_days', '35');
  s.run('withdraw_daily_limit', '500000');
  s.run('withdraw_monthly_limit', '5000000');
  s.run('vendor_monthly_fee', '5000');
  s.run('sms_amount_only_match', '0');
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
