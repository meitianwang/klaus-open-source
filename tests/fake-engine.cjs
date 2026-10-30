#!/usr/bin/env node
// Fake engine used by the manager tests.
//
// It speaks the real app-server framing (NDJSON on stdout, requests on stdin) but
// its behaviour is driven by environment variables, so each manager test can pin
// one property: a slow handshake, a spawn that dies before answering, a process
// that ignores stdin EOF (which is what exercises the 5s KILL_FALLBACK), and so
// on. Using a real child process is what makes the pool tests meaningful -- an
// in-memory stand-in could not reproduce spawn failure, exit ordering, or a process
// that refuses to die.
//
// The engine binary itself is exercised separately by engine-live.test.ts.

'use strict';

const MODE = process.env.FAKE_ENGINE_MODE || 'normal';
const log = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

// Prove argv reached us, because the manager must append --app-server itself.
log({ type: 'argv', argv: process.argv.slice(2) });

const HANDSHAKE_DELAY_MS = Number(process.env.FAKE_ENGINE_HANDSHAKE_DELAY_MS || 0);
let initialized = false;

function reply(id, result) {
  log({ id, result });
}

function replyError(id, code, message) {
  log({ id, error: { code, message } });
}

let buffer = '';
let lastInitializeParams = null;
let initializeCallCount = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    handle(frame);
  }
});

function handle(frame) {
  const { id, method, params } = frame;

  if (method === undefined) {
    log({ method: 'fake/response', params: frame });
    return;
  }

  if (method === 'initialize') {
    // The manager must send clientInfo + capabilities nested, and must follow with
    // the `initialized` notification. Retain what arrived so a later request can
    // assert the shape on the wire rather than trusting the sender.
    initializeCallCount += 1;
    lastInitializeParams = params;
    if (MODE === 'no-handshake-reply') return; // never answers: forces the 20s timeout
    const send = () => reply(id, { ok: true, got: params, clientName: process.env.FAKE_ENGINE_NAME || null });
    if (HANDSHAKE_DELAY_MS > 0) setTimeout(send, HANDSHAKE_DELAY_MS);
    else send();
    return;
  }

  if (method === 'initialized') {
    initialized = true;
    log({ type: 'initialized-notification' });
    return;
  }

  // A notification from the host has no id; nothing to answer.
  if (id === undefined || id === null) {
    log({ type: 'notification', method, params });
    return;
  }

  switch (MODE) {
    case 'close-stdout':
      process.stdout.end();
      return;
    case 'stderr-pressure':
      process.stderr.write(Buffer.alloc(1024 * 1024, 'x'), () => reply(id, { ok: true }));
      return;
    case 'die-without-reply':
      // Swallow the request: the process is about to exit, so the reply never comes.
      return;
    case 'reverse-request':
      // Ask the client something and wait. Whether it answers is the test's job.
      log({
        id: 500,
        method: 'approval/request',
        params: { sessionId: 'fake-session', request: { id: 'req-1' } },
      });
      reply(id, { ok: true, method });
      return;
    case 'never-reply':
      return; // forces requestWithTimeout to fire
    case 'server-error':
      replyError(id, -32601, `fake engine refused ${method}`);
      return;
    case 'garbage':
      process.stdout.write('this is not json\n');
      reply(id, { ok: true, method });
      return;
    default:
      // Echo the argv the process was started with, so the manager test can assert
      // the pool appended --app-server (pool.rs:243-259) rather than trusting it.
      reply(id, {
        ok: true,
        method,
        initialized,
        argv: process.argv.slice(2),
        initializeParams: lastInitializeParams,
        initializeCalls: initializeCallCount,
      });
      return;
  }
}

// Startup emissions, sent before the handshake so a listener attached before
// `attach()` observes them. A listener attached afterwards would miss them, which
// is a test bug rather than a manager bug — the manager wires stdout synchronously
// after spawn, so nothing is lost on the host side.
if (MODE === 'normal' || MODE === 'events') {
  log({ method: 'engine/event', params: { event: { type: 'fake-startup-event' } } });
}

if (MODE === 'reverse-request') {
  // Ask the client for an approval straight away and leave it unanswered: the test
  // asserts the -32000 drop ordering, which needs a request that is still pending
  // when teardown begins.
  log({
    id: 500,
    method: 'approval/request',
    params: { sessionId: 'fake-session', request: { id: 'req-1' } },
  });
}

if (MODE === 'multiple-reverse-requests') {
  for (const id of [500, 501]) {
    log({ id, method: 'approval/request', params: { sessionId: 'fake-session', request: { id: `req-${id}` } } });
  }
}

process.stdin.on('end', () => {
  // The well-behaved engine exits when stdin closes -- that is the normal teardown
  // path the manager relies on before falling back to SIGKILL.
  if (MODE !== 'ignore-stdin-eof') process.exit(0);
});

if (MODE === 'ignore-stdin-eof') {
  // Deliberately survive stdin EOF to prove the KILL_FALLBACK timer fires and the
  // manager escalates to SIGKILL instead of leaking the process.
  process.stdin.resume();
  setInterval(() => {}, 1000);
}

if (MODE === 'die-immediately') {
  process.exit(3);
}

if (MODE === 'startup-failed-stderr') {
  // Refuse to serve the way the real engine does when its own startup check fails:
  // print the diagnosis on stderr and exit before answering `initialize`. The manager
  // must turn this into an Error whose message carries the stderr tail, because the
  // RPC rejection alone only says the connection closed.
  process.stderr.write('klaus-agent-stdio: startup failed: invalid installed plugins state: config.toml is not valid TOML\n');
  process.exit(1);
}

if (MODE === 'die-after-handshake') {
  // Exit shortly after answering, so the manager sees a real engine death mid-life.
  setTimeout(() => process.exit(7), 120);
}

if (MODE === 'die-without-reply') {
  // Never answers any post-handshake request and exits, so a pending request must
  // fail with 'closed' rather than hang or resolve.
  setTimeout(() => process.exit(9), 120);
}
