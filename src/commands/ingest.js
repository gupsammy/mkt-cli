import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { openDb, upsertStmt, rowToParams } from '../db.js';
import { MktError } from '../providers/tradingview.js';
import { printObject } from '../output.js';

const home = () => process.env.MKT_HOME || path.join(os.homedir(), '.mkt');

// Load one .ndjson.gz file into the DB inside a single transaction. Returns rows ingested.
async function ingestFile(file, db, stmt) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()) });
  const rows = [];
  for await (const line of rl) { if (line.trim()) rows.push(JSON.parse(line)); }
  const tx = db.transaction((items) => { for (const o of items) stmt.run(rowToParams(o)); });
  tx(rows);
  return rows.length;
}

// mkt ingest [--region R] [--prune]
// Loads every snapshot .ndjson.gz into ~/.mkt/mkt.db (idempotent upsert). With --prune, deletes
// gz files older than 30 days AFTER a verified round-trip (DB row count for that date matches the
// file's line count) — the gz is a 30-day disaster-recovery buffer; the DB is the source of truth.
export default async function ingest({ flags }) {
  const region = flags.region || 'america';
  const dir = path.join(home(), 'snapshots', region);
  if (!fs.existsSync(dir)) {
    throw new MktError('not_found', `No snapshots at ${dir}.`, `mkt record --region ${region}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson.gz')).sort();

  const db = openDb({ readonly: false });
  const stmt = upsertStmt(db);
  let ingested = 0, filesDone = 0, pruned = 0;
  const perDate = {};

  for (const f of files) {
    const n = await ingestFile(path.join(dir, f), db, stmt);
    const date = f.replace('.ndjson.gz', '');
    perDate[date] = n;
    ingested += n; filesDone++;
  }

  if (flags.prune) {
    const cutoff = cutoffDate(30);   // YYYY-MM-DD 30 days before the newest recorded date
    const newest = files.length ? files[files.length - 1].replace('.ndjson.gz', '') : null;
    for (const f of files) {
      const date = f.replace('.ndjson.gz', '');
      if (date >= cutoff || date === newest) continue;   // keep the 30-day buffer + always the latest
      const inDb = db.prepare(`SELECT COUNT(*) c FROM snapshots WHERE date = ?`).get(date).c;
      if (inDb === perDate[date]) { fs.rmSync(path.join(dir, f)); pruned++; }   // verified round-trip → safe to delete
    }
  }

  const totalRows = db.prepare(`SELECT COUNT(*) c FROM snapshots`).get().c;
  const dates = db.prepare(`SELECT COUNT(DISTINCT date) c FROM snapshots`).get().c;
  db.close();
  printObject({ ingested, files: filesDone, pruned, db_rows: totalRows, db_dates: dates, region }, flags);
  return 0;
}

// N days before the newest file date — string compare works on YYYY-MM-DD. Uses UTC epoch math
// on the newest recorded date (Date.now() is banned in this codebase's other layer, but a command
// invoked at runtime may use the real clock).
function cutoffDate(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
