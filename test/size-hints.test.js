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

// Correctable inputs: the numbers are well-formed, the combination just doesn't size. The hint is a
// CORRECTION, and a correction is FULLY EXPLICIT — it spells out every resolved flag. That is the
// contract that killed the omission bug class: a hint that drops flags "at their default" needs a
// local copy of each default to decide what to drop, every copy can diverge from the real resolution
// (a literal 6000 vs `$MKT_ACCOUNT || 6000`), and an omitted flag is indistinguishable from a dropped
// one. With all flags spelled out, what the hint says is literally what the rerun parses.
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
  // --risk 1 is the default spelled out. Under the old omission design this was the case that noticed
  // hint()'s `risk !== 1` literal diverging from pct()'s fallback; it stays as the pin that a flag
  // passed at its default still comes back explicit, not silently dropped.
  ['cap-bound with risk spelled out at its default', ['--entry', '5000', '--stop', '4999', '--account', '6000', '--risk', '1']],
  // The same invocation with MKT_ACCOUNT exported. The old design omitted --account whenever the
  // resolved value equalled its 6000 literal, so this exact shape re-resolved to 3000 on rerun and
  // failed again. Explicit hints make it a non-event — which is what this row now pins.
  ['explicit account equal to the old omission literal, with the env set',
    ['--entry', '5000', '--stop', '4999', '--account', '6000'], { MKT_ACCOUNT: '3000' }],
  // The two need* paths where ceil() lands a hair under the limit it was computed to clear. Found by
  // sweeping 37,496 hint-emitting inputs against the binary, not by inspection — the arithmetic is
  // exact on paper and only the second rounding, inside the rerun, is short.
  ['account hint whose rounding lands a hair short',
    ['--entry', '1234.56', '--stop', '7000', '--account', '6000', '--risk', '1', '--max-pct', '1']],
  ['risk hint whose rounding lands a hair short',
    ['--entry', '0.0001', '--stop', '1', '--account', '1', '--risk', '0.01', '--max-pct', '25']],
  // A target paired with a SIZING failure. Every other --target row has a stop tight enough that both
  // limits clear, so the `'target' in offered` assertion below was aspirational until this row existed.
  ['valid target alongside a cap-bound failure',
    ['--entry', '5000', '--stop', '4999', '--account', '6000', '--target', '5100']],
  // A LOSING target alongside a sizing failure. Hoisting the target check above the sizing checks made
  // this branch reachable for the first time, and its hint corrected only the target — one blind spot
  // traded for its mirror image. Both limits, so neither correction path can regress alone.
  ['losing target alongside a cap-bound failure',
    ['--entry', '5000', '--stop', '4999', '--account', '6000', '--target', '4000']],
  ['losing target alongside a risk-bound failure',
    ['--entry', '100', '--stop', '7000', '--account', '6000', '--target', '200']],
  // target === entry is the boundary of the `rewardPerShare <= 0` predicate — what distinguishes it
  // from `< 0`. The grid can't generate it (its targets are strict multiples of entry), and it's the
  // twin of the `entry === stop` case that does have a row.
  ['target exactly at entry, which is zero reward, not a small one',
    ['--entry', '50', '--stop', '47', '--target', '50']],
];

for (const [name, args, env] of FAILING) {
  test(`hint corrects in one step: ${name}`, () => {
    const failed = run(args, env);
    assert.equal(failed.code, 2, `expected a usage failure\n${failed.stderr}`);
    assert.ok(failed.hint, `no hint offered\n${failed.stderr}`);

    // The runtime downgrade to the example tier: no suggested account/risk/cap clears one share
    // (sizingFix === null). Reachable — a denormal --risk overflows every candidate account to
    // Infinity — but inputs like that, where no correction CAN exist, belong in INVALID below. A row
    // listed HERE is one we claim is correctable, so taking this branch is a finding, not a pass:
    // the example hint is verified runnable, then the row fails naming the downgrade — checked before
    // the explicitness loop so the red says what happened instead of misreporting "hint omits --risk".
    if (/the hint is an example, not a correction/.test(failed.stderr)) {
      assert.equal(run(hintArgv(failed.hint), env).code, 0, `example hint does not run: ${failed.hint}`);
      assert.fail(`no sizing correction exists for a correctable input: mkt size ${args.join(' ')}`);
    }

    const asked = flagsOf(args);
    const offered = flagsOf(hintArgv(failed.hint));

    // The explicit-hint contract itself. This is what makes the value comparisons below sufficient:
    // with no flag ever omitted, "what the hint offers" and "what the rerun resolves" cannot differ,
    // so there is no default to copy and nothing for an exported MKT_ACCOUNT to silently rewrite.
    for (const flag of ['entry', 'stop', 'risk', 'max-pct', 'account']) {
      assert.ok(flag in offered, `hint omits --${flag}; a correction must spell out every resolved flag`);
    }

    // Kept for its failure message only — explicitness subsumed it. A correction now always emits
    // 5-6 flags while callers pass 2-4, so the sets differ before any value is compared; there is no
    // reachable input left where this is the assertion that fires. Do not count it as coverage.
    assert.notDeepEqual(offered, asked, 'hint is the failing command with its flags reordered');

    for (const [flag, value] of Object.entries(asked)) {
      if (flag === 'target') {
        assert.ok('target' in offered, 'hint dropped --target instead of moving it to a profitable price');
      } else if (flag === 'entry' || flag === 'stop') {
        // Numeric, not string: hint() re-renders via String(Number(x)), so `--entry 1e2` comes back as
        // `100` and a string compare would report a hint bug that is really just canonical formatting.
        assert.equal(Number(offered[flag]), Number(value),
          `hint changed --${flag}, which is the caller's actual trade`);
      } else {
        // "Exits 0" alone is too weak on the target path: a hint that lowered --risk from 100 to the
        // default still sizes successfully, just at 1% of the account — silently wrong, and green.
        assert.ok(Number(offered[flag]) >= Number(value),
          `hint silently lowers --${flag}: asked ${value}, offered ${offered[flag]}`);
      }
    }

    // The paste-back itself, under the same env the hint was issued in: one step, exit 0. --compact
    // so the offered values can be checked against what the rerun RESOLVED them to: explicitness
    // removed the omission gap, not the assumption that the parser reads back what the hint wrote.
    const rerun = run([...hintArgv(failed.hint), '--compact'], env);
    assert.equal(rerun.code, 0, `hint does not resolve: ${failed.hint}\n${rerun.stderr}`);
    const sized = JSON.parse(rerun.stdout);
    // account is rounded to 2dp in the output; the hint prints the caller's value verbatim, so round
    // both sides or a fractional --account would false-red on a hint that is entirely correct.
    assert.equal(sized.account, Math.round(Number(offered.account) * 100) / 100,
      'rerun resolved a different --account than the hint spelled');
    assert.equal(sized.max_pct, Number(offered['max-pct']),
      'rerun resolved a different --max-pct than the hint spelled');
    // risk — the flag that made "exits 0" insufficient in the first place — is recovered from two
    // outputs that are each 2dp-rounded, so the slack scales with that rounding (~1/account), not a
    // fixed epsilon orders of magnitude tighter than the quantity it guards.
    assert.ok(Math.abs(sized.risk_budget / sized.account * 100 - Number(offered.risk)) <= 1 / sized.account,
      'rerun resolved a different --risk than the hint spelled');
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
  // target was read only after sizing succeeded, so a sizing failure swallowed a garbage target whole.
  ['target that is not a number, alongside a sizing failure',
    ['--entry', '5000', '--stop', '4999', '--account', '6000', '--target', 'abc']],
  // The zero-risk throw used to run before --target was read, so it swallowed a bad target too.
  ['entry equals stop AND the target is garbage', ['--entry', '50', '--stop', '50', '--target', 'abc']],
  ['zero risk under an account the example would not clear',
    ['--entry', '412.5', '--stop', '412.5', '--account', '6000'], { MKT_ACCOUNT: '100' }],
  // Well-formed numbers, but no correction CAN exist: a denormal --risk overflows every candidate
  // account to Infinity, which bump() rejects rather than letting `--account Infinity` fail num()
  // on the rerun. The one input shape that crosses from correctable to example tier BY DESIGN —
  // FAILING's trip-wire is for rows that cross unexpectedly.
  ['denormal risk that no finite account can satisfy',
    ['--entry', '5000', '--stop', '4999', '--account', '6000', '--risk', '5e-324']],
  // The target twins of the row above, at both ends of the number line: entry + 2R overflows to
  // Infinity on the long side, entry / 2 underflows to 0 on the short side — either suggestion
  // would fail num() on the rerun, so profitable() refuses and the example tier says why.
  ['losing target whose correction would overflow to Infinity',
    ['--entry', '1e308', '--stop', '1', '--risk', '100', '--max-pct', '100', '--target', '0.5']],
  ['losing target whose correction would underflow to zero',
    ['--entry', '5e-324', '--stop', '1', '--target', '1']],
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

// The contract stated as a property rather than a list. Deliberately weaker than the FAILING tier —
// it only checks that a hint runs, not that it preserved the caller's flags — but it covers inputs
// nobody thought to write down. The two `need*` bugs above came out of a 37,496-input sweep at a 0.6%
// hit rate, which no hand-picked list converges on; that sweep is ~30 minutes of spawns, so what ships
// is a fixed grid of the same shape. Deterministic: no seed, no sampling, no flake.
test('every hint-emitting input in the grid resolves in one step', () => {
  const failures = [];
  // The target dimension is what lets the grid reach the losing-target throw — the one branch whose
  // hint carries no limit correction of its own, and therefore the one a targetless sweep cannot see.
  // 331 was dropped from the accounts to offset it, though only partly: 3 targets against 2 accounts is
  // 600 combinations, net 2x the 300 it replaced. Worth it while the suite stays under a minute; if it
  // ever needs trimming, the entry/stop lists are where the redundancy is (1.07/50 and 1/47 explore the
  // same regime). FAILING pins both need* paths and the target === entry boundary directly regardless.
  for (const entry of [0.01, 1.07, 50, 1234.56, 9000])
    for (const stop of [0.0001, 1, 47, 4999, 7000])
      for (const account of [100, 6000])
        // 5e-324 puts one denormal in the box: every overflow bug so far lived at the ends of the
        // number line, outside the sane-value grid that therefore couldn't see any of them.
        for (const [risk, cap] of [[1, 25], [0.01, 1], [0.75, 100], [100, 25], [5e-324, 25]])
          for (const target of [null, entry * (stop < entry ? 0.9 : 1.1), entry * (stop < entry ? 1.2 : 0.8)]) {
            const args = ['--entry', `${entry}`, '--stop', `${stop}`,
              '--account', `${account}`, '--risk', `${risk}`, '--max-pct', `${cap}`,
              ...(target == null ? [] : ['--target', `${target}`])];
            const failed = run(args);
            if (failed.code === 0) continue;
            if (!failed.hint) { failures.push(`no hint: mkt size ${args.join(' ')}`); continue; }
            if (run(hintArgv(failed.hint)).code !== 0) {
              failures.push(`from: mkt size ${args.join(' ')}\n    hint: ${failed.hint}`);
            }
          }
  assert.deepEqual(failures, [], `${failures.length} hint(s) do not resolve:\n  ${failures.join('\n  ')}`);
});

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

test('a hint that moves a limit says so, not just what was asked about', () => {
  // The hint here raises --max-pct from 25 to 84 — a position 3.4x larger than the caller's own cap,
  // on the one flag whose job is to prevent that. Nothing else in the suite can see a message: FAILING
  // compares flags and exit codes, the grid checks exit 0.
  const r = run(['--entry', '5000', '--stop', '4999', '--account', '6000', '--target', '4000']);
  assert.match(r.stderr, /losing side/);
  assert.match(r.stderr, /does not size at these limits/);
  assert.match(r.hint, /--max-pct 84/);

  // The account arm is worded separately: there the limits come back untouched and it is --account
  // that moves — here 6000 → 690000, a 115x raise the generic "corrects both" sentence never named.
  const acct = run(['--entry', '100', '--stop', '7000', '--account', '6000', '--target', '200']);
  assert.match(acct.stderr, /raises --account to \$690000/);

  // ...and the {acct} arm fires most often on the plain sizing paths — the same raise has to be
  // named there too, not only when a losing target happens to be along for the ride. One row per
  // throw site: byRisk < 1 falls through on needRisk > 100, byCap < 1 on needPct > 100.
  const riskPath = run(['--entry', '100', '--stop', '7000', '--account', '6000']);
  assert.match(riskPath.stderr, /Stop is too wide .* raises --account to \$690000/);
  const capPath = run(['--entry', '500', '--stop', '499.9', '--account', '100']);
  assert.match(capPath.stderr, /Position cap .* raises --account to \$2000/);

  // "Single" is load-bearing on the both-limits-fail route: here needRisk (1.67) and needPct (34)
  // are BOTH under 100, so raising the caller's own two flags together would size a share — the
  // sentence may say the account is the one-flag fix, not that no percentage correction exists.
  const bothFail = run(['--entry', '100', '--stop', '95', '--account', '300']);
  assert.match(bothFail.stderr, /raises --account to \$500; no single limit under 100%/);

  // ...and the denormal-risk input, where no finite correction exists at all, says that instead.
  const noFix = run(['--entry', '5000', '--stop', '4999', '--account', '6000', '--risk', '5e-324']);
  assert.match(noFix.stderr, /sizes one share here; the hint is an example/);

  // A refused target suggestion gets its own sentence, not NO_FIX's — here a sizing correction
  // (an account) does exist, so "no account sizes a share" would be false; the missing piece is a
  // representable price on the profitable side of a 1e308 entry.
  const noTarget = run(['--entry', '1e308', '--stop', '1', '--risk', '100', '--max-pct', '100', '--target', '0.5']);
  assert.match(noTarget.stderr, /No representable price is on the profitable side/);

  // ...and a target error with no sizing problem does not claim one.
  const plain = run(['--entry', '50', '--stop', '47', '--target', '40']);
  assert.doesNotMatch(plain.stderr, /does not size at these limits/);
});

test('an unparseable --target is reported, not swallowed by a sizing failure', () => {
  // The INVALID tier alone cannot pin this: with target read after sizing, `--target abc` still exits 2
  // with a runnable hint — the CAP error — so the generic contract passes while the garbage evaporates.
  // Only naming the message distinguishes "an error happened" from "the right error happened".
  for (const args of [
    ['--entry', '5000', '--stop', '4999', '--account', '6000', '--target', 'abc'],   // sizing failure
    ['--entry', '50', '--stop', '50', '--target', 'abc'],                            // zero-risk failure
  ]) {
    const r = run(args);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--target must be a finite number/,
      `a different error swallowed the bad target: mkt size ${args.join(' ')}`);
  }
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
