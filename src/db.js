import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { WIDE, colType } from './schema.js';
import { MktError } from './errors.js';

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
  // Repair first: CREATE UNIQUE INDEX fails over existing duplicates, and migrate() runs on every
  // writable open — one pre-index double-insert would otherwise brick the whole write path.
  // Gated on the index (its existence proves the invariant has held since creation) so the
  // steady state is a catalog lookup, and the one repair that ever matters is reported.
  const hasActiveIdx = db.prepare(
    `SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_alert_hits_active'`).get().c;
  if (!hasActiveIdx) {
    // Keep the earliest active stint, close later ones as degenerate (departed = own first_seen).
    const repaired = db.prepare(`UPDATE alert_hits SET departed = first_seen
      WHERE departed IS NULL AND EXISTS (
        SELECT 1 FROM alert_hits h2
         WHERE h2.alert_id = alert_hits.alert_id AND h2.symbol = alert_hits.symbol
           AND h2.departed IS NULL AND h2.first_seen < alert_hits.first_seen)`).run().changes;
    // Deliberately not gated on --quiet (openDb has no flags): this rewrites alert history once,
    // ever, and that must be on the record wherever stderr went.
    if (repaired) process.stderr.write(`# repaired ${repaired} duplicate active alert stint(s) — closed as degenerate\n`);
    // IF NOT EXISTS despite the gate: the gate read and this write are not one transaction, so
    // two writable opens in the migration window (nightly ingest vs 15-min alert check — the very
    // concurrency this index defends against) can both get here; the loser must not throw.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_hits_active
      ON alert_hits(alert_id, symbol) WHERE departed IS NULL;`);
  }

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

const UPSERT_COLS = ['date', 'symbol', 'region', ...WIDE];

// Returns write(obj): upserts one recorded snapshot row, keyed on (date, symbol). Only the columns
// PRESENT in obj are written — an absent field keeps its stored value, a field recorded as null
// overwrites (issue #19: a whole-row replace let a narrow snapshot null ~70 columns). A full-width
// row still overwrites everything, so re-ingesting a day stays idempotent. Values bind by position,
// never by a sanitised name, so `High.1M` and `High|1M` can't share a parameter (#38). Statements
// are cached per present-column set; a day-file normally has one.
export function snapshotWriter(db, cols = UPSERT_COLS) {
  const cache = new Map();
  return (obj) => {
    const present = cols.filter((c) => Object.hasOwn(obj, c));
    const key = present.join('\0');
    let stmt = cache.get(key);
    if (!stmt) {
      const set = present.filter((c) => c !== 'date' && c !== 'symbol').map((c) => `${qid(c)}=excluded.${qid(c)}`);
      stmt = db.prepare(
        `INSERT INTO snapshots (${present.map(qid).join(', ')}) VALUES (${present.map(() => '?').join(', ')}) ` +
        `ON CONFLICT(date, symbol) DO ${set.length ? `UPDATE SET ${set.join(', ')}` : 'NOTHING'}`);
      cache.set(key, stmt);
    }
    stmt.run(present.map((c) => bindable(c, obj[c])));
  };
}

// The driver binds only numbers, strings, bigints, buffers and null; anything else threw on every
// row, wedging ingest once schema.js gained such a field (issue #20). Booleans → 0/1, arrays and
// objects → JSON text; a value with no SQL form fails naming its field.
function bindable(field, v) {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' || Buffer.isBuffer(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  throw new MktError('bad_column', `Field "${field}" holds a ${typeof v}, which has no SQL form.`, null);
}
