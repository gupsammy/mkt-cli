import { openDb } from '../db.js';
import { scan, fieldSet, MktError } from '../providers/tradingview.js';
import { parseWhere, validateColumns } from '../filter.js';
import { notify } from '../notify.js';
import { printRows, printObject } from '../output.js';

const ALERT_MAX = 2000;                 // live-alert match cap; a selective alert stays well under this
const now = () => new Date().toISOString();

// Router for `mkt alert <sub> ...`. Subcommand is positionals[0]; name (where used) is positionals[1].
export default async function alert({ positionals, flags }) {
  const sub = positionals[0];
  const name = positionals[1];
  const db = openDb({ readonly: false });
  try {
    switch (sub) {
      case 'add':    return await add(db, name, flags);
      case 'list':   return list(db, flags);
      case 'rm':     return rm(db, name, flags);
      case 'test':   return await test(db, name, flags);
      case 'check':  return await check(db, flags);
      default:
        throw new MktError('usage', `Unknown alert subcommand "${sub ?? ''}".`,
          'mkt alert add <name> --where \'RSI<30\'   |   list | rm <name> | test <name> | check');
    }
  } finally {
    db.close();
  }
}

// mkt alert add <name> --where '<expr>'... (live)  |  --sql "<SELECT>" (panel)
async function add(db, name, flags) {
  if (!name) throw new MktError('usage', 'Alert needs a name.', 'mkt alert add oversold --where \'RSI<30\'');
  const region = flags.region || 'america';
  const wheres = flags.where || [];
  const sql = flags.sql;
  if (wheres.length && sql) throw new MktError('usage', 'Use --where (live) OR --sql (panel), not both.', null);
  if (!wheres.length && !sql) throw new MktError('usage', 'Give --where \'<expr>\' (live) or --sql "<SELECT>" (panel).', null);

  let kind, query;
  if (sql) {
    kind = 'panel';
    if (!/^\s*(select|with)\b/i.test(sql)) throw new MktError('usage', 'Panel --sql must be a SELECT/WITH query.', null);
    if (!/\bsymbol\b/i.test(sql)) throw new MktError('usage', 'Panel --sql must return a `symbol` column (edge-trigger keys on it).', null);
    db.prepare(sql).all();                       // validate it runs (throws → caught by router)
    query = sql;
  } else {
    kind = 'live';
    const fs = await fieldSet(region);
    const { cols } = parseWhere(wheres, fs);      // parse + validate the filter now, not at fire time
    validateColumns(cols, fs);
    query = wheres.join('\n');
  }

  try {
    const info = db.prepare(`INSERT INTO alerts (name, kind, query, region, enabled, created) VALUES (?,?,?,?,1,?)`)
      .run(name, kind, query, region, now());
    printObject({ added: name, id: info.lastInsertRowid, kind, region, query }, flags);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new MktError('conflict', `Alert "${name}" already exists.`, `mkt alert rm ${name}`);
    throw e;
  }
  return 0;
}

function list(db, flags) {
  const rows = db.prepare(
    `SELECT a.name, a.kind, a.region, a.enabled,
            (SELECT COUNT(*) FROM alert_hits h WHERE h.alert_id=a.id) AS watching, a.query
       FROM alerts a ORDER BY a.name`).all();
  printRows(rows, flags);
  return 0;
}

function rm(db, name, flags) {
  if (!name) throw new MktError('usage', 'Which alert?', 'mkt alert list');
  const info = db.prepare(`DELETE FROM alerts WHERE name=?`).run(name);   // ON DELETE CASCADE clears hits
  if (!info.changes) throw new MktError('not_found', `No alert "${name}".`, 'mkt alert list');
  printObject({ removed: name }, flags);
  return 0;
}

// Run an alert's query once and show current matches — no state change. For authoring/tuning.
async function test(db, name, flags) {
  const a = getAlert(db, name);
  const rows = await currentRows(db, a);
  if (!flags.quiet) process.stderr.write(`# alert=${name} kind=${a.kind} matches=${rows.length}\n`);
  printRows(rows, flags);
  return 0;
}

// The loop: for each enabled alert, diff live/current matches vs alert_hits, push NEW entrants,
// update state. --kind live|panel filters (launchd runs live 15m, panel daily). --dry-run: no push/no write.
async function check(db, flags) {
  const dry = flags['dry-run'];
  const kindFilter = flags.kind;
  if (kindFilter && !['live', 'panel'].includes(kindFilter)) throw new MktError('usage', '--kind must be live or panel.', null);
  const alerts = db.prepare(`SELECT * FROM alerts WHERE enabled=1 ${kindFilter ? 'AND kind=?' : ''} ORDER BY name`)
    .all(...(kindFilter ? [kindFilter] : []));

  const addHit = db.prepare(`INSERT OR IGNORE INTO alert_hits (alert_id, symbol, first_seen) VALUES (?,?,?)`);
  const dropHit = db.prepare(`DELETE FROM alert_hits WHERE alert_id=? AND symbol=?`);
  const summary = [];

  for (const a of alerts) {
    let rows;
    try {
      rows = await currentRows(db, a);
    } catch (e) {
      process.stderr.write(`# alert "${a.name}" errored: ${e.message}\n`);
      summary.push({ alert: a.name, error: e.message });
      continue;
    }
    const current = new Set(rows.map((r) => r.symbol));
    const last = new Set(db.prepare(`SELECT symbol FROM alert_hits WHERE alert_id=?`).all(a.id).map((r) => r.symbol));
    const entered = [...current].filter((s) => !last.has(s));
    const gone = [...last].filter((s) => !current.has(s));

    if (entered.length && !dry) {
      const preview = entered.slice(0, 8).join(', ') + (entered.length > 8 ? ` +${entered.length - 8} more` : '');
      await notify(`mkt: ${a.name}`, `${entered.length} new — ${preview}`);
    }
    if (!dry) {
      const ts = now();
      const tx = db.transaction(() => {
        for (const s of entered) addHit.run(a.id, s, ts);
        for (const s of gone) dropHit.run(a.id, s);
      });
      tx();
    }
    summary.push({ alert: a.name, kind: a.kind, matches: current.size, entered: entered.length, gone: gone.length, notified: dry ? false : entered.length > 0 });
  }

  if (!flags.quiet) process.stderr.write(`# checked=${alerts.length}${dry ? ' (dry-run)' : ''}\n`);
  for (const s of summary) printRows([s], flags);
  return 0;
}

function getAlert(db, name) {
  if (!name) throw new MktError('usage', 'Which alert?', 'mkt alert list');
  const a = db.prepare(`SELECT * FROM alerts WHERE name=?`).get(name);
  if (!a) throw new MktError('not_found', `No alert "${name}".`, 'mkt alert list');
  return a;
}

// The current matching set for an alert. live → live scanner; panel → SQL over the DB.
// Both return objects carrying at least `symbol`.
async function currentRows(db, a) {
  if (a.kind === 'panel') {
    return db.prepare(a.query).all();            // guaranteed SELECT + symbol col at add time
  }
  const fs = await fieldSet(a.region);
  const { filter, cols } = parseWhere(a.query.split('\n'), fs);
  validateColumns(new Set(['name', ...cols]), fs);
  const { rows } = await scan({ region: a.region, columns: ['name'], filter, range: [0, ALERT_MAX] });
  return rows.map((r) => ({ symbol: r.s, name: r.d[0] }));
}
