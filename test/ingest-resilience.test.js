import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const CLI = path.resolve('bin/mkt.js');

function splitHint(hint) {
  const words = [];
  let word = '', quote = null;
  for (const char of hint) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (word) { words.push(word); word = ''; }
    } else word += char;
  }
  if (word) words.push(word);
  return words;
}

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
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /2026-08-02\.ndjson\.gz: line 2, byte \d+/);
  assert.deepEqual(JSON.parse(result.stdout), {
    ingested: 2, files: 2, skipped: 0, pruned: 0, db_rows: 2, db_dates: 2,
    region: 'america', failed: 1,
  });

  const rows = f.run('sql', 'SELECT date,symbol FROM snapshots ORDER BY date', '--compact');
  assert.equal(rows.status, 0, rows.stderr);
  assert.deepEqual(rows.stdout.trim().split('\n').map(JSON.parse), [
    { date: '2026-08-01', symbol: 'NYSE:GOOD1' },
    { date: '2026-08-03', symbol: 'NYSE:GOOD3' },
  ]);

  assert.match(fs.readFileSync(f.notifyLog, 'utf8'), /mkt ingest failed/);

  const retry = f.run('ingest', '--compact');
  assert.equal(retry.status, 1, retry.stderr);
  assert.match(retry.stderr, /2026-08-02\.ndjson\.gz: line 2, byte \d+/);
});

test('ingest reports every corrupt file in one error', (t) => {
  const f = fixture(t);
  f.writeSnapshot('2026-08-01.ndjson.gz', ['{first bad line']);
  f.writeRawSnapshot('2026-08-02.ndjson.gz', 'not a gzip stream');
  f.writeSnapshot('2026-08-03.ndjson.gz', [
    JSON.stringify({ date: '2026-08-03', symbol: 'NYSE:GOOD3', close: 30 }),
  ]);

  const result = f.run('ingest', '--all', '--compact');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /2026-08-01\.ndjson\.gz: line 1, byte 0/);
  assert.match(result.stderr, /2026-08-02\.ndjson\.gz: after \d+ decompressed bytes/);

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

  const result = f.run('notify', '--title=mkt-record', '--body=--backup failed (exit 1)');
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(f.notifyLog, 'utf8'), /mkt-record/);
  assert.match(fs.readFileSync(f.notifyLog, 'utf8'), /--backup failed \(exit 1\)/);
});

test('notify usage hint is runnable', (t) => {
  const f = fixture(t);
  const usage = f.run('notify');
  assert.equal(usage.status, 2);
  const hint = usage.stderr.match(/^hint:\s+(.+)$/m)?.[1];
  assert.ok(hint, usage.stderr);
  const [command, ...args] = splitHint(hint);
  assert.equal(command, 'mkt');
  const rerun = f.run(...args);
  assert.equal(rerun.status, 0, rerun.stderr);
});

test('failed full replay does not prune any source snapshots', (t) => {
  const f = fixture(t);
  f.writeSnapshot('2020-01-02.ndjson.gz', [
    JSON.stringify({ date: '2020-01-02', symbol: 'NYSE:OLD', close: 10 }),
  ]);
  f.writeSnapshot('2026-08-03.ndjson.gz', ['{bad json']);

  const result = f.run('ingest', '--prune', '--compact');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(f.hasSnapshot('2020-01-02.ndjson.gz'), true);
});

test('ingest notifies failures that happen before the per-file loop', (t) => {
  const f = fixture(t);

  const result = f.run('ingest', '--region', 'missing');
  assert.equal(result.status, 3, result.stderr);
  assert.match(fs.readFileSync(f.notifyLog, 'utf8'), /mkt ingest failed/);
  assert.match(fs.readFileSync(f.notifyLog, 'utf8'), /No snapshots/);
});
