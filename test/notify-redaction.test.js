import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, telegramReq, ntfyReq } from '../src/notify.js';

// Issue #17: the Telegram bot token must never reach a process argument list (readable via `ps`) and
// must never survive into a logged diagnostic. Both guarantees live in src/notify.js, so the tests
// exercise the real request builders and the real child-process runner — no network, no mocking of
// the thing under test.

// A fabricated secret that is easy to grep for and could never appear by coincidence.
const TOKEN = '1234567890:AAErf-TOKEN-DO-NOT-LEAK-abcdefghijklmnop';
const CHAT = '999888777';

test('telegramReq keeps the token off argv — it travels only via stdin', () => {
  const { cmd, args, input, secrets } = telegramReq('Title', 'Body', TOKEN, CHAT);
  assert.equal(cmd, 'curl');
  // The whole argument vector is what `ps` and the execFile error string expose. The token (and the
  // URL that embeds it) must not be anywhere in it.
  const argv = args.join(' ');
  assert.ok(!argv.includes(TOKEN), `token leaked into argv: ${argv}`);
  assert.ok(!argv.includes('api.telegram.org'), `token-bearing URL leaked into argv: ${argv}`);
  // It has to be *somewhere*, and that somewhere is the stdin config curl reads with `--config -`.
  assert.ok(args.includes('--config') && args.includes('-'), 'expected `--config -` to read from stdin');
  assert.ok(input.includes(TOKEN), 'token should be supplied via stdin config');
  // The runner needs to know what to scrub if a send fails; both credential values are registered.
  assert.ok(secrets.includes(TOKEN) && secrets.includes(CHAT));
});

test('telegramReq preserves the wire body — title\\nbody, newline-escaped for the config parser', () => {
  const { input } = telegramReq('Hello', 'World', TOKEN, CHAT);
  // A real newline inside a curl config value ends the value; it has to be written as the escape \n,
  // which curl unescapes back to a newline before --data-urlencode percent-encodes it (→ %0A).
  assert.ok(input.includes('text=Hello\\nWorld'), `body not encoded as expected: ${input}`);
  assert.ok(input.includes(`chat_id=${CHAT}`));
});

test('run redacts every registered secret from a failed child’s diagnostic', async () => {
  // The worst case the issue describes: a child that echoes its own (secret-bearing) config to stderr
  // and then fails. Node folds that stderr into err.message; without redaction the token would land
  // in the wrapper’s plaintext monthly log. `cat 1>&2` reproduces the leak deterministically, offline.
  const { input, secrets } = telegramReq('T', 'B', TOKEN, CHAT);
  const err = await run('sh', ['-c', 'cat 1>&2; exit 1'], { input, secrets }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'expected the failing child to reject');
  assert.ok(!err.message.includes(TOKEN), `token survived into the diagnostic: ${err.message}`);
  assert.ok(!err.message.includes(CHAT), `chat id survived into the diagnostic: ${err.message}`);
  assert.ok(err.message.includes('[REDACTED]'), 'a redacted marker should remain in its place');
});

test('ntfyReq strips CR/LF from the Title header — no header injection', () => {
  const { args } = ntfyReq('Alert\r\nX-Evil: pwned', 'body', 'my-topic');
  const titleHeader = args[args.indexOf('-H') + 1];
  assert.ok(!/[\r\n]/.test(titleHeader), `newline survived into the Title header: ${titleHeader}`);
  assert.ok(titleHeader.startsWith('Title: Alert'));
});

test('ntfyReq keeps the topic (a capability token) off argv and registers it for redaction', () => {
  const TOPIC = 'my-secret-ntfy-topic';
  const { args, input, secrets } = ntfyReq('t', 'b', TOPIC);
  const argv = args.join(' ');
  assert.ok(!argv.includes(TOPIC), `ntfy topic leaked into argv: ${argv}`);
  assert.ok(!argv.includes('ntfy.sh'), `topic-bearing URL leaked into argv: ${argv}`);
  assert.ok(args.includes('--config') && args.includes('-'), 'expected `--config -` to read from stdin');
  assert.ok(input.includes(TOPIC), 'topic should be supplied via stdin config');
  assert.ok(secrets.includes(TOPIC));
});

test('ntfyReq sends the body literally — never curl’s file-reading -d', () => {
  // curl -d treats a value starting with @ as a filename to read. The ntfy body is caller-controlled
  // (`mkt notify --body=…` carries arbitrary log text), so a @-leading body under -d would POST a
  // local file to ntfy.sh. --data-raw is byte-identical but never interprets @.
  const body = '@/etc/hostname';
  const { args } = ntfyReq('t', body, 'topic');
  assert.ok(!args.includes('-d'), 'must not use -d — it reads @-prefixed values as files');
  const raw = args[args.indexOf('--data-raw') + 1];
  assert.equal(raw, body, 'the @-leading body must be passed through verbatim');
});

test('run redacts a secret carried on argv — from err.message and err.cmd', async () => {
  // The other redaction test drives the secret in via stdin; this one puts it on argv (the
  // `Command failed: <argv>` path + err.cmd) to prove both secret-bearing fields are scrubbed.
  const SECRET = 'argv-secret-do-not-leak';
  const err = await run('sh', ['-c', 'exit 1', SECRET], { secrets: [SECRET] }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'expected the failing child to reject');
  assert.ok(!err.message.includes(SECRET), `secret survived in err.message: ${err.message}`);
  assert.ok(!String(err.cmd ?? '').includes(SECRET), `secret survived in err.cmd: ${err.cmd}`);
});
