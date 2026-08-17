// Single source of truth for the recorded snapshot shape.
// record.js writes these columns; db.js builds the `snapshots` table from the same list,
// so the NDJSON on disk and the SQLite schema can never drift apart.
//
// WIDE by design (spec §9a): an unused field costs a few MB; an un-recorded field is
// unrecoverable. Edit freely — adding a field here is picked up by both the recorder and,
// on next ingest, by db.js (which ALTERs the table to add any missing column).
export const WIDE = [
  'name', 'description', 'sector', 'industry', 'type', 'market_cap_basic', 'total_shares_outstanding_current', 'float_shares_outstanding',
  'close', 'open', 'high', 'low', 'change', 'change_abs', 'volume', 'average_volume_10d_calc', 'average_volume_90d_calc',
  'relative_volume_10d_calc', 'VWAP', 'gap', 'price_52_week_high', 'price_52_week_low', 'High.1M', 'Low.1M', 'High.3M', 'Low.3M',
  'RSI', 'Stoch.K', 'Stoch.D', 'MACD.macd', 'MACD.signal', 'CCI20', 'ADX', 'ATR', 'Mom',
  'SMA20', 'SMA50', 'SMA200', 'EMA20', 'EMA50', 'EMA200', 'BB.upper', 'BB.lower', 'KltChnl.upper', 'KltChnl.lower',
  'Recommend.All', 'Recommend.MA', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.Y', 'Perf.YTD', 'Volatility.D', 'Volatility.W', 'beta_1_year',
  'price_earnings_ttm', 'price_book_fq', 'price_sales_ratio', 'enterprise_value_ebitda_ttm',
  'total_revenue_ttm', 'net_income_ttm', 'ebitda_ttm', 'free_cash_flow_ttm', 'earnings_per_share_diluted_ttm', 'total_debt_fq',
  'total_revenue_yoy_growth_ttm', 'earnings_per_share_diluted_yoy_growth_ttm',
  'gross_margin', 'operating_margin', 'net_margin', 'return_on_equity', 'return_on_assets', 'debt_to_equity',
  'dividend_yield_recent',
];

// The only non-numeric snapshot fields. Everything else in WIDE is bound as REAL so
// `WHERE RSI < 30` compares numerically, not lexically. `date`/`symbol` are the TEXT PK.
export const TEXT_FIELDS = new Set(['name', 'description', 'sector', 'industry', 'type']);

// SQLite column name for a TradingView field. TV fields contain '.' and '|' (e.g. `MACD.macd`,
// `BB.upper`) which are illegal bare SQL identifiers — we quote them in DDL/DML instead of
// renaming, so the column name matches the JSON key 1:1 and `mkt sql` uses the TV name verbatim.
export const colType = (field) => (TEXT_FIELDS.has(field) ? 'TEXT' : 'REAL');
