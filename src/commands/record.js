import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
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

  // Gzip on the fly (~8× smaller than plain NDJSON). Read back with `gzcat file | jq`.
  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(file);
  gzip.pipe(out);
  for (const r of rows) {
    gzip.write(JSON.stringify({ date, ...r }) + '\n');   // r = {symbol, <column>: value}
  }
  await new Promise((res, rej) => { out.on('close', res); out.on('error', rej); gzip.end(); });

  const bytes = fs.statSync(file).size;
  printObject({ recorded: rows.length, region, date, columns: columns.length, size_mb: Math.round(bytes / 1e5) / 10, file }, flags);
  return 0;
}
