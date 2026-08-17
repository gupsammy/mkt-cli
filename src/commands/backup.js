import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
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
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (e) {
    throw new MktError('generic', `Backup directory is not writable: ${e.message}`,
      'check free space and permissions on the backup directory');
  }

  // 1. Consistent DB snapshot (online backup API — safe on the live WAL database).
  //    Count first: openDb autocreates+migrates an empty DB on a fresh machine (db.js), so a 0-row
  //    dump would otherwise look like a successful backup.
  const date = todayFor();
  const dbDest = path.join(dbDir, `mkt-${date}.db`);
  //    Staged like the gz mirror: a process killed mid-backup would otherwise leave a partial file
  //    under a valid-looking name, and a half-written SQLite file is non-zero, so the size guard below
  //    can't catch it — it would count toward KEEP_DB_DUMPS and eventually evict a good dump.
  const dbTmp = `${dbDest}.${process.pid}.tmp`;
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
  //    quick_check before publishing: the gz mirror is gunzip-verified, and the dump is the one
  //    artifact you would restore from that nothing else validates.
  const chk = new Database(dbTmp, { readonly: true });
  let ok;
  try { ok = chk.pragma('quick_check', { simple: true }); } finally { chk.close(); }
  if (ok !== 'ok') {
    fs.rmSync(dbTmp, { force: true });
    throw new MktError('conflict', `DB dump failed integrity check: ${ok}.`, 'mkt ingest --region america');
  }
  fs.renameSync(dbTmp, dbDest);   // publish only a complete, verified dump

  // 2. Mirror the irreplaceable gz archive (this is what rebuilds the DB via `mkt ingest`).
  //    EVERY file goes through publish() — staged, gunzip-verified, renamed — so nothing can land in
  //    the mirror unverified. A bulk cpSync could not give that: it would copy a past day that was
  //    truncated at the source without ever decompressing it, and a size comparison can't tell the
  //    difference. Past days are immutable and already verified, so they're skipped on a size match;
  //    rewriting them would reset every mtime and make iCloud re-upload the archive nightly
  //    (~3 GB/yr of churn to add ~12 MB).
  const dstSnap = path.join(dir, 'snapshots');
  const regions = fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  let refreshed = 0;
  const protectedSrc = [];   // source rotted, but a verified mirror holds it — recoverable
  const lost = [];           // source rotted with no mirror — that day is gone
  for (const region of regions) {
    const todayName = `${todayFor(region)}.ndjson.gz`;
    sweepStale(path.join(dstSnap, region));
    for (const name of fs.readdirSync(path.join(src, region)).filter((f) => f.endsWith('.ndjson.gz'))) {
      const from = path.join(src, region, name);
      const to = path.join(dstSnap, region, name);
      // `record` rewrites today's file in place (idempotent), so it is always re-published. A past day
      // is re-published only when the mirror disagrees on size — a run interrupted mid-copy.
      const isToday = name === todayName;
      const mirrored = fs.existsSync(to);
      if (!isToday && mirrored && fs.statSync(to).size === fs.statSync(from).size) continue;
      if (await publish(from, to)) refreshed++;
      // Today failing is a benign race with `record`. A past day is immutable, so it is real
      // corruption — but only *unmirrored* corruption is a loss: if a verified copy is already in the
      // backup, this command did its job and the archive is safe.
      else if (!isToday) (mirrored ? protectedSrc : lost).push(`${region}/${name}`);
    }
  }

  // 3. Retain only the last KEEP_DB_DUMPS timestamped dumps (each is a full consistent copy).
  //    A failed dump throws before the rename above, so anything named mkt-<date>.db is complete.
  const dumps = fs.readdirSync(dbDir).filter((f) => /^mkt-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  let pruned = 0;
  for (const f of dumps.slice(0, Math.max(0, dumps.length - KEEP_DB_DUMPS))) { fs.rmSync(path.join(dbDir, f)); pruned++; }

  printObject({
    backed_up_to: dir, db_dump: path.basename(dbDest), db_mb: Math.round(fs.statSync(dbDest).size / 1e5) / 10,
    db_rows: rows, snapshots_refreshed: refreshed,
    corrupt_but_backed_up: protectedSrc.length, unrecoverable: lost.length, old_dumps_pruned: pruned,
  }, flags);

  // A rotted source that IS mirrored is the system working — say so on stderr and exit 0, so one bad
  // local file can't wedge the launchd chain (backup runs before the panel-alert check, under set -e).
  if (protectedSrc.length && !flags.quiet) {
    process.stderr.write(`# corrupt source, restore from the backup: ${protectedSrc.join(', ')}\n`);
    process.stderr.write(`# cp ${path.join(dstSnap, protectedSrc[0])} ${path.join(src, protectedSrc[0])}\n`);
  }

  // A rotted source with no mirror is the one genuinely unrecoverable state: nothing to restore from,
  // and `ingest` would rebuild the panel from the bad file. Data is printed first, then fail loudly.
  if (lost.length) {
    throw new MktError('conflict', `Corrupt snapshot source with no backup copy: ${lost.join(', ')}.`,
      `gzcat ${path.join(src, lost[0])} | tail -1`);
  }
  return 0;
}

// Copy through a temp file and verify the gzip stream decompresses before replacing the live mirror.
// `record` writes the day's file in place, so a concurrent copy can capture a truncated stream —
// staging keeps a good previous backup rather than overwriting it with a corrupt one.
//
// Only a failed *integrity check* returns false. A failed copy or rename (ENOSPC, EACCES, a vanished
// backup volume) throws: a full disk and a benign mid-write race must not collapse into the same
// signal, because the launchd wrapper sees nothing but the exit code.
async function publish(from, to) {
  // pid-scoped: a catch block can't clean up after SIGKILL or a launchd timeout, and two overlapping
  // runs sharing one temp name could rename each other's half-written bytes into place.
  const tmp = `${to}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new MktError('generic', `Could not write ${to}: ${e.message}`,
      'check free space and permissions on the backup directory');
  }
  try {
    await verifyGzip(tmp);
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;   // truncated/corrupt source; any existing mirror stays intact
  }
  try {
    fs.renameSync(tmp, to);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new MktError('generic', `Could not publish ${to}: ${e.message}`,
      'check free space and permissions on the backup directory');
  }
  return true;
}

// Drop staging files a killed run left behind — nothing else sweeps them, and an unlabelled partial
// sitting in the archive syncs to iCloud forever. Day-old only, so a concurrent run's temp survives.
function sweepStale(dir) {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 86_400_000;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))) {
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
  }
}

// Stream through gunzip and discard. The CRC/ISIZE trailer only validates if the whole stream
// decompresses, so this is a real integrity check — streamed rather than gunzipSync'd so a ~12 MB gz
// doesn't materialize its ~100 MB expansion in memory just to be thrown away.
function verifyGzip(file) {
  return pipeline(fs.createReadStream(file), zlib.createGunzip(), new Writable({ write(_c, _e, cb) { cb(); } }));
}
