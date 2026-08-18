// Pins the source-archive sweep from PR #40 review: a SIGKILLed `record` orphans
// <date>.ndjson.gz.<pid>.tmp in ~/.mkt/snapshots/<region>/ — the one directory whose rule is
// "never delete archive data" — so `backup` must collect day-old staged tmps there, and ONLY
// those (the .ndjson.gz files are irreplaceable; a fresh tmp may belong to a live run).
//
// First DB-touching test in the suite: everything runs through the real CLI under a temp
// MKT_HOME, so the developer's real ~/.mkt is never opened (db.js, ingest, record, backup all
// resolve their paths from $MKT_HOME).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/mkt.js', import.meta.url));

// Same env hygiene as size-hints.test.js: every other MKT_* var has side effects (MKT_BACKUP_DIR
// would redirect the backup, alert vars would push to real Telegram/ntfy). Only the temp home stays.
function env(home) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MKT_')));
  return { ...clean, MKT_HOME: home };
}

test('backup sweeps day-old staged tmps out of the source archive, and nothing else', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-home-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-dest-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  // A past-day snapshot (a fixed old date, so it can never collide with todayFor()'s special case),
  // ingested so the panel is non-empty — backup refuses an empty DB before it touches anything.
  const region = path.join(home, 'snapshots', 'america');
  fs.mkdirSync(region, { recursive: true });
  const gz = path.join(region, '2020-01-02.ndjson.gz');
  fs.writeFileSync(gz, zlib.gzipSync('{"date":"2020-01-02","symbol":"NASDAQ:AAPL","close":1}\n'));
  await run(process.execPath, [CLI, 'ingest', '--region', 'america', '--all'], { env: env(home) });

  const stale = path.join(region, '2020-01-02.ndjson.gz.11111.tmp');   // a SIGKILLed record's leftover
  const fresh = path.join(region, '2020-01-02.ndjson.gz.22222.tmp');   // a concurrent run, mid-write
  fs.writeFileSync(stale, 'partial bytes');
  fs.writeFileSync(fresh, 'partial bytes');
  const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

  await run(process.execPath, [CLI, 'backup', '--to', dest], { env: env(home) });   // throws on exit != 0

  assert.ok(!fs.existsSync(stale), 'day-old staged tmp must be swept from the source archive');
  assert.ok(fs.existsSync(fresh), 'a recent tmp (possibly a live run) must survive');
  assert.ok(fs.existsSync(gz), 'the archive file itself is never touched');
  assert.ok(fs.existsSync(path.join(dest, 'snapshots', 'america', '2020-01-02.ndjson.gz')),
    'and the backup still did its real job: the gz is mirrored');
});
