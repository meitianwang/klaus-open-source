// Projector acceptance: the committed vectors, run against the TypeScript port.
//
// THIS IS THE EVIDENCE THAT THE PORT IS CORRECT, not my reading of the Rust. Four vector
// files were copied into `contracts/vectors/` from the retired shell's
// `assets/contract/` directory (baseline `8c441be9`). Three of them still match that
// baseline byte-for-byte; `turn-termination-vectors.json` has since been amended
// deliberately, in the same commit as the behaviour change it records (`4905bd4b`) — see
// `main/paths.ts`. Each is consumed here the SAME WAY the Rust tests consumed it —
// including the same harness input shape, because several cases assert only a slice
// of the event and the surrounding envelope is part of the contract:
//
//   message-phase-vectors.json     `projectionCases[]` -> ProductEvent{method, params}
//   subagent-stream-vectors.json   `cases[]` -> RawSessionEvent with the child event
//                                  wrapped in `event.subagentEvent`, agentId
//                                  "child-agent", sessionId "parent-session"
//   turn-termination-vectors.json  `projection.byStopReason` -> TurnCompleted, and
//                                  `failureProjection.byErrorCode` -> turn/failed
//   agent-notification-vectors.json `cases[]` -> RawSessionEvent with `event
//                                  .agentNotification`
//
// Per AGENTS.md, contract behaviour is pinned by committed vectors rather than by
// comparing this client against another implementation — and these tests read only files
// inside `apps/desktop`, so deleting the shell that produced the vectors did not break
// them.
//
// COMPARISON IS KEY-ORDER INSENSITIVE, ARRAY-ORDER SENSITIVE. The vectors were produced by
// `serde_json::json!` (a BTreeMap) and compared in Rust with `assert_eq!` on `Value`, so
// the files record an insertion order they assert nothing about — see `canonical()` in
// `tests/harness.ts`. Array order stays significant because it is genuinely contractual:
// `stream_mode` precedes its delta, `auth_required` precedes `interrupted`.

import { readFileSync } from 'node:fs';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';
import { vectorPath } from '../main/paths';
import { mapChatEvents, projectEngineEvent, type ChatEvent } from '../main/ipc/project';
import { notificationToEvent, type ClientEvent } from '../main/engine/protocol';
import type { Json } from '../main/ipc/contract';
import { projectSessionHistory } from '../main/sessions/history';

const h = new Harness();

interface VectorCase {
  name?: string;
  method?: string;
  params?: Json;
  input?: Json;
  event?: Json;
  expected?: Json;
}

function loadVector(name: string): Record<string, Json> {
  return JSON.parse(readFileSync(vectorPath(name), 'utf8')) as Record<string, Json>;
}

function cases(vector: Record<string, Json>, key: string): VectorCase[] {
  const found = vector[key];
  if (!Array.isArray(found)) throw new Error(`vector has no array '${key}'`);
  return found as VectorCase[];
}

/**
 * Read one projected frame by index, failing loudly if it is absent.
 *
 * Under `noUncheckedIndexedAccess` a bare `events[0]` is `ChatEvent | undefined`, and
 * asserting on it would either need a non-null assertion or would silently pass a
 * `undefined` into an equality check. Naming the missing frame is more useful than
 * either: "expected 2 frames, got 1" is the actual defect, while `undefined.type` is a
 * TypeError that hides which projection fell short.
 */
function frameAt(events: ChatEvent[], index: number, what: string): ChatEvent {
  const found = events[index];
  if (found === undefined) {
    throw new Error(
      `${what}: expected a frame at index ${index}, got ${events.length} frame(s): ` +
        JSON.stringify(events.map((event) => event.type)),
    );
  }
  return found;
}

/** Read one field off a task row, failing loudly if the row is absent. */
function taskAt(tasks: Json | undefined, index: number, what: string): Record<string, Json> {
  if (!Array.isArray(tasks)) throw new Error(`${what}: tasks is not an array`);
  const found = tasks[index];
  if (found === undefined || typeof found !== 'object' || found === null) {
    throw new Error(`${what}: expected a task at index ${index}, got ${tasks.length}`);
  }
  return found as Record<string, Json>;
}

// ---------------------------------------------------------------------------
// 1. message-phase-vectors.json — the product-event projection.
// ---------------------------------------------------------------------------

h.test('message phase projection matches the committed vector', () => {
  const vector = loadVector('message-phase-vectors.json');
  const rows = cases(vector, 'projectionCases');
  assertEqual(rows.length, 6, 'all six projection cases are present');

  for (const row of rows) {
    const method = row.method;
    assert(typeof method === 'string', `case has a method: ${JSON.stringify(row).slice(0, 80)}`);
    // Exactly the Rust harness (main.rs:9818-9821): a ProductEvent built from the case's
    // method and params.
    const event: ClientEvent = { type: 'productEvent', method, params: row.params ?? null };
    assertDeepEqual(mapChatEvents(event), row.expected, `projection case ${method}`);
  }
});

h.test('message phase replay blocks keep identity and phase intact', () => {
  // `replayBlocks` is the other half of this vector: what the renderer is owed per
  // message when history is replayed. The Rust test (`engine.rs:5641-5652`) feeds each
  // block to `to_replay_block` with NO metadata and asserts it comes back UNCHANGED —
  // i.e. the block's own shape is the contract, and replay must neither add nor drop
  // fields.
  //
  // The vector's own `reason` states the rule this pins: "Message identity and native
  // phase must reach the renderer unchanged so commentary never prematurely collapses
  // and the first final-answer delta can close the preceding activity. Legacy
  // notifications without metadata retain their existing shape."
  //
  // So the third block deliberately carries NO messageId and NO phase: it is a legacy
  // notification, and asserting that every block has them would assert the opposite of
  // what the vector exists to protect. What IS owed is that a block which DOES carry
  // identity keeps it, that commentary and final_answer stay distinguishable, and that a
  // block without metadata is passed through as-is rather than being given defaults.
  const vector = loadVector('message-phase-vectors.json');
  const blocks = vector.replayBlocks;
  assert(Array.isArray(blocks), 'replayBlocks is an array');
  assertEqual((blocks as Json[]).length, 3, 'all three blocks are present');

  const typed = blocks as Array<Record<string, Json>>;

  // A commentary block and a final-answer block must be distinguishable, because that is
  // what stops commentary from collapsing prematurely.
  const phases = new Set(typed.map((block) => block.phase));
  assert(phases.has('commentary'), 'commentary phase present');
  assert(phases.has('final_answer'), 'final_answer phase present');

  // Blocks that DO carry identity keep both fields.
  for (const block of typed) {
    if (block.phase === undefined) continue;
    assert(typeof block.messageId === 'string' && block.messageId !== '', 'a phased block keeps its messageId');
    assert(typeof block.phase === 'string' && block.phase !== '', 'and its phase');
  }

  // And the legacy block is untouched: no identity is invented for it.
  const legacy = typed[2];
  assert(legacy !== undefined, 'the legacy block exists');
  assertEqual(legacy.type, 'text', 'it is a text block');
  assertEqual(legacy.text, 'Legacy', 'with its text intact');
  assert(!('messageId' in legacy), 'no messageId is invented for a legacy block');
  assert(!('phase' in legacy), 'and no phase is invented either');
});

// ---------------------------------------------------------------------------
// 2. subagent-stream-vectors.json — child events, parent identity.
// ---------------------------------------------------------------------------

h.test('sub-agent live stream preserves child events and parent identity', () => {
  const vector = loadVector('subagent-stream-vectors.json');
  const rows = cases(vector, 'cases');
  assertEqual(rows.length, 15, 'all child stream cases are present');

  for (const row of rows) {
    const name = row.name ?? '(unnamed)';
    // Exactly the Rust harness (main.rs:11354-11358): a RawSessionEvent whose envelope
    // carries an empty submissionId and a subagentEvent wrapping the case's child event.
    const params = {
      sessionId: 'parent-session',
      event: {
        submissionId: '',
        subagentEvent: { agentId: 'child-agent', event: row.event },
      },
    } as unknown as Json;
    const events = mapChatEvents({ type: 'rawSessionEvent', params });

    assertDeepEqual(events, row.expected, `sub-agent case '${name}'`);
    // Every frame is an agent_progress wrapper — the child's stream never leaks into the
    // parent transcript as if it were the parent's own.
    for (const event of events) {
      assertEqual(event.type, 'agent_progress', `case '${name}' wraps every frame`);
    }
    // And the parent identity is preserved on each, with the child's sessionId stripped
    // from the inner event.
    for (const event of events) {
      assertEqual(event.sessionId, 'parent-session', `case '${name}' keeps the parent session`);
      assertEqual(event.agentId, 'child-agent', `case '${name}' names the child agent`);
      const inner = event.event as Record<string, Json> | undefined;
      assert(inner !== undefined, `case '${name}' carries the child event`);
      assert(!inner || !('sessionId' in inner), `case '${name}' strips the child sessionId`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. turn-termination-vectors.json — stopReason and errorCode mapping.
// ---------------------------------------------------------------------------

h.test('turn termination projection matches the committed vector', () => {
  const vector = loadVector('turn-termination-vectors.json');
  const projection = vector.projection as Record<string, Json>;
  const byStopReason = projection.byStopReason as Record<string, string>;

  // The aborted reason is the whole point of this vector (Rust asserts its presence at
  // main.rs:9841-9845 before iterating).
  assert('aborted' in byStopReason, 'the aborted reason is the whole point of this vector');
  assertEqual(byStopReason.aborted, 'interrupted', 'a user stop is interrupted, not done');

  for (const [reason, expected] of Object.entries(byStopReason)) {
    // Exactly the Rust harness (main.rs:9846-9857).
    const events = mapChatEvents({
      type: 'turnCompleted',
      params: {
        sessionId: 's-vector',
        turnId: 'turn-vector',
        result: { stopReason: reason },
      } as unknown as Json,
    });
    assertDeepEqual(
      events,
      [{ type: expected, sessionId: 's-vector', turnId: 'turn-vector' }],
      `stopReason '${reason}' must project as '${expected}'`,
    );
  }

  // "No result at all still settles the composer, with the declared type" (main.rs:9859-
  // 9870): a turn.completed with no `result` must still emit, using the vector's declared
  // missing-result type rather than a guessed one.
  assertEqual(projection.missingResultProjectsAs, 'done', 'the vector declares the fallback type');
  const bare = mapChatEvents({
    type: 'turnCompleted',
    params: { sessionId: 's-vector', turnId: 'turn-bare' } as unknown as Json,
  });
  assertDeepEqual(bare, [{ type: 'done', sessionId: 's-vector', turnId: 'turn-bare' }], 'a bare turn settles as done');

  // turnId is ALWAYS present on the frame (main.rs:4410-4423 emits it unconditionally),
  // which is what lets the renderer scope a Stop to the turn it meant.
  assertEqual(projection.turnIdAlwaysPresent, true, 'the vector declares turnId mandatory');
  const noTurnId = mapChatEvents({ type: 'turnCompleted', params: { sessionId: 's' } as unknown as Json });
  assert('turnId' in frameAt(noTurnId, 0, 'a turn with no turnId'), 'turnId is present even when the engine omitted it');
  assertDeepEqual(
    projection.eventFields as string[],
    ['type', 'sessionId', 'turnId', 'finalMessageId'],
    'and the frame carries exactly the declared fields',
  );
});

h.test('a failed turn projects per the committed error-code mapping', () => {
  const vector = loadVector('turn-termination-vectors.json');
  const failure = vector.failureProjection as Record<string, Json>;
  const byErrorCode = failure.byErrorCode as Record<string, string[]>;

  assertDeepEqual(Object.keys(byErrorCode).sort(), ['aborted', 'auth_failed', 'default'], 'three branches');

  for (const [code, expectedTypes] of Object.entries(byErrorCode)) {
    const errorCode = code === 'default' ? 'something_unmodelled' : code;
    const events = mapChatEvents({
      type: 'productEvent',
      method: 'turn/failed',
      params: {
        sessionId: 's-vector',
        // Real turn.failed payloads carry no detail.turnId (main.rs:4222-4227), so the
        // submissionId fallback is what the vector's `turnIdSource` describes.
        submissionId: 'turn-vector',
        detail: { error: { code: errorCode, message: 'boom' } },
      } as unknown as Json,
    });
    assertDeepEqual(
      events.map((event) => event.type),
      expectedTypes,
      `error code '${errorCode}' projects ${expectedTypes.join(' + ')}`,
    );
  }

  // The api_error frame is TERMINAL, and carries exactly the declared fields
  // (failureProjection.apiErrorFields, failureProjection.apiErrorIsTerminal).
  assertEqual(failure.apiErrorIsTerminal, true, 'the vector declares api_error terminal');
  const apiError = frameAt(
    mapChatEvents({
      type: 'productEvent',
      method: 'turn/failed',
      params: {
        sessionId: 's-vector',
        submissionId: 'turn-vector',
        detail: { error: { code: 'rate_limit_exceeded', message: 'slow down', retryAfterMs: 4000 } },
      } as unknown as Json,
    }),
    0,
    'the api_error frame',
  );
  assertEqual(apiError.terminal, true, 'terminal is set');
  assertEqual(apiError.retryAfterMs, 4000, 'the server-suggested wait rides the frame for the countdown offer');
  assertDeepEqual(
    Object.keys(apiError).sort(),
    [...(failure.apiErrorFields as string[])].sort(),
    'the api_error frame carries exactly the declared fields',
  );
  assertEqual(failure.turnIdSource, 'detail.turnId with submissionId fallback', 'the fallback the vector names');
  assertEqual(apiError.turnId, 'turn-vector', 'and the fallback is what produced this turnId');
});

h.test('a failed turn with an EMPTY message still reads as a failure', () => {
  // main.rs:4236-4247: the engine can settle a failed turn with message:"" (a provider
  // error body carrying no text), and `unwrap_or` only covers the ABSENT case. Without
  // this fallback the renderer shows a zero-content error card and the user reads it as
  // "no response" rather than "the turn failed".
  const events = mapChatEvents({
    type: 'productEvent',
    method: 'turn/failed',
    params: {
      sessionId: 's',
      submissionId: 't',
      detail: { error: { code: 'internal', message: '' } },
    } as unknown as Json,
  });
  assertEqual(events.length, 1, 'one frame');
  const emptyMessage = frameAt(events, 0, 'a failed turn with an empty message');
  assertEqual(emptyMessage.type, 'api_error', 'an api_error');
  assertEqual(emptyMessage.error, 'Engine error (internal)', 'with a readable label naming the code');

  // A whitespace-only message is trimmed to empty and falls back the same way.
  const blank = frameAt(
    mapChatEvents({
      type: 'productEvent',
      method: 'turn/failed',
      params: {
        sessionId: 's',
        submissionId: 't',
        detail: { error: { code: 'network', message: '   ' } },
      } as unknown as Json,
    }),
    0,
    'a failed turn with a blank message',
  );
  assertEqual(blank.error, 'Engine error (network)', 'whitespace-only falls back too');

  // And a request id is appended when the engine carried one (main.rs:4258-4262).
  const withRequest = frameAt(
    mapChatEvents({
      type: 'productEvent',
      method: 'turn/failed',
      params: {
        sessionId: 's',
        submissionId: 't',
        detail: { error: { code: 'overloaded', message: 'Busy', requestId: 'req_9' } },
      } as unknown as Json,
    }),
    0,
    'a failed turn carrying a request id',
  );
  assertEqual(withRequest.error, 'Busy (request-id: req_9)', 'the request id rides the message');
});

// ---------------------------------------------------------------------------
// 4. agent-notification-vectors.json — receipts only, never child chatter.
// ---------------------------------------------------------------------------

h.test('agent notification receipts match the committed vector', () => {
  const vector = loadVector('agent-notification-vectors.json');
  const rows = cases(vector, 'cases');
  assertEqual(rows.length, 10, 'all ten cases are present');

  for (const row of rows) {
    const name = row.name ?? '(unnamed)';
    // The case's `input` IS the raw-session params envelope (agent_notifications.rs:66+:
    // `chat_events(&params)`), so it is passed through unchanged rather than rewrapped.
    const events = mapChatEvents({ type: 'rawSessionEvent', params: row.input ?? null });
    assertDeepEqual(events, row.expected, `agent notification case '${name}'`);
  }
});

h.test('child progress and model text never become parent notifications', () => {
  // The vector's own `description` states the rule; these four cases are the ones that
  // enforce it, named explicitly so a regression says which guarantee broke.
  const vector = loadVector('agent-notification-vectors.json');
  const rows = cases(vector, 'cases');
  const rejecting = [
    'missing identity rejected',
    'unknown source rejected',
    'missing receiver rejected',
    'child progress is not receipt',
    'meta text cannot impersonate receipt',
  ];
  for (const name of rejecting) {
    const row = rows.find((candidate) => candidate.name === name);
    assert(row !== undefined, `the vector has a case named '${name}'`);
    const events = mapChatEvents({ type: 'rawSessionEvent', params: row.input ?? null });
    assertDeepEqual(events, [], `'${name}' projects nothing`);
  }
});

// ---------------------------------------------------------------------------
// 5. The fan-out arms the vectors do not cover, asserted from the Rust behaviour.
// ---------------------------------------------------------------------------

h.test('a raw envelope projects each fan-out exactly once', () => {
  // The initialize handshake opts out of `session/event` (asserted in
  // tests/engine-manager.test.ts), so an envelope the typed surface does not project
  // arrives once, on `session/rawEvent`. Projecting from both streams without that
  // opt-out would duplicate every pill and notice (main.rs:4429-4440).
  const raw: ClientEvent = {
    type: 'rawSessionEvent',
    params: {
      sessionId: 's',
      event: {
        event: {
          type: 'tool.event',
          toolUseId: 'tu_1',
          turnId: 'turn_1',
          event: { type: 'stdout', chunk: 'hello' },
        },
      },
    } as unknown as Json,
  };
  const fromRaw = mapChatEvents(raw);
  assertEqual(fromRaw.length, 1, 'one frame from the raw envelope');
  assertDeepEqual(
    fromRaw[0],
    { type: 'progress', sessionId: 's', toolName: '', toolCallId: 'tu_1', content: 'hello' },
    'a stdout chunk becomes progress on the owning tool card',
  );

  // The same payload arriving as `session/event` projects identically — one arm, two
  // kinds — which is what makes the opt-out the only thing preventing duplication.
  const fromSession = mapChatEvents({ type: 'sessionEvent', params: raw.params });
  assertDeepEqual(fromSession, fromRaw, 'session/event projects the same frames');
});

h.test('a file change keeps the shape the engine measured it in', () => {
  // main.rs:4988-4996: rendering it as diff text would mean re-parsing a path out of a
  // header this function had just built, and would drop the line counts.
  const events = mapChatEvents({
    type: 'rawSessionEvent',
    params: {
      sessionId: 's',
      event: {
        event: {
          type: 'tool.event',
          toolUseId: 'tu_2',
          turnId: 'turn_9',
          event: { type: 'file_change', change: { path: 'a/b.ts', kind: 'modified', added: 3, removed: 1 } },
        },
      },
    } as unknown as Json,
  });
  assertEqual(events.length, 1, 'one frame');
  assertDeepEqual(
    events[0],
    {
      type: 'diff_update',
      sessionId: 's',
      turnId: 'turn_9',
      changes: [{ path: 'a/b.ts', kind: 'modified', added: 3, removed: 1 }],
    },
    'the change ships as measured, with turnId so one turn is not read as the next',
  );
});

for (const row of cases(loadVector('compaction-lifecycle-vectors.json'), 'projectionCases')) {
  h.test(`compaction lifecycle: ${row.name}`, () => {
    if (!Array.isArray(row.input)) throw new Error('Compaction lifecycle input must be an event sequence');
    const projected = row.input.flatMap(event => mapChatEvents({
      type: 'rawSessionEvent', params: { sessionId: 'session', event } as Json,
    }));
    assertDeepEqual(projected, row.expected, 'The lifecycle preserves ordered frames, scope and boundary identity');
  });
}

h.test('compaction: a no-op finishes without claiming a boundary', () => {
  // main.rs:4809-4832 plus the Rust test at main.rs:11367-11384.
  const wrap = (inner: Json): ClientEvent => ({
    type: 'rawSessionEvent',
    params: { sessionId: 's', event: { event: inner } } as unknown as Json,
  });

  assertDeepEqual(
    mapChatEvents(wrap({ type: 'compaction.progress', phase: 'completed' } as unknown as Json)),
    [{ type: 'compaction_end', sessionId: 's' }],
    'a completed automatic pass emits compaction_end',
  );
  assertDeepEqual(
    mapChatEvents(wrap({ type: 'compaction', mode: 'micro', freedTokens: 40 } as unknown as Json)),
    [],
    'a micro compaction claims no boundary',
  );
  assertDeepEqual(
    mapChatEvents(wrap({ type: 'compaction.progress', phase: 'started' } as unknown as Json)),
    [{ type: 'compaction_start', sessionId: 's', trigger: 'auto' }],
    'and an automatic start says so',
  );

  // A MANUAL completed pass with a boundary carries the summary the renderer turns into
  // the done pill; without one it emits nothing, because the renderer clears its
  // optimistic pill from the compact_session answer instead (main.rs:4926-4943).
  const manual = (progress: Json): ClientEvent => ({
    type: 'rawSessionEvent',
    params: { sessionId: 's', event: { compactProgress: progress } } as unknown as Json,
  });
  assertDeepEqual(
    mapChatEvents(manual({ phase: 'completed', result: { boundary: { summary: 'Sum', uuid: 'u1' } }, trigger: 'manual' } as unknown as Json)),
    [{ type: 'compact_boundary', sessionId: 's', summaryText: 'Sum', summaryUuid: 'u1', trigger: 'manual' }],
    'a real compaction carries its boundary',
  );
  assertDeepEqual(
    mapChatEvents(manual({ phase: 'completed', result: {} } as unknown as Json)),
    [],
    'a no-op manual pass emits nothing',
  );
  assertDeepEqual(
    mapChatEvents(manual({ phase: 'failed' } as unknown as Json)),
    [{ type: 'compaction_error', sessionId: 's', error: 'Compaction failed.' }],
    'a failure with no error text still reads correctly',
  );
});

h.test('a completed memory run that touched nothing is not a write', () => {
  // main.rs:4592-4598: reporting it would put an empty section on screen every time a
  // pass merely ran.
  const wrap = (event: Json): ClientEvent => ({
    type: 'rawSessionEvent',
    params: { sessionId: 's', event: { memoryMaintenanceEvent: event } } as unknown as Json,
  });

  assertDeepEqual(
    mapChatEvents(wrap({ kind: 'auto_memory', run: { status: 'completed', runId: 'r1', filesTouched: [] } } as unknown as Json)),
    [],
    'an empty run projects nothing',
  );
  assertDeepEqual(
    mapChatEvents(wrap({ kind: 'auto_memory', run: { status: 'running', runId: 'r1', filesTouched: ['a.md'] } } as unknown as Json)),
    [],
    'an unfinished run projects nothing',
  );
  assertDeepEqual(
    mapChatEvents(
      wrap({ kind: 'auto_dream', run: { status: 'completed', dreamRunId: 'd1', filesTouched: ['m.md'], turnCount: 2 } } as unknown as Json),
    ),
    [
      {
        type: 'memory_write',
        sessionId: 's',
        kind: 'auto-dream',
        runId: 'd1',
        filesTouched: ['m.md'],
        turnCount: 2,
      },
    ],
    'a completed dream run that wrote projects its row',
  );
});

h.test('an unknown extension failure kind is dropped, not shown', () => {
  // main.rs:4494-4498: an unknown kind would be a row the UI has no repair action for.
  const wrap = (failure: Json): ClientEvent => ({
    type: 'rawSessionEvent',
    params: { sessionId: 's', extensionFailure: failure } as unknown as Json,
  });
  assertDeepEqual(mapChatEvents(wrap({ kind: 'mystery', id: 'x', message: 'm' } as unknown as Json)), [], 'unknown kind dropped');
  assertDeepEqual(mapChatEvents(wrap({ kind: 'hook', id: '', message: 'm' } as unknown as Json)), [], 'empty id dropped');
  assertDeepEqual(
    mapChatEvents(wrap({ kind: 'skill', id: 's1', message: 'not found', scope: 'project' } as unknown as Json)),
    [{ type: 'extension_failure', sessionId: 's', kind: 'skill', id: 's1', message: 'not found', scope: 'project' }],
    'a known kind with an id projects, scope included',
  );
  assertDeepEqual(
    mapChatEvents(wrap({ kind: 'plugin', id: 'p1', message: 'failed' } as unknown as Json)),
    [{ type: 'extension_failure', sessionId: 's', kind: 'plugin', id: 'p1', message: 'failed' }],
    'and an empty scope is omitted rather than sent as ""',
  );
});

h.test('taskList/changed stamps the paging fields a live change does not carry', () => {
  // main.rs:4452-4473: nextCursor null, total = task count, cursorStatus "current".
  const events = mapChatEvents({
    type: 'productEvent',
    method: 'taskList/changed',
    params: {
      sessionId: 's',
      taskList: {
        planId: 'plan-1',
        planKind: 'plan',
        revision: 3,
        tasks: [
          { id: 't1', subject: 'First', status: 'in_progress', description: 'do it', blockedBy: [] },
          { id: 't2', subject: 'Second', status: 'weird_new_status', owner: '', description: '' },
        ],
      },
    } as unknown as Json,
  });
  assertEqual(events.length, 1, 'one frame');
  const frame = frameAt(events, 0, 'the task_list frame');
  assertEqual(frame.type, 'task_list', 'a task_list frame');
  assertEqual(frame.sessionId, 's', 'attributed to the session');
  assertEqual(frame.total, 2, 'total is the task count');
  assertEqual(frame.cursor, null, 'nextCursor is stamped null');
  assertEqual(frame.status, 'current', 'cursorStatus is stamped current');
  assertEqual(frame.available, true, 'and the list is available');
  assertEqual(frame.planKind, 'plan', 'planKind passes through');

  // An unrecognized status becomes `pending` so a new engine status cannot produce a
  // renderer state it has no rendering for (engine.rs:222-227), and empty
  // description/owner are dropped rather than sent as "".
  const task0 = taskAt(frame.tasks, 0, 'the first task');
  const task1 = taskAt(frame.tasks, 1, 'the second task');
  assertEqual(task0.status, 'in_progress', 'a known status survives');
  assertEqual(task1.status, 'pending', 'an unknown status normalizes to pending');
  assert(!('owner' in task1), 'an empty owner is dropped');
  assert(!('description' in task1), 'an empty description is dropped');
  assertDeepEqual(task1.blockedBy, [], 'blockedBy is always an array');

  // An empty sessionId is refused: a task list with no session cannot be attributed.
  assertDeepEqual(
    mapChatEvents({
      type: 'productEvent',
      method: 'taskList/changed',
      params: { sessionId: '', taskList: { tasks: [] } } as unknown as Json,
    }),
    [],
    'no session, no frame',
  );
});

h.test('turn_usage reports nothing when the turn measured nothing', () => {
  // main.rs:4546-4551: an empty frame would render a zeroed budget, which reads as "this
  // turn cost nothing" rather than "not measured".
  const wrap = (inner: Json): ClientEvent => ({
    type: 'rawSessionEvent',
    params: { sessionId: 's', event: { event: inner } } as unknown as Json,
  });
  assertDeepEqual(
    projectEngineEvent(wrap({ type: 'turn.completed', usage: null } as unknown as Json)),
    [],
    'null usage emits nothing',
  );
  assertDeepEqual(
    projectEngineEvent(wrap({ type: 'turn.completed', usage: { inputTokens: 10 }, stopReason: 'completed' } as unknown as Json)),
    [
      {
        type: 'turn_usage',
        sessionId: 's',
        usage: { inputTokens: 10 },
        stopReason: 'completed',
      },
    ],
    'measured usage emits its frame with the stop reason',
  );
});

h.test('a throttled provider reports its retry instead of spinning silently', () => {
  // main.rs:3745-3766: without api_retry the renderer shows a frozen spinner for the
  // whole back-off instead of printing "retrying 2/3...". maxRetries comes from
  // per-session settings, which the engine does not report — hence the argument.
  const wrap = (decision: Json): ClientEvent => ({
    type: 'rawSessionEvent',
    params: { sessionId: 's', event: { event: { type: 'provider.decision', event: decision } } } as unknown as Json,
  });

  assertDeepEqual(
    projectEngineEvent(wrap({ kind: 'retry_scheduled', attempt: 2, debug: { errorKind: 'rate_limit' } } as unknown as Json), {
      maxRetries: 3,
    }),
    [{ type: 'api_retry', sessionId: 's', attempt: 2, maxRetries: 3, phase: null, kind: 'rate_limit' }],
    'a scheduled retry names the attempt and the ceiling',
  );
  assertDeepEqual(
    projectEngineEvent(wrap({ kind: 'model_fallback', model: 'a', nextModel: 'b' } as unknown as Json)),
    [{ type: 'notice', sessionId: 's', content: 'Provider fallback: switching from a to b.' }],
    'a fallback becomes a readable notice',
  );
  assertDeepEqual(
    projectEngineEvent(
      wrap({ kind: 'request_failed', attempt: 1, debug: { errorKind: 'overloaded', retryable: true, status: 529 } } as unknown as Json),
    ),
    [
      { type: 'provider_status', sessionId: 's', kind: 'overloaded', retryable: true, status: 529, attempt: 1 },
    ],
    'a failed request surfaces the normalized kind',
  );
  // request_started / request_completed are silent: the turn lifecycle covers them.
  assertDeepEqual(projectEngineEvent(wrap({ kind: 'request_started' } as unknown as Json)), [], 'a started request is silent');
});

h.test('provider request-start metadata cannot clear the captured request identity', () => {
  const inference = { revision: 0, model: 'shared-name', source: 'custom', selection: 'custom:first' };
  const event: ClientEvent = {
    type: 'sessionEvent',
    params: { sessionId: 's', event: { event: { type: 'provider.decision', inference,
      event: { kind: 'request_started', providerId: 'anthropic', model: 'shared-name', attempt: 1 } } } },
  };
  const frames = projectEngineEvent(event);
  assertDeepEqual(frames.filter(frame => frame.type === 'stream_mode'),
    [{ type: 'stream_mode', sessionId: 's', mode: 'requesting', inference }],
    'the diagnostic start preserves revision zero and the original source');
});

h.test('runtime auth expiry offers re-login with the bound mode', () => {
  // Raw turn.completed and typed turn/failed share the same bound auth policy.
  const wrap = (stopReason: string): ClientEvent => ({
    type: 'rawSessionEvent',
    params: { sessionId: 's', event: { event: { type: 'turn.completed', stopReason } } } as unknown as Json,
  });

  assertDeepEqual(
    projectEngineEvent(wrap('auth_failed'), { authMode: 'custom' }),
    [
      { type: 'auth_required', sessionId: 's', reason: 'token_invalid', mode: 'custom' },
      { type: 'interrupted', sessionId: 's' },
    ],
    'a bound session gets the re-login card, with the mode it picks its variant by',
  );
  assertDeepEqual(projectEngineEvent(wrap('completed')), [], 'any other stop reason emits nothing here');

  // The usage-bearing `done` is deliberately NOT projected from this raw frame
  // (main.rs:3676-3687): the driver runs emitDone:false and drops every done under that
  // flag, so projecting it grew the bubble a "turn N tok" span that does not belong.
  const withUsage: ClientEvent = {
    type: 'rawSessionEvent',
    params: {
      sessionId: 's',
      event: { event: { type: 'turn.completed', stopReason: 'completed', usage: { inputTokens: 5 } } },
    } as unknown as Json,
  };
  const projected = projectEngineEvent(withUsage);
  assert(
    !projected.some((event) => event.type === 'done'),
    'a raw turn.completed never projects done — only turn_usage',
  );
  assertEqual(projected[0]?.type, 'turn_usage', 'usage still reaches the overview row');
});

h.test('full projection applies committed session auth contexts while base failure vectors stay context-free', () => {
  const vector = loadVector('session-event-context.json');
  const inputs = vector.inputs as unknown as Record<'rawAuth' | 'typedAuth' | 'retry', ClientEvent>;
  const authCases = vector.authCases as Array<{ name: string; source: string; rawAuth: Json[]; typedAuth: Json[] }>;
  for (const test of authCases) {
    for (const kind of ['rawAuth', 'typedAuth'] as const) {
      assertDeepEqual(projectEngineEvent(inputs[kind], { authMode: test.source }), test[kind], `${test.name} ${kind}`);
    }
  }
  assertDeepEqual(projectEngineEvent(inputs.retry), [{ type: 'api_retry', sessionId: 'engine-session', attempt: 1, maxRetries: 5, phase: null, kind: 'rate_limit' }], 'full projection defaults to the engine retry budget of five');
  assertDeepEqual(mapChatEvents(inputs.typedAuth), [
    { type: 'auth_required', sessionId: 'engine-session', reason: 'Session credential expired' },
    { type: 'interrupted', sessionId: 'engine-session', turnId: 'turn-1' },
  ], 'the existing context-free failure contract is unchanged');
});

h.test('the projector consumes the ONE authoritative notification classifier', () => {
  // `main/engine/protocol.ts:notificationToEvent` is the single place that maps an
  // engine notification method onto a ClientEvent, and `tests/engine-protocol.test.ts`
  // already pins its five named cases plus the product-event default against
  // `SPECIAL_NOTIFICATION_EVENT_TYPES`.
  //
  // This projector used to carry a SECOND copy of that mapping. That was a real defect
  // rather than a tidy-up: the copy classified `engine/event` straight, while the
  // authoritative one UNWRAPS a level to `params.event` (protocol.ts:226-230, mirroring
  // rpc.rs:411-413). Two classifiers that disagree on one method is exactly the drift
  // AGENTS.md warns about, so this asserts the projector is fed BY the authoritative
  // function, including the unwrap.
  const named: Array<[string, string]> = [
    ['session/rawEvent', 'rawSessionEvent'],
    ['session/event', 'sessionEvent'],
    ['engine/event', 'engineEvent'],
    ['turn/completed', 'turnCompleted'],
    ['thread/deleted', 'threadDeleted'],
  ];
  for (const [method, type] of named) {
    assertEqual(notificationToEvent(method, {}).type, type, `${method} -> ${type}`);
  }
  for (const method of ['item/started', 'item/agentMessage/delta', 'taskList/changed', 'turn/failed', 'anything/new']) {
    const event = notificationToEvent(method, { sessionId: 's' });
    assertEqual(event.type, 'productEvent', `${method} is a product event`);
    if (event.type === 'productEvent') assertEqual(event.method, method, 'and keeps its method name');
  }

  // The unwrap the duplicate got wrong: engine/event carries its payload at params.event,
  // and the projector must see the INNER value.
  const unwrapped = notificationToEvent('engine/event', { event: { type: 'engineStatus', status: 'ok' } });
  assertEqual(unwrapped.type, 'engineEvent', 'classified as engineEvent');
  if (unwrapped.type === 'engineEvent') {
    assertDeepEqual(unwrapped.params, { type: 'engineStatus', status: 'ok' }, 'unwrapped one level');
  }

  // engine/event and thread/deleted project no chat frame today: they are consumed for
  // host bookkeeping (engine status, thread removal) rather than for the transcript.
  assertDeepEqual(mapChatEvents({ type: 'engineEvent', params: {} }), [], 'engine/event projects no chat frame');
  assertDeepEqual(mapChatEvents({ type: 'threadDeleted', params: {} }), [], 'thread/deleted projects no chat frame');
});

h.test('tool lifecycle frames arrive in the order the renderer expects', () => {
  // stream_mode BEFORE the frame it explains, in every arm that emits one — the renderer
  // switches its indicator on the mode frame and appends content on the next
  // (main.rs:4276-4279, 4281-4284, 4302-4315).
  const delta = mapChatEvents({
    type: 'productEvent',
    method: 'item/agentMessage/delta',
    params: { sessionId: 's', delta: 'Hi', messageId: 'm1', phase: 'commentary' } as unknown as Json,
  });
  assertDeepEqual(
    delta.map((event) => event.type),
    ['stream_mode', 'text_delta'],
    'mode first, then the delta',
  );
  assertEqual(delta[0]?.mode, 'responding', 'the responding mode');
  assertEqual(delta[1]?.phase, 'commentary', 'and the phase survives, which is what stops commentary collapsing early');

  const thinking = mapChatEvents({
    type: 'productEvent',
    method: 'item/reasoning/delta',
    params: { sessionId: 's', delta: 'Hmm' },
  });
  assertDeepEqual(
    thinking.map((event) => event.type),
    ['stream_mode', 'thinking_delta'],
    'thinking follows the same order',
  );
  assertEqual(thinking[0]?.mode, 'thinking', 'the thinking mode');
  assertEqual(thinking[1]?.thinking, 'Hmm', 'carried as `thinking`, not `text`');

  const tool = mapChatEvents({
    type: 'productEvent',
    method: 'item/started',
    params: { sessionId: 's', item: { type: 'tool_call', id: 'tc1', toolName: 'read', arguments: { path: 'a' } } },
  });
  assertDeepEqual(
    tool.map((event) => event.type),
    ['stream_mode', 'tool_start'],
    'a tool call opens with its mode',
  );
  assertEqual(tool[0]?.mode, 'tool-use', 'the tool-use mode');
  assertEqual(tool[1]?.toolCallId, 'tc1', 'the tool call id');
  // The engine calls it `arguments`; the renderer calls it `args`.
  assertDeepEqual(tool[1]?.args, { path: 'a' }, 'arguments are renamed to args');

  const command = mapChatEvents({
    type: 'productEvent',
    method: 'item/started',
    params: { sessionId: 's', item: { type: 'command_execution', id: 'ce1', command: 'ls' } },
  });
  assertEqual(command[1]?.toolName, 'Bash', 'a command execution is presented as the Bash tool');
  assertDeepEqual(command[1]?.args, { command: 'ls' }, 'with the command as its only arg');
});

h.test('a terminal tool call reports its error message, not the error object', () => {
  // main.rs:4828-4856. toolResultText reads item.error.message; stringifying the error
  // object would print JSON into the card.
  const failed = mapChatEvents({
    type: 'productEvent',
    method: 'item/completed',
    params: {
      sessionId: 's',
      item: { type: 'tool_call', id: 'tc2', toolName: 'read', status: 'failed', error: { message: 'no such file' }, result: { partial: true } },
    },
  });
  assertEqual(failed.length, 1, 'one frame');
  const failedFrame = frameAt(failed, 0, 'the failed tool_end frame');
  assertEqual(failedFrame.type, 'tool_end', 'a tool_end');
  assertEqual(failedFrame.isError, true, 'isError is set');
  assertEqual(failedFrame.content, 'no such file', 'the error MESSAGE, not the stringified object');
  assert(!('computerUse' in failedFrame), 'an errored tool carries no computerUse surface');

  // A bare-string error passes through unchanged (main.rs:4836-4838).
  const bare = mapChatEvents({
    type: 'productEvent',
    method: 'item/updated',
    params: {
      sessionId: 's',
      item: { type: 'tool_call', id: 'tc3', toolName: 'read', status: 'failed', error: 'boom' },
    } as unknown as Json,
  });
  assertEqual(frameAt(bare, 0, 'a bare-string tool error').content, 'boom', 'a bare-string error passes through');

  // item/updated with a NON-terminal status is a streaming args delta instead, stringified
  // because the renderer appends it to the partial args text it already shows
  // (main.rs:4335-4339). This arm had no case at all in an earlier shell version, so
  // every update was dropped.
  const streaming = mapChatEvents({
    type: 'productEvent',
    method: 'item/updated',
    params: {
      sessionId: 's',
      item: { type: 'tool_call', id: 'tc4', status: 'in_progress', arguments: { a: 1 } },
    } as unknown as Json,
  });
  const streamingFrame = frameAt(streaming, 0, 'an in-progress tool update');
  assertEqual(streamingFrame.type, 'tool_input_delta', 'an in-progress update streams args');
  assertEqual(streamingFrame.delta, '{"a":1}', 'stringified compactly, as serde_json does');
});

h.test('mobile recovery preserves authoritative turn and reasoning identities', () => {
  const vector = loadVector('mobile-event-identity-vectors.json');
  for (const row of vector.cases as unknown as Array<{ name: string; input: ClientEvent; type: string; innerType?: string; turnId?: string; messageId?: string }>) {
    const frames = projectEngineEvent(row.input);
    const outer = frames.find(value => value.type === row.type && (!row.innerType || (value.event as Record<string, Json> | undefined)?.type === row.innerType));
    const frame = row.innerType ? outer?.event as Record<string, Json> | undefined : outer;
    assert(frame !== undefined, row.name + ': projected item exists');
    if (row.turnId) assertEqual(frame.turnId, row.turnId, row.name + ': authoritative turn');
    if (row.messageId) assertEqual(frame.messageId, row.messageId, row.name + ': stable reasoning identity');
  }
  const replay = projectSessionHistory(vector.thinkingReplay!, 's') as Record<string, Json>;
  const messages = replay.messages as Array<Record<string, Json>>;
  const blocks = messages[0]!.contentBlocks as Array<Record<string, Json>>;
  assertEqual(blocks[0]!.messageId, 'assistant-reasoning-0', 'persisted reasoning survives host history projection');
  assert(!('messageId' in blocks[1]!), 'legacy reasoning does not invent an identity');
});

h.test('payload and context failures preserve the committed diagnostic projection', () => {
  const vector = loadVector('provider-error-details-vectors.json');
  const rows = vector.projectionCases as unknown as Array<{ name: string; error: Json; expectedKind: string; expectedText: string; expectedDetails: Json }>;
  for (const row of rows) {
    const event = frameAt(mapChatEvents({ type: 'productEvent', method: 'turn/failed', params: { sessionId: 'media-vector', submissionId: 'media-turn', detail: { error: row.error } } }), 0, row.name);
    assertEqual(event.kind, row.expectedKind, row.name + ': normalized kind');
    assertEqual(event.error, row.expectedText, row.name + ': original reason and identity');
    assertDeepEqual(event.errorDetails, row.expectedDetails, row.name + ': structured diagnostics');
    assertEqual(event.terminal, true, row.name + ': terminal state');
    const error = row.error as Record<string, Json>;
    const source = error.providerError as Record<string, Json> | undefined;
    if (!('status' in error) && source?.status === undefined) assert(!('status' in event), row.name + ': stream failure has no fabricated HTTP status');
    assertDeepEqual(event.status, (row.expectedDetails as Record<string, Json>).status, row.name + ': original HTTP status');
  }
});

h.test('restored error diagnostics preserve identity without mutating the original reply', () => {
  const vector = loadVector('provider-error-details-vectors.json');
  const rows = vector.historyCases as unknown as Array<{ name: string; input: Json; expectedText: string; expectedKind: string }>;
  for (const row of rows) {
    const original = JSON.stringify(row.input);
    const history = projectSessionHistory(row.input, 'media-vector') as Record<string, Json>;
    assertEqual((history.turnErrors as Record<string, Json>)['turn-payload'], row.expectedText, row.name + ': restored reason');
    assertEqual((history.turnErrorKinds as Record<string, Json>)['turn-payload'], row.expectedKind, row.name + ': restored kind');
    assertDeepEqual(history.turnErrorDetails, (row.input as Record<string, Json>).turnErrorDetails, row.name + ': restored diagnostics');
    assertEqual(JSON.stringify(row.input), original, row.name + ': input reply is untouched');
  }
  const legacy = projectSessionHistory({ history: [], turnErrors: { 'old-turn': 'Legacy provider failure' } }, 'media-vector') as Record<string, Json>;
  assertEqual((legacy.turnErrors as Record<string, Json>)['old-turn'], 'Legacy provider failure', 'old histories retain their error');
  assert(!('turnErrorDetails' in legacy), 'old histories do not invent diagnostics');
});

h.test('automatic review product and raw events preserve lifecycle attribution and exact action data', () => {
  const vector = loadVector('approval-review.json'), raw = vector.denied as Record<string, Json>;
  const normalized: Record<string, Json> = { ...raw, reviewId: raw.id! }; delete normalized.id;
  const original = JSON.stringify(raw);
  const rawFrames = mapChatEvents({ type: 'rawSessionEvent', params: { sessionId: 'review-session', event: { event: { type: 'approval_review', review: raw } } } });
  assertDeepEqual(rawFrames, [{ type: 'approval_review', sessionId: 'review-session', review: normalized, rawReview: raw }], 'raw lifecycle');
  const product = { sessionId: 'review-session', turnId: raw.turnId!, reviewId: raw.id!, targetItemId: raw.targetItemId!, startedAtMs: raw.startedAtMs!, completedAtMs: raw.completedAtMs!, decisionSource: 'agent', action: raw.action!, review: { status: raw.status!, riskLevel: raw.riskLevel!, userAuthorization: raw.userAuthorization!, rationale: raw.rationale! } };
  assertDeepEqual(mapChatEvents({ type: 'productEvent', method: 'item/autoApprovalReview/completed', params: product }), [{ type: 'approval_review', sessionId: 'review-session', review: normalized }], 'product lifecycle');
  assertEqual(JSON.stringify(raw), original, 'projection preserves original event');
  const history = projectSessionHistory({ history: [], approvalReviews: [raw] }, 'review-session') as Record<string, Json>;
  const row = (history.messages as Record<string, Json>[])[0]!;
  assertEqual(row.kind, 'approval-review', 'saved review replay');
  assertDeepEqual(row.approvalReview, normalized, 'saved review data');
  assertEqual(row.turnId, raw.turnId, 'saved owning turn');
});

h.test('browser tool review actions preserve registered identity in raw and product projections', () => {
  const vector = loadVector('approval-review.json'), raw = vector.denied as Record<string, Json>;
  const browserAction = (vector.actions as Record<string, Json>[]).find(action => action.type === 'browser_tool_call')!;
  const normalized: Record<string, Json> = { ...raw, reviewId: raw.id!, action: { type: 'browserToolCall', toolName: browserAction.toolName! } };
  delete normalized.id;
  const rawReview = { ...raw, action: browserAction };
  const rawFrames = mapChatEvents({ type: 'rawSessionEvent', params: { sessionId: 'review-browser', event: { event: { type: 'approval_review', review: rawReview } } } });
  assertDeepEqual(rawFrames, [{ type: 'approval_review', sessionId: 'review-browser', review: normalized, rawReview }], 'raw browser review');
  const product = { sessionId: 'review-browser', turnId: raw.turnId!, reviewId: raw.id!, targetItemId: raw.targetItemId!, startedAtMs: raw.startedAtMs!, completedAtMs: raw.completedAtMs!, decisionSource: 'agent', action: { type: 'browserToolCall', toolName: browserAction.toolName! }, review: { status: raw.status!, riskLevel: raw.riskLevel!, userAuthorization: raw.userAuthorization!, rationale: raw.rationale! } };
  assertDeepEqual(mapChatEvents({ type: 'productEvent', method: 'item/autoApprovalReview/completed', params: product }), [{ type: 'approval_review', sessionId: 'review-browser', review: normalized }], 'product browser review');
});

h.test('received agent communication remains visible in saved history without exposing housekeeping', () => {
  const vector = loadVector('subagent-communication-vectors.json');
  for (const value of vector.cases as Json[]) {
    const row = value as Record<string, Json>;
    const result = projectSessionHistory({ history: [{ type: 'user', uuid: 'received', isMeta: row.isMeta!, content: row.content! }], historyTurnIds: { received: 'child-turn' } }, 'parent-session') as Record<string, Json>;
    const messages = result.messages as Record<string, Json>[];
    if (row.expected) {
      assertEqual(messages.length, 1, String(row.name));
      assertEqual(messages[0]!.kind, 'agent-message', String(row.name));
      assertDeepEqual(messages[0]!.agentMessage, row.expected, String(row.name));
      assertEqual(messages[0]!.turnId, 'child-turn', 'received message retains the accepting turn');
    } else if (row.isMeta === true) assertEqual(messages.length, 0, String(row.name));
    else assertEqual(messages[0]!.kind, undefined, 'human content remains ordinary input');
  }
});

h.test('root mailbox delivery projects into the root while child delivery retains its own stream', () => {
  const vector = loadVector('subagent-communication-vectors.json');
  const row = (vector.cases as Record<string, Json>[])[0]!;
  const input = (agentId: string): ClientEvent => ({ type: 'rawSessionEvent', params: { sessionId: 'root', event: { subagentEvent: { agentId, event: { type: 'user.message', message: { uuid: 'received', isMeta: true, content: row.content! } } } } } });
  const root = mapChatEvents(input('root'));
  assertEqual(root.length, 1, 'root delivery projects once');
  assertEqual(root[0]!.type, 'user_message', 'no synthetic child is created for root mail');
  assertEqual(root[0]!.sessionId, 'root', 'root owns the input');
  const child = mapChatEvents(input('child'));
  assertEqual(child[0]!.type, 'agent_progress', 'child input retains child routing');
  const { sessionId: _owner, ...received } = root[0]!;
  assertDeepEqual((child[0] as Record<string, Json>).event, received, 'same received content on both paths');
});
h.test('nested live events retain the trusted direct-parent attribution', () => {
  const vector = loadVector('subagent-hierarchy-vectors.json');
  const result = mapChatEvents({ type: 'rawSessionEvent', params: { sessionId: vector.root!, event: { subagentEvent: {
    agentId: vector.agentId!, parentAgentId: vector.parentAgentId!, spawnTurnId: vector.parentTurnId!, depth: vector.depth!, event: vector.event!,
  } } } });
  assertDeepEqual(result, (vector.expectedEvents as Json[]).map(event => ({ type: 'agent_progress', sessionId: vector.root!, agentId: vector.agentId!, parentAgentId: vector.parentAgentId!, spawnTurnId: vector.parentTurnId!, depth: vector.depth!,
    event })), 'nested ownership is preserved alongside every projected event');
});
h.test('saved communication actions retain queue acceptance separately from model-facing prose', () => {
  const queued = loadVector('subagent-communication-vectors.json').queuedAction as Record<string, Json>;
  const output = queued.output!;
  const result = projectSessionHistory({ history: [
    { type: 'assistant', uuid: 'action', content: [{ type: 'tool_use', id: 'message-call', name: queued.toolName!, input: queued.arguments! }] },
    { type: 'tool_result', toolUseId: 'message-call', output, content: [{ type: 'text', text: queued.modelText! }] },
  ] }, 'root') as Record<string, Json>;
  const message = (result.messages as Record<string, Json>[])[0]!;
  const block = (message.contentBlocks as Record<string, Json>[])[0]!;
  assertDeepEqual((block.__result as Record<string, Json>).agentCommunication, output, 'saved queue acknowledgement survives replay');
});

// Drain the queue, then report.
void (async () => {
  const failed = await h.finish(`${__dirname}/project-result.json`, 'project');
  process.exit(failed);
})();
