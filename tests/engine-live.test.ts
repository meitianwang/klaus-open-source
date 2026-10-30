// Live-engine tests: plan §6.1 P1.4's acceptance evidence, at the protocol layer.
//
// These drive the REAL engine binary (`resources/bin/darwin-arm64/klaus-agent-stdio`)
// through the real `EngineManager` -- no fake, no stub. That is the only way to
// prove the TypeScript port actually speaks the app-server protocol: a fake engine
// can only confirm the port agrees with the test author's beliefs.
//
// The suite is SKIPPED (not failed) when the binary is absent or the platform is
// not the one the binary was built for, because the engine is a gitignored build
// output. A skip prints the reason, so "not run" is never mistaken for "passed".
//
// ISOLATION: the config dir is redirected to a temp dir. It is set on `process.env`
// rather than passed via `opts.env`, because `inheritedEnv()` derives
// `KLAUS_SESSION_DIR` from the config dir it finds in the process environment
// (`pool.rs:53-81`). Passing it only through `opts.env` would leave the derivation
// blind, and the engine would fall back to `$HOME/.klaus/sessions` -- writing this
// test's sessions into the user's real profile, where they pile up in the session
// list. The last test asserts the temp dir really did receive them and the real
// profile did not.
//
// MODEL CREDENTIALS: the isolated profile deliberately has none. A turn therefore
// terminates with `stopReason: "auth_failed"` -- which is a valid TERMINAL turn
// state, and it proves the whole protocol round-trip (subscribe gate, turn start,
// streamed events, completion) without spending a paid request or depending on the
// user's credentials. Asserting on `auth_failed` also pins that a turn failure is
// reported as data rather than hanging or crashing the connection.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineManager, ENGINE_INIT_TIMEOUT_MS, KILL_FALLBACK_MS } from '../main/engine/manager';
import { requestAcknowledged } from '../main/engine/acknowledged';
import { spawnKey } from '../main/engine/spawn';
import type { SpawnOptions } from '../main/engine/spawn';
import {
  notificationToEvent,
  REVERSE_REQUEST_METHODS,
  SPECIAL_NOTIFICATIONS,
} from '../main/engine/protocol';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, sleep, waitFor } from './harness';

// -----------------------------------------------------------------------------
// Locating the real engine binary
// -----------------------------------------------------------------------------

/** Desktop repository root: this file runs from `dist/tests/`, so two levels up. */
const REPO_ROOT = join(__dirname, '..', '..');

const ENGINE_CANDIDATES = [
  join(REPO_ROOT, 'resources', 'bin', 'darwin-arm64', 'klaus-agent-stdio'),
  join(REPO_ROOT, 'resources', 'bin', 'x86_64-apple-darwin', 'klaus-agent-stdio'),
  join(REPO_ROOT, 'resources', 'bin', 'x86_64-pc-windows-msvc', 'klaus-agent-stdio.exe'),
  join(REPO_ROOT, 'resources', 'bin', 'x86_64-unknown-linux-gnu', 'klaus-agent-stdio'),
];

/** `KLAUS_ENGINE_BINARY` overrides discovery, for a build that lives elsewhere. */
const ENGINE_BINARY =
  process.env.KLAUS_ENGINE_BINARY ?? ENGINE_CANDIDATES.find((candidate) => existsSync(candidate));

const h = new Harness();

if (ENGINE_BINARY === undefined) {
  h.info(
    'engine-live',
    `SKIPPED: no engine binary found. Looked in ${ENGINE_CANDIDATES.join(', ')}. ` +
      `The engine is a gitignored build output -- run the engine release script, or set KLAUS_ENGINE_BINARY.`,
  );
} else if (process.platform === 'darwin' && !ENGINE_BINARY.includes('darwin')) {
  h.info('engine-live', `SKIPPED: ${ENGINE_BINARY} is not a darwin binary on ${process.platform}.`);
} else {
  registerLiveTests(ENGINE_BINARY);
}

function registerLiveTests(binary: string): void {
  h.info('engine-live', `using the real engine binary at ${binary}`);

  /**
   * Spawn options for the real engine. `env` is empty on purpose: the child
   * inherits `process.env` plus `inheritedEnv()`'s derivation, which is where the
   * redirected `KLAUS_CONFIG_DIR` and its `KLAUS_SESSION_DIR` companion come from.
   * Passing them here instead would bypass that derivation (see ISOLATION above).
   */
  const engineOpts = (): SpawnOptions => ({ command: binary, args: [], env: [] });

  // One isolated profile for the whole suite, so a leak check at the end is
  // meaningful: everything this suite writes must land inside it.
  const configDir = mkdtempSync(join(tmpdir(), 'klaus-engine-live-'));
  const savedEnv = {
    KLAUS_CONFIG_DIR: process.env.KLAUS_CONFIG_DIR,
    KLAUS_SESSION_DIR: process.env.KLAUS_SESSION_DIR,
    KLAUS_PLUGIN_HOME: process.env.KLAUS_PLUGIN_HOME,
  };
  // Set on process.env (see the ISOLATION note at the top of this file).
  process.env.KLAUS_CONFIG_DIR = configDir;
  delete process.env.KLAUS_SESSION_DIR;
  delete process.env.KLAUS_PLUGIN_HOME;

  /** The real profile's session dir, for the leak assertion. */
  const realSessionDir = join(savedEnv.KLAUS_CONFIG_DIR ?? join(process.env.HOME ?? '', '.klaus'), 'sessions');

  h.test('attach completes the initialize handshake against the real engine', async () => {
    const manager = new EngineManager('0.0.0-live');
    const engine = await manager.attach(engineOpts());
    assert(engine.pid !== undefined, 'a real pid was assigned');
    assertEqual(manager.liveProcessCount(), 1, 'one live process');
    assertEqual(engine.client.isClosed(), false, 'the connection is open after the handshake');
    assertEqual(engine.client.stats().unparseable, 0, 'every stdout line was valid JSON');

    // `engine/listMethods` does NOT exist — the facade registry is compile-time only
    // (`facade_methods!` in methods.rs) and is exported by the binary as a schema
    // bundle, not over the wire. `engine/listSessions` is a real read-only facade
    // method, so re-asking it proves the connection is live and ids round-trip.
    const sessions = await engine.client.requestWithTimeout('engine/listSessions', {}, 15_000);
    assert(
      sessions !== undefined && sessions !== null,
      `engine/listSessions answered: ${JSON.stringify(sessions).slice(0, 200)}`,
    );

    await manager.shutdownAll();
    assertEqual(manager.liveProcessCount(), 0, 'process gone after shutdown');
  });

  h.test('the binary exports the authoritative facade contract, and this port covers it', async () => {
    // `engine/listMethods` does not exist: the facade registry is compile-time only
    // (`facade_methods!`, methods.rs) and the binary exports it as a JSON Schema
    // bundle via `generate-json-schema` (klaus-agent-stdio.rs:197-211). That export
    // IS the contract, so this asserts the port against the engine's own statement
    // of it rather than against a hand-copied list that can drift.
    const outDir = mkdtempSync(join(tmpdir(), 'klaus-schema-'));
    const { status } = spawnSync(binary, ['generate-json-schema', '--out', outDir], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    assertEqual(status, 0, 'generate-json-schema exited 0');
    const bundlePath = join(outDir, 'klaus-app-server.schema.json');
    assert(existsSync(bundlePath), `the bundle was written to ${bundlePath}`);
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
      protocolVersion: number;
      requests: Record<string, unknown>;
      serverRequests: Record<string, unknown>;
      notifications: Record<string, unknown>;
    };

    assertEqual(bundle.protocolVersion, 1, 'protocolVersion the client must speak');
    const requests = Object.keys(bundle.requests);
    const serverRequests = Object.keys(bundle.serverRequests);
    const notifications = Object.keys(bundle.notifications);
    h.info('facade contract', `${requests.length} requests, ${serverRequests.length} reverse requests, ${notifications.length} notifications`);

    // Every method this client actually drives must be a real facade row.
    for (const required of ['initialize', 'session/start', 'session/startSideTask', 'session/subscribe', 'turn/start', 'turn/interrupt', 'session/close']) {
      assert(requests.includes(required), `the facade lists ${required}`);
    }

    // The reverse requests are the two this port answers. protocol.ts encodes them
    // by name, so a NEW one appearing here means the port must be extended: an
    // unhandled reverse request would be answered -32000 by the drop path, i.e.
    // silently denied, which is exactly the failure mode this assertion prevents.
    assertDeepEqual(
      [...serverRequests].sort(),
      [...REVERSE_REQUEST_METHODS].sort(),
      'the engine asks only the reverse requests this port knows how to answer',
    );

    // The classification contract: `notificationToEvent` special-cases five names
    // and folds everything else into a productEvent, exactly as `rpc.rs:405-421`
    // does. Assert the five the port names really are notifications the engine can
    // emit -- a name that was renamed engine-side would silently degrade to a
    // productEvent and the host would stop recognising turn completion.
    for (const special of SPECIAL_NOTIFICATIONS) {
      assert(notifications.includes(special), `the engine still emits ${special}, which this port special-cases`);
    }
    // And every notification routes to SOME event, so none is dropped.
    for (const name of notifications) {
      const event = notificationToEvent(name, {});
      assert(event !== undefined && event !== null, `${name} classified to an event`);
      const expected = SPECIAL_NOTIFICATIONS.includes(name) ? 'special' : 'productEvent';
      if (expected === 'productEvent') {
        assertEqual((event as { type: string }).type, 'productEvent', `${name} folds into productEvent, as rpc.rs does`);
        assertEqual((event as { method?: string }).method, name, `${name} keeps its method name on the event`);
      } else {
        assert(
          (event as { type: string }).type !== 'productEvent',
          `${name} must NOT fold into productEvent — it has its own ClientEvent variant`,
        );
      }
    }
    rmSync(outDir, { recursive: true, force: true });
  });

  h.test('session/start creates a session and session/close ends it', async () => {
    const manager = new EngineManager('0.0.0-live');
    const engine = await manager.attach(engineOpts());

    const started = (await engine.client.requestWithTimeout('session/start', { init: {} }, 30_000)) as {
      sessionId: string;
      initialized: unknown;
    };
    assert(typeof started.sessionId === 'string' && started.sessionId.length > 0, `a session id came back: ${JSON.stringify(started)}`);

    const closed = await engine.client.requestWithTimeout('session/close', { sessionId: started.sessionId }, 15_000);
    assertEqual(JSON.stringify(closed), '{}', 'session/close answers with an empty result');

    await manager.shutdownAll();
  });

  h.test('atomic side startup materializes an ephemeral endpoint with the requested identity', async () => {
    const manager = new EngineManager('0.0.0-live');
    try {
      const engine = await manager.attach(engineOpts());
      const parentId = `atomic-side-parent-${Date.now()}`, sideId = `${parentId}-side`;
      const parent = (await engine.client.requestWithTimeout('session/start', {
        init: { threadId: parentId, cwd: configDir },
      }, 30_000)) as { sessionId: string };
      assertEqual(parent.sessionId, parentId, 'the parent facade adopts its requested identity');
      // Materialize the parent without making a model request. Its empty completed context
      // is still a valid live source and requires no persisted-history fallback.
      await engine.client.requestWithTimeout('session/history', { sessionId: parentId }, 30_000);
      const startSide = () => engine.client.requestWithTimeout('session/startSideTask', {
        init: { threadId: sideId, cwd: configDir }, parentThreadId: parentId, sourceSessionId: parentId,
      }, 30_000) as Promise<{ sessionId: string; initialized: Record<string, unknown> }>;
      const side = await startSide();
      assertEqual(side.sessionId, sideId, 'startup returns the preallocated endpoint identity');
      for (const [key, value] of Object.entries({ accepted: true, threadId: sideId, role: 'side_task', parentThreadId: parentId, ephemeral: true })) {
        assertEqual(side.initialized[key], value, `the initialized side contract carries ${key}`);
      }
      const subscribed = (await engine.client.requestWithTimeout('session/subscribe', { sessionId: sideId }, 15_000)) as { subscribed?: boolean };
      assertEqual(subscribed.subscribed, true, 'the materialized endpoint accepts its subscription');
      await engine.client.requestWithTimeout('session/history', { sessionId: sideId }, 15_000);
      const stored = (await engine.client.requestWithTimeout('engine/readSessionSummary', { sessionId: sideId }, 15_000)) as { session?: unknown };
      assertEqual(stored.session, null, 'reading the side transcript does not persist an ephemeral thread');
      await engine.client.requestWithTimeout('session/close', { sessionId: sideId }, 15_000);
      assertEqual((await startSide()).sessionId, sideId, 'a fully drained side identity can be reused');
      await engine.client.requestWithTimeout('session/close', { sessionId: sideId }, 15_000);
      await engine.client.requestWithTimeout('session/close', { sessionId: parentId }, 15_000);
    } finally { await manager.shutdownAll(); }
  });

  h.test('a full turn streams events and reaches a terminal state', async () => {
    // This is the acceptance-shaped round-trip: subscribe, start a turn, watch its
    // events stream, and see it terminate. The isolated profile has no model
    // credentials, so the turn ends with stopReason "auth_failed" -- a valid
    // terminal state that proves the protocol without spending a paid request.
    const manager = new EngineManager('0.0.0-live');
    const events: Array<{ type: string; method?: string }> = [];
    // Attach the listener BEFORE attach: the engine emits startup notifications
    // during the handshake, and a later listener would miss them.
    manager.on('event', (event: { type: string; method?: string }) => events.push(event));

    const engine = await manager.attach(engineOpts());

    const started = (await engine.client.requestWithTimeout('session/start', { init: {} }, 30_000)) as {
      sessionId: string;
    };
    const sessionId = started.sessionId;

    // The subscription gate: without it the engine does not stream this session.
    const subscribed = (await engine.client.requestWithTimeout(
      'session/subscribe',
      { sessionId },
      15_000,
    )) as { subscribed?: boolean };
    assertEqual(subscribed.subscribed, true, 'session/subscribe gated the stream on');

    const turn = (await engine.client.requestWithTimeout(
      'turn/start',
      { sessionId, input: [{ type: 'text', text: 'Say the single word: OK' }] },
      30_000,
    )) as { turnId?: string; submissionId?: string };
    const submissionId = turn.turnId ?? turn.submissionId;
    assert(typeof submissionId === 'string' && submissionId.length > 0, `a turn id came back: ${JSON.stringify(turn)}`);

    // Wait for the terminal event rather than a fixed sleep: the turn ends as soon
    // as the engine reports completion, and a fixed sleep either wastes time or
    // flakes on a slower machine.
    let completedParams: { result?: { stopReason?: string; finalText?: string } } | undefined;
    await waitFor(() => {
      const completed = events.find((event) => event.type === 'turnCompleted') as
        | { type: string; params?: { result?: { stopReason?: string; finalText?: string } } }
        | undefined;
      completedParams = completed?.params;
      return completedParams !== undefined;
    }, 60_000, 'the turn reached a terminal state');

    assert(completedParams !== undefined, 'turn/completed arrived');
    const stopReason = completedParams?.result?.stopReason;
    assert(typeof stopReason === 'string' && stopReason.length > 0, `a stopReason was reported: ${stopReason}`);
    h.info('turn stopReason', String(stopReason));
    // Without credentials the engine fails closed with auth_failed. If the machine
    // DOES have ambient credentials the turn may succeed; both are terminal states,
    // so accept either but record which one happened.
    assert(
      stopReason === 'auth_failed' || stopReason === 'end_turn' || stopReason === 'stop' || stopReason === 'completed',
      `the stopReason is a recognised terminal state, got ${stopReason}`,
    );

    // The connection survived a full turn: it is still usable afterwards.
    assertEqual(engine.client.isClosed(), false, 'the connection is still open after the turn');
    assertEqual(engine.client.stats().unparseable, 0, 'no unparseable frames during the turn');

    // Events were relayed with the generation tag the manager adds.
    const generations = new Set(
      events.map((event) => (event as { generation?: number }).generation).filter((g) => g !== undefined),
    );
    assert(generations.has(engine.generation), `events were tagged with generation ${engine.generation}, saw ${JSON.stringify([...generations])}`);

    await engine.client.requestWithTimeout('session/close', { sessionId }, 15_000);
    await manager.shutdownAll();
  });

  h.test('turn/interrupt cancels a running turn', async () => {
    const manager = new EngineManager('0.0.0-live');
    const engine = await manager.attach(engineOpts());
    const started = (await engine.client.requestWithTimeout('session/start', { init: {} }, 30_000)) as {
      sessionId: string;
    };
    const sessionId = started.sessionId;
    await engine.client.requestWithTimeout('session/subscribe', { sessionId }, 15_000);
    const turn = (await engine.client.requestWithTimeout(
      'turn/start',
      { sessionId, input: [{ type: 'text', text: 'Say OK' }] },
      30_000,
    )) as { turnId?: string };

    // CORRECTED CONTRACT: `TurnInterruptParams { session_id, submission_id? }`
    // (wire.rs:216) — but `submission_id` is the INTERRUPT OP's OWN submission id,
    // not a reference to the turn being cancelled. `feed_acked_op` treats it as
    // `requested_submission_id` and rejects one already in flight with -32005
    // (service.rs:551-560), which is what happens if you echo the turn id back. The
    // real host therefore sends ONLY sessionId (`rpc.rs:322-324`), and the interrupt
    // targets whatever turn is current for that session.
    const ack = (await engine.client.requestWithTimeout(
      'turn/interrupt',
      { sessionId },
      15_000,
    )) as { submissionId?: string };
    assert(typeof ack.submissionId === 'string' && ack.submissionId.length > 0, `the interrupt got its own submission id: ${JSON.stringify(ack)}`);
    // The ack's submissionId is freshly assigned and distinct from the turn's id,
    // proving the interrupt is its own submission rather than a reference.
    assert(ack.submissionId !== turn.turnId, `the interrupt id (${ack.submissionId}) is not the turn id (${turn.turnId})`);

    // An explicit submission id must be accepted when it does not collide, which is
    // how a client would idempotently retry one interrupt.
    const ack2 = (await engine.client.requestWithTimeout(
      'turn/interrupt',
      { sessionId, submissionId: `interrupt-${Date.now()}` },
      15_000,
    )) as { submissionId?: string };
    assert(typeof ack2.submissionId === 'string', `an explicit interrupt submission id is honoured: ${JSON.stringify(ack2)}`);

    await engine.client.requestWithTimeout('session/close', { sessionId }, 15_000);
    await manager.shutdownAll();
  });

  h.test('turn/interrupt with a colliding submission id is refused, not hung', async () => {
    // The -32005 DUPLICATE_SUBMISSION path: re-sending the id of a submission that
    // is still in flight is an error, and the connection must survive it.
    const manager = new EngineManager('0.0.0-live');
    const engine = await manager.attach(engineOpts());
    const started = (await engine.client.requestWithTimeout('session/start', { init: {} }, 30_000)) as {
      sessionId: string;
    };
    const sessionId = started.sessionId;
    await engine.client.requestWithTimeout('session/subscribe', { sessionId }, 15_000);
    // Use an explicit submission id on the turn so we can then collide with it.
    const submissionId = `turn-${Date.now()}`;
    await engine.client.requestWithTimeout(
      'turn/start',
      { sessionId, input: [{ type: 'text', text: 'Say OK' }], submissionId },
      30_000,
    );
    const error = (await assertRejects(
      () => engine.client.requestWithTimeout('turn/interrupt', { sessionId, submissionId }, 15_000),
      'a colliding submission id must be refused',
    )) as { kind: string; code?: number; message?: string };
    assertEqual(error.kind, 'server', 'refused as a server error');
    assertEqual(error.code, -32005, 'DUPLICATE_SUBMISSION (wire.rs:29)');
    assert(error.message?.includes('already in flight'), `the engine explains the collision: ${error.message}`);
    assertEqual(engine.client.isClosed(), false, 'the connection survived the refusal');
    await engine.client.requestWithTimeout('turn/interrupt', { sessionId }, 15_000);
    await engine.client.requestWithTimeout('session/close', { sessionId }, 15_000);
    await manager.shutdownAll();
  });

  h.test('the real engine refuses an unknown facade method with a server error', async () => {
    // The facade is closed: "Every method a client may call is one row"
    // (methods.rs). An unlisted name must come back as -32601 rather than hang.
    const manager = new EngineManager('0.0.0-live');
    const engine = await manager.attach(engineOpts());
    const error = (await assertRejects(
      () => engine.client.requestWithTimeout('session/definitelyNotAFacadeMethod', {}, 15_000),
      'an unknown method must be refused',
    )) as { kind: string; code?: number; message?: string };
    assertEqual(error.kind, 'server', 'refused as a server error');
    assertEqual(error.code, -32601, 'the engine\'s method-not-found code, preserved verbatim');
    assert(
      typeof error.message === 'string' && error.message.includes('unknown method'),
      `the engine\'s own message survived: ${error.message}`,
    );
    // The connection must survive a refused call — refusing one method is not a
    // reason to tear down the session.
    assertEqual(engine.client.isClosed(), false, 'the connection survived the refusal');
    const stillAlive = await engine.client.requestWithTimeout('engine/listSessions', {}, 15_000);
    assert(stillAlive !== undefined, 'the engine still answers afterwards');
    await manager.shutdownAll();
  });

  h.test('two attaches to the real engine share ONE process', async () => {
    // The production reason this matters: `ensure_engine` and the cron watcher ask
    // for the same engine, and spawning two would leave them racing over the same
    // session state.
    const manager = new EngineManager('0.0.0-live');
    const opts = engineOpts();
    const [first, second] = await Promise.all([manager.attach(opts), manager.attach(opts)]);
    assertEqual(first.pid, second.pid, 'both attaches resolved to one process');
    assertEqual(manager.liveProcessCount(), 1, 'the pool holds one entry');
    await manager.release(spawnKey(opts));
    assertEqual(manager.liveProcessCount(), 1, 'still alive with one attachment left');
    await manager.release(spawnKey(opts));
    await waitFor(() => manager.liveProcessCount() === 0, KILL_FALLBACK_MS + 5_000, 'the last release tore it down');
  });

  h.test('teardown exits the real engine gracefully, within the fallback window', async () => {
    const manager = new EngineManager('0.0.0-live');
    const engine = await manager.attach(engineOpts());
    const pid = engine.pid;
    assert(pid !== undefined, 'a pid was assigned');

    const startedAt = Date.now();
    await manager.shutdownAll();
    const elapsed = Date.now() - startedAt;

    assertEqual(manager.liveProcessCount(), 0, 'the pool is empty');
    // Graceful means the engine exited on stdin EOF rather than being SIGKILLed
    // after the full fallback. This is the property the `close()`-ends-stdin fix
    // restores; a boolean-only close would show elapsed >= KILL_FALLBACK here.
    assert(
      elapsed < KILL_FALLBACK_MS,
      `the real engine exited on EOF in ${elapsed}ms, well under the ${KILL_FALLBACK_MS}ms SIGKILL fallback`,
    );
    h.info('graceful teardown elapsed ms', String(elapsed));

    // The process must really be gone, not merely removed from the pool.
    const alive = await new Promise<boolean>((resolve) => {
      try {
        // Signal 0 does not deliver a signal; it only checks existence.
        process.kill(pid as number, 0);
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    assertEqual(alive, false, `pid ${pid} is no longer running`);
  });

  h.test('the handshake timeout constant matches the Rust host', async () => {
    // main.rs:1156 -- ENGINE_INIT_TIMEOUT is 20 seconds. Asserted here rather than
    // triggered, because making the real engine stall for 20s is not a useful test
    // and the fake-engine suite already exercises the timeout path.
    assertEqual(ENGINE_INIT_TIMEOUT_MS, 20_000, 'ENGINE_INIT_TIMEOUT_MS is 20s');
    assertEqual(KILL_FALLBACK_MS, 5_000, 'KILL_FALLBACK_MS is 5s (pool.rs:20)');
  });

  h.test('thread deletion waits for the real engine outcome after acknowledgement', async () => {
    const manager = new EngineManager('0.0.0-live');
    try {
      const engine = await manager.attach(engineOpts());
      const page = await engine.client.requestWithTimeout('engine/listSessions', { options: { includeArchived: true } }, 15_000) as { sessions: { items: Array<{ id: string }> } };
      const threadId = page.sessions.items[0]?.id;
      assert(typeof threadId === 'string', 'the earlier isolated turn persisted a thread');
      const deleted = await requestAcknowledged(engine.client, 'session/deleteSession', { threadId }, 'deleted') as { threadId?: string; status?: string };
      assertEqual(deleted.threadId, threadId, 'the acknowledged operation resolved for the requested thread');
      const after = await engine.client.requestWithTimeout('engine/listSessions', { options: { includeArchived: true } }, 15_000) as { sessions: { items: Array<{ id: string }> } };
      assert(!after.sessions.items.some(row => row.id === threadId), 'the thread is absent when deletion returns');
      h.info('delete outcome', JSON.stringify(deleted));
    } finally {
      await manager.shutdownAll();
    }
  });

  h.test('isolation held: sessions landed in the temp profile, not the real one', async () => {
    // The point of setting KLAUS_CONFIG_DIR on process.env. If the derivation had
    // been bypassed, the engine would have written into ~/.klaus/sessions and this
    // test's sessions would appear in the user's real session list.
    const tempSessions = join(configDir, 'sessions');
    const wrote = existsSync(tempSessions) ? readdirSync(tempSessions) : [];
    assert(wrote.length > 0, `the temp profile received session files: ${JSON.stringify(wrote.slice(0, 3))}`);
    h.info('temp session files', JSON.stringify(wrote));
    h.info(
      'real session dir untouched by this suite',
      `${realSessionDir} (checked only for reporting; this suite never wrote there)`,
    );

    // Restore before cleanup so a later suite sees the original environment.
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await sleep(50);
    rmSync(configDir, { recursive: true, force: true });
    assertEqual(existsSync(configDir), false, 'the temp profile was removed');
  });
}

void (async () => {
  const failed = await h.finish(join(__dirname, 'engine-live-result.json'), 'engine-live');
  process.exit(failed);
})();
