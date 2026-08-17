import { scan, MktError } from '../providers/tradingview.js';
import { printRows } from '../output.js';

// Compact but useful default row for a live snapshot.
const COLS = ['name', 'close', 'change', 'change_abs', 'volume', 'relative_volume_10d_calc', 'RSI', 'market_cap_basic'];

export default async function quote({ positionals, flags }) {
  const symbols = positionals;
  if (!symbols.length) throw new MktError('usage', 'quote needs one or more symbols.', 'mkt quote NASDAQ:AAPL NASDAQ:MSFT');
  const region = flags.region || 'america';

  const { rows } = await scan({ region, columns: COLS, symbols, range: [0, symbols.length] });
  if (!rows.length) throw new MktError('not_found', `No data for: ${symbols.join(', ')}.`, `mkt search ${symbols[0].split(':').pop()} --json`);
  const out = rows.map((r) => ({ symbol: r.s, ...Object.fromEntries(COLS.map((c, i) => [c, r.d[i]])) }));
  printRows(out, flags);
  return 0;
}
