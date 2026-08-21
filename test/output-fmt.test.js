import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printRows, printObject } from '../src/output.js';

// Table mode must never render a NON-ZERO number as "0" (issue #14). The human formatter rounds to
// four decimals, so any value with |x| < 5e-5 collapsed to 0 — exit 0, plausible-looking, wrong, and
// for sub-penny tickers it silently poisoned size/target/stop and screening. The machine paths
// (--json / --compact) serialize the raw number and must stay byte-identical.
//
// Tested through the public printers (fmt is private) by capturing stdout: the contract is what the
// user sees, not the helper's signature.
function capture(fn) {
  const orig = process.stdout.write;
  let out = '';
  process.stdout.write = (s) => { out += s; return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return out;
}

const objLine = (obj) => capture(() => printObject(obj));

test('sub-1e-4 values never collapse to 0 in table mode', () => {
  assert.equal(objLine({ close: 0.000001 }), 'close: 0.000001\n');
  assert.equal(objLine({ close: 0.00003 }), 'close: 0.00003\n');
  assert.equal(objLine({ close: -0.000001 }), 'close: -0.000001\n');
});

test('ordinary-magnitude decimals format byte-identically to today', () => {
  assert.equal(objLine({ a: 1.23456 }), 'a: 1.2346\n');   // rounds to 4 decimals, unchanged
  assert.equal(objLine({ a: 123.4 }), 'a: 123.4\n');
  assert.equal(objLine({ a: 0.0001 }), 'a: 0.0001\n');    // at the threshold: already non-zero
  assert.equal(objLine({ a: 0.00007 }), 'a: 0.0001\n');   // rounds up to 0.0001, non-zero, unchanged
});

test('integers, null/undefined, arrays, and strings format byte-identically to today', () => {
  assert.equal(objLine({ a: 42 }), 'a: 42\n');
  assert.equal(objLine({ a: 0 }), 'a: 0\n');
  assert.equal(objLine({ a: null }), 'a: \n');
  assert.equal(objLine({ a: undefined }), 'a: \n');
  assert.equal(objLine({ a: ['x', 'y'] }), 'a: x,y\n');
  assert.equal(objLine({ a: 'hello' }), 'a: hello\n');
});

test('--json and --compact carry raw precision, byte-identical to today', () => {
  const row = { close: 0.000001, name: 'DECN' };
  assert.equal(capture(() => printRows([row], { json: true })), JSON.stringify(row) + '\n');
  assert.equal(capture(() => printRows([row], { compact: true })), JSON.stringify(row) + '\n');
  assert.equal(capture(() => printObject(row, { json: true })), JSON.stringify(row, null, 2) + '\n');
  assert.equal(capture(() => printObject(row, { compact: true })), JSON.stringify(row) + '\n');
});

test('table rows keep sub-1e-4 values non-zero and align to the widened cell', () => {
  // Capturing stdout is non-TTY, so printRows leaves the header un-bolded and column widths are stable.
  const out = capture(() => printRows([{ symbol: 'DECN', close: 0.000001 }]));
  const lines = out.split('\n');
  assert.match(lines[1], /^DECN\s+0\.000001$/);
});
