import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { WIDE, colType } from './schema.js';

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
  // The declared ON DELETE CASCADEs (alerts→hits, watchlists→members) only fire with this ON —
  // SQLite defaults it OFF per connection, which silently orphaned child rows on delete.
  db.pragma('foreign_keys = ON');
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
    `date TEXT NOT NULL, symbol TEXT NOT NULL, region TEXT, ${cols}, ` +
    `PRIMARY KEY (date, symbol));`
  );
  const have = new Set(db.prepare(`PRAGMA table_info(snapshots)`).all().map((r) => r.name));
  // region is DB-side provenance (ingest stamps it from the snapshot directory), not a scanner
  // field — so it rides the same ALTER path as the WIDE list instead of living in schema.js.
  for (const [f, type] of [...WIDE.map((f) => [f, colType(f)]), ['region', 'TEXT']]) {
    if (!have.has(f)) db.exec(`ALTER TABLE snapshots ADD COLUMN ${qid(f)} ${type};`);
  }
  // Symbol-major access path: per-symbol time series (self-joins, journal marks) would otherwise
  // scan the whole date-major primary key.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_symbol_date ON snapshots(symbol, date);`);
  // Ingest's high-water mark (MAX(date) WHERE region=?) — without this it is a full scan for any
  // region not yet present, every night.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_region_date ON snapshots(region, date);`);

  // Alerts (spec §12). Definitions + edge-trigger memory both live here, not a JSON side-file.
  // kind: 'live' (query = newline-joined --where exprs, run against the live scanner) or
  //       'panel' (query = raw SELECT over snapshots, run daily).
  db.exec(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    query TEXT NOT NULL, region TEXT NOT NULL DEFAULT 'america',
    enabled INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);`);

  // alert_hits: append-only membership stints. A row is one stint of a symbol inside an alert's
  // matching set — active while departed IS NULL, closed (never deleted) when the symbol drops
  // out; re-entry starts a new row. The v1 shape DELETEd departures, destroying exactly the
  // entry/exit history forward-eval (spec §11) replays — hence the one-time rebuild below.
  db.exec(`CREATE TABLE IF NOT EXISTS alert_hits (
    alert_id INTEGER NOT NULL, symbol TEXT NOT NULL,
    first_seen TEXT NOT NULL, departed TEXT,
    PRIMARY KEY (alert_id, symbol, first_seen),
    FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE);`);
  const hitCols = new Set(db.prepare(`PRAGMA table_info(alert_hits)`).all().map((r) => r.name));
  if (!hitCols.has('departed')) {
    // Atomic on purpose: multi-statement exec commits per statement, so a crash after the RENAME
    // would orphan the v1 data forever — the CREATE IF NOT EXISTS above already made the v2 shape,
    // so this branch could never run again. One transaction makes the rebuild all-or-nothing.
    db.transaction(() => {
      db.exec(`ALTER TABLE alert_hits RENAME TO alert_hits_v1;
        CREATE TABLE alert_hits (
          alert_id INTEGER NOT NULL, symbol TEXT NOT NULL,
          first_seen TEXT NOT NULL, departed TEXT,
          PRIMARY KEY (alert_id, symbol, first_seen),
          FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE);
        INSERT INTO alert_hits (alert_id, symbol, first_seen)
          SELECT alert_id, symbol, first_seen FROM alert_hits_v1;
        DROP TABLE alert_hits_v1;`);
    })();
  }
  // One ACTIVE stint per (alert, symbol): the widened PK alone would let two overlapping `check`
  // runs (a slow live scan vs the next 15-min firing) both insert; INSERT OR IGNORE needs this
  // index to turn the second insert into a no-op. Closed stints (departed set) are exempt.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_hits_active
    ON alert_hits(alert_id, symbol) WHERE departed IS NULL;`);

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

// Prepared upsert over (date, symbol, region, ...WIDE). INSERT OR REPLACE keyed on the PK →
// re-ingesting a day overwrites it (idempotent), matching the recorder's overwrite-a-day semantics.
const UPSERT_COLS = ['date', 'symbol', 'region', ...WIDE];

export function upsertStmt(db) {
  const placeholders = UPSERT_COLS.map((n) => '@' + n.replace(/[^A-Za-z0-9_]/g, '_')).join(', ');
  return db.prepare(
    `INSERT OR REPLACE INTO snapshots (${UPSERT_COLS.map(qid).join(', ')}) VALUES (${placeholders})`
  );
}

// Map a recorded NDJSON object to the @-bound param names upsertStmt expects.
// SQLite named params can't contain '.'/'|', so we sanitize keys the same way upsertStmt does.
export function rowToParams(obj) {
  const p = {};
  for (const f of UPSERT_COLS) {
    p[f.replace(/[^A-Za-z0-9_]/g, '_')] = obj[f] ?? null;
  }
  return p;
}
