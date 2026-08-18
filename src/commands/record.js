import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { scan, fieldSet } from '../providers/tradingview.js';
import { MktError } from '../errors.js';
import { validateColumns } from '../filter.js';
import { todayFor } from '../tzdate.js';
import { printObject } from '../output.js';
import { WIDE } from '../schema.js';   // shared with db.js so disk NDJSON and SQLite never drift

export default async function record({ flags }) {
  const region = flags.region || 'america';
  const columns = flags.columns ? flags.columns.split(',').map((s) => s.trim()) : WIDE;

  // Freshness guard (the day-one incident): this machine's clock is not the market's, and the
  // scanner has no "as of" — recording before the NY close stores the PREVIOUS session under
  // today's date, permanently. Equities only; --force asserts the label is right anyway.
  if (region === 'america' && !flags.force) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const closed = !['Sat', 'Sun'].includes(p.weekday) && `${p.hour}:${p.minute}` >= '16:05';
    if (!closed) {
      throw new MktError('conflict',
        `NY time is ${p.weekday} ${p.hour}:${p.minute} — the session dated ${todayFor(region)} hasn't closed; recording now would store the previous session under that date.`,
        'run after 16:05 ET, or mkt record --force if the label is truly right');
    }
  }

  const fs2 = await fieldSet(region);
  validateColumns(new Set(columns), fs2);   // D2

  // Two-step: get the count, then pull the whole universe.
  const { total } = await scan({ region, columns: ['name'], range: [0, 1] });
  const { rows } = await scan({ region, columns, range: [0, total] });

  const date = todayFor(region);
  const dir = path.join(process.env.MKT_HOME || path.join(os.homedir(), '.mkt'), 'snapshots', region);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.ndjson.gz`);   // gzipped NDJSON; idempotent (overwrite today)

  // Session-staleness guard: the clock guard can't see market holidays — 17:00 ET on July 4 is
  // "after the close" of a session that never happened, and the scanner just re-serves the last
  // one. If ~every symbol's close is identical to the newest already-recorded day, this is that
  // day again: refuse rather than write a phantom session the panel would read as 0% change.
  if (!flags.force && columns.includes('close')) {
    // The guard must never COST a session: a corrupt/truncated baseline (bad gz, malformed line)
    // is treated as no baseline. Worst case of proceeding is a visible, deletable phantom day;
    // worst case of throwing here is a session that exists nowhere — the scanner has no "as of".
    let ratio = 0, prev = null, compared = 0;
    try {
      ({ ratio, prev, compared } = await sameCloseRatio(dir, date, rows));
    } catch (e) {
      if (!flags.quiet) process.stderr.write(`# staleness guard skipped: could not read baseline (${e.message})\n`);
    }
    // compared >= 100: a thin previous file (narrow --columns, truncation) could make a handful
    // of matches read as 100% and block a real session with only --force as the escape.
    if (ratio > 0.99 && compared >= 100) {
      throw new MktError('conflict',
        `${Math.round(ratio * 1000) / 10}% of ${compared} closes are identical to ${prev} — market likely closed (holiday?); refusing to record a phantom session as ${date}.`,
        'mkt record --force if this is truly a new session');
    }
    // A would-have-fired match suppressed by a small sample means the PREVIOUS file is suspect
    // (thin/truncated) — that must not pass unremarked either.
    if (ratio > 0.99 && compared < 100 && !flags.quiet) {
      process.stderr.write(`# staleness guard: only ${compared} comparable closes vs ${prev} (need 100) — too few to trust, proceeding\n`);
    }
  } else if (!flags.force && !flags.quiet) {
    process.stderr.write(`# staleness guard skipped: close not in --columns\n`);
  }

  // Gzip on the fly (~8× smaller than plain NDJSON). Read back with `gzcat file | jq`.
  await writeSnapshotGz(file, date, rows);

  const bytes = fs.statSync(file).size;
  printObject({ recorded: rows.length, region, date, columns: columns.length, size_mb: Math.round(bytes / 1e5) / 10, file }, flags);
  return 0;
}

// Stage → fsync → rename, the same shape as backup.js publish(): the live archive is only ever
// REPLACED by a complete flushed file, never opened for write — createWriteStream(file) truncates
// the existing good day at open, and any interruption before the replacement bytes land (SIGKILL,
// launchd timeout, an overlapping run) destroys a snapshot the scanner cannot re-serve. The tmp is
// pid-scoped so concurrent runs can't rename each other's half-written bytes into place; pipeline()
// makes a gzip error reject instead of going unobserved and honors the compressor's backpressure;
// `flush` fsyncs the fd before close so the rename never publishes bytes the OS hasn't persisted —
// on Node < 20.10 the option is silently ignored (no fsync, no error); package.json pins >= 22,
// the floor `node --test`'s discovery semantics already require anyway. Exported for testing.
export async function writeSnapshotGz(file, date, rows) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await pipeline(
      Readable.from((function* () { for (const r of rows) yield JSON.stringify({ date, ...r }) + '\n'; })()),
      zlib.createGzip(),
      fs.createWriteStream(tmp, { flush: true }),
    );
    fs.renameSync(tmp, file);   // atomic replace, only after the bytes are safe
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new MktError('generic', `Could not write snapshot ${file}: ${e.message}`,
      'check free space and permissions on the snapshot directory');
  }
}

// Fraction of symbols whose close matches the newest recorded day BEFORE `date` (today's own file
// is excluded — re-recording the same day is legitimately identical). Exported for testing.
export async function sameCloseRatio(dir, date, rows) {
  const prevFile = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson.gz') && f.replace('.ndjson.gz', '') < date)
    .sort().pop();
  if (!prevFile) return { ratio: 0, prev: null };
  const prev = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, prevFile)).pipe(zlib.createGunzip()) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.close != null) prev.set(r.symbol, r.close);
  }
  let same = 0, compared = 0;
  for (const r of rows) {
    if (r.close == null || !prev.has(r.symbol)) continue;
    compared++;
    if (prev.get(r.symbol) === r.close) same++;
  }
  return { ratio: compared ? same / compared : 0, prev: prevFile.replace('.ndjson.gz', ''), compared };
}
