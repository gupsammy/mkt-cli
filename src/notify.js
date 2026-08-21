import { execFile } from 'node:child_process';

// Push to every configured sink (spec §6): Telegram (push + searchable history + two-way, if a bot
// token/chat is set), ntfy.sh (if a topic is set), and a native macOS banner (always). Best-effort —
// a sink failure is logged to stderr, never throws, so one dead sink can't abort an alert run.
export async function notify(title, body) {
  await Promise.all([telegram(title, body), ntfy(title, body), macBanner(title, body)]);
}

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
  // Quote+escape config values so a quote or newline in the body can't terminate the value. curl
  // unescapes \n to a newline, which --data-urlencode then percent-encodes — same wire body as before.
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
  const input = [
    `url = ${q(url)}`,
    `data-urlencode = ${q(`chat_id=${chat}`)}`,
    `data-urlencode = ${q(`text=${title}\n${body}`)}`,
    '',
  ].join('\n');
  return { cmd: 'curl', args: ['-fsS', '-G', '--config', '-'], input, secrets: [token, chat] };
}

function ntfy(title, body) {
  const topic = process.env.MKT_NTFY_TOPIC;
  if (!topic) return Promise.resolve();   // silent opt-in fallback (Telegram is the primary sink)
  const { cmd, args } = ntfyReq(title, body, topic);
  return run(cmd, args).catch((e) => process.stderr.write(`# ntfy failed: ${e.message}\n`));
}

// The alert title becomes an HTTP request header (`Title: …`). A CR/LF in it would inject additional
// headers, so strip them before concatenation — the header is single-line by construction.
export function ntfyReq(title, body, topic) {
  const header = `Title: ${String(title).replace(/[\r\n]+/g, ' ')}`;
  return { cmd: 'curl', args: ['-fsS', '-H', header, '-d', body, `https://ntfy.sh/${topic}`] };
}

function macBanner(title, body) {
  // Escape double-quotes for the AppleScript string literals.
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
  return run('osascript', ['-e', script]).catch((e) =>
    process.stderr.write(`# osascript failed: ${e.message}\n`));
}

// Shared child-process runner for every sink. `input` is written to the child's stdin (how secrets
// reach curl without touching argv); `env` overrides the child environment. On failure the rejected
// error is scrubbed of every value in `secrets` — Node folds the child's stderr into err.message, and
// that message is what the sinks write to a plaintext log, so redaction here protects all callers.
export function run(cmd, args, { input, env, secrets = [] } = {}) {
  return new Promise((res, rej) => {
    const child = execFile(cmd, args, { timeout: 10000, env: env ?? process.env }, (err, stdout) => {
      if (!err) return res(stdout);
      for (const s of secrets) if (s) err.message = err.message.split(s).join('[REDACTED]');
      rej(err);
    });
    // A fast-failing child can close stdin before we finish writing — swallow the EPIPE so it surfaces
    // as the child's exit error (already redacted), not an unhandled rejection.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
