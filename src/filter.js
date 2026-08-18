/**
 * `--where` mini-language → scanner filter objects.
 * Maps the AND subset only (spec §4): each --where is one clause, all AND-combined.
 *
 *   RSI < 30            → {left:'RSI', operation:'less',    right:30}
 *   Perf.3M >= 15       → {left:'Perf.3M', operation:'egreater', right:15}
 *   close > SMA200      → {left:'close', operation:'greater', right:'SMA200'}   (column-vs-column)
 *   RSI between 55,72   → {left:'RSI', operation:'in_range', right:[55,72]}
 *   typespecs has common→ {left:'typespecs', operation:'has', right:['common']}
 *   sector = Technology → {left:'sector', operation:'equal', right:'Technology'}
 *
 * `fieldSet` disambiguates a non-numeric right side: a valid column name → column reference,
 * otherwise a string literal. It also collects every referenced column for D2 validation.
 */
import { MktError } from './errors.js';

const OPS = [
  ['>=', 'egreater'], ['<=', 'eless'], ['!=', 'nequal'],
  ['>', 'greater'], ['<', 'less'], ['=', 'equal'],
];

const baseCol = (c) => c.split('|')[0];   // strip |60 intraday suffix for validation
const num = (s) => { const n = Number(s); return Number.isFinite(n) && s.trim() !== '' ? n : null; };
const unquote = (s) => s.replace(/^['"]|['"]$/g, '');

export function parseWhere(exprs, fieldSet) {
  const filter = [];
  const cols = new Set();
  const useCol = (c) => { cols.add(c); return c; };

  for (const raw of exprs) {
    const expr = raw.trim();
    let m;

    // between
    if ((m = expr.match(/^(\S+)\s+between\s+(.+)$/i))) {
      const [, left, rest] = m;
      const parts = rest.split(',').map((x) => num(x));
      if (parts.length !== 2 || parts.some((x) => x === null)) throw badFilter(raw, 'between needs two numbers: `RSI between 55,72`');
      filter.push({ left: useCol(left), operation: 'in_range', right: parts });
      continue;
    }
    // has
    if ((m = expr.match(/^(\S+)\s+has\s+(.+)$/i))) {
      const [, left, val] = m;
      filter.push({ left: useCol(left), operation: 'has', right: [unquote(val.trim())] });
      continue;
    }
    // comparison operators
    let matched = false;
    for (const [sym, op] of OPS) {
      const idx = expr.indexOf(sym);
      if (idx <= 0) continue;
      const left = expr.slice(0, idx).trim();
      const rightRaw = expr.slice(idx + sym.length).trim();
      if (!left || !rightRaw) break;
      let right;
      const n = num(rightRaw);
      if (n !== null) right = n;
      else if (fieldSet && fieldSet.has(baseCol(unquote(rightRaw)))) right = useCol(unquote(rightRaw));  // column-vs-column
      else right = unquote(rightRaw);                                                                    // string literal
      filter.push({ left: useCol(left), operation: op, right });
      matched = true;
      break;
    }
    if (!matched) throw badFilter(raw, 'expected `<col> <op> <value>`, `<col> between a,b`, or `<col> has v`');
  }
  return { filter, cols };
}

function badFilter(raw, why) {
  return new MktError('bad_filter', `Cannot parse --where "${raw}": ${why}.`, 'mkt fields --json');
}

/** D2: validate every referenced column against the region's field catalog. */
export function validateColumns(cols, fieldSet) {
  const bad = [...cols].filter((c) => !fieldSet.has(baseCol(c)));
  if (bad.length) {
    throw new MktError('bad_column', `Unknown column(s): ${bad.join(', ')}. The scanner returns null (not an error) for these.`,
      `mkt fields --search ${baseCol(bad[0])} --json`);
  }
}
