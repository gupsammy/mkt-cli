// Pins the durability contract of issue #11: the live snapshot archive is only ever REPLACED by a
// complete, flushed file — never opened for write in place. The old writer truncated the existing
// good day the instant the stream opened; any interruption in the seconds before the replacement
// bytes landed destroyed a snapshot the scanner cannot re-serve.
//
// The crash and concurrency cases spawn a real child process (test/helpers/record-write-child.js):
// SIGKILL and pid-scoped tmp names are process-level behavior an in-process test cannot fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeSnapshotGz } from '../src/commands/record.js';
import { MktError } from '../src/errors.js';

const CHILD = fileURLToPath(new URL('./helpers/record-write-child.js', import.meta.url));

const readGz = (file) =>
  zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map((l) => JSON.parse(l));

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(cond, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('publishes atomically: valid gz, date stamped, previous day replaced, no tmp left', async (t) => {
  const dir = makeDir(t);
  const file = path.join(dir, '2026-08-18.ndjson.gz');
  fs.writeFileSync(file, zlib.gzipSync('{"symbol":"OLD"}\n'));   // idempotent re-record of today
  await writeSnapshotGz(file, '2026-08-18', [{ symbol: 'AAPL', close: 1 }, { symbol: 'MSFT', close: 2 }]);
  assert.deepEqual(readGz(file), [
    { date: '2026-08-18', symbol: 'AAPL', close: 1 },
    { date: '2026-08-18', symbol: 'MSFT', close: 2 },
  ]);
  assert.deepEqual(fs.readdirSync(dir), ['2026-08-18.ndjson.gz']);   // staged tmp was renamed away
});

test('kill -9 mid-write leaves the previous file byte-identical and gunzip-valid', async (t) => {
  const dir = makeDir(t);
  const file = path.join(dir, '2026-08-18.ndjson.gz');
  const good = zlib.gzipSync('{"date":"2026-08-17","symbol":"GOOD"}\n');
  fs.writeFileSync(file, good);
  // The endless writer can never finish, so seeing its staged tmp means it is mid-write by construction.
  const child = spawn(process.execPath, [CHILD, file, '2026-08-18', 'endless'], { stdio: 'ignore' });
  const tmp = `${file}.${child.pid}.tmp`;
  await waitFor(() => fs.existsSync(tmp));
  child.kill('SIGKILL');
  await new Promise((res) => child.on('exit', res));
  assert.ok(fs.readFileSync(file).equals(good), 'live file must be untouched');
  assert.deepEqual(readGz(file), [{ date: '2026-08-17', symbol: 'GOOD' }]);
  assert.ok(fs.existsSync(tmp), 'the staged tmp is what gets lost, never the archive');
});

test('two concurrent writers cannot corrupt the destination', async (t) => {
  const dir = makeDir(t);
  const file = path.join(dir, '2026-08-18.ndjson.gz');
  const run = (marker, count) => new Promise((res, rej) => {
    const c = spawn(process.execPath, [CHILD, file, '2026-08-18', marker, String(count)], { stdio: 'ignore' });
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`writer ${marker} exited ${code}`))));
  });
  await Promise.all([run('a', 2000), run('b', 2500)]);
  const rows = readGz(file);   // a torn write would fail to decompress here
  const markers = new Set(rows.map((r) => r.marker));
  assert.equal(markers.size, 1, 'file must be wholly one run, never interleaved');
  assert.equal(rows.length, markers.has('a') ? 2000 : 2500, 'and that run must be complete');
});

test('a stream error mid-write rejects typed, discards the tmp, preserves the live file', async (t) => {
  const dir = makeDir(t);
  const file = path.join(dir, '2026-08-18.ndjson.gz');
  const good = zlib.gzipSync('{"symbol":"GOOD"}\n');
  fs.writeFileSync(file, good);
  function* explode() { yield { symbol: 'A' }; throw new Error('boom'); }   // stand-in for a stream error
  // The hint is prose, not a runnable command — the deliberate backup.js precedent for I/O failures
  // (free space / permissions have no command to suggest), so the size-hints runnability contract
  // doesn't apply; assert it exists, since output.js prints it as the user's only lead.
  await assert.rejects(
    () => writeSnapshotGz(file, '2026-08-18', explode()),
    (e) => e instanceof MktError && e.code === 'generic' && /boom/.test(e.message) && e.hint !== null,
  );
  assert.ok(fs.readFileSync(file).equals(good), 'live file must be untouched');
  assert.deepEqual(fs.readdirSync(dir), ['2026-08-18.ndjson.gz'], 'tmp must be discarded');
});

test('an unopenable destination rejects typed and publishes nothing', async (t) => {
  const dir = makeDir(t);
  const file = path.join(dir, 'no-such-subdir', '2026-08-18.ndjson.gz');
  await assert.rejects(
    () => writeSnapshotGz(file, '2026-08-18', [{ symbol: 'X' }]),
    (e) => e instanceof MktError && e.code === 'generic' && e.hint !== null,
  );
  assert.ok(!fs.existsSync(file));
});
