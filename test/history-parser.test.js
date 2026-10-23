/**
 * History WS parser — the batched-envelope contract (issue #12).
 *
 * TradingView batches several `~m~<len>~m~<json>` envelopes into ONE WebSocket
 * message. The old parser treated a message as a single envelope, which produced
 * three data-integrity bugs. These tests pin the correct behavior against real
 * captured wire bytes (`test/fixtures/history-*.json`) plus one synthetic message
 * that reproduces the un-triggerable-live race: a heartbeat batched AHEAD of data.
 *
 * The parser is unit-testable because it is a pure seam — `createHistoryReader()`
 * consumes raw message strings and exposes the accumulated bars / completion /
 * error, with no WebSocket in sight.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { splitEnvelopes, classifyEnvelope, createHistoryReader } from '../src/providers/tradingview.js';

const FIX = path.resolve('test/fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

test('splitEnvelopes: one message splits into its batched envelopes', () => {
  const [, dataMsg] = load('history-ok.json');
  const envs = splitEnvelopes(dataMsg);
  // The data message carries series_loading + symbol_resolved OR timescale_update + series_completed.
  assert.ok(envs.length >= 2, `expected batched envelopes, got ${envs.length}`);
  const kinds = envs.map((e) => classifyEnvelope(e).kind);
  assert.ok(kinds.includes('timescale_update'));
  assert.ok(kinds.includes('series_completed'));
});

test('classifyEnvelope dispatches on the parsed `m` type, not raw substring', () => {
  assert.equal(classifyEnvelope('~h~7').kind, 'heartbeat');
  assert.equal(classifyEnvelope('{"m":"series_completed","p":[]}').kind, 'series_completed');
  assert.equal(classifyEnvelope('{"m":"series_error","p":[]}').kind, 'error');
  assert.equal(classifyEnvelope('{"m":"symbol_error","p":[]}').kind, 'error');
  assert.equal(classifyEnvelope('{"m":"du","p":[]}').kind, 'other');
  // A field VALUE containing "series_error" must NOT be misread as an error frame.
  assert.equal(classifyEnvelope('{"m":"symbol_resolved","p":["cs","sym",{"note":"series_error in url"}]}').kind, 'other');
  // Garbage never throws — it is reported as unparseable so siblings survive.
  assert.equal(classifyEnvelope('{not json').kind, 'unparseable');
});

test('happy path: real captured messages yield the full bar set on completion', () => {
  const msgs = load('history-ok.json');
  const reader = createHistoryReader();
  let completed = false;
  for (const m of msgs) { if (reader.push(m).completed) completed = true; }
  assert.equal(completed, true, 'series_completed must be observed');
  const bars = reader.bars();
  assert.equal(bars.length, 5);
  // OHLCV shape + ascending time.
  for (const b of bars) {
    for (const k of ['t', 'o', 'h', 'l', 'c', 'v']) assert.ok(k in b);
  }
  assert.ok(bars.every((b, i) => i === 0 || b.t > bars[i - 1].t));
});

test('BUG #1 fixed: a heartbeat batched AHEAD of data does not drop the trailing envelopes', () => {
  // The exact audited race: `~h~7` envelope, then the real timescale_update + series_completed,
  // all in ONE message. The old parser echoed the heartbeat and `return`ed, dropping the bars.
  const msgs = load('history-heartbeat-batched.json');
  const reader = createHistoryReader();
  let completed = false, echoed = 0;
  for (const m of msgs) {
    const ev = reader.push(m);
    echoed += ev.heartbeats.length;
    if (ev.completed) completed = true;
  }
  assert.equal(echoed, 1, 'the heartbeat is still echoed');
  assert.equal(completed, true, 'and the batched completion still lands');
  assert.equal(reader.bars().length, 5, 'and NO bars are dropped');
});

test('BUG #2 fixed: a malformed envelope does not drop its siblings in the same message', () => {
  const [, dataMsg] = load('history-ok.json');
  const envs = splitEnvelopes(dataMsg);
  // Rebuild the message with a corrupt envelope wedged in front of the good ones.
  const reframe = (payload) => `~m~${payload.length}~m~${payload}`;
  const poisoned = reframe('{ this is not json') + envs.map(reframe).join('');
  const reader = createHistoryReader();
  const ev = reader.push(poisoned);
  assert.equal(ev.completed, true, 'series_completed survives the bad sibling');
  assert.equal(reader.bars().length, 5, 'bars survive the bad sibling');
  // ...but the parse failure is NOT swallowed — it is counted so the caller can fail loud.
  assert.equal(reader.unparseable(), 1, 'the dropped envelope is retained, not silently ignored');
});

test('a completion arriving with an unparseable sibling is flagged so the caller can fail loud', () => {
  // Codex P1 / silent-truncation guard: an unparseable envelope + a valid series_completed
  // in one batch must NOT be trusted as a clean result — the bar set may be silently short.
  // The reader keeps parsing valid siblings (bug #2) but reports the drop; `_historyOnce`
  // then rejects as retryable `upstream` rather than resolving corrupt history at exit 0.
  const reader = createHistoryReader();
  const done = '{"m":"series_completed","p":[]}';
  const bad = '{ half a frame';
  const msg = `~m~${bad.length}~m~${bad}~m~${done.length}~m~${done}`;
  const ev = reader.push(msg);
  assert.equal(ev.completed, true, 'the completion is still observed');
  assert.equal(reader.unparseable(), 1, 'and the dropped sibling is reported, not hidden');
});

test('a clean response reports zero unparseable envelopes', () => {
  const msgs = load('history-ok.json');
  const reader = createHistoryReader();
  for (const m of msgs) reader.push(m);
  assert.equal(reader.unparseable(), 0, 'healthy wire data never trips the corrupt-frame guard');
});

test('BUG #3 fixed: a lone `du` tick frame does NOT resolve the request', () => {
  const reader = createHistoryReader();
  // A 1-bar live-tick `du` frame (what used to satisfy first-non-empty resolve).
  const du = '{"m":"du","p":["cs",{"sds_1":{"s":[{"i":9,"v":[9999,1,2,3,4,5]}]}}]}';
  const ev = reader.push(`~m~${du.length}~m~${du}`);
  assert.equal(ev.completed, false, 'a du frame never signals completion');
  assert.equal(ev.error, false);
});

test('error path: real symbol_error message is classified as an error', () => {
  const msgs = load('history-error.json');
  const reader = createHistoryReader();
  let errored = false;
  for (const m of msgs) { if (reader.push(m).error) errored = true; }
  assert.equal(errored, true);
});

test('multi-frame accumulation: bars from several timescale_update frames merge and dedup', () => {
  const reader = createHistoryReader();
  const tsu = (rows) => {
    const p = JSON.stringify({ m: 'timescale_update', p: ['cs', { sds_1: { s: rows.map((v, i) => ({ i, v })) } }] });
    return `~m~${p.length}~m~${p}`;
  };
  reader.push(tsu([[100, 1, 1, 1, 1, 1], [200, 2, 2, 2, 2, 2]]));
  reader.push(tsu([[200, 9, 9, 9, 9, 9], [300, 3, 3, 3, 3, 3]])); // ts 200 repeats → last wins
  const done = '{"m":"series_completed","p":[]}';
  const ev = reader.push(`~m~${done.length}~m~${done}`);
  assert.equal(ev.completed, true);
  const bars = reader.bars();
  assert.deepEqual(bars.map((b) => b.t), [100, 200, 300]);
  assert.equal(bars.find((b) => b.t === 200).o, 9, 'later frame overwrites the earlier bar at the same time');
});
