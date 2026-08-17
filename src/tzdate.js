/**
 * Trading-date normalization (spec D4).
 *
 * A daily bar's `t` is a unix instant at the SESSION OPEN in the exchange's timezone
 * (AAPL daily t = 09:30 ET), NOT midnight UTC. A naive new Date(t*1000).toISOString().slice(0,10)
 * lands on the wrong calendar day for non-US exchanges. Resolve the exchange tz and format there.
 */

// Exchange prefix → IANA timezone. Extend as new venues are exercised (coverage is sampled).
const TZ = {
  NASDAQ: 'America/New_York', NYSE: 'America/New_York', AMEX: 'America/New_York',
  BATS: 'America/New_York', CBOE: 'America/New_York', OTC: 'America/New_York',
  ARCA: 'America/New_York', TVC: 'America/New_York', FRED: 'America/New_York',
  CME: 'America/Chicago', CME_MINI: 'America/Chicago', CBOT: 'America/Chicago', COMEX: 'America/New_York', NYMEX: 'America/New_York',
  TSX: 'America/Toronto', TSXV: 'America/Toronto',
  LSE: 'Europe/London', LSIN: 'Europe/London',
  EURONEXT: 'Europe/Paris', XETR: 'Europe/Berlin', FWB: 'Europe/Berlin', SIX: 'Europe/Zurich',
  TSE: 'Asia/Tokyo', JPX: 'Asia/Tokyo',
  HKEX: 'Asia/Hong_Kong', SSE: 'Asia/Shanghai', SZSE: 'Asia/Shanghai',
  NSE: 'Asia/Kolkata', BSE: 'Asia/Kolkata',
  ASX: 'Australia/Sydney',
  BINANCE: 'UTC', COINBASE: 'UTC', BITSTAMP: 'UTC', KRAKEN: 'UTC',   // crypto = 24/7 UTC
};

const DEFAULT_TZ = 'America/New_York';

export function tzOf(symbol) {
  const exch = (symbol || '').includes(':') ? symbol.split(':')[0].toUpperCase() : '';
  return TZ[exch] || DEFAULT_TZ;
}

/** Exchange trading date (YYYY-MM-DD) for a bar instant `t` (unix seconds). */
export function tradingDate(t, symbol) {
  const tz = tzOf(symbol);
  // en-CA gives ISO YYYY-MM-DD; timeZone shifts the instant into the venue's local day.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(t * 1000));
}

/** Today's trading date for a region (used by `mkt record` to name the day's file). */
export function todayFor(region) {
  const tz = region === 'crypto' || region === 'coin' ? 'UTC' : DEFAULT_TZ;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
