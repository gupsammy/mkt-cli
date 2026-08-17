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
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return run('curl', ['-fsS', '-G', url, '--data-urlencode', `chat_id=${chat}`,
    '--data-urlencode', `text=${title}\n${body}`]).catch((e) =>
    process.stderr.write(`# telegram failed: ${e.message}\n`));
}

function ntfy(title, body) {
  const topic = process.env.MKT_NTFY_TOPIC;
  if (!topic) return Promise.resolve();   // silent opt-in fallback (Telegram is the primary sink)
  const url = `https://ntfy.sh/${topic}`;
  return run('curl', ['-fsS', '-H', `Title: ${title}`, '-d', body, url]).catch((e) =>
    process.stderr.write(`# ntfy failed: ${e.message}\n`));
}

function macBanner(title, body) {
  // Escape double-quotes for the AppleScript string literals.
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
  return run('osascript', ['-e', script]).catch((e) =>
    process.stderr.write(`# osascript failed: ${e.message}\n`));
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => (err ? rej(err) : res(stdout)));
  });
}
