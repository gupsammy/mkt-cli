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

// size.js falls back to $MKT_ACCOUNT when --account is absent, and spawnSync inherits the parent env,
// so an exported value would silently rewrite every expectation here. CLAUDE.md has this repo setting
// mkt env vars in launchd plists, which makes a developer with it exported the normal case, not an
// exotic one — and a suite that is green in CI and red on one machine is the confusion a pinning
// suite exists to prevent.
//
// The whole MKT_ namespace, not just that one var: the vars the OTHER commands read have side effects
// rather than defaults. MKT_TG_TOKEN / MKT_NTFY_TOPIC would make an `alert` test send real pushes, and
// MKT_BACKUP_DIR would make a `backup` test write into someone's iCloud mirror. $HOME is the remaining
// one — anything touching sql/ingest/alert/watchlist opens the developer's real ~/.mkt/mkt.db — and it
// needs a temp dir per test, so it is owed by whoever adds the first DB-touching case.
const ENV = { ...process.env };
for (const k of Object.keys(ENV)) if (k.startsWith('MKT_')) delete ENV[k];

// extraEnv puts a variable deliberately back: MKT_ACCOUNT is the one default that is environment-
// dependent, so the hint path that decides whether to emit --account can only be exercised with it set.
// The rerun has to see the same env, which is the entire point of the case.
function run(args, extraEnv) {
  const r = spawnSync(process.execPath, [BIN, 'size', ...args], { encoding: 'utf8', env: { ...ENV, ...extraEnv } });
  const hint = (r.stderr.match(/^hint:\s+(.+)$/m) ?? [])[1]?.trim() ?? null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, hint };
}

// Every flag in this command takes a value, so pairing is enough. NOTE for anyone extending this to
// other commands: hints elsewhere carry quoted expressions with spaces (`--where 'RSI < 30'`), and
// splitting those on whitespace produces a rerun that fails for reasons unrelated to the hint. That
// needs a quote-aware tokenizer, deliberately not written here because nothing would exercise it yet.
const flagsOf = (argv) => Object.fromEntries(
  argv.reduce((pairs, tok, i) => (i % 2 ? pairs : [...pairs, [tok.replace(/^--/, ''), argv[i + 1]]]), []),
);
const hintArgv = (hint) => hint.split(/\s+/).slice(2);   // drop the leading `mkt size`

// No local copy of size.js's defaults lives here. Every one of them is read back out of the rerun's
// own output instead, because a copy cannot see the original change — which is the PR #8 bug shape
// reappearing inside the suite built to catch it. `max_pct` was added to the output for exactly this
// reason; it also answers "capped at what?" for anything parsing the JSON.

// Correctable inputs: the numbers are well-formed, the combination just doesn't size. The hint is a
// CORRECTION, so it has to carry the caller's own inputs forward.
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
  // --risk 1 is the default spelled out, so hint() omits it. That makes this the case that notices if
  // size.js's real default and hint()'s omission literal ever stop agreeing.
  ['cap-bound with risk spelled out at its default', ['--entry', '5000', '--stop', '4999', '--account', '6000', '--risk', '1']],
  // The same invocation with MKT_ACCOUNT set. --account 6000 is the literal hint() used to compare
  // against, so this is the only shape where an omitted --account resolves to a different account on
  // rerun — the account twin of the case above, except one of the two copies isn't a constant.
  ['explicit account that matches the literal, with the env set',
    ['--entry', '5000', '--stop', '4999', '--account', '6000'], { MKT_ACCOUNT: '3000' }],
  // The two need* paths where ceil() lands a hair under the limit it was computed to clear. Found by
  // sweeping 37,496 hint-emitting inputs against the binary, not by inspection — the arithmetic is
  // exact on paper and only the second rounding, inside the rerun, is short.
  ['account hint whose rounding lands a hair short',
    ['--entry', '1234.56', '--stop', '7000', '--account', '6000', '--risk', '1', '--max-pct', '1']],
  ['risk hint whose rounding lands a hair short',
    ['--entry', '0.0001', '--stop', '1', '--account', '1', '--risk', '0.01', '--max-pct', '25']],
];

for (const [name, args, env] of FAILING) {
  test(`hint corrects in one step: ${name}`, () => {
    const failed = run(args, env);
    assert.equal(failed.code, 2, `expected a usage failure\n${failed.stderr}`);
    assert.ok(failed.hint, `no hint offered\n${failed.stderr}`);

    const asked = flagsOf(args);
    const offered = flagsOf(hintArgv(failed.hint));

    // Compared as flag sets, not strings: hint() emits a fixed flag order, so a string compare misses
    // a hint that is the failing command reordered.
    assert.notDeepEqual(offered, asked, 'hint is the failing command with its flags reordered');

    // "Exits 0" alone is too weak on the target path: dropping --risk from a target hint still sizes
    // successfully, just at 1% instead of the 100% the caller asked for — silently wrong, and green.
    // So run the hint and read back what it ACTUALLY sized at, rather than recomputing what it should
    // have. Asserting against a local copy of size.js's defaults cannot see those defaults change.
    const rerun = run([...hintArgv(failed.hint), '--compact'], env);
    assert.equal(rerun.code, 0, `hint does not resolve: ${failed.hint}\n${rerun.stderr}`);
    const sized = JSON.parse(rerun.stdout);
    const effective = {
      account: sized.account, 'max-pct': sized.max_pct, risk: sized.risk_budget / sized.account * 100,
    };

    for (const [flag, value] of Object.entries(asked)) {
      if (flag === 'target') {
        assert.ok('target' in offered, 'hint dropped --target instead of moving it to a profitable price');
      } else if (flag === 'entry' || flag === 'stop') {
        // Numeric, not string: hint() re-renders via String(Number(x)), so `--entry 1e2` comes back as
        // `100` and a string compare would report a hint bug that is really just canonical formatting.
        assert.equal(Number(offered[flag]), Number(value),
          `hint changed --${flag}, which is the caller's actual trade`);
      } else {
        // risk is derived from two outputs that size.js rounds to 2dp, so it carries ~1/account of
        // error. A fixed epsilon would be orders of magnitude tighter than the quantity it guards and
        // would fire on a correct hint — e.g. --account 331 --risk 0.75 lands at 0.74924.
        const slack = flag === 'risk' ? 1 / effective.account : 0;
        assert.ok(effective[flag] >= Number(value) - slack,
          `hint silently lowers --${flag}: asked ${value}, rerun actually used ${effective[flag]}`);
      }
    }
  });
}

// Malformed inputs: there is nothing to carry forward, so the hint is an EXAMPLE of the right shape
// rather than a correction. Weaker contract, but it still has to run — a typo in a canned hint string
// ships silently and hands the user a command that reproduces an error.
const INVALID = [
  ['entry is not a number', ['--entry', 'abc', '--stop', '47']],
  ['risk above 100 percent', ['--entry', '50', '--stop', '47', '--risk', '200']],
  ['stop missing entirely', ['--entry', '50']],
  ['entry equals stop (zero risk per share)', ['--entry', '50', '--stop', '50']],
  // The canned example is a command too, and it inherits the same env fallback every other hint does.
  ['zero risk under an account the example would not clear',
    ['--entry', '412.5', '--stop', '412.5', '--account', '6000'], { MKT_ACCOUNT: '100' }],
];

for (const [name, args, env] of INVALID) {
  test(`example hint runs: ${name}`, () => {
    const failed = run(args, env);
    assert.equal(failed.code, 2, `expected a usage failure\n${failed.stderr}`);
    assert.ok(failed.hint, `validation error offers no hint at all\n${failed.stderr}`);
    assert.notDeepEqual(flagsOf(hintArgv(failed.hint)), flagsOf(args), 'hint reproduces the failing command');
    assert.equal(run(hintArgv(failed.hint), env).code, 0, `hint does not run: ${failed.hint}`);
  });
}

test('sizing arithmetic is unchanged', () => {
  const base = JSON.parse(run(['--entry', '50', '--stop', '47', '--compact']).stdout);
  assert.deepEqual(base, {
    side: 'long', shares: 20, position_value: 1000, pct_of_account: 16.67,
    risk_per_share: 3, loss_at_stop: 60, risk_budget: 60, account: 6000, max_pct: 25, capped_by_max_pct: false,
  });

  // Floors throughout, so the realised loss never exceeds the stated risk budget.
  assert.ok(base.loss_at_stop <= base.risk_budget);
});

test('a target on the profitable side reports R and profit', () => {
  const out = JSON.parse(run(['--entry', '50', '--stop', '47', '--target', '56', '--compact']).stdout);
  assert.equal(out.reward_risk, 2);
  assert.equal(out.profit_at_target, 120);
});

test('an empty MKT_ACCOUNT falls back to the default rather than failing', () => {
  // `??` treated MKT_ACCOUNT= as set, so blanking the var — a wrapper passing an unset value through,
  // or an empty launchd EnvironmentVariables entry — removed the 6000 fallback entirely.
  const out = JSON.parse(run(['--entry', '50', '--stop', '47', '--compact'], { MKT_ACCOUNT: '' }).stdout);
  assert.equal(out.account, 6000);
});

test('the position cap binds before the risk budget does', () => {
  const out = JSON.parse(run(['--entry', '50', '--stop', '49', '--compact']).stdout);
  assert.equal(out.shares, 30);
  assert.equal(out.pct_of_account, 25);
  assert.equal(out.capped_by_max_pct, true);
});
