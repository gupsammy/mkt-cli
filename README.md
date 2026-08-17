# mkt

Agent-first CLI to extract TradingView market + macro data as JSON — cross-sectional snapshots
(screener) and temporal OHLCV history — across 8 asset universes. No login, no GUI, delayed ~15m.

Design spec: `../trading-experiments/docs/mkt-cli-spec.md`.

## Install
```bash
npm install
npm link          # optional → `mkt` on PATH; otherwise `node bin/mkt.js`
```

## Commands
```bash
mkt screen --liquid --where 'RSI < 38' --where 'close > SMA200' --columns name,close,RSI --sort RSI --limit 25 --json
mkt history NASDAQ:AAPL --tf 1D --bars 300 --json     # any symbol: TVC:US10Y, FRED:UNRATE, BINANCE:BTCUSDT
mkt quote NASDAQ:AAPL NASDAQ:MSFT --json
mkt search apple --json                                # synthesizes exchange:symbol
mkt fields --search rsi --json                         # grep the 3,771-field catalog
mkt fields --category margins                          # curated columns per category
mkt regions --json
mkt record --region america                            # append today's wide snapshot → NDJSON
```

## Filter mini-language (`--where`, AND-combined)
```
RSI < 30            close > SMA200 (column-vs-column)      RSI between 55,72
typespecs has common    sector = Technology               RSI|60 < 30 (intraday: |5 |15 |60 |240 |1W)
```
Operators: `< <= > >= = != between has`. OR/nested groups are Phase 2.

## Output & exit codes
- Human table by default; `--json` = NDJSON (lists) / JSON (scalars); `--compact` = minified.
- Data → stdout, diagnostics → stderr.
- `0` ok · `1` generic · `2` usage/bad-filter/bad-column · `3` not-found · `4` auth · `5` upstream.
- With `--json`, errors are `{"error","message","hint"}` on stderr; `hint` is an executable command.

## Data recording (the point)
`mkt record` appends a wide daily snapshot (~74 fields × full universe) to
`$MKT_HOME/snapshots/<region>/<YYYY-MM-DD>.ndjson` (`MKT_HOME` defaults to `~/.mkt`). Daily screener
data is **unrecoverable** — the scanner has no "as of last week" — so run it daily (cron) to build a
point-in-time panel. Idempotent: re-running a day overwrites that day's file.

```cron
# 4:15pm ET weekdays — after the US close
15 16 * * 1-5  cd /Users/samarthgupta/repos/myrepos/mkt && /usr/bin/node bin/mkt.js record --region america --json >> ~/.mkt/record.log 2>&1
```

## Notes
- Not affiliated with TradingView. Uses undocumented endpoints (the anonymous, account-less delayed
  path) — they can change without notice; all wire formats are isolated in `src/providers/tradingview.js`.
- Deps: `ws` only. SQLite query/cache layer is deferred (spec §9b) until a measured need.
