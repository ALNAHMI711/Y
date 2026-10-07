import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';

const NAME = /^app-\d{8}T\d{6}Z\.db$/;
export const isBackupName = (n) => NAME.test(n);

export async function createBackup(db, dir, keep = 14, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const name = `app-${stamp}.db`;
  await backup(db, path.join(dir, name)); // consistent online snapshot, safe while serving requests
  const all = listBackups(dir);
  for (const old of all.slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });
  return name;
}
export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isBackupName).sort().reverse()
    .map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size }));
}
