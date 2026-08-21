import { execFile } from 'node:child_process';

// Push to every configured sink (spec §6): Telegram (push + searchable history + two-way, if a bot
// token/chat is set), ntfy.sh (if a topic is set), and a native macOS banner (always). Best-effort —
// a sink failure is logged to stderr, never throws, so one dead sink can't abort an alert run.
export async function notify(title, body) {
  await Promise.all([telegram(title, body), ntfy(title, body), macBanner(title, body)]);
}

// Quote+escape a value for a curl `--config -` file: quoting means a `#` can't start a comment and a
// newline can't terminate the value; the escape set is exactly curl's (\\ \" \r \n). Used to hide
// credential-bearing URLs on stdin instead of argv — curl unescapes \n to a newline before it acts.
const cfgq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;

// Telegram Bot API sendMessage. Setup: message @BotFather → /newbot → token; message your bot once,
// then read the chat id. Set MKT_TG_TOKEN + MKT_TG_CHAT. The chat log IS the searchable history.
function telegram(title, body) {
  const token = process.env.MKT_TG_TOKEN, chat = process.env.MKT_TG_CHAT;
  if (!token || !chat) return Promise.resolve();   // silent — Telegram is opt-in
  const { cmd, args, input, secrets } = telegramReq(title, body, token, chat);
  return run(cmd, args, { input, secrets }).catch((e) =>
    process.stderr.write(`# telegram failed: ${e.message}\n`));
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
  if (!topic) return Promise.resolve();   // silent opt-in fallback (Telegram is the primary sink)
  const { cmd, args, input, secrets } = ntfyReq(title, body, topic);
  return run(cmd, args, { input, secrets }).catch((e) =>
    process.stderr.write(`# ntfy failed: ${e.message}\n`));
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
  // Escape double-quotes for the AppleScript string literals.
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
  return run('osascript', ['-e', script]).catch((e) =>
    process.stderr.write(`# osascript failed: ${e.message}\n`));
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
