import { execFile } from 'node:child_process';

// Push a notification to both sinks (spec §12): ntfy.sh (phone/desktop, if a topic is configured)
// and a native macOS banner (always). Best-effort — a sink failure is logged to stderr, never throws,
// so one dead sink can't abort an alert run.
export async function notify(title, body) {
  await Promise.all([ntfy(title, body), macBanner(title, body)]);
}

function ntfy(title, body) {
  const topic = process.env.MKT_NTFY_TOPIC;
  if (!topic) {
    process.stderr.write('# ntfy skipped (set MKT_NTFY_TOPIC to enable phone push)\n');
    return Promise.resolve();
  }
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
