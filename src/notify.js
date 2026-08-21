import { execFile } from 'node:child_process';

// Push to every configured sink (spec §6): Telegram (push + searchable history + two-way, if a bot
// token/chat is set), ntfy.sh (if a topic is set), and a native macOS banner (always). Best-effort —
// a sink failure is logged to stderr, never throws, so one dead sink can't abort an alert run.
//
// Returns a delivery tally so callers can tell "reached someone" from "reached no one" (issue #16):
//   { delivered, failed, attempted }   attempted = delivered + failed  (skipped sinks excluded).
// A sink is 'skipped' when it is unconfigured (opt-in Telegram/ntfy with no env), or when the
// always-on banner's binary is absent off a Mac (see the per-sink rule below) — that is NOT a
// failure, so a banner-only Mac still reports delivered:1. `attempted > 0 && delivered === 0` is a
// TOTAL delivery failure: nothing reached anyone, and the alert check withholds the hit so it retries.
export async function notify(title, body) {
  const outcomes = await Promise.all([telegram(title, body), ntfy(title, body), macBanner(title, body)]);
  const delivered = outcomes.filter((o) => o === 'delivered').length;
  const failed = outcomes.filter((o) => o === 'failed').length;
  return { delivered, failed, attempted: delivered + failed };
}

// Each sink resolves to one of 'delivered' | 'failed' | 'skipped'. Failures still log to stderr (as
// before) but are now also reported to the caller instead of being silently swallowed.
//   The distinction that matters is CONFIGURED vs NOT, not the errno. macBanner is the always-on
//   sink, but only ON a Mac: off a Mac its binary is absent (execFile ENOENT), meaning "no banner
//   here", not "delivery failed" — so there it's 'skipped' (absentIsSkip). Counting that as a failure
//   would wedge alert state on any non-Mac host (permanent total-failure → every hit withheld
//   forever). ON a Mac the banner IS a real expected sink, so a missing `osascript` (e.g. a broken
//   launchd PATH) is a genuine 'failed' — withhold and retry loudly, don't commit unnotified. Hence
//   absentIsSkip = (platform !== darwin). Telegram/ntfy are reached ONLY after the operator
//   configured them, so for them too a missing `curl` is a configured sink that cannot deliver — a
//   real 'failed' (issue #16: if it silently became 'skipped', attempted would drop to 0 and the hit
//   would commit unnotified).
// execFile's error message echoes the full argv, and the Telegram/ntfy URLs carry the secret token /
// topic — so redact before writing, or a revoked-token retry loops the secret into the launchd log
// every 15m.
const ok = () => 'delivered';
const failedWith = (kind, absentIsSkip = false) => (e) =>
  absentIsSkip && e.code === 'ENOENT' ? 'skipped'   // always-on banner, binary absent → not a sink here
    : (process.stderr.write(`# ${kind} failed: ${redact(e.message)}\n`), 'failed');
const redact = (m) => String(m)
  .replace(/\/bot[^/\s]+\//g, '/bot***/')          // telegram: …/bot<token>/sendMessage
  .replace(/(ntfy\.sh\/)[^/\s]+/g, '$1***');       // ntfy: ntfy.sh/<topic>

// Telegram Bot API sendMessage. Setup: message @BotFather → /newbot → token; message your bot once,
// then read the chat id. Set MKT_TG_TOKEN + MKT_TG_CHAT. The chat log IS the searchable history.
function telegram(title, body) {
  const token = process.env.MKT_TG_TOKEN, chat = process.env.MKT_TG_CHAT;
  if (!token || !chat) return Promise.resolve('skipped');   // silent — Telegram is opt-in
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return run('curl', ['-fsS', '-G', url, '--data-urlencode', `chat_id=${chat}`,
    '--data-urlencode', `text=${title}\n${body}`]).then(ok).catch(failedWith('telegram'));
}

function ntfy(title, body) {
  const topic = process.env.MKT_NTFY_TOPIC;
  if (!topic) return Promise.resolve('skipped');   // silent opt-in fallback (Telegram is the primary sink)
  const url = `https://ntfy.sh/${topic}`;
  return run('curl', ['-fsS', '-H', `Title: ${title}`, '-d', body, url]).then(ok).catch(failedWith('ntfy'));
}

function macBanner(title, body) {
  // Escape double-quotes for the AppleScript string literals.
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
  // Off a Mac there is no banner (osascript absent) → skip; on a Mac a missing osascript is a real
  // failure, not an absent sink, so it must be withheld and retried rather than silently committed.
  return run('osascript', ['-e', script]).then(ok).catch(failedWith('osascript', process.platform !== 'darwin'));
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => (err ? rej(err) : res(stdout)));
  });
}
