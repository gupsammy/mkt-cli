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
//   would commit unnotified). Secrets are already scrubbed from e.message by run().
const ok = () => 'delivered';
const failedWith = (kind, absentIsSkip = false) => (e) =>
  absentIsSkip && e.code === 'ENOENT' ? 'skipped'   // always-on banner, binary absent → not a sink here
    : (process.stderr.write(`# ${kind} failed: ${e.message}\n`), 'failed');

// Quote+escape a value for a curl `--config -` file: quoting means a `#` can't start a comment and a
// newline can't terminate the value; the escape set is exactly curl's (\\ \" \r \n). Used to hide
// credential-bearing URLs on stdin instead of argv — curl unescapes \n to a newline before it acts.
const cfgq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;

// Telegram Bot API sendMessage. Setup: message @BotFather → /newbot → token; message your bot once,
// then read the chat id. Set MKT_TG_TOKEN + MKT_TG_CHAT. The chat log IS the searchable history.
function telegram(title, body) {
  const token = process.env.MKT_TG_TOKEN, chat = process.env.MKT_TG_CHAT;
  if (!token || !chat) return Promise.resolve('skipped');   // silent — Telegram is opt-in
  const { cmd, args, input, secrets } = telegramReq(title, body, token, chat);
  return run(cmd, args, { input, secrets }).then(ok).catch(failedWith('telegram'));
}

// Build the Telegram request without ever placing the token on argv. The API embeds the token in the
// URL *path* (`/bot<token>/…`), so it can't move to a header — instead the whole URL and the message
// data are fed to curl via a `--config -` file on stdin, keeping them out of the process argument
// list (`ps`) and out of the execFile failure string. `secrets` tells run() what to scrub if it fails.
export function telegramReq(title, body, token, chat) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  // --data-urlencode percent-encodes each value, so the wire body is unchanged (title\nbody → …%0A…).
  const input = [
    `url = ${cfgq(url)}`,
    `data-urlencode = ${cfgq(`chat_id=${chat}`)}`,
    `data-urlencode = ${cfgq(`text=${title}\n${body}`)}`,
    '',
  ].join('\n');
  return { cmd: 'curl', args: ['-fsS', '-G', '--config', '-'], input, secrets: [token, chat] };
}

function ntfy(title, body) {
  const topic = process.env.MKT_NTFY_TOPIC;
  if (!topic) return Promise.resolve('skipped');   // silent opt-in fallback (Telegram is the primary sink)
  const { cmd, args, input, secrets } = ntfyReq(title, body, topic);
  return run(cmd, args, { input, secrets }).then(ok).catch(failedWith('ntfy'));
}

// The ntfy topic is a capability token (whoever knows it can read and publish), so it gets the same
// treatment as the Telegram token: the URL that embeds it travels via `--config -` on stdin, never
// argv, and it is registered as a secret for redaction. The alert title becomes an HTTP header
// (`Title: …`); strip CR/LF first so it can't inject additional headers.
export function ntfyReq(title, body, topic) {
  const header = `Title: ${String(title).replace(/[\r\n]+/g, ' ')}`;
  const input = `url = ${cfgq(`https://ntfy.sh/${topic}`)}\n`;
  // --data-raw, not -d: curl's -d reads a value starting with `@` as a filename, and the body is
  // caller-controlled (`mkt notify --body=…` carries arbitrary log text), so a `@`-leading body would
  // POST a local file to ntfy.sh. --data-raw is identical but never interprets `@`.
  return { cmd: 'curl', args: ['-fsS', '--config', '-', '-H', header, '--data-raw', body], input, secrets: [topic] };
}

function macBanner(title, body) {
  const { cmd, args } = macBannerReq(title, body);
  // Off a Mac there is no banner (osascript absent) → skip; on a Mac a missing osascript is a real
  // failure, not an absent sink, so it must be withheld and retried rather than silently committed.
  return run(cmd, args).then(ok).catch(failedWith('osascript', process.platform !== 'darwin'));
}

// Escape for the AppleScript string literals — backslash FIRST, then quote (as cfgq does), else a
// backslash before a quote in caller text (`mkt notify --body=…`) closes the literal and injects into
// the osascript program.
export function macBannerReq(title, body) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
  return { cmd: 'osascript', args: ['-e', script] };
}

// Shared child-process runner for every sink. `input` is written to the child's stdin — how secrets
// reach curl without touching argv. On failure the rejected error is scrubbed of every value in
// `secrets`: Node folds the child's stderr into err.message, and the sinks write that message to a
// plaintext log, so redacting here (message and cmd, the two secret-bearing fields) protects all callers.
export function run(cmd, args, { input, secrets = [] } = {}) {
  return new Promise((res, rej) => {
    const child = execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
      if (!err) return res(stdout);
      for (const s of secrets) {
        if (!s) continue;
        err.message = err.message.split(s).join('[REDACTED]');
        if (err.cmd) err.cmd = err.cmd.split(s).join('[REDACTED]');
      }
      rej(err);
    });
    // A fast-failing child can close stdin before we finish writing — swallow the EPIPE so it surfaces
    // as the child's exit error (already redacted), not an unhandled rejection.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
