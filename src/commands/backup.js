import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
  //    Staged like the gz mirror: a process killed mid-backup would otherwise leave a partial file
  //    under a valid-looking name, and a half-written SQLite file is non-zero, so the size guard below
  //    can't catch it — it would count toward KEEP_DB_DUMPS and eventually evict a good dump.
  const dbTmp = `${dbDest}.tmp`;
  const db = openDb({ readonly: true });
  let rows;
  try {
    rows = db.prepare('SELECT COUNT(*) c FROM snapshots').get().c;
    if (!rows) throw new MktError('not_found', 'Panel is empty — nothing to back up.', 'mkt ingest --region america');
    await db.backup(dbTmp);
  } catch (e) {
    fs.rmSync(dbTmp, { force: true });
    throw e;
  } finally {
    db.close();
  }
  fs.renameSync(dbTmp, dbDest);   // publish only a complete dump

  // 2. Mirror the irreplaceable gz archive (this is what rebuilds the DB via `mkt ingest`).
  //    Past days are immutable once written, so skip what is already mirrored — cpSync defaults to
  //    force:true, which rewrites every file and resets its mtime, making iCloud re-upload the entire
  //    archive nightly (~3 GB/yr of churn to add ~12 MB).
  const dstSnap = path.join(dir, 'snapshots');
  const regions = fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const today = new Set(regions.map((r) => path.join(src, r, `${todayFor(r)}.ndjson.gz`)));

  fs.cpSync(src, dstSnap, {
    recursive: true, force: false, errorOnExist: false,
    filter: (from, to) => {
      // publish() is the SOLE writer for the current day. Letting cpSync copy it first would mirror a
      // possibly mid-write file unverified, and publish()'s "keep the existing mirror" fallback would
      // then preserve that truncated copy forever (force:false skips it, and publish only ever looks
      // at the current date, so no later run revisits it).
      if (today.has(from)) return false;
      if (fs.statSync(from).isDirectory()) return true;
      // Self-heal: force:false alone would keep a short mirror left by an interrupted earlier run.
      if (fs.existsSync(to) && fs.statSync(to).size !== fs.statSync(from).size) fs.rmSync(to);
      return true;
    },
  });

  // `record` is overwrite-idempotent, so today's file can change after it was first mirrored.
  // Staged and gunzip-verified, so a copy that catches `record` mid-write never replaces a good one.
  let refreshed = 0;
  for (const region of regions) {
    const name = `${todayFor(region)}.ndjson.gz`;
    const from = path.join(src, region, name);
    if (fs.existsSync(from) && await publish(from, path.join(dstSnap, region, name))) refreshed++;
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
async function publish(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.tmp`;
  try {
    fs.copyFileSync(from, tmp);
    await verifyGzip(tmp);
    fs.renameSync(tmp, to);
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;   // mid-write source; the existing mirror stays intact and tomorrow's run catches up
  }
}

// Stream through gunzip and discard. The CRC/ISIZE trailer only validates if the whole stream
// decompresses, so this is a real integrity check — streamed rather than gunzipSync'd so a ~12 MB gz
// doesn't materialize its ~100 MB expansion in memory just to be thrown away.
function verifyGzip(file) {
  return pipeline(fs.createReadStream(file), zlib.createGunzip(), new Writable({ write(_c, _e, cb) { cb(); } }));
}
