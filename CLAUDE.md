# mkt — project instructions

Agent-first CLI that extracts TradingView market + macro data as JSON. Standalone Node ESM;
`ws` + `better-sqlite3` are the only runtime deps. No login, no GUI, data delayed ~15m. Replaces
the old tradingview-mcp server / `tv` CLI+skill (that approach drove a live chart via CDP; this one
is stateless HTTP/WS).

## Two data sources (undocumented; all wire formats isolated in `src/providers/tradingview.js`)
- **Scanner REST** `POST scanner.tradingview.com/{region}/scan` — cross-sectional snapshot. 8 regions,
  3,771 fields. Fetch specific tickers via `symbols.tickers`. `range:[0,0]` → HTTP 400, use `[0,1]`.
- **History WS** `wss://data.tradingview.com/socket.io/websocket` + public `unauthorized_user_token`
  — temporal OHLCV, any symbol, no bar cap. Intermittently flaky → `history()` retries 3× on upstream
  errors, never on `not_found` (a `symbol_error` frame is deterministic, ~1.1s fast-fail).

## Commands, filter language, exit codes
Run as `node bin/mkt.js <cmd>`, or `mkt` after `npm link`. The command table, the `--where`
mini-language, and the exit-code list have ONE home — the README:

@README.md

Only what the README does not carry:
- `--liquid`: prepends the real-US-stock floor (common, >$1B cap, >$5, >500k vol). Use on `america`;
  no-op on forex/crypto/econ. Without it, `screen` surfaces penny/OTC base-effect junk.
- Column typos are validated against `/metainfo` BEFORE the scan (the scanner returns null, not an
  error, for unknown columns).
- Exit `1` = generic/partial (an `alert check` with one errored alert — the healthy alerts still
  ran). Exit `7` = conflict (duplicate resource, or `record` refusing pre-close/holiday — nothing
  written). The full map is `CODE_TO_EXIT` in `src/output.js`.
- Scope a screen to a watchlist: `mkt screen --watchlist my-semis --where 'RSI<40'`.
- **Flag position matters.** The command is the first bare token; boolean global flags may precede
  it, command flags may not — a value flag before the command name swallows it. `mkt screen --region
  america` works; `mkt --region america screen` mis-parses. The per-command flag registry is `SPEC`
  in `bin/mkt.js` (`value`/`repeat`/`bool` arrays); a flag missing from it parses as boolean and its
  value leaks into positionals.

## The recorder + DB + scheduling (the point of the project)
Daily screener data is **unrecoverable** — the scanner has no "as of last week". `mkt record` appends
a wide (~74-field) gzipped snapshot of the whole universe to
`~/.mkt/snapshots/<region>/<YYYY-MM-DD>.ndjson.gz` (~12 MB/day america). Idempotent; read with
`gzcat file | jq`. Record dates use exchange-tz trading dates (`src/tzdate.js`), not naive UTC.
The `WIDE` field list lives in `src/schema.js` — single source of truth shared by the recorder and
the DB schema; add a field there and both the next record and the next ingest pick it up.
**`region` is the one exception — it is NOT in `WIDE`** and must not be added: it is DB-side
provenance, stamped by `ingest.js` from the archive directory name and special-cased onto the
migration path in `db.js`. "Fixing" the omission breaks the migration.
`record` has two `conflict` (exit 7) guards: the NY-close clock check, and a holiday-staleness check
(>99% of closes identical to the newest recorded day across ≥100 symbols → refuse, rather than write
a phantom session). Both name `--force` in their hints; it disables both.

**The panel = SQLite (Phase 2, built).** `mkt ingest` loads the gz snapshots into `~/.mkt/mkt.db`,
one `snapshots(date, symbol, region, …74 cols)` table, PK `(date,symbol)`, plus two indexes:
`(symbol,date)` and `(region,date)` — the latter keeps ingest's `MAX(date) WHERE region=?`
high-water-mark query off a full table scan every night. Idempotent upsert. Incremental by default:
files ≥ the region's newest ingested date replay (`≥` not `>`, because `record` replaces today's
file on every run, so today must be re-absorbed), **plus any older archive date missing from the
DB** — a corrupt day is retried until repaired rather than becoming a permanent silent hole;
`--all` = full rebuild). Schema auto-migrates: a new field in `schema.js` → `ALTER TABLE ADD COLUMN`
on next ingest (old rows NULL).
Data failures notify by default; `--no-notify` lets the scheduled wrapper own the single alert.
That wrapper treats ingest's partial exit as non-fatal and always continues to backup + panel alerts,
so a repeatedly corrupt day stays loud without wedging the durable mirror. For gzip-stream rot,
`backup` preserves an existing good mirror and prints the restore command; it does not validate
individual JSON records inside an otherwise valid gzip stream.
Query with `mkt sql "<SELECT>"` — a **read-only** connection (writes fail at the driver), NDJSON out.
Bad SQL / unknown column → exit 2 with a hint. **Only snapshots are stored** — temporal price stays
on-demand via `mkt history` (bars are recoverable from the WS any time, so caching them buys speed
not durability; not worth it — see spec §9b). Each daily snapshot already *is* a daily bar + the
rest of the ~74 `WIDE` fields, so daily-resolution temporal analysis is a `snapshots` self-join, no
bars needed.

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
NY-close freshness guard). The wrapper runs `record` → `ingest` **per region, inside the loop**, then
`backup` → `alert check --kind panel` **once, after the loop** — not per region. Add regions by
editing `REGIONS` in the wrapper. Logs: `~/scripts/logs/mkt-record/`.

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
  its value scales with recorded history, and the panel is nearly empty (recording started 2026-08-14;
  2 sessions on disk as of 2026-08-18). Revisit once there's a meaningful depth of snapshots.
- Custom-condition alerts → **BUILT** (`mkt alert`, spec §12). Edge-triggered: saved query → run on
  schedule → diff vs active `alert_hits` stints (append-only: departures close a stint, never
  delete it — the entry/exit history feeds forward-eval) → push only NEW entrants. Two kinds:
  `live` (a `screen --where` filter, run against the live scanner every 15m during market hours) and
  `panel` (a SQL query over `mkt.db`, run once/day after ingest). Definitions + state live in
  `mkt.db` (`alerts`, `alert_hits`); both kinds fan out to all three sinks (below).
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

## Tests
`npm test` — bare `node --test` (a positional path is a glob in Node >=22, not a directory, so
`node --test test/` matches nothing and silently "passes"). CI runs it on every PR
(`.github/workflows/test.yml`); it needs `npm ci` because `bin/mkt.js` imports every command eagerly,
better-sqlite3 included. `package.json` pins `engines: node >=22` — 22 for those discovery
semantics, and because `record`'s durability rests on `createWriteStream`'s `flush` option, which
Node < 20.10 silently ignores (no fsync, no error).

Six suites: `size-hints` (the hint contract — see `docs/hint-contract.md`), `ingest-resilience`
(corrupt-file continuation, retry visibility, partial-success output, offsets, notification
ownership, and prune safety), `record-staged-write` (record's
stage→fsync→rename durability: SIGKILL mid-write, concurrent writers, typed error paths — the crash
cases spawn a real child process), `backup-sweep` (backup collects day-old staged tmps from the
source archive and touches nothing else; end-to-end through the real CLI: ingest → backup),
`output-fmt` (the human table formatter never renders a non-zero number as `0` — sub-$0.0001 tickers
kept non-zero via significant figures — while integers, null, arrays, strings, ordinary decimals, and
the `--json`/`--compact` paths stay byte-identical; drives the public `printRows`/`printObject`), and
`notify-redaction` (both notify sinks keep their credential — the Telegram bot token and the ntfy
topic — off curl's argv by feeding the token-bearing URL through a `--config -` stdin file, and the
shared runner scrubs every registered secret from a failed child's diagnostic, message and cmd, before
it reaches a log; also asserts ntfy's Title header is CR/LF-sanitised against header injection).

`test/size-hints.test.js` asserts the **hint contract** — a command-level error hint must be a
command line that actually runs, so the suite spawns the real CLI rather than importing `size()`.
Full rationale (the three tiers, `NO_FIX`, why four bugs hid there across five review rounds):
`docs/hint-contract.md`. Read it before touching any hint.

The suite clears the whole `MKT_*` namespace before spawning — `size` falls back to `$MKT_ACCOUNT`, and
the vars other commands read have *side effects*: an `alert` test would send real Telegram/ntfy pushes,
a `backup` test would write to someone's iCloud. The old "`$HOME` is owed by the first DB-touching
case" debt is settled by `backup-sweep.test.js`, and the mechanism is `$MKT_HOME`, not `$HOME`: it
is the one knob every path resolver honours — five of them, `db.js`, `ingest.js`, `record.js`,
`backup.js`, and `providers/tradingview.js` (the `$MKT_HOME/meta` metainfo cache) — so a temp
`MKT_HOME` isolates the DB, the archive *and* the column cache in one move. Copy that pattern for
any new DB-touching test.

Two test traps: `mkt sql` opens read-only but is **not** side-effect-free — on a missing DB file
`openDb` creates and migrates it through a throwaway writable handle first, so a "read-only query"
on a fresh `MKT_HOME` writes a 0-row DB to disk. And the metainfo cache refreshes only weekly, so
column validation can pass or fail against a stale catalog.

Extend the suite whenever a command grows a hint.

Full design spec: `../trading-experiments/docs/mkt-cli-spec.md`.

## Repo etiquette
Work lands via PR against `main`, merged as `Merge PR #N: <subject>`. Commit subjects are
conventional with a scope where one applies: `fix(record):`, `docs:`, `ci:`, `test:`, `review:`.
Three workflows run on every PR — `test.yml` (`npm ci` + `npm test`), `claude.yml`, and
`claude-code-review.yml`; the review agent gates merges (PR #8 took five rounds). Never merge
without explicit instruction.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `gupsammy/mkt-cli`, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`) — a state axis orthogonal to the existing
`severity:*` and area labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root, both created lazily. See `docs/agents/domain.md`.
