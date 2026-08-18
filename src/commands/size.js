import { MktError } from '../errors.js';
import { printObject } from '../output.js';

// mkt size --entry E --stop S [--account 6000] [--risk 1] [--max-pct 25] [--target T]
// Risk-first position sizing (spec §5): you fix the max loss; the stop distance sets the share count.
// side is inferred from entry vs stop (stop below entry = long, above = short).
//
// Every number here ends up in a real order, so each one is validated at the boundary rather than
// allowed to propagate: a NaN or a negative silently produces a share count that looks like an answer.
export default async function size({ flags }) {
  const entry = num(flags.entry, 'entry', { positive: true });
  const stop = num(flags.stop, 'stop', { positive: true });
  // MKT_ACCOUNT is user input too — routed through num() so a stale `6k` in a shell profile or a plist
  // fails loudly instead of making every share count NaN, which JSON renders as a confident `null`.
  const account = flags.account != null
    ? num(flags.account, 'account', { positive: true })
    : num(process.env.MKT_ACCOUNT ?? 6000, 'account (from $MKT_ACCOUNT)', { positive: true });
  // hint() may omit a flag only when the rerun would fall back to the same value. That holds for risk
  // and max-pct, whose defaults are constants — but the account default is `$MKT_ACCOUNT ?? 6000`, so
  // with the env set an omitted --account resolves to something else entirely and the hint fails.
  const envAccount = process.env.MKT_ACCOUNT != null;
  const riskPct = pct(flags.risk, 'risk', 1);
  const maxPct = pct(flags['max-pct'], 'max-pct', 25);

  const riskPerShare = Math.abs(entry - stop);
  // Every other failure in this command hands back a runnable command; this one used to hand back null,
  // which made "a size error always offers a way forward" an invariant with one silent exception.
  // The hint stays an EXAMPLE rather than a correction carrying the caller's account and risk: any stop
  // it suggested would be a trading decision (stop distance is the whole input this command sizes from),
  // and on a small account a suggested stop can fail the position cap instead — relocating the error,
  // which is the bug class PR #8 spent five rounds killing. Their number goes in the message instead.
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
  // Both limits have to clear one share, so a hint that raises only the one that happened to fail just
  // relocates the error to the next line. A single-flag suggestion is therefore offered ONLY when the
  // other limit already passes; otherwise fall back to the account that satisfies both at once. The
  // caller's own percentages are carried into every hint, since needAccount was derived from them and
  // a hint that silently reverts them to the defaults is computed against different numbers than it runs.
  const hint = ({ risk = riskPct, cap: capFlag = maxPct, acct = null, target = null }) =>
    `mkt size --entry ${entry} --stop ${stop}`
    + (risk !== 1 ? ` --risk ${risk}` : '') + (capFlag !== 25 ? ` --max-pct ${capFlag}` : '')
    + ((account !== 6000 || envAccount) && !acct ? ` --account ${account}` : '') + (acct ? ` --account ${acct}` : '')
    + (target ? ` --target ${target}` : '');
  const needRisk = ceil2(riskPerShare / account * 100);
  const needPct = Math.ceil(entry / account * 100);
  const needAccount = Math.ceil(Math.max(riskPerShare * 100 / riskPct, entry * 100 / maxPct));
  if (byRisk < 1) {
    throw new MktError('usage',
      `Stop is too wide for the risk budget: $${round(riskDollars)} at $${round(riskPerShare)}/share is under one share.`,
      byCap >= 1 && needRisk <= 100 ? hint({ risk: needRisk }) : hint({ acct: needAccount }));
  }
  if (byCap < 1) {
    throw new MktError('usage',
      `Position cap (--max-pct ${maxPct}% = $${round(cap)}) is below one share at $${entry}.`,
      needPct <= 100 ? hint({ cap: needPct }) : hint({ acct: needAccount }));
  }
  const shares = Math.min(byRisk, byCap);   // floor throughout: actual risk is always <= stated risk
  const capped = byCap < byRisk;

  const position = shares * entry;
  const out = {
    side, shares, position_value: round(position), pct_of_account: round(position / account * 100),
    risk_per_share: round(riskPerShare), loss_at_stop: round(shares * riskPerShare),
    risk_budget: round(riskDollars), account: round(account), max_pct: maxPct, capped_by_max_pct: capped,
  };
  if (flags.target != null) {
    const target = num(flags.target, 'target', { positive: true });
    // Signed, not Math.abs: a target on the losing side of the trade (below entry on a long, above it
    // on a short) is a loss, and abs() reported it as profit with a positive R multiple.
    const rewardPerShare = side === 'long' ? target - entry : entry - target;
    if (rewardPerShare <= 0) {
      // A 2R target, floored at half the entry: on a short whose stop is wide relative to entry,
      // `entry - 2R` goes negative, and a suggested price below zero fails num() on the very next run.
      // The floored branch is no longer 2R — it is just the nearest sane target that is still a profit.
      const twoR = side === 'long' ? entry + riskPerShare * 2 : Math.max(entry - riskPerShare * 2, entry / 2);
      // twoR is strictly on the profitable side by construction; only the rounding can break that, so
      // round against that inequality rather than at a chosen precision — see profitable() below.
      const better = (v) => (side === 'long' ? v > entry : v < entry);
      throw new MktError('usage',
        `Target ${target} is on the losing side of a ${side} from ${entry} — that is a loss, not a target.`,
        hint({ target: profitable(twoR, better) }));
    }
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

// The shape of a valid invocation, shown when the caller's own numbers are unusable.
// --account is pinned for the same reason hint() stopped omitting it: without it, this example
// fails outright under an exported MKT_ACCOUNT too small to buy a share.
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
