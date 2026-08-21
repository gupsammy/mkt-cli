import { execFile } from 'node:child_process';

// Push to every configured sink (spec §6): Telegram (push + searchable history + two-way, if a bot
// token/chat is set), ntfy.sh (if a topic is set), and a native macOS banner (always). Best-effort —
// a sink failure is logged to stderr, never throws, so one dead sink can't abort an alert run.
//
// Returns a delivery tally so callers can tell "reached someone" from "reached no one" (issue #16):
//   { delivered, failed, attempted }   attempted = delivered + failed  (skipped sinks excluded).
// A sink is 'skipped' when it is unconfigured (opt-in Telegram/ntfy with no env) — that is NOT a
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
const delivered = () => 'delivered';
const failedWith = (kind) => (e) => { process.stderr.write(`# ${kind} failed: ${e.message}\n`); return 'failed'; };

// Telegram Bot API sendMessage. Setup: message @BotFather → /newbot → token; message your bot once,
// then read the chat id. Set MKT_TG_TOKEN + MKT_TG_CHAT. The chat log IS the searchable history.
function telegram(title, body) {
  const token = process.env.MKT_TG_TOKEN, chat = process.env.MKT_TG_CHAT;
  if (!token || !chat) return Promise.resolve('skipped');   // silent — Telegram is opt-in
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return run('curl', ['-fsS', '-G', url, '--data-urlencode', `chat_id=${chat}`,
    '--data-urlencode', `text=${title}\n${body}`]).then(delivered).catch(failedWith('telegram'));
}

function ntfy(title, body) {
  const topic = process.env.MKT_NTFY_TOPIC;
  if (!topic) return Promise.resolve('skipped');   // silent opt-in fallback (Telegram is the primary sink)
  const url = `https://ntfy.sh/${topic}`;
  return run('curl', ['-fsS', '-H', `Title: ${title}`, '-d', body, url]).then(delivered).catch(failedWith('ntfy'));
}

function macBanner(title, body) {
  // Escape double-quotes for the AppleScript string literals.
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
  return run('osascript', ['-e', script]).then(delivered).catch(failedWith('osascript'));
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => (err ? rej(err) : res(stdout)));
  });
}
