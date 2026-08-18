# The hint contract

Read this before touching any command's error hints, or before extending
`test/size-hints.test.js`.

`test/size-hints.test.js` asserts the **hint contract**: a *command-level* error hint is a command
line the user pastes back, so it must run. (Parser errors in `bin/mkt.js` are the deliberate
exception — a malformed argv has no command worth suggesting, so their hint is a flag *reference*,
not a command.) Four distinct bugs hid in that gap (PR #8, five review rounds) — none visible by
reading the code, all trivial to catch by executing the hint. The suite spawns the real CLI rather
than importing `size()` for exactly that reason.

## Three tiers

- **correctable input** (well-formed numbers that just don't size) → the hint is a *correction* and is
  **fully explicit**: it spells out every resolved flag, never omitting one "at its default". Omission
  was the root of most of PR #8/#10's bugs — each omitted flag needs a local copy of its default to
  compare against, the copies diverge (a literal `6000` vs the real `$MKT_ACCOUNT || 6000`), and an
  omitted flag is indistinguishable from an accidentally dropped one. Caller flags must come back equal
  or raised, never lowered; exit-0-on-rerun alone is NOT sufficient (dropping `--risk 100` still exits
  0, silently sizing at 1%).
- **malformed input** → the hint is an *example* of the right shape; it only has to differ and run.
  A well-formed input can also cross into this tier *at runtime* when no suggested account/risk/cap
  sizes a share (`NO_FIX` in `size.js` — e.g. a denormal `--risk` overflows every candidate account to
  Infinity). Inputs where no correction can exist are listed in the INVALID tier; a FAILING row that
  crosses is a trip-wire failure naming the downgrade, never a silent pass at the weaker contract.
- **the grid** — a fixed sweep asserting only that a hint runs. Weaker than the first tier by design,
  but it covers inputs nobody wrote down: the two `ceil()` rounding bugs came out of a 37,496-input
  sweep at a 0.6% hit rate, which no hand-picked list converges on. The full sweep is ~30 minutes of
  spawns, hence a deterministic grid of the same shape.

## Extending it

`size-hints`'s own argv splitter is whitespace-only, so it cannot execute a hint carrying a quoted
expression (`--where 'RSI < 30'`). That gap is now closed elsewhere: `test/ingest-resilience.test.js`
ships a quote-aware `splitHint`, and asserts the resulting command actually runs. Reuse it — or lift
it somewhere shared — rather than writing a third splitter.
