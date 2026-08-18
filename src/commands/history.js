import { history } from '../providers/tradingview.js';
import { MktError } from '../errors.js';
import { tradingDate } from '../tzdate.js';
import { printRows } from '../output.js';

export default async function historyCmd({ positionals, flags }) {
  const symbol = positionals[0];
  if (!symbol) throw new MktError('usage', 'history needs a symbol.', 'mkt history NASDAQ:AAPL --tf 1D');
  if (!symbol.includes(':')) throw new MktError('usage', `Qualify the exchange, e.g. NASDAQ:${symbol}.`, `mkt search ${symbol} --json`);

  const tf = flags.tf || '1D';
  const bars = parseInt(flags.bars || '300', 10);

  const { bars: rows } = await history({ symbol, tf, bars });
  // D4: attach exchange trading-date alongside raw unix t.
  const out = rows.map((b) => ({ date: tradingDate(b.t, symbol), t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));

  if (!flags.quiet) process.stderr.write(`# ${symbol} ${tf} bars=${out.length}\n`);
  printRows(out, flags);
  return 0;
}
