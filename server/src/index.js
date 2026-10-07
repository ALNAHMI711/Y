import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from './app.js';
import { createBackup } from './backup.js';
import { whatsappSender } from './whatsapp.js';

const dataDir = process.env.DATA_DIR ?? path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
// secrets are generated once and kept outside git (data/ is ignored)
function secretFile(name, bytes) {
  const f = path.join(dataDir, name);
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(bytes).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(f, 'utf8'), 'hex');
}
const secret = process.env.APP_SECRET ?? secretFile('app.secret', 32).toString('hex');
const encKey = process.env.ENC_KEY ? Buffer.from(process.env.ENC_KEY, 'hex') : secretFile('enc.key', 32);
if (encKey.length !== 32) throw new Error('ENC_KEY must be 64 hex chars');

const { server, services, db } = createApp({
  dbPath: path.join(dataDir, 'app.db'), secret, encKey,
  adminPhone: process.env.ADMIN_PHONE, supportPhone: process.env.SUPPORT_PHONE,
  whatsapp: whatsappSender({ token: process.env.WA_TOKEN, phoneId: process.env.WA_PHONE_ID, template: process.env.WA_TEMPLATE }),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
  anthropicKey: process.env.ANTHROPIC_API_KEY, copilotModel: process.env.COPILOT_MODEL,
  backupDir: path.join(dataDir, 'backups'), backupKeep: Number(process.env.BACKUP_KEEP ?? 14),
  ingestKey: process.env.INGEST_KEY, devOtp: process.env.DEV_OTP === '1',
});
setInterval(() => services.releaseDue(), 60 * 60 * 1000).unref();
// daily snapshot (first one shortly after start), keeps the newest BACKUP_KEEP files
const snap = () => createBackup(db, path.join(dataDir, 'backups'), Number(process.env.BACKUP_KEEP ?? 14)).catch((e) => console.error('backup failed:', e.message));
setTimeout(snap, 30_000).unref(); setInterval(snap, 24 * 60 * 60 * 1000).unref();
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Thaqafat Watan server on :${port}`));
