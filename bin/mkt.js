#!/usr/bin/env node
/**
 * mkt — agent-first CLI for TradingView market + macro data.
 * Router + global flags. Each command lives in src/commands/*.
 */
import { printError } from '../src/output.js';
import { MktError } from '../src/providers/tradingview.js';

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

// Flags that consume the next token as a value; everything else is boolean. --where repeats.
const VALUE_FLAGS = new Set(['region', 'columns', 'sort', 'limit', 'tf', 'bars', 'category', 'search', 'type', 'out', 'sql', 'kind',
  'entry', 'stop', 'account', 'risk', 'max-pct', 'target', 'watchlist', 'to']);
const REPEATABLE = new Set(['where']);

function parse(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2), val = true;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else if (VALUE_FLAGS.has(key) || REPEATABLE.has(key)) { val = argv[++i]; }
      if (REPEATABLE.has(key)) (flags[key] ||= []).push(val);
      else flags[key] = val;
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (const ch of a.slice(1)) flags[{ j: 'json', c: 'compact', q: 'quiet', v: 'verbose', h: 'help' }[ch] || ch] = true;
    } else positionals.push(a);
  }
  return { positionals, flags };
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
  ingest    Load snapshots into ~/.mkt/mkt.db (SQLite); --prune drops gz >30d after verify
  backup    Mirror gz archive + a consistent DB dump to durable storage (default iCloud) [--to DIR]
  sql       Query the panel:     mkt sql "SELECT symbol,RSI FROM snapshots WHERE RSI<30"
  alert     Edge-triggered alerts: add <name> --where '<expr>' (live) | --sql "<SELECT>" (panel)
            list · rm <name> · test <name> · check [--kind live|panel] [--dry-run]
  size      Risk-first sizing:   mkt size --entry 50 --stop 47 [--account 6000] [--risk 1] [--target 56]
  watchlist Hand-picked sets:    add <name> · put <name> SYM… · rm <name> [SYM…] · list [<name>]
            scope a screen to one: mkt screen --watchlist my-semis --where 'RSI<40'

GLOBAL  --json (NDJSON lists) · --compact · -q/--quiet · -v/--verbose · --no-color · --version
FILTER  RSI < 30 · close > SMA200 (col-vs-col) · RSI between 55,72 · typespecs has common · RSI|60 < 30 (intraday)
Data delayed ~15m (free). Not affiliated with TradingView. Undocumented endpoints — may break.`;

async function main() {
  const argv = process.argv.slice(2);
  const { positionals, flags } = parse(argv);
  const cmd = positionals.shift();

  if (flags.version) { process.stdout.write(VERSION + '\n'); return 0; }
  if (!cmd || flags.help && !cmd || cmd === 'help') { process.stdout.write(HELP + '\n'); return 0; }
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
