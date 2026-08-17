import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db.js';
import { printObject } from '../output.js';

// mkt backup [--to DIR]
// Durability (spec §data-protection): the gz snapshot archive is the irreplaceable source of truth;
// the DB is a rebuildable projection. This mirrors BOTH to durable storage (default: iCloud Drive),
// which syncs offsite automatically. Safe to run while the daily job writes — the DB copy uses
// SQLite's online-backup API (a consistent page-level snapshot), not a naive file copy of a live WAL db.
const ICLOUD = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'mkt-backup');
const KEEP_DB_DUMPS = 7;   // retain the last week of timestamped DB dumps; gz mirror is kept whole

export default async function backup({ flags }) {
  const dir = flags.to || process.env.MKT_BACKUP_DIR || ICLOUD;
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(dir, { recursive: true });

  // 1. Consistent DB snapshot (online backup API — safe on the live WAL database).
  const db = openDb({ readonly: true });
  const dbDest = path.join(dir, `mkt-${date}.db`);
  await db.backup(dbDest);
  db.close();

  // 2. Mirror the irreplaceable gz archive (this is what rebuilds the DB via `mkt ingest`).
  const src = path.join(process.env.MKT_HOME || path.join(os.homedir(), '.mkt'), 'snapshots');
  const mirrored = fs.existsSync(src);
  if (mirrored) fs.cpSync(src, path.join(dir, 'snapshots'), { recursive: true });

  // 3. Retain only the last KEEP_DB_DUMPS timestamped dumps (each is a full consistent copy).
  const dumps = fs.readdirSync(dir).filter((f) => /^mkt-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  let pruned = 0;
  for (const f of dumps.slice(0, Math.max(0, dumps.length - KEEP_DB_DUMPS))) { fs.rmSync(path.join(dir, f)); pruned++; }

  const dbMb = Math.round(fs.statSync(dbDest).size / 1e5) / 10;
  printObject({ backed_up_to: dir, db_dump: path.basename(dbDest), db_mb: dbMb, snapshots_mirrored: mirrored, old_dumps_pruned: pruned }, flags);
  return 0;
}
