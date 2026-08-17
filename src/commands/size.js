import { MktError } from '../providers/tradingview.js';
import { printObject } from '../output.js';

// mkt size --entry E --stop S [--account 6000] [--risk 1] [--max-pct 25] [--target T]
// Risk-first position sizing (spec §5): you fix the max loss; the stop distance sets the share count.
// side is inferred from entry vs stop (stop below entry = long, above = short).
export default async function size({ flags }) {
  const entry = num(flags.entry, 'entry');
  const stop = num(flags.stop, 'stop');
  const account = flags.account != null ? num(flags.account, 'account') : Number(process.env.MKT_ACCOUNT || 6000);
  const riskPct = flags.risk != null ? num(flags.risk, 'risk') : 1;
  const maxPct = flags['max-pct'] != null ? num(flags['max-pct'], 'max-pct') : 25;

  const riskPerShare = Math.abs(entry - stop);
  if (riskPerShare === 0) throw new MktError('usage', 'entry and stop cannot be equal (zero risk/share).', null);
  const side = stop < entry ? 'long' : 'short';

  const riskDollars = account * riskPct / 100;
  let shares = Math.floor(riskDollars / riskPerShare);
  const cap = account * maxPct / 100;
  let capped = false;
  if (shares * entry > cap) { shares = Math.floor(cap / entry); capped = true; }   // don't over-concentrate
  if (shares < 1) throw new MktError('usage', `Stop too wide for the risk budget — 0 shares. Widen risk or tighten stop.`, null);

  const position = shares * entry;
  const out = {
    side, shares, position_value: round(position), pct_of_account: round(position / account * 100),
    risk_per_share: round(riskPerShare), loss_at_stop: round(shares * riskPerShare),
    risk_budget: round(riskDollars), capped_by_max_pct: capped,
  };
  if (flags.target != null) {
    const target = num(flags.target, 'target');
    const rewardPerShare = Math.abs(target - entry);
    out.reward_risk = round(rewardPerShare / riskPerShare);
    out.profit_at_target = round(shares * rewardPerShare);
  }
  printObject(out, flags);
  return 0;
}

function num(v, name) {
  const n = Number(v);
  if (v == null || v === true || Number.isNaN(n)) throw new MktError('usage', `--${name} must be a number.`, `mkt size --entry 50 --stop 47`);
  return n;
}
const round = (x) => Math.round(x * 100) / 100;
