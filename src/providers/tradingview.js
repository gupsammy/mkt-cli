/**
 * TradingView provider — the ONLY module that knows TradingView's (undocumented)
 * wire formats. Isolated on purpose: if TV changes an endpoint or frame shape, the
 * fix is here, not scattered. Nothing above this layer imports `ws` or builds URLs.
 *
 *   scanner REST   POST https://scanner.tradingview.com/{region}/scan     (no auth, delayed)
 *   metainfo REST  GET  https://scanner.tradingview.com/{region}/metainfo
 *   symbol search  GET  https://symbol-search.tradingview.com/symbol_search/?text=
 *   history WS     wss://data.tradingview.com/socket.io/websocket  + unauthorized_user_token
 */
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SCANNER = 'https://scanner.tradingview.com';
const SEARCH = 'https://symbol-search.tradingview.com/symbol_search/';
const WS_URL = 'wss://data.tradingview.com/socket.io/websocket';
// Public constant used by the charting library for delayed, unauthenticated data.
// NOT a user secret — tied to no account. TV can revoke it unilaterally (see spec §10.5).
const ANON_TOKEN = 'unauthorized_user_token';

// 'index' is intentionally omitted — that scanner path 404s; indices live under other regions.
export const REGIONS = ['america', 'forex', 'crypto', 'futures', 'bond', 'cfd', 'coin', 'economics2'];

// Meta-columns the scanner always accepts but that are absent from /metainfo.
export const META_COLUMNS = new Set(['name', 'description']);

/** Typed error the CLI maps to an exit code + hint. */
export class MktError extends Error {
  constructor(code, message, hint = null) {
    super(message);
    this.code = code;   // snake_case: unknown_symbol, bad_column, upstream, ...
    this.hint = hint;   // executable command string or null
  }
}

// ---------------------------------------------------------------- scanner REST

export async function scan({ region = 'america', columns, filter, filter2, sort, range = [0, 50], symbols }) {
  const body = { columns, range, markets: [region] };
  if (symbols) body.symbols = { tickers: symbols };   // fetch specific tickers (quote)
  if (filter) body.filter = filter;
  if (filter2) body.filter2 = filter2;
  if (sort) body.sort = sort;
  let res;
  try {
    res = await fetch(`${SCANNER}/${region}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new MktError('upstream', `Scanner unreachable: ${e.message}`, null);
  }
  if (res.status === 404) throw new MktError('not_found', `Unknown region "${region}".`, 'mkt regions --json');
  if (!res.ok) throw new MktError('upstream', `Scanner HTTP ${res.status} ${res.statusText}`, null);
  const json = await res.json();
  return { total: json.totalCount ?? 0, rows: json.data || [] };
}

// metainfo, cached to disk (refresh weekly) so column validation is ~free after first run.
const CACHE_DIR = path.join(process.env.MKT_HOME || path.join(os.homedir(), '.mkt'), 'meta');
const WEEK_MS = 7 * 864e5;

export async function metainfo(region = 'america') {
  const file = path.join(CACHE_DIR, `${region}.json`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < WEEK_MS) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* miss → fetch */ }
  let res;
  try {
    res = await fetch(`${SCANNER}/${region}/metainfo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  } catch (e) {
    throw new MktError('upstream', `Metainfo unreachable: ${e.message}`, null);
  }
  if (!res.ok) throw new MktError('upstream', `Metainfo HTTP ${res.status}`, null);
  const json = await res.json();
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(json)); } catch { /* cache best-effort */ }
  return json;
}

/** Set of valid column base-names for a region (for D2 validation). */
export async function fieldSet(region = 'america') {
  const meta = await metainfo(region);
  const set = new Set((meta.fields || []).map((f) => f.n));
  for (const c of META_COLUMNS) set.add(c);
  return set;
}

// ---------------------------------------------------------------- symbol search

export async function search({ text, type = '', region = '' }) {
  const url = `${SEARCH}?text=${encodeURIComponent(text)}&type=${encodeURIComponent(type)}&exchange=${encodeURIComponent(region)}`;
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://www.tradingview.com' } }); }
  catch (e) { throw new MktError('upstream', `Symbol search unreachable: ${e.message}`, null); }
  if (!res.ok) throw new MktError('upstream', `Symbol search HTTP ${res.status}`, null);
  const raw = await res.json();
  // D5: the API's `symbol` field is bare ("AAPL"); synthesize exchange:symbol so the result
  // feeds straight back into `mkt history` without re-failing.
  return (Array.isArray(raw) ? raw : []).map((r) => {
    const bare = (r.symbol || '').replace(/<\/?em>/g, '');
    const exch = r.exchange || r.source_id || '';
    return {
      symbol: exch ? `${exch}:${bare}` : bare,
      ticker: bare,
      exchange: exch,
      description: (r.description || '').replace(/<\/?em>/g, ''),
      type: r.type || '',
    };
  });
}

// ---------------------------------------------------------------- history WS

const frame = (m, p) => { const s = JSON.stringify({ m, p }); return `~m~${s.length}~m~${s}`; };
const rid = (pre) => pre + Math.random().toString(36).slice(2, 10);

/**
 * Pull `bars` OHLCV bars for `symbol` at timeframe `tf`. Resolves { symbol, tf, bars: [...] }.
 * D1: a `symbol_error`/`series_error` frame (~1.1s) rejects immediately as not_found — no 12s wait.
 */
/**
 * Public history: retries the WS on transient upstream failures (connection/timeout),
 * which do happen intermittently. Never retries not_found — a symbol_error is deterministic.
 */
export async function history(opts) {
  const attempts = opts.attempts ?? 3;
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await _historyOnce(opts); }
    catch (e) {
      if (e instanceof MktError && e.code === 'not_found') throw e;   // deterministic — don't retry
      last = e;
    }
  }
  throw last;
}

function _historyOnce({ symbol, tf = '1D', bars = 300, timeoutMs = 12000 }) {
  return new Promise((resolve, reject) => {
    const cs = rid('cs_');
    let ws, settled = false;
    const timer = setTimeout(() => finish(() => reject(new MktError('upstream',
      `No bars for ${symbol} within ${timeoutMs}ms.`, `mkt history ${symbol} --tf ${tf} --bars ${bars}`))), timeoutMs);

    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} fn(); };

    try { ws = new WebSocket(WS_URL, { headers: { Origin: 'https://www.tradingview.com' } }); }
    catch (e) { clearTimeout(timer); return reject(new MktError('upstream', `WS connect failed: ${e.message}`, null)); }

    ws.on('open', () => {
      ws.send(frame('set_auth_token', [ANON_TOKEN]));
      ws.send(frame('chart_create_session', [cs, '']));
      ws.send(frame('resolve_symbol', [cs, 'sym_1', `=${JSON.stringify({ symbol, adjustment: 'splits' })}`]));
      ws.send(frame('create_series', [cs, 'sds_1', 's1', 'sym_1', tf, bars, '']));
    });

    ws.on('message', (raw) => {
      const data = raw.toString();
      const hb = data.match(/~m~\d+~m~(~h~\d+)/);
      if (hb) { ws.send(`~m~${hb[1].length}~m~${hb[1]}`); return; }        // echo heartbeat

      if (data.includes('symbol_error') || data.includes('series_error')) {
        return finish(() => reject(new MktError('not_found',
          `Unknown or unresolvable symbol "${symbol}".`, `mkt search ${symbol.split(':').pop()} --json`)));
      }
      if (data.includes('timescale_update') || data.includes('"sds_1"')) {
        try {
          for (const j of data.split(/~m~\d+~m~/).filter((x) => x.startsWith('{'))) {
            const obj = JSON.parse(j);
            const series = obj?.p?.[1]?.sds_1?.s;
            if (Array.isArray(series) && series.length) {
              const out = series.map((b) => ({ t: b.v[0], o: b.v[1], h: b.v[2], l: b.v[3], c: b.v[4], v: b.v[5] ?? null }));
              return finish(() => resolve({ symbol, tf, bars: out }));
            }
          }
        } catch { /* partial frame — keep listening */ }
      }
    });

    ws.on('error', (e) => finish(() => reject(new MktError('upstream', `WS error: ${e.message}`, null))));
  });
}
