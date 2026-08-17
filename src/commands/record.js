import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { scan, fieldSet } from '../providers/tradingview.js';
import { validateColumns } from '../filter.js';
import { todayFor } from '../tzdate.js';
import { printObject } from '../output.js';

// WIDE by design (spec §9a): an unused field costs a few MB; an un-recorded field is
// unrecoverable. ~70 fields spanning every category. Edit freely — you can only lose what you omit.
const WIDE = [
  'name', 'description', 'sector', 'industry', 'type', 'market_cap_basic', 'total_shares_outstanding_current', 'float_shares_outstanding',
  'close', 'open', 'high', 'low', 'change', 'change_abs', 'volume', 'average_volume_10d_calc', 'average_volume_90d_calc',
  'relative_volume_10d_calc', 'VWAP', 'gap', 'price_52_week_high', 'price_52_week_low', 'High.1M', 'Low.1M', 'High.3M', 'Low.3M',
  'RSI', 'Stoch.K', 'Stoch.D', 'MACD.macd', 'MACD.signal', 'CCI20', 'ADX', 'ATR', 'Mom',
  'SMA20', 'SMA50', 'SMA200', 'EMA20', 'EMA50', 'EMA200', 'BB.upper', 'BB.lower', 'KltChnl.upper', 'KltChnl.lower',
  'Recommend.All', 'Recommend.MA', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.Y', 'Perf.YTD', 'Volatility.D', 'Volatility.W', 'beta_1_year',
  'price_earnings_ttm', 'price_book_fq', 'price_sales_ratio', 'enterprise_value_ebitda_ttm',
  'total_revenue_ttm', 'net_income_ttm', 'ebitda_ttm', 'free_cash_flow_ttm', 'earnings_per_share_diluted_ttm', 'total_debt_fq',
  'total_revenue_yoy_growth_ttm', 'earnings_per_share_diluted_yoy_growth_ttm',
  'gross_margin', 'operating_margin', 'net_margin', 'return_on_equity', 'return_on_assets', 'debt_to_equity',
  'dividend_yield_recent',
];

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
