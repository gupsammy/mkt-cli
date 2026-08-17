import { metainfo } from '../providers/tradingview.js';
import { printRows, printObject } from '../output.js';

// Curated representative columns per TradingView filter category (all verified live).
// The full catalog is ~3,771 fields (mostly period/timeframe variants) — use --search to grep it.
const CATEGORIES = {
  'security-info': ['name', 'description', 'sector', 'industry', 'country', 'exchange', 'type', 'market_cap_basic', 'total_shares_outstanding_current', 'float_shares_outstanding', 'number_of_employees'],
  'market-data': ['close', 'open', 'high', 'low', 'change', 'change_abs', 'volume', 'average_volume_10d_calc', 'average_volume_90d_calc', 'relative_volume_10d_calc', 'VWAP', 'gap', 'premarket_change', 'postmarket_change', 'price_52_week_high', 'price_52_week_low', 'High.3M', 'Low.3M'],
  technicals: ['RSI', 'Stoch.K', 'Stoch.D', 'MACD.macd', 'MACD.signal', 'CCI20', 'ADX', 'ATR', 'Mom', 'SMA20', 'SMA50', 'SMA200', 'EMA20', 'EMA50', 'EMA200', 'BB.upper', 'BB.lower', 'KltChnl.upper', 'KltChnl.lower', 'Recommend.All', 'Recommend.MA', 'Perf.1M', 'Perf.3M', 'Perf.Y', 'Perf.YTD', 'Volatility.D'],
  financials: ['total_revenue_ttm', 'net_income_ttm', 'total_debt_fq', 'total_assets_fq', 'total_equity_fq', 'cash_n_equivalents_fq', 'free_cash_flow_ttm', 'ebitda_ttm', 'earnings_per_share_diluted_ttm', 'revenue_per_share_ttm', 'book_value_per_share_fq'],
  valuation: ['price_earnings_ttm', 'price_book_fq', 'price_sales_ratio', 'price_free_cash_flow_ttm', 'enterprise_value_fq', 'enterprise_value_ebitda_ttm', 'price_earnings_growth_ttm'],
  growth: ['total_revenue_yoy_growth_ttm', 'earnings_per_share_diluted_yoy_growth_ttm', 'net_income_yoy_growth_ttm', 'ebitda_yoy_growth_ttm', 'free_cash_flow_yoy_growth_ttm'],
  margins: ['gross_margin', 'operating_margin', 'net_margin', 'pre_tax_margin', 'ebitda_margin_ttm', 'return_on_equity', 'return_on_assets', 'return_on_invested_capital'],
  dividends: ['dividend_yield_recent', 'dividends_per_share_fq', 'dividend_payout_ratio_percent_fy', 'continuous_dividend_payout', 'continuous_dividend_growth'],
};

export default async function fields({ flags }) {
  const region = flags.region || 'america';

  // --search: grep the full live catalog by substring.
  if (flags.search) {
    const term = String(flags.search).toLowerCase();
    const meta = await metainfo(region);
    const hits = (meta.fields || []).filter((f) => f.n.toLowerCase().includes(term)).map((f) => ({ field: f.n, type: f.t }));
    if (!flags.quiet) process.stderr.write(`# matches=${hits.length} (of ${meta.fields.length})\n`);
    printRows(hits, flags);
    return 0;
  }

  // --category: the curated columns for one group.
  if (flags.category) {
    const key = String(flags.category).toLowerCase().replace(/[_ ]/g, '-');
    const cols = CATEGORIES[key];
    if (!cols) { process.stderr.write(`error: unknown category "${flags.category}". One of: ${Object.keys(CATEGORIES).join(', ')}\n`); return 2; }
    printRows(cols.map((c) => ({ category: key, field: c })), flags);
    return 0;
  }

  // bare: category summary.
  const meta = await metainfo(region);
  printObject({
    region,
    total_fields: (meta.fields || []).length,
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.length])),
    note: 'curated columns per category; --category <name> lists them; --search <term> greps all fields',
  }, flags);
  return 0;
}
