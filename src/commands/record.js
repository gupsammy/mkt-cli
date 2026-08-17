import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { scan, fieldSet } from '../providers/tradingview.js';
import { validateColumns } from '../filter.js';
import { todayFor } from '../tzdate.js';
import { printObject } from '../output.js';
import { WIDE } from '../schema.js';   // shared with db.js so disk NDJSON and SQLite never drift

export default async function record({ flags }) {
  const region = flags.region || 'america';
  const columns = flags.columns ? flags.columns.split(',').map((s) => s.trim()) : WIDE;

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
    gzip.write(JSON.stringify({ date, symbol: r.s, ...Object.fromEntries(columns.map((c, i) => [c, r.d[i]])) }) + '\n');
  }
  await new Promise((res, rej) => { out.on('close', res); out.on('error', rej); gzip.end(); });

  const bytes = fs.statSync(file).size;
  printObject({ recorded: rows.length, region, date, columns: columns.length, size_mb: Math.round(bytes / 1e5) / 10, file }, flags);
  return 0;
}
