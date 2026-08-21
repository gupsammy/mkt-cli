/**
 * Output contract (spec §6/§7/§8).
 * - Data → stdout. Diagnostics/errors → stderr.
 * - Default: human table. `--json`: NDJSON for row lists, one JSON object for scalars.
 * - `--compact`: minified JSON. Cosmetics (color/align) TTY-detect; data format follows the flag.
 */

// Typed exit codes — identical across every command so an agent branches on the code.
export const EXIT = {
  ok: 0, generic: 1, usage: 2, not_found: 3, auth: 4, upstream: 5, conflict: 7,
};
const CODE_TO_EXIT = { bad_filter: 2, bad_column: 2, usage: 2, not_found: 3, unknown_symbol: 3, auth: 4, upstream: 5, conflict: 7 };

const isTTY = () => process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

/** Print a list of row objects. NDJSON under --json, aligned table otherwise. */
export function printRows(rows, { json, compact } = {}) {
  if (json || compact) {
    for (const r of rows) process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (!rows.length) { process.stdout.write('(no rows)\n'); return; }
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => fmt(r[c]).length)));
  const line = (cells) => cells.map((s, i) => s.padEnd(w[i])).join('  ').trimEnd();
  const bar = isTTY() ? (s) => `\x1b[1m${s}\x1b[0m` : (s) => s;
  process.stdout.write(bar(line(cols)) + '\n');
  for (const r of rows) process.stdout.write(line(cols.map((c) => fmt(r[c]))) + '\n');
}

/** Print a single object (scalar result: quote row, region summary, etc.). */
export function printObject(obj, { json, compact } = {}) {
  if (json) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); return; }
  if (compact) { process.stdout.write(JSON.stringify(obj) + '\n'); return; }
  for (const [k, v] of Object.entries(obj)) process.stdout.write(`${k}: ${fmt(v)}\n`);
}

const fmt = (v) => {
  if (v == null) return '';
  if (typeof v !== 'number') return Array.isArray(v) ? v.join(',') : String(v);
  if (Number.isInteger(v)) return String(v);
  const rounded = Math.round(v * 1e4) / 1e4;
  // Never let 4-decimal rounding collapse a non-zero value to 0 (sub-$0.0001 tickers, issue #14):
  // fall back to significant-figure formatting so the value stays non-zero and readable. (-0 === 0,
  // so this covers small negatives too.) JSON/compact bypass fmt entirely and keep full precision.
  if (rounded === 0) return String(Number(v.toPrecision(4)));
  return String(rounded);
};

/** Emit a typed error to stderr and return the exit code. */
export function printError(err, { json } = {}) {
  const code = err.code || 'generic';
  const exit = CODE_TO_EXIT[code] ?? EXIT.generic;
  if (json) {
    process.stderr.write(JSON.stringify({ error: code, message: err.message, hint: err.hint ?? null }) + '\n');
  } else {
    process.stderr.write(`error: ${err.message}\n`);
    if (err.hint) process.stderr.write(`hint:  ${err.hint}\n`);
  }
  return exit;
}
