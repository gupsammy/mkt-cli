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
mkt ingest --region america --prune                    # load snapshots → ~/.mkt/mkt.db, drop gz >30d
mkt sql "SELECT symbol,RSI FROM snapshots WHERE date=(SELECT max(date) FROM snapshots) AND RSI<30" --json
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

## Data recording + the panel (the point)
`mkt record` appends a wide daily snapshot (~74 fields × full universe) to
`$MKT_HOME/snapshots/<region>/<YYYY-MM-DD>.ndjson.gz` (`MKT_HOME` defaults to `~/.mkt`). Daily
screener data is **unrecoverable** — the scanner has no "as of last week" — so run it daily to build a
point-in-time panel. Idempotent: re-running a day overwrites that day's file.

`mkt ingest` loads the gz snapshots into `~/.mkt/mkt.db` (SQLite, one `snapshots(date,symbol,…)`
table, idempotent upsert). Query with `mkt sql "<SELECT>"` (read-only connection; NDJSON out).
`--prune` drops gz files >30 days old after a verified round-trip — the gz is a 30-day recovery
buffer, the DB is the source of truth. Only snapshots are stored; temporal price stays on-demand via
`mkt history`.

Scheduled via **launchd** (not cron) — `~/scripts/mkt-record.sh` runs `record` → `ingest --prune`
weekdays after the US close. See the repo's `CLAUDE.md` for the panel-query examples.

## Notes
- Not affiliated with TradingView. Uses undocumented endpoints (the anonymous, account-less delayed
  path) — they can change without notice; all wire formats are isolated in `src/providers/tradingview.js`.
- Deps: `ws` + `better-sqlite3`. The SQLite panel/query layer (Phase 2) is built — see above.
