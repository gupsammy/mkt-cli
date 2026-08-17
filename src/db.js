import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { WIDE, colType } from './schema.js';
import { MktError } from './providers/tradingview.js';

// The canonical, queryable store. Snapshots only — bars stay on-demand (recoverable via the
// history WS; see spec §9b). Default ~/.mkt/mkt.db, override with $MKT_HOME.
export function dbPath() {
  return path.join(process.env.MKT_HOME || path.join(os.homedir(), '.mkt'), 'mkt.db');
}

const qid = (name) => '"' + name.replace(/"/g, '""') + '"';   // TV fields hold '.'/'|' → must quote

// Open the DB. readonly:true for `mkt sql` (query path can never mutate the panel);
// writable + auto-migrate for ingest.
export function openDb({ readonly = false } = {}) {
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // DB autocreate: the DB is core infra now, so a readonly open on a fresh machine shouldn't error —
  // create + migrate the schema first via a throwaway writable handle, then open readonly.
  if (readonly && !fs.existsSync(file)) {
    const w = new Database(file);
    w.pragma('journal_mode = WAL');
    migrate(w);
    w.close();
  }
  const db = new Database(file, { readonly });
  if (!readonly) {
    db.pragma('journal_mode = WAL');   // concurrent reads while the daily ingest writes
    migrate(db);
  }
  return db;
}

// Create the table if absent, then ADD COLUMN for any WIDE field not yet present.
// This is how the schema evolves: append a field to schema.js, next ingest widens the table,
// old rows read NULL for it. No manual migration, no drift.
function migrate(db) {
  const cols = WIDE.map((f) => `${qid(f)} ${colType(f)}`).join(', ');
  db.exec(
    `CREATE TABLE IF NOT EXISTS snapshots (` +
    `date TEXT NOT NULL, symbol TEXT NOT NULL, ${cols}, ` +
    `PRIMARY KEY (date, symbol));`
  );
  const have = new Set(db.prepare(`PRAGMA table_info(snapshots)`).all().map((r) => r.name));
  for (const f of WIDE) {
    if (!have.has(f)) db.exec(`ALTER TABLE snapshots ADD COLUMN ${qid(f)} ${colType(f)};`);
  }

  // Alerts (spec §12). Definitions + edge-trigger memory both live here, not a JSON side-file.
  // kind: 'live' (query = newline-joined --where exprs, run against the live scanner) or
  //       'panel' (query = raw SELECT over snapshots, run daily). alert_hits = who matched last check.
  db.exec(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    query TEXT NOT NULL, region TEXT NOT NULL DEFAULT 'america',
    enabled INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS alert_hits (
    alert_id INTEGER NOT NULL, symbol TEXT NOT NULL, first_seen TEXT NOT NULL,
    PRIMARY KEY (alert_id, symbol),
    FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE);`);

  // Watchlists (spec §1): hand-populated sets of symbols. A screen/alert can scope to one instead of
  // a whole region. kind: 'equity' (scanner-visible) or 'macro' (quote/history-scoped).
  db.exec(`CREATE TABLE IF NOT EXISTS watchlists (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'equity',
    created TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS watchlist_members (
    watchlist_id INTEGER NOT NULL, symbol TEXT NOT NULL, added TEXT NOT NULL,
    PRIMARY KEY (watchlist_id, symbol),
    FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE);`);
}

// Prepared upsert over (date, symbol, ...WIDE). INSERT OR REPLACE keyed on the PK → re-ingesting
// a day overwrites it (idempotent), matching the recorder's own overwrite-a-day semantics.
export function upsertStmt(db) {
  const names = ['date', 'symbol', ...WIDE];
  const placeholders = names.map((n) => '@' + n.replace(/[^A-Za-z0-9_]/g, '_')).join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO snapshots (${names.map(qid).join(', ')}) VALUES (${placeholders})`
  );
  return stmt;
}

// Map a recorded NDJSON object to the @-bound param names upsertStmt expects.
// SQLite named params can't contain '.'/'|', so we sanitize keys the same way upsertStmt does.
export function rowToParams(obj) {
  const p = {};
  for (const f of ['date', 'symbol', ...WIDE]) {
    p[f.replace(/[^A-Za-z0-9_]/g, '_')] = obj[f] ?? null;
  }
  return p;
}
