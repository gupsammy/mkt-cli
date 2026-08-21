import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

// Issue #16: an alert hit must be committed only when at least one notification sink actually
// delivered. On total delivery failure the entrant is withheld so it re-fires next check, rather
// than being silently marked "already notified" forever.
//
// Everything runs through the real CLI (like the other suites). The sinks are made deterministic by
// shadowing `curl` (Telegram/ntfy) and `osascript` (the macOS banner) on PATH with shims whose exit
// code is driven by env vars — so a test can force "every sink fails" or "the banner delivers"
// without any network, on Linux CI or a Mac alike. Alerts use the panel (SQL) path, which is fully
// offline: no scanner, no live market.

const CLI = path.resolve('bin/mkt.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-alert-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const binDir = path.join(root, 'bin');
  const sinkLog = path.join(root, 'sinks.log');
  const snapshotDir = path.join(home, 'snapshots', 'america');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.mkdirSync(binDir);

  // Both shims log the attempt, then exit with the code the env demands (default: success). A
  // non-zero exit makes `curl -fsS` / `osascript` look like a dead sink, exactly as a revoked token
  // or missing network would.
  const shim = (exitVar) =>
    `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> "$MKT_TEST_SINK_LOG"\nexit \${${exitVar}:-0}\n`;
  fs.writeFileSync(path.join(binDir, 'curl'), shim('MKT_TEST_CURL_EXIT'), { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'osascript'), shim('MKT_TEST_OSA_EXIT'), { mode: 0o755 });

  const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MKT_'))),
    HOME: home,
    MKT_HOME: home,
    MKT_TEST_SINK_LOG: sinkLog,
    PATH: `${binDir}:${process.env.PATH}`,
  };

  return {
    // Run the CLI with per-call sink control. `sinks` selects which sinks are configured/succeed.
    run(args, sinks = {}) {
      const env = { ...baseEnv };
      // Telegram is opt-in: configured only when we want it attempted.
      if (sinks.telegram) { env.MKT_TG_TOKEN = 'tok'; env.MKT_TG_CHAT = 'chat'; }
      // curl (Telegram/ntfy) exit code; osascript (banner) exit code. Default both to failing so a
      // test must explicitly opt a sink into delivering.
      env.MKT_TEST_CURL_EXIT = String(sinks.curlExit ?? 1);
      env.MKT_TEST_OSA_EXIT = String(sinks.osaExit ?? 1);
      return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    },
    writeSnapshot(date, symbols) {
      const lines = symbols.map((s) => JSON.stringify({ date, symbol: s, close: 10 }));
      fs.writeFileSync(path.join(snapshotDir, `${date}.ndjson.gz`), gzipSync(lines.join('\n') + '\n'));
    },
    sinkLog: () => (fs.existsSync(sinkLog) ? fs.readFileSync(sinkLog, 'utf8') : ''),
  };
}

// Parse `mkt alert check --json` NDJSON summary rows from stdout.
const rows = (stdout) => stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
// COUNT(*) of active (undeparted) hit rows, via the read-only sql command.
function activeHits(fx) {
  const r = fx.run(['sql', 'SELECT COUNT(*) AS n FROM alert_hits WHERE departed IS NULL', '--json']);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim()).n;
}

test('total delivery failure: entrant is withheld, re-fires next check, non-zero exit', (t) => {
  const fx = fixture(t);
  let r = fx.run(['alert', 'add', 'panelA', '--sql', "SELECT 'AAA' AS symbol"]);
  assert.equal(r.status, 0, r.stderr);

  // Every attempted sink fails: Telegram configured but curl exits non-zero, banner exits non-zero.
  r = fx.run(['alert', 'check', '--kind', 'panel', '--json'], { telegram: true });
  assert.equal(r.status, 1, `expected exit 1 on total delivery failure\n${r.stderr}`);
  const row = rows(r.stdout).find((x) => x.alert === 'panelA');
  assert.equal(row.entered, 1);
  assert.equal(row.notified, false);
  assert.equal(row.delivery, 'failed', 'summary row must flag the delivery failure');
  assert.equal(activeHits(fx), 0, 'no hit may be committed when nothing delivered');

  // The very next check must see AAA as an entrant again (it was never committed).
  r = fx.run(['alert', 'check', '--kind', 'panel', '--json'], { telegram: true });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(rows(r.stdout).find((x) => x.alert === 'panelA').entered, 1, 'symbol must re-fire');
  assert.equal(activeHits(fx), 0);
});

test('at least one sink delivers: hit commits, exit 0, no re-fire (banner-only, Telegram unconfigured)', (t) => {
  const fx = fixture(t);
  let r = fx.run(['alert', 'add', 'panelB', '--sql', "SELECT 'BBB' AS symbol"]);
  assert.equal(r.status, 0, r.stderr);

  // Only the banner is configured/succeeds; Telegram + ntfy are unconfigured (skipped, NOT failed).
  r = fx.run(['alert', 'check', '--kind', 'panel', '--json'], { osaExit: 0 });
  assert.equal(r.status, 0, `unconfigured sinks must not count as failures\n${r.stderr}`);
  const row = rows(r.stdout).find((x) => x.alert === 'panelB');
  assert.equal(row.entered, 1);
  assert.equal(row.notified, true);
  assert.equal(row.delivery, undefined, 'no failure flag when delivered');
  assert.equal(activeHits(fx), 1, 'hit commits when a sink delivered');

  // Second check: BBB is now a known entrant, so it neither re-enters nor re-notifies.
  r = fx.run(['alert', 'check', '--kind', 'panel', '--json'], { osaExit: 0 });
  assert.equal(r.status, 0, r.stderr);
  const row2 = rows(r.stdout).find((x) => x.alert === 'panelB');
  assert.equal(row2.entered, 0);
  assert.equal(row2.notified, false);
  assert.equal(activeHits(fx), 1);
});

test('departure closes its stint even when delivery fails on the same run', (t) => {
  const fx = fixture(t);
  // A panel alert over the latest snapshot date: the matching set changes as new snapshots land.
  fx.writeSnapshot('2026-08-20', ['AAA']);
  let r = fx.run(['ingest', '--region', 'america', '--no-notify']);
  assert.equal(r.status, 0, r.stderr);
  r = fx.run(['alert', 'add', 'panelC', '--sql',
    'SELECT DISTINCT symbol FROM snapshots WHERE date=(SELECT MAX(date) FROM snapshots)']);
  assert.equal(r.status, 0, r.stderr);

  // Commit AAA with a delivering banner.
  r = fx.run(['alert', 'check', '--kind', 'panel', '--json'], { osaExit: 0 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(activeHits(fx), 1);

  // New session: matching set becomes {BBB}; AAA departs. Force every sink to fail on this run.
  fx.writeSnapshot('2026-08-21', ['BBB']);
  r = fx.run(['ingest', '--region', 'america', '--no-notify']);
  assert.equal(r.status, 0, r.stderr);
  r = fx.run(['alert', 'check', '--kind', 'panel', '--json'], { telegram: true }); // all sinks fail
  assert.equal(r.status, 1, r.stderr);
  const row = rows(r.stdout).find((x) => x.alert === 'panelC');
  assert.equal(row.entered, 1, 'BBB entered');
  assert.equal(row.gone, 1, 'AAA departed');
  assert.equal(row.delivery, 'failed');

  // AAA's stint is closed (departed), BBB was NOT committed (delivery failed) → still 0 active.
  assert.equal(activeHits(fx), 0, 'departure must close AAA regardless of send outcome');
  const closed = fx.run(['sql',
    "SELECT COUNT(*) AS n FROM alert_hits WHERE symbol='AAA' AND departed IS NOT NULL", '--json']);
  assert.equal(JSON.parse(closed.stdout.trim()).n, 1, 'AAA stint must be closed, not deleted');
});

test('dry-run writes nothing and sends nothing', (t) => {
  const fx = fixture(t);
  let r = fx.run(['alert', 'add', 'panelD', '--sql', "SELECT 'DDD' AS symbol"]);
  assert.equal(r.status, 0, r.stderr);

  r = fx.run(['alert', 'check', '--kind', 'panel', '--dry-run', '--json'], { osaExit: 0 });
  assert.equal(r.status, 0, r.stderr);
  const row = rows(r.stdout).find((x) => x.alert === 'panelD');
  assert.equal(row.entered, 1);
  assert.equal(row.notified, false, 'dry-run notifies nothing');
  assert.equal(activeHits(fx), 0, 'dry-run writes nothing');
  assert.equal(fx.sinkLog(), '', 'dry-run must not invoke any sink');
});
