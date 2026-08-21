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
import { MktError } from '../errors.js';
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
  // Rows come back keyed by column name — the {s, d:[...]} wire shape stays inside this module.
  const rows = (json.data || []).map((r) => {
    const o = { symbol: r.s };
    columns.forEach((c, i) => { o[c] = r.d[i]; });
    return o;
  });
  return { total: json.totalCount ?? 0, rows };
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

// ---- batched-envelope parser (issue #12) -------------------------------------
// ONE WebSocket message is NOT one envelope: TV batches several `~m~<len>~m~<payload>`
// envelopes into a single message (an 11,505-bar reply arrived as one 1.27 MB message).
// These three helpers are the pure, WS-free seam so the batching is unit-testable.

/**
 * Split one raw WS message into its batched envelope payloads.
 * Splits on the `~m~<len>~m~` delimiter rather than trusting the byte length —
 * payloads carry UTF-8 (foreign exchange/company names) where a JS-char slice
 * would misalign. The leading empty split element is dropped.
 */
export function splitEnvelopes(raw) {
  return raw.split(/~m~\d+~m~/).filter((p) => p.length > 0);
}

/**
 * Classify a single envelope payload by DISPATCHING ON the parsed `m` type —
 * never a raw-substring match, which false-positives when a field value happens
 * to contain "series_error". Parsing is guarded so one bad envelope is reported
 * `unparseable` (siblings survive) instead of throwing out of the loop.
 */
export function classifyEnvelope(payload) {
  if (payload.startsWith('~h~')) return { kind: 'heartbeat', echo: payload };
  let obj;
  try { obj = JSON.parse(payload); } catch { return { kind: 'unparseable' }; }
  switch (obj?.m) {
    case 'timescale_update': {
      const series = obj?.p?.[1]?.sds_1?.s;
      return { kind: 'timescale_update', bars: Array.isArray(series) ? series : [] };
    }
    case 'series_completed': return { kind: 'series_completed' };
    case 'series_error':
    case 'symbol_error': return { kind: 'error' };
    default: return { kind: 'other', m: obj?.m };
  }
}

/**
 * Stateful reader that accumulates bars across the (possibly many) timescale_update
 * frames of a series load, keyed by bar time so repeats dedup (last write wins).
 * `push(raw)` processes one whole message and returns what happened in it:
 * `{ heartbeats, completed, error }`. Callers resolve ONLY when `completed` — never
 * on the first non-empty frame (a lone `du` live-tick must not satisfy the request).
 */
export function createHistoryReader() {
  const byTime = new Map();
  let unparseable = 0;   // cumulative count of envelopes that failed to parse
  return {
    push(raw) {
      const ev = { heartbeats: [], completed: false, error: false };
      for (const payload of splitEnvelopes(raw)) {
        const c = classifyEnvelope(payload);   // per-envelope guard lives inside classify
        switch (c.kind) {
          case 'heartbeat': ev.heartbeats.push(c.echo); break;
          case 'timescale_update':
            for (const b of c.bars) if (b && Array.isArray(b.v)) byTime.set(b.v[0], b.v);
            break;
          case 'series_completed': ev.completed = true; break;
          case 'error': ev.error = true; break;
          case 'unparseable': unparseable++; break;   // count it — never resolve a maybe-short set silently
          default: break;   // other → ignore, keep listening
        }
      }
      return ev;
    },
    // A parsed `series_completed` is only trustworthy if NO sibling failed to parse:
    // a dropped envelope means the bar set may be silently short, so the caller must
    // fail loud (and retry) rather than resolve a corrupt/partial history.
    unparseable() { return unparseable; },
    bars() {
      return [...byTime.keys()].sort((a, b) => a - b).map((t) => {
        const v = byTime.get(t);
        return { t: v[0], o: v[1], h: v[2], l: v[3], c: v[4], v: v[5] ?? null };
      });
    },
  };
}

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

    const reader = createHistoryReader();
    ws.on('message', (raw) => {
      const ev = reader.push(raw.toString());
      // Echo every heartbeat found — even ones batched ahead of real data in the
      // same message (the old parser returned here and dropped the trailing bars).
      // `.length` is a byte-accurate prefix here ONLY because a heartbeat (`~h~<digits>`)
      // is pure ASCII; do not reuse this char-length framing for a UTF-8 payload.
      for (const echo of ev.heartbeats) ws.send(`~m~${echo.length}~m~${echo}`);
      // Errors win over any partial bars accumulated so far — a bad symbol never completes.
      if (ev.error) {
        return finish(() => reject(new MktError('not_found',
          `Unknown or unresolvable symbol "${symbol}".`, `mkt search ${symbol.split(':').pop()} --json`)));
      }
      // Resolve ONLY on explicit completion — never the first non-empty frame.
      if (ev.completed) {
        // ...but a completion that arrived alongside an unparseable envelope may be
        // hiding a silently-short bar set. Fail loud as retryable `upstream` (transient
        // wire glitch self-heals across the 3 retries; persistent drift fails loud)
        // rather than emit maybe-corrupt history at exit 0.
        const dropped = reader.unparseable();
        if (dropped) {
          return finish(() => reject(new MktError('upstream',
            `Corrupt history frame for ${symbol}: ${dropped} unparseable envelope(s) — bar set may be incomplete.`,
            `mkt history ${symbol} --tf ${tf} --bars ${bars}`)));
        }
        return finish(() => resolve({ symbol, tf, bars: reader.bars() }));
      }
    });

    ws.on('error', (e) => finish(() => reject(new MktError('upstream', `WS error: ${e.message}`, null))));
  });
}
