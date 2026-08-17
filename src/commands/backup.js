import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { openDb } from '../db.js';
import { MktError } from '../providers/tradingview.js';
import { todayFor } from '../tzdate.js';
import { printObject } from '../output.js';

// mkt backup [--to DIR]
// Durability (spec §data-protection): the gz snapshot archive is the irreplaceable source of truth;
// the DB is a rebuildable projection. This mirrors BOTH to durable storage (default: iCloud Drive),
// which syncs offsite automatically. Safe to run while the daily job writes — the DB copy uses
// SQLite's online-backup API (a consistent page-level snapshot), not a naive file copy of a live WAL db.
//
// Failure policy: a backup that silently doesn't happen is worse than no backup, because it stops you
// looking. Every precondition here fails loudly with a typed MktError rather than exiting 0.
const ICLOUD = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'mkt-backup');
const KEEP_DB_DUMPS = 7;   // retain the last week of timestamped DB dumps; gz mirror is kept whole

export default async function backup({ flags }) {
  const explicit = flags.to || process.env.MKT_BACKUP_DIR;
  const dir = explicit || ICLOUD;

  // mkdirSync(recursive) would fabricate the whole CloudDocs chain as ordinary local directories if
  // iCloud Drive is off or still initializing — we'd report an offsite backup that never leaves the
  // machine. Require the container to pre-exist when falling back to the default; an explicit --to is
  // the user asserting the target, so create it freely.
  if (!explicit && !fs.existsSync(path.dirname(ICLOUD))) {
    throw new MktError('not_found', `iCloud Drive not found at ${path.dirname(ICLOUD)}.`,
      'mkt backup --to /path/to/durable/dir');
  }

  const src = path.join(process.env.MKT_HOME || path.join(os.homedir(), '.mkt'), 'snapshots');
  if (!fs.existsSync(src)) {
    throw new MktError('not_found', `No snapshot archive at ${src}.`, 'mkt record --region america');
  }

  const dbDir = path.join(dir, 'db');   // dumps get their own dir so retention can only delete our files
  fs.mkdirSync(dbDir, { recursive: true });

  // 1. Consistent DB snapshot (online backup API — safe on the live WAL database).
  //    Count first: openDb autocreates+migrates an empty DB on a fresh machine (db.js), so a 0-row
  //    dump would otherwise look like a successful backup.
  const date = todayFor();
  const dbDest = path.join(dbDir, `mkt-${date}.db`);
  const db = openDb({ readonly: true });
  let rows;
  try {
    rows = db.prepare('SELECT COUNT(*) c FROM snapshots').get().c;
    if (!rows) throw new MktError('not_found', 'Panel is empty — nothing to back up.', 'mkt ingest --region america');
    await db.backup(dbDest);
  } finally {
    db.close();
  }

  // 2. Mirror the irreplaceable gz archive (this is what rebuilds the DB via `mkt ingest`).
  //    gz files are immutable once written, so skip what is already mirrored — cpSync defaults to
  //    force:true, which rewrites every file and resets its mtime, making iCloud re-upload the entire
  //    archive nightly (~3 GB/yr of churn to add ~12 MB).
  const dstSnap = path.join(dir, 'snapshots');
  fs.cpSync(src, dstSnap, { recursive: true, force: false, errorOnExist: false });

  // `record` is overwrite-idempotent, so today's file can change after it was first mirrored;
  // force:false would leave the stale copy. Re-publish just those, staged and verified.
  let refreshed = 0;
  for (const region of fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const name = `${todayFor(region.name)}.ndjson.gz`;
    const from = path.join(src, region.name, name);
    if (fs.existsSync(from) && publish(from, path.join(dstSnap, region.name, name))) refreshed++;
  }

  // 3. Retain only the last KEEP_DB_DUMPS timestamped dumps (each is a full consistent copy).
  //    Guarded on the new dump being non-empty so a bad run can't cost us the oldest good one.
  const dbBytes = fs.statSync(dbDest).size;
  let pruned = 0;
  if (dbBytes > 0) {
    const dumps = fs.readdirSync(dbDir).filter((f) => /^mkt-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of dumps.slice(0, Math.max(0, dumps.length - KEEP_DB_DUMPS))) { fs.rmSync(path.join(dbDir, f)); pruned++; }
  }

  printObject({
    backed_up_to: dir, db_dump: path.basename(dbDest), db_mb: Math.round(dbBytes / 1e5) / 10,
    db_rows: rows, snapshots_refreshed: refreshed, old_dumps_pruned: pruned,
  }, flags);
  return 0;
}

// Copy through a temp file and verify the gzip stream decompresses before replacing the live mirror.
// `record` writes the day's file in place, so a concurrent copy can capture a truncated stream —
// staging keeps a good previous backup rather than overwriting it with a corrupt one.
function publish(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.tmp`;
  try {
    fs.copyFileSync(from, tmp);
    zlib.gunzipSync(fs.readFileSync(tmp));   // throws on a truncated/corrupt stream
    fs.renameSync(tmp, to);
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;   // mid-write source; the existing mirror stays intact and tomorrow's run catches up
  }
}
