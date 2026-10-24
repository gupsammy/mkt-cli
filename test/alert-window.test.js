import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Issue #15: a live alert diffed a capped 2,000-row scanner window and threw away the scanner's
// total. When more symbols matched than the window held, the kept slice shifted between runs, so
// symbols outside it were closed as "gone" and re-fired as "new" every 15 minutes, and some matches
// were never seen at all. The fix: a truncated scan is an error for that alert. Nothing is diffed,
// so no stint opens or closes on a partial set, and the check exits non-zero so the scheduler alerts.
//
// Runs the real CLI with fetch replaced by test/helpers/fake-scanner.js, so the live path is offline.
// Every sink is left unconfigured or failing except where a test opts the banner in.

const CLI = path.resolve('bin/mkt.js');
const FAKE = pathToFileURL(path.resolve('test/helpers/fake-scanner.js')).href;

// A /scan reply: `symbols` in the window, `total` matches overall.
const reply = (symbols, total = symbols.length) =>
  JSON.stringify({ totalCount: total, data: symbols.map((s) => ({ s, d: [s] })) });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-alert-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const binDir = path.join(root, 'bin');
  const sinkLog = path.join(root, 'sinks.log');
  fs.mkdirSync(home);
  fs.mkdirSync(binDir);
  // osascript shim: logs the attempt and delivers, so a committed hit can be told from a withheld one.
  fs.writeFileSync(path.join(binDir, 'osascript'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sinkLog}"\nexit 0\n`, { mode: 0o755 });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MKT_'))),
    HOME: home,
    MKT_HOME: home,
    PATH: `${binDir}:${process.env.PATH}`,
  };
  return {
    run: (args, scan = reply([])) =>
      spawnSync(process.execPath, ['--import', FAKE, CLI, ...args],
        { env: { ...env, MKT_TEST_SCAN: scan }, encoding: 'utf8' }),
    sinkLog: () => (fs.existsSync(sinkLog) ? fs.readFileSync(sinkLog, 'utf8') : ''),
  };
}

const rows = (stdout) => stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
function activeHits(fx) {
  const r = fx.run(['sql', 'SELECT symbol FROM alert_hits WHERE departed IS NULL ORDER BY symbol', '--json']);
  assert.equal(r.status, 0, r.stderr);
  return rows(r.stdout).map((x) => x.symbol);
}

test('truncated live scan: alert errors, no stint opens or closes, check exits 1', (t) => {
  const fx = fixture(t);
  let r = fx.run(['alert', 'add', 'wide', '--where', 'RSI<30']);
  assert.equal(r.status, 0, r.stderr);

  // A complete scan commits A and B.
  r = fx.run(['alert', 'check', '--kind', 'live', '--json'], reply(['X:A', 'X:B']));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(activeHits(fx), ['X:A', 'X:B']);
  const notifiedBefore = fx.sinkLog();

  // Now 5,000 match but the window holds only B and C. Diffing it would close A and announce C.
  r = fx.run(['alert', 'check', '--kind', 'live', '--json'], reply(['X:B', 'X:C'], 5000));
  assert.equal(r.status, 1, `a truncated alert must fail the check\n${r.stderr}`);
  const row = rows(r.stdout).find((x) => x.alert === 'wide');
  assert.match(row.error, /5000/, 'the error must say how many matched');
  assert.equal(row.entered, undefined, 'a truncated scan must not be diffed');
  assert.deepEqual(activeHits(fx), ['X:A', 'X:B'], 'no stint may open or close on a partial set');
  assert.equal(fx.sinkLog(), notifiedBefore, 'nothing may be announced from a partial set');
});

test('one truncated alert does not stop the others', (t) => {
  const fx = fixture(t);
  assert.equal(fx.run(['alert', 'add', 'wide', '--where', 'RSI<30']).status, 0);
  assert.equal(fx.run(['alert', 'add', 'panelOk', '--sql', "SELECT 'P:OK' AS symbol"]).status, 0);

  const r = fx.run(['alert', 'check', '--json'], reply(['X:A'], 3000));
  assert.equal(r.status, 1, r.stderr);
  const out = rows(r.stdout);
  assert.ok(out.find((x) => x.alert === 'wide').error);
  assert.equal(out.find((x) => x.alert === 'panelOk').entered, 1);
  assert.deepEqual(activeHits(fx), ['P:OK']);
});

test('a scan that holds every match is not treated as truncated', (t) => {
  const fx = fixture(t);
  assert.equal(fx.run(['alert', 'add', 'exact', '--where', 'RSI<30']).status, 0);
  const r = fx.run(['alert', 'check', '--kind', 'live', '--json'], reply(['X:A', 'X:B'], 2));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rows(r.stdout)[0].entered, 2);
});

test('alert test on a truncated scan is a usage error naming the match count', (t) => {
  const fx = fixture(t);
  assert.equal(fx.run(['alert', 'add', 'wide', '--where', 'RSI<30']).status, 0);
  const r = fx.run(['alert', 'test', 'wide', '--json'], reply(['X:A'], 4000));
  assert.equal(r.status, 2, r.stderr);
  assert.match(JSON.parse(r.stderr.trim().split('\n').pop()).message, /4000/);
});
