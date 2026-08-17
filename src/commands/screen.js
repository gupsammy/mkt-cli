import { scan, fieldSet } from '../providers/tradingview.js';
import { parseWhere, validateColumns } from '../filter.js';
import { printRows } from '../output.js';

export default async function screen({ flags }) {
  const region = flags.region || 'america';
  const columns = (flags.columns || 'name,close,change,volume').split(',').map((s) => s.trim());
  const limit = Math.min(parseInt(flags.limit || '50', 10), 500);
  const wheres = flags.where || [];

  const fs = await fieldSet(region);
  const { filter, cols } = parseWhere(wheres, fs);

  // --liquid: bundle the "real, tradeable US stock" floor (common stock, >$1B cap, >$5, >500k vol).
  // Excludes penny/OTC base-effect junk. US-equity oriented — has no effect on forex/crypto/econ.
  if (flags.liquid) {
    filter.unshift(
      { left: 'typespecs', operation: 'has', right: ['common'] },
      { left: 'market_cap_basic', operation: 'egreater', right: 1e9 },
      { left: 'close', operation: 'greater', right: 5 },
      { left: 'volume', operation: 'egreater', right: 5e5 },
    );
  }

  let sort;
  if (flags.sort) {
    const desc = flags.sort.startsWith('-');
    const by = desc ? flags.sort.slice(1) : flags.sort;
    cols.add(by);
    sort = { sortBy: by, sortOrder: desc ? 'desc' : 'asc' };
  }
  validateColumns(new Set([...columns, ...cols]), fs);   // D2: reject typos before the scan

  const { total, rows } = await scan({ region, columns, filter, sort, range: [0, limit] });
  const out = rows.map((r) => ({ symbol: r.s, ...Object.fromEntries(columns.map((c, i) => [c, r.d[i]])) }));

  if (!flags.quiet) process.stderr.write(`# matches=${total} returned=${out.length} has_more=${total > out.length}\n`);
  printRows(out, flags);
  return 0;
}
