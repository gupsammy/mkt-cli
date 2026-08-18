import { openDb } from '../db.js';
import { MktError } from '../errors.js';
import { printRows, printObject } from '../output.js';

const now = () => new Date().toISOString();

// mkt watchlist add <name> [--kind equity|macro] | put <name> SYM… | rm <name> [SYM…] | list [<name>]
// Hand-picked symbol sets (spec §1) — a screen/alert can scope to one instead of a whole region.
export default async function watchlist({ positionals, flags }) {
  const sub = positionals[0];
  const name = positionals[1];
  const symbols = positionals.slice(2);
  const db = openDb({ readonly: false });
  try {
    switch (sub) {
      case 'add':  return add(db, name, flags);
      case 'put':  return put(db, name, symbols, flags);
      case 'rm':   return rm(db, name, symbols, flags);
      case 'list': return list(db, name, flags);
      default:
        throw new MktError('usage', `Unknown watchlist subcommand "${sub ?? ''}".`,
          'mkt watchlist add my-semis  |  put my-semis NASDAQ:NVDA  |  rm | list');
    }
  } finally {
    db.close();
  }
}

function add(db, name, flags) {
  if (!name) throw new MktError('usage', 'Watchlist needs a name.', 'mkt watchlist add my-semis');
  const kind = flags.kind || 'equity';
  if (!['equity', 'macro'].includes(kind)) throw new MktError('usage', '--kind must be equity or macro.', null);
  try {
    const info = db.prepare(`INSERT INTO watchlists (name, kind, created) VALUES (?,?,?)`).run(name, kind, now());
    printObject({ added: name, id: info.lastInsertRowid, kind }, flags);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new MktError('conflict', `Watchlist "${name}" already exists.`, `mkt watchlist put ${name} SYMBOL`);
    throw e;
  }
  return 0;
}

// Idempotent add of symbols; auto-creates the watchlist if absent (convenience).
function put(db, name, symbols, flags) {
  if (!name || !symbols.length) throw new MktError('usage', 'Give a watchlist and symbols.', 'mkt watchlist put my-semis NASDAQ:NVDA NASDAQ:AMD');
  let wl = db.prepare(`SELECT id FROM watchlists WHERE name=?`).get(name);
  if (!wl) { const info = db.prepare(`INSERT INTO watchlists (name, kind, created) VALUES (?,?,?)`).run(name, 'equity', now()); wl = { id: info.lastInsertRowid }; }
  const stmt = db.prepare(`INSERT OR IGNORE INTO watchlist_members (watchlist_id, symbol, added) VALUES (?,?,?)`);
  const ts = now();
  const tx = db.transaction((syms) => { let added = 0; for (const s of syms) added += stmt.run(wl.id, s, ts).changes; return added; });
  const added = tx(symbols);
  const total = db.prepare(`SELECT COUNT(*) c FROM watchlist_members WHERE watchlist_id=?`).get(wl.id).c;
  printObject({ watchlist: name, added, skipped: symbols.length - added, total }, flags);
  return 0;
}

// rm with symbols → drop those members. rm without → delete the whole watchlist (cascade).
function rm(db, name, symbols, flags) {
  if (!name) throw new MktError('usage', 'Which watchlist?', 'mkt watchlist list');
  const wl = db.prepare(`SELECT id FROM watchlists WHERE name=?`).get(name);
  if (!wl) throw new MktError('not_found', `No watchlist "${name}".`, 'mkt watchlist list');
  if (symbols.length) {
    const stmt = db.prepare(`DELETE FROM watchlist_members WHERE watchlist_id=? AND symbol=?`);
    const removed = db.transaction((syms) => { let n = 0; for (const s of syms) n += stmt.run(wl.id, s).changes; return n; })(symbols);
    printObject({ watchlist: name, removed }, flags);
  } else {
    db.prepare(`DELETE FROM watchlists WHERE id=?`).run(wl.id);
    printObject({ removed_watchlist: name }, flags);
  }
  return 0;
}

function list(db, name, flags) {
  if (name) {
    const wl = db.prepare(`SELECT id, kind FROM watchlists WHERE name=?`).get(name);
    if (!wl) throw new MktError('not_found', `No watchlist "${name}".`, 'mkt watchlist list');
    const rows = db.prepare(`SELECT symbol, added FROM watchlist_members WHERE watchlist_id=? ORDER BY symbol`).all(wl.id);
    if (!flags.quiet) process.stderr.write(`# watchlist=${name} kind=${wl.kind} members=${rows.length}\n`);
    printRows(rows, flags);
  } else {
    const rows = db.prepare(
      `SELECT w.name, w.kind, (SELECT COUNT(*) FROM watchlist_members m WHERE m.watchlist_id=w.id) AS members, w.created
         FROM watchlists w ORDER BY w.name`).all();
    printRows(rows, flags);
  }
  return 0;
}

// Exported for screen.js --watchlist scoping.
export function watchlistSymbols(db, name) {
  const wl = db.prepare(`SELECT id FROM watchlists WHERE name=?`).get(name);
  if (!wl) throw new MktError('not_found', `No watchlist "${name}".`, 'mkt watchlist list');
  return db.prepare(`SELECT symbol FROM watchlist_members WHERE watchlist_id=?`).all(wl.id).map((r) => r.symbol);
}
