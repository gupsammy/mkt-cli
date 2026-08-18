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
- Exit codes: `0` ok, `1` generic/partial (an `alert check` with an errored alert — healthy alerts
  still ran), `2` usage/bad-filter/bad-column, `3` not-found, `5` upstream, `7` conflict (duplicate
  resource, or `record` refusing pre-close/holiday — nothing written). Errors in `--json`
  are `{error,message,hint}` on stderr; `hint` is a runnable command.
- Column typos are validated against `/metainfo` BEFORE the scan (the scanner returns null, not an
  error, for unknown columns).

## The recorder + DB + scheduling (the point of the project)
Daily screener data is **unrecoverable** — the scanner has no "as of last week". `mkt record` appends
a wide (~74-field) gzipped snapshot of the whole universe to
`~/.mkt/snapshots/<region>/<YYYY-MM-DD>.ndjson.gz` (~12 MB/day america). Idempotent; read with
`gzcat file | jq`. Record dates use exchange-tz trading dates (`src/tzdate.js`), not naive UTC.
The `WIDE` field list lives in `src/schema.js` — single source of truth shared by the recorder and
the DB schema; add a field there and both the next record and the next ingest pick it up.

**The panel = SQLite (Phase 2, built).** `mkt ingest` loads the gz snapshots into `~/.mkt/mkt.db`,
one `snapshots(date, symbol, region, …74 cols)` table, PK `(date,symbol)`, `(symbol,date)` index,
idempotent upsert. Incremental by default (only files ≥ the region's newest ingested date replay;
`--all` = full rebuild). Schema auto-migrates: a new field in `schema.js` → `ALTER TABLE ADD COLUMN`
on next ingest (old rows NULL).
Query with `mkt sql "<SELECT>"` — a **read-only** connection (writes fail at the driver), NDJSON out.
Bad SQL / unknown column → exit 2 with a hint. **Only snapshots are stored** — temporal price stays
on-demand via `mkt history` (bars are recoverable from the WS any time, so caching them buys speed
not durability; not worth it — see spec §9b). Each daily snapshot already *is* a daily bar + ~200
features, so daily-resolution temporal analysis is a `snapshots` self-join, no bars needed.

**Durability model:** the gz archive is the **irreplaceable source of truth**; `mkt.db` is a
rebuildable projection (`mkt ingest` reconstructs it). So: **keep every gz forever** (no prune —
~3GB/yr is trivial vs losing unrecoverable snapshots; `--prune` still exists but is NOT used). `mkt
backup` mirrors the gz archive + a consistent DB dump (SQLite online-backup API, WAL-safe) to durable
storage (default iCloud `~/Library/Mobile Documents/com~apple~CloudDocs/mkt-backup/`, override `--to`
or `$MKT_BACKUP_DIR`), keeping the last 7 timestamped DB dumps. iCloud syncs it offsite. Guardrails:
`sql` opens read-only (writes fail at the driver), the DB lives *outside* the git repo (repo ops can't
touch it), no command deletes panel data.

Scheduled via **launchd** (not cron): `~/scripts/mkt-record.sh` → `com.user.mkt-record.plist`,
**Tue–Sat 03:30 IST** (= 18:00 EDT / 17:00 EST Mon–Fri, after the US close — the machine runs IST;
16:30 IST is pre-open and recorded the previous session under the wrong date, hence `record`'s
NY-close freshness guard). The wrapper runs `record` → `ingest` → `backup` → panel-alert check per region.
Add regions by editing `REGIONS` in the wrapper. Logs: `~/scripts/logs/mkt-record/`.

Example panel queries:
```
mkt sql "SELECT symbol,name,RSI FROM snapshots WHERE date=(SELECT max(date) FROM snapshots) AND RSI<30 ORDER BY RSI LIMIT 20"
# volume waking up while price flat (needs ≥2 recorded dates):
mkt sql "SELECT s2.symbol FROM snapshots s1 JOIN snapshots s2 USING(symbol) WHERE s1.date='D1' AND s2.date='D2' AND s2.volume>2*s1.average_volume_90d_calc AND abs(s2.close-s1.close)/s1.close<0.03"
```

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
- Custom-condition alerts → **BUILT** (`mkt alert`, spec §12). Edge-triggered: saved query → run on
  schedule → diff vs active `alert_hits` stints (append-only: departures close a stint, never
  delete it — the entry/exit history feeds forward-eval) → push only NEW entrants. Two kinds:
  `live` (a `screen --where` filter, run against the live scanner every 15m during market hours) and
  `panel` (a SQL query over `mkt.db`, run once/day after ingest). Both sinks: ntfy.sh (`MKT_NTFY_TOPIC`)
  + macOS banner. Definitions + state live in `mkt.db` (`alerts`, `alert_hits`).
  ```
  mkt alert add oversold --where 'RSI<30' --where 'market_cap_basic>1e9'   # live
  mkt alert add wakeup --sql "SELECT symbol FROM snapshots WHERE ..."      # panel
  mkt alert list | test <name> | rm <name> | check [--kind live|panel] [--dry-run]
  ```
  Scheduling: live → `com.user.mkt-alert.plist` (15m, `~/scripts/mkt-alert.sh` self-gates to
  09:30–16:15 ET); panel → appended to `mkt-record.sh` after ingest. Sinks (`src/notify.js`, best-effort):
  Telegram (`MKT_TG_TOKEN`+`MKT_TG_CHAT`, preferred — push + searchable history), ntfy (`MKT_NTFY_TOPIC`),
  macOS banner. **Set the env in the plist's EnvironmentVariables** (launchd doesn't inherit the shell).

## Trade-support (v1 — spec `../trading-experiments/docs/mkt-screens-spec.md`)
This is a swing system (daily bars, 15m delay irrelevant), EOD-first, human-in-the-loop: the CLI
signals, YOU trade + report fills, the CLI logs/tracks. Built so far:
- `mkt size --entry E --stop S [--account 6000] [--risk 1] [--max-pct 25] [--target T]` — risk-first
  sizing (you fix max loss; stop distance sets shares). Caps position at max-pct of account.
- `mkt watchlist add|put|rm|list` — hand-picked symbol sets (`watchlists`/`watchlist_members` tables).
  Scope a screen to one: `mkt screen --watchlist my-semis --where 'RSI<40'` (monitoring vs discovery).
Full vision (staged strategies, trade journal, strategy eval, exit/portfolio risk) documented in the
screens spec §7–§13; back half is v2+.

The SQLite query layer (Phase 2) is **built** — see "The recorder + DB" above. Deps are now
`ws` + `better-sqlite3`.

## Tests
`npm test` — bare `node --test` (a positional path is a glob in Node >=22, not a directory, so
`node --test test/` matches nothing and silently "passes"). CI runs it on every PR
(`.github/workflows/test.yml`); it needs `npm ci` because `bin/mkt.js` imports every command eagerly,
better-sqlite3 included.

`test/size-hints.test.js` asserts the **hint contract**: a *command-level* error hint is a command line
the user pastes back, so it must run. (Parser errors in `bin/mkt.js` are the deliberate exception — a
malformed argv has no command worth suggesting, so their hint is a flag *reference*, not a command.) Four distinct bugs hid in that gap (PR #8, five review rounds) — none
visible by reading the code, all trivial to catch by executing the hint. The suite spawns the real CLI
rather than importing `size()` for exactly that reason. Two tiers:
- **correctable input** (well-formed numbers that just don't size) → the hint is a *correction*, so it
  must carry the caller's flags forward. Exit-0-on-rerun is NOT sufficient here: dropping `--risk 100`
  from a target hint still exits 0, silently sizing at 1%. Flags are compared as sets (hint emits a
  fixed order) and every caller flag must survive or be raised, never lowered.
- **malformed input** → the hint is an *example* of the right shape; it only has to differ and run.

The suite clears the whole `MKT_*` namespace before spawning — `size` falls back to `$MKT_ACCOUNT`, and
the vars other commands read have *side effects*: an `alert` test would send real Telegram/ntfy pushes,
a `backup` test would write to someone's iCloud. `$HOME` is still owed by whoever adds the first
DB-touching case (it needs a temp dir, else the test opens the developer's real `~/.mkt/mkt.db`). Extend it whenever a command grows a hint; note the argv splitter is
whitespace-only, and hints elsewhere carry quoted expressions (`--where 'RSI < 30'`) that need a
quote-aware tokenizer first.

Full design spec: `../trading-experiments/docs/mkt-cli-spec.md`.
