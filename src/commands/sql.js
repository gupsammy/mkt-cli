import { openDb } from '../db.js';
import { MktError } from '../errors.js';
import { printRows } from '../output.js';

// mkt sql "SELECT ..."  — raw read-only SQL against ~/.mkt/mkt.db.
// The connection is opened readonly, so a stray INSERT/UPDATE/DELETE/DROP fails at the driver
// (SQLITE_READONLY) rather than corrupting the panel — the query surface can only read.
// Output: NDJSON rows (--json) or a table. Scalars/aggregates come back as normal columns.
export default async function sql({ positionals, flags }) {
  const query = positionals.join(' ').trim();
  if (!query) {
    throw new MktError('usage', 'No SQL given.',
      'mkt sql "SELECT symbol, RSI FROM snapshots WHERE date=(SELECT max(date) FROM snapshots) AND RSI<30"');
  }

  const db = openDb({ readonly: true });
  let rows;
  try {
    rows = db.prepare(query).all();   // .all() works for SELECT/CTE/PRAGMA; readonly blocks writes
  } catch (err) {
    db.close();
    // Bad SQL / unknown column is a usage error (exit 2); hint how to list the real columns.
    throw new MktError('usage', err.message,
      'mkt sql "SELECT name FROM pragma_table_info(\'snapshots\')"');
  }
  db.close();

  if (!flags.quiet) process.stderr.write(`# rows=${rows.length}\n`);
  printRows(rows, flags);
  return 0;
}
