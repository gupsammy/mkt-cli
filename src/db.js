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
  if (readonly && !fs.existsSync(file)) {
    throw new MktError('not_found', `No database yet at ${file}.`, 'mkt ingest');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
