/**
 * Typed error the CLI maps to an exit code + hint (see src/output.js CODE_TO_EXIT).
 * Lives alone so pure-local commands (size, sql, watchlist) don't transitively import
 * `ws` via the provider just to throw a usage error.
 */
export class MktError extends Error {
  constructor(code, message, hint = null) {
    super(message);
    this.code = code;   // snake_case: usage, bad_filter, bad_column, not_found, upstream, conflict, ...
    this.hint = hint;   // executable command string or null
  }
}
