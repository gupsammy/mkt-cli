import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The hint contract for `mkt size`.
//
// Every hint this command prints is a command line the user is expected to paste back. So a hint is
// only correct if running it verbatim actually SUCCEEDS — naming the failing constraint is not enough.
// Five review rounds on PR #8 found four separate ways to break that: a hint that reverted the
// caller's percentages, a hint that raised one limit while the other still blocked, and two rounding
// choices (2 decimals, then 6 significant digits) that collapsed a suggested target back onto the
// entry and reproduced the very error they were meant to resolve.
//
// None of those are visible by reading the code — they only appear when the hint is executed. Hence
// the whole CLI is spawned rather than size() imported: the hint is a command line, and it has to
// parse as one.
const BIN = fileURLToPath(new URL('../bin/mkt.js', import.meta.url));

function run(args) {
  const r = spawnSync(process.execPath, [BIN, 'size', ...args], { encoding: 'utf8' });
  const hint = (r.stderr.match(/^hint:\s+(.+)$/m) ?? [])[1]?.trim() ?? null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, hint };
}

// Each case fails on purpose. The invariants are the same for all of them, so they are asserted
// together rather than per-case: a case that starts succeeding is itself a regression worth failing on.
const FAILING = [
  ['short, stop one cent-millionth away', ['--entry', '100', '--stop', '100.000001', '--target', '101']],
  ['long, stop one cent-millionth away', ['--entry', '100', '--stop', '99.999999', '--target', '99']],
  ['short at the tightest representable stop', ['--entry', '100', '--stop', '100.00000000000001', '--target', '101']],
  ['sub-cent short (2dp rounding lands on entry)', ['--entry', '0.01', '--stop', '0.02', '--account', '100', '--target', '0.03']],
  ['short with a target above entry', ['--entry', '50', '--stop', '53', '--target', '60']],
  ['long with a target below entry', ['--entry', '50', '--stop', '47', '--target', '40']],
  ['losing target with every percentage non-default', ['--entry', '7000', '--stop', '6999', '--account', '7000', '--risk', '100', '--max-pct', '100', '--target', '6000']],
  ['stop too wide, cap still clears', ['--entry', '50', '--stop', '5000']],
  ['cap below one share, risk still clears', ['--entry', '5000', '--stop', '4999', '--account', '6000']],
  ['both limits below one share', ['--entry', '9000', '--stop', '100', '--account', '6000']],
  ['account too small for one share', ['--entry', '500', '--stop', '490', '--account', '100']],
  ['wide stop with a non-default risk to preserve', ['--entry', '100', '--stop', '7000', '--account', '6000', '--risk', '100', '--max-pct', '25']],
];

for (const [name, args] of FAILING) {
  test(`hint resolves in one step: ${name}`, () => {
    const failed = run(args);
    assert.equal(failed.code, 2, `expected a usage failure\n${failed.stderr}`);
    assert.ok(failed.hint, `no hint offered\n${failed.stderr}`);

    // A hint identical to the command that just failed is an infinite loop, not a suggestion.
    assert.notEqual(failed.hint, `mkt size ${args.join(' ')}`, 'hint reproduces the failing command');

    const rerun = run(failed.hint.split(/\s+/).slice(2));   // drop the leading `mkt size`
    assert.equal(rerun.code, 0, `hint does not resolve: ${failed.hint}\n${rerun.stderr}`);
  });
}

test('sizing arithmetic is unchanged', () => {
  const base = JSON.parse(run(['--entry', '50', '--stop', '47', '--compact']).stdout);
  assert.deepEqual(base, {
    side: 'long', shares: 20, position_value: 1000, pct_of_account: 16.67,
    risk_per_share: 3, loss_at_stop: 60, risk_budget: 60, account: 6000, capped_by_max_pct: false,
  });

  // Floors throughout, so the realised loss never exceeds the stated risk budget.
  assert.ok(base.loss_at_stop <= base.risk_budget);
});

test('a target on the profitable side reports R and profit', () => {
  const out = JSON.parse(run(['--entry', '50', '--stop', '47', '--target', '56', '--compact']).stdout);
  assert.equal(out.reward_risk, 2);
  assert.equal(out.profit_at_target, 120);
});

test('the position cap binds before the risk budget does', () => {
  const out = JSON.parse(run(['--entry', '50', '--stop', '49', '--compact']).stdout);
  assert.equal(out.shares, 30);
  assert.equal(out.pct_of_account, 25);
  assert.equal(out.capped_by_max_pct, true);
});
