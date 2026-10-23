import { openDb } from '../db.js';
import { scan, fieldSet } from '../providers/tradingview.js';
import { MktError } from '../errors.js';
import { parseWhere, validateColumns } from '../filter.js';
import { notify } from '../notify.js';
import { printRows, printObject, EXIT } from '../output.js';

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
    preparePanel(db, sql).all();                 // validate it runs (throws → caught by router)
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
            (SELECT COUNT(*) FROM alert_hits h WHERE h.alert_id=a.id AND h.departed IS NULL) AS watching, a.query
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

// The loop: for each enabled alert, diff live/current matches vs the ACTIVE alert_hits stints,
// push NEW entrants, update state. --kind live|panel filters (launchd runs live 15m, panel daily).
// --dry-run: no push/no write.
async function check(db, flags) {
  const dry = flags['dry-run'];
  const kindFilter = flags.kind;
  if (kindFilter && !['live', 'panel'].includes(kindFilter)) throw new MktError('usage', '--kind must be live or panel.', null);
  const alerts = db.prepare(`SELECT * FROM alerts WHERE enabled=1 ${kindFilter ? 'AND kind=?' : ''} ORDER BY name`)
    .all(...(kindFilter ? [kindFilter] : []));

  const addHit = db.prepare(`INSERT OR IGNORE INTO alert_hits (alert_id, symbol, first_seen) VALUES (?,?,?)`);
  // Append-only: a departure CLOSES the stint (stamps departed), never deletes it — the entry/exit
  // history is exactly what forward-eval (spec §11) replays. Re-entry inserts a fresh stint.
  const closeHit = db.prepare(`UPDATE alert_hits SET departed=? WHERE alert_id=? AND symbol=? AND departed IS NULL`);
  const summary = [];
  let errored = 0, deliveryFailures = 0;

  for (const a of alerts) {
    let rows;
    try {
      rows = await currentRows(db, a);
    } catch (e) {
      process.stderr.write(`# alert "${a.name}" errored: ${e.message}\n`);
      summary.push({ alert: a.name, error: e.message });
      errored++;
      continue;
    }
    const current = new Set(rows.map((r) => r.symbol));
    const last = new Set(db.prepare(`SELECT symbol FROM alert_hits WHERE alert_id=? AND departed IS NULL`)
      .all(a.id).map((r) => r.symbol));
    const entered = [...current].filter((s) => !last.has(s));
    const gone = [...last].filter((s) => !current.has(s));

    // Notify BEFORE writing state, so the send outcome can gate the entrant commit (issue #16).
    let result = null;
    if (entered.length && !dry) {
      const preview = entered.slice(0, 8).join(', ') + (entered.length > 8 ? ` +${entered.length - 8} more` : '');
      result = await notify(`mkt: ${a.name}`, `${entered.length} new — ${preview}`);
    }
    const delivered = !!(result && result.delivered > 0);
    // Total delivery failure: at least one sink was attempted and every one failed. Unconfigured
    // (skipped) sinks don't count — a banner-only Mac with a working banner is not a failure.
    const totalFail = !!(result && result.attempted > 0 && result.delivered === 0);
    if (totalFail) deliveryFailures++;

    if (!dry) {
      const ts = now();
      // Withhold the entrant hits on a total send failure so the symbol is seen as an entrant again
      // next check and retried — instead of being marked "already notified" and going permanently
      // silent. Departures ALWAYS close (append-only history, independent of the send outcome), and
      // both stay in ONE transaction so entrant/departure state can never diverge.
      const toCommit = totalFail ? [] : entered;
      const tx = db.transaction(() => {
        for (const s of toCommit) addHit.run(a.id, s, ts);
        for (const s of gone) closeHit.run(ts, a.id, s);
      });
      tx();
    }
    const row = { alert: a.name, kind: a.kind, matches: current.size, entered: entered.length, gone: gone.length, notified: delivered };
    if (totalFail) row.delivery = 'failed';   // hits withheld — will retry next check
    summary.push(row);
  }

  if (!flags.quiet) process.stderr.write(`# checked=${alerts.length}${dry ? ' (dry-run)' : ''}${deliveryFailures ? ` delivery_failed=${deliveryFailures}` : ''}\n`);
  for (const s of summary) printRows([s], flags);
  // A failed alert must not exit 0 forever — the scheduler's log line on a non-zero exit is the only
  // place a broken query or a dead sink ever surfaces. EXIT.generic = partial: the healthy alerts
  // above still ran and notified; a total delivery failure also downgrades to it (hits were withheld).
  return (errored || deliveryFailures) ? EXIT.generic : EXIT.ok;
}

function getAlert(db, name) {
  if (!name) throw new MktError('usage', 'Which alert?', 'mkt alert list');
  const a = db.prepare(`SELECT * FROM alerts WHERE name=?`).get(name);
  if (!a) throw new MktError('not_found', `No alert "${name}".`, 'mkt alert list');
  return a;
}

// Prepare panel SQL and prove it read-only. The ^SELECT/WITH regex is a friendly first gate, but
// `WITH x AS (...) DELETE ... RETURNING symbol` sails past it — and this statement runs on the
// writable alert connection. stmt.readonly is the driver's own verdict, so it is the gate.
function preparePanel(db, sql) {
  const stmt = db.prepare(sql);   // throws on bad SQL → usage error upstream
  if (!stmt.readonly) throw new MktError('usage', 'Panel --sql must be read-only (no INSERT/UPDATE/DELETE).', null);
  return stmt;
}

// The current matching set for an alert. live → live scanner; panel → SQL over the DB.
// Both return objects carrying at least `symbol`.
async function currentRows(db, a) {
  if (a.kind === 'panel') {
    // Re-proved at fire time, not just add time — the stored query is editable outside this CLI.
    return preparePanel(db, a.query).all();
  }
  const fs = await fieldSet(a.region);
  const { filter, cols } = parseWhere(a.query.split('\n'), fs);
  validateColumns(new Set(['name', ...cols]), fs);
  const { rows } = await scan({ region: a.region, columns: ['name'], filter, range: [0, ALERT_MAX] });
  return rows;   // provider returns {symbol, name}
}
