# mkt — project instructions

Agent-first CLI that extracts TradingView market + macro data as JSON. Standalone Node ESM,
`ws` the only runtime dep. No login, no GUI, data delayed ~15m. Replaces the old tradingview-mcp
server / `tv` CLI+skill (that approach drove a live chart via CDP; this one is stateless HTTP/WS).

## Two data sources (undocumented; all wire formats isolated in `src/providers/tradingview.js`)
- **Scanner REST** `POST scanner.tradingview.com/{region}/scan` — cross-sectional snapshot. 8 regions,
  3,771 fields. Fetch specific tickers via `symbols.tickers`. `range:[0,0]` → HTTP 400, use `[0,1]`.
- **History WS** `wss://data.tradingview.com/socket.io/websocket` + public `unauthorized_user_token`
  — temporal OHLCV, any symbol, no bar cap. Intermittently flaky → `history()` retries 3× on upstream
  errors, never on `not_found` (a `symbol_error` frame is deterministic, ~1.1s fast-fail).

## Commands (`node bin/mkt.js <cmd>` or `mkt` after `npm link`)
```
screen   --where 'RSI < 38' --where 'close > SMA200' --columns a,b --sort -col --limit n [--liquid]
history  NASDAQ:AAPL --tf 1D --bars 300          # any symbol: TVC:US10Y, FRED:UNRATE, BINANCE:BTCUSDT
quote    NASDAQ:AAPL NASDAQ:MSFT                 # latest row(s), one call
search   apple                                   # → NASDAQ:AAPL (synthesizes exchange:symbol)
fields   --search rsi  |  --category margins     # introspect the field catalog
regions                                          # the 8 universes + counts
record   --region america                        # append daily wide snapshot (see below)
```
- `--json` = NDJSON (lists) / JSON (scalars). `--compact` = minified. Data→stdout, errors→stderr.
- `--where` filter language (AND-only; OR is a future addition): `<col> < > <= >= = != <val>`,
  `<col> between a,b`, `<col> has v`, `close > SMA200` (column-vs-column), `RSI|60 < 30` (intraday).
- `--liquid`: prepends the real-US-stock floor (common, >$1B cap, >$5, >500k vol). Use on `america`;
  no-op on forex/crypto/econ. Without it, `screen` surfaces penny/OTC base-effect junk.
- Exit codes: `0` ok, `2` usage/bad-filter/bad-column, `3` not-found, `5` upstream. Errors in `--json`
  are `{error,message,hint}` on stderr; `hint` is a runnable command.
- Column typos are validated against `/metainfo` BEFORE the scan (the scanner returns null, not an
  error, for unknown columns).

## The recorder + scheduling (the point of the project)
Daily screener data is **unrecoverable** — the scanner has no "as of last week". `mkt record` appends
a wide (~74-field) gzipped snapshot of the whole universe to
`~/.mkt/snapshots/<region>/<YYYY-MM-DD>.ndjson.gz` (~12 MB/day america). Idempotent; read with
`gzcat file | jq`. Bar/record dates use exchange-tz trading dates (`src/tzdate.js`), not naive UTC.

Scheduled via **launchd** (not cron): `~/scripts/mkt-record.sh` → `com.user.mkt-record.plist`,
weekdays 4:30 PM local. Add regions by editing `REGIONS` in the wrapper. Logs:
`~/scripts/logs/mkt-record/`.

## Deliberately NOT here (was in tradingview-mcp, dropped with the CDP approach)
Chart control, Pine Script dev/backtest, screenshots, drawings, order-book depth, real-time quotes.
All need the live desktop chart. mkt is stateless data only.

**Two separate tools, no overlap:** `mkt` = stateless data (this project). `tv`
(`~/repos/forks/tradingview-mcp/`, still intact) = live chart control via CDP, on demand. We removed
only tv's MCP registration + skill wrapper, not the CLI.

**What Pine uniquely gives (and the honest verdict):**
- Custom indicators → NOT a loss: compute from `mkt history` bars in Python/pandas (more flexible than Pine).
- Strategy backtester (equity curve, win rate, drawdown, trade list, lookahead protection) → the ONE
  genuinely hard-to-replace piece. **Decision (2026-08-17): use `tv`+Pine strategy tester for backtesting
  for now.** A native mkt/Python backtester (vectorbt/backtrader over the recorded panel) is deferred —
  its value scales with recorded history, and the panel is brand new (recording started today). Revisit
  once there's a meaningful depth of snapshots to backtest against.
- Custom-condition alerts → mkt owns these itself, OUTSIDE TradingView (TV free tier caps alerts at 1).
  An alert = saved condition + check schedule + notify sink; mkt already has the first two.
  **Design locked (2026-08-17): intraday cadence (tight launchd interval during market hours) + ntfy.sh
  push + cross-sectional screen alerts, edge-triggered (notify on NEW entrants, tiny JSON state file).**
  Per-symbol thresholds + Telegram sink deferred. Not built yet.

The SQLite query/cache layer (fast cross-period joins over recorded snapshots) is deferred until a
measured need — Phase 2.

Full design spec: `../trading-experiments/docs/mkt-cli-spec.md`.
