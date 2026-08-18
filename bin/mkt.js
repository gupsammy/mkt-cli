#!/usr/bin/env node
/**
 * mkt — agent-first CLI for TradingView market + macro data.
 * Router + strict flag parsing. Each command lives in src/commands/*.
 */
import { printError } from '../src/output.js';
import { MktError } from '../src/errors.js';

import screen from '../src/commands/screen.js';
import history from '../src/commands/history.js';
import quote from '../src/commands/quote.js';
import search from '../src/commands/search.js';
import fields from '../src/commands/fields.js';
import regions from '../src/commands/regions.js';
import record from '../src/commands/record.js';
import ingest from '../src/commands/ingest.js';
import sql from '../src/commands/sql.js';
import alert from '../src/commands/alert.js';
import size from '../src/commands/size.js';
import watchlist from '../src/commands/watchlist.js';
import backup from '../src/commands/backup.js';

const COMMANDS = { screen, history, quote, search, fields, regions, record, ingest, sql, alert, size, watchlist, backup };
const VERSION = '0.1.0';

// Per-command flag contract. Anything not declared here (or global) is rejected: a typo'd flag
// must fail loudly, not silently become boolean `true` while its value leaks into positionals —
// unacceptable once flags carry money numbers (`mkt size --entry`, the future `mkt trade`).
const GLOBAL = new Set(['json', 'compact', 'quiet', 'verbose', 'help', 'version', 'no-color']);
const SHORT = { j: 'json', c: 'compact', q: 'quiet', v: 'verbose', h: 'help' };
const SPEC = {
  screen:    { value: ['region', 'columns', 'sort', 'limit', 'watchlist'], repeat: ['where'], bool: ['liquid'] },
  history:   { value: ['tf', 'bars'] },
  quote:     { value: ['region'] },
  search:    { value: ['type', 'region'] },
  fields:    { value: ['region', 'category', 'search'] },
  regions:   {},
  record:    { value: ['region', 'columns'], bool: ['force'] },
  ingest:    { value: ['region'], bool: ['all', 'prune'] },
  sql:       {},
  alert:     { value: ['region', 'kind', 'sql'], repeat: ['where'], bool: ['dry-run'] },
  size:      { value: ['entry', 'stop', 'account', 'risk', 'max-pct', 'target'] },
  watchlist: { value: ['kind'] },
  backup:    { value: ['to'] },
};

// The command is the first bare token — global flags (all boolean, so they consume nothing) may
// precede it; command flags may not, since a value flag there would swallow the command name.
// An unknown command parses loose so "Unknown command" wins over any flag complaint.
function parse(argv) {
  const cmdIdx = argv.findIndex((a) => !a.startsWith('-') || /^-\d/.test(a));
  const cmd = cmdIdx >= 0 ? argv[cmdIdx] : undefined;
  const spec = cmd != null && Object.hasOwn(SPEC, cmd) ? SPEC[cmd] : null;
  const value = new Set(spec?.value || []);
  const repeat = new Set(spec?.repeat || []);
  const local = new Set([...(spec?.bool || []), ...value, ...repeat]);
  const usage = (msg) => {
    const valid = [...local].map((f) => '--' + f).sort().join(' ') || '(none)';
    throw new MktError('usage', msg, `${cmd} flags: ${valid}  (global: --json --compact -q -v -h)`);
  };

  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (i === cmdIdx) continue;
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2), val = true;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      if (spec) {
        if (!local.has(key) && !GLOBAL.has(key)) usage(`Unknown flag --${key} for "${cmd}".`);
        if (eq >= 0 && !value.has(key) && !repeat.has(key)) usage(`--${key} takes no value.`);
        if (eq < 0 && (value.has(key) || repeat.has(key))) {
          // A following `--flag` is a missing value, not a value: `backup --to --quiet` must not
          // create a directory named "--quiet" and report a durable backup that never left cwd.
          // Only `--` is rejected — a single dash stays a value (`--sort -change` is documented).
          if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) usage(`--${key} needs a value.`);
          val = argv[++i];
        }
      }
      if (repeat.has(key)) (flags[key] ||= []).push(val);
      else flags[key] = val;
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (const ch of a.slice(1)) {
        if (!SHORT[ch]) { if (spec) usage(`Unknown flag -${ch}.`); flags[ch] = true; continue; }
        flags[SHORT[ch]] = true;
      }
    } else positionals.push(a);
  }
  return { cmd, positionals, flags };
}

const HELP = `mkt — extract TradingView market + macro data as JSON.

USAGE  mkt [--json|--compact] <command> [args]

COMMANDS
  screen    Filter a universe: --where '<expr>' (repeatable, AND) --columns a,b --sort -col --limit n --region R
            --liquid = real US stocks only (common, >$1B cap, >$5, >500k vol; excludes penny/OTC junk)
  history   OHLCV series:       mkt history NASDAQ:AAPL --tf 1D --bars 300
  quote     Latest row(s):      mkt quote NASDAQ:AAPL NASDAQ:MSFT
  search    Resolve symbols:    mkt search apple
  fields    Column catalog:     mkt fields --category technicals --search rsi
  regions   List universes:     mkt regions
  record    Append daily snapshot to ~/.mkt/snapshots/<region>/<date>.ndjson.gz
            (refuses pre-close NY time — would mislabel the previous session; --force overrides)
  ingest    Load NEW snapshots into ~/.mkt/mkt.db (incremental; --all = full replay;
            --prune deprecated, implies --all — re-reads the whole archive)
  backup    Mirror gz archive + a consistent DB dump to durable storage (default iCloud) [--to DIR]
  sql       Query the panel:     mkt sql "SELECT symbol,RSI FROM snapshots WHERE RSI<30"
  alert     Edge-triggered alerts: add <name> --where '<expr>' (live) | --sql "<SELECT>" (panel)
            list · rm <name> · test <name> · check [--kind live|panel] [--dry-run]
  size      Risk-first sizing:   mkt size --entry 50 --stop 47 [--account 6000] [--risk 1] [--target 56]
  watchlist Hand-picked sets:    add <name> · put <name> SYM… · rm <name> [SYM…] · list [<name>]
            scope a screen to one: mkt screen --watchlist my-semis --where 'RSI<40'

GLOBAL  --json (NDJSON lists) · --compact · -q/--quiet · -v/--verbose · --no-color · --version
        Flags are strict: an undeclared flag is a usage error (exit 2), never silently boolean.
FILTER  RSI < 30 · close > SMA200 (col-vs-col) · RSI between 55,72 · typespecs has common · RSI|60 < 30 (intraday)
Data delayed ~15m (free). Not affiliated with TradingView. Undocumented endpoints — may break.`;

async function main() {
  const argv = process.argv.slice(2);
  const jsonish = argv.some((a) => a === '--json' || a === '--compact' || a === '-j' || a === '-c');
  let cmd, positionals, flags;
  try { ({ cmd, positionals, flags } = parse(argv)); }
  catch (err) { return printError(err, { json: jsonish }); }

  if (flags['no-color']) process.env.NO_COLOR = '1';   // output.js reads the env; wire the flag to it
  if (flags.version) { process.stdout.write(VERSION + '\n'); return 0; }
  if (!cmd || cmd === 'help') { process.stdout.write(HELP + '\n'); return 0; }
  if (!COMMANDS[cmd]) {
    return printError(new MktError('usage', `Unknown command "${cmd}".`, 'mkt help'), { json: flags.json });
  }
  if (flags.help) { process.stdout.write(HELP + '\n'); return 0; }

  try {
    return (await COMMANDS[cmd]({ positionals, flags })) ?? 0;
  } catch (err) {
    if (err instanceof MktError) return printError(err, { json: flags.json || flags.compact });
    return printError(new MktError('generic', err.message, null), { json: flags.json || flags.compact });
  }
}

process.exit(await main());
