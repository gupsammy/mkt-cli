import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const CLI = path.resolve('bin/mkt.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-ingest-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshotDir = path.join(root, 'home', 'snapshots', 'america');
  const binDir = path.join(root, 'bin');
  const notifyLog = path.join(root, 'notifications.log');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'osascript'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MKT_TEST_NOTIFY_LOG"\n', { mode: 0o755 });

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MKT_'))),
    HOME: path.join(root, 'home'),
    MKT_HOME: path.join(root, 'home'),
    MKT_TEST_NOTIFY_LOG: notifyLog,
    PATH: `${binDir}:${process.env.PATH}`,
  };

  return {
    env,
    notifyLog,
    writeSnapshot(name, lines) {
      fs.writeFileSync(path.join(snapshotDir, name), gzipSync(lines.join('\n') + '\n'));
    },
    writeRawSnapshot(name, contents) {
      fs.writeFileSync(path.join(snapshotDir, name), contents);
    },
    hasSnapshot(name) {
      return fs.existsSync(path.join(snapshotDir, name));
    },
    run(...args) {
      return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    },
  };
}

test('ingest skips a corrupt file, commits later files, reports its offset, and notifies', (t) => {
  const f = fixture(t);
  f.writeSnapshot('2026-08-01.ndjson.gz', [
    JSON.stringify({ date: '2026-08-01', symbol: 'NYSE:GOOD1', close: 10 }),
  ]);
  f.writeSnapshot('2026-08-02.ndjson.gz', [
    JSON.stringify({ date: '2026-08-02', symbol: 'NYSE:PARTIAL', close: 20 }),
    '{bad json',
  ]);
  f.writeSnapshot('2026-08-03.ndjson.gz', [
    JSON.stringify({ date: '2026-08-03', symbol: 'NYSE:GOOD3', close: 30 }),
  ]);

  const result = f.run('ingest', '--all', '--json');
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, /2026-08-02\.ndjson\.gz: line 2, byte \d+/);

  const rows = f.run('sql', 'SELECT date,symbol FROM snapshots ORDER BY date', '--compact');
  assert.equal(rows.status, 0, rows.stderr);
  assert.deepEqual(rows.stdout.trim().split('\n').map(JSON.parse), [
    { date: '2026-08-01', symbol: 'NYSE:GOOD1' },
    { date: '2026-08-03', symbol: 'NYSE:GOOD3' },
  ]);

  assert.match(fs.readFileSync(f.notifyLog, 'utf8'), /mkt ingest failed/);
});

test('ingest reports every corrupt file in one error', (t) => {
  const f = fixture(t);
  f.writeSnapshot('2026-08-01.ndjson.gz', ['{first bad line']);
  f.writeRawSnapshot('2026-08-02.ndjson.gz', 'not a gzip stream');
  f.writeSnapshot('2026-08-03.ndjson.gz', [
    JSON.stringify({ date: '2026-08-03', symbol: 'NYSE:GOOD3', close: 30 }),
  ]);

  const result = f.run('ingest', '--all', '--compact');
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, /2026-08-01\.ndjson\.gz: line 1, byte 0/);
  assert.match(result.stderr, /2026-08-02\.ndjson\.gz: byte \d+/);

  const rows = f.run('sql', 'SELECT symbol FROM snapshots', '--compact');
  assert.equal(rows.status, 0, rows.stderr);
  assert.deepEqual(rows.stdout.trim().split('\n').map(JSON.parse), [{ symbol: 'NYSE:GOOD3' }]);
});

test('clean ingest keeps its existing summary and does not notify', (t) => {
  const f = fixture(t);
  f.writeSnapshot('2026-08-01.ndjson.gz', [
    JSON.stringify({ date: '2026-08-01', symbol: 'NYSE:GOOD1', close: 10 }),
  ]);

  const result = f.run('ingest', '--all', '--compact');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout,
    '{"ingested":1,"files":1,"skipped":0,"pruned":0,"db_rows":1,"db_dates":1,"region":"america"}\n');
  assert.equal(fs.existsSync(f.notifyLog), false);
});

test('notify command routes wrapper failures through the shared sinks', (t) => {
  const f = fixture(t);

  const result = f.run('notify', 'mkt-record', 'backup failed (exit 1)');
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(f.notifyLog, 'utf8'), /mkt-record/);
  assert.match(fs.readFileSync(f.notifyLog, 'utf8'), /backup failed \(exit 1\)/);
});

test('failed full replay does not prune any source snapshots', (t) => {
  const f = fixture(t);
  f.writeSnapshot('2020-01-02.ndjson.gz', [
    JSON.stringify({ date: '2020-01-02', symbol: 'NYSE:OLD', close: 10 }),
  ]);
  f.writeSnapshot('2026-08-03.ndjson.gz', ['{bad json']);

  const result = f.run('ingest', '--prune', '--compact');
  assert.equal(result.status, 7, result.stderr);
  assert.equal(f.hasSnapshot('2020-01-02.ndjson.gz'), true);
});
