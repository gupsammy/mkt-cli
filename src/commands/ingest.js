import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { openDb, upsertStmt, rowToParams } from '../db.js';
import { MktError } from '../errors.js';
import { notify } from '../notify.js';
import { printObject } from '../output.js';

const home = () => process.env.MKT_HOME || path.join(os.homedir(), '.mkt');
const NOTIFY_BODY_MAX = 3500;   // Telegram allows 4096 chars; leave room for title/context

// Load one .ndjson.gz file into the DB inside a single transaction. Returns a result so one bad
// file cannot abort the caller's loop. Byte offsets refer to the decompressed NDJSON stream.
// region is stamped here (not in the NDJSON): the archive directory is the authority on it.
async function ingestFile(file, db, stmt, region) {
  const rows = [];
  let lineNumber = 0, byteOffset = 0, failedLine = null, failedByte = 0;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()) });
    for await (const line of rl) {
      lineNumber++;
      const lineStart = byteOffset;
      byteOffset += Buffer.byteLength(line) + 1;
      if (!line.trim()) continue;
      try {
        rows.push({ ...JSON.parse(line), region });
      } catch (error) {
        failedLine = lineNumber;
        failedByte = lineStart;
        throw error;
      }
    }
    const tx = db.transaction((items) => { for (const o of items) stmt.run(rowToParams(o)); });
    tx(rows);
    return { ok: true, rows: rows.length };
  } catch (error) {
    return { ok: false, error, line: failedLine, byte: failedLine == null ? byteOffset : failedByte };
  }
}

// mkt ingest [--region R] [--all] [--prune]
// Loads snapshot .ndjson.gz files into ~/.mkt/mkt.db (idempotent upsert). Incremental by default:
// only files on/after the region's newest ingested date replay — ">=" not ">" because `record`
// replaces today's file on every run, so today must be re-absorbed. --all replays every file (full
// rebuild: fresh machine, restored archive, relabeled days).
// --prune is DEPRECATED and not used by the scheduled job: the gz archive is the source of truth and
// is kept forever (it is unrecoverable; the DB is a projection this command can always rebuild from
// it). It still deletes gz >30d after a verified round-trip if you ask for it — and it implies
// --all (re-reads the whole archive), since the round-trip is only verified for replayed files.
// See `mkt backup`.
export default async function ingest(args) {
  const region = args.flags.region || 'america';
  try {
    return await runIngest(args);
  } catch (error) {
    if (!args.flags['no-notify'] && !['usage', 'not_found'].includes(error.code)) {
      const body = `${region}: ${error.message}`;
      await notify('mkt ingest failed', body.length > NOTIFY_BODY_MAX ? body.slice(0, NOTIFY_BODY_MAX - 1) + '…' : body);
    }
    throw error;
  }
}

async function runIngest({ flags }) {
  const region = flags.region || 'america';
  const dir = path.join(home(), 'snapshots', region);
  if (!fs.existsSync(dir)) {
    throw new MktError('not_found', `No snapshots at ${dir}.`, `mkt record --region ${region}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson.gz')).sort();

  const db = openDb({ readonly: false });
  const stmt = upsertStmt(db);

  // High-water mark is per-region. Rows ingested before the region column existed are NULL and
  // don't count — so the first post-migration run replays everything once and stamps them.
  // --prune implies --all: the verified-round-trip check below compares DB counts against rows
  // replayed THIS run (perDate), and an incremental run never replays the >30d prune candidates —
  // pruning on stale counts would delete gz files nothing verified.
  const maxDate = db.prepare(`SELECT MAX(date) d FROM snapshots WHERE region = ?`).get(region).d;
  const all = flags.all || flags.prune || !maxDate;
  // A failed file has no rows, so later successes can advance maxDate past it. Include every archive
  // date missing from the projection or that corrupt day would become a permanent silent hole.
  const have = all ? null : new Set(db.prepare(
    `SELECT DISTINCT date FROM snapshots WHERE region = ?`).all(region).map((r) => r.date));
  const todo = all ? files : files.filter((f) => {
    const date = f.replace('.ndjson.gz', '');
    return date >= maxDate || !have.has(date);
  });

  let ingested = 0, filesDone = 0, pruned = 0;
  const perDate = {};
  const failures = [];

  for (const f of todo) {
    const result = await ingestFile(path.join(dir, f), db, stmt, region);
    if (!result.ok) {
      failures.push({ file: f, ...result });
      continue;
    }
    const date = f.replace('.ndjson.gz', '');
    perDate[date] = result.rows;
    ingested += result.rows; filesDone++;
  }

  if (flags.prune && !failures.length) {
    const cutoff = cutoffDate(30);   // YYYY-MM-DD 30 days before the newest recorded date
    const newest = files.length ? files[files.length - 1].replace('.ndjson.gz', '') : null;
    for (const f of files) {
      const date = f.replace('.ndjson.gz', '');
      if (date >= cutoff || date === newest) continue;   // keep the 30-day buffer + always the latest
      const inDb = db.prepare(`SELECT COUNT(*) c FROM snapshots WHERE date = ? AND region = ?`).get(date, region).c;
      if (inDb === perDate[date]) { fs.rmSync(path.join(dir, f)); pruned++; }   // verified round-trip → safe to delete
    }
  }

  const totalRows = db.prepare(`SELECT COUNT(*) c FROM snapshots`).get().c;
  const dates = db.prepare(`SELECT COUNT(DISTINCT date) c FROM snapshots`).get().c;
  db.close();
  const skipped = files.length - todo.length;
  // A restored/partially-replayed archive is invisible in a bare count — say what was skipped and
  // how to replay it, so "skipped" never silently reads as "covered".
  if (skipped && !flags.quiet) {
    process.stderr.write(`# skipped=${skipped} file(s) before ${maxDate} (already ingested); mkt ingest --all replays everything\n`);
  }
  const summary = { ingested, files: filesDone, skipped, pruned, db_rows: totalRows, db_dates: dates, region };
  if (failures.length) summary.failed = failures.length;
  printObject(summary, flags);
  if (failures.length) {
    const detail = failures.map(formatFailure).join('; ');
    const first = failures[0];
    const hint = `gzip -cd ${shellQuote(path.join(dir, first.file))} | sed -n '${first.line ?? 1}p'`;
    throw new MktError('generic', `Failed to ingest ${failures.length} snapshot file(s): ${detail}.`, hint);
  }
  return 0;
}

function formatFailure(failure) {
  const offset = failure.line == null
    ? `after ${failure.byte} decompressed bytes`
    : `line ${failure.line}, byte ${failure.byte}`;
  return `${failure.file}: ${offset} (${failure.error.message})`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

// N days before the newest file date — string compare works on YYYY-MM-DD. Uses UTC epoch math
// on the newest recorded date (Date.now() is banned in this codebase's other layer, but a command
// invoked at runtime may use the real clock).
function cutoffDate(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
