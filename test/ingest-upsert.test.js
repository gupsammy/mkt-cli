import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import Database from 'better-sqlite3';
import { snapshotWriter } from '../src/db.js';

// How ingest writes a snapshot row into the panel. Three bugs shared one statement:
//  #19 — a whole-row INSERT OR REPLACE bound every absent field as null, so a narrow snapshot
//        (record --columns close,RSI) erased the ~70 columns it didn't carry.
//  #20 — values were bound raw; a boolean or array field throws in the driver, so declaring one in
//        schema.js widened the table and then wedged every later ingest.
//  #38 — fields were bound by sanitised name ('.'/'|' → '_'), so `High.1M` and `High|1M` would
//        collide on one parameter and one column would silently get the other's value.
// The CLI cases drive the real `ingest` → `sql` path; the #38 and unrepresentable-value cases use
// the writer directly, since today's schema holds no colliding pair and JSON can't carry a function.

const CLI = path.resolve('bin/mkt.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-ingest-upsert-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const dir = path.join(home, 'snapshots', 'america');
  fs.mkdirSync(dir, { recursive: true });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MKT_'))),
    HOME: home,
    MKT_HOME: home,
  };
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return {
    // Overwrites the day's file, exactly as `record` replaces today's file on every run.
    write(date, rows) {
      const lines = rows.map((r) => JSON.stringify({ date, ...r }));
      fs.writeFileSync(path.join(dir, `${date}.ndjson.gz`), gzipSync(lines.join('\n') + '\n'));
    },
    ingest() {
      const r = run(['ingest', '--region', 'america', '--no-notify', '--json']);
      assert.equal(r.status, 0, r.stderr);
    },
    row(symbol, cols, date = D) {
      const sel = cols.map((c) => `"${c}"`).join(', ');
      const r = run(['sql', `SELECT ${sel} FROM snapshots WHERE symbol='${symbol}' AND date='${date}'`, '--json']);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim());
    },
    all() {
      const r = run(['sql', 'SELECT * FROM snapshots ORDER BY date, symbol', '--json']);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    },
  };
}

const D = '2026-10-23';
const WIDE_ROW = { symbol: 'X:A', name: 'Alpha', close: 10, RSI: 25, volume: 1000, 'MACD.macd': 0.5 };

test('#19 wide then narrow: a narrow re-ingest keeps the columns it did not carry', (t) => {
  const fx = fixture(t);
  fx.write(D, [WIDE_ROW]);
  fx.ingest();
  fx.write(D, [{ symbol: 'X:A', close: 11 }]);
  fx.ingest();
  assert.deepEqual(fx.row('X:A', ['close', 'RSI', 'name', 'volume', 'MACD.macd']),
    { close: 11, RSI: 25, name: 'Alpha', volume: 1000, 'MACD.macd': 0.5 });
});

test('#19 narrow then wide: a full-width row still overwrites every column', (t) => {
  const fx = fixture(t);
  fx.write(D, [{ symbol: 'X:A', close: 9, RSI: 70 }]);
  fx.ingest();
  fx.write(D, [WIDE_ROW]);
  fx.ingest();
  assert.deepEqual(fx.row('X:A', ['close', 'RSI', 'name', 'volume']),
    { close: 10, RSI: 25, name: 'Alpha', volume: 1000 });
});

test('#19 an explicit null is a recorded value and does overwrite', (t) => {
  const fx = fixture(t);
  fx.write(D, [WIDE_ROW]);
  fx.ingest();
  fx.write(D, [{ symbol: 'X:A', close: 10, RSI: null }]);
  fx.ingest();
  assert.deepEqual(fx.row('X:A', ['RSI', 'name']), { RSI: null, name: 'Alpha' });
});

test('#19 re-ingesting the same file leaves the panel identical', (t) => {
  const fx = fixture(t);
  fx.write(D, [WIDE_ROW, { symbol: 'X:B', close: 3, RSI: null }]);
  fx.ingest();
  const first = fx.all();
  fx.ingest();
  assert.equal(fx.all(), first);
});

test('#20 boolean and array values land as 0/1 and JSON text instead of wedging ingest', (t) => {
  const fx = fixture(t);
  fx.write(D, [{ symbol: 'X:A', close: 10, RSI: true, sector: ['Tech', 'Semis'], industry: { a: 1 } }]);
  fx.ingest();
  assert.deepEqual(fx.row('X:A', ['close', 'RSI', 'sector', 'industry']),
    { close: 10, RSI: 1, sector: '["Tech","Semis"]', industry: '{"a":1}' });
  // ...and the next day still ingests, so nothing is wedged.
  fx.write('2026-10-24', [{ symbol: 'X:A', close: 12, RSI: false }]);
  fx.ingest();
  assert.deepEqual(fx.row('X:A', ['close', 'RSI'], '2026-10-24'), { close: 12, RSI: 0 });
});

// The writer against a throwaway in-memory table with the column pair #38 warns about.
function memTable(cols) {
  const db = new Database(':memory:');
  const q = (c) => `"${c}"`;
  db.exec(`CREATE TABLE snapshots (date TEXT NOT NULL, symbol TEXT NOT NULL, region TEXT, ` +
    `${cols.map((c) => `${q(c)} REAL`).join(', ')}, PRIMARY KEY (date, symbol))`);
  return db;
}

test('#38 fields that differ only in punctuation keep their own values', () => {
  const cols = ['High.1M', 'High|1M'];
  const db = memTable(cols);
  const write = snapshotWriter(db, ['date', 'symbol', 'region', ...cols]);
  write({ date: D, symbol: 'X:A', region: 'america', 'High.1M': 1, 'High|1M': 2 });
  assert.deepEqual(db.prepare(`SELECT "High.1M" a, "High|1M" b FROM snapshots`).get(), { a: 1, b: 2 });
});

test('a field named after an Object.prototype member counts as absent unless the row has it', () => {
  const db = memTable(['constructor']);
  const write = snapshotWriter(db, ['date', 'symbol', 'region', 'constructor']);
  write({ date: D, symbol: 'X:A', region: 'america' });
  assert.deepEqual(db.prepare(`SELECT "constructor" c FROM snapshots`).get(), { c: null });
});

test('#20 a value with no SQL form fails with an error naming the field', () => {
  const db = memTable(['RSI']);
  const write = snapshotWriter(db, ['date', 'symbol', 'region', 'RSI']);
  assert.throws(() => write({ date: D, symbol: 'X:A', region: 'america', RSI: () => 1 }),
    (e) => e.code === 'bad_column' && /RSI/.test(e.message) && /function/.test(e.message));
});
