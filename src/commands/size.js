import { MktError } from '../errors.js';
import { printObject } from '../output.js';

// mkt size --entry E --stop S [--account 6000] [--risk 1] [--max-pct 25] [--target T]
// Risk-first position sizing (spec §5): you fix the max loss; the stop distance sets the share count.
// side is inferred from entry vs stop (stop below entry = long, above = short).
//
// Every number here ends up in a real order, so each one is validated at the boundary rather than
// allowed to propagate: a NaN or a negative silently produces a share count that looks like an answer.
// --target included, above every throw: read only after sizing, a garbage target was swallowed by any
// earlier failure — the caller pasted the correction back, got a clean answer, and never learned.
export default async function size({ flags }) {
  const entry = num(flags.entry, 'entry', { positive: true });
  const stop = num(flags.stop, 'stop', { positive: true });
  // MKT_ACCOUNT is user input too — routed through num() so a stale `6k` in a shell profile or a plist
  // fails loudly instead of making every share count NaN, which JSON renders as a confident `null`.
  // `||`, not `??`: MKT_ACCOUNT= (a wrapper passing an unset var through, an empty plist entry) is a
  // normal way to blank a variable, and treating it as set removed the 6000 fallback entirely.
  const account = flags.account != null
    ? num(flags.account, 'account', { positive: true })
    : num(process.env.MKT_ACCOUNT || 6000, 'account (from $MKT_ACCOUNT)', { positive: true });
  const riskPct = pct(flags.risk, 'risk', 1);
  const maxPct = pct(flags['max-pct'], 'max-pct', 25);
  const target = flags.target != null ? num(flags.target, 'target', { positive: true }) : null;

  const riskPerShare = Math.abs(entry - stop);
  // The hint stays an EXAMPLE rather than a correction: any stop it suggested would be a trading
  // decision (stop distance is the whole input this command sizes from), and on a small account a
  // suggested stop can fail the position cap instead — relocating the error rather than resolving it.
  // The caller's number goes in the message instead.
  if (riskPerShare === 0) {
    throw new MktError('usage', `entry and stop are both ${entry} — a stop must differ from entry, or there is no risk to size.`, EXAMPLE);
  }
  const side = stop < entry ? 'long' : 'short';

  const riskDollars = account * riskPct / 100;
  const cap = account * maxPct / 100;
  // Separate the two limits so a 0-share result can say which one produced it. Blaming stop width for a
  // cap-bound result sent you in a circle: widening --risk changed nothing and the message didn't move.
  const byRisk = Math.floor(riskDollars / riskPerShare);
  const byCap = Math.floor(cap / entry);

  // A correction hint spells out EVERY resolved flag — no flag is ever omitted for being "at its
  // default". Six review rounds across PR #8/#10 traced almost every hint bug to omission: each
  // omitted flag needs its own copy of the default to compare against (a literal 6000 vs the real
  // `$MKT_ACCOUNT || 6000`), every copy can silently diverge, and at the call site an omitted flag is
  // indistinguishable from a forgotten one — which is exactly how sizing hints came to drop the
  // caller's --target. Explicit kills the class: what the hint says is what the rerun parses, env or
  // no env. Defaults here are the caller's own resolved values; a call site overrides only what it is
  // deliberately correcting.
  const hint = ({ risk = riskPct, cap: capFlag = maxPct, acct = account, target: tgt = target } = {}) =>
    `mkt size --entry ${entry} --stop ${stop} --risk ${risk} --max-pct ${capFlag} --account ${acct}`
    + (tgt != null ? ` --target ${tgt}` : '');

  // ceil() clears these thresholds in exact arithmetic, but the rerun rounds again — so a suggestion
  // can land a hair under the very limit it was computed to clear, handing back a hint that reproduces
  // the error. This is what profitable() already does for the target price; these three were the last
  // places still asserting a rounding rather than checking it. A sweep of 37,496 hint-emitting inputs
  // found 235 that failed, the most ordinary being `--entry 1234.56 --stop 7000 --account 6000
  // --risk 1 --max-pct 1`, which suggested `--account 576544` and exited 2 on the rerun.
  const clearsRisk = (r) => Math.floor(account * r / 100 / riskPerShare) >= 1;
  const clearsCap = (p) => Math.floor(account * p / 100 / entry) >= 1;
  // The account hint keeps the caller's own percentages, so it has to clear both limits at that rate.
  const clearsBoth = (a) =>
    Math.floor(a * riskPct / 100 / riskPerShare) >= 1 && Math.floor(a * maxPct / 100 / entry) >= 1;
  const needRisk = bump(ceil2(riskPerShare / account * 100), 0.01, clearsRisk);
  const needPct = bump(Math.ceil(entry / account * 100), 1, clearsCap);
  const needAccount = bump(Math.ceil(Math.max(riskPerShare * 100 / riskPct, entry * 100 / maxPct)), 1, clearsBoth);
  // Both limits have to clear one share, so a hint that raises only the one that happened to fail just
  // relocates the error to the next line. A single-flag suggestion is therefore offered ONLY when the
  // other limit already passes; otherwise fall back to the account that satisfies both at the caller's
  // own percentages — needAccount was derived from them, and a hint that silently reverts them to the
  // defaults is computed against different numbers than it runs.
  //
  // Computed once, above the target throw, so the target error carries it too: without that, a losing
  // target on an input that also fails sizing got a hint fixing only the target — the same relocation
  // this rule forbids, on a third axis. null means no correction exists; EXAMPLE still runs.
  const sizingFix =
    byRisk >= 1 && byCap >= 1 ? {}
    : byRisk < 1 && byCap >= 1 && needRisk != null && needRisk <= 100 ? { risk: needRisk }
    : byRisk >= 1 && needPct != null && needPct <= 100 ? { cap: needPct }
    : needAccount != null ? { acct: needAccount } : null;
  // The {acct} arm is the general fallback and it moves --account by orders of magnitude while
  // leaving the caller's limits untouched — a raise that large is not allowed to ride along unnamed
  // in a risk-sizing tool. One shared sentence, so every throw that emits the arm explains it and
  // the wordings cannot drift apart. Empty on every other arm.
  const raised = sizingFix?.acct
    ? ` The hint raises --account to $${sizingFix.acct}; no risk or cap under 100% sizes a share at these numbers.`
    : '';

  // Signed, not Math.abs: a target on the losing side of the trade (below entry on a long, above it
  // on a short) is a loss, and abs() reported it as profit with a positive R multiple.
  const rewardPerShare = target == null ? null : (side === 'long' ? target - entry : entry - target);
  if (target != null && rewardPerShare <= 0) {
    // A 2R target, floored at half the entry: on a short whose stop is wide relative to entry,
    // `entry - 2R` goes negative, and a suggested price below zero fails num() on the very next run.
    // The floored branch is no longer 2R — it is just the nearest sane target that is still a profit.
    const twoR = side === 'long' ? entry + riskPerShare * 2 : Math.max(entry - riskPerShare * 2, entry / 2);
    // twoR is strictly on the profitable side by construction; only the rounding can break that, so
    // round against that inequality rather than at a chosen precision — see profitable() below.
    const better = (v) => (side === 'long' ? v > entry : v < entry);
    // The hint may also raise a limit here, and --max-pct is the flag whose whole job is to cap
    // exposure. Every branch that moves a limit says so in its message; this one has to as well,
    // or the user pastes back a command that quietly quadruples their position size. The account
    // arm reuses the shared `raised` sentence.
    const also = !sizingFix ? NO_FIX
      : !Object.keys(sizingFix).length ? ''
      : sizingFix.acct ? raised
      : ' The position does not size at these limits either, so the hint corrects both.';
    throw new MktError('usage',
      `Target ${target} is on the losing side of a ${side} from ${entry} — that is a loss, not a target.${also}`,
      sizingFix ? hint({ ...sizingFix, target: profitable(twoR, better) }) : EXAMPLE);
  }
  if (byRisk < 1) {
    throw new MktError('usage',
      `Stop is too wide for the risk budget: $${round(riskDollars)} at $${round(riskPerShare)}/share is under one share.${sizingFix ? raised : NO_FIX}`,
      sizingFix ? hint(sizingFix) : EXAMPLE);
  }
  if (byCap < 1) {
    throw new MktError('usage',
      `Position cap (--max-pct ${maxPct}% = $${round(cap)}) is below one share at $${entry}.${sizingFix ? raised : NO_FIX}`,
      sizingFix ? hint(sizingFix) : EXAMPLE);
  }
  const shares = Math.min(byRisk, byCap);   // floor throughout: actual risk is always <= stated risk
  const capped = byCap < byRisk;

  const position = shares * entry;
  const out = {
    side, shares, position_value: round(position), pct_of_account: round(position / account * 100),
    risk_per_share: round(riskPerShare), loss_at_stop: round(shares * riskPerShare),
    risk_budget: round(riskDollars), account: round(account), max_pct: maxPct, capped_by_max_pct: capped,
  };
  if (target != null) {
    out.reward_risk = round(rewardPerShare / riskPerShare);
    out.profit_at_target = round(shares * rewardPerShare);
  }
  printObject(out, flags);
  return 0;
}

// Number(''), Number(' ') and Number(null) are all 0, and 1e400 is Infinity — none of which are a price.
function num(v, name, { positive = false } = {}) {
  const bad = (msg) => new MktError('usage', `--${name} ${msg}`, EXAMPLE);
  if (v == null || v === true || (typeof v === 'string' && v.trim() === '')) throw bad('must be a number.');
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad('must be a finite number.');
  if (positive && n <= 0) throw bad('must be greater than 0.');
  return n;
}

// Percentages of the account. Above 100 is leverage, which this command does not size for — it would
// quietly hand back a position larger than the account under a flag that reads like a safety cap.
function pct(v, name, fallback) {
  if (v == null) return fallback;
  const n = num(v, name, { positive: true });
  if (n > 100) throw new MktError('usage', `--${name} must be between 0 and 100 (percent of account).`, `${EXAMPLE} --${name} 25`);
  return n;
}

// Widen a suggested value by whole steps until the rerun's own test actually passes. Two steps, because
// only the final rounding is ever short: across 112,488 need* evaluations the measured maximum was ONE
// step and nothing failed to clear. Returns null rather than a value the caller just proved doesn't
// clear — handing that back would emit a hint reproducing its own error, the thing this exists to stop.
// (profitable() looks identical but returns its input, which is earned: 17 significant digits round-trip
// any double, so its fallthrough is unreachable by construction rather than by measurement.)
function bump(v, step, clears) {
  for (let i = 0; i < 2 && !clears(v); i++) v = round(v + step);
  return clears(v) ? v : null;
}

// sizingFix === null is the one place a CORRECTABLE input falls back to the example tier at runtime:
// no suggested account, risk or cap clears one share. bump() has never returned null across the
// 112,488-evaluation sweep, but that is measured, not proven — so when it happens the message says
// what changed tiers instead of silently handing over a different trade. The suite keys its
// example-tier handling on this sentence rather than carrying a copy of EXAMPLE's text.
const NO_FIX = ' No account, risk or cap this command can suggest sizes one share here; the hint is an example, not a correction.';

// The shape of a valid invocation, shown when the caller's own numbers are unusable. Not fully
// explicit like a correction hint — it teaches shape, not values — but --account is pinned because
// that default alone is env-dependent: without it the example fails outright under an exported
// MKT_ACCOUNT too small to buy a share. The risk and max-pct defaults are constants, so relying on
// them cannot break the rerun.
const EXAMPLE = 'mkt size --entry 50 --stop 47 --account 6000';

const round = (x) => Math.round(x * 100) / 100;
// Round UP to 2dp: a suggested percentage has to clear the threshold, not land just under it.
const ceil2 = (x) => Math.ceil(x * 100) / 100;
// Shortest rendering of a suggested price that is still strictly on the profitable side of entry.
// No fixed precision can do this, because both failure modes are real: 2 decimals collapse a $0.005
// target to $0.01 (the entry itself, on a penny short), while 6 significant digits collapse
// entry+0.000002 back to 100 (the entry itself, on a tight stop). Both hand back a hint that
// reproduces the very error it is meant to resolve. So widen until the inequality actually holds:
// 17 significant digits round-trips any double exactly, and String(x) is exact regardless, so the
// loop always terminates on a value that passes.
function profitable(x, ok) {
  for (let p = 3; p <= 17; p++) {
    const v = Number(x.toPrecision(p));
    if (ok(v)) return v;
  }
  return x;
}
