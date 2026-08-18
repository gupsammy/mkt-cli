import { search } from '../providers/tradingview.js';
import { MktError } from '../errors.js';
import { printRows } from '../output.js';

export default async function searchCmd({ positionals, flags }) {
  const text = positionals.join(' ').trim();
  if (!text) throw new MktError('usage', 'search needs a query.', 'mkt search apple');
  const rows = await search({ text, type: flags.type || '', region: flags.region || '' });
  if (!flags.quiet) process.stderr.write(`# matches=${rows.length}\n`);
  printRows(rows, flags);
  return 0;
}
