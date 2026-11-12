import { acceptedTurnInput } from './turn-input-fixture';
import { FakeEngineQueue } from './engine-queue-fixture';
// Wire-contract tests for the session layer.
//
// These pin six defects that a careful read of the engine's facade contract caught in a first
// draft of this port. Every one of them would have produced a PLAUSIBLE-LOOKING failure — an
// empty sidebar, a Stop button that does nothing, a transcript that renders blank — rather than
// an error, which is why they need tests rather than review.
//
// Each assertion names the Rust or engine source that decides the behaviour, because the whole
// point is that these shapes are not a matter of taste:
//
//   1. `agentMemorySnapshotPolicy` is five fields, not one, and the timeout is 125s not 120s
//      (`main.rs:2306-2321`). Every uncertain branch is `keep` because `replace` DESTROYS local
//      memory.
//   2. `engine/listSessions` nests the page: `{"sessions":{"items":[…],"nextCursor":…}}`.
//      Treating `sessions` as the array is a bug the Rust shell documents having shipped
//      (`engine.rs:1476-1479`).
//   3. `session/deleteSession` takes `threadId`, not `sessionId`, and must run even when no live
//      binding exists (`wire.rs:1113-1131`, `engine.rs:1021-1028`).
//   4. `turn/submit` with mode `steer` carries `"steer-" + messageId` while the reply's `messageId`
//      is the bare uuid (`main.rs:6842-6844`).
//   5. `turn/submit` answers a validated admission with `turnId` and the host MUST record it, or `interruptIsStale`
//      refuses every Stop that carries an `expectedTurnId` (`wire.rs:206-210`,
//      `main.rs:5127-5129`).
//   6. `session/history` is re-projected: the engine keys the transcript `history` and the turn
//      map `historyTurnIds`, the renderer reads `messages` with per-row `turnId`
//      (`crates/protocol/src/server.rs:3474-3484`, `engine.rs:3389-3402`).
//
// A FAKE CLIENT stands in for the engine. It records every method call and answers from a
// script, so these tests assert what this host SENDS — which is the contract under test — and
// run without spawning a process. `tests/engine-live.test.ts` covers the real engine.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type { RpcRequestOptions } from '../main/engine/request-scheduler';

import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';
import { HostState } from '../main/services/host-state';
import {
  SessionService,
  type EngineAttacherLike,
  type EngineClientLike,
  type SessionServiceDeps,
} from '../main/sessions/service';
import { buildSessionInit, buildSessionConfig, resolveSessionAuth, sessionDir, INLINE_VISUALIZATIONS_KEY, THREAD_TOOLS_KEY } from '../main/services/session-init';
import { readModelTierMapping, setModelTierMapping, GLOBAL_MODEL_TIERS_KEY } from '../main/services/model-tier-settings';
import { ModelFeatureSettings } from '../main/services/model-features';
import { delegationProtocolNote, productContextNote } from '../main/services/klaus-control';
import { THREAD_TOOL_SPECS } from '../main/services/thread-tools';
import { CRON_TOOL_SPECS } from '../main/services/cron-tools';
import { bindSessionWorkdir, readSessionModel, setSessionModel, setSessionThinkingLevel } from '../main/services/session-store';
import { ComposerService } from '../main/services/composer';
import { kvGet, kvSet, withSettingsDb } from '../main/services/settings';
import { recordCompletedSessionReply, recordInitialSessionRecency } from '../main/services/session-recency';
import { readSessionTitle } from '../main/services/session-titles';
import { vectorPath } from '../main/paths';
import type { ReverseRequest } from '../main/engine/protocol';
import { projectSessionHistory } from '../main/sessions/history';
import type { Json } from '../main/ipc/contract';
import { object } from '../main/ipc/arguments';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerSessionHandlers } from '../main/ipc/handlers/sessions';
import { registerSettingsHandlers } from '../main/ipc/handlers/settings';
import { WorkspaceStore } from '../main/services/workspaces';
import { ExtensionDiscovery } from '../main/services/extensions/discovery';
import { combineHostCapabilities, refreshIdleHostCapabilities } from '../main/sessions/host-capabilities';
import { planRewind } from '../main/sessions/lifecycle';
import { SessionQueries } from '../main/sessions/queries';
import { prepareSession, sessionFailureMessage, SessionPreparationPendingError } from '../main/sessions/preparation';
import { SessionConfiguration } from '../main/sessions/configuration';
import { WindowsRuntimePolicyProjection } from '../main/services/windows-runtime-policy';
import { applySessionRuntimePolicy, sessionRuntimePolicy } from '../main/services/session-store';
import { presetRuntimePolicy, type RuntimePolicy } from '../contracts/runtime-settings';
import { FEATURE_ONBOARDING_UI_STATE_KEYS } from '../contracts/feature-onboarding';
import { configuredInference, inferenceInit, replaceInferenceInit } from '../main/sessions/inference';
import { ChatEventForwarder, SessionEventPump } from '../main/sessions/events';
import { setupLifecycleNotices } from '../main/sessions/setup-lifecycle';
import { browserTabMentionLink, browserTabMentionUri, type BrowserTabMention } from '../shared/browser-tab-mention';
import { FriendTaskStore } from '../main/services/friend-task-store';
import { ClientFollowUpQueue } from '../main/sessions/client-queue';
import { SessionQueue } from '../main/sessions/queue';
import { AgentTaskTracker } from '../main/sessions/agent-tasks';
import { DesktopNotifications, type DesktopNotice } from '../main/services/notifications';
import { deactivateFriendSession, friendConversationGrant, friendSessionScope } from '../main/services/friend-session-scope';
import { FriendMessageStore } from '../main/services/friend-message-store';
import type { FriendExecutionPreset, FriendTaskGrant, FriendMessage } from '../shared/friends';

const h = new Harness();

h.test('a host-authored send pushes the user frame no composer owns', async () => {
  const client = new FakeClient().reply('session/start', { sessionId: 'host-frame-live' }).replySubmit('start-if-idle', 'host-frame-turn');
  const { service, state, pushed } = serviceWith(client, freshRoot());
  const session = await service.newSession() as Record<string, Json>;
  const id = String(session.id);
  await service.send(id, { text: 'Run the nightly report', displayMetadata: { origin: 'automation', taskName: 'Nightly' } }, undefined, undefined, { frame: true });
  const frame = pushed.find(event => (event as Record<string, Json>).type === 'user_message') as Record<string, any> | undefined;
  assert(frame, 'the live layer receives the trigger row a scheduled run has no composer for');
  assertEqual(frame.message.message.content, 'Run the nightly report', 'the frame carries the prompt text');
  assertDeepEqual(frame.message.message.localRender, { origin: 'automation', taskName: 'Nightly' }, 'the provenance snapshot rides the frame');
  pushed.length = 0;
  // Admission marks the turn running; an idle session is what a composer send needs.
  state.clearTurnRunning(id);
  await service.send(id, { text: 'typed follow-up' });
  assert(!pushed.some(event => (event as Record<string, Json>).type === 'user_message'), 'renderer-authored sends keep their own optimistic bubble');
});

h.test('browser tab references reach normal and mid-turn input through the named facade while keeping display metadata', async () => {
  const client = new FakeClient().reply('session/start', { sessionId: 'browser-mention-live' }).replySubmit('start-if-idle', 'browser-mention-turn').replySubmit('steer');
  const root = byoRoot();
  const contexts: Array<{ sessionId: string; ids: string[] }> = [];
  const { service, state } = serviceWith(client, root, undefined, { browserTabContext: async (references, sessionId) => {
    contexts.push({ sessionId, ids: references.map(reference => reference.tabId) });
    return 'LIVE_BROWSER_REFERENCE_CONTEXT';
  } });
  const session = await service.newSession() as Record<string, Json>;
  const id = String(session.id);
  const row = { source: 'extension' as const, browserId: 'chrome:fixture', tabId: '42', title: 'Example', url: 'https://example.com/', browserName: 'Chrome', lastOpened: 1 };
  const reference: BrowserTabMention = { ...row, mention: browserTabMentionUri(row) };
  const text = `Read ${browserTabMentionLink(reference)}`;
  const metadata = { displayText: text, composerReferences: [{ kind: 'browser-tab', name: 'Example', value: browserTabMentionLink(reference) }] };
  await service.send(id, { text, displayMetadata: metadata });
  const started = rowAt(client.sentSubmit('start-if-idle'), 0, 'browser turn');
  assert(String(started.input).includes(reference.mention), 'canonical identity reaches provider input');
  assert(String(started.input).includes('LIVE_BROWSER_REFERENCE_CONTEXT'), 'ordinary input has live operational context');
  assertDeepEqual((started.options as Record<string, Json>).displayMetadata, metadata, 'display chips survive separately');
  state.markTurnRunning(id, 'browser-mention-turn');
  const followed = await service.followUp(id, { text, displayMetadata: metadata }) as Record<string, Json>;
  assertEqual(followed.ok, true, 'human follow-up admitted');
  const steered = rowAt(client.sentSubmit('steer'), 0, 'browser steer');
  assert(JSON.stringify(steered.input).includes('LIVE_BROWSER_REFERENCE_CONTEXT'), 'mid-turn input has the same browser resolver context');
  assertDeepEqual(steered.displayMetadata, metadata, 'mid-turn metadata stays separate from operational input');
  assertDeepEqual(contexts, [{ sessionId: id, ids: ['42'] }, { sessionId: id, ids: ['42'] }], 'resolver is scoped for both human paths');
  await service.shutdown();
});
const modelSourceVectors = JSON.parse(readFileSync(vectorPath('session-model-source-vectors.json'), 'utf8')) as {
  inferenceProjection: Array<{ name: string; init: Record<string, Json>; resolved: Record<string, Json>;
    sources: Record<string, Json>; expected: Record<string, Json> }>;
};
const remoteCatalogVector = JSON.parse(readFileSync(vectorPath('remote-catalog-host-vectors.json'), 'utf8')) as {
  catalog: { defaultPageSize: number; priority: string; source: string; databaseConnectionsPerPage: number;
    summaryMethod: string; hiddenIds: string[]; sourceUpdatedAt: number; savedRecency: number };
};
const recoveryVectors = JSON.parse(readFileSync(vectorPath('session-recovery-vectors.json'), 'utf8')) as {
  historyFallbackMethod: string;
  cachedWorkingState: boolean;
  liveSessionLimit: number;
  idleRetirement: { idleMs: number };
  closeRecovery: { deadlineMs: number; pendingCode: string; serializeScopedReads: boolean };
  startupRecovery: { activationFailureMethods: string[]; closeAttempts: number; unknownSessionCode: number;
    retryBaseMs: number; retryMaxMs: number; retryDelaysMs: number[]; probePriority: string;
    preparation: { timeoutDelaysMs: number[]; closingRetryDelaysMs: number[]; activationOrder: string[] } };
  setupLifecycle: { reply: Json; notice: Json };
};
const capabilityRefreshVectors = JSON.parse(readFileSync(vectorPath('host-capability-refresh-vectors.json'), 'utf8')) as {
  bindings: Array<{ rendererId: string; stale: boolean; working: boolean; reload: 'success' | 'must-not-run' | 'unavailable' | 'failure' }>;
  expected: Array<{ rendererId: string; status: 'reloaded' | 'deferred' | 'failed' }>;
  attempted: string[];
};

/**
 * Read one projected row by index, failing loudly when it is absent.
 *
 * Under `noUncheckedIndexedAccess` a bare `messages[0]` is `T | undefined`. Naming the
 * missing row is more useful than a TypeError: "expected 2 rows, got 1" is the actual defect,
 * while `undefined.text` hides which projection fell short.
 */
function rowAt(rows: Json[], index: number, what: string): Record<string, Json> {
  const found = rows[index];
  if (found === undefined || found === null || typeof found !== 'object' || Array.isArray(found)) {
    throw new Error(
      `${what}: expected a row at index ${index}, got ${rows.length} row(s)`,
    );
  }
  return found as Record<string, Json>;
}

/** The same, for a row's `contentBlocks`. */
function blocksOf(row: Record<string, Json>, what: string): Array<Record<string, Json>> {
  const blocks = row.contentBlocks;
  if (!Array.isArray(blocks)) throw new Error(`${what}: contentBlocks is not an array`);
  return blocks as Array<Record<string, Json>>;
}

// ---------------------------------------------------------------------------
// A fake engine client: records calls, answers from a script.
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  params: Json;
}

/**
 * A fake engine client that IMPLEMENTS `EngineClientLike`.
 *
 * `implements` rather than a cast is the point: the compiler then checks this fake against the
 * same interface the real `AppServerClient` satisfies (verified separately — `EngineManager`
 * and `AppServerClient` are assignable to `EngineAttacherLike` / `EngineClientLike`), so the
 * fake cannot drift from the real client without the test file failing to compile. A
 * `client as never` cast would compile no matter how wrong the fake was, and the tests would
 * keep passing while proving nothing about the real wire.
 */
class FakeClient extends EventEmitter implements EngineClientLike {
  capabilities?: Readonly<Record<string, unknown>>;
  readonly calls: Call[] = [];
  readonly queue = new FakeEngineQueue();
  sentQueue(mode: 'start-if-idle' | 'steer'): Json[] {
    return this.calls.filter(call => call.method === 'thread/queue/start' && (object(call.params)?.mode ?? 'start-if-idle') === mode).map(call => call.params);
  }
  private readonly submitReplies = new Map<string, string>();
  replySubmit(mode: 'start-if-idle' | 'steer', fallbackSubmissionId = 'fixture-turn'): this {
    this.submitReplies.set(mode, fallbackSubmissionId);
    return this;
  }
  sentSubmit(mode: 'start-if-idle' | 'continue-if-idle' | 'steer'): Json[] {
    return this.calls.filter(call => call.method === 'turn/submit' && (call.params as Record<string, Json>).mode === mode).map(call => call.params);
  }

  private readonly replies = new Map<string, Json>();
  /** A per-call sequence, when one reply is not enough (pagination). */
  private readonly sequences = new Map<string, Json[]>();
  private readonly sequenceIndex = new Map<string, number>();
  /** Methods that refuse every call, for fallback-order tests. */
  private readonly failures = new Set<string>();
  closed = false;
  private readonly outcomes = new Map<string, Record<string, Json>>();

  failWith(method: string): this {
    this.failures.add(method);
    return this;
  }

  replyAcknowledged(method: string, envelope: Record<string, Json>): this {
    this.outcomes.set(method, envelope);
    return this.reply(method, { submissionId: 'fixture-submission' });
  }

  /** Queue the answer for every call of `method`. */
  reply(method: string, value: Json): this {
    this.replies.set(method, value);
    return this;
  }

  /**
   * Queue one answer per call of `method`, consumed in order.
   *
   * This exists so the pagination test can script two pages without overriding a method on the
   * instance through a cast — which would compile even if the override's signature drifted from
   * the interface, defeating the point of `implements EngineClientLike`.
   */
  replySequence(method: string, values: Json[]): this {
    this.sequences.set(method, values);
    this.sequenceIndex.set(method, 0);
    return this;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async requestWithTimeout(method: string, params: Json): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.failures.has(method)) throw new Error(`fake client: ${method} is unreadable`);
    if (method.startsWith('thread/queue/')) return this.queue.request(method, params);
    if (method === 'turn/interrupt') {
      const scripted = object(this.replies.get(method)), submissionId = typeof scripted?.submissionId === 'string' ? scripted.submissionId : 'fixture-interrupt';
      this.emit('event', { type: 'rawSessionEvent', params: { sessionId: object(params)?.sessionId, event: { submissionId, turnInterrupt: { accepted: true } } } });
      return { submissionId };
    }
    const outcome = this.outcomes.get(method);
    if (outcome) this.emit('event', { type: 'engineEvent', params: { submissionId: 'fixture-submission', ...outcome } });
    if (method === 'session/prepare' && !this.replies.has(method)) return { sessionId: object(params)?.sessionId, ready: true };
    if (method === 'session/subscribe' && !this.replies.has(method)) return { subscribed: true };
    if (method === 'session/resumePending' && !this.replies.has(method)) return { pendingResume: { started: false, reason: 'empty' } };
    if (method === 'session/taskList' && !this.replies.has(method)) return { tasks: [] };
    if (method === 'session/setupLifecycle' && !this.replies.has(method)) return { setupLifecycle: { idempotencyResults: {} } };
    if (method === 'session/subagentLifecycle' && !this.replies.has(method)) return { subagentLifecycle: { agents: [] } };
    if (method === 'session/backgroundProcesses' && !this.replies.has(method) && !this.sequences.has(method)) return { backgroundProcesses: { processes: [] } };
    if (method === 'session/queueSnapshot' && !this.replies.has(method) && !this.sequences.has(method)) return { queueSnapshot: { revision: 0, status: 'authoritative', items: [] } };
    if (method === 'config/read' && !this.replies.has(method) && !this.sequences.has(method)) return { resolved: {}, sources: {} };
    if (method === 'model/selection/resolve' && !this.replies.has(method)) {
      const saved = params as { source: string; selection: string };
      return { source: saved.source, selection: saved.selection === 'auto' ? `${saved.source}:fixture-default` : saved.selection };
    }
    const sequence = this.sequences.get(method);
    if (sequence !== undefined) {
      const index = this.sequenceIndex.get(method) ?? 0;
      this.sequenceIndex.set(method, index + 1);
      if (index >= sequence.length) throw new Error(`fake client: sequence for ${method} exhausted at call ${index}`);
      return sequence[index];
    }
    if (method === 'turn/submit' && !this.replies.has(method)) {
      const request = params as Record<string, Json>;
      if (request.mode !== 'continue-if-idle' && (request.input === '' || Array.isArray(request.input) && request.input.length === 0)) {
        return { status: 'not-submitted', submissionId: request.submissionId, reason: { code: 'empty-input' } };
      }
      const mode = String(request.mode), fallback = this.submitReplies.get(mode === 'continue-if-idle' ? 'start-if-idle' : mode);
      if (fallback !== undefined) return acceptedTurnInput(params, fallback);
    }
    if (!this.replies.has(method)) throw new Error(`fake client: no reply scripted for ${method}`);
    return this.replies.get(method);
  }

  /** Every call of one method, in order. */
  sent(method: string): Json[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }
}

function serviceWith(client: FakeClient, configRoot: string, workspaces?: WorkspaceStore, overrides: Partial<SessionServiceDeps> = {}): { service: SessionService; state: HostState; pushed: Json[] } {
  const state = new HostState();
  const pushed: Json[] = [];
  // A one-process attacher: `attach` always hands back this fake, and `shutdownAll` records
  // that it was asked. Typed as `EngineAttacherLike` so the shape is checked, not cast.
  const manager: EngineAttacherLike = {
    attach: async () => ({ client, generation: 1 }),
    shutdownAll: async () => {
      client.closed = true;
    },
  };
  const service = new SessionService({
    manager,
    state,
    spawnOptions: () => ({ command: '/bin/true', args: [], env: [] }),
    pushChatEvents: (events) => pushed.push(...events),
    configRoot,
    workspaces,
    ...overrides,
  });
  return { service, state, pushed };
}

// A throwaway config root: session-init reads settings, and these tests must not touch the
// developer profile (see tests/services.test.ts for the guard that enforces this).
process.env.KLAUS_TEST = '1';
const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'klaus-session-'));
  roots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// 1. The session init shape.
// ---------------------------------------------------------------------------

/**
 * A throwaway config root explicitly configured for a custom BYO source.
 * Writing the source keeps these fixtures independent of future default changes.
 * Seeding it through the settings handler also avoids touching the developer profile.
 */
function byoRoot(): string {
  const root = freshRoot();
  const written = kvSet('auth_mode', 'custom', root);
  assertEqual(written, true, 'the BYO precondition was written');
  return root;
}

h.test('new workspace sessions bind before init and carry every local workspace root', async () => {
  const root = byoRoot(), client = new FakeClient().reply('session/start', { sessionId: 'live-workspace' });
  mkdirSync(join(root, 'primary')); mkdirSync(join(root, 'secondary'));
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.save({ id: 'group', name: 'Multi', roots: [join(root, 'primary'), join(root, 'secondary')] });
  const { service, state } = serviceWith(client, root, workspaces);
  const row = await service.newSession({ workspaceId: 'group' }) as Record<string, Json>;
  const init = rowAt(client.sent('session/start'), 0, 'start').init as Record<string, Json>;
  assertEqual(init.cwd, join(root, 'primary'), 'primary root is chosen before starting engine');
  // Inline visualizations add the conversation's own
  // `visualizations/<sessionId>` directory as a second additional root, so the
  // workspace roots are now a SUBSET: the extra workspace folder must be there
  // and the visualization directory must ride along with it.
  const extraRoots = ((init.config as Record<string, Json>).sandbox_workspace_write as Record<string, Json>).writable_roots as string[];
  assert(extraRoots.includes(join(root, 'secondary')), 'extra folder passes through the engine path guard');
  assert(extraRoots.includes(join(root, 'visualizations', String(row.id))), 'the conversation visualization directory rides along as a writable root');
  assertDeepEqual(state.hostWritableRoots(String(row.id)), extraRoots, 'host roots are captured separately from configurable writable roots');
  assert(!Object.hasOwn(init, 'hostWritableRoots'), 'host root ownership never becomes an engine init field');
  assert(String(init.developerInstructions).includes(join(root, 'secondary')), 'agent knows all workspace folders');
  assertEqual(row.workspaceId, 'group', 'sidebar receives workspace membership');
  assertEqual(workspaces.customWorkdir(String(row.id)), join(root, 'primary'), 'binding is durable');
});

h.test('host-owned agent startup pins its BYO model and local directory before named session initialization', async () => {
  const root = freshRoot(), directory = join(root, 'team-repository');
  mkdirSync(directory);
  const definition = { name: 'reviewer', description: 'Review', prompt: 'Review the code', tools: ['read'] };
  const client = new FakeClient().reply('session/start', { sessionId: 'agent-live', initialized: { accepted: true, agentDefinitionName: 'reviewer' } });
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const { service } = serviceWith(client, root, workspaces);
  try {
    await service.newSession({ localWorkdir: directory, modelOverride: 'custom:collaboration-provider', agentProfile: { name: 'reviewer', definition } });
    const init = rowAt(client.sent('session/start'), 0, 'agent start').init as Record<string, Json>;
    assertEqual(init.cwd, directory, 'directory is bound before startup');
    assertEqual(init.modelSelection, 'custom:collaboration-provider', 'explicit provider choice is used for the new session');
    assertEqual(init.agentDefinitionName, 'reviewer', 'named facade selects the actual specialist');
    assertDeepEqual(init.agents, [definition], 'the actual local definition reaches the selector');
    assertEqual(kvGet('auth_mode', root), null, 'the global source preference is unchanged');
    assertEqual(kvGet('composer.main_model', root), null, 'the future default model is unchanged');
    assertDeepEqual(object(workspaces.projectsList())?.roots, [], 'the execution folder is not registered as a standalone project');
  } finally { await service.shutdown(); }
});

h.test('an engine without the selected-agent acknowledgment cannot silently start an ordinary root', async () => {
  const root = byoRoot(), client = new FakeClient().reply('session/start', { sessionId: 'old-engine-live', initialized: { accepted: true } })
    .reply('session/close', { closed: true });
  const { service } = serviceWith(client, root);
  try {
    const error = await assertRejects(() => service.newSession({ agentProfile: { name: 'general-purpose' } }), 'missing role acknowledgment must fail') as { code: string };
    assertEqual(error.code, 'AGENT_RUNTIME_MISMATCH', 'the host refuses a fake specialist');
    assertDeepEqual(client.sent('session/close'), [{ sessionId: 'old-engine-live' }], 'the mismatched session is closed');
    assertDeepEqual(client.sentSubmit('start-if-idle'), [], 'no inference is sent to an unverified root');
  } finally { await service.shutdown(); }
});

h.test('new sessions capture the effective retry ceiling in the engine init', async () => {
  for (const maxRetries of [0, 7]) {
    const root = byoRoot(), client = new FakeClient()
      .reply('config/read', { resolved: { maxRetries }, sources: { maxRetries: 'project' } })
      .reply('session/start', { sessionId: 'retry-live' });
    const { service } = serviceWith(client, root);
    const row = await service.newSession() as Record<string, Json>;
    const init = rowAt(client.sent('session/start'), 0, 'start').init as Record<string, Json>;
    assertEqual((init.config as Record<string, Json>).maxRetries, maxRetries, 'the displayed and actual retry budgets share one init');
    assertDeepEqual(client.sent('config/read'), [{ cwd: sessionDir(String(row.id), root) }], 'effective configuration is scoped to this session');
    await service.shutdown();
  }
});

h.test('session initialization shares one configuration snapshot with styles and managed capabilities', async () => {
  const root = byoRoot(), values = { selectedOutputStyle: 'fixture-style', plugins: {} };
  const client = new FakeClient().reply('config/read', { resolved: {}, sources: {}, values }).reply('session/start', { sessionId: 'snapshot-live' });
  let styleSnapshot: unknown, capabilitySnapshot: unknown;
  const { service } = serviceWith(client, root, undefined, {
    sessionStyles: async (_cwd, _extra, snapshot) => { styleSnapshot = snapshot; return { outputStyles: [], selectedOutputStyle: 'fixture-style' }; },
    hostCapabilities: async (_id, _cwd, snapshot) => { capabilitySnapshot = snapshot; return { mcpServers: [], runtimeCapabilityRoots: [] }; },
  });
  await service.newSession();
  assertDeepEqual(styleSnapshot, values, 'styles use the effective startup snapshot');
  assertEqual(capabilitySnapshot, styleSnapshot, 'capability declarations share the same request-scoped snapshot');
  assertEqual(client.sent('config/read').length, 1, 'startup does not reread shared configuration for each loader');
  await service.shutdown();
});

h.test('new sessions capture the subagent selection switch and the shared catalog only when enabled', async () => {
  for (const enabled of [false, true]) {
    const root = byoRoot(), providers = { fixture: { name: 'Fixture Model', provider: 'openai', model: 'wire-model' } };
    const client = new FakeClient().reply('config/read', {
      resolved: { subagentModelCatalog: enabled, modelProviders: providers }, values: { modelProviders: providers }, sources: {},
    }).reply('session/start', { sessionId: 'child-model-policy-live' });
    let statusReads = 0;
    const { service } = serviceWith(client, root, undefined, {
      modelSourceStatus: async () => { statusReads++; return { loggedIn: false }; },
    });
    try {
      await service.newSession();
      const init = rowAt(client.sent('session/start'), 0, 'start').init as Record<string, Json>, config = object(init.config)!;
      assertEqual(config.subagentModelCatalog, enabled, 'startup captures the effective switch');
      assertDeepEqual(config.subagentModelOptions, enabled ? [{ value: 'custom:fixture', label: 'custom · Fixture Model' }] : [],
        'catalog values use configured entry identities and safe labels');
      assertEqual(statusReads > 0, enabled, 'tier-only startup never queries model source catalogs');
      assertEqual(client.sent('model/credential/read').length, 0, 'directory listing does not inspect credentials');
    } finally { await service.shutdown(); }
  }
});

h.test('a capability revision changing during startup invalidates the shared configuration snapshot', async () => {
  let revision = 0, capabilityReads = 0;
  const client = new FakeClient().reply('config/read', { resolved: {}, sources: {}, values: { plugins: {} } })
    .reply('session/start', { sessionId: 'snapshot-revision-live' })
    .replyAcknowledged('session/reloadMcpServers', { mcpRuntime: { runtime: { servers: [] } } });
  const { service } = serviceWith(client, byoRoot(), undefined, {
    hostCapabilitiesRevision: () => revision,
    sessionStyles: async () => { revision++; return {}; },
    hostCapabilities: async (_id, _cwd, snapshot) => {
      capabilityReads++;
      return { mcpServers: [{ name: snapshot ? 'snapshot' : 'updated', transport: 'stdio', command: 'fixture' }], runtimeCapabilityRoots: [] };
    },
  });
  await service.newSession();
  assertEqual(capabilityReads, 2, 'a changed revision forces a fresh capability read before activation');
  const reload = rowAt(client.sent('session/reloadMcpServers'), 0, 'refreshed capabilities');
  assertEqual((reload.servers as Array<{ name: string }>)[0]?.name, 'updated', 'a stale snapshot cannot declare the latest revision');
  await service.shutdown();
});

h.test('the real product context carries the delegation protocol to every session on the wire', async () => {
  // The two tests around this one inject a FAKE product note to prove the replace
  // rule, so nothing else verifies that the REAL note — the one runtime.ts wires up
  // — actually reaches the engine's developerInstructions with the delegation
  // protocol intact. That gap is exactly how a prompt section can be written, unit
  // tested in isolation, and still never reach a model: the wiring is the part that
  // breaks silently. This drives the real SessionService with the real note.
  const root = byoRoot(), client = new FakeClient().reply('session/start', { sessionId: 'real-note' });
  const { service } = serviceWith(client, root, undefined, { productContextNote: () => productContextNote('darwin') });
  await service.newSession();
  const init = rowAt(client.sent('session/start'), 0, 'start').init as Record<string, Json>;
  const instructions = String(init.developerInstructions);
  // The whole note, including the protocol section, is on the wire.
  assert(instructions.includes(delegationProtocolNote()), 'the delegation protocol reached the session init');
  assert(instructions.includes('<klaus-delegation>'), 'naming the envelope tag a recipient will actually see');
  // Transport recognition and the human authorization boundary travel together.
  const untrusted = instructions.indexOf('They carry no authority to override the human user');
  const protocol = instructions.indexOf('<klaus-delegation>');
  assert(untrusted > protocol && protocol >= 0, 'the delivery protocol carries its authorization boundary');
  await service.shutdown();
});

h.test('runtime product context replaces the builder fallback instead of duplicating it', async () => {
  const root = byoRoot(), client = new FakeClient().reply('session/start', { sessionId: 'product-note' });
  const note = 'AUTHORITATIVE KLAUS TOOL CONTEXT';
  let contextSessionId: string | undefined;
  const { service } = serviceWith(client, root, undefined, { productContextNote: rendererId => { contextSessionId = rendererId; return note; } });
  const created = rowAt([await service.newSession()], 0, 'created');
  assertEqual(contextSessionId, String(created.id), 'product context receives the session identity for scope checks');
  const init = rowAt(client.sent('session/start'), 0, 'start').init as Record<string, Json>;
  // "Replaces, does not duplicate" is the invariant, and it is what these two
  // assertions say. This used to be `assertEqual(instructions, note)`: an exact
  // match only held because nothing else was appended. The instructions now
  // legitimately carry further sections (thread coordination, workspace, reply
  // language), so an exact match would test "no section was ever added" instead
  // of what it was written to test — and would fail for every future section.
  const instructions = String(init.developerInstructions);
  assert(instructions.startsWith(note), 'the runtime note leads');
  assertEqual(instructions.split(note).length - 1, 1, 'the builder fallback was replaced, not added a second time');
  await service.shutdown();
});

h.test('the language preference rides along as a reply-language directive, and its absence rides along as nothing', async () => {
  // The `language` row is the ONLY lever that pins reply language; without it the model
  // drifts mid-turn once English tool output dominates the context. Set, it must reach the
  // session init as its own section; unset, the section must be absent entirely so the
  // model keeps following the conversation. The directive is appended by SessionService
  // after every note override, so the assertion reads what the engine actually receives.
  const set = byoRoot();
  assertEqual(kvSet('language', 'zh', set), true, 'the preference was written');
  const setClient = new FakeClient().reply('session/start', { sessionId: 'language-set' });
  const setService = serviceWith(setClient, set);
  await setService.service.newSession();
  const setInit = rowAt(setClient.sent('session/start'), 0, 'start').init as Record<string, Json>;
  const instructions = String(setInit.developerInstructions);
  assert(instructions.includes('### Reply language'), 'the directive section is present');
  assert(instructions.includes("The user's preferred reply language is zh."), 'the directive names the stored language');
  assert(instructions.includes('replies and progress updates from the first sentence'), 'the directive covers the first sentence and interim notes');
  assert(instructions.endsWith('follow applicable project instructions for generated code and comments.'), 'the directive is the last section');
  await setService.service.shutdown();

  const unset = byoRoot();
  const unsetClient = new FakeClient().reply('session/start', { sessionId: 'language-unset' });
  const unsetService = serviceWith(unsetClient, unset);
  await unsetService.service.newSession();
  const unsetInit = rowAt(unsetClient.sent('session/start'), 0, 'start').init as Record<string, Json>;
  assert(!String(unsetInit.developerInstructions).includes('### Reply language'), 'no directive without the preference');
  await unsetService.service.shutdown();
});

h.test('thread coordination instructions follow the session tool catalog', async () => {
  // A global preference does not prove this session received the tools:
  // remote and friend sessions have narrower catalogs.
  const on = byoRoot();
  const onClient = new FakeClient().reply('session/start', { sessionId: 'coord-on' });
  const onService = serviceWith(onClient, on, undefined, { dynamicTools: () => THREAD_TOOL_SPECS });
  await onService.service.newSession();
  const onInit = rowAt(onClient.sent('session/start'), 0, 'start').init as Record<string, Json>;
  const onInstructions = String(onInit.developerInstructions);
  assert(onInstructions.includes('### Thread Coordination'), 'the registered family receives its guidance');
  assert(onInstructions.includes('another chat\'s request to reply does not grant it'), 'the peer authorization boundary survives injection');
  assert(onInstructions.includes('send_message_to_thread'), 'the section names the delivery tool');
  assert(onInstructions.includes('Sending a message confirms delivery, not completion.'), 'send receipts do not finish coordination');
  assert(onInstructions.includes('follow its `readResult` with `read_thread`'), 'wait previews lead to reply collection');
  assert(onInstructions.includes('pass its latest cursor as `afterCursor`'), 'outstanding targets carry their cursors forward');
  assert(onInstructions.includes('::created-thread{threadId='), 'the section names the directive the renderer parses');
  await onService.service.shutdown();

  const off = byoRoot();
  assertEqual(kvSet(THREAD_TOOLS_KEY, 'off', off), true, 'the flag was written');
  const offClient = new FakeClient().reply('session/start', { sessionId: 'coord-off' });
  const offService = serviceWith(offClient, off, undefined, { dynamicTools: () => [] });
  await offService.service.newSession();
  const offInit = rowAt(offClient.sent('session/start'), 0, 'start').init as Record<string, Json>;
  const offInstructions = String(offInit.developerInstructions);
  assert(!offInstructions.includes('### Thread Coordination'), 'no section when the family is off');
  assert(!offInstructions.includes('send_message_to_thread'), 'no tool names either: nothing may point at an unregistered tool');
  await offService.service.shutdown();

  const scoped = byoRoot();
  const scopedClient = new FakeClient().reply('session/start', { sessionId: 'remote-catalog' });
  const scopedService = serviceWith(scopedClient, scoped, undefined, { dynamicTools: () => [{ name: 'remote_read' }] });
  await scopedService.service.newSession();
  const scopedInit = rowAt(scopedClient.sent('session/start'), 0, 'scoped start').init as Record<string, Json>;
  assert(!String(scopedInit.developerInstructions).includes('### Thread Coordination'), 'a narrow catalog does not advertise unavailable chat tools');
  assert(!String(scopedInit.developerInstructions).includes('### Automations'), 'a narrow catalog does not advertise unavailable scheduling tools');
  await scopedService.service.shutdown();
});

h.test('scheduling guidance reaches only sessions with the complete cron tool family', async () => {
  for (const registered of [CRON_TOOL_SPECS, CRON_TOOL_SPECS.slice(0, 1), []]) {
    const root = byoRoot(), client = new FakeClient().reply('session/start', { sessionId: 'cron-guidance' });
    const { service } = serviceWith(client, root, undefined, { dynamicTools: () => registered });
    await service.newSession();
    const init = rowAt(client.sent('session/start'), 0, 'cron start').init as Record<string, Json>;
    const instructions = String(init.developerInstructions);
    assertEqual(instructions.includes('### Automations'), registered.length === 3, 'guidance tracks the actual complete tool family');
    if (registered.length === 3) {
      assert(instructions.includes('Prefer updating the existing task over creating a duplicate'), 'existing-task editing survives wire delivery');
      assert(instructions.includes('stay quiet while the monitored state is unchanged'), 'notification intent survives wire delivery');
    }
    await service.shutdown();
  }
});

h.test('inline visualization directory and directive ride along by default and disappear with the flag', async () => {
  // The inline-vis surface binds THREE things to ONE settings row:
  // the thread-scoped writable directory, the `### Inline Visualizations` section
  // naming it, and the `::klaus-inline-vis` directive the renderer parses. All
  // three must appear together by default and all three must disappear with
  // `inline_visualizations.enabled=off` — a section without a writable directory
  // would tell the model to write somewhere the whitelist refuses, and a
  // directory without the section would be a capability the model never learns
  // to use.
  const on = byoRoot();
  const onClient = new FakeClient().reply('session/start', { sessionId: 'vis-on' });
  const onService = serviceWith(onClient, on);
  const onRow = await onService.service.newSession() as Record<string, Json>;
  const onInit = rowAt(onClient.sent('session/start'), 0, 'start').init as Record<string, Json>;
  const visDir = join(on, 'visualizations', String(onRow.id));
  assert(existsSync(visDir), 'the directory exists on disk before the first turn');
  const onRoots = ((onInit.config as Record<string, Json>).sandbox_workspace_write as Record<string, Json>).writable_roots as string[];
  assert(Array.isArray(onRoots) && onRoots.includes(visDir), 'the directory is an additional writable root');
  const onInstructions = String(onInit.developerInstructions);
  assert(onInstructions.includes('### Inline Visualizations'), 'the section is present by default');
  assert(onInstructions.includes(visDir), 'the section names the conversation\'s own directory');
  assert(onInstructions.includes('::klaus-inline-vis{path='), 'the section names the directive the renderer parses');
  assert(onInstructions.includes('kebab-case'), 'the section states the file-name shape the whitelist enforces');
  await onService.service.shutdown();

  const off = byoRoot();
  assertEqual(kvSet(INLINE_VISUALIZATIONS_KEY, 'off', off), true, 'the flag was written');
  const offClient = new FakeClient().reply('session/start', { sessionId: 'vis-off' });
  const offService = serviceWith(offClient, off);
  await offService.service.newSession();
  const offInit = rowAt(offClient.sent('session/start'), 0, 'start').init as Record<string, Json>;
  const offInstructions = String(offInit.developerInstructions);
  assert(!offInstructions.includes('### Inline Visualizations'), 'no section when the surface is off');
  assert(!offInstructions.includes('::klaus-inline-vis'), 'no directive either: nothing may point at an unparseable contract');
  const offRoots = (((offInit.config as Record<string, Json>).sandbox_workspace_write as Record<string, Json>).writable_roots ?? []) as string[];
  assert(!offRoots.some(root => root.includes(join('visualizations', ''))), 'no visualization directory is granted writable');
  await offService.service.shutdown();
});

h.test('thread coordination instructions never displace the language directive', async () => {
  // The language directive is appended LAST by contract; the coordination
  // section goes in before it, so both must survive in one init. The flag is set
  // explicitly so this asserts the ordering rather than depending on the default.
  const root = byoRoot();
  assertEqual(kvSet('language', 'zh', root), true, 'the language preference was written');
  assertEqual(kvSet(THREAD_TOOLS_KEY, 'on', root), true, 'the coordination family was enabled');
  const client = new FakeClient().reply('session/start', { sessionId: 'coord-language' });
  const { service } = serviceWith(client, root, undefined, { dynamicTools: () => THREAD_TOOL_SPECS });
  await service.newSession();
  const init = rowAt(client.sent('session/start'), 0, 'start').init as Record<string, Json>;
  const instructions = String(init.developerInstructions);
  const coordination = instructions.indexOf('### Thread Coordination');
  const language = instructions.indexOf('### Reply language');
  assert(coordination >= 0 && language > coordination, 'coordination precedes the language directive');
  assert(instructions.endsWith('follow applicable project instructions for generated code and comments.'), 'the language directive still closes the instructions');
  await service.shutdown();
});

h.test('the product-note override cannot drop the reply-language directive', async () => {
  // SessionService REPLACES the builder's base note with the authoritative runtime one; the
  // directive is appended after that replacement, so an override must never eat it.
  const root = byoRoot();
  assertEqual(kvSet('language', 'zh', root), true, 'the preference was written');
  const client = new FakeClient().reply('session/start', { sessionId: 'language-override' });
  const { service } = serviceWith(client, root, undefined, { productContextNote: () => 'AUTHORITATIVE NOTE' });
  await service.newSession();
  const init = rowAt(client.sent('session/start'), 0, 'start').init as Record<string, Json>;
  const instructions = String(init.developerInstructions);
  assert(instructions.startsWith('AUTHORITATIVE NOTE'), 'the runtime note still leads');
  assert(instructions.includes("The user's preferred reply language is zh."), 'the directive survives the override');
  await service.shutdown();
});

h.test('subagent task titles follow the current UI language in new and existing sessions', async () => {
  const vectors = JSON.parse(readFileSync(vectorPath('subagent-identity-vectors.json'), 'utf8')) as {
    languageCases: Array<{ setting: string | null; language: string }>;
  };
  for (const row of vectors.languageCases) {
    const root = byoRoot();
    if (row.setting) assertEqual(kvSet('language', row.setting, root), true, 'the interface preference was written');
    const client = new FakeClient().reply('session/start', { sessionId: 'titles-live' }).replySubmit('start-if-idle', 'titles-turn');
    const { service, state } = serviceWith(client, root, undefined, { productContextNote: () => 'PRODUCT NOTE' });
    const session = await service.newSession() as Record<string, Json>;
    const id = String(session.id);
    const init = rowAt(client.sent('session/start'), 0, 'start').init as Record<string, Json>;
    const instructions = String(init.developerInstructions);
    assert(instructions.startsWith('PRODUCT NOTE'), 'the product context is retained');
    assert(instructions.includes(`summary of the work in ${row.language}, the current interface language`), 'child sessions inherit the configured title language');
    const metadata = { displayText: 'Displayed request', origin: 'composer' };
    await service.send(id, { text: 'Find the settings and delegate the work.', displayMetadata: metadata });
    const first = rowAt(client.sentSubmit('start-if-idle'), 0, 'first turn').options as Record<string, Json>;
    assertDeepEqual(first.displayMetadata, metadata, 'naming instructions do not overwrite display metadata');
    assert(String(first.systemPromptAppend).includes(`summary of the work in ${row.language}, the current interface language`), 'the normal turn receives the current language');
    state.clearTurnRunning(id);
    const nextSetting = row.setting === 'zh' ? 'en' : 'zh';
    assertEqual(kvSet('language', nextSetting, root), true, 'the interface language changed');
    await service.send(id, { text: 'Delegate another task.' });
    const next = rowAt(client.sentSubmit('start-if-idle'), 1, 'next turn').options as Record<string, Json>;
    const nextLanguage = nextSetting === 'zh' ? 'Chinese' : 'English';
    assert(String(next.systemPromptAppend).includes(`summary of the work in ${nextLanguage}, the current interface language`), 'the next turn reads the changed preference');
    assert(!String(next.systemPromptAppend).includes(`summary of the work in ${row.language}, the current interface language`), 'the append does not retain the old language');
    assertEqual(client.sent('session/start').length, 1, 'changing title language does not replace the live session');
    await service.shutdown();
  }
});

// ---------------------------------------------------------------------------
// 1. The session init shape.
// ---------------------------------------------------------------------------

h.test('a fresh profile defaults to a custom engine model without host credentials', () => {
  const root = freshRoot();
  const built = buildSessionInit({ rendererId: 'r1', cwd: '/tmp/c', configRoot: root });
  assert(built.ok, 'the default BYO init is available for engine resolution');
  assertEqual(built.init.modelSelection, 'auto', 'the engine selects the configured custom default');
  assertDeepEqual(built.init.modelSource, { source: 'custom', modelId: 'auto', selection: 'auto' }, 'the fresh profile uses the supported custom source');
  assertEqual(built.init.provider, undefined, 'the host does not prepare a provider');
  assertEqual(built.init.auth, undefined, 'the host does not inject account credentials');
});

h.test('agentMemorySnapshotPolicy is the full keep-biased policy, not just a timeout', () => {
  const root = byoRoot();
  const built = buildSessionInit({ rendererId: 'r1', cwd: '/tmp/c', configRoot: root });
  assert(built.ok, `init built: ${JSON.stringify(built)}`);
  if (!built.ok) return;

  const policy = built.init.agentMemorySnapshotPolicy as Record<string, Json>;
  // main.rs:2306-2321. Every uncertain branch is `keep` because `replace` destroys local
  // memory; absent the field the engine applies its OWN policy, which is not keep-biased.
  assertDeepEqual(
    policy,
    { timeoutMs: 125_000, firstUse: 'initialize', timeout: 'keep', disconnect: 'keep', noHandler: 'keep' },
    'all five fields, with the 125s budget',
  );
  // The budget sits just OUTSIDE the host's own 120s prompt timeout so the shell answers
  // first. A 120s value here would race it.
  assertEqual(policy.timeoutMs, 125_000, '125s, not the host 120s timeout');
  assertEqual(policy.timeout, 'keep', 'an unanswered snapshot keeps memory');
  assertEqual(policy.noHandler, 'keep', 'and so does a missing handler');
});

h.test('buildSessionConfig maps each permission mode onto canonical filesystem configuration', () => {
  // engine_config.rs build_session_config. Each of these booleans is a SECURITY setting the
  // engine enforces, so the mapping is contract rather than preference.
  assertDeepEqual(
    buildSessionConfig('high', true, null, presetRuntimePolicy('bypassPermissions')),
    {
      thinking: true, ultraMode: false,
      effort: 'high',
      approval_policy: 'never', sandbox_mode: 'danger-full-access', approvals_reviewer: 'user',
      sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
      plansDirectory: '.klaus/specs',
    },
    'bypassPermissions',
  );
  assertDeepEqual(
    buildSessionConfig('off', false, 200_000, presetRuntimePolicy('default')),
    {
      thinking: false, ultraMode: false,
      approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user',
      sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
      contextWindow: 200_000,
    },
    'default (Manual): sandboxed profile shared with acceptEdits',
  );
  const acceptEdits = buildSessionConfig('medium', false, null, presetRuntimePolicy('acceptEdits')) as Record<string, Json>;
  assertEqual(acceptEdits.sandbox_mode, 'workspace-write', 'legacy selection serializes the canonical filesystem mode');
  assertEqual((acceptEdits.sandbox_workspace_write as Record<string, Json>).network_access, true, 'workspace network grant');
  for (const key of ['sandbox', 'sandboxNetworkAllowed', 'requireRealSandbox', 'sandboxRetryOnDenial']) assert(!(key in acceptEdits), key + ' is retired');
  // This config is built with thinking ON ('medium'), so `effort` carries the level. The
  // OMITTED-when-off case is pinned exactly by the `assertDeepEqual` above, whose expected
  // object has no `effort` key at all.
  assertEqual(acceptEdits.effort, 'medium', 'effort carries the level when thinking is on');
  assertEqual(acceptEdits.thinking, true, 'and thinking is on');
  // `plansDirectory` is set only for a project session, so a projectless one keeps Spec plans
  // out of a directory it does not own.
  assert(!('plansDirectory' in acceptEdits), 'no plansDirectory for a projectless session');
  // A zero or negative context window is not sent: it comes from RESOLVED auth, not a stored
  // setting, so an engine-resolved model fills it from the definition.
  assert(!('contextWindow' in buildSessionConfig('medium', false, 0, presetRuntimePolicy('default'))), 'a zero window is omitted');
});

h.test('a session init carries the engine-resolved model selection, not host credentials', () => {
  const root = byoRoot();
  const built = buildSessionInit({ rendererId: 'r1', cwd: '/tmp/c', configRoot: root });
  assert(built.ok, `init built: ${JSON.stringify(built)}`);
  if (!built.ok) return;

  // This profile's stored auth_mode is `custom`, so the EngineModel branch applies: the host
  // sends only the selection and the engine resolves the credential itself.
  assertEqual(typeof built.init.modelSelection, 'string', 'modelSelection is sent');
  // The Provider branch's fields must be ABSENT, not empty: sending `provider`/`auth` would
  // tell the engine the host resolved a credential when it did not.
  assert(!('provider' in built.init), 'no host-resolved provider on the EngineModel path');
  assert(!('auth' in built.init), 'and no host-resolved auth');
  assert(!('capabilities' in built.init), 'and no host-declared capabilities');

  // The fields that are always present, whatever the branch.
  assertEqual(built.init.cwd, '/tmp/c', 'cwd');
  assertEqual(built.init.mcpOauthRedirectUri, 'http://127.0.0.1:33418/callback', 'the MCP OAuth redirect (main.rs:2304)');
  assertDeepEqual(
    built.init.hostCapabilities,
    { mcpServers: [], runtimeCapabilityRoots: [] },
    'declared empty rather than omitted, because the engine reads mcpServers unconditionally',
  );
  assertEqual(typeof built.init.developerInstructions, 'string', 'the product note rides along');
  assertEqual(Object.hasOwn(built.init, 'permissionMode'), false, 'ordinary modes do not cross the facade');
  assert(!('prePlanPermissionMode' in built.init), 'planning uses independent collaboration state');
});

h.test('a threadId beginning __ is not sent, so it cannot become a persistent thread', () => {
  const root = byoRoot();
  const internal = buildSessionInit({ rendererId: '__sweep', cwd: '/tmp/c', threadId: null, configRoot: root });
  assert(internal.ok, 'built');
  if (internal.ok) assert(!('threadId' in internal.init), 'a null threadId is omitted');

  const normal = buildSessionInit({ rendererId: 'abc', cwd: '/tmp/c', threadId: 'abc', configRoot: root });
  assert(normal.ok, 'built');
  if (normal.ok) assertEqual(normal.init.threadId, 'abc', 'a normal id becomes the thread identity');
});

// ---------------------------------------------------------------------------
// 2. listSessions page nesting.
// ---------------------------------------------------------------------------

const runtimeStateVector = JSON.parse(readFileSync(vectorPath('session-runtime-state-vectors.json'), 'utf8')) as {
  channel: string; workingSessionIds: string[]; excludedSessionIds: string[]; expectedConcurrentCatalogScans: number;
};

h.test('runtime state reads only the host registry and filters hidden conversations', async () => {
  const root = freshRoot(), client = new FakeClient();
  const { service, state } = serviceWith(client, root, undefined, {
    isPrivateThread: id => runtimeStateVector.excludedSessionIds.includes(id),
  });
  for (const id of [...runtimeStateVector.workingSessionIds, ...runtimeStateVector.excludedSessionIds, '__internal']) state.markTurnRunning(id);
  const registry = new ChannelRegistry();
  registerSessionHandlers(registry, { sessions: service, state, events: {} as SessionEventPump,
    configRoot: root, chooseExportPath: async () => undefined });
  const handler = registry.lookup(runtimeStateVector.channel)!;
  const context = { channel: runtimeStateVector.channel, role: 'main' as const, senderId: 1, args: [] };
  assertDeepEqual(await handler(context), { workingSessionIds: runtimeStateVector.workingSessionIds }, 'only visible working conversations are returned');
  state.clearTurnRunning(runtimeStateVector.workingSessionIds[0]!);
  assertDeepEqual(await handler(context), { workingSessionIds: runtimeStateVector.workingSessionIds.slice(1) }, 'the snapshot observes new host state immediately');
  assertEqual(client.calls.length, 0, 'status recovery never attaches to the engine or reads its catalog');
});

h.test('concurrent complete catalog readers share one scan and release it after success or failure', async () => {
  let release!: () => void, started = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class DelayedCatalogClient extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'engine/listSessions') { started++; await gate; }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new DelayedCatalogClient().reply('engine/listSessions', { sessions: { items: [{ id: 'shared' }], nextCursor: null } });
  const { service } = serviceWith(client, freshRoot());
  const readers = [service.listSessions(), service.listSessions(), service.listSessions()];
  await waitFor(() => started > 0, 1000, 'catalog read entered');
  assertEqual(started, runtimeStateVector.expectedConcurrentCatalogScans, 'overlapping readers do not duplicate a storage scan');
  release();
  for (const rows of await Promise.all(readers)) assertEqual(object(rows[0])?.id, 'shared', 'every reader receives the complete snapshot');
  client.reply('engine/listSessions', { sessions: { items: [] } });
  assertDeepEqual(await service.listSessions(), [], 'a settled read never hides later catalog changes');
  client.reply('engine/listSessions', { sessions: { items: [null] } });
  const failed = await Promise.allSettled([service.listSessions(), service.listSessions()]);
  assert(failed.every(result => result.status === 'rejected'), 'invalid replies reject every reader');
  client.reply('engine/listSessions', { sessions: { items: [{ id: 'recovered' }] } });
  assertEqual(object((await service.listSessions())[0])?.id, 'recovered', 'a rejected read does not pin the scope');
});

h.test('active and archived catalog readers keep independent scans', async () => {
  const client = new FakeClient().replySequence('engine/listSessions', [
    { sessions: { items: [{ id: 'active' }] } },
    { sessions: { items: [{ id: 'archived', archived: true }] } },
  ]);
  const { service } = serviceWith(client, freshRoot());
  const [active, archived] = await Promise.all([service.listSessions(), service.listArchivedSessions()]);
  assertEqual(object(active[0])?.id, 'active', 'active scope receives its own rows');
  assertEqual(object(archived[0])?.id, 'archived', 'archived scope receives its own rows');
  assertEqual(client.sent('engine/listSessions').length, 2, 'different scopes are not conflated');
});

h.test('catalog mutations retire older shared reads without letting late snapshots replace recovery state', async () => {
  let release!: () => void, captured = false, fail = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class SnapshotClient extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'engine/listSessions' && fail) throw Error('catalog temporarily unavailable');
      const reply = await super.requestWithTimeout(method, params);
      if (method === 'engine/listSessions' && !captured) { captured = true; await gate; }
      return reply;
    }
  }
  const client = new SnapshotClient().replySequence('engine/listSessions', [
    { sessions: { items: [] } }, { sessions: { items: [{ id: 'restored' }] } },
  ]).replyAcknowledged('session/unarchiveSession', { unarchived: { threadId: 'restored', status: 'restored' } });
  const { service } = serviceWith(client, freshRoot());
  const old = service.listSessions();
  await waitFor(() => captured, 1000, 'old catalog snapshot captured');
  assertEqual(object(await service.setArchived('restored', false))?.ok, true, 'unarchive completes before the next read');
  const refreshed = await service.listSessions();
  assertEqual(object(refreshed[0])?.id, 'restored', 'post-mutation readers do not join the older snapshot');
  release();
  assertDeepEqual(await old, [], 'the older caller receives its captured snapshot');
  fail = true;
  assertEqual(object((await service.listSessions())[0])?.id, 'restored', 'a late stale result cannot overwrite the recovery cache');
});

h.test('listSessions reads the nested page, not a top-level array', async () => {
  const root = freshRoot();
  const client = new FakeClient();
  // The shape the engine actually answers with (wire.rs ThreadPage -> {items, nextCursor},
  // wrapped under `sessions`). A top-level array scan finds nothing here and yields an empty
  // sidebar with no error anywhere — the bug engine.rs:1476-1479 documents.
  client.reply('engine/listSessions', {
    sessions: {
      items: [
        { id: 't1', title: 'First', createdAt: 1, updatedAt: 2, cwd: '/a', model: 'm', role: 'main' },
        { id: 't2', createdAt: 3, updatedAt: 4, cwd: '/b', model: 'm', role: 'main' },
      ],
      nextCursor: null,
    },
  });
  const { service } = serviceWith(client, root);

  const rows = await service.listSessions();
  assertEqual(rows.length, 2, 'both rows were found in the nested page');
  const first = rowAt(rows, 1, 'the older listed row');
  assertEqual(first.id, 't1', 'the id is preserved');
  assertEqual(first.title, 'First', 'and so is the title');
  // A row with no title still gets one, because the renderer indexes the field.
  assertEqual(rowAt(rows, 0, 'the newer listed row').title, '', 'a missing title becomes an empty string');
  // isWorking is overlaid from the HOST's running-turn set, never trusted from the engine.
  assertEqual(first.isWorking, false, 'not working by default');
  assertEqual(client.sent('engine/listSessions').length, 1, 'one page request when there is no cursor');
  assertDeepEqual(
    rowAt(client.sent('engine/listSessions'), 0, 'the list request').options,
    { includeArchived: false },
    'with includeArchived false',
  );
});

h.test('listSessions follows the cursor across pages', async () => {
  const root = freshRoot();
  const client = new FakeClient();
  // Two pages: the first carries a cursor, the second terminates. Reading only one reply would
  // silently show a fraction of the user's conversations.
  client.replySequence('engine/listSessions', [
    { sessions: { items: [{ id: 't1', createdAt: 1, updatedAt: 1, cwd: '/a', model: 'm', role: 'main' }], nextCursor: 'page-2' } },
    { sessions: { items: [{ id: 't2', createdAt: 2, updatedAt: 2, cwd: '/b', model: 'm', role: 'main' }], nextCursor: null } },
  ]);

  const { service } = serviceWith(client, root);
  const rows = await service.listSessions();
  assertEqual(rows.length, 2, 'both pages were collected');
  assertDeepEqual(
    [rowAt(rows, 0, 'page one').id, rowAt(rows, 1, 'page two').id],
    ['t2', 't1'],
    'newest completed work first, after all pages have been collected',
  );
  // The second request must carry the cursor the first page returned.
  const second = rowAt(client.sent('engine/listSessions'), 1, 'the second page request');
  assertDeepEqual(second.options, { includeArchived: false, cursor: 'page-2' }, 'the cursor is forwarded');
});

h.test('catalog page decorates 1000 metadata rows using one settings connection and preserves source watermarks', async () => {
  const root = freshRoot(), rows: Json[] = Array.from({ length: 1000 }, (_, index) => ({
    id: `catalog-${index}`, title: 'Engine title', updatedAt: remoteCatalogVector.catalog.sourceUpdatedAt, workdir: `/engine-project-${index}`,
  }));
  const configuredRoot = join(root, 'custom-worktrees'), nextRoot = join(root, 'next-worktrees');
  const paths = [join(root, 'worktrees', 'default'), join(configuredRoot, 'current'), join(root, 'historical', 'recorded'),
    join(nextRoot, 'future'), join(root, 'sessions', 'catalog-5')];
  paths.forEach((workdir, index) => { rows[index + 1] = { ...object(rows[index + 1]), workdir }; });
  rows[6] = { ...object(rows[6]), workdir: `${join(root, 'historical')}/unused/../recorded` };
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.bindSession('catalog-0', { workdir: '/bound-worktree', projectRoot: '/origin-project' });
  recordInitialSessionRecency('catalog-0', remoteCatalogVector.catalog.savedRecency, root);
  withSettingsDb(root, db => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('worktrees.root', configuredRoot);
    db.exec('CREATE TABLE managed_worktree_origins (path TEXT PRIMARY KEY, repo_root TEXT NOT NULL, git_common_dir TEXT NOT NULL, created_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO managed_worktree_origins VALUES (?, ?, ?, 1)').run(paths[2]!, '/historical-origin', '/historical-origin/.git');
    db.exec('CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT, source TEXT, ai_title_attempted_at INTEGER, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO session_titles VALUES (?, ?, ?, NULL, 1)').run('catalog-0', 'Saved title', 'custom');
  });
  class CatalogClient extends FakeClient {
    scheduling?: RpcRequestOptions;
    override async requestWithTimeout(method: string, params: Json, _timeoutMs?: number, options?: RpcRequestOptions): Promise<unknown> {
      this.scheduling = options; return super.requestWithTimeout(method, params);
    }
  }
  const client = new CatalogClient().reply('engine/listSessions', { sessions: { items: rows, nextCursor: 'opaque-page-2', membershipFingerprint: 'members-v1', metadataFingerprint: 'metadata-v1' } });
  const { service } = serviceWith(client, root, workspaces);
  await service.client();
  let closed = 0;
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function() { closed++; return close.call(this); };
  try {
    const page = await service.catalogPage({ limit: 1000 });
    assertEqual(closed, remoteCatalogVector.catalog.databaseConnectionsPerPage, 'all row decoration shares one database connection');
    assertEqual(page.rows.length, 1000, 'page rows are never truncated');
    assertEqual(client.sent('engine/listSessions').length, 1, 'a page does not eagerly enumerate its cursor');
    assertEqual(page.nextCursor, 'opaque-page-2', 'caller owns the next page');
    assertEqual(page.membershipFingerprint, 'members-v1', 'source membership snapshot remains available for reconciliation');
    assertEqual(page.metadataFingerprint, 'metadata-v1', 'source metadata changes with unchanged recency remain detectable');
    assertDeepEqual(client.scheduling, { priority: remoteCatalogVector.catalog.priority, source: remoteCatalogVector.catalog.source }, 'catalog budget is explicit');
    const saved = page.rows.map(object).find(row => row?.id === 'catalog-0')!;
    assertEqual(saved.title, 'Saved title', 'host title provenance remains authoritative');
    assertEqual(saved.updatedAt, remoteCatalogVector.catalog.savedRecency, 'host sorting clock remains authoritative');
    assertEqual(page.sourceWatermarks['catalog-0'], remoteCatalogVector.catalog.sourceUpdatedAt, 'source scan clock is not overwritten by recency');
    assertEqual(saved.workdir, '/bound-worktree', 'bound workdir is preserved');
    assertEqual(saved.projectRoot, '/origin-project', 'project assignment survives worktree bindings');
    assertEqual(service.isCatalogVisible('catalog-0'), true, 'a cached public row remains visible');
    const projectRoots = (page: { rows: Json[] }) => Array.from({ length: 6 }, (_, index) => page.rows.map(object).find(row => row?.id === `catalog-${index + 1}`)?.projectRoot);
    assertDeepEqual(projectRoots(page), [null, null, '/historical-origin', paths[3], null, '/historical-origin'], 'default, configured, historical, ordinary, scratch and canonicalized paths retain their ownership');
    withSettingsDb(root, db => db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(nextRoot, 'worktrees.root'));
    closed = 0;
    const nextPage = await service.catalogPage({ limit: 1000 });
    assertEqual(closed, remoteCatalogVector.catalog.databaseConnectionsPerPage, 'distinct directories and changed settings still share one page connection');
    assertDeepEqual(projectRoots(nextPage), [null, paths[1], '/historical-origin', null, null, '/historical-origin'], 'the next page observes the changed root while retaining recorded historical ownership');
  } finally { DatabaseSync.prototype.close = close; await service.shutdown(); }
});

h.test('catalog page filters private and archived entries and default pagination is metadata-only', async () => {
  let privateId = 'private';
  const rows: Json[] = [{ id: 'public', updated_at: 7 }, { id: 'private', updatedAt: 8 }, { id: '__internal', updatedAt: 9 }, { id: 'archived', archived: true }];
  const client = new FakeClient().reply('engine/listSessions', { sessions: { items: rows, nextCursor: null } });
  const { service, state } = serviceWith(client, freshRoot(), undefined, { isPrivateThread: id => id === privateId });
  const page = await service.catalogPage();
  assertDeepEqual(page.rows.map(row => object(row)?.id), ['public'], 'only public active metadata is published');
  assertDeepEqual(page.sourceWatermarks, { public: 7 }, 'hidden row identifiers do not escape through watermark metadata');
  assertDeepEqual(client.sent('engine/listSessions'), [{ options: { includeArchived: false, limit: remoteCatalogVector.catalog.defaultPageSize } }], 'bounded source request');
  assertEqual(state.bindings().length, 0, 'metadata does not activate sessions');
  privateId = 'public';
  assertEqual(service.isCatalogVisible('public'), false, 'cached metadata rechecks current private ownership');
  assertEqual(await service.catalogRow('public'), null, 'private targeted reads stop before engine access');
  assertEqual(client.sent('engine/readSessionSummary').length, 0, 'no private metadata facade invocation');
  await service.shutdown();
});

h.test('targeted metadata lookup reads one summary without a catalog scan and validates absence and identity', async () => {
  const client = new FakeClient().reply('engine/readSessionSummary', { session: { id: 'target', title: 'Known', updatedAt: 1 } });
  const { service, state } = serviceWith(client, freshRoot());
  assertEqual((await service.threadRow('target')).title, 'Known', 'the requested metadata is returned');
  assertDeepEqual(client.sent(remoteCatalogVector.catalog.summaryMethod), [{ sessionId: 'target' }], 'the named summary facade receives only the target');
  assertEqual(client.sent('engine/listSessions').length, 0, 'point lookups never scan all task pages');
  assertEqual(state.bindings().length, 0, 'point lookup does not open a session');
  client.reply('engine/readSessionSummary', { session: null });
  assertEqual(await service.catalogRow('target'), null, 'confirmed missing metadata becomes a catalog tombstone');
  client.reply('engine/readSessionSummary', { session: { id: 'target', archived: true } });
  assertEqual(await service.catalogRow('target'), null, 'archive becomes an active-catalog tombstone');
  const invalidSummaries: Json[] = [{}, { session: { id: 'other' } }, { session: [] }];
  for (const invalid of invalidSummaries) {
    client.reply('engine/readSessionSummary', invalid);
    const error = await assertRejects(() => service.threadRow('target'), 'invalid metadata must not mean absent') as { code: string };
    assertEqual(error.code, 'INVALID_ENGINE_RESPONSE', 'malformed metadata remains an explicit failure');
  }
  client.reply('engine/readSessionSummary', { error: 'Read denied', errorDetail: { code: 'READ_DENIED' } });
  const refused = await assertRejects(() => service.catalogRow('target'), 'read refusal cannot erase a cached row') as { code: string };
  assertEqual(refused.code, 'READ_DENIED', 'source refusal is preserved');
  await service.shutdown();
});

function savedRecency(root: string, id: string): number | undefined {
  return withSettingsDb(root, db => {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_recency'").get()) return undefined;
    const value = db.prepare('SELECT sort_at FROM session_recency WHERE session_id=?').get(id)?.sort_at;
    return typeof value === 'number' ? value : undefined;
  });
}

h.test('session recency reuses stored clocks and freezes imported clocks across metadata writes and reopen', async () => {
  const root = freshRoot(), workspacePath = join(root, 'project');
  // The installed profile already has this schema. Its clock must win over rollout mtime.
  withSettingsDb(root, db => {
    db.exec('CREATE TABLE session_recency (session_id TEXT PRIMARY KEY, sort_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO session_recency VALUES (?, ?)').run('stored', 1000);
  });
  const client = new FakeClient().reply('engine/listSessions', { sessions: { items: [
    { id: 'stored', title: 'Custom title', createdAt: 500, updatedAt: 9000 },
    { id: 'imported', title: 'Imported title', createdAt: 700, updatedAt: 2000 },
    { id: 'created-only', createdAt: 1500 },
  ], nextCursor: null } });
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.save({ id: 'group', name: 'Group', roots: [workspacePath] });
  workspaces.bindSession('stored', { workspaceId: 'group' });
  const { service } = serviceWith(client, root, workspaces);
  const first = await service.listSessions();
  assertDeepEqual(first.map(row => [rowAt([row], 0, 'row').id, rowAt([row], 0, 'row').updatedAt]),
    [['imported', 2000], ['created-only', 1500], ['stored', 1000]], 'persisted clock, imported baseline and creation fallback share one order');
  const projectRow = rowAt(first, 2, 'workspace conversation');
  assertEqual(projectRow.workspaceId, 'group', 'group membership survives the recency overlay');
  assertEqual(projectRow.workdir, workspacePath, 'group sorting receives the persisted conversation clock');
  assertEqual(projectRow.title, 'Custom title', 'metadata titles are preserved');
  client.reply('engine/listSessions', { sessions: { items: [
    { id: 'stored', title: 'Renamed title', createdAt: 500, updatedAt: 19000, archived: true },
    { id: 'imported', title: 'Imported title', createdAt: 700, updatedAt: 29000, archived: true },
  ], nextCursor: null } });
  const reopened = serviceWith(client, root, workspaces).service;
  const refreshed = await reopened.listArchivedSessions();
  assertDeepEqual(refreshed.map(row => [rowAt([row], 0, 'row').id, rowAt([row], 0, 'row').updatedAt]),
    [['imported', 2000], ['stored', 1000]], 'archive/reopen and new file timestamps cannot rewrite durable recency');
  assertEqual(rowAt(refreshed, 1, 'renamed row').title, 'Renamed title', 'title updates still reach the row');
  await Promise.all([service.shutdown(), reopened.shutdown()]);
});

h.test('new conversations persist their creation clock before rollout data exists', async () => {
  const root = byoRoot(), client = new FakeClient().reply('session/start', { sessionId: 'live-new' });
  const { service } = serviceWith(client, root);
  const row = await service.newSession() as Record<string, Json>, id = String(row.id);
  assertEqual(savedRecency(root, id), row.createdAt, 'creation time is durable even without a list request');
  client.reply('engine/listSessions', { sessions: { items: [{ id, createdAt: 1, updatedAt: Number(row.createdAt) + 60000 }], nextCursor: null } });
  assertEqual(rowAt(await service.listSessions(), 0, 'new conversation').updatedAt, row.createdAt, 'first rollout write cannot move the conversation');
  recordInitialSessionRecency(id, Number(row.createdAt) + 120000, root);
  assertEqual(savedRecency(root, id), row.createdAt, 'initialization never overwrites an existing clock');
  await service.shutdown();
});

h.test('completed-reply recency follows the committed termination cases through the engine receiver', async () => {
  const vector = JSON.parse(readFileSync(vectorPath('turn-termination-vectors.json'), 'utf8')) as {
    sidebarRecency: { completionCases: Array<{ name: string; result: Json; advancesRecency: boolean }> };
  };
  for (const [index, scenario] of vector.sidebarRecency.completionCases.entries()) {
    const root = freshRoot(), client = new FakeClient(), completedAt = 2000 + index;
    recordInitialSessionRecency('conversation', 1000, root);
    const { service, state, pushed } = serviceWith(client, root, undefined, { recencyClock: () => completedAt });
    state.rememberSession('conversation', 'engine-session', {});
    await service.client();
    client.emit('event', { type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: `turn-${index}`, result: scenario.result } });
    assertEqual(savedRecency(root, 'conversation'), scenario.advancesRecency ? completedAt : 1000, scenario.name);
    assertDeepEqual(pushed, scenario.advancesRecency ? [{ type: 'session_recency_updated', sessionId: 'conversation' }] : [], `${scenario.name}: only durable completion asks the sidebar to refresh`);
    await service.shutdown();
  }
});

h.test('queued completion updates recency before observers and duplicate or backward clocks cannot reorder again', async () => {
  const root = freshRoot(), client = new FakeClient();
  let now = 2000;
  const observed: Array<number | undefined> = [];
  recordInitialSessionRecency('conversation', 1000, root);
  const { service, state, pushed } = serviceWith(client, root, undefined, {
    recencyClock: () => now,
    onEvent: event => { if (event.type === 'turnCompleted') observed.push(savedRecency(root, 'conversation')); },
  });
  state.rememberSession('conversation', 'engine-session', {});
  state.markTurnRunning('conversation', 'queued-turn');
  await service.client();
  const completed = { type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'previous-turn', result: { stopReason: 'completed', finalText: 'Done' } } };
  client.emit('event', completed);
  assertEqual(state.runningTurnId('conversation'), 'queued-turn', 'the next turn remains active');
  await waitFor(() => observed.length === 1, 1000, 'empty queue admission releases the terminal observer');
  assertDeepEqual(observed, [2000], 'the terminal observer reads committed recency');
  assertDeepEqual(pushed, [{ type: 'session_recency_updated', sessionId: 'conversation' }], 'queued continuation still receives its own completion refresh');
  now = 3000; client.emit('event', completed);
  assertEqual(savedRecency(root, 'conversation'), 2000, 'duplicate delivery cannot advance the same completed turn twice');
  assertEqual(pushed.length, 1, 'duplicate delivery adds no recency refresh');
  now = 1500;
  client.emit('event', { ...completed, params: { ...completed.params, turnId: 'later-turn' } });
  assertEqual(savedRecency(root, 'conversation'), 2000, 'a backward wall clock cannot rewind completed work');
  recordCompletedSessionReply('conversation', 0, root);
  assertEqual(savedRecency(root, 'conversation'), 2000, 'an invalid completion clock cannot erase recency');
  await service.shutdown();
});

h.test('unowned, private and stale-generation terminal events cannot create recency metadata', async () => {
  const root = freshRoot(), client = new FakeClient();
  const { service, state, pushed } = serviceWith(client, root, undefined, { isPrivateThread: id => id === 'private', recencyClock: () => 5000 });
  state.rememberSession('private', 'engine-private', {});
  state.rememberSession('__internal', 'engine-internal', {});
  state.rememberSession('public', 'engine-public', {});
  await service.client();
  const lateReceive = client.listeners('event')[0];
  assert(lateReceive !== undefined, 'engine event observer installed');
  const eventFor = (id: string) => ({ type: 'turnCompleted', params: { sessionId: id, turnId: 'turn', result: { stopReason: 'completed', finalText: 'Done' } } });
  for (const id of ['unowned', 'engine-private', 'engine-internal']) client.emit('event', eventFor(id));
  assertDeepEqual(pushed, [], 'hidden or unknown ownership never reaches the sidebar');
  for (const id of ['unowned', 'private', '__internal']) assertEqual(savedRecency(root, id), undefined, `${id}: no durable recency record`);
  client.emit('event', { type: 'streamClosed' });
  lateReceive!(eventFor('engine-public'));
  assertEqual(savedRecency(root, 'public'), undefined, 'a detached engine cannot stamp a later completion');
  await service.shutdown();
});

h.test('only acknowledged deletion removes owned recency and late events cannot recreate it', async () => {
  const root = freshRoot(), client = new FakeClient().reply('session/close', {});
  const { service, state } = serviceWith(client, root);
  recordInitialSessionRecency('target', 1000, root);
  recordInitialSessionRecency('unrelated', 2000, root);
  state.rememberSession('target', 'engine-target', {});
  client.replyAcknowledged('session/deleteSession', { deleted: { threadId: 'target', deleted: false } });
  await assertRejects(() => service.deleteSession('target'), 'unconfirmed deletion must retain history metadata');
  assertEqual(savedRecency(root, 'target'), 1000, 'failed deletion retains recency for reopening');
  client.replyAcknowledged('session/deleteSession', { deleted: { threadId: 'target', deleted: true } });
  await service.deleteSession('target');
  assertEqual(savedRecency(root, 'target'), undefined, 'confirmed deletion removes only the target clock');
  assertEqual(savedRecency(root, 'unrelated'), 2000, 'unrelated conversation clock survives');
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'engine-target', turnId: 'late', result: { stopReason: 'completed', finalText: 'Late reply' } } });
  assertEqual(savedRecency(root, 'target'), undefined, 'late terminal delivery cannot recreate deleted metadata');
  await service.shutdown();
});

h.test('private diagnostics stay outside lists, observers, direct history and mutations', async () => {
  const observed: string[] = [];
  const client = new FakeClient().reply('engine/listSessions', { sessions: { items: [
    { id: 'private-diagnostic', role: 'main', createdAt: 1, updatedAt: 1, archived: true },
    { id: 'public-thread', role: 'main', createdAt: 2, updatedAt: 2 },
  ], nextCursor: null } });
  const { service } = serviceWith(client, freshRoot(), undefined, {
    isPrivateThread: id => id === 'private-diagnostic', onThreadRow: row => { observed.push(String(row.id)); },
  });
  assertDeepEqual((await service.listSessions()).map(row => rowAt([row], 0, 'public row').id), ['public-thread'], 'only public conversations are listed');
  assertDeepEqual(await service.listArchivedSessions(), [], 'private archives stay hidden');
  assertDeepEqual(observed, ['public-thread', 'public-thread'], 'private titles are not observed');
  for (const run of [() => service.threadRow('private-diagnostic'), () => service.history('private-diagnostic'),
    () => service.exportMessages('private-diagnostic'), () => service.rename('private-diagnostic', 'new title'),
    () => service.directory('private-diagnostic')]) {
    const error = await assertRejects(run, 'private diagnostic lookup') as { code: string };
    assertEqual(error.code, 'SESSION_NOT_FOUND', 'the same public lookup error is returned');
  }
  assertEqual(client.calls.length, 2, 'no private lookup or mutation reached the engine');
  await service.shutdown();
});

h.test('all concurrent callers wait for engine recovery and a failed recovery can be retried', async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let recovery = 0;
  const client = new FakeClient().reply('engine/listSessions', { sessions: { items: [], nextCursor: null } });
  const { service } = serviceWith(client, freshRoot(), undefined, { onAttached: async () => {
    recovery++;
    if (recovery === 1) { entered(); await barrier; throw new Error('Owned diagnostic cleanup failed'); }
  } });
  const first = service.listSessions(); await started;
  const second = service.listSessions();
  await Promise.resolve();
  assertEqual(client.sent('engine/listSessions').length, 0, 'a second caller cannot bypass the recovery barrier');
  const results = Promise.allSettled([first, second]); release();
  assertDeepEqual((await results).map(result => result.status), ['rejected', 'rejected'], 'failed recovery is reported to every waiter');
  assertDeepEqual(await service.listSessions(), [], 'the same managed endpoint can retry recovery');
  assertEqual(recovery, 2, 'the failed endpoint is not exposed without retrying');
  assertEqual(client.listenerCount('event'), 1, 'the rejected recovery left no duplicate event listener');
  await service.shutdown();
});

h.test('list failures reject and retain the engine error code', async () => {
  const client = new FakeClient(), { service } = serviceWith(client, freshRoot());
  await assertRejects(() => service.listSessions(), 'a transport failure must not become an empty list');
  client.reply('engine/listSessions', { error: 'Read denied', errorDetail: { code: 'READ_DENIED' } });
  const error = await assertRejects(() => service.listSessions(), 'an engine error must reject') as {code: string};
  assertEqual(error.code, 'READ_DENIED', 'the actionable error code is retained');
  client.reply('engine/listSessions', { sessions: { items: [], nextCursor: null } });
  assertDeepEqual(await service.listSessions(), [], 'an actual empty page is a successful snapshot');
  client.closed = true;
  await assertRejects(() => service.listArchivedSessions(), 'a disconnected client must not erase archived rows');
});

h.test('a cold-start list failure restores the last validated sidebar without a stale spinner', async () => {
  const root = freshRoot();
  const firstClient = new FakeClient().reply('engine/listSessions', { sessions: { items: [
    { id: 'cached-thread', title: 'Cached conversation', createdAt: 1, updatedAt: 2 },
  ], nextCursor: null } });
  const first = serviceWith(firstClient, root);
  first.state.markTurnRunning('cached-thread', 'old-process-turn');
  assertEqual(rowAt(await first.service.listSessions(), 0, 'live snapshot').isWorking, true, 'the live process state is projected while connected');
  await first.service.shutdown();

  const secondClient = new FakeClient();
  const second = serviceWith(secondClient, root);
  const restored = await second.service.listSessions();
  assertEqual(rowAt(restored, 0, 'restored snapshot').title, 'Cached conversation', 'cold startup retains the last validated row');
  assertEqual(rowAt(restored, 0, 'restored snapshot').isWorking, recoveryVectors.cachedWorkingState, 'a process-local running flag is never persisted');
  assertEqual(secondClient.sent('engine/listSessions').length, 1, 'the engine was attempted before recovery');
  await second.service.shutdown();
});

h.test('malformed session pages reject using the committed vectors', async () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../tests/vectors/session-pages.json'), 'utf8')) as {invalid:Json[]};
  for (const reply of vectors.invalid) {
    const client = new FakeClient().reply('engine/listSessions', reply);
    const { service } = serviceWith(client, freshRoot());
    const error = await assertRejects(() => service.listSessions(), 'malformed page ' + JSON.stringify(reply)) as {code:string};
    assertEqual(error.code, 'INVALID_ENGINE_RESPONSE', 'malformed data is explicit');
  }
});

h.test('failed later pages reject the entire conversation snapshot', async () => {
  const client = new FakeClient().replySequence('engine/listSessions', [
    { sessions: { items: [{ id: 'first' }], nextCursor: 'missing-page' } },
  ]);
  const { service } = serviceWith(client, freshRoot());
  await assertRejects(() => service.listSessions(), 'partial rows must not become an authoritative result');
  assertEqual(client.sent('engine/listSessions').length, 2, 'the failure occurs after a real first page');
});

h.test('repeated cursors and the page limit reject without returning partial rows or false not-found', async () => {
  const repeated = new FakeClient().reply('engine/listSessions', { sessions: { items: [{id:'first'}], nextCursor: 'repeat' } });
  const error = await assertRejects(() => serviceWith(repeated, freshRoot()).service.listSessions(), 'repeated cursor') as {code:string};
  assertEqual(error.code, 'INVALID_ENGINE_RESPONSE', 'repetition is reported');
  assertEqual(repeated.sent('engine/listSessions').length, 2, 'repetition stops promptly');
  {
    const client = new FakeClient().replySequence('engine/listSessions', Array.from({ length: 50 }, (_, i) => ({ sessions: { items: [], nextCursor: 'page-' + i } })));
    const { service } = serviceWith(client, freshRoot());
    const error = await assertRejects(() => service.listArchivedSessions(), 'unbounded cursor') as {code:string};
    assertEqual(error.code, 'INVALID_ENGINE_RESPONSE', 'a truncated search is not proof of an absent conversation');
    assertEqual(client.sent('engine/listSessions').length, 50, 'pagination stays bounded');
  }
});

h.test('configured MCP declarations cannot replace task-bound managed capabilities', async () => {
  const managed = { mcpServers: [{ name: 'klaus-browser', transport: 'http', url: 'http://127.0.0.1/private-task-token' }], runtimeCapabilityRoots: [{ id: 'klaus-browser' }] };
  const combined = combineHostCapabilities([{ name: 'docs', transport: 'stdio', command: 'docs-server' }], [managed]);
  assertDeepEqual((combined.mcpServers as Json[]).map(row => (row as {name:string}).name), ['docs', 'klaus-browser'], 'both namespaces reach init and reload');
  assertDeepEqual(combined.runtimeCapabilityRoots, managed.runtimeCapabilityRoots, 'managed roots retain their owner');
  const error = await assertRejects(async () => combineHostCapabilities([{ name: 'klaus-browser', transport: 'http', url: 'https://foreign.invalid' }], [managed]), 'a duplicate must not replace the task-bound capability') as {code:string};
  assertEqual(error.code, 'MCP_NAME_CONFLICT', 'the conflict is explicit');
});

h.test('saved capability changes refresh idle tasks without failing on running or unavailable tasks', async () => {
  const attempted: string[] = [];
  const outcomes = await refreshIdleHostCapabilities(
    capabilityRefreshVectors.bindings,
    id => capabilityRefreshVectors.bindings.find(binding => binding.rendererId === id)?.working === true,
    async id => {
      attempted.push(id);
      const mode = capabilityRefreshVectors.bindings.find(binding => binding.rendererId === id)?.reload;
      if (mode === 'failure') throw new Error('fixture live reload refused');
      return mode === 'success';
    },
  );
  assertDeepEqual(outcomes.map(({ rendererId, status }) => ({ rendererId, status })), capabilityRefreshVectors.expected, 'durable configuration outcome is independent from best-effort live refresh');
  assertDeepEqual(attempted, capabilityRefreshVectors.attempted, 'running and stale tasks are never mutated');
});

h.test('session capability reload defers while a turn is running', async () => {
  const client = new FakeClient().replyAcknowledged('session/reloadMcpServers', { mcpRuntime: { runtime: { servers: [] } } });
  const { service, state } = serviceWith(client, freshRoot(), undefined, {
    hostCapabilities: async () => ({ mcpServers: [], runtimeCapabilityRoots: [] }),
  });
  await service.client();
  state.rememberSession('thread', 'live', { cwd: '/fixture' });
  state.markTurnRunning('thread', 'active-turn');
  assertEqual(await service.reloadHostCapabilities('thread'), false, 'running task defers its capability snapshot');
  assertEqual(client.sent('session/reloadMcpServers').length, 0, 'engine never receives a forbidden mid-turn MCP mutation');
});

h.test('MCP changes during session startup are reconciled before the conversation opens', async () => {
  let revision = 0, reads = 0;
  const client = new FakeClient().reply('session/start', { sessionId: 'live-mcp' })
    .replyAcknowledged('session/reloadMcpServers', { mcpRuntime: { runtime: { servers: [] } } });
  const { service } = serviceWith(client, byoRoot(), undefined, {
    hostCapabilitiesRevision: () => revision,
    hostCapabilities: async () => {
      reads++; if (reads === 1) revision++;
      return { mcpServers: [{ name: reads === 1 ? 'old' : 'new', transport: 'stdio', command: 'fixture' }], runtimeCapabilityRoots: [] };
    },
  });
  const row = await service.newSession();
  assert(rowAt([row], 0, 'the conversation').id, 'the conversation opens after reconciliation');
  const reload = rowAt(client.sent('session/reloadMcpServers'), 0, 'the terminal reload');
  assertEqual(reload.sessionId, 'live-mcp', 'the current engine binding is used');
  assertEqual((reload.servers as Array<{name:string}>)[0]?.name, 'new', 'the saved update cannot be lost behind startup');
});

h.test('failed declaration reads preserve an existing binding and never send an empty reload', async () => {
  const client = new FakeClient();
  const { service, state } = serviceWith(client, freshRoot(), undefined, { hostCapabilities: async () => { throw new Error('Damaged project MCP JSON'); } });
  await service.client(); state.rememberSession('thread', 'live', { cwd: '/fixture' });
  await assertRejects(() => service.reloadHostCapabilities('thread'), 'a damaged file must not disconnect healthy servers');
  assertEqual(state.liveSession('thread'), 'live', 'the live binding survives');
  assertEqual(client.sent('session/reloadMcpServers').length, 0, 'no empty declaration is sent');
  assertEqual(await service.reloadHostCapabilities('missing'), false, 'a reload never creates an unknown session');
  assertEqual(client.sent('session/start').length, 0, 'no temporary engine session');
});

h.test('MCP reload and conversation deletion cannot race their engine binding', async () => {
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
  const client = new FakeClient().replyAcknowledged('session/reloadMcpServers', { mcpRuntime: { runtime: { servers: [] } } })
    .reply('session/close', null).replyAcknowledged('session/deleteSession', { deleted: { threadId: 'thread', deleted: true } });
  const { service, state } = serviceWith(client, freshRoot(), undefined, { hostCapabilities: async () => {
    entered(); await paused; return { mcpServers: [], runtimeCapabilityRoots: [] };
  } });
  await service.client(); state.rememberSession('thread', 'live', { cwd: '/fixture' });
  const reload = service.reloadHostCapabilities('thread'); await reading;
  const deleting = service.deleteSession('thread');
  await Promise.resolve(); assertEqual(client.sent('session/close').length, 0, 'close waits until the admitted reload settles');
  release(); await reload; await deleting;
  const methods = client.calls.map(call => call.method);
  assert(methods.indexOf('session/reloadMcpServers') < methods.indexOf('session/close'), 'terminal reload precedes close');
  assertEqual(state.liveSession('thread'), undefined, 'deletion removes the binding');
});

// ---------------------------------------------------------------------------
// 3. deleteSession params.
// ---------------------------------------------------------------------------

h.test('deleteSession sends threadId, and runs with no live binding', async () => {
  const root = freshRoot();
  const client = new FakeClient();
  client.replyAcknowledged('session/deleteSession', { deleted: { threadId: 'thread-9', deleted: true } });
  const { service, state } = serviceWith(client, root);

  // A sidebar thread that was never opened this run has NO live binding — the common case.
  assertEqual(state.liveSession('thread-9'), undefined, 'no binding exists');
  await service.deleteSession('thread-9');

  const sent = client.sent('session/deleteSession');
  assertEqual(sent.length, 1, 'the delete was still issued');
  // `threadId`, NOT `sessionId` (SessionThreadParams, wire.rs:1113-1131), and it is the
  // RENDERER id: that uuid IS the persistent thread identity the engine adopted.
  assertDeepEqual(sent[0], { threadId: 'thread-9' }, 'by threadId, naming the renderer id');
});

h.test('deleteSession propagates deletion failure instead of reporting success', async () => {
  const root = freshRoot();
  const client = new FakeClient();
  const { service, state } = serviceWith(client, root);
  state.rememberSession('r1', 'engine-1', {});
  assertEqual(state.liveSession('r1'), 'engine-1', 'bound');

  client.reply('session/close', {});
  client.replyAcknowledged('session/deleteSession', { error: 'permission denied' });
  const error = await assertRejects(() => service.deleteSession('r1'), 'ACK is not successful deletion');
  assert(String(error).includes('permission denied'), 'the storage failure stays visible');
  assertEqual(state.liveSession('r1'), undefined, 'the closed engine handle is no longer reused');
});

// ---------------------------------------------------------------------------
// 4. steer submissionId.
// ---------------------------------------------------------------------------

h.test('followUp sends a prefixed submissionId and returns the bare messageId', async () => {
  const root = freshRoot();
  const client = new FakeClient();
  client.replySubmit('steer');
  const { service, state, pushed } = serviceWith(client, root);

  // Steering needs a connected running turn, or the composer's follow-up offer is stale.
  await service.client();
  state.markTurnRunning('r1', 'turn-1');
  state.rememberSession('r1', 'engine-1', {});

  const result = await service.followUp('r1', { text: 'also check the tests' }) as Record<string, Json>;
  assertEqual(result.ok, true, 'accepted');
  const messageId = result.messageId as string;
  assert(typeof messageId === 'string' && messageId.length > 0, 'a messageId came back');

  const sent = rowAt(client.sentSubmit('steer'), 0, 'the steer request');
  // main.rs:6842-6844: the engine's submissionId is "steer-" + the messageId the renderer
  // gets. The prefix is what lets the host correlate the engine's reply envelope back to THIS
  // follow-up card rather than to any other in-flight steer.
  assertEqual(sent.submissionId, `steer-${messageId}`, 'the submissionId is the prefixed messageId');
  // Explicit steer mode binds this input to the captured running turn.
  assertEqual(sent.mode, 'steer', 'targeted running-turn admission');
  assertEqual(sent.expectedTurnId, 'turn-1', 'steer binds the captured turn');
  assertEqual(sent.queueMessageId, messageId, 'durable queue identity equals the user message identity');
  // The steer lands in history as its own user message; the leading marker block is what
  // later tells that row apart from a message that OPENED a turn (the edit rule's
  // distinction), and every user-facing projection strips it back off.
  assertDeepEqual(sent.input, [
    { type: 'text', text: '<!-- klaus-steered-message -->' },
    { type: 'text', text: 'also check the tests' },
  ], 'the marker block leads the steered input');
  assertEqual(sent.sessionId, 'engine-1', 'addressed by the ENGINE session id');
  assert(!pushed.some(value => (value as Record<string, Json>).state === 'applied'), 'admission does not apply the input');
  client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'engine-1', event: { submissionId: sent.submissionId, steered: { applied: true } } } });
  await waitFor(() => pushed.some(value => (value as Record<string, Json>).state === 'applied'), 1000, 'delivery completion');
  assertDeepEqual(pushed.filter(value => (value as Record<string, Json>).type === 'follow_up_status'), [
    { type: 'follow_up_status', sessionId: 'r1', messageId, text: 'also check the tests', state: 'engine_queued' },
    { type: 'follow_up_status', sessionId: 'r1', messageId, text: 'also check the tests', state: 'applied' },
  ], 'admission and application are separate, correlated renderer events');
  await service.shutdown();
});

h.test('production turn aliases keep UI UUID distinct from the facade ID used for follow-ups', async () => {
  const root = byoRoot(), client = new FakeClient().replySubmit('steer');
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('r1', 'engine-1', {}); state.markTurnRunning('r1', 'facade-turn');
  const pump = new SessionEventPump({ state, currentGeneration: () => 1, emit: () => {}, log: () => {},
    forwarder: new ChatEventForwarder(() => {}) });
  pump.receive({ type: 'productEvent', method: 'turn/started', params: { sessionId: 'engine-1',
    submissionId: 'facade-turn', detail: { type: 'turn.started', turnId: 'core-turn-uuid' } } }, 1);
  assertEqual(state.runningTurnId('r1'), 'core-turn-uuid', 'the UI keeps the actual engine turn UUID');
  assertEqual(state.runningSubmissionId('r1'), 'facade-turn', 'wire admission keeps the facade ID');
  assertEqual(object(await service.followUp('r1', { text: 'follow live core turn' }))?.ok, true, 'aliased turn accepts follow-up');
  const request = rowAt(client.sentSubmit('steer'), 0, 'aliased steer');
  assertEqual(request.expectedTurnId, 'facade-turn', 'strict engine fence receives its own canonical identity');
  pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-1', turnId: 'facade-turn', result: { stopReason: 'aborted' } } }, 1);
  assertEqual(state.runningSubmissionId('r1'), undefined, 'terminal releases the wire alias');
  await service.shutdown();
});

h.test('followUp rechecks the captured turn after delayed attachment preparation', async () => {
  const root = byoRoot(), client = new FakeClient();
  let prepared!: (value: Json) => void;
  const { service, state } = serviceWith(client, root, undefined, { messageInput: () => new Promise(resolve => { prepared = resolve; }) });
  await service.client();
  state.markTurnRunning('r1', 'old-turn'); state.rememberSession('r1', 'engine-1', {});
  const reply = service.followUp('r1', { text: 'late follow-up' });
  await waitFor(() => typeof prepared === 'function', 1000, 'input preparation began');
  state.clearTurnRunning('r1');
  prepared('late follow-up');
  const result = object(await reply);
  assertEqual(result?.ok, false, 'a finished turn cannot admit a late steer');
  assertEqual(client.sentSubmit('steer').length, 0, 'late input never reaches the idle engine queue');
  await service.shutdown();
});

h.test('active input bypasses a pending title receipt without losing queue ownership', async () => {
  const client = new FakeClient().replySubmit('steer')
    .reply('session/updateTitle', { title: { threadId: 'thread', title: 'Renamed while running' } });
  const { service, state, pushed } = serviceWith(client, byoRoot());
  await service.client(); state.rememberSession('thread', 'live', {}); state.markTurnRunning('thread', 'active');
  let release!: () => void, titleEntered = false, titleFinished = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method === 'session/updateTitle') { titleEntered = true; await gate; }
    return original(method, params);
  };
  const renaming = service.rename('thread', 'Renamed while running').then(result => { titleFinished = true; return result; });
  try {
    await waitFor(() => titleEntered, 1000, 'title persistence holds the lifecycle mutation');
    await service.clientQueueAdd('thread', { id: 'behind-title', item: { text: 'Queued during title persistence' } });
    let delivered: Json | undefined;
    const delivery = service.clientQueueDeliver('thread', 'behind-title', undefined, 'active', true).then(value => { delivered = value; });
    await waitFor(() => delivered !== undefined, 1000, 'queued steer admission is independent of the pending title receipt');
    await delivery;
    assertEqual(object(delivered)?.ok, true, 'the captured running turn admits its queued input');
    assertEqual(titleFinished, false, 'title persistence is still waiting');
    assertEqual(object(object(await service.clientQueueSnapshot('thread'))?.snapshot)?.items instanceof Array, true, 'the durable queue remains readable');
    assertEqual((object(object(await service.clientQueueSnapshot('thread'))?.snapshot)?.items as Json[]).length, 0, 'accepted input releases its durable claim');
    assertEqual(client.sentQueue('steer').length, 1, 'exactly one atomic queued steer was issued');
    const steer = rowAt(client.sentQueue('steer'), 0, 'title-independent steer');
    assertEqual(steer.expectedTurnId, 'active', 'the original running identity stays fenced');
    const messageId = 'another-pending-input';
    state.installQueueSnapshot('thread', { revision: 1, status: 'authoritative', items: [{ state: 'pending', mutable: true, message: { uuid: messageId, value: 'Another pending input' } }] });
    const engineQueue = new SessionQueue(service, state);
    let recovered: Record<string, Json> | undefined;
    const reading = engineQueue.snapshot('thread').then(value => { recovered = value; });
    await waitFor(() => recovered !== undefined, 1000, 'a replacement renderer can recover the engine queue while title persistence waits');
    await reading; assertEqual(recovered?.ok, true, 'the authoritative pending UUID remains readable');
    client.reply('session/removeQueued', { queueMutation: { status: 'applied', snapshot: { revision: 2, status: 'authoritative', items: [] } } });
    const removed = await engineQueue.mutate('remove', { sessionId: 'thread', request: { uuid: messageId, mutationId: 'during-title' } });
    assertEqual(removed.ok, true, 'pending input remains removable without waiting for unrelated metadata');
    assertEqual(titleFinished, false, 'queue read and mutation do not release or bypass the title receipt');
    for (let index = 0; index < 2; index++) client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: steer.submissionId, steered: { applied: true } } } });
    assertEqual(pushed.filter(event => object(event)?.state === 'applied').length, 1, 'duplicate late receipts apply the input once');
  } finally { release(); await renaming; await service.shutdown(); }
});

h.test('active input refuses a changed or disconnected binding after asynchronous preparation', async () => {
  for (const outcome of ['rebound', 'closed'] as const) {
    const client = new FakeClient().replySubmit('steer');
    let prepared!: (value: Json) => void;
    const { service, state } = serviceWith(client, byoRoot(), undefined, { messageInput: () => new Promise(resolve => { prepared = resolve; }) });
    await service.client(); state.rememberSession('thread', 'live', {}); state.markTurnRunning('thread', 'active');
    const sending = service.followUp('thread', { text: 'Prepared for the original binding' });
    const refused = assertRejects(() => sending, 'a retired binding cannot accept prepared input');
    await waitFor(() => Boolean(prepared), 1000, 'asynchronous input preparation begins');
    if (outcome === 'rebound') state.rememberSession('thread', 'replacement-live', {}); else client.closed = true;
    prepared('Prepared for the original binding'); await refused;
    assertEqual(client.sentSubmit('steer').length, 0, 'the retired input never reaches an engine');
    await service.shutdown();
  }
});

h.test('Continue without queued input starts from history and rejects a duplicate while running', async () => {
  const client = new FakeClient().replySubmit('start-if-idle');
  const { service, state, pushed } = serviceWith(client, byoRoot());
  state.rememberSession('r1', 'engine-1', {});
  const vector = JSON.parse(readFileSync(vectorPath('turn-termination-vectors.json'), 'utf8')) as {
    channels: { resume: { facade: string; mode: string; input: Json } };
  };
  try {
    assertDeepEqual(await service.continueTurn('r1'), { ok: true }, 'continuation is admitted');
    const request = object(client.sent(vector.channels.resume.facade)[0])!;
    assertEqual(request.mode, vector.channels.resume.mode, 'continuation has an explicit admission mode');
    assertDeepEqual(request.input, vector.channels.resume.input, 'no user input is replayed or synthesized');
    assertEqual(client.sent('session/resumeQueued').length, 0, 'an empty queue does not need a queued-input resume');
    assertEqual(pushed.filter(event => object(event)?.type === 'user_message').length, 0, 'continuing adds no synthetic user bubble');
    assertEqual(state.runningSubmissionId('r1'), request.submissionId, 'the new turn retains its admission identity');
    const error = await assertRejects(() => service.continueTurn('r1'), 'a running continuation cannot be started twice');
    assertEqual((error as { code: string }).code, 'TURN_IN_PROGRESS', 'busy continuation is refused');
    assertEqual(client.sent('turn/submit').length, 1, 'duplicate Continue never issues another turn');
  } finally { await service.shutdown(); }
});

h.test('explicit Continue consumes pending engine input once and only continues history after a confirmed empty queue', async () => {
  for (const started of [true, false]) {
    const root = byoRoot(), client = new FakeClient();
    const original = client.requestWithTimeout.bind(client);
    client.requestWithTimeout = async (method, params) => {
      if (method === 'session/resumeQueued') {
        client.calls.push({ method, params });
        const request = object(params)!;
        client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'engine-1', event: {
          submissionId: request.submissionId, pendingResume: { started, ...(started ? {} : { reason: 'empty' }) },
        } } });
        return { turnId: request.submissionId };
      }
      return original(method, params);
    };
    client.reply('session/queueSnapshot', { queueSnapshot: { revision: 2, status: 'authoritative', items: [
      { state: 'pending', mutable: true, message: { uuid: 'saved-message', priority: 'now', delivery: 'delegation', value: 'saved input' } },
    ] } });
    client.replySubmit('start-if-idle', 'empty-fallback');
    const { service, state } = serviceWith(client, root);
    state.rememberSession('r1', 'engine-1', {});
    assertDeepEqual(await service.continueTurn('r1'), { ok: true }, 'explicit queue resume admitted');
    assertEqual(client.sent('session/resumeQueued').length, 1, 'exactly one queued batch admission');
    assertEqual(client.sent('session/resumePending').length, 0, 'interrupted queue does not bypass the completed fence');
    assertEqual(client.sentSubmit('continue-if-idle').length, started ? 0 : 1, 'history continuation only follows a confirmed empty queue');
    assertEqual(client.sentSubmit('start-if-idle').length, 0, 'Continue never submits an empty ordinary message');
    if (started) {
      const duplicate = await assertRejects(() => service.continueTurn('r1'), 'a second Continue cannot start competing inference');
      assertEqual((duplicate as { code?: string }).code, 'TURN_IN_PROGRESS', 'single-turn admission stays enforced');
    }
    await service.shutdown();
  }
});

h.test('a stop racing explicit queue Continue returns refusal and never leaves a pending admission', async () => {
  const root = byoRoot(), client = new FakeClient().reply('session/queueSnapshot', { queueSnapshot: { revision: 1, status: 'authoritative', items: [
    { state: 'pending', message: { uuid: 'saved', priority: 'now', value: 'pending' } },
  ] } }).reply('session/resumeQueued', { pendingResume: { started: false, reason: 'interrupted' } });
  const { service, state } = serviceWith(client, root); state.rememberSession('r1', 'engine-1', {});
  const reply = object(await service.continueTurn('r1'));
  assertEqual(reply?.ok, false, 'renderer receives refusal and releases its continuing guard');
  assertEqual(state.isWorking('r1'), false, 'no nonexistent turn stays running');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'stop never triggers an empty fallback turn');
  assertEqual(client.sent('session/resumeQueued').length, 1, 'one queue admission attempt'); await service.shutdown();
});

h.test('followUp refuses softly when there is no running turn or no text', async () => {
  const root = freshRoot();
  const client = new FakeClient();
  const { service } = serviceWith(client, root);

  // Convention B: a SOFT failure the renderer's promise accepts and reads as result.ok===false.
  // Throwing instead would make a refusal look like a transport failure.
  const noTurn = await service.followUp('r1', { text: 'hi' }) as Record<string, Json>;
  assertEqual(noTurn.ok, false, 'no running turn is refused');
  assertEqual(typeof noTurn.error, 'string', 'with a bare-string error, not an envelope');

  const empty = await service.followUp('r1', { text: '   ' }) as Record<string, Json>;
  assertEqual(empty.ok, false, 'empty text is refused');

  assertEqual(client.calls.length, 0, 'and nothing was sent to the engine');
});

// ---------------------------------------------------------------------------
// 5. turnId capture and interrupt staleness.
// ---------------------------------------------------------------------------

h.test('send reserves the turn identity before dispatch and records its confirmation', async () => {
  const root = freshRoot();
  const client = new FakeClient();
  client.replySubmit('start-if-idle', 'turn-42');
  const { service, state } = serviceWith(client, root);
  state.rememberSession('r1', 'engine-1', {});

  const result = await service.send('r1', { text: 'hello' });
  // FIRE-AND-FORGET: the reply is null and progress arrives only over the push stream.
  // Awaiting the turn would block the composer for its whole duration.
  assertEqual(result, null, 'send resolves with null');
  assertEqual(state.isWorking('r1'), true, 'the session is marked working');
  // Without this, interruptIsStale compares against undefined and refuses EVERY Stop that
  // carries an expectedTurnId — the Stop button would silently do nothing.
  const sent = client.sentSubmit('start-if-idle')[0] as Record<string, Json>;
  assert(typeof sent.submissionId === 'string' && sent.submissionId.length > 0, 'a turn identity is reserved before dispatch');
  assertEqual(state.runningTurnId('r1'), sent.submissionId, 'the same identity remains recorded after confirmation');
  // A plain text message sends the BARE STRING: the engine echoes the input verbatim into the
  // queue snapshot, so wrapping it in a parts array is a renderer-visible shape change.
  assertEqual(sent.input, 'hello', 'input is a bare string, not a parts array');
  assertEqual(sent.sessionId, 'engine-1', 'addressed by the engine session id');
  assertEqual(state.runningSubmissionId('r1'), sent.submissionId, 'Stop can fence the admitted reservation before the first stream frame');
});

h.test('a stopped predecessor cannot clear a new send before its acknowledgement or first stream frame', async () => {
  const root = freshRoot(), client = new FakeClient();
  const request = client.requestWithTimeout.bind(client);
  let release!: (value: Json) => void, submitted: Json | undefined;
  client.requestWithTimeout = async (method, params) => {
    if (method === 'turn/submit' && object(params)?.mode === 'start-if-idle') {
      client.calls.push({ method, params });
      submitted = params;
      return new Promise(resolve => { release = resolve; });
    }
    return request(method, params);
  };
  let pump: SessionEventPump | undefined;
  const { service, state } = serviceWith(client, root, undefined, { onEvent: event => pump?.receive(event, 1) });
  pump = new SessionEventPump({ state, currentGeneration: () => 1, emit: () => {}, log: () => {},
    forwarder: new ChatEventForwarder(() => {}) });
  state.rememberSession('r1', 'engine-1', {});
  state.markTurnRunning('r1', 'old-turn');
  assertEqual(object(await service.interrupt('r1', 'old-turn'))?.confirmed, true, 'the old Stop is confirmed');
  const sending = service.send('r1', { text: 'New message immediately after Stop' });
  await waitFor(() => !!release, 1000, 'the new request reaches admission');
  const nextId = object(submitted)?.submissionId;
  assert(typeof nextId === 'string' && nextId !== 'old-turn', 'the new request owns a distinct reservation');
  assertEqual(state.runningTurnId('r1'), nextId, 'identity is installed while the ACK is pending');
  pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-1', turnId: 'old-turn', result: { stopReason: 'aborted' } } }, 1);
  assertEqual(state.isWorking('r1'), true, 'old terminal cannot clear the successor');
  assertEqual(state.runningTurnId('r1'), nextId, 'the successor keeps its own identity');
  release(acceptedTurnInput(submitted!));
  await sending;
  assertEqual(client.calls.filter(call => call.method === 'turn/submit').length, 1, 'the new input is submitted exactly once');
  state.clearTurnRunning('r1');
  await service.shutdown();
});

h.test('interrupt forwards explicit user origin, and refuses a stale expectedTurnId', async () => {
  const root = freshRoot();
  const client = new FakeClient();
  client.reply('turn/interrupt', { submissionId: 'i1' });
  const interrupted: string[] = [];
  const { service, state } = serviceWith(client, root, undefined, { onInterrupted: id => interrupted.push(id) });
  state.rememberSession('r1', 'engine-1', {});
  state.markTurnRunning('r1', 'turn-7');

  // A stale expectedTurnId is answered accepted:false and NOT forwarded: without that, a Stop
  // pressed after the turn settled would cancel the NEXT turn.
  const stale = await service.interrupt('r1', 'turn-OLD') as Record<string, Json>;
  assertEqual(stale.ok, true, 'the call itself succeeds');
  assertEqual(stale.accepted, false, 'but the stop was not accepted');
  assertEqual(client.sent('turn/interrupt').length, 0, 'and nothing was forwarded');
  assertEqual(interrupted.length, 0, 'a stale stop cannot suppress a later failure');

  // An empty expectedTurnId means "stop whatever is running", which must still work.
  const bare = await service.interrupt('r1', '') as Record<string, Json>;
  assertEqual(bare.accepted, true, 'an empty expectedTurnId is not stale');
  // The settlement is optimistic: the registry clears and the idle frame publishes BEFORE the
  // engine RPC resolves, so the RPC send only appears once the background leg reaches the
  // client.
  await waitFor(() => client.sent('turn/interrupt').length === 1, 1000, 'the background interrupt leg reaches the engine');

  const sent = rowAt(client.sent('turn/interrupt'), 0, 'the interrupt request');
  assertDeepEqual(sent, { sessionId: 'engine-1', origin: 'user-stop' }, 'explicit origin without inventing a request correlation');
  assertEqual(bare.interruptedTurnId, 'turn-7', 'and the interrupted turn is reported');
  assertEqual(state.isWorking('r1'), false, 'the running flag is cleared');
  assertDeepEqual(interrupted, ['r1'], 'an accepted stop reaches lifecycle observers before disconnect cleanup');
});

h.test('interrupt settles parked approvals so the engine stops blocking', async () => {
  const root = freshRoot();
  const client = new FakeClient();
  client.reply('turn/interrupt', { submissionId: 'i1' });
  const { service, state, pushed } = serviceWith(client, root);
  state.rememberSession('r1', 'engine-1', {});
  state.markTurnRunning('r1', 'turn-7');

  // The engine BLOCKS on a parked approval: leaving it parked would hang the very turn being
  // stopped. Each kind answers with its OWN cancellation shape, because sending `decline` to
  // an approval is something the engine cannot parse.
  const answered: Array<{ label: string; response: unknown }> = [];
  // Typed as the real `ReverseRequest` rather than cast: if that interface gains a member, or
  // `respond` changes signature, this fake stops compiling — which is the only thing keeping
  // the cancellation assertions honest about what the service actually calls.
  const responder = (label: string): ReverseRequest => ({
    method: 'approval/request',
    params: {},
    id: 1,
    outstanding: true,
    respond: async (response) => {
      answered.push({ label, response });
    },
    respondError: async () => {},
  });
  state.parkReverse({
    requestId: 'req-1',
    sessionId: 'r1',
    isApproval: true,
    card: { requestId: 'req-1' },
    toolName: 'Bash',
    request: responder('approval'),
  });
  state.parkReverse({
    requestId: 'req-2',
    sessionId: 'r1',
    isApproval: false,
    card: { requestId: 'req-2' },
    toolName: '',
    request: responder('elicit'),
  });
  // A request for a DIFFERENT session must be left alone.
  state.parkReverse({
    requestId: 'req-3',
    sessionId: 'other',
    isApproval: true,
    card: { requestId: 'req-3' },
    toolName: 'Bash',
    request: responder('other'),
  });

  await service.interrupt('r1', undefined);

  assertEqual(answered.length, 2, 'both of this session"s requests were settled');
  assertDeepEqual(answered[0], { label: 'approval', response: { decision: 'deny' } }, 'an approval is denied');
  assertDeepEqual(answered[1], { label: 'elicit', response: { kind: 'decline' } }, 'an elicitation is declined');
  assertEqual(state.pendingCount(), 1, "and the other session's request is untouched");

  // The renderer is told each card is gone, so an open approval dialog closes instead of
  // waiting forever for an answer the engine no longer wants.
  assertDeepEqual(
    pushed.map((event) => (event as Record<string, Json>).type).sort(),
    ['elicit_cancelled', 'permission_cancelled', 'session_runtime_status'],
    'a cancellation event per settled request plus the optimistic idle frame',
  );
});

// ---------------------------------------------------------------------------
// 6. session/history re-projection.
// ---------------------------------------------------------------------------

h.test('stored conversation remains readable when its provider cannot start', async () => {
  const saved = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/stored-history-vectors.json'), 'utf8')).reply;
  const root = freshRoot(), client = new FakeClient().failWith('model/selection/resolve')
    .reply('engine/readThreadHistory', { ...saved, threadId: 'offline-history' });
  const { service, state, pushed } = serviceWith(client, root);
  assertEqual(service.canReadSessionMedia('offline-history'), false, 'an unchecked disk identity grants no workspace media access');
  const projected = await service.history('offline-history') as Record<string, Json>;
  const messages = projected.messages as Array<Record<string, Json>>;
  assertDeepEqual(messages.map(row => row.text), ['Saved question', 'Saved answer'], 'provider failure does not hide saved dialogue');
  assertEqual(messages[1]?.isFinalReply, true, 'original final reply survives stored replay');
  assertEqual(client.sent('session/start').length, 0, 'an unavailable provider cannot start a writer');
  assertEqual(client.sent('engine/readThreadHistory').length, 1, 'saved work uses the complete history facade');
  assertEqual(state.liveSession('offline-history'), undefined, 'history recovery does not fabricate a live session');
  assertEqual(service.canReadSessionMedia('offline-history'), true, 'validated stored history can read its workspace attachments');
  assertDeepEqual(await service.exportMessages('offline-history'), saved.history, 'offline export retains the complete original messages and tool results');
  assertEqual(pushed.filter(row => (row as Record<string, Json>).type === 'api_error').length, 0, 'a read-only recovery does not append an inference error to saved dialogue');
  client.replyAcknowledged('session/deleteSession', { deleted: { threadId: 'offline-history', deleted: true } });
  await service.deleteSession('offline-history');
  assertEqual(service.canReadSessionMedia('offline-history'), false, 'confirmed deletion revokes the saved attachment scope');
  await assertRejects(() => service.storedHistory('offline-history'), 'a deleted history cannot regain its media scope');
  await service.shutdown();
});

h.test('a cold attachment read validates stored history without activating its provider', async () => {
  const saved = JSON.parse(readFileSync(vectorPath('stored-history-vectors.json'), 'utf8')).reply;
  const client = new FakeClient().failWith('model/selection/resolve')
    .reply('engine/readThreadHistory', { ...saved, threadId: 'cold-media' })
    .replyAcknowledged('session/deleteSession', { deleted: { threadId: 'cold-media', deleted: true } });
  const { service, state } = serviceWith(client, freshRoot());
  assertEqual(service.canReadSessionMedia('cold-media'), false, 'an unchecked queued attachment starts without read scope');
  assertEqual(await service.prepareSessionMedia('cold-media'), true, 'the first request waits for validated saved history');
  assertEqual(service.canReadSessionMedia('cold-media'), true, 'the protocol may now read the owning attachment roots');
  assertEqual(await service.prepareSessionMedia('cold-media'), true, 'subsequent images share the validated scope');
  assertEqual(client.sent('engine/readThreadHistory').length, 1, 'an established scope does not reread history per image');
  assertEqual(client.sent('model/selection/resolve').length, 0, 'attachment reads never select a provider');
  assertEqual(client.sent('session/start').length, 0, 'attachment reads never acquire a writer');
  assertEqual(state.liveSession('cold-media'), undefined, 'saved input remains dormant');
  await service.deleteSession('cold-media');
  assertEqual(await service.prepareSessionMedia('cold-media'), false, 'deletion revokes scope and prevents validation from reopening it');
  assertEqual(client.sent('engine/readThreadHistory').length, 1, 'deleted input cannot issue a fresh read');
  await service.shutdown();
});

h.test('cold attachment admission rejects private, invalid and foreign stored histories', async () => {
  const saved = JSON.parse(readFileSync(vectorPath('stored-history-vectors.json'), 'utf8')).reply;
  for (const reply of [{}, { ...saved, threadId: 'another-owner' }]) {
    const client = new FakeClient().reply('engine/readThreadHistory', reply);
    const { service } = serviceWith(client, freshRoot(), undefined, { isPrivateThread: id => id === 'private-media' });
    assertEqual(await service.prepareSessionMedia('private-media'), false, 'private conversations cannot grant protocol scope');
    assertEqual(client.sent('engine/readThreadHistory').length, 0, 'private admission never reads history');
    assertEqual(await service.prepareSessionMedia('cold-media'), false, 'malformed or foreign replies cannot authorize a file');
    assertEqual(service.canReadSessionMedia('cold-media'), false, 'a refused read leaves no cached scope');
    await service.shutdown();
  }
});

h.test('cold attachment validation cannot outlive deletion, privacy, connection or shutdown', async () => {
  const saved = JSON.parse(readFileSync(vectorPath('stored-history-vectors.json'), 'utf8')).reply;
  for (const retirement of ['delete', 'private', 'connection', 'shutdown']) {
    let reading = false, privateThread = false, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    class DelayedMediaClient extends FakeClient {
      override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
        if (method === 'engine/readThreadHistory') { reading = true; await pending; }
        return super.requestWithTimeout(method, params);
      }
    }
    const client = new DelayedMediaClient()
      .reply('engine/readThreadHistory', { ...saved, threadId: 'retired-media' })
      .replyAcknowledged('session/deleteSession', { deleted: { threadId: 'retired-media', deleted: true } });
    const { service } = serviceWith(client, freshRoot(), undefined, { isPrivateThread: () => privateThread });
    const admission = service.prepareSessionMedia('retired-media');
    await waitFor(() => reading, 1000, 'Cold attachment validation started');
    if (retirement === 'delete') await service.deleteSession('retired-media');
    else if (retirement === 'private') privateThread = true;
    else if (retirement === 'connection') { client.closed = true; client.emit('event', { type: 'streamClosed' }); }
    else await service.shutdown();
    release();
    assertEqual(await admission, false, 'a late saved reply cannot authorize its retired owner');
    if (retirement === 'private') privateThread = false;
    assertEqual(service.canReadSessionMedia('retired-media'), false, 'retirement did not leave a hidden readable-history grant');
    await service.shutdown();
  }
});

h.test('live history retains original message grouping and thinking signatures', async () => {
  const original: Json[] = [{ type: 'assistant', uuid: 'original-answer', content: [
    { type: 'thinking', text: 'Reasoning', signature: 'original-signature' },
    { type: 'text', text: 'Answer' },
  ] }];
  const client = new FakeClient()
    .reply('engine/readThreadHistory', {
      threadId: 'conversation', history: original, historyTurnIds: { 'original-answer': 'turn-1' },
      turnFinalMessageIds: {}, turnStatuses: {}, turnStartedAtMs: {}, turnFinishedAtMs: {},
      turnDurations: {}, turnCancelledTools: {}, turnErrors: {}, turnErrorKinds: {}, agentNotifications: [],
    })
    .reply('session/history', { history: original, historyTurnIds: { 'original-answer': 'turn-1' } });
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conversation', 'live-engine', {});
  const projected = await service.history('conversation') as Record<string, Json>;
  const messages = projected.messages as Array<Record<string, Json>>;
  assertEqual(messages.length, 1, 'one original assistant message remains one row');
  assertEqual(messages[0]?.uuid, 'original-answer', 'original UUID survives');
  assertEqual((messages[0]?.contentBlocks as Array<Record<string, Json>>)[0]?.signature, 'original-signature', 'original signature survives');
  const exported = await service.exportMessages('conversation');
  assertEqual((exported[0] as Record<string, Json>).uuid, 'original-answer', 'live export retains the original message identity');
  assertEqual(client.sent('engine/readThreadHistory').length, 1, 'the live transcript and its export share one saved capture');
  assertEqual(client.sent('session/history').length, 0, 'the model-context snapshot is not the transcript source');
  await service.shutdown();
});

h.test('a steered user row projects without its marker and carries the steered flag', async () => {
  const marker = '<!-- klaus-steered-message -->';
  const history: Json[] = [
    { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'the send' }] },
    { type: 'user', uuid: 'u2', content: [{ type: 'text', text: marker }, { type: 'text', text: 'mid-turn follow-up' }] },
  ];
  const client = new FakeClient()
    .reply('session/history', { history, historyTurnIds: { u1: 'turn-1', u2: 'turn-1' } });
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conversation', 'live-engine', {});
  const projected = await service.history('conversation') as Record<string, Json>;
  const messages = projected.messages as Array<Record<string, Json>>;
  assertEqual(messages.length, 2, 'both user rows survive');
  const steered = messages[1] as Record<string, Json>;
  assertEqual(steered.steered, true, 'the marker row is flagged for the renderer');
  assertEqual(steered.text, 'mid-turn follow-up', 'the bubble shows the user words, not the marker');
  const blocks = steered.contentBlocks as Array<Record<string, Json>>;
  assertEqual(blocks.length, 1, 'the marker block is gone from the replay blocks');
  assertEqual(blocks[0]?.text, 'mid-turn follow-up', 'and the remaining block is the message');
  assertEqual(messages[0]?.steered, undefined, 'an ordinary send carries no flag');
  await service.shutdown();
});

h.test('session follow binds an atomic engine revision to the projected renderer history', async () => {
  const client = new FakeClient().reply('session/follow', {
    sessionId: 'live-engine',
    streamId: 'stream-1',
    revision: 7,
    mode: 'snapshot',
    availableFromRevision: 3,
    snapshot: {
      activeItems: [], coveredMessageIds: ['followed-answer'],
      history: [{ type: 'assistant', uuid: 'followed-answer', content: [{ type: 'text', text: 'Atomic answer' }] }],
      historyTurnIds: { 'followed-answer': 'turn-1' },
    },
  });
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conversation', 'live-engine', {});
  const followed = await service.followHistory('conversation') as Record<string, Json>;
  assertEqual(followed.mode, 'snapshot', 'the renderer sees the snapshot join mode');
  assertEqual(followed.streamId, 'stream-1', 'the engine stream epoch is preserved');
  assertEqual(followed.revision, 7, 'the exact history cut is preserved');
  assertEqual(rowAt(followed.messages as Json[], 0, 'follow snapshot').text, 'Atomic answer', 'the snapshot uses the normal history projection');
  assertDeepEqual(client.sent('session/follow'), [{ sessionId: 'live-engine', includeOriginalHistory: true }], 'the named facade method addresses the live engine session');
  await service.shutdown();
});

h.test('a superseded mobile saved read cancels its RPC and releases the recovery lane', async () => {
  class CancelledReadClient extends FakeClient {
    readOptions?: RpcRequestOptions;
    override async requestWithTimeout(...requestArgs: [method: string, params: Json, timeoutMs?: number, options?: RpcRequestOptions]): Promise<unknown> {
      const [method, params, , options] = requestArgs;
      if (method !== 'engine/readThreadHistory') return super.requestWithTimeout(method, params);
      this.readOptions = options;
      return new Promise((resolve, reject) => {
        const signal = options?.signal;
        if (!signal) { reject(new Error('Stored read omitted cancellation')); return; }
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  }
  const client = new CancelledReadClient(); const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conversation', 'live-engine', {}); await service.client();
  const controller = new AbortController();
  const loading = service.withEngineOwner({ client, generation: 1 }, controller.signal, () => service.followHistory('conversation', undefined, { signal: controller.signal, priority: 'interactive', source: 'thread' }, () => {}));
  const rejected = assertRejects(() => loading, 'cancelled original reads must not retain the foreground slot');
  await waitFor(() => client.readOptions !== undefined, 1000, 'Saved read admission');
  assertEqual(client.readOptions?.signal, controller.signal, 'saved history uses the follow cancellation signal');
  controller.abort(); await rejected;
  assertEqual(client.sent('session/follow').length, 0, 'a cancelled read cannot publish a final source cut');
  await service.shutdown();
});
h.test('leaving a loading mobile chat releases foreground recovery while its startup safely drains', async () => {
  const saved = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/stored-history-vectors.json'), 'utf8')).reply;
  let release!: () => void, startupEntered = false, startupFinished = false;
  class SlowStartClient extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method !== 'session/start') return super.requestWithTimeout(method, params);
      startupEntered = true; await new Promise<void>(resolve => { release = resolve; }); startupFinished = true;
      return { sessionId: 'late-start' };
    }
  }
  const client = new SlowStartClient().reply('engine/readThreadHistory', { ...saved, threadId: 'slow-mobile' }).reply('session/close', null);
  const { service } = serviceWith(client, byoRoot()); await service.client();
  const controller = new AbortController(); let readable = false;
  const loading = service.withEngineOwner({ client, generation: 1 }, controller.signal, () => service.followHistory('slow-mobile', undefined, { signal: controller.signal }, () => { readable = true; }));
  const rejected = assertRejects(() => loading, 'view cancellation must settle before provider startup');
  await waitFor(() => startupEntered && readable, 1000, 'Saved history shown while provider startup waits');
  controller.abort(); await rejected;
  assertEqual(startupFinished, false, 'view recovery released without cancelling the admitted startup');
  release(); await waitFor(() => client.sent('session/close').length === 1, 1000, 'Late startup cleanup');
  assertEqual(client.sent('session/follow').length, 0, 'departed view never receives a stale follow cut');
  await service.shutdown();
});
h.test('mobile read-first history remains available when its provider cannot resume', async () => {
  const saved = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/stored-history-vectors.json'), 'utf8')).reply;
  const root = byoRoot();
  const client = new FakeClient().failWith('model/selection/resolve')
    .reply('engine/readThreadHistory', { ...saved, threadId: 'offline-mobile' });
  const { service } = serviceWith(client, root); const visible: Json[] = [];
  const failure = await assertRejects(() => service.followHistory('offline-mobile', undefined, undefined, history => visible.push(history)), 'live recovery must report its unavailable provider');
  assertEqual((failure as { code?: string }).code, 'MODEL_PROVIDER_UNAVAILABLE', 'live recovery retains its unavailable provider error');
  assertEqual(visible.length, 1, 'the saved transcript is delivered independently of runtime activation');
  assertDeepEqual(((visible[0] as Record<string, Json>).messages as Array<Record<string, Json>>).map(row => row.text), ['Saved question', 'Saved answer'], 'complete saved dialogue remains readable');
  assertEqual(client.sent('session/follow').length, 0, 'no source cursor is fabricated when runtime resume fails');
  assertEqual(client.sent('session/start').length, 0, 'read-first needs no provider writer');
  await service.shutdown();
});
h.test('an unreadable rollout falls back to the engine snapshot, and a provider that cannot start still serves the saved transcript', async () => {
  const saved = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/stored-history-vectors.json'), 'utf8')).reply;
  // The rollout read fails, the model-context snapshot answers: the fallback order is
  // saved projection first, snapshot second, never the reverse.
  const failing = new FakeClient().failWith('engine/readThreadHistory')
    .reply('session/history', { history: saved.history, historyTurnIds: saved.historyTurnIds });
  const { service, state } = serviceWith(failing, freshRoot());
  state.rememberSession('conversation', 'live-engine', {});
  const projected = await service.history('conversation') as Record<string, Json>;
  assertDeepEqual((projected.messages as Array<Record<string, Json>>).map(row => row.text), ['Saved question', 'Saved answer'], 'the snapshot keeps the transcript alive when the rollout is unreadable');
  assertEqual(failing.sent('session/history').length, 1, 'the snapshot is the fallback, not the source');
  // A provider that cannot start at all still serves the complete saved transcript.
  const offline = new FakeClient().reply('engine/readThreadHistory', { ...saved, threadId: 'offline-conversation' });
  const offlineService = serviceWith(offline, freshRoot());
  const offlineProjected = await offlineService.service.history('offline-conversation') as Record<string, Json>;
  assertDeepEqual((offlineProjected.messages as Array<Record<string, Json>>).map(row => row.text), ['Saved question', 'Saved answer'], 'saved dialogue remains readable when its provider cannot start');
  await service.shutdown();
  await offlineService.service.shutdown();
});

h.test('an invalid stored fallback reports failure instead of an empty transcript', async () => {
  const client = new FakeClient().reply('engine/readThreadHistory', {});
  const { service } = serviceWith(client, freshRoot());
  await assertRejects(() => service.history('missing-history'), 'provider startup and invalid stored history cannot appear successful');
  assertEqual(service.canReadSessionMedia('missing-history'), false, 'a failed history read grants no media scope');
  assertEqual(client.sent('engine/readThreadHistory').length, 1, 'the provider-independent read was attempted');
  await service.shutdown();
});

h.test('a decoded stored reply cannot publish after its owner retires before the caller resumes', async () => {
  const saved = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/stored-history-vectors.json'), 'utf8')).reply;
  for (const operation of ['history', 'export']) for (const retirement of ['connection', 'private']) {
    let privateThread = false, retired = false;
    class RetiringHistoryClient extends FakeClient {
      override requestWithTimeout(method: string, params: Json): Promise<unknown> {
        if (method !== 'engine/readThreadHistory') return super.requestWithTimeout(method, params);
        // Retire after the decoder consumes the reply, but before its caller resumes.
        queueMicrotask(() => queueMicrotask(() => {
          retired = true;
          if (retirement === 'private') privateThread = true;
          else { this.closed = true; this.emit('event', { type: 'streamClosed' }); }
        }));
        return Promise.resolve({ ...saved, threadId: 'retired-history', history: [
          { type: 'assistant', uuid: 'retired-image', content: [
            { type: 'image', mimeType: 'image/png', base64: Buffer.from('retired-image').toString('base64') },
          ] },
        ] });
      }
    }
    const root = freshRoot(), client = new RetiringHistoryClient();
    const { service } = serviceWith(client, root, undefined, { isPrivateThread: () => privateThread });
    await assertRejects(() => operation === 'history' ? service.storedHistory('retired-history') : service.exportMessages('retired-history'), 'a retired owner cannot publish its saved reply');
    assert(retired, 'the retirement ran before the result was rejected');
    assert(!existsSync(join(root, 'media')), 'the rejected history creates no media cache');
    assertEqual(service.canReadSessionMedia('retired-history'), false, 'the rejected history grants no attachment scope');
    await service.shutdown();
  }
});

h.test('a late live history cannot publish or cache media after its binding closes or is deleted', async () => {
  for (const action of ['close', 'replace', 'delete']) {
    let reading = false, release!: (value: Json) => void;
    const pending = new Promise<Json>(resolve => { release = resolve; });
    class DelayedHistoryClient extends FakeClient {
      override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
        if (method === 'session/history') { reading = true; return pending; }
        return super.requestWithTimeout(method, params);
      }
    }
    const root = freshRoot(), client = new DelayedHistoryClient().reply('session/close', {});
    client.replyAcknowledged('session/deleteSession', { deleted: { threadId: 'late-history', deleted: true } });
    const { service, state } = serviceWith(client, root);
    state.rememberSession('late-history', 'old-engine', {});
    const history = service.history('late-history');
    const rejected = assertRejects(() => history, 'retired history read is rejected');
    await waitFor(() => reading, 1000, 'history request captured');
    if (action === 'delete') await service.deleteSession('late-history');
    else {
      state.forgetSession('late-history');
      if (action === 'replace') state.rememberSession('late-history', 'new-engine', {});
    }
    release({ history: [{ type: 'assistant', uuid: 'late', content: [{ type: 'image', mimeType: 'image/png', base64: Buffer.from('stale-image').toString('base64') }] }] });
    await rejected;
    assert(!existsSync(join(root, 'media')), 'a retired response cannot write its image cache');
    if (action !== 'replace') assertEqual(service.canReadSessionMedia('late-history'), false, 'a retired read cannot reestablish saved media scope');
    await service.shutdown();
  }
});

h.test('history re-keys the engine reply into the renderer shape', () => {
  // The engine answers with `history` and `historyTurnIds`; the renderer reads `messages` and
  // a per-row `turnId`. The shapes are close enough that a pass-through would render an EMPTY
  // transcript with no error anywhere.
  const projected = projectSessionHistory(
    {
      history: [
        { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'Read the file' }] },
        {
          type: 'assistant',
          uuid: 'a1',
          content: [
            { type: 'text', text: 'On it.', messageId: 'm1', phase: 'commentary' },
            { type: 'tool_use', id: 'tc1', name: 'read', input: { path: 'a.ts' } },
          ],
        },
        { type: 'tool_result', toolUseId: 'tc1', content: [{ type: 'text', text: 'contents' }], isError: false },
      ],
      historyTurnIds: { u1: 'turn-1', a1: 'turn-1' },
      turnFinalMessageIds: { 'turn-1': 'a1' },
      turnStatuses: { 'turn-1': 'completed' },
      agentNotifications: [
        { notificationId: 'n1', source: 'background-task', status: 'completed' },
        { notificationId: 'n1', source: 'background-task', status: 'completed' },
      ],
    },
    'renderer-1',
  ) as Record<string, Json>;

  const messages = projected.messages as Json[];
  // The tool_result is NOT its own row: it is attached to its tool_use as __result.
  assertEqual(messages.length, 2, 'two rows: the tool result rides its tool_use');
  const user = rowAt(messages, 0, 'the user row');
  assertEqual(user.role, 'user', 'the user row');
  assertEqual(user.text, 'Read the file', 'with its text');
  // Rows are keyed by the RENDERER id, because that is what the renderer files the
  // conversation under (engine.rs:3563 formats `${session_id}-${index}`).
  assertEqual(user.id, 'renderer-1-0', 'keyed by the renderer id');
  assertEqual(user.uuid, 'u1', 'keeping the engine uuid');
  assertEqual(user.turnId, 'turn-1', 'with its turn id from historyTurnIds');

  const assistant = rowAt(messages, 1, 'the assistant row');
  assertEqual(assistant.role, 'assistant', 'the assistant row');
  assertEqual(assistant.isFinalReply, true, 'flagged as the turn final reply');
  const blocks = blocksOf(assistant, 'the assistant row');
  assertEqual(blocks.length, 2, 'both blocks projected');
  const text = rowAt(blocks, 0, 'the text block');
  assertEqual(text.type, 'text', 'a text block');
  // messageId and phase survive replay: they are what stops commentary collapsing into the
  // final answer (contracts/vectors/message-phase-vectors.json).
  assertEqual(text.messageId, 'm1', 'messageId preserved');
  assertEqual(text.phase, 'commentary', 'and phase preserved');
  const toolUse = rowAt(blocks, 1, 'the tool_use block');
  assertEqual(toolUse.type, 'tool_use', 'a tool_use block');
  const result = toolUse.__result as Record<string, Json>;
  assertEqual(result.type, 'tool_result', 'with its result attached');
  assertEqual(result.tool_use_id, 'tc1', 'keyed by the tool_use id');
  assertEqual(result.is_error, false, 'and the error flag');
  assertDeepEqual(result.content, [{ type: 'text', text: 'contents' }], 'with normalized content');

  // Every turn map is passed through under the RENDERER's name, defaulting to an empty object
  // so the renderer never indexes into undefined.
  assertDeepEqual(projected.turnStatuses, { 'turn-1': 'completed' }, 'turnStatuses passed through');
  assertDeepEqual(projected.turnFinalMessageIds, { 'turn-1': 'a1' }, 'and turnFinalMessageIds');
  assertDeepEqual(projected.turnErrors, {}, 'a missing turnErrors becomes an empty object');
  assertDeepEqual(projected.turnCancelledTools, {}, 'as does turnCancelledTools');

  // The notification receipt filter applies to replay too, and de-duplicates by id, so a
  // replayed transcript shows exactly the receipts the live stream showed.
  assertDeepEqual(
    projected.agentNotifications,
    [{ notificationId: 'n1', source: 'background-task', status: 'completed' }],
    'one de-duplicated receipt',
  );
});

h.test('history drops what the renderer must not show', () => {
  const projected = projectSessionHistory(
    {
      history: [
        // Engine housekeeping, not something the user said.
        { type: 'user', uuid: 'm1', isMeta: true, content: [{ type: 'text', text: 'internal' }] },
        { type: 'user', uuid: 'm2', is_meta: true, content: [{ type: 'text', text: 'internal' }] },
        // Its content rides the real message via localRender.
        { type: 'system', subtype: 'user_display', uuid: 's1', text: '{"messageUuid":"u1","localRender":{"origin":"user"}}' },
        // An assistant message with nothing renderable would be an empty bubble.
        { type: 'assistant', uuid: 'a0', content: [{ type: 'mystery' }] },
        // Unknown types are dropped rather than rendered as empty bubbles.
        { type: 'progress', uuid: 'p1' },
        { type: 'compact_boundary', uuid: 'cb1' },
        { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'Real question' }] },
      ],
      historyTurnIds: {},
    },
    'r',
  ) as Record<string, Json>;

  const messages = projected.messages as Json[];
  assertEqual(messages.length, 2, 'the compaction marker and the real message survive');
  const compaction = rowAt(messages, 0, 'the compaction row');
  assertEqual(compaction.kind, 'compaction', 'a compact_boundary becomes a compaction row');
  assertEqual(compaction.role, 'user', 'rendered on the user side');
  assertEqual(compaction.compactionTrigger, 'auto', 'with the auto trigger');
  assertEqual(rowAt(messages, 1, 'the real message').text, 'Real question', 'and the real message follows');
});

h.test('compaction checkpoint output never reaches the transcript as a reply', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/compaction-transcript-vectors.json'), 'utf8')) as {
    checkpointProjectionCases: Array<{
      name: string; history: Json[]; historyTurnIds: Record<string, Json>;
      expectedKinds: string[]; forbiddenText: string[];
    }>;
  };
  for (const caseItem of vector.checkpointProjectionCases) {
    const projected = projectSessionHistory({ history: caseItem.history, historyTurnIds: caseItem.historyTurnIds }, 'r') as Record<string, Json>;
    const messages = projected.messages as Json[];
    assertDeepEqual(messages.map(message => (message as Record<string, Json>).kind ?? 'user'),
      caseItem.expectedKinds, `${caseItem.name}: kinds`);
    for (const forbidden of caseItem.forbiddenText) {
      assertEqual(messages.some(message => String((message as Record<string, Json>).text ?? '').includes(forbidden)), false,
        `${caseItem.name}: the checkpoint body and the boundary summary stay out of every row`);
    }
    assertEqual(messages.some(message => (message as Record<string, Json>).kind === 'compact-summary'), false,
      `${caseItem.name}: the desktop transcript carries no summary card row`);
    assertEqual(messages.some(message => (message as Record<string, Json>).uuid === 'cp-body'), false, `${caseItem.name}: no checkpoint body row`);
    assertEqual(messages.some(message => (message as Record<string, Json>).uuid === 'cp-marker'), false, `${caseItem.name}: no envelope marker row`);
  }
});

h.test('compaction file recovery stays a typed row across marked and legacy history', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/compaction-file-restore-vectors.json'), 'utf8'));
  const text = vector.prefix + vector.file;
  const projected = projectSessionHistory({
    history: [
      { type: 'compact_boundary', uuid: 'boundary-1' },
      { type: 'user', uuid: 'marked', isMeta: true, content: [{ type: 'text', text, phase: vector.phase }] },
      { type: 'user', uuid: 'real', content: [{ type: 'text', text: 'Please continue' }] },
      { type: 'compact_boundary', uuid: 'boundary-2' },
      { type: 'user', uuid: 'legacy', content: [{ type: 'text', text }] },
      { type: 'user', uuid: 'quoted', content: [{ type: 'text', text }] },
      { type: 'user', uuid: 'other-meta', isMeta: true, content: [{ type: 'text', text: 'housekeeping' }] },
    ],
    historyTurnIds: {},
  }, 'r') as Record<string, Json>;
  const messages = projected.messages as Json[];
  assertDeepEqual(messages.map(message => (message as Record<string, Json>).kind ?? 'user'),
    ['compaction', vector.projectedKind, 'user', 'compaction', vector.projectedKind, 'user'],
    'only marked or boundary-adjacent recovery is classified; later user text stays user');
  assertEqual(rowAt(messages, 1, 'marked restore').text, text, 'the full file body survives replay');
  assertEqual(rowAt(messages, 1, 'marked restore').uuid, 'marked', 'the stored identity survives replay');
  assertEqual(rowAt(messages, 4, 'legacy restore').kind, vector.projectedKind, 'legacy recovery is upgraded on read');
});

h.test('history attaches a user_display localRender and honours a goal rewrite', () => {
  // A goal instruction is ENGINE-authored: every renderer action, including Copy, must
  // receive only the user's original objective. So a goal display overrides the text and
  // blocks with the user-facing wording.
  const projected = projectSessionHistory(
    {
      history: [
        { type: 'system', subtype: 'user_display', uuid: 's1', text: '{"messageUuid":"u1","localRender":{"origin":"goal","displayText":"Ship it"}}' },
        { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'GOAL: do everything, then deploy' }] },
      ],
      historyTurnIds: {},
    },
    'r',
  ) as Record<string, Json>;

  const row = rowAt(projected.messages as Json[], 0, 'the goal row');
  assertDeepEqual(row.localRender, { origin: 'goal', displayText: 'Ship it' }, 'the local render is attached');
  assertEqual(row.text, 'Ship it', 'the text is the user-facing objective');
  assertDeepEqual(row.contentBlocks, [{ type: 'text', text: 'Ship it' }], 'and so are the blocks');
});

h.test('history pairs a replayed image with the tool Saved: path', () => {
  // Saved keeps the source identity while returned image bytes use the profile pool.
  const root = freshRoot();
  const savedFile = join(root, 'kept.png'), inlineBytes = Buffer.from('img-bytes');
  writeFileSync(savedFile, Buffer.from('x'));

  const history: Json = {
      history: [
        {
          type: 'assistant',
          uuid: 'a1',
          content: [{ type: 'tool_use', id: 'tc1', name: 'generate', input: {} }],
        },
        {
          type: 'tool_result',
          toolUseId: 'tc1',
          content: [
            { type: 'image', base64: inlineBytes.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: `Done. Saved: ${savedFile}` },
          ],
        },
      ],
      historyTurnIds: {},
  };
  const projectImage = (): Record<string, Json> => {
    const projected = projectSessionHistory(history, 'r', root) as Record<string, Json>;
    const assistant = rowAt(projected.messages as Json[], 0, 'the assistant row');
    const result = rowAt(blocksOf(assistant, 'the assistant row'), 0, 'the tool_use block').__result as Record<string, Json>;
    return rowAt(result.content as Json[], 0, 'the image block');
  };
  const image = projectImage(), poolPath = String(image.path);
  const fileName = poolPath.slice(join(root, 'media').length + 1);
  assertEqual(image.type, 'image', 'the image block survives');
  assertEqual(image.sourcePath, savedFile, 'paired with the exact Saved: source alias');
  assert(/^[a-f0-9]{16}\.png$/.test(fileName), 'the display path names a content-addressed PNG');
  assertEqual(poolPath, join(root, 'media', fileName), 'the display file belongs directly to this isolated profile pool');
  assert(existsSync(poolPath), 'the pooled image exists');
  assert(readFileSync(poolPath).equals(inlineBytes), 'the display file preserves returned bytes instead of mutable source bytes');
  assertEqual(image.mimeType, 'image/png', 'with its mime');
  // The base64 never reaches the renderer: the row carries a path, not bytes.
  assert(!('base64' in image), 'and no base64 crossed to the renderer');
  rmSync(savedFile);
  assertDeepEqual(projectImage(), image, 'deleting the source preserves the display path and source alias on replay');
  assert(existsSync(poolPath) && readFileSync(poolPath).equals(inlineBytes), 'the pooled original bytes remain readable after source deletion');
});


h.test('history keeps strict saved-image slots and original bytes after a screenshot disappears', () => {
  const root = freshRoot(), gone = join(root, 'missing.png'), kept = join(root, 'kept, UI.png');
  const firstBytes = Buffer.from('first screenshot bytes'), secondBytes = Buffer.from('second screenshot bytes');
  writeFileSync(kept, secondBytes);
  const history: Json = { history: [
    { type: 'assistant', uuid: 'image-owner', content: [{ type: 'tool_use', id: 'capture-images', name: 'screenshot', input: {} }] },
    { type: 'tool_result', toolUseId: 'capture-images', content: [
      { type: 'text', text: 'Saved: ' + JSON.stringify([gone, kept]) + '\nVerified two states.' },
      { type: 'image', mimeType: 'image/png', base64: firstBytes.toString('base64') },
      { type: 'image', mimeType: 'image/png', base64: secondBytes.toString('base64') },
    ] },
  ], historyTurnIds: {} };
  const projectImages = (): Array<Record<string, Json>> => {
    const projected = projectSessionHistory(history, 'owner', root) as Record<string, Json>;
    const assistant = rowAt(projected.messages as Json[], 0, 'assistant');
    const result = rowAt(blocksOf(assistant, 'assistant'), 0, 'tool').__result as Record<string, Json>;
    return (result.content as Array<Record<string, Json>>).filter(block => block.type === 'image');
  };
  const images = projectImages(), expectedBytes = [firstBytes, secondBytes];
  assertEqual(images.length, 2, 'both original image slots survive');
  assertDeepEqual(images.map(image => image.sourcePath), [gone, kept], 'the missing first source cannot shift the second source alias');
  assertEqual(images[1]?.sourcePath, kept, 'the second capture keeps its own identity');
  assert(images[0]?.path !== images[1]?.path, 'distinct capture bytes keep separate pooled files');
  for (const [index, image] of images.entries()) {
    const poolPath = String(image.path), fileName = poolPath.slice(join(root, 'media').length + 1);
    assert(/^[a-f0-9]{16}\.png$/.test(fileName), 'each capture names a content-addressed PNG');
    assertEqual(poolPath, join(root, 'media', fileName), 'each capture belongs directly to this isolated profile pool');
    assertEqual(image.mimeType, 'image/png', 'each capture retains its MIME');
    assert(!('base64' in image), 'capture bytes never cross to the renderer');
    assert(existsSync(poolPath) && readFileSync(poolPath).equals(expectedBytes[index]!), 'each slot preserves its exact original bytes');
  }
  assert(readFileSync(String(images[0]?.path)).equals(firstBytes), 'the first image falls back to its own bytes');
  rmSync(kept);
  assertDeepEqual(projectImages(), images, 'source deletion preserves both replay paths and source aliases in order');
  for (const [index, image] of images.entries()) {
    assert(existsSync(String(image.path)) && readFileSync(String(image.path)).equals(expectedBytes[index]!), 'both pooled captures remain readable after all sources disappear');
  }
});
h.test('stored tool inspection restores original capture bytes independently of model vision and resizing', () => {
  const root = freshRoot(), original = Buffer.from('original full-resolution screenshot'), resized = Buffer.from('model resized screenshot');
  const scenarios: Json[] = [
    { ok: true, operation: 'browser_screenshot', response: { value: { dataUrl: 'data:image/png;base64,' + original.toString('base64'), saved: false }, artifacts: [] } },
    { contentItems: [{ type: 'inputText', text: 'Captured a visible state.' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,' + original.toString('base64') }] },
  ];
  for (const output of scenarios) for (const vision of [true, false]) {
    const content: Json[] = [{ type: 'text', text: vision ? 'Captured state.' : 'This model cannot understand images.' }];
    if (vision) content.push({ type: 'image', mimeType: 'image/png', base64: resized.toString('base64') });
    const projected = projectSessionHistory({ history: [
      { type: 'assistant', uuid: 'capturer', content: [{ type: 'tool_use', id: 'capture', name: 'capture', input: {} }] },
      { type: 'tool_result', toolUseId: 'capture', content, output },
    ], historyTurnIds: {} }, 'owner', root) as Record<string, Json>;
    const result = rowAt(blocksOf(rowAt(projected.messages as Json[], 0, 'assistant'), 'assistant'), 0, 'tool').__result as Record<string, Json>;
    const images = (result.content as Array<Record<string, Json>>).filter(block => block.type === 'image');
    assertEqual(images.length, 1, 'one original capture survives replay');
    assert(readFileSync(String(images[0]?.path)).equals(original), 'display uses original inspected bytes');
    if (!vision) assert(JSON.stringify(result.content).includes('cannot understand images'), 'model capability notice remains visible');
  }
});

h.test('every desktop session receives native media and file presentation instructions', async () => {
  const root = byoRoot(), client = new FakeClient().reply('session/start', { sessionId: 'desktop-media' });
  const { service } = serviceWith(client, root);
  try {
    await service.newSession();
    const init = rowAt(client.sent('session/start'), 0, 'desktop start').init as Record<string, Json>;
    const instructions = String(init.developerInstructions);
    for (const fragment of ['Klaus desktop', 'absolute', 'Markdown image syntax', 'actual saved artifact path', 'inspect', 'clickable Markdown link']) assert(instructions.includes(fragment), fragment + ' reaches the engine');
  } finally { await service.shutdown(); }
});

h.test('history turns an undecodable image into a readable text block', () => {
  // "An image the user cannot see is a bug worth reading, not a silent gap in the transcript."
  const root = freshRoot();
  const projected = projectSessionHistory(
    {
      history: [
        { type: 'assistant', uuid: 'a1', content: [{ type: 'image', base64: 'not!!valid!!base64', mimeType: 'image/png' }] },
      ],
      historyTurnIds: {},
    },
    'r',
    root,
  ) as Record<string, Json>;

  const assistant = rowAt(projected.messages as Json[], 0, 'the assistant row');
  const fallback = rowAt(blocksOf(assistant, 'the assistant row'), 0, 'the fallback block');
  assertEqual(fallback.type, 'text', 'a text block, not a dropped block');
  assert(String(fallback.text).includes('image unavailable'), 'saying the image is unavailable');
});

h.test('history tolerates an empty or malformed engine reply', () => {
  for (const reply of [{}, null, { history: null }, { messages: [] }]) {
    const projected = projectSessionHistory(reply as Json, 'r') as Record<string, Json>;
    assertDeepEqual(projected.messages, [], `${JSON.stringify(reply)} -> no messages`);
    assertDeepEqual(projected.agentNotifications, [], 'and no notifications');
    assertDeepEqual(projected.turnStatuses, {}, 'with every turn map defaulted');
  }
  // The older `messages` key is accepted too (engine.rs:3325-3328 reads either).
  const legacy = projectSessionHistory(
    { messages: [{ type: 'user', uuid: 'u', content: [{ type: 'text', text: 'hi' }] }] },
    'r',
  ) as Record<string, Json>;
  assertEqual((legacy.messages as Json[]).length, 1, 'a legacy `messages` reply renders');
});

h.test('a saved session source survives later changes to the global model default', () => {
  const root = byoRoot();
  kvSet('composer.main_model', 'custom:pinned', root);
  const first = resolveSessionAuth('saved-thread', root);
  kvSet('composer.main_model', 'codex:next-default', root);
  kvSet('auth_mode', 'codex', root);
  assertDeepEqual(resolveSessionAuth('saved-thread', root), first, 'the old conversation stays on its saved BYO model');
  const next = resolveSessionAuth('new-thread', root);
  assert(next.kind === 'engineModel', 'the new BYO choice is available');
  assertEqual(next.source, 'codex', 'a new conversation captures the latest source');
  assertEqual(next.selection, 'codex:next-default', 'a new conversation captures the latest model');
});

h.test('session cwd preserves project bindings and creates safe scratch directories', () => {
  const root = freshRoot();
  const project = join(root, 'project');
  bindSessionWorkdir('project-thread', project, root);
  assertEqual(sessionDir('project-thread', root), project, 'existing workdir binding wins');
  const scratch = sessionDir('../escape', root);
  assertEqual(scratch, join(root, 'sessions', '___escape'), 'a session ID cannot traverse out of its root');
  assert(existsSync(scratch), 'the engine receives an existing scratch cwd');
  assertEqual(sessionDir('__control__', root), join(root, 'sessions', '__klaus__'), 'internal sessions use the canonical anchor');
});

h.test('reconnection invalidates running state and restores the thread on the new engine generation', async () => {
  const root = byoRoot();
  const old = new FakeClient().reply('session/start', { sessionId: 'old-engine-session' });
  const next = new FakeClient().reply('session/start', { sessionId: 'new-engine-session' });
  const state = new HostState();
  let generation = 0; const disconnected: number[] = [];
  const service = new SessionService({
    manager: { attach: async () => ({ client: ++generation === 1 ? old : next, generation }), shutdownAll: async () => {} },
    state, configRoot: root, spawnOptions: () => ({ command: '/unused', args: [], env: [] }), pushChatEvents: () => {},
    onDisconnected: generation => { disconnected.push(generation); },
  });
  assertEqual(await service.resolveLiveSession('thread'), 'old-engine-session', 'first engine attached');
  state.markTurnRunning('thread', 'old-turn');
  old.closed = true;
  old.emit('event', { type: 'streamClosed' });
  assertEqual(state.runningSessions().includes('thread'), false, 'disconnect ends stale running state');
  assertEqual(await service.resolveLiveSession('thread'), 'new-engine-session', 'a new engine session is created');
  assertEqual(rowAt(next.sent('session/start'), 0, 'resume').resume, 'thread', 'the persisted thread identity is resumed');
  old.emit('event', { type: 'streamClosed' });
  assertDeepEqual(disconnected, [1], 'one unexpected disconnect notification for the attached generation');
  await service.shutdown(); next.closed = true; next.emit('event', { type: 'streamClosed' });
  assertDeepEqual(disconnected, [1], 'normal shutdown does not report an engine crash');
});

h.test('archived sessions exclude active rows from an includeArchived page', async () => {
  const root = freshRoot();
  const client = new FakeClient().reply('engine/listSessions', {
    sessions: { items: [{ id: 'active', archived: false }, { id: 'archived', archived: true }], nextCursor: null },
  });
  const { service } = serviceWith(client, root);
  const rows = await service.listArchivedSessions();
  assertEqual(rows.length, 1, 'only archived rows are returned');
  assertEqual(rowAt(rows, 0, 'archived row').id, 'archived', 'the active thread was excluded');
});

h.test('structural changes preserve an active turn and serialize the next close and resume', async () => {
  let releaseClose: () => void = () => {};
  const closed = new Promise<void>(resolve => { releaseClose = resolve; });
  class SlowCloseClient extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      const reply = await super.requestWithTimeout(method, params);
      if (method === 'session/close') await closed;
      return reply;
    }
  }
  const client = new SlowCloseClient().replySequence('session/start', [{ sessionId: 'old' }, { sessionId: 'new' }]).reply('session/close', {});
  const { service, state } = serviceWith(client, byoRoot());
  await service.resolveLiveSession('thread');
  state.markTurnRunning('thread', 'turn');
  state.markStale('thread');
  assertEqual(await service.resolveLiveSession('thread'), 'old', 'history or a panel query keeps the active writer');
  assertEqual(client.sent('session/close').length, 0, 'an active turn was not closed');
  state.clearTurnRunning('thread');
  const first = service.resolveLiveSession('thread'), second = service.resolveLiveSession('thread');
  await waitFor(() => client.sent('session/close').length === 1, 1000, 'old writer is closing');
  assertEqual(client.sent('session/start').length, 1, 'no caller resumes before the old writer is closed');
  releaseClose();
  assertDeepEqual(await Promise.all([first, second]), ['new', 'new'], 'both callers use the same replacement session');
  assertEqual(client.sent('session/start').length, 2, 'only one replacement was started');
});

/**
 * The host tool context above reads `bindingUsable`, so the model's own durable
 * write cannot invalidate the call that made it. Deleting a slash command marks
 * every binding stale through `configuration.markChanged()`; treating that as
 * "this conversation is gone" failed the tool AFTER the file was already gone and
 * took the rest of the turn's `klaus_query`/`klaus_action` calls down with it.
 * The rule has to match `resolveLiveSession`, which keeps serving a stale binding
 * while its turn runs (the previous test).
 */
h.test('a settings write during a turn keeps the binding usable, and identity is still enforced', () => {
  const state = new HostState();
  const binding = { rendererId: 'thread', engineId: 'live' };
  assertEqual(state.bindingUsable(binding), false, 'an unknown conversation has no binding to act on');
  state.rememberSession('thread', 'live', { cwd: '/fixture' });
  assertEqual(state.bindingUsable(binding), true, 'a fresh binding is usable');
  state.markStale('thread');
  assertEqual(state.bindingUsable(binding), false, 'an idle stale binding is rebuilt, not acted on');
  state.markTurnRunning('thread', 'turn');
  assertEqual(state.bindingUsable(binding), true, 'a durable write during this turn cannot revoke the turn\'s own identity');
  state.clearTurnRunning('thread');
  assertEqual(state.bindingUsable(binding), false, 'the deferral ends with the turn');
  state.markTurnRunning('thread', 'turn');
  state.rememberSession('thread', 'rebuilt', { cwd: '/fixture' });
  assertEqual(state.bindingUsable(binding), false, 'a rebuilt engine session is a different conversation');
  assertEqual(state.bindingUsable({ rendererId: 'thread', engineId: 'rebuilt' }), true, 'the replacement binding itself is usable');
  state.forgetSession('thread');
  assertEqual(state.bindingUsable({ rendererId: 'thread', engineId: 'rebuilt' }), false, 'a dropped binding is not usable');
  // The safety half of the rule: a running turn alone must not resurrect a conversation
  // whose binding is gone, or `bindingUsable` would hand out an identity for a session
  // the engine no longer holds.
  state.markTurnRunning('thread', 'orphan-turn');
  assertEqual(state.bindingUsable({ rendererId: 'thread', engineId: 'rebuilt' }), false, 'a running turn cannot resurrect a dropped binding');
  state.clearTurnRunning('thread');
});

h.test('idle retirement skips running and background-owned conversations, then closes the oldest idle writer', async () => {
  const client = new FakeClient()
    .replySequence('session/backgroundProcesses', [
      { backgroundProcesses: { processes: [{ shellId: 'shell', status: 'running' }] } },
      { backgroundProcesses: { processes: [] } },
    ])
    .reply('session/close', {});
  const { service, state } = serviceWith(client, freshRoot());
  await service.client();
  for (const id of ['a-running', 'b-background', 'c-oldest-idle', 'd-idle', 'e-idle', 'f-idle', 'z-current']) {
    state.rememberSession(id, `engine-${id}`, {});
  }
  state.markTurnRunning('a-running', 'turn');
  assertEqual(await service.resolveLiveSession('z-current'), 'engine-z-current', 'the requested binding remains live');
  await waitFor(() => client.sent('session/close').length === 1, 1000, 'one excess idle binding is retired');
  assertEqual(rowAt(client.sent('session/close'), 0, 'retired writer').sessionId, 'engine-c-oldest-idle', 'the oldest unprotected writer is closed');
  assertEqual(state.liveSession('a-running'), 'engine-a-running', 'a running turn is protected');
  assertEqual(state.liveSession('b-background'), 'engine-b-background', 'a live background process is protected');
  assertEqual(state.liveCount(), recoveryVectors.liveSessionLimit, 'the process returns to the bounded live-session limit');
  await service.shutdown();
});

h.test('inactive sessions below the capacity limit retire at a deadline and restore through the ordinary cold path', async () => {
  let now = 0, timer: { at: number; run(): void } | undefined;
  const client = new FakeClient().reply('session/close', {}).reply('session/start', { sessionId: 'replacement' });
  const { service, state } = serviceWith(client, byoRoot(), undefined, {
    retirementClock: () => now,
    retirementSchedule: (run, delay) => { const scheduled = { at: now + delay, run: () => { if (timer === scheduled) timer = undefined; run(); } }; timer = scheduled; return () => { if (timer === scheduled) timer = undefined; }; },
  });
  await service.client();
  state.rememberSession('old', 'engine-old', {}); state.rememberSession('visible', 'engine-visible', {});
  service.retainView(1, 'visible', 'main');
  try {
    await service.resolveLiveSession('old');
    await waitFor(() => timer !== undefined && !(service as unknown as { idleRetirement?: Promise<void> }).idleRetirement, 1000, 'an inactive deadline is scheduled without pressure');
    assertEqual(timer!.at, recoveryVectors.idleRetirement.idleMs, 'idle interval starts after the request lease settles');
    now = timer!.at; timer!.run();
    await waitFor(() => state.liveSession('old') === undefined, 1000, 'deadline releases the idle handle without another user request');
    assertEqual(state.liveSession('visible'), 'engine-visible', 'the mounted surface retains its resources');
    assertEqual(await service.resolveLiveSession('old'), 'replacement', 'ordinary access restores an unloaded conversation');
    assertEqual(client.sent('session/start').length, 1, 'cold access starts one replacement');
    assertEqual(object(client.sent('session/close')[0])?.sessionId, 'engine-old', 'the idle engine handle was closed');
  } finally { await service.shutdown(); }
  assertEqual(timer, undefined, 'shutdown cancels the next idle deadline');
});

h.test('idle deadlines preserve running, stopping, queued, goal and pending-interaction ownership', async () => {
  for (const phase of ['running', 'stopping', 'queue', 'goal', 'approval', 'elicitation', 'external', 'background'] as const) {
    let now = 0, timer: { at: number; run(): void } | undefined;
    class ProtectedActivityClient extends FakeClient {
      override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
        if (phase === 'background' && method === 'session/backgroundProcesses' && object(params)?.sessionId === 'engine-protected') {
          this.calls.push({ method, params }); return { backgroundProcesses: { processes: [{ shellId: 'active-shell', status: 'running' }] } };
        }
        return super.requestWithTimeout(method, params);
      }
    }
    const client = new ProtectedActivityClient().reply('session/close', {});
    const { service, state } = serviceWith(client, freshRoot(), undefined, {
      retirementClock: () => now, isSessionRetirementProtected: id => phase === 'external' && id === 'protected',
      retirementSchedule: (run, delay) => { const scheduled = { at: now + delay, run: () => { if (timer === scheduled) timer = undefined; run(); } }; timer = scheduled; return () => { if (timer === scheduled) timer = undefined; }; },
    });
    await service.client(); state.rememberSession('protected', 'engine-protected', {}); state.rememberSession('idle', 'engine-idle', {});
    if (phase === 'running') state.markTurnRunning('protected', 'active-turn');
    if (phase === 'stopping') state.noteInterruptWindow('protected');
    if (phase === 'queue') state.installQueueSnapshot('protected', { revision: 1, status: 'authoritative', items: [{ state: 'pending', message: { uuid: 'pending', priority: 'next', value: 'queued input' } }] });
    if (phase === 'goal') state.workflows.installGoal('protected', { goal: { ...recoveredGoal('protected'), status: 'active' } as never, goalRevision: 1 });
    if (phase === 'approval' || phase === 'elicitation') state.parkReverse({ requestId: 'pending', sessionId: 'protected', isApproval: phase === 'approval', card: {}, toolName: 'fixture',
      request: { id: 1, method: 'approval/request', params: {}, outstanding: true, respond: async () => {}, respondError: async () => {} } });
    try {
      await service.resolveLiveSession('idle');
      await waitFor(() => timer !== undefined && !(service as unknown as { idleRetirement?: Promise<void> }).idleRetirement, 1000, phase + ': timer ready');
      now = timer!.at; timer!.run();
      await waitFor(() => !state.liveSession('idle'), 1000, phase + ': unrelated idle handle expires');
      assertEqual(state.liveSession('protected'), 'engine-protected', phase + ': active ownership survives the deadline');
      assertDeepEqual(client.sent('session/close').map(row => object(row)?.sessionId), ['engine-idle'], phase + ': only the idle writer closes');
    } finally { await service.shutdown(); }
  }
});

h.test('multiple mounted views postpone retirement until the last matching owner releases', async () => {
  let now = 0, timer: { at: number; run(): void } | undefined;
  const client = new FakeClient().reply('session/close', {});
  const { service, state } = serviceWith(client, freshRoot(), undefined, {
    retirementClock: () => now,
    retirementSchedule: (run, delay) => { const scheduled = { at: now + delay, run: () => { if (timer === scheduled) timer = undefined; run(); } }; timer = scheduled; return () => { if (timer === scheduled) timer = undefined; }; },
  });
  await service.client(); state.rememberSession('chat', 'engine-chat', {});
  service.retainView(1, 'chat', 'old'); service.retainView(1, 'chat', 'new'); service.retainView(2, 'chat', 'main');
  try {
    service.releaseView(1, 'chat', 'old'); service.releaseView(1, 'chat', 'old'); service.releaseViewOwner(1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assertEqual(timer, undefined, 'a second window still retains the conversation');
    now = 12_345; service.releaseViewOwner(2);
    await waitFor(() => timer !== undefined && !(service as unknown as { idleRetirement?: Promise<void> }).idleRetirement, 1000, 'the final owner starts the idle interval');
    assertEqual(timer!.at, now + recoveryVectors.idleRetirement.idleMs, 'release gets a fresh inactivity interval');
    now = timer!.at; timer!.run();
    await waitFor(() => state.liveSession('chat') === undefined, 1000, 'last released view can retire');
  } finally { await service.shutdown(); }
});

h.test('a view acquired during the asynchronous activity probe prevents a deadline close', async () => {
  let now = 0, timer: { at: number; run(): void } | undefined, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class DelayedViewProbe extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/backgroundProcesses') { this.calls.push({ method, params }); await gate; return { backgroundProcesses: { processes: [] } }; }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new DelayedViewProbe().reply('session/close', {});
  const { service, state } = serviceWith(client, freshRoot(), undefined, {
    retirementClock: () => now,
    retirementSchedule: (run, delay) => { const scheduled = { at: now + delay, run: () => { if (timer === scheduled) timer = undefined; run(); } }; timer = scheduled; return () => { if (timer === scheduled) timer = undefined; }; },
  });
  await service.client(); state.rememberSession('chat', 'engine-chat', {});
  try {
    await service.resolveLiveSession('chat'); await waitFor(() => timer !== undefined && !(service as unknown as { idleRetirement?: Promise<void> }).idleRetirement, 1000, 'idle timer ready');
    now = timer!.at; timer!.run(); await waitFor(() => client.sent('session/backgroundProcesses').length === 1, 1000, 'probe is pending');
    service.retainView(1, 'chat', 'new'); release(); await new Promise(resolve => setTimeout(resolve, 20));
    assertEqual(client.sent('session/close').length, 0, 'a late view protects the handle after the probe');
    assertEqual(state.liveSession('chat'), 'engine-chat', 'the new view keeps its writer');
  } finally { release(); await service.shutdown(); }
});

h.test('voice reservations keep connecting, active and stopping conversations out of idle retirement', async () => {
  const contract = JSON.parse(readFileSync(vectorPath('voice-chat-vectors.json'), 'utf8')) as { idleRetirement: { protectedPhases: string[] } };
  for (const phase of contract.idleRetirement.protectedPhases) {
    let reserved = true;
    const client = new FakeClient().reply('session/close', {});
    const { service, state } = serviceWith(client, freshRoot(), undefined, {
      isSessionRetirementProtected: id => reserved && id === 'a-voice',
    });
    await service.client();
    for (const id of ['a-voice', 'b-idle', 'c', 'd', 'e', 'f', 'z']) state.rememberSession(id, `engine-${id}`, {});
    for (const id of ['c', 'd', 'e', 'f']) state.markTurnRunning(id, `turn-${id}`);
    try {
      await service.resolveLiveSession('z');
      await waitFor(() => state.liveCount() === recoveryVectors.liveSessionLimit, 1000, `${phase}: idle writer retired`);
      assertEqual(state.isWorking('a-voice'), false, 'audio does not impersonate a text turn');
      assertEqual(state.liveSession('a-voice'), 'engine-a-voice', `${phase}: the reserved audio writer survives`);
      assertEqual(rowAt(client.sent('session/close'), 0, 'idle writer').sessionId, 'engine-b-idle', 'ordinary idle cleanup remains enabled');
      reserved = false;
      state.rememberSession('new-idle', 'engine-new-idle', {});
      await service.resolveLiveSession('z');
      await waitFor(() => state.liveSession('a-voice') === undefined, 1000, 'released voice reservation can retire');
    } finally { await service.shutdown(); }
  }
});

h.test('a voice reservation acquired during an idle probe prevents its pending close', async () => {
  let reserved = false, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  class PausedVoiceProbe extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/backgroundProcesses' && object(params)?.sessionId === 'engine-a-voice') {
        this.calls.push({ method, params }); await barrier;
        return { backgroundProcesses: { processes: [] } };
      }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new PausedVoiceProbe().reply('session/close', {});
  const { service, state } = serviceWith(client, freshRoot(), undefined, {
    isSessionRetirementProtected: id => reserved && id === 'a-voice',
  });
  await service.client();
  for (const id of ['a-voice', 'b-idle', 'c', 'd', 'e', 'f', 'z']) state.rememberSession(id, `engine-${id}`, {});
  for (const id of ['c', 'd', 'e', 'f']) state.markTurnRunning(id, `turn-${id}`);
  try {
    await service.resolveLiveSession('z');
    await waitFor(() => client.sent('session/backgroundProcesses').length === 1, 1000, 'idle probe is suspended');
    reserved = true; release();
    await waitFor(() => state.liveCount() === recoveryVectors.liveSessionLimit, 1000, 'the next idle writer closes');
    assertEqual(state.liveSession('a-voice'), 'engine-a-voice', 'a stale idle observation cannot cancel voice startup');
    assertDeepEqual(client.sent('session/close').map(row => object(row)?.sessionId), ['engine-b-idle'], 'only the unrelated idle writer was closed');
  } finally { release(); await service.shutdown(); }
});

h.test('unconfirmed idle closes fence reads and inference until teardown is acknowledged', async () => {
  for (const unknownReceipt of [false, true]) {
    let now = 0, retry = false, closeEntered = false, release!: () => void;
    const closeGate = new Promise<void>(resolve => { release = resolve; });
    class DelayedClose extends FakeClient {
      override async requestWithTimeout(method: string, params: Json, timeoutMs?: number): Promise<unknown> {
        if (method === 'session/close' && object(params)?.sessionId === 'engine-a-old') {
          this.calls.push({ method, params });
          assertEqual(timeoutMs, recoveryVectors.closeRecovery.deadlineMs, 'teardown has its own deadline');
          if (!retry) throw { kind: 'timeout', method };
          closeEntered = true;
          await closeGate;
          if (unknownReceipt) throw { kind: 'server', code: -32004, message: 'unknown session' };
          return {};
        }
        return super.requestWithTimeout(method, params);
      }
    }
    const client = new DelayedClose().reply('session/start', { sessionId: 'replacement' })
      .reply('session/contextSnapshot', { context: { totalTokens: 20, contextWindow: 100 } });
    const { service, state } = serviceWith(client, byoRoot(), undefined, { retirementClock: () => now });
    await service.client();
    for (const id of ['a-old', 'b', 'c', 'd', 'e', 'f', 'z']) state.rememberSession(id, `engine-${id}`, {});
    try {
      await service.resolveLiveSession('z');
      await waitFor(() => service.isSessionClosing('a-old'), 1000, 'unconfirmed teardown fence');
      assertEqual(state.liveSession('a-old'), 'engine-a-old', 'retain the writer until a receipt');
      for (const method of ['session/contextSnapshot', 'session/goal', 'session/taskList']) {
        const error = await assertRejects(() => service.requestSession('a-old', method), 'reads are fenced') as { code?: string };
        assertEqual(error.code, recoveryVectors.closeRecovery.pendingCode, 'retryable lifecycle state');
        assertEqual(client.sent(method).length, 0, 'no query reaches the draining handle');
      }
      const sendError = await assertRejects(() => service.send('a-old', { text: 'wait for cleanup' }), 'inference is fenced') as { code?: string };
      assertEqual(sendError.code, recoveryVectors.closeRecovery.pendingCode, 'sends share the same fence');
      assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no turn starts during teardown');
      retry = true; now += recoveryVectors.startupRecovery.retryBaseMs;
      const read = service.requestSession('a-old', 'session/contextSnapshot');
      await waitFor(() => closeEntered, 1000, 'read rejoins pending teardown');
      assertEqual(client.sent('session/start').length, 0, 'the old writer cannot be replaced before a receipt');
      assertEqual(client.sent('session/contextSnapshot').length, 0, 'read waits for teardown');
      release();
      assertEqual(object(await read)?.context !== undefined, true, 'read succeeds after recovery');
      assertEqual(client.sent('session/start').length, 1, 'one replacement after confirmed teardown');
      assertEqual(object(client.sent('session/contextSnapshot')[0])?.sessionId, 'replacement', 'read uses the recovered handle');
      assertEqual(service.isSessionClosing('a-old'), false, 'confirmed receipt releases admission');
    } finally { release(); await service.shutdown(); }
  }
});

h.test('scoped query RPCs retain the lifecycle lease until their result arrives', async () => {
  let reading = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class DelayedRead extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/contextSnapshot') {
        this.calls.push({ method, params }); reading = true;
        await gate; return { context: { totalTokens: 20, contextWindow: 100 } };
      }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new DelayedRead().reply('session/close', {})
    .replyAcknowledged('session/deleteSession', { deleted: { threadId: 'chat', deleted: true } });
  const { service, state } = serviceWith(client, freshRoot());
  await service.client(); state.rememberSession('chat', 'engine-chat', {});
  const read = service.requestSession('chat', 'session/contextSnapshot');
  let deletion: Promise<Json> | undefined;
  try {
    await waitFor(() => reading, 1000, 'query RPC in flight');
    deletion = service.deleteSession('chat');
    await waitFor(() => service.isSessionClosing('chat'), 1000, 'delete prepares close');
    assertEqual(client.sent('session/close').length, 0, 'close cannot cross the query lease');
    release(); await read; await deletion;
    assertEqual(client.sent('session/close').length, 1, 'close follows the completed read');
    assertEqual(state.liveSession('chat'), undefined, 'delete releases the binding');
  } finally { release(); await deletion?.catch(() => {}); await service.shutdown(); }
});

const goalReadLifecycle = JSON.parse(readFileSync(vectorPath('planning-goals-vectors.json'), 'utf8')).goalReadLifecycle as { readyMethods: string[]; priority: string; runtimeConfigOutcomeField: string };
const recoveredGoal = (threadId = 'thread', goalId = 'recovered') => ({ threadId, goalId, objective: 'Retain the saved objective', status: 'paused', tokensUsed: 10, timeUsedSeconds: 1, createdAtMs: 1, updatedAtMs: 2 });

for (const barrier of goalReadLifecycle.readyMethods) for (const resumed of [true, false]) h.test(`goal hydration follows ${barrier} readiness without delaying ${resumed ? 'resume' : 'creation'}`, async () => {
  let releaseBarrier!: () => void, releaseGoal!: (value: Json) => void;
  const barrierWait = new Promise<void>(resolve => { releaseBarrier = resolve; });
  const goalWait = new Promise<Json>(resolve => { releaseGoal = resolve; });
  let entered = false, goalThread = '', priority: string | undefined;
  class ReadinessClient extends FakeClient {
    override async requestWithTimeout(method: string, params: Json, _timeout?: number, options?: RpcRequestOptions): Promise<unknown> {
      if (method === 'session/goal') {
        this.calls.push({ method, params }); goalThread = String(object(params)?.threadId); priority = options?.priority;
        return goalWait;
      }
      const reply = await super.requestWithTimeout(method, params);
      if (method === barrier) { entered = true; await barrierWait; }
      return reply;
    }
  }
  const client = new ReadinessClient().reply('session/start', { sessionId: 'live' });
  const published: Json[] = [];
  const { service, state } = serviceWith(client, byoRoot(), undefined, { onGoalSnapshot: (_id, snapshot) => published.push(snapshot as unknown as Json) });
  try {
    const starting = resumed ? service.resolveLiveSession('thread') : service.newSession();
    await waitFor(() => entered, 1000, 'activation barrier entered');
    assertEqual(client.sent('session/goal').length, 0, 'goal state is not queried while activation is incomplete');
    releaseBarrier(); await starting;
    await waitFor(() => goalThread !== '', 1000, 'background goal read entered');
    assertEqual(published.length, 0, 'runtime readiness does not require a goal response');
    assertEqual(priority, goalReadLifecycle.priority, 'ordinary hydration uses background capacity');
    releaseGoal({ threadGoal: recoveredGoal(goalThread), goalRevision: 1 });
    await waitFor(() => published.length === 1, 1000, 'goal snapshot published');
    assertEqual(state.workflows.goal(goalThread)?.goal?.goalId, 'recovered', 'the recovered state reaches the shared cache');
    const count = client.sent('session/goal').length;
    await service.resolveLiveSession(goalThread);
    assertEqual(client.sent('session/goal').length, count, 're-entering a ready runtime reuses its snapshot');
  } finally { releaseBarrier(); releaseGoal({ threadGoal: null, goalRevision: 1 }); await service.shutdown(); }
});

h.test('an explicit goal review during start waits for recovery and shares its hydration', async () => {
  let releaseStart!: () => void, releaseGoal!: (value: Json) => void;
  const startWait = new Promise<void>(resolve => { releaseStart = resolve; });
  const goalWait = new Promise<Json>(resolve => { releaseGoal = resolve; });
  let entered = false;
  class PendingStart extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/goal') { this.calls.push({ method, params }); return goalWait; }
      const reply = await super.requestWithTimeout(method, params);
      if (method === 'session/start') { entered = true; await startWait; }
      return reply;
    }
  }
  const client = new PendingStart().reply('session/start', { sessionId: 'live' });
  const published: Json[] = [];
  const config = byoRoot(), { service, state } = serviceWith(client, config, undefined, { onGoalSnapshot: (_id, snapshot) => published.push(snapshot as unknown as Json) });
  try {
    const recovering = service.resolveLiveSession('thread');
    await waitFor(() => entered, 1000, 'start acknowledgement held');
    const review = new SessionQueries(service, state, config).goal('thread');
    await new Promise(resolve => setTimeout(resolve, 0));
    assertEqual(client.sent('session/goal').length, 0, 'review cannot cross the pending start');
    releaseStart(); await recovering;
    await waitFor(() => client.sent('session/goal').length === 1, 1000, 'review read entered');
    releaseGoal({ threadGoal: recoveredGoal(), goalRevision: 1 });
    assertEqual(object((await review).goal)?.goalId, 'recovered', 'review receives the restored state');
    await waitFor(() => published.length === 1, 1000, 'shared hydration published');
    assertEqual(client.sent('session/goal').length, 1, 'automatic hydration does not replace the explicit review read');
  } finally { releaseStart(); releaseGoal({ threadGoal: null, goalRevision: 1 }); await service.shutdown(); }
});

h.test('goal hydration failure preserves runtime readiness and the last authoritative snapshot', async () => {
  const client = new FakeClient().reply('session/start', { sessionId: 'live' }).failWith('session/goal');
  const logs: string[] = [], published: Json[] = [];
  const { service, state, pushed } = serviceWith(client, byoRoot(), undefined, {
    onGoalSnapshot: (_id, snapshot) => published.push(snapshot as unknown as Json), log: (kind, detail) => logs.push(`${kind}: ${detail}`),
  });
  const previous = state.workflows.installGoal('thread', { goal: recoveredGoal() as never, goalRevision: 3 });
  assertEqual(await service.resolveLiveSession('thread'), 'live', 'runtime recovery succeeds');
  await waitFor(() => logs.some(line => line.includes('session-query-unavailable') && line.includes('session/goal')), 1000, 'read failure recorded');
  assertEqual(state.workflows.goal('thread'), previous, 'failure retains the last authoritative goal');
  assertEqual(client.sent('session/close').length, 0, 'a goal read failure does not roll back activation');
  assertEqual(published.length, 0, 'a failed read publishes no invented absence');
  assertEqual(pushed.filter(event => object(event)?.type === 'api_error').length, 0, 'background failure adds no conversation error');
  await service.shutdown();
});

for (const invalidation of ['close', 'delete', 'disconnect', 'same-id-resume'] as const) h.test(`${invalidation} invalidates a pending goal hydration even when its response has a higher revision`, async () => {
  let releaseGoal!: (value: Json) => void, reads = 0;
  const response = new Promise<Json>(resolve => { releaseGoal = resolve; });
  class DelayedGoal extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/goal') {
        this.calls.push({ method, params });
        return ++reads === 1 ? response : { threadGoal: recoveredGoal('thread', 'replacement'), goalRevision: 2 };
      }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new DelayedGoal().reply('session/start', { sessionId: 'thread' }).reply('session/close', {})
    .replyAcknowledged('session/deleteSession', { deleted: { threadId: 'thread', deleted: true } });
  const published: Json[] = [];
  const { service, state } = serviceWith(client, byoRoot(), undefined, { onGoalSnapshot: (_id, snapshot) => published.push(snapshot as unknown as Json) });
  try {
    await service.resolveLiveSession('thread');
    await waitFor(() => reads === 1, 1000, 'old goal read entered');
    if (invalidation === 'disconnect') { client.closed = true; client.emit('event', { type: 'streamClosed' }); }
    else if (invalidation === 'delete') await service.deleteSession('thread');
    else { const release = await service.quiesceDirectory(await service.directory('thread')); release(); }
    if (invalidation === 'same-id-resume') {
      await service.resolveLiveSession('thread');
      await waitFor(() => state.workflows.goal('thread')?.goal?.goalId === 'replacement', 1000, 'replacement runtime hydrated');
    }
    const count = published.length;
    releaseGoal({ threadGoal: recoveredGoal('thread', 'obsolete'), goalRevision: 99 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assertEqual(published.length, count, 'retired hydration cannot publish');
    assert(state.workflows.goal('thread')?.goal?.goalId !== 'obsolete', 'retired hydration cannot enter the shared cache');
  } finally { releaseGoal({ threadGoal: null, goalRevision: 1 }); await service.shutdown(); }
});

h.test('parallel resolves wait for readiness before subscribing and admitting a turn', async () => {
  let ready!: () => void, preparing = false;
  const gate = new Promise<void>(resolve => { ready = resolve; });
  class Restoring extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method !== 'session/prepare') return super.requestWithTimeout(method, params);
      this.calls.push({ method, params }); preparing = true; await gate;
      return { sessionId: 'restored-live', ready: true };
    }
  }
  const client = new Restoring().reply('session/start', { sessionId: 'restored-live' }).replySubmit('start-if-idle', 'ready-turn');
  const { service, state } = serviceWith(client, byoRoot());
  const first = service.resolveLiveSession('chat'), second = service.resolveLiveSession('chat');
  try {
    await waitFor(() => preparing, 1000, 'restoration entered');
    assertEqual(state.liveSession('chat'), 'restored-live', 'publication events have their renderer binding');
    assertEqual(client.sent('session/subscribe').length, 0, 'activation waits for readiness');
    assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no inference before readiness');
    ready();
    assertDeepEqual(await Promise.all([first, second]), ['restored-live', 'restored-live'], 'parallel callers share readiness');
    assertEqual(client.sent('session/start').length, 1, 'one endpoint');
    assertEqual(client.sent('session/prepare').length, 1, 'one host preparation');
    assertDeepEqual(client.calls.filter(call => recoveryVectors.startupRecovery.preparation.activationOrder.includes(call.method)).map(call => call.method), recoveryVectors.startupRecovery.preparation.activationOrder, 'prepare, subscribe and queue seed retain their order');
    assertEqual(client.sent('session/taskList').length, 0, 'task data is not a readiness probe');
    await service.send('chat', { text: 'continue' });
    assertEqual(client.sentSubmit('start-if-idle').length, 1, 'ready conversation accepts inference');
  } finally { ready(); await service.shutdown(); }
});

h.test('preparation deadlines retain the writer and a later resolve reattaches to it', async () => {
  let timeout = true;
  const budgets: number[] = [];
  class TimedPreparation extends FakeClient {
    override async requestWithTimeout(method: string, params: Json, timeoutMs?: number): Promise<unknown> {
      if (method !== 'session/prepare') return super.requestWithTimeout(method, params);
      this.calls.push({ method, params }); budgets.push(timeoutMs!);
      if (timeout) throw { kind: 'timeout', method };
      return { sessionId: 'restored-live', ready: true };
    }
  }
  const client = new TimedPreparation().reply('session/start', { sessionId: 'restored-live' }).replySubmit('start-if-idle', 'ready-turn');
  const { service, state } = serviceWith(client, byoRoot());
  const failure = await assertRejects(() => service.resolveLiveSession('chat'), 'local wait exhausted');
  assert(failure instanceof SessionPreparationPendingError, 'readiness remains pending');
  assertDeepEqual(budgets, recoveryVectors.startupRecovery.preparation.timeoutDelaysMs, 'dedicated preparation deadlines');
  assertEqual(state.liveSession('chat'), 'restored-live', 'writer ownership retained');
  assertEqual(client.sent('session/close').length, 0, 'a deadline never closes recovery');
  assertEqual(client.sent('session/subscribe').length, 0, 'unfinished activation cannot publish ready');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'input is still unsent');
  timeout = false;
  await service.send('chat', { text: 'continue' });
  assertEqual(client.sent('session/start').length, 1, 'retry reuses the endpoint');
  assertEqual(client.sent('session/prepare').length, 4, 'retry attaches to the same restoration');
  assertEqual(client.sent('session/subscribe').length, 1, 'activation finishes once');
  assertEqual(client.sentSubmit('start-if-idle').length, 1, 'input is admitted once after readiness');
  await service.shutdown();
});

h.test('publication queue events survive readiness and supersede the activation snapshot', async () => {
  class Publishing extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method !== 'session/prepare') return super.requestWithTimeout(method, params);
      this.calls.push({ method, params });
      const event = { type: 'rawSessionEvent', params: { sessionId: 'published-live', event: { queueSnapshot: { revision: 2, status: 'authoritative', items: [] } } } };
      this.emit('event', event);
      return { sessionId: 'published-live', ready: true };
    }
  }
  const client = new Publishing().reply('session/start', { sessionId: 'published-live' })
    .reply('session/queueSnapshot', { queueSnapshot: { revision: 2, status: 'authoritative', items: [] } });
  const delivered: Json[] = [];
  const forwarder = new ChatEventForwarder((_channel, events) => { if (Array.isArray(events)) delivered.push(...events); });
  let pump!: SessionEventPump;
  const { service, state, pushed } = serviceWith(client, byoRoot(), undefined, { onEvent: (event, generation) => pump.receive(event, generation) });
  pump = new SessionEventPump({ state, forwarder, emit: () => {}, currentGeneration: () => service.engine()?.generation, log: () => {} });
  try {
    await service.resolveLiveSession('chat'); forwarder.flush();
    assertEqual(state.queueSnapshot('chat')?.revision, 2, 'publication snapshot retains its newer revision');
    assertEqual(delivered.filter(event => object(event)?.type === 'queue_snapshot').length, 1, 'one publication snapshot reaches the renderer');
    assertEqual(pushed.filter(event => object(event)?.type === 'queue_snapshot').length, 0, 'the same activation snapshot cannot be replayed');
    assertEqual(client.sent('session/subscribe').length, 1, 'one subscription receipt');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('connection loss during preparation cannot admit an old turn or cross engine generations', async () => {
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class LostPreparation extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method !== 'session/prepare') return super.requestWithTimeout(method, params);
      this.calls.push({ method, params }); entered = true; await gate;
      return { sessionId: 'old-live', ready: true };
    }
  }
  const oldClient = new LostPreparation().reply('session/start', { sessionId: 'old-live' });
  const replacement = new FakeClient().reply('session/start', { sessionId: 'new-live' }).replySubmit('start-if-idle', 'new-turn');
  let current: FakeClient = oldClient;
  const { service, state } = serviceWith(oldClient, byoRoot(), undefined, { manager: {
    attach: async () => ({ client: current, generation: current === oldClient ? 1 : 2 }),
    shutdownAll: async () => { current.closed = true; },
  } });
  const first = service.send('chat', { text: 'continue' });
  const failure = assertRejects(() => first, 'old readiness cannot authorize inference');
  try {
    await waitFor(() => entered, 1000, 'old preparation entered');
    oldClient.closed = true; current = replacement; oldClient.emit('event', { type: 'streamClosed' });
    release();
    assertEqual((await failure as { code?: string }).code, 'ENGINE_DISCONNECTED', 'connection loss is explicit');
    assertEqual(state.liveSession('chat'), undefined, 'old generation binding is retired');
    assertEqual(oldClient.sentSubmit('start-if-idle').length, 0, 'old engine never receives the input');
    assertEqual(oldClient.sent('session/subscribe').length, 0, 'late old receipt cannot activate');
    await service.send('chat', { text: 'continue' });
    assertEqual(replacement.sent('session/prepare').length, 1, 'replacement prepares its own core');
    assertEqual(replacement.sentSubmit('start-if-idle').length, 1, 'explicit retry admits exactly one turn');
  } finally { release(); await service.shutdown(); }
});

h.test('closing retries use bounded backoff and terminal RPC failures keep their explanation', async () => {
  const delays: number[] = [];
  let calls = 0;
  const closing = { kind: 'server', code: -32000, message: 'the session is closing' };
  const client = { requestWithTimeout: async () => { calls++; throw closing; } };
  assertEqual(await assertRejects(() => prepareSession(client, 'live', () => {}, async ms => { delays.push(ms); }), 'closing retries exhaust'), closing, 'original closing failure retained');
  assertDeepEqual(delays, recoveryVectors.startupRecovery.preparation.closingRetryDelaysMs, 'bounded exponential backoff');
  assertEqual(calls, delays.length + 1, 'four retries after the first attempt');
  assertEqual(sessionFailureMessage({ kind: 'server', code: -32010, message: 'Restoration could not read the rollout' }), 'Restoration could not read the rollout', 'bare RPC message is readable');
  assert(!sessionFailureMessage({ kind: 'timeout', method: 'session/prepare' }).includes('[object Object]'), 'timeout reason survives');
});

h.test('activation failures close once and preserve the original error for new and resumed chats', async () => {
  for (const method of recoveryVectors.startupRecovery.activationFailureMethods) for (const resumed of [false, true]) {
    const failure = { kind: 'server', code: -32010, message: `failed ${method}`, data: { secret: 'do-not-log' } };
    const logs: string[] = [];
    class FailActivation extends FakeClient {
      override async requestWithTimeout(name: string, params: Json): Promise<unknown> {
        if (name === method) { this.calls.push({ method: name, params }); throw failure; }
        return super.requestWithTimeout(name, params);
      }
    }
    const client = new FailActivation().reply('session/start', { sessionId: 'failed-live' }).reply('session/close', {});
    const { service, state } = serviceWith(client, byoRoot(), undefined, { log: (kind, detail) => logs.push(`${kind}: ${detail}`) });
    const error = await assertRejects(() => resumed ? service.resolveLiveSession('failed-chat') : service.newSession(), 'activation is refused');
    assertEqual(error, failure, 'cleanup cannot replace the original RPC error');
    assertEqual(client.sent('session/close').length, recoveryVectors.startupRecovery.closeAttempts, 'one rollback owner');
    assertEqual(state.liveCount(), 0, 'confirmed cleanup releases ownership');
    assertEqual(client.sent('session/goal').length, 0, 'failed activation never schedules goal hydration');
    assert(logs.some(line => line.includes('-32010')), 'the original code is recorded');
    assert(!logs.some(line => line.includes('do-not-log')), 'RPC data never enters diagnostics');
    await service.shutdown();
  }
});

h.test('failed startup cleanup retains the writer, blocks sends, and recovers before resuming', async () => {
  let now = 0, fail = true;
  const primary = { kind: 'timeout', method: 'session/subscribe' };
  const cleanup = { kind: 'timeout', method: 'session/close' };
  class FailCleanup extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (fail && (method === 'session/subscribe' || method === 'session/close')) {
        this.calls.push({ method, params }); throw method === 'session/close' ? cleanup : primary;
      }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new FailCleanup().reply('session/start', { sessionId: 'live' }).reply('session/close', {});
  const { service, state } = serviceWith(client, byoRoot(), undefined, { retirementClock: () => now });
  const error = await assertRejects(() => service.resolveLiveSession('chat'), 'cleanup fails') as AggregateError;
  assert(error instanceof AggregateError, 'both failures survive');
  assertDeepEqual(error.errors, [primary, cleanup], 'primary and cleanup stay distinct');
  assertEqual(state.liveSession('chat'), 'live', 'writer retained');
  assertEqual(service.isSessionClosing('chat'), true, 'host tool admission remains closed');
  const rejection = await assertRejects(() => service.send('chat', { text: 'do not send' }), 'pending cleanup blocks inference') as { code?: string };
  assertEqual(rejection.code, 'SESSION_CLEANUP_PENDING', 'actionable cleanup refusal');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no turn can use a half-activated session');
  assertEqual(client.sent('session/close').length, 1, 'immediate retry does not close again');
  now += recoveryVectors.startupRecovery.retryBaseMs; fail = false;
  assertEqual(await service.resolveLiveSession('chat'), 'live', 'retry closes the old writer and resumes');
  assertEqual(client.sent('session/close').length, 2, 'one cleanup retry');
  assertEqual(client.sent('session/start').length, 2, 'one replacement after confirmed cleanup');
  assertEqual(service.isSessionClosing('chat'), false, 'recovery releases admission');
  await service.shutdown();
});

h.test('in-flight sends cannot use a replacement binding whose activation cleanup failed', async () => {
  let release!: () => void, preparing = false, fail = false;
  const input = new Promise<void>(resolve => { release = resolve; });
  class FailedReplacement extends FakeClient {
    closes = 0;
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/close') {
        this.closes++;
        if (this.closes > 1) throw { kind: 'timeout', method };
      }
      if (fail && method === 'session/subscribe') throw { kind: 'timeout', method };
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new FailedReplacement().reply('session/start', { sessionId: 'live' }).reply('session/close', {});
  const { service, state } = serviceWith(client, byoRoot(), undefined, { messageInput: async () => { preparing = true; await input; return 'message'; } });
  await service.resolveLiveSession('chat');
  const sent = service.send('chat', { text: 'message' });
  const rejected = assertRejects(() => sent, 'old sender must respect replacement cleanup');
  await waitFor(() => preparing, 1000, 'input preparation paused');
  state.markStale('chat'); fail = true;
  await assertRejects(() => service.resolveLiveSession('chat'), 'replacement activation failed');
  release();
  const error = await rejected as { code?: string };
  assertEqual(error.code, 'SESSION_CLEANUP_PENDING', 'late sender checks the independent cleanup fence');
  assertEqual(client.sent('session/reconfigureInference').length, 0, 'no model change can erase the fence');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'half-activated writer is never used');
  await service.shutdown();
});

h.test('prepared sends remain fenced after a stale writer close times out', async () => {
  let release!: () => void, preparing = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class FailedStaleClose extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/close') { this.calls.push({ method, params }); throw { kind: 'timeout', method }; }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new FailedStaleClose().reply('session/start', { sessionId: 'live' });
  const { service, state } = serviceWith(client, byoRoot(), undefined, {
    messageInput: async () => { preparing = true; await gate; return 'message'; },
  });
  await service.resolveLiveSession('chat');
  const sent = service.send('chat', { text: 'message' });
  const rejected = assertRejects(() => sent, 'a prepared sender respects pending close');
  try {
    await waitFor(() => preparing, 1000, 'input preparation paused');
    state.markStale('chat');
    await assertRejects(() => service.resolveLiveSession('chat'), 'stale close timed out');
    assertEqual(service.isSessionClosing('chat'), true, 'unconfirmed stale teardown keeps admission fenced');
    release();
    const error = await rejected as { code?: string };
    assertEqual(error.code, recoveryVectors.closeRecovery.pendingCode, 'sender sees the same lifecycle refusal');
    assertEqual(client.sent('session/reconfigureInference').length, 0, 'no model update clears pending teardown');
    assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no turn reaches the draining writer');
  } finally { release(); await rejected; await service.shutdown(); }
});

h.test('foreground cleanup retries and background retirement share one cooldown', async () => {
  let now = 0;
  class FailedCleanup extends FakeClient {
    closes = 0;
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/subscribe') throw { kind: 'timeout', method };
      if (method === 'session/close') { this.closes++; throw { kind: 'timeout', method }; }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new FailedCleanup().reply('session/start', { sessionId: 'broken-live' });
  const { service, state } = serviceWith(client, byoRoot(), undefined, { retirementClock: () => now });
  await assertRejects(() => service.resolveLiveSession('broken'), 'initial cleanup failure');
  state.rememberSession('current', 'current-live', {});
  now = 30000;
  await assertRejects(() => service.resolveLiveSession('broken'), 'foreground cleanup fails');
  assertEqual(client.closes, 2, 'foreground makes one retry');
  await service.resolveLiveSession('current'); await new Promise(resolve => setTimeout(resolve, 10));
  assertEqual(client.closes, 2, 'background cannot bypass the updated foreground cooldown');
  now = 90000;
  await service.resolveLiveSession('current');
  await waitFor(() => client.closes === 3, 1000, 'background retries at the shared deadline');
  await new Promise(resolve => setTimeout(resolve, 10));
  const error = await assertRejects(() => service.resolveLiveSession('broken'), 'foreground respects background backoff') as { code?: string };
  assertEqual(error.code, 'SESSION_CLEANUP_PENDING', 'background failure updates the same deadline');
  assertEqual(client.closes, 3, 'no immediate fourth attempt');
  await service.shutdown();
});

h.test('late cleanup from a disconnected client cannot erase a replacement binding', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class OldClient extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/subscribe') throw { kind: 'timeout', method };
      if (method === 'session/close') { this.calls.push({ method, params }); await gate; return {}; }
      return super.requestWithTimeout(method, params);
    }
  }
  const old = new OldClient().reply('session/start', { sessionId: 'live' });
  const next = new FakeClient(); let current: FakeClient = old;
  const { service, state } = serviceWith(old, byoRoot(), undefined, { manager: {
    attach: async () => ({ client: current, generation: current === old ? 1 : 2 }), shutdownAll: async () => {},
  } });
  const rejected = assertRejects(() => service.resolveLiveSession('chat'), 'old startup fails');
  await waitFor(() => old.sent('session/close').length === 1, 1000, 'cleanup in flight');
  old.closed = true; old.emit('event', { type: 'streamClosed' }); current = next;
  await service.client(); state.rememberSession('chat', 'live', {});
  release(); await rejected;
  assertEqual(state.liveSession('chat'), 'live', 'same ID on a new connection survives');
  assertEqual(service.isSessionClosing('chat'), false, 'no stale cleanup fence remains');
  await service.shutdown();
});

h.test('retirement recognizes unknown handles during probes but preserves unrelated ownership', async () => {
  class MissingHandle extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (object(params)?.sessionId === 'engine-a-missing' && ['session/subagentLifecycle', 'session/close'].includes(method)) {
        this.calls.push({ method, params }); throw { kind: 'server', code: recoveryVectors.startupRecovery.unknownSessionCode, message: 'unknown session' };
      }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new MissingHandle(); const { service, state } = serviceWith(client, freshRoot()); await service.client();
  for (const id of ['a-missing', 'b', 'c', 'd', 'e', 'f', 'z']) state.rememberSession(id, `engine-${id}`, {});
  await service.resolveLiveSession('z');
  await waitFor(() => state.liveSession('a-missing') === undefined, 1000, 'missing handle is released');
  assertEqual(state.liveCount(), 6, 'only missing handle removed');
  assertEqual(client.sent('session/close').length, 1, 'probe failure reaches close reconciliation');
  assertEqual(client.sent('session/deleteSession').length, 0, 'history is not deleted');
  await service.shutdown();
});

h.test('unknown live handles do not block stale rebuilds or deletion of a working binding', async () => {
  class UnknownClose extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (['turn/interrupt', 'session/close'].includes(method)) {
        this.calls.push({ method, params }); throw { kind: 'server', code: recoveryVectors.startupRecovery.unknownSessionCode, message: 'unknown session' };
      }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new UnknownClose().reply('session/start', { sessionId: 'replacement' })
    .replyAcknowledged('session/deleteSession', { deleted: { threadId: 'working', deleted: true } });
  const { service, state } = serviceWith(client, byoRoot()); await service.client();
  state.rememberSession('stale', 'gone', {}); state.markStale('stale');
  assertEqual(await service.resolveLiveSession('stale'), 'replacement', 'explicit missing handle allows a rebuild');
  state.rememberSession('working', 'gone-working', {}); state.markTurnRunning('working', 'old-turn');
  await service.deleteSession('working');
  assertEqual(state.liveSession('working'), undefined, 'missing interrupt target does not strand deletion');
  assertEqual(state.liveSession('stale'), 'replacement', 'unrelated replacement survives');
  await service.shutdown();
});

h.test('retirement backs off repeated probe failures and retries at the capped interval', async () => {
  let now = 0, fail = true;
  const logs: Array<{ attempts: number; retryMs: number }> = [];
  class FailingProbe extends FakeClient {
    readonly priorities: Array<string | undefined> = [];
    override async requestWithTimeout(method: string, params: Json, _timeout?: number, options?: RpcRequestOptions): Promise<unknown> {
      if (method === 'session/subagentLifecycle') {
        this.priorities.push(options?.priority);
        if (fail) { this.calls.push({ method, params }); throw { kind: 'timeout', method }; }
      }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new FailingProbe().reply('session/close', {});
  const { service, state } = serviceWith(client, freshRoot(), undefined, { retirementClock: () => now,
    log: (kind, detail) => { if (kind === 'idle-session-retirement-candidate-failed') logs.push(JSON.parse(detail)); } });
  await service.client();
  for (const id of ['a-failed', 'b', 'c', 'd', 'e', 'f', 'z']) state.rememberSession(id, `engine-${id}`, {});
  for (const id of ['b', 'c', 'd', 'e', 'f']) state.markTurnRunning(id, `turn-${id}`);
  for (const [index, delay] of recoveryVectors.startupRecovery.retryDelaysMs.entries()) {
    await service.resolveLiveSession('z');
    await waitFor(() => logs.length === index + 1, 1000, 'one failed candidate recorded');
    assertEqual(logs[index]?.retryMs, delay, 'backoff follows the contract');
    now += delay - 1;
    await service.resolveLiveSession('z');
    await new Promise(resolve => setTimeout(resolve, 5));
    assertEqual(logs.length, index + 1, 'refresh cannot bypass cooldown: ' + JSON.stringify(logs));
    now += 1;
  }
  assert(client.priorities.every(priority => priority === recoveryVectors.startupRecovery.probePriority), 'probes use background capacity');
  assertEqual(client.sent('session/close').length, 0, 'timeouts never authorize closing an unknown workload');
  fail = false; await service.resolveLiveSession('z');
  await waitFor(() => !state.liveSession('a-failed'), 1000, 'a recovered candidate can retire');
  assertEqual(state.liveCount(), 6, 'healthy running chats survive');
  await service.shutdown();
});

h.test('retirement rechecks queues after asynchronous probes', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  class PausedProbe extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'session/backgroundProcesses') { this.calls.push({ method, params }); await barrier; return { backgroundProcesses: { processes: [] } }; }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new PausedProbe(); const { service, state } = serviceWith(client, freshRoot()); await service.client();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'z']) state.rememberSession(id, `engine-${id}`, {});
  for (const id of ['b', 'c', 'd', 'e', 'f']) state.markTurnRunning(id, `turn-${id}`);
  await service.resolveLiveSession('z');
  await waitFor(() => client.sent('session/backgroundProcesses').length === 1, 1000, 'probe is pending');
  state.markTurnRunning('a', 'new-turn'); release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assertEqual(client.sent('session/close').length, 0, 'a newly started turn survives a stale idle observation');
  assertEqual(state.liveSession('a'), 'engine-a', 'binding is retained');
  await service.shutdown();
});

h.test('shutdown reaches the engine manager even when a parked answer never finishes writing', async () => {
  const state = new HostState();
  let stopped = false;
  state.parkReverse({
    requestId: 'blocked', sessionId: 'thread', isApproval: true, card: {}, toolName: 'shell',
    request: { id: 1, method: 'approval/request', params: {}, outstanding: true,
      respond: async () => new Promise<void>(() => {}), respondError: async () => {} },
  });
  const service = new SessionService({
    manager: { attach: async () => ({ client: new FakeClient(), generation: 1 }), shutdownAll: async () => { stopped = true; } },
    state, configRoot: freshRoot(), spawnOptions: () => ({ command: '/unused', args: [], env: [] }), pushChatEvents: () => {},
  });
  const before = Date.now();
  const shutdown = service.shutdown();
  assertEqual(service.shutdown(), shutdown, 'quit callers share the same shutdown');
  await shutdown;
  assert(stopped, 'engine cleanup ran despite the blocked responder');
  assert(Date.now() - before < 2500, 'shutdown was bounded');
});

h.test('engine provider refusals retain their error for a turn and a running follow-up', async () => {
  const refusal = { kind: 'server', code: -32000, message: 'Provider access was revoked' };
  class RefuseInference extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'turn/submit') {
        this.calls.push({ method, params });
        throw refusal;
      }
      return super.requestWithTimeout(method, params);
    }
  }
  const client = new RefuseInference(), root = byoRoot();
  const { service, state, pushed } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'engine-thread', {}, { source: 'custom', selection: 'custom:fixture' });
  const failure = await assertRejects(() => service.send('thread', { text: 'test' }), 'refused turn');
  assertEqual(failure, refusal, 'the engine refusal reaches the caller unchanged');
  assertEqual(state.isWorking('thread'), false, 'a refused turn does not remain running');
  state.markTurnRunning('thread', 'turn');
  const followUp = await service.followUp('thread', { text: 'test' });
  assertDeepEqual(followUp, { ok: false, error: refusal.message }, 'the follow-up reports the engine refusal');
  assertEqual(state.isWorking('thread'), true, 'a refused follow-up does not stop the existing turn');
  assertEqual(pushed.filter(event => (event as Record<string, Json>).type === 'follow_up_status').length, 0, 'an unaccepted follow-up is never marked queued or applied');
  assertEqual(client.sentSubmit('start-if-idle').length, 1, 'only one turn request was attempted');
  assertEqual(client.sentSubmit('steer').length, 1, 'only one follow-up request was attempted');
  await service.shutdown();
});

h.test('a BYO selection is resolved once by the engine and reaches session start without host provider credentials', async () => {
  const root = byoRoot(), client = new FakeClient().reply('session/start', { sessionId: 'custom-engine' });
  setSessionModel('custom-thread', 'custom:installed', 'custom', root);
  const { service, state } = serviceWith(client, root);
  try {
    await service.resolveLiveSession('custom-thread');
    assertDeepEqual(client.sent('model/selection/resolve'), [{ source: 'custom', selection: 'custom:installed' }], 'one named engine resolution');
    assertEqual(client.sentSubmit('start-if-idle').length, 0, 'opening the session does not start inference');
    const init = rowAt(client.sent('session/start'), 0, 'session init').init as Record<string, Json>;
    assertEqual(init.modelSelection, 'custom:installed', 'the engine-resolved selector reaches session start');
    assertDeepEqual(init.modelSource, { source: 'custom', modelId: 'installed', selection: 'custom:installed' }, 'the model source retains its identity');
    for (const field of ['provider', 'auth', 'capabilities']) assertEqual(init[field], undefined, `the host does not inject ${field}`);
    const config = object(init.config);
    assert(config, 'the session has a configuration');
    assertEqual(config.contextWindow, undefined, 'the engine owns the model context window');
    assertEqual(state.sessionProvider('custom-thread')?.token, undefined, 'no host provider token is retained');
    assertEqual(state.sessionProvider('custom-thread')?.source, 'custom', 'binding retains its actual provider source');
  } finally { await service.shutdown(); }
});

h.test('directory removal waits for an admitted session start and rejects new starts until release', async () => {
  const root = byoRoot(), project = join(root, 'project'); mkdirSync(project);
  let releaseStart!: () => void; const ready = new Promise<void>(resolve => { releaseStart = resolve; });
  class SlowStart extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      const result = await super.requestWithTimeout(method, params);
      if (method === 'session/start' && this.sent(method).length === 1) await ready;
      return result;
    }
  }
  const client = new SlowStart().replySequence('session/start', [{ sessionId: 'old' }, { sessionId: 'resumed' }]).reply('session/close', {});
  bindSessionWorkdir('thread', project, root);
  const { service, state } = serviceWith(client, root);
  const start = service.resolveLiveSession('thread');
  await waitFor(() => client.sent('session/start').length === 1, 1000, 'start entered');
  let drained = false; const pendingLease = service.quiesceDirectory(project).then(release => { drained = true; return release; });
  await assertRejects(() => service.newSession({ workdir: project }), 'new session cannot enter deleting directory');
  assert(!drained, 'cleanup waits for admitted start'); releaseStart(); await start;
  const release = await pendingLease; assertEqual(state.liveSession('thread'), undefined, 'started session closed before deletion');
  assertEqual(client.sent('session/close').length, 1, 'actual engine writer closed');
  await assertRejects(() => service.send('thread', { text: 'late turn' }), 'late turn cannot reopen directory');
  release(); assertEqual(await service.resolveLiveSession('thread'), 'resumed', 'failed removal can resume after release');
});
h.test('delete serializes with activation and queued readers cannot resurrect a deleted thread', async () => {
  let releaseStart!: () => void; const ready = new Promise<void>(resolve => { releaseStart = resolve; });
  class SlowStart extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      const result = await super.requestWithTimeout(method, params); if (method === 'session/start') await ready; return result;
    }
  }
  const client = new SlowStart().reply('session/start', { sessionId: 'live' }).reply('session/close', {}).replyAcknowledged('session/deleteSession', { deleted: { threadId: 'thread', deleted: true } });
  const { service, state } = serviceWith(client, byoRoot());
  const started = service.resolveLiveSession('thread'); await waitFor(() => client.sent('session/start').length === 1, 1000, 'activation started');
  const deleted = service.deleteSession('thread'); const reopened = assertRejects(() => service.resolveLiveSession('thread'), 'reader queued after delete');
  releaseStart(); await started; await deleted; await reopened;
  assertEqual(state.liveSession('thread'), undefined, 'no live writer retained');
  assertEqual(client.sent('session/start').length, 1, 'deleted identity never starts a second writer');
});
h.test('historical metadata edits avoid provider activation and preserve unrelated host metadata', async () => {
  const client = new FakeClient().reply('engine/readSessionSummary', { session: { id: 'history', hostMetadata: { custom: 'keep' } } })
    .replyAcknowledged('session/updateThreadHostMetadata', { hostMetadataUpdated: true }).replyAcknowledged('session/updateTitle', { title: { title: 'Renamed' } });
  const { service } = serviceWith(client, byoRoot());
  await service.backfillAutomationSessionMetadata('history', { taskId: 'task', taskName: 'Task', runId: 7, triggerType: 'manual' });
  await service.setPinned('history', true); await service.rename('history', 'Renamed');
  const backfilled = rowAt(client.sent('session/updateThreadHostMetadata'), 0, 'backfill').hostMetadata as Record<string, Json>;
  const pinned = rowAt(client.sent('session/updateThreadHostMetadata'), 1, 'pin').hostMetadata as Record<string, Json>;
  assertEqual(backfilled.threadSource, 'automation', 'automation source written');
  assertDeepEqual(backfilled.automation, { taskId: 'task', taskName: 'Task', runId: 7, triggerType: 'manual' }, 'task metadata written');
  assertEqual(backfilled.custom, 'keep', 'unrelated metadata retained');
  assert(typeof pinned.sidebarPinnedAt === 'number', 'pin timestamp persisted');
  assertEqual(client.sent('session/start').length, 0, 'metadata does not start a session'); assertEqual(client.sent('model/selection/resolve').length, 0, 'metadata does not resolve a model');
});
h.test('a failed engine close releases the directory lease and keeps the writer binding for retry', async () => {
  let refuse = true, now = 0;
  class RefuseClose extends FakeClient { override async requestWithTimeout(method: string, params: Json): Promise<unknown> { if (method === 'session/close' && refuse) throw new Error('close failed'); return super.requestWithTimeout(method, params); } }
  const root = byoRoot(), project = join(root, 'project'); mkdirSync(project); bindSessionWorkdir('thread', project, root);
  const client = new RefuseClose().reply('session/start', { sessionId: 'live' }).reply('session/close', {});
  const { service, state } = serviceWith(client, root, undefined, { retirementClock: () => now });
  await service.resolveLiveSession('thread'); await assertRejects(() => service.quiesceDirectory(project), 'engine refused close');
  assertEqual(state.liveSession('thread'), 'live', 'ownership was not forgotten');
  assertEqual(service.isSessionClosing('thread'), true, 'retained ownership is fenced');
  await assertRejects(() => service.resolveLiveSession('thread'), 'read reaches cleanup retry without a leaked directory lease');
  refuse = false; now += recoveryVectors.startupRecovery.retryBaseMs;
  assertEqual(await service.resolveLiveSession('thread'), 'live', 'confirmed cleanup releases the lease and resumes');
  assertEqual(service.isSessionClosing('thread'), false, 'cleanup receipt releases admission');
  await service.shutdown();
});
h.test('archiving closes an active writer before preserving its title without inventing a user rename', async () => {
  const root = byoRoot(), client = new FakeClient().reply('turn/interrupt', {}).reply('session/close', {})
    .reply('session/archiveSession', { archived: { archived: true, threadId: 'thread' } })
    .reply('session/updateTitle', { title: { threadId: 'thread', title: 'Visible first message' } });
  const { service, state } = serviceWith(client, root);
  await service.client(); state.rememberSession('thread', 'live', {}); state.markTurnRunning('thread', 'active-turn');
  const result = await service.setArchived('thread', true, 'Visible first message');
  assertEqual((result as Record<string, Json>).ok, true, 'archive is confirmed');
  const methods = client.calls.map(call => call.method);
  assert(methods.indexOf('session/close') < methods.indexOf('session/archiveSession'), 'writer closes before archive');
  assert(methods.indexOf('session/archiveSession') < methods.indexOf('session/updateTitle'), 'title preservation cannot deadlock an active turn');
  assertEqual(state.liveSession('thread'), undefined, 'archived writer is released');
  assertEqual(readSessionTitle('thread', root), undefined, 'archiving does not label a seed as a user rename');
  await service.shutdown();
});

h.test('a title preservation failure cannot turn a confirmed archive into a failed archive', async () => {
  const client = new FakeClient().reply('session/archiveSession', { archived: { archived: true, threadId: 'thread' } });
  const { service } = serviceWith(client, byoRoot());
  const result = await service.setArchived('thread', true, 'Saved label');
  assertEqual((result as Record<string, Json>).ok, true, 'archive succeeds despite unavailable title write');
  assertEqual(client.sent('session/updateTitle').length, 1, 'display title is attempted after archive');
  await service.shutdown();
});

h.test('unarchive requires a matching durable outcome and preserves refusal details', async () => {
  const client = new FakeClient().replyAcknowledged('session/unarchiveSession', { unarchived: { threadId: 'thread', status: 'restored' } });
  const { service } = serviceWith(client, byoRoot());
  assertDeepEqual(await service.setArchived('thread', false), { ok: true, sessionId: 'thread', threadId: 'thread', status: 'restored' }, 'restored outcome');
  client.replyAcknowledged('session/unarchiveSession', { unarchived: { threadId: 'thread', status: 'already-active' } });
  assertEqual((await service.setArchived('thread', false) as {status:string}).status, 'already-active', 'idempotent active outcome');
  client.replyAcknowledged('session/unarchiveSession', { unarchived: { threadId: 'other', status: 'restored' } });
  assertEqual((await service.setArchived('thread', false) as {ok:boolean}).ok, false, 'wrong identity refused');
  client.replyAcknowledged('session/unarchiveSession', { unarchived: { threadId: 'thread', status: 'persistence-failed', error: 'disk full' } });
  assertEqual((await service.setArchived('thread', false) as {error:string}).error, 'disk full', 'persistence failure visible');
});
h.test('file extensions reach session init and slash commands expand before a turn', async () => {
  const root = byoRoot(); mkdirSync(join(root, 'agents')); mkdirSync(join(root, 'commands'));
  writeFileSync(join(root, 'agents', 'fixture.md'), '---\nname: fixture-agent\ndescription: Fixture reader\n---\nRead carefully.\n');
  writeFileSync(join(root, 'commands', 'fixture.md'), '---\ndescription: Fixture command\n---\nInspect $0 and $ARGUMENTS');
  const state = new HostState(), client = new FakeClient().reply('session/start', { sessionId: 'live' }).replySubmit('start-if-idle', 'turn');
  const service = new SessionService({ state, configRoot: root, extensions: new ExtensionDiscovery({ configRoot: root }),
    manager: { attach: async () => ({ client, generation: 1 }), shutdownAll: async () => {} },
    spawnOptions: () => ({ command: '/unused', args: [], env: [] }), pushChatEvents: () => {},
  });
  await service.send('thread', { text: '/fixture selected-file' });
  const init = rowAt(client.sent('session/start'), 0, 'init').init as Record<string, Json>;
  assert((init.agents as Array<{name:string}>).some(agent => agent.name === 'fixture-agent'), 'custom agent included');
  assertEqual(rowAt(client.sentSubmit('start-if-idle'), 0, 'turn').input, 'Inspect selected-file and selected-file', 'file command expanded');
});

h.test('rewind planning uses committed user anchors and restores displayed command text', async () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../tests/vectors/session-rewind.json'), 'utf8')) as Array<{ name: string; messages: Json[]; uuid: string; expected: Json }>;
  for (const vector of vectors) assertDeepEqual(planRewind(vector.messages, vector.uuid), vector.expected, vector.name);
});
h.test('rewind waits for the terminal outcome and exposes partial failure', async () => {
  const root = byoRoot(), client = new FakeClient().reply('session/history', { history: [{ type: 'user', uuid: 'u1', content: [{type:'text',text:'restore me'}] }] })
    .reply('session/rewindPreview', { rewindPreview: {canRewind:true, files:['changed.txt'], droppedTurns:1} });
  const {service,state} = serviceWith(client, root); await service.client(); state.rememberSession('thread', 'actual-engine', {});
  let outcome!: () => void;
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method !== 'session/rewind') return original(method, params);
    assertDeepEqual(params, {sessionId:'actual-engine',numTurns:1,scope:'both'}, 'named scoped facade');
    outcome = () => client.emit('event', {type:'rawSessionEvent',params:{event:{submissionId:'rewind-op',rewound:{scope:'both',droppedTurns:1,remainingTurns:0,filesRestored:false,error:'disk restore failed'}}}});
    return {submissionId:'rewind-op'};
  };
  let finished = false;
  const request = service.rewind('thread','u1','both').then(value => { finished=true; return value; });
  await waitFor(() => Boolean(outcome),1000,'rewind was submitted');
  assertEqual(finished,false,'ACK does not claim completion'); outcome();
  const reply = await request as {ok:boolean;conversationChanged:boolean;reason:string;text:string};
  assert(!reply.ok && reply.conversationChanged,'partial mutation is explicit');
  assertEqual(reply.reason,'disk restore failed','actual terminal refusal retained'); assertEqual(reply.text,'restore me','removed input can be recovered');
});
h.test('missing checkpoints refuse before either history or files are changed', async () => {
  const root=byoRoot(), client=new FakeClient().reply('session/history',{history:[{type:'user',uuid:'u',content:[]}]})
    .reply('session/rewindPreview',{rewindPreview:{canRewind:false,files:[],droppedTurns:1,error:'checkpointing off'}});
  const {service,state}=serviceWith(client,root); await service.client(); state.rememberSession('thread','live',{});
  assertEqual((await service.rewind('thread','u','both') as {reason:string}).reason,'checkpointing off','preflight refusal');
  assertEqual(client.sent('session/rewind').length,0,'no destructive submission');
  state.markTurnRunning('thread','running'); await assertRejects(()=>service.rewind('thread','u','conversation'),'running turn is protected');
});
h.test('conversation-only rewind works without a file checkpoint and refills the input', async () => {
  const root = byoRoot(), client = new FakeClient()
    .reply('session/history', {history:[{type:'user',uuid:'u',content:[{type:'text',text:'retry this'}]}]})
    .replyAcknowledged('session/rewind', {rewound:{scope:'conversation',droppedTurns:1,remainingTurns:0,filesRestored:false}});
  settleRewindOnReply(client);
  const {service,state} = serviceWith(client,root); await service.client(); state.rememberSession('thread','live',{});
  const result = await service.rewind('thread','u','conversation') as {ok:boolean;text:string;outcome:{filesRestored:boolean}};
  assertEqual(result.ok,true,'conversation truncation succeeds');
  assertEqual(result.text,'retry this','removed input is returned to the composer');
  assertEqual(result.outcome.filesRestored,false,'files stay untouched');
  assertEqual(client.sent('session/rewindPreview').length,0,'a missing file checkpoint is not required');
  assertEqual((client.sent('session/rewind')[0] as {scope:string}).scope,'conversation','engine receives conversation-only scope');
});
h.test('rewind materializes a complete mixed draft before truncating its source history', async () => {
  const root = byoRoot(), upload = join(root, 'uploads', 'notes.txt');
  mkdirSync(join(root, 'uploads'), {recursive:true}); writeFileSync(upload, 'unchanged file bytes');
  const imageBytes = Buffer.from('image-fixture'), documentBytes = Buffer.from('%PDF-1.4\nfixture');
  const localRender = {displayText:'Please review.',selectedTextAttachments:[{text:'Quoted source'}],pastedCards:[{text:'Pasted lines\nSecond line'}]};
  const history: Json[] = [
    {type:'user',uuid:'u',content:[{type:'text',text:`Please review.\n\nAttached:\n- ${upload}`},
      {type:'image',base64:imageBytes.toString('base64'),mimeType:'image/png'},
      {type:'document',base64:documentBytes.toString('base64'),mimeType:'application/pdf'}]},
    {type:'system',subtype:'user_display',text:JSON.stringify({messageUuid:'u',localRender})},
  ];
  const client = new FakeClient().reply('session/history', {history})
    .replyAcknowledged('session/rewind', {rewound:{scope:'conversation',droppedTurns:1,remainingTurns:0,filesRestored:false}});
  settleRewindOnReply(client);
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method === 'session/rewind') {
      assertEqual(readdirSync(join(root,'media')).length,2,'both native media blocks are materialized before truncation');
      history.length = 0;
    }
    return original(method,params);
  };
  const {service,state} = serviceWith(client,root); await service.client(); state.rememberSession('thread','live',{});
  const result = object(await service.rewind('thread','u','conversation'))!;
  assertEqual(result.ok,true,'conversation rewind succeeds');
  assertEqual(result.text,'Please review.','composer text excludes injected attachment paths and card bodies');
  assertDeepEqual(result.displayMetadata,localRender,'quote and paste metadata survive');
  const attachments = result.attachments as Array<{path:string;mimeType?:string}>;
  assertEqual(attachments.length,3,'image, document and file are all returned');
  assertDeepEqual(readFileSync(attachments.find(row=>row.mimeType==='image/png')!.path),imageBytes,'image bytes remain readable');
  assertDeepEqual(readFileSync(attachments.find(row=>row.mimeType==='application/pdf')!.path),documentBytes,'document bytes remain readable');
  assert(attachments.some(row=>row.path===upload),'uploaded text file path survives');
  assertEqual(readFileSync(upload,'utf8'),'unchanged file bytes','conversation rewind does not restore or modify files');
  assertEqual(history.length,0,'the source history was removed before the response');
});
h.test('rewind returns bodyless image, file and text-card drafts', async () => {
  for (const kind of ['image','file','paste','selection']) {
    const root = byoRoot(), upload = join(root,'uploads','bodyless.txt');
    mkdirSync(join(root,'uploads'),{recursive:true}); writeFileSync(upload,'bodyless attachment');
    const localRender = kind === 'paste' ? {displayText:'',pastedCards:[{text:'Pasted-only text'}]}
      : kind === 'selection' ? {displayText:'',selectedTextAttachments:[{text:'Selected-only text'}]} : null;
    const content: Json[] = kind === 'image' ? [{type:'image',base64:'AAAA',mimeType:'image/png'}]
      : [{type:'text',text:kind==='file' ? `Attached:\n- ${upload}` : 'Injected card text'}];
    const history: Json[] = [{type:'user',uuid:'u',content},...(localRender ? [{type:'system',subtype:'user_display',text:JSON.stringify({messageUuid:'u',localRender})}] : [])];
    const client = new FakeClient().reply('session/history',{history})
      .replyAcknowledged('session/rewind',{rewound:{scope:'conversation',droppedTurns:1,remainingTurns:0,filesRestored:false}});
    settleRewindOnReply(client);
    const {service,state} = serviceWith(client,root); await service.client(); state.rememberSession('thread','live',{});
    const result = object(await service.rewind('thread','u','conversation'))!;
    assertEqual(result.ok,true,`${kind}: conversation rewind succeeds`);
    assertEqual(result.text,'',`${kind}: an empty body is not replaced by model-visible wrapper text`);
    assertEqual((result.attachments as Json[]).length,kind==='image'||kind==='file' ? 1 : 0,`${kind}: attachments survive independently of text`);
    if (localRender) assertDeepEqual(result.displayMetadata,localRender,`${kind}: display cards survive`);
  }
});
h.test('file-only rewind does not materialize a composer draft', async () => {
  const root = byoRoot(), client = new FakeClient()
    .reply('session/history',{history:[{type:'user',uuid:'u',content:[{type:'image',base64:'AAAA',mimeType:'image/png'}]}]})
    .reply('session/rewindPreview',{rewindPreview:{canRewind:true,files:['changed.txt'],droppedTurns:1}})
    .replyAcknowledged('session/rewind',{rewound:{scope:'files',droppedTurns:0,remainingTurns:1,filesRestored:true}});
  settleRewindOnReply(client,{scope:'files',droppedTurns:0,remainingTurns:1,filesRestored:true});
  const {service,state} = serviceWith(client,root); await service.client(); state.rememberSession('thread','live',{});
  const result = object(await service.rewind('thread','u','files'))!;
  assertEqual(result.ok,true,'file-only rewind succeeds without modifying conversation context');
  assertEqual(result.text,null,'file undo never refills the composer');
  assert(!('attachments' in result),'file undo does not return composer attachments');
  assert(!existsSync(join(root,'media')),'file undo does not copy unrelated media');
});
h.test('approval authorization forwards the original denied event through one named facade without starting a turn', async () => {
  const requests: Array<{ sessionId: string; method: string; params: Json }> = [];
  const registry = new ChannelRegistry();
  registerSessionHandlers(registry, {
    sessions: { requestSession: async (sessionId: string, method: string, params: Json = {}) => { requests.push({sessionId,method,params}); return {}; } } as unknown as SessionService,
    state: {} as HostState, events: {} as SessionEventPump, configRoot: byoRoot(), chooseExportPath: async () => undefined,
  });
  const event: Json = {id:'denied-action',targetItemId:'tool',turnId:'turn',status:'denied',startedAtMs:42,completedAtMs:51,
    pluginId:'package-tool',scriptPath:'scripts/check.sh',reviewReason:'authorization_changed',rationale:'Needs explicit authorization',
    action:{type:'command',source:'unified_exec',command:'printf approved',cwd:'/fixture/work'}};
  const handler = registry.lookup('approval-review:approve')!;
  let checked = 0;
  const result = await handler({channel:'approval-review:approve',role:'main',senderId:1,args:[{sessionId:'selected-chat',event}],assertCurrent:() => { checked++; }});
  assertDeepEqual(result,{},'the facade acknowledgment does not claim an execution result');
  assertEqual(checked,1,'the renderer binding is checked before admission');
  assertDeepEqual(requests,[{sessionId:'selected-chat',method:'session/approveApprovalReviewDenial',params:{event}}],'the entire original event travels unchanged without a prompt or new turn');
  await assertRejects(() => Promise.resolve(handler({channel:'approval-review:approve',role:'main',senderId:1,args:[{sessionId:'selected-chat',event}],assertCurrent:() => { throw Error('stale renderer'); }})),'stale renderer authorization is rejected');
  assertEqual(requests.length,1,'a stale renderer cannot inject an authorization');
  await assertRejects(() => Promise.resolve(handler({channel:'approval-review:approve',role:'main',senderId:1,args:[{sessionId:'selected-chat',event:[]}]})),'invalid event envelopes are rejected');
});
h.test('message rewind channel never selects file restoration, even for a supplied scope', async () => {
  const scopes: string[] = [];
  const registry = new ChannelRegistry();
  registerSessionHandlers(registry, {
    sessions: { rewind: async (_sessionId: string, _messageUuid: string, scope: string) => { scopes.push(scope); return {ok:true}; } } as unknown as SessionService,
    state: {} as HostState, events: {} as SessionEventPump, configRoot: byoRoot(), chooseExportPath: async () => undefined,
  });
  const handler = registry.lookup('chat:rewind-from');
  assert(handler, 'message rewind handler is registered');
  for (const scope of [undefined, 'both']) {
    const args: Json[] = [{sessionId:'thread',messageUuid:'u',...(scope ? {scope} : {})}];
    await handler({channel:'chat:rewind-from',role:'main',senderId:1,args});
  }
  assertDeepEqual(scopes,['conversation','conversation'],'the channel cannot restore files');
});

// ---------------------------------------------------------------------------
// Inline edit of the last user message (`chat:edit-message`).
//
// The operation is a truncate-then-restart, which is the part that can go wrong in
// a way no amount of reading catches: `rewind` and `startTurn` each take the
// per-session `mutate` lock, and `mutate` is a promise CHAIN, not a reentrant lock.
// Calling the public methods from inside `editMessage` would queue behind the call
// already holding the lock and hang forever. `editMessage` therefore composes the
// `*Locked` bodies inside ONE `mutate`. These tests pin that it terminates, that it
// sequences truncate BEFORE restart, that a running turn is refused before any
// history is touched, and that an image survives the edit.
// ---------------------------------------------------------------------------
h.test('editMessage truncates the conversation only, then re-runs the edited text', async () => {
  const root = byoRoot();
  const client = new FakeClient()
    .reply('session/history', { history: [
      { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'first' }] },
      { type: 'assistant', uuid: 'a1', content: [{ type: 'text', text: 'reply' }] },
      { type: 'user', uuid: 'u2', content: [{ type: 'text', text: 'look at this' }] },
    ] })
    // conversation-only rewind: filesRestored is reported but must stay false, since
    // an edit never touches the working tree (rewinding a conversation is never a
    // file restore).
    .replyAcknowledged('session/rewind', { rewound: { scope: 'conversation', droppedTurns: 1, remainingTurns: 2, filesRestored: false } })
    .replySubmit('start-if-idle', 'edited-turn');
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  // The rewind ACK is not the outcome; emit the terminal `rewound` event so the
  // awaited truncation settles and the restart can proceed.
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method !== 'session/rewind') return original(method, params);
    const result = await original(method, params);
    client.emit('event', { type: 'rawSessionEvent', params: { event: { submissionId: 'fixture-submission', rewound: { scope: 'conversation', droppedTurns: 1, remainingTurns: 2, filesRestored: false } } } });
    return result;
  };
  const reply = await service.editMessage('thread', 'u2', 'edited words') as { ok: boolean; reason?: string };
  assertEqual(reply.ok, true, `edit accepted (got ${JSON.stringify(reply)})`);
  // conversation scope only — the truncation must NOT ask the engine to restore files.
  const rewindParams = client.sent('session/rewind')[0] as { scope: string; numTurns: number };
  assertEqual(rewindParams.scope, 'conversation', 'files are left alone');
  assertEqual(rewindParams.numTurns, 1, 'only the edited message’s turn is dropped');
  // The restart carries the EDITED text, sent after the rewind completed. The shape
  // follows the original message: `send` writes a bare string for text-only input but
  // an array once there is a second part, and the engine echoes `input` verbatim into
  // the queue snapshot, so an edit must not convert one shape into the other. This
  // history row is array-shaped, so the array is preserved with only its text part
  // replaced — the rewrite maps over the original parts instead of rebuilding them.
  const turn = client.sentSubmit('start-if-idle')[0] as { input: Json };
  assertDeepEqual(turn.input, [{ type: 'text', text: 'edited words' }], 'the edited text is re-sent in the original shape');
  // Ordering: rewind was submitted before turn/start. Both recorded, rewind first.
  const methods = client.calls.map(call => call.method);
  assert(methods.indexOf('session/rewind') < methods.indexOf('turn/submit'), 'truncate precedes restart');
});

h.test('editMessage refuses a running turn before touching history', async () => {
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', { history: [{ type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'x' }] }] });
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  state.markTurnRunning('thread', 'busy-turn');
  const reply = await service.editMessage('thread', 'u1', 'nope') as { ok: boolean; reason: string };
  assertEqual(reply.ok, false, 'refused');
  assertEqual(reply.reason, 'turn-in-progress', 'worded refusal, not a thrown fault');
  assertEqual(client.sent('session/rewind').length, 0, 'no truncation while running');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no restart while running');
});

h.test('editMessage refuses a message that is not the newest user message', async () => {
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', { history: [
    { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'first' }] },
    { type: 'assistant', uuid: 'a1', content: [{ type: 'text', text: 'reply' }] },
    { type: 'user', uuid: 'u2', content: [{ type: 'text', text: 'second' }] },
  ] });
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  // u1 is followed by another user turn, so editing it would discard u2.
  const reply = await service.editMessage('thread', 'u1', 'nope') as { ok: boolean; reason: string };
  assertEqual(reply.ok, false, 'refused');
  assertEqual(reply.reason, 'not-the-last-message', 'named refusal');
  assertEqual(client.sent('session/rewind').length, 0, 'history untouched');
});

h.test('editing a message that carried an image re-sends the image with the new text', async () => {
  // Only the first text part is swapped and the image block is passed through, so an
  // edit of a message with an attachment does not silently drop the attachment.
  const root = byoRoot();
  const image = { type: 'image', base64: 'AAAA', mimeType: 'image/png' };
  const client = new FakeClient()
    .reply('session/history', { history: [{ type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'see this' }, image] }] })
    .replyAcknowledged('session/rewind', { rewound: { scope: 'conversation', droppedTurns: 1, remainingTurns: 0, filesRestored: false } })
    .replySubmit('start-if-idle', 't');
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method !== 'session/rewind') return original(method, params);
    const result = await original(method, params);
    client.emit('event', { type: 'rawSessionEvent', params: { event: { submissionId: 'fixture-submission', rewound: { scope: 'conversation', droppedTurns: 1, remainingTurns: 0, filesRestored: false } } } });
    return result;
  };
  await service.editMessage('thread', 'u1', 'edited caption');
  const turn = client.sentSubmit('start-if-idle')[0] as { input: Json };
  assert(Array.isArray(turn.input), 'multi-part input stays an array');
  const parts = turn.input as Array<Record<string, Json>>;
  assertEqual(parts[0]?.text, 'edited caption', 'text part replaced');
  assertDeepEqual(parts[1], image, 'image block passed through untouched');
});

h.test('a missing uuid is refused without contacting the engine', async () => {
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', { history: [{ type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'x' }] }] });
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = await service.editMessage('thread', 'absent', 'nope') as { ok: boolean; reason: string };
  assertEqual(reply.ok, false, 'refused');
  assertEqual(reply.reason, 'uuid-not-found', 'named refusal');
  assertEqual(client.sent('session/rewind').length, 0, 'no truncation');
});
// ---- An edit named by TURN, not by uuid ------------------------------------
// The renderer cannot always name the message it wants to edit: a turn the user
// stopped keeps its bubble in the live layer and never reloads history, and that
// bubble is optimistic — the engine assigned the message uuid and no event carries
// it back. The turn id is the renderer's only handle, and the engine's own
// `historyTurnIds` map resolves it to exactly one message.

/** A `session/history` reply whose rows are keyed to turns by `historyTurnIds`. */
const turnMappedHistory = (): Json => ({
  history: [
    { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'first' }] },
    { type: 'assistant', uuid: 'a1', content: [{ type: 'text', text: 'reply' }] },
    { type: 'user', uuid: 'u2', content: [{ type: 'text', text: 'stopped mid-turn' }] },
    { type: 'assistant', uuid: 'a2', content: [{ type: 'text', text: 'partial' }] },
  ],
  historyTurnIds: { u1: 'turn-1', a1: 'turn-1', u2: 'turn-2', a2: 'turn-2' },
});

/** The rewind ACK is not the outcome; emit `rewound` so the awaited truncation settles. */
function settleRewindOnReply(client: FakeClient, rewound: Json = { scope: 'conversation', droppedTurns: 1, remainingTurns: 2, filesRestored: false }): void {
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method !== 'session/rewind') return original(method, params);
    const result = await original(method, params);
    client.emit('event', { type: 'rawSessionEvent', params: { event: { submissionId: 'fixture-submission', rewound } } });
    return result;
  };
}

h.test('an empty uuid with a turn id edits the message that started that turn', async () => {
  const root = byoRoot();
  const client = new FakeClient()
    .reply('session/history', turnMappedHistory())
    .replyAcknowledged('session/rewind', { rewound: { scope: 'conversation', droppedTurns: 1, remainingTurns: 2, filesRestored: false } })
    .replySubmit('start-if-idle', 'edited-turn');
  settleRewindOnReply(client);
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = await service.editMessage('thread', '', 'edited words', undefined, undefined, 'turn-2') as { ok: boolean; reason?: string };
  assertEqual(reply.ok, true, `turn-addressed edit accepted (got ${JSON.stringify(reply)})`);
  const rewindParams = client.sent('session/rewind')[0] as { messageUuid?: string; numTurns: number };
  assertEqual(rewindParams.numTurns, 1, 'the resolved message starts exactly one turn');
  const turn = client.sentSubmit('start-if-idle')[0] as { input: Json };
  assertDeepEqual(turn.input, [{ type: 'text', text: 'edited words' }], 'the resolved message is re-run with the edited text');
});

h.test('a rewind named by an optimistic uuid resolves through its turn handle', async () => {
  // The bubble a stopped turn leaves on screen carries a client-only uuid the engine
  // never persisted, so naming it directly refuses. The renderer also hands over the
  // turn id stamped on that bubble, and the engine's own uuid map resolves it to the
  // row the truncation must start from — the same handle the edit path uses.
  const root = byoRoot();
  const client = new FakeClient()
    .reply('session/history', turnMappedHistory())
    .replyAcknowledged('session/rewind', { rewound: { scope: 'conversation', droppedTurns: 1, remainingTurns: 1, filesRestored: false } });
  settleRewindOnReply(client, { scope: 'conversation', droppedTurns: 1, remainingTurns: 1, filesRestored: false });
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = await service.rewind('thread', 'submission:optimistic', 'conversation', false, 'turn-2') as { ok: boolean; reason?: string; text?: Json };
  assertEqual(reply.ok, true, `turn-handled rewind accepted (got ${JSON.stringify(reply)})`);
  assertEqual(reply.text, 'stopped mid-turn', 'the draft comes back from the resolved row');
  const rewindParams = client.sent('session/rewind')[0] as { numTurns: number };
  assertEqual(rewindParams.numTurns, 1, 'truncation starts at the resolved message');
});

h.test('a rewind whose turn handle resolves nowhere still refuses by name', async () => {
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', turnMappedHistory());
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = await service.rewind('thread', 'submission:optimistic', 'conversation', false, 'turn-404') as { ok: boolean; reason: string };
  assertEqual(reply.ok, false, 'refused');
  assertEqual(reply.reason, 'uuid-not-found', 'named refusal');
  assertEqual(client.sent('session/rewind').length, 0, 'history untouched');
});

h.test('a turn id that names an EARLIER message is still refused by the recency rule', async () => {
  // Resolving a turn must not become a way around "only the newest message is editable":
  // turn-1 is a real message, and editing it would discard turn-2.
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', turnMappedHistory());
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = await service.editMessage('thread', '', 'nope', undefined, undefined, 'turn-1') as { ok: boolean; reason: string };
  assertEqual(reply.ok, false, 'refused');
  assertEqual(reply.reason, 'not-the-last-message', 'the resolved message is not the newest');
  assertEqual(client.sent('session/rewind').length, 0, 'history untouched');
});

h.test('an unknown turn refuses rather than guessing at the newest message', async () => {
  // A send that failed before reaching the engine leaves an optimistic bubble with no
  // persisted counterpart. Falling back to "the newest user message" there would truncate
  // a DIFFERENT, real message — the one the failed send never replaced.
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', turnMappedHistory());
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = await service.editMessage('thread', '', 'nope', undefined, undefined, 'turn-does-not-exist') as { ok: boolean; reason: string };
  assertEqual(reply.ok, false, 'refused');
  assertEqual(reply.reason, 'turn-not-in-history', 'named refusal');
  assertEqual(client.sent('session/rewind').length, 0, 'no truncation');
});

// ---- A composer-owned payload rebuilds the message --------------------------
// Editing in the real composer means the attachment list is the user's current one, so
// the replacement is rebuilt by the send pipeline instead of inheriting the original
// blocks. Inheriting them would re-send an attachment the user just removed.

h.test('a media manifest replaces the original blocks entirely', async () => {
  const root = byoRoot();
  const kept = { type: 'image', path: join(root, 'kept.png'), name: 'kept.png' };
  const client = new FakeClient()
    .reply('session/history', { history: [
      // The original carried TWO images; the edit keeps one.
      { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'two pictures' },
        { type: 'image', base64: 'AAAA', mimeType: 'image/png' }, { type: 'image', base64: 'AAAA', mimeType: 'image/png' }] },
    ] })
    .replyAcknowledged('session/rewind', { rewound: { scope: 'conversation', droppedTurns: 1, remainingTurns: 0, filesRestored: false } })
    .replySubmit('start-if-idle', 'edited-turn');
  settleRewindOnReply(client);
  const seen: Array<{ text: string; media: Json[] }> = [];
  const { service, state } = serviceWith(client, root, undefined, {
    messageInput: async (text, media) => { seen.push({ text, media }); return [{ type: 'text', text }, ...media]; },
  });
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = await service.editMessage('thread', 'u1', 'one picture now', undefined, [kept]) as { ok: boolean; reason?: string };
  assertEqual(reply.ok, true, `accepted (got ${JSON.stringify(reply)})`);
  assertEqual(seen.length, 1, 'the replacement went through the send pipeline');
  assertDeepEqual(seen[0]?.media, [kept], 'only the kept attachment is re-sent, not the original two');
  assertEqual(seen[0]?.text, 'one picture now', 'the edited text is what the pipeline received');
});

h.test('an empty media manifest drops every original attachment', async () => {
  // Removing the last attachment in the composer sends an empty list. Treating "no media
  // argument" and "empty media list" as the same thing would silently restore them.
  const root = byoRoot();
  const client = new FakeClient()
    .reply('session/history', { history: [
      { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'look at this' }, { type: 'image', base64: 'AAAA', mimeType: 'image/png' }] },
    ] })
    .replyAcknowledged('session/rewind', { rewound: { scope: 'conversation', droppedTurns: 1, remainingTurns: 0, filesRestored: false } })
    .replySubmit('start-if-idle', 'edited-turn');
  settleRewindOnReply(client);
  const seen: Json[][] = [];
  const { service, state } = serviceWith(client, root, undefined, {
    messageInput: async (_text, media) => { seen.push(media); return 'text only'; },
  });
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = await service.editMessage('thread', 'u1', 'text only now', undefined, []) as { ok: boolean; reason?: string };
  assertEqual(reply.ok, true, 'accepted');
  assertDeepEqual(seen[0], [], 'the image is gone rather than passed through');
});

h.test('a composer-owned payload does not re-stamp the original display metadata', async () => {
  // The envelope describes the WHOLE replacement message. Falling back to the original one
  // when the new payload has none would redraw the pre-edit wording and the chips whose
  // attachments were just removed.
  const root = byoRoot();
  const client = new FakeClient()
    .reply('session/history', { history: [
      { type: 'user', uuid: 'u1', content: [{ type: 'text', text: 'original' }] },
      { type: 'system', subtype: 'user_display', text: JSON.stringify({ messageUuid: 'u1', localRender: { displayText: 'STALE wording' } }) },
    ] })
    .replyAcknowledged('session/rewind', { rewound: { scope: 'conversation', droppedTurns: 1, remainingTurns: 0, filesRestored: false } })
    .replySubmit('start-if-idle', 'edited-turn');
  settleRewindOnReply(client);
  const { service, state } = serviceWith(client, root, undefined, { messageInput: async text => text });
  await service.client();
  state.rememberSession('thread', 'live', {});
  await service.editMessage('thread', 'u1', 'rewritten', undefined, []);
  const options = (client.sentSubmit('start-if-idle')[0] as { options?: Record<string, Json> })?.options;
  // `displayOptions(null)` yields null, which the turn start flattens away, so the field is
  // absent rather than explicitly null. Either way the stale envelope must not ride along.
  assertEqual(options?.displayMetadata, undefined, 'no envelope rides the replacement');
  assert(!JSON.stringify(options ?? {}).includes('STALE'), 'the pre-edit wording is not re-stamped');
});

// ---- The edit-prepare read (`chat:edit-prepare`) ---------------------------

h.test('editPrepare answers with the user wording and the attachment paths', async () => {
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', { history: [
    // A send splits attachments: an inline image becomes a block (base64 on the engine's
    // side), while any other file is named by path inside the model-visible text.
    { type: 'user', uuid: 'u1', content: [
      { type: 'text', text: `please review\n\nAttached:\n- ${join(root, 'report.md')}` },
      { type: 'image', base64: 'AAAA', mimeType: 'image/png' },
    ] },
    { type: 'system', subtype: 'user_display', text: JSON.stringify({ messageUuid: 'u1', localRender: { displayText: 'please review' } }) },
  ] });
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = object(await service.editPrepare('thread', 'u1')) as {
    ok: boolean; messageUuid?: string; text?: string; attachments?: Array<Record<string, Json>>; reason?: string };
  assertEqual(reply.ok, true, `accepted (got ${JSON.stringify(reply)})`);
  assertEqual(reply.messageUuid, 'u1', 'the target is named by its engine uuid');
  // The recorded displayText, not the model-visible text: a refill must show what the user
  // typed, never the upload paths the send appended.
  assertEqual(reply.text, 'please review', 'the user wording, without the reference block');
  const paths = (reply.attachments ?? []).map(entry => String(entry?.path ?? ''));
  assertEqual(paths.length, 2, `both attachments come back (got ${JSON.stringify(reply.attachments)})`);
  assert(paths.some(path => path.endsWith('report.md')), 'the path-referenced file is recovered from the text');
  assert(paths.some(path => path.includes(root)), 'the inline image comes back as a pool path, not base64');
});

h.test('editPrepare resolves a turn id the same way the resend does', async () => {
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', turnMappedHistory());
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = object(await service.editPrepare('thread', '', 'turn-2')) as { ok: boolean; messageUuid?: string; text?: string };
  assertEqual(reply.ok, true, 'accepted');
  assertEqual(reply.messageUuid, 'u2', 'the turn resolved to its user message');
  assertEqual(reply.text, 'stopped mid-turn', 'its text came back for refilling');
});

h.test('editPrepare refuses an older message instead of offering an edit that cannot be sent', async () => {
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', turnMappedHistory());
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  const reply = object(await service.editPrepare('thread', 'u1')) as { ok: boolean; reason?: string };
  assertEqual(reply.ok, false, 'refused');
  assertEqual(reply.reason, 'not-the-last-message', 'named refusal');
});

h.test('editPrepare touches no history-mutating method', async () => {
  // It is a read: a user who opens an edit and then cancels must leave the conversation
  // exactly as it was, so nothing here may truncate or start a turn.
  const root = byoRoot();
  const client = new FakeClient().reply('session/history', turnMappedHistory());
  const { service, state } = serviceWith(client, root);
  await service.client();
  state.rememberSession('thread', 'live', {});
  await service.editPrepare('thread', 'u2');
  assertEqual(client.sent('session/rewind').length, 0, 'no truncation');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no turn started');
});

h.test('close preparation cancels authorization before waiting behind a held MCP reload', async () => {
  const root=byoRoot(), client=new FakeClient().reply('session/close',{}).replyAcknowledged('session/deleteSession',{deleted:{threadId:'thread',deleted:true}});
  let releaseReload!:()=>void, prepared=false, released=false;
  const original=client.requestWithTimeout.bind(client);
  client.requestWithTimeout=async(method,params)=>{
    if(method!=='session/reloadMcpServers')return original(method,params);
    await new Promise<void>(resolve=>{releaseReload=resolve;});
    return {mcpRuntime:{runtime:{servers:[]}}};
  };
  const {service,state}=serviceWith(client,root,undefined,{
    hostCapabilities:async()=>({mcpServers:[]}),
    beginClosing:async(id,engineId,generation)=>{assertEqual(id,'thread','renderer identity');assertEqual(engineId,'live','original engine identity');assertEqual(generation,1,'original generation');prepared=true;releaseReload();return()=>{released=true;};},
  });
  await service.client();state.rememberSession('thread','live',{});
  const reload=service.reloadMcpRuntime('thread','live',1);await waitFor(()=>!!releaseReload,1000,'reload owns its mutation gate');
  const question=service.sideQuestion('thread','queued question').then(()=>null,error=>error);
  await new Promise(resolve=>setTimeout(resolve,5));
  const closing=service.deleteSession('thread');await Promise.all([reload,closing]);
  assertEqual((await question as {code:string}).code,'ABORTED','a question queued behind authorization is cancelled before teardown');
  assertEqual(client.sent('session/sideQuestion').length,0,'cancelled queued question never reaches the provider');
  assert(prepared && released,'close preparation held admission until actual teardown');assertEqual(state.liveSession('thread'),undefined,'actual session closed');
  await assertRejects(()=>service.reloadMcpRuntime('thread','live',1),'closed context cannot reload a replacement');
});

h.test('inference projection resets old model pins and excludes host resources and permissions', () => {
  const selection = configuredInference({ modelSelection: 'custom:new', permissionMode: 'plan', cwd: '/project',
    config: { thinking: false, sandbox_mode: 'danger-full-access' }, hostCapabilities: { mcpServers: [] } },
  { model: 'engine-default', effort: 'max', maxOutputTokens: 1234, maxOutputRetryTokens: 5678, contextWindow: 80000, sandbox_mode: 'workspace-write' },
  { model: 'defaults', effort: 'user', maxOutputTokens: 'project', maxOutputRetryTokens: 'project', contextWindow: 'user', sandbox_mode: 'user' });
  assertDeepEqual(selection, { modelSelection: 'custom:new', config: { maxOutputTokens: 1234, maxOutputRetryTokens: 5678, contextWindow: 80000, thinking: false, modelVerbosity: null, reasoningSummary: 'auto', webSearch: { access: 'live' } } }, 'only the selected inference contract');
  const previous = { provider: { model: 'old' }, auth: { token: 'old' }, pricing: [], modelTierSelections: { low: 'old' },
    cwd: '/project', permissionMode: 'plan', hostCapabilities: { mcpServers: [{ id: 'mcp' }] },
    config: { effort: 'high', modelTiers: { high: 'old' }, maxOutputTokens: 99, maxOutputRetryTokens: 100, sandbox_mode: 'workspace-write',
      subagentModelCatalog: true, subagentModelOptions: [{ value: 'custom:child', label: 'Child' }] } };
  assertDeepEqual(replaceInferenceInit(previous, selection), { modelSelection: 'custom:new', cwd: '/project', permissionMode: 'plan',
    hostCapabilities: { mcpServers: [{ id: 'mcp' }] }, config: { sandbox_mode: 'workspace-write', subagentModelCatalog: true,
      subagentModelOptions: [{ value: 'custom:child', label: 'Child' }], maxOutputTokens: 1234, maxOutputRetryTokens: 5678, contextWindow: 80000, thinking: false, modelVerbosity: null, reasoningSummary: 'auto', webSearch: { access: 'live' } } }, 'old credentials and omitted inference pins are removed, resources and subagent model policy stay');
});

for (const vector of modelSourceVectors.inferenceProjection) {
  h.test(`inference projection: ${vector.name}`, () => {
    assertDeepEqual(configuredInference(vector.init, vector.resolved, vector.sources), vector.expected,
      'model precedence follows the committed source-selection contract');
  });
}

// The truncation-recovery rung is an inference pin like `maxOutputTokens`, so it
// has to survive the same projection: dropped here and the engine silently falls
// back to doubling the budget instead of using the configured rung.
h.test('inference projection carries the output retry rung and drops an unpinned one', () => {
  const pinned = configuredInference({ modelSelection: 'custom:new' },
    { maxOutputRetryTokens: 24000 }, { maxOutputRetryTokens: 'project' });
  assertDeepEqual(pinned.config, { maxOutputRetryTokens: 24000, modelVerbosity: null, reasoningSummary: 'auto', webSearch: { access: 'cached' } }, 'an explicitly pinned rung is forwarded');
  const defaulted = configuredInference({ modelSelection: 'custom:new' },
    { maxOutputRetryTokens: 24000 }, { maxOutputRetryTokens: 'defaults' });
  assertDeepEqual(defaulted.config, { modelVerbosity: null, reasoningSummary: 'auto', webSearch: { access: 'cached' } }, 'a rung that only comes from defaults is not pinned to the session');
  const unknown = inferenceInit({ config: { maxOutputRetryTokens: 1, notAContractKey: 2 } });
  assertDeepEqual(unknown.config, { maxOutputRetryTokens: 1 }, 'only contract keys reach the named facade');
});

function modelChangeClient(): FakeClient {
  const client = new FakeClient().reply('session/start', { sessionId: 'live' }).replySubmit('start-if-idle', 'next')
    .reply('session/modelRuntime', { revision: 0 })
    .reply('config/read', { resolved: { model: 'default', maxOutputTokens: 4096 }, sources: { model: 'defaults', maxOutputTokens: 'project' } })
    .reply('session/reconfigureModel', { revision: 1 });
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    const row = object(params)!;
    if (method === 'session/beginModelUpdate') {
      client.calls.push({ method, params });
      return { revision: row.expectedRevision, changeId: row.changeId };
    }
    const result = await original(method, params);
    return method === 'session/reconfigureModel' ? { ...object(result), changeId: row.changeId } : result;
  };
  return client;
}

h.test('queued continuation applies a pending model without replacing its writer or emitting an intermediate done', async () => {
  const root = byoRoot(), client = modelChangeClient(), terminals: string[] = [];
  const { service, state } = serviceWith(client, root, undefined, {
    onEvent: event => { if (event.type === 'turnCompleted') terminals.push(String((event.params as { turnId: string }).turnId)); },
  });
  await service.resolveLiveSession('thread');
  const queue = { revision: 3, status: 'authoritative', items: [{ state: 'pending', mutable: true,
    message: { uuid: 'queued-original', value: 'Queued input', mode: 'prompt', priority: 'next' } }] };
  client.reply('session/queueSnapshot', { queueSnapshot: queue }); state.installQueueSnapshot('thread', queue);
  state.markTurnRunning('thread', 'first');
  setSessionModel('thread', 'custom:new', 'custom', root); state.markModelChanged('thread');
  client.reply('session/resumePending', { pendingResume: { started: true } });
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'first', result: { stopReason: 'completed' } } });
  await waitFor(() => client.sent('session/resumePending').length === 1, 1000, 'queued admission');
  const resume = rowAt(client.sent('session/resumePending'), 0, 'continuation');
  assertEqual(resume.afterSubmissionId, 'first', 'completed submission guards continuation');
  assertEqual(resume.sessionId, 'live', 'the same engine writer owns the queue');
  assert(typeof resume.submissionId === 'string' && resume.submissionId.length > 0, 'continuation has its own identity');
  assert(client.calls.findIndex(call => call.method === 'session/reconfigureModel') < client.calls.findIndex(call => call.method === 'session/resumePending'), 'model replacement is confirmed before queued inference');
  assertEqual(state.sessionProvider('thread')?.selection, 'custom:new', 'confirmed queued model is visible to host tools');
  assertEqual(client.sent('session/close').length, 0, 'no writer or background resource was destroyed');
  client.reply('session/resumePending', { pendingResume: { started: false, reason: 'empty' } });
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: resume.submissionId, result: { stopReason: 'completed' } } });
  await waitFor(() => terminals.length === 1, 1000, 'only the final done is presented');
  assertDeepEqual(terminals, [resume.submissionId], 'the predecessor cannot clear a running continuation');
  await service.shutdown();
});

h.test('an empty completed queue leaves a saved model change pending until actual inference', async () => {
  const root = byoRoot(), client = modelChangeClient(); let completed = false;
  const { service, state } = serviceWith(client, root, undefined, { onEvent: event => { if (event.type === 'turnCompleted') completed = true; } });
  await service.resolveLiveSession('thread');
  const provider = state.sessionProvider('thread');
  setSessionModel('thread', 'custom:new', 'custom', root); state.markModelChanged('thread');
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'first', result: { stopReason: 'completed' } } });
  await waitFor(() => completed, 1000, 'empty completion remains successful');
  assertDeepEqual(state.sessionProvider('thread'), provider, 'no provider side effect without a queued turn');
  assertEqual(state.inferencePending('thread'), true, 'the saved model is reserved for the next actual admission');
  assertEqual(client.sent('session/reconfigureModel').length, 0, 'completion does not activate the saved provider');
  assertEqual(client.sent('session/resumePending').length, 0, 'an authoritative empty queue needs no inference admission');
  await service.shutdown();
});

h.test('stop fences a held queue admission before awaiting the interrupt ACK', async () => {
  const root = byoRoot(), client = modelChangeClient().reply('turn/interrupt', {});
  let release!: (value: unknown) => void, completed = 0;
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method !== 'session/resumePending') return original(method, params);
    return new Promise(resolve => { release = resolve; });
  };
  const { service, state } = serviceWith(client, root, undefined, { onEvent: event => { if (event.type === 'turnCompleted') completed++; } });
  await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'first');
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'first', result: { stopReason: 'completed' } } });
  await waitFor(() => !!release, 1000, 'queue admission is held');
  const stopped = service.interrupt('thread', 'first');
  release({ pendingResume: { started: false } });
  await stopped;
  // The engine RPC is the stop's background leg now; flush it before counting sends.
  await Promise.resolve();
  assertEqual(state.isWorking('thread'), false, 'the accepted stop clears the held busy state');
  assertEqual(completed, 1, 'stop releases the real completion once and ignores a late admission outcome');
  assertEqual(client.sent('turn/interrupt').length, 1, 'the actual engine receives the stop');
  await service.shutdown();
});

h.test('failed stop or close releases an already completed turn without generating a title or restarting its queue', async () => {
  const expected = JSON.parse(readFileSync(vectorPath('pending-turn-vectors.json'), 'utf8')).stoppedCompletion;
  for (const failure of ['interrupt', 'beginClosing', 'onClosing']) {
    const root = byoRoot(), client = modelChangeClient();
    let release!: (value: unknown) => void;
    const original = client.requestWithTimeout.bind(client);
    client.requestWithTimeout = async (method, params) => {
      if (method === 'session/resumePending') return new Promise(resolve => { release = resolve; });
      if (method === 'turn/interrupt') throw new Error('Interrupt unavailable');
      return original(method, params);
    };
    let pump: SessionEventPump | undefined;
    const frames: Json[] = [];
    const forwarder = new ChatEventForwarder((_channel, values) => frames.push(...values as Json[]));
    const { service, state } = serviceWith(client, root, undefined, {
      onEvent: event => pump?.receive(event, 1),
      ...(failure === 'beginClosing' ? { beginClosing: async () => { throw new Error('Pre-close unavailable'); } } : {}),
      ...(failure === 'onClosing' ? { onClosing: async () => { throw new Error('Resource close unavailable'); } } : {}),
    });
    pump = new SessionEventPump({ state, forwarder, currentGeneration: () => 1, emit: () => {}, log: () => {} });
    await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'first');
    const terminal = { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'first', result: { stopReason: 'completed' } } };
    client.emit('event', terminal);
    await waitFor(() => !!release, 1000, 'queue admission is held');
    if (failure === 'interrupt') {
      // A stop settles optimistically, so an engine RPC that later fails is a
      // background log line, not a rejection the user waits on. The completed turn still
      // releases below because the terminal event, not the RPC, owns the verdict.
      const stopped = await service.interrupt('thread', 'first') as Record<string, Json>;
      assertEqual(stopped.ok, true, 'interrupt: a stop against an already-completed turn resolves as a harmless no-op');
    } else {
      await assertRejects(() => service.deleteSession('thread'), failure);
    }
    release({ pendingResume: { started: false } });
    client.emit('event', terminal);
    assertEqual(state.isWorking('thread'), false, `${failure}: completed work cannot stay busy`);
    assertEqual(frames.filter(frame => (frame as Record<string, Json>).type === 'done').length, 1, 'one original completion reaches the real event pump');
    assertDeepEqual(frames.find(frame => (frame as Record<string, Json>).type === 'done'), expected, 'the published completion carries exactly these fields and no invented queuePaused');
    assertEqual(frames.filter(frame => (frame as Record<string, Json>).type === 'interrupted').length, 0, 'no synthetic cancellation was invented');
    assertEqual(client.sent('session/generateTitle').length, 0, 'stopping never starts title inference');
    assertEqual(state.liveSession('thread'), 'live', 'the refused close preserves its writer');
    state.markTurnRunning('thread', 'successor');
    client.emit('event', { ...terminal, params: { ...terminal.params, turnId: 'another-predecessor' } });
    assertEqual(state.runningTurnId('thread'), 'successor', 'a later old completion cannot clear the successor');
    assertEqual(client.sent('session/generateTitle').length, 0, 'late stopped completions also skip title inference');
    await service.shutdown(); forwarder.close();
  }
});

h.test('a tier saved while session start awaits its receipt is published before activation completes', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  const configuration = new SessionConfiguration({ state, configRoot: root, request: (method, params) => service.request(method, params), log: () => {}, refreshModelTiers: () => service.refreshModelTiers() });
  let release!: () => void;
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    const result = await original(method, params);
    if (method === 'session/start') await new Promise<void>(resolve => { release = resolve; });
    return result;
  };
  const activation = service.resolveLiveSession('thread');
  await waitFor(() => !!release, 1000, 'session start is waiting for its receipt');
  const initial = rowAt(client.sent('session/start'), 0, 'initial snapshot').init as Record<string, Json>;
  const mapping = readModelTierMapping(root);
  const changed = setModelTierMapping('low', { source: 'codex', modelId: 'latest' }, mapping.revision, root);
  await configuration.settingsChanged(GLOBAL_MODEL_TIERS_KEY);
  assertEqual(state.liveSession('thread'), undefined, 'the saved notification cannot yet see the starting binding');
  assertEqual(client.sent('session/reconfigureModel').length, 0, 'no request is sent to an unacknowledged engine session');
  release(); await activation;
  assertDeepEqual(rowAt(client.sent('session/reconfigureModel'), 0, 'activation catch-up').init, {
    modelTierTargets: { high: null, medium: null, low: { type: 'source', source: 'codex', modelId: 'latest' } },
  }, 'activation publishes the saved mapping instead of retaining its stale bundle');
  assertEqual(state.modelTierRevision('thread'), changed.revision, 'the cache records exactly the acknowledged tier revision');
  assertEqual(state.sessionProvider('thread')?.selection, initial.modelSelection, 'main identity remains the initial selection');
  assertEqual(state.inferencePending('thread'), false, 'catch-up does not create a pending main replacement');
  assertEqual(client.sent('session/start').length, 1, 'one writer was activated');
  assertEqual(client.sent('session/close').length, 0, 'the caught-up session is not destroyed');
  await service.shutdown();
});

h.test('saving shared tiers publishes a tier-only CAS during a running turn without changing its main provider', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  const configuration = new SessionConfiguration({ state, configRoot: root, request: (method, params) => service.request(method, params), log: () => {}, refreshModelTiers: () => service.refreshModelTiers() });
  await service.resolveLiveSession('thread');
  const previous = state.sessionProvider('thread');
  state.markTurnRunning('thread', 'old-turn');
  const mapping = readModelTierMapping(root);
  setModelTierMapping('low', { source: 'codex', modelId: 'fast' }, mapping.revision, root);
  await configuration.settingsChanged(GLOBAL_MODEL_TIERS_KEY);
  assertDeepEqual(rowAt(client.sent('session/reconfigureModel'), 0, 'tier update'), {
    sessionId: 'live', expectedRevision: 0,
    init: { modelTierTargets: { high: null, medium: null, low: { type: 'source', source: 'codex', modelId: 'fast' } } },
  }, 'only shared tier targets travel over the active-safe facade');
  assertDeepEqual(state.sessionProvider('thread'), previous, 'main auth and selection remain unchanged');
  assertEqual(state.runningTurnId('thread'), 'old-turn', 'in-flight turn keeps its identity');
  assertEqual(state.inferencePending('thread'), false, 'a confirmed tier update does not request a full main replacement');
  assertEqual(client.sent('session/close').length, 0, 'no existing child or writer is closed');
  assertEqual(client.sent('session/start').length, 1, 'no replacement session starts');
  await service.shutdown();
});

h.test('a shared tier update cannot consume an independently pending main model change', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  await service.resolveLiveSession('thread');
  const previous = state.sessionProvider('thread');
  setSessionModel('thread', 'custom:new', 'custom', root); state.markModelChanged('thread');
  const mapping = readModelTierMapping(root);
  setModelTierMapping('high', { source: 'subscription', modelId: 'opus' }, mapping.revision, root);
  await service.refreshModelTiers();
  assertEqual(state.inferencePending('thread'), true, 'the main selection still waits for admission');
  assertDeepEqual(state.sessionProvider('thread'), previous, 'tier refresh never prepares the pending main');
  const init = rowAt(client.sent('session/reconfigureModel'), 0, 'tier update').init as Record<string, Json>;
  assertDeepEqual(Object.keys(init), ['modelTierTargets'], 'no main config or credentials are sent');
  await service.shutdown();
});

h.test('newer shared tiers arriving before the update receipt are applied against the next engine revision', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  await service.resolveLiveSession('thread');
  let mapping = readModelTierMapping(root);
  mapping = setModelTierMapping('low', { source: 'codex', modelId: 'first' }, mapping.revision, root);
  client.replySequence('session/modelRuntime', [{ revision: 0 }, { revision: 1 }]).replySequence('session/reconfigureModel', [{ revision: 1 }, { revision: 2 }]);
  let release!: () => void;
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    const result = await original(method, params);
    if (method === 'session/reconfigureModel' && client.sent(method).length === 1) await new Promise<void>(resolve => { release = resolve; });
    return result;
  };
  const refresh = service.refreshModelTiers();
  await waitFor(() => !!release, 1000, 'first tier receipt is held');
  setModelTierMapping('low', { source: 'codex', modelId: 'latest' }, mapping.revision, root);
  release(); await refresh;
  const last = rowAt(client.sent('session/reconfigureModel'), 1, 'newest tiers');
  assertEqual(last.expectedRevision, 1, 'the second CAS reads the actual engine revision');
  assertDeepEqual(last.init, { modelTierTargets: { high: null, medium: null, low: { type: 'source', source: 'codex', modelId: 'latest' } } }, 'latest saved mapping wins');
  assertEqual(state.inferencePending('thread'), false, 'main ownership remains confirmed');
  await service.shutdown();
});

h.test('a failed live tier update is reported as saved but unapplied and leaves a retry pending', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  await service.resolveLiveSession('thread');
  const previous = state.sessionProvider('thread');
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => { if (method === 'session/reconfigureModel') throw { kind: 'timeout', method }; return original(method, params); };
  const configuration = new SessionConfiguration({ state, configRoot: root, request: (method, params) => service.request(method, params), log: () => {}, refreshModelTiers: () => service.refreshModelTiers() });
  const error = await assertRejects(() => configuration.settingsChanged(GLOBAL_MODEL_TIERS_KEY), 'lost tier receipt stays explicit') as { code: string };
  assertEqual(error.code, 'MODEL_TIER_APPLY_FAILED', 'no false success on an unconfirmed update');
  assertDeepEqual(state.sessionProvider('thread'), previous, 'main provider is not guessed');
  assertEqual(state.inferencePending('thread'), true, 'the next admission will re-read the runtime and retry');
  await service.shutdown();
});

// Renamed by this change: the behaviour it pins is no longer "replace inference
// before the next turn" but "publish during the active turn", which the body
// below asserts (no writer replacement, no queue loss, no turn relabel).
h.test('a model preference publishes during the active turn without replacing its writer or queue', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  const configuration = new SessionConfiguration({ state, configRoot: root, request: (method, params) => service.request(method, params), log: () => {},
    publishInference: id => service.publishInferenceChanges(id) });
  await service.resolveLiveSession('thread');
  state.installQueueSnapshot('thread', { revision: 2, items: [], status: 'authoritative' });
  const queue = state.queueSnapshot('thread');
  state.markTurnRunning('thread', 'old-turn');
  setSessionModel('thread', 'custom:new', 'custom', root);
  await configuration.composerChanged({ kind: 'model', sessionId: 'thread' });
  assertEqual(state.isStale('thread'), false, 'model changes never request a close/resume');
  assertEqual(await service.resolveLiveSession('thread'), 'live', 'a panel read retains the same binding');
  await waitFor(() => !state.inferencePending('thread'), 1000, 'active-turn publication finishes');
  assertEqual(client.sent('session/reconfigureModel').length, 1, 'the next step can capture the new selection without a turn terminal');
  assertEqual(state.runningTurnId('thread'), 'old-turn', 'publication never ends or relabels the current turn');
  state.clearTurnRunning('thread');
  await service.send('thread', { text: 'new turn' });
  assertEqual(state.liveSession('thread'), 'live', 'engine identity was preserved');
  assertEqual(state.queueSnapshot('thread'), queue, 'queue revision and object were retained');
  assertEqual(state.sessionProvider('thread')?.selection, 'custom:new', 'host provider follows the confirmed replacement');
  assertEqual(state.inferencePending('thread'), false, 'the acknowledged revision was applied');
  assertEqual(client.sent('session/start').length, 1, 'no resume endpoint was created');
  assertEqual(client.sent('session/close').length, 0, 'MCP and background resources were not closed');
  const change = rowAt(client.sent('session/reconfigureModel'), 0, 'replacement');
  assert(typeof change.changeId === 'string' && change.changeId.length > 0, 'publication carries the fence identity');
  assertDeepEqual(change, { sessionId: 'live', expectedRevision: 0, changeId: change.changeId,
    init: { modelSelection: 'custom:new', modelSource: { source: 'custom', modelId: 'new', selection: 'custom:new' },
      modelTierTargets: { high: null, medium: null, low: null }, advisorTarget: null, featureTargets: { title: null, prediction: null, memory: null }, config: { maxOutputTokens: 4096, thinking: true, ultraMode: false, effort: 'medium', modelVerbosity: null, reasoningSummary: 'auto', webSearch: { access: 'cached' } } } },
  'project output, source attribution and complete tier targets use the named facade');
  assertDeepEqual(client.sent('config/read'), [{ cwd: sessionDir('thread', root) }, { cwd: sessionDir('thread', root) }], 'activation and model replacement use this conversation directory');
  assert(client.calls.findIndex(call => call.method === 'session/reconfigureModel') < client.calls.findIndex(call => call.method === 'turn/submit' && (call.params as Record<string, Json>).mode === 'start-if-idle'), 'replacement is confirmed before the new turn');
});

h.test('Advisor settings publish their independent target through the inference facade and preserve the live chat', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  const features = new ModelFeatureSettings(root);
  features.setAdvisor({ enabled: true, model: 'subscription:opus' });
  const configuration = new SessionConfiguration({ state, configRoot: root, request: (method, params) => service.request(method, params), log: () => {},
    publishInference: id => service.publishInferenceChanges(id) });
  await service.resolveLiveSession('thread');
  const initial = rowAt(client.sent('session/start'), 0, 'initial setup').init as Record<string, Json>;
  assertDeepEqual(initial.advisorTarget, { type: 'source', source: 'subscription', modelId: 'opus' }, 'start carries the global advisor rather than the main source');
  state.markTurnRunning('thread', 'old-turn');
  const snapshot = JSON.stringify(initial.advisorTarget), main = state.sessionProvider('thread')?.selection;
  const choices: Array<Record<string, Json>> = [{ enabled: false }, { enabled: true }, { enabled: true, model: 'custom:small' }, { enabled: false, model: '' }];
  for (const choice of choices) {
    features.setAdvisor(choice);
    await configuration.settingsChanged('advisor');
    await waitFor(() => !state.inferencePending('thread'), 1000, 'advisor publication completes');
    const calls = client.sent('session/reconfigureModel');
    const init = rowAt(calls, calls.length - 1, 'published advisor').init as Record<string, Json>;
    assertDeepEqual(init.advisorTarget, features.getAdvisorTarget(), 'full publication includes source target or explicit null');
    assertEqual(state.isStale('thread'), false, 'an advisor change never requests a rebind');
    assertEqual(state.sessionProvider('thread')?.selection, main, 'main model identity is retained');
    assertEqual(state.runningTurnId('thread'), 'old-turn', 'the active turn is not replaced');
    assertEqual(JSON.stringify(initial.advisorTarget), snapshot, 'the captured initial target was not mutated');
  }
  assertEqual(client.sent('session/start').length, 1, 'there is only one session writer');
  assertEqual(client.sent('session/close').length, 0, 'no session resources were closed');
  assertEqual(client.sent('model/credential/read').length, 0, 'no advisor credentials enter the host publication');
  assertEqual(features.getAdvisorTarget(), null, 'explicit clear remains disabled');
  state.clearTurnRunning('thread');
  await service.send('thread', { text: 'next turn uses the published advisor setting' });
  assertEqual(state.liveSession('thread'), 'live', 'the next turn reuses the acknowledged binding');
  await service.shutdown();
});

h.test('an active-turn side question joins model publication without a recursive mutation deadlock', async () => {
  const root = byoRoot(), client = modelChangeClient().reply('session/sideQuestion', { sideQuestion: { response: 'new-model-answer' } });
  const { service, state } = serviceWith(client, root);
  await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'main-turn');
  setSessionModel('thread', 'custom:new', 'custom', root); state.markModelChanged('thread');
  const answer = await service.sideQuestion('thread', 'ask while the main turn is running');
  assertEqual(answer.response, 'new-model-answer', 'the public side question completes while the main turn remains active');
  assertEqual(state.runningTurnId('thread'), 'main-turn', 'side work cannot finish the main turn');
  assertEqual(state.sessionProvider('thread')?.selection, 'custom:new', 'side admission does not skip pending publication');
  assert(client.calls.findIndex(row => row.method === 'session/reconfigureModel') < client.calls.findIndex(row => row.method === 'session/sideQuestion'), 'complete provider publication precedes new side capture');
  await service.shutdown();
});

h.test('live model publication does not wait for an already-started title request', async () => {
  const root = byoRoot(), client = modelChangeClient()
    .reply('engine/readSessionSummary', { session: { id: 'thread', title: 'New Chat' } })
    .reply('session/generateTitle', { generatedTitle: { threadId: 'thread', title: { title: 'Captured old title', persisted: false } } })
    .reply('session/updateTitle', { title: { threadId: 'thread', title: 'Captured old title' } });
  let release!: () => void;
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    const result = await original(method, params);
    if (method === 'session/generateTitle') await new Promise<void>(resolve => { release = resolve; });
    return result;
  };
  const { service, state } = serviceWith(client, root);
  await service.resolveLiveSession('thread'); await service.send('thread', { text: 'seed content' });
  client.emit('event', { type: 'productEvent', method: 'turn/started', params: { sessionId: 'live', turnId: 'next' } });
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'next', result: { stopReason: 'completed' } } });
  await waitFor(() => !!release, 1000, 'title has captured its old provider and is still held');
  setSessionModel('thread', 'custom:new', 'custom', root); state.markModelChanged('thread');
  await service.publishInferenceChanges('thread');
  await waitFor(() => !state.inferencePending('thread'), 1000, 'next snapshot publishes while title is held');
  assertEqual(client.sent('session/reconfigureModel').length, 1, 'no title wait sits before publication');
  release(); await waitFor(() => readSessionTitle('thread', root)?.source === 'ai', 1000, 'the old title safely finishes later');
  await service.shutdown();
});

h.test('invalid configuration rejection retains the old provider and permits an explicit retry', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  await service.resolveLiveSession('thread');
  const previous = state.sessionProvider('thread');
  setSessionModel('thread', 'custom:new', 'custom', root); state.markModelChanged('thread');
  const original = client.requestWithTimeout.bind(client); let busy = true;
  client.requestWithTimeout = async (method, params) => {
    if (method === 'session/reconfigureModel' && busy) { await original(method, params); throw { kind: 'server', code: -32000, message: 'invalid inference configuration' }; }
    return original(method, params);
  };
  const failed = await assertRejects(() => service.send('thread', { text: 'first' }), 'invalid inference configuration refuses publication');
  assertEqual((failed as { code: string }).code, 'MODEL_RECONFIGURE_FAILED', 'reason is surfaced to the composer');
  assertDeepEqual(state.sessionProvider('thread'), previous, 'no optimistic provider update');
  assertEqual(state.inferenceUncertain('thread'), false, 'an explicit atomic refusal is known');
  assertEqual(state.inferencePending('thread'), true, 'saved choice can be retried');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no turn uses a model different from the requested selection');
  busy = false;
  await service.send('thread', { text: 'retry' });
  assertEqual(client.sentSubmit('start-if-idle').length, 1, 'explicit retry starts once');
  assertEqual(client.sent('session/close').length, 0, 'refusal did not destroy existing resources');
});

h.test('send and continue publish after Stop without a busy-retry loop', async () => {
  for (const action of ['send', 'continue'] as const) {
    const root = byoRoot(), client = modelChangeClient().reply('turn/interrupt', { submissionId: 'stop' });
    const { service, state } = serviceWith(client, root);
    await service.resolveLiveSession('thread');
    state.markTurnRunning('thread', 'old');
    setSessionModel('thread', 'custom:new', 'custom', root); state.markModelChanged('thread');
    await service.interrupt('thread', 'old');
    client.reply('session/backgroundProcesses', { backgroundProcesses: { processes: [{ id: 'preview', status: 'running' }] } });
    if (action === 'send') await service.send('thread', { text: 'after stop' });
    else await service.continueTurn('thread');
    assertEqual(client.sent('session/reconfigureModel').length, 1, `${action}: one publication, without waiting for old inference or the preview`);
    assertEqual(client.sentSubmit(action === 'continue' ? 'continue-if-idle' : 'start-if-idle').length, 1, `${action}: one new turn starts after replacement`);
    assertEqual(state.inferencePending('thread'), false, `${action}: the saved selection was applied`);
    assertEqual(client.sent('session/close').length, 0, `${action}: the preview-owning session was not closed`);
    await service.shutdown();
  }
});

h.test('a lost model ACK blocks cached-provider inference until a confirmed replacement', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  await service.resolveLiveSession('thread');
  setSessionModel('thread', 'custom:new', 'custom', root); state.markModelChanged('thread');
  const original = client.requestWithTimeout.bind(client); let loseAck = true;
  client.requestWithTimeout = async (method, params) => {
    if (method === 'session/reconfigureModel' && loseAck) { await original(method, params); throw { kind: 'timeout', method }; }
    return original(method, params);
  };
  await assertRejects(() => service.send('thread', { text: 'lost ack' }), 'transport outcome is ambiguous');
  assertEqual(state.inferenceUncertain('thread'), true, 'cached provider cannot prove the active auth source');
  state.markTurnRunning('thread', 'unexpected-turn');
  const failed = await assertRejects(() => service.followUp('thread', { text: 'steer' }), 'an unknown provider cannot bypass authorization');
  assertEqual((failed as { code: string }).code, 'MODEL_STATE_UNCERTAIN', 'steer clearly reports the uncertainty');
  assertEqual(client.sentSubmit('steer').length, 0, 'no inference on guessed credentials');
  state.clearTurnRunning('thread'); loseAck = false;
  client.reply('session/modelRuntime', { revision: 1 }).reply('session/reconfigureModel', { revision: 2 });
  await service.send('thread', { text: 'retry' });
  assertEqual(state.inferenceUncertain('thread'), false, 'new complete selection restores known ownership');
  assertEqual(rowAt(client.sent('session/reconfigureModel'), 1, 'retry').expectedRevision, 1, 'retry rereads engine state instead of overwriting with the old CAS');
  assertEqual(client.sentSubmit('start-if-idle').length, 1, 'only the confirmed retry starts');
});

h.test('a newer preference arriving during reconfiguration is applied before admitting a turn', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  await service.resolveLiveSession('thread');
  setSessionModel('thread', 'custom:second', 'custom', root); state.markModelChanged('thread');
  let release!: () => void;
  const original = client.requestWithTimeout.bind(client);
  client.replySequence('session/modelRuntime', [{ revision: 0 }, { revision: 1 }]).replySequence('session/reconfigureModel', [{ revision: 1 }, { revision: 2 }]);
  client.requestWithTimeout = async (method, params) => {
    const reply = await original(method, params);
    if (method === 'session/reconfigureModel' && client.sent(method).length === 1) await new Promise<void>(resolve => { release = resolve; });
    return reply;
  };
  const send = service.send('thread', { text: 'latest' });
  await waitFor(() => !!release, 1000, 'first replacement is awaiting its ACK');
  setSessionModel('thread', 'custom:third', 'custom', root); state.markModelChanged('thread'); setSessionThinkingLevel('thread', 'off', root);
  release(); await send;
  assertEqual(state.sessionProvider('thread')?.selection, 'custom:third', 'newer preference was not consumed by the older completion');
  assertEqual(client.sent('session/reconfigureModel').length, 2, 'latest preference was prepared against the new engine revision');
  const last = rowAt(client.sent('session/reconfigureModel'), 1, 'latest').init as Record<string, Json>;
  assertDeepEqual(last.config, { maxOutputTokens: 4096, thinking: false, ultraMode: false, modelVerbosity: null, reasoningSummary: 'auto', webSearch: { access: 'cached' } }, 'turning thinking off clears old effort');
  assertEqual(client.calls.filter(call => ['session/reconfigureModel', 'turn/submit'].includes(call.method)).map(call => call.method).join(','), 'session/reconfigureModel,session/reconfigureModel,turn/submit', 'no turn slips between settings revisions');
});

h.test('model edits during session activation are not lost and UI-only settings keep the binding', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  const configuration = new SessionConfiguration({ state, configRoot: root, request: (method, params) => service.request(method, params), log: () => {} });
  let release!: () => void;
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    const reply = await original(method, params);
    if (method === 'session/start') await new Promise<void>(resolve => { release = resolve; });
    return reply;
  };
  const starting = service.resolveLiveSession('thread'); await waitFor(() => !!release, 1000, 'session activation awaits engine');
  setSessionModel('thread', 'custom:new', 'custom', root); await configuration.composerChanged({ kind: 'model', sessionId: 'thread' });
  release(); await starting;
  assertEqual(state.inferencePending('thread'), true, 'initialization records its captured preference revision');
  await service.send('thread', { text: 'first turn' });
  assertEqual(state.sessionProvider('thread')?.selection, 'custom:new', 'new selection applied before the first turn');
  for (const key of ['language', 'global_shortcut', 'quick_input_shortcut', 'composer.main_model']) configuration.settingsChanged(key);
  await configuration.composerChanged({ kind: 'model' });
  assertEqual(state.isStale('thread'), false, 'global new-chat defaults and UI settings do not close a live session');
  assertEqual(state.inferencePending('thread'), false, 'the session-specific choice keeps precedence');
});

h.test('an independent Windows level write survives request-policy publication and rebuilds before the next idle send', async () => {
  class WindowsConfigClient extends FakeClient {
    readonly values: Record<string, Json> = {
      approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user',
      sandbox_workspace_write: { network_access: false }, windows: { sandbox: 'unelevated' },
    };
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method === 'config/read') {
        this.calls.push({ method, params });
        return { values: structuredClone(this.values), resolved: structuredClone(this.values), sources: { windows: 'user' } };
      }
      if (method === 'config/batchWrite') {
        this.calls.push({ method, params });
        const edits = object(params)?.edits as Json[];
        assertEqual(edits.length, 1, 'each settings click has its own configuration write');
        const edit = object(edits[0]);
        if (edit?.keyPath === 'windows.sandbox') this.values.windows = { sandbox: edit.value! };
        else if (edit?.keyPath === 'approval_policy') this.values.approval_policy = edit.value!;
        else throw new Error('Unexpected configuration edit: ' + JSON.stringify(edit));
        return {};
      }
      return super.requestWithTimeout(method, params);
    }
  }
  const root = byoRoot(), client = new WindowsConfigClient()
    .replySequence('session/start', [{ sessionId: 'windows-old' }, { sessionId: 'windows-rebuilt' }])
    .reply('session/close', {}).reply('session/setRuntimePolicy', {}).replySubmit('start-if-idle', 'windows-next')
    .replyAcknowledged('session/updateConfig', { [goalReadLifecycle.runtimeConfigOutcomeField]: {} });
  const snapshots: Json[] = [];
  const { service, state } = serviceWith(client, root, undefined, {
    hostCapabilities: async (_id, _cwd, values) => {
      snapshots.push(object(values?.windows)?.sandbox ?? null);
      return { mcpServers: [], runtimeCapabilityRoots: [] };
    },
  });
  const configuration = new SessionConfiguration({ state, configRoot: root,
    request: (method, params) => service.request(method, params), log: () => {},
    updateRuntimeConfig: (id, update) => service.updateRuntimeConfig(id, update) });
  const registry = new ChannelRegistry();
  registerSettingsHandlers(registry, { configRoot: root,
    request: (method, params) => service.request(method, object(params) ?? {}),
    onSettingsChanged: (key, scope) => configuration.settingsChanged(key, scope) });
  const write = (key: string, value: string) => registry.lookup('settings:kv:set')!({
    channel: 'settings:kv:set', role: 'main', senderId: 1, args: [{ key, value }],
  });
  try {
    await service.resolveLiveSession('windows-thread');
    assertDeepEqual(snapshots, ['unelevated'], 'the initial writer was built from the original Windows configuration');
    assertEqual(state.isWorking('windows-thread'), false, 'the next send starts from an idle writer');
    await write('klaus.windows.sandbox', 'elevated');
    assertEqual(state.isStale('windows-thread'), true, 'the independent structural setting fences the existing writer');
    await write('klaus.approvalPolicy', 'on-request');
    const policy = rowAt(client.sent('session/setRuntimePolicy'), 0, 'request policy');
    assertDeepEqual({ approvalPolicy: policy.approvalPolicy, sandboxMode: policy.sandboxMode,
      approvalsReviewer: policy.approvalsReviewer, networkAllowed: policy.networkAllowed },
    { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', approvalsReviewer: 'user', networkAllowed: false },
    'the successful live publication is the ordinary request/default policy tuple');
    assertEqual(state.isStale('windows-thread'), true, 'policy and search publication cannot erase the independent rebuild requirement');
    assertEqual(state.liveSession('windows-thread'), 'windows-old', 'the policy write does not replace the idle writer itself');
    assertEqual(client.sent('session/close').length, 0, 'settings callbacks leave teardown to the next admission');
    const admissionStart = client.calls.length;
    await service.send('windows-thread', { text: 'Use the prepared Windows configuration' });
    assertDeepEqual(client.calls.slice(admissionStart).filter(call => ['session/close', 'config/read', 'session/start', 'turn/submit'].includes(call.method)).map(call => call.method),
      ['session/close', 'config/read', 'session/start', 'turn/submit'], 'idle admission closes, rereads, rebuilds, and only then starts inference');
    assertDeepEqual(snapshots, ['unelevated', 'elevated'], 'the replacement startup consumes the newly read Windows configuration');
    assertEqual(state.liveSession('windows-thread'), 'windows-rebuilt', 'the next turn owns the replacement engine session');
    assertEqual(state.isStale('windows-thread'), false, 'only the replacement binding clears the old structural fence');
    assertEqual(rowAt(client.sentSubmit('start-if-idle'), 0, 'next Windows turn').sessionId, 'windows-rebuilt', 'no turn reaches the old Windows capture');
  } finally { await service.shutdown(); }
});

for (const resumed of [false, true]) h.test(`${resumed ? 'resumed' : 'new'} configured full-access sessions start with bypass execution`, async () => {
  const root = byoRoot(), client = new FakeClient()
    .reply('config/read', { values: {}, resolved: { approval_policy: 'never', sandbox_mode: 'danger-full-access', approvals_reviewer: 'user' }, sources: {} })
    .reply('session/start', { sessionId: 'full-access-live' });
  const { service } = serviceWith(client, root);
  if (resumed) applySessionRuntimePolicy('full-access-thread', { policy: { ...presetRuntimePolicy('bypassPermissions') } }, root);
  try {
    if (resumed) await service.resolveLiveSession('full-access-thread');
    else await service.newSession();
    const started = rowAt(client.sent('session/start'), 0, 'full-access start'), init = object(started.init)!;
    const config = object(init.config)!;
    assertEqual(Object.hasOwn(init, 'permissionMode'), false, 'only canonical policies reach tool permission evaluation');
    assertEqual(config.approval_policy, 'never', 'full access does not request approval');
    assertEqual(config.sandbox_mode, 'danger-full-access', 'the filesystem policy remains unrestricted');
    assertEqual(init.networkAllowed, true, 'the network policy remains unrestricted');
    assertEqual(started.resume, resumed ? 'full-access-thread' : null, 'the startup path retains its session identity');
  } finally { await service.shutdown(); }
});

h.test('native preparation projects startup and each bound turn while preserving every original frozen policy', async () => {
  const cases: Array<{ policy: RuntimePolicy; permissionMode: string; implicitAccess: string }> = [
    { policy: presetRuntimePolicy('bypassPermissions'), permissionMode: 'bypassPermissions', implicitAccess: 'live' },
    { policy: presetRuntimePolicy('auto'), permissionMode: 'auto', implicitAccess: 'cached' },
    { policy: { approvalPolicy: 'on-request', sandboxMode: 'read-only', approvalsReviewer: 'user', sandboxNetworkAllowed: true }, permissionMode: 'default', implicitAccess: 'cached' },
  ];
  for (const { policy, permissionMode, implicitAccess } of cases) for (const access of [undefined, 'live', 'cached', 'disabled']) {
    const root = byoRoot(), client = new FakeClient()
      .reply('config/read', { values: {}, resolved: { approval_policy: 'on-request', sandbox_mode: 'workspace-write', ...(access === undefined ? {} : { webSearch: { access } }) }, sources: {} })
      .reply('engine/windowsSandboxReadiness', { status: 'notConfigured' })
      .reply('session/start', { sessionId: 'windows-bound' }).reply('session/close', {})
      .reply('session/setRuntimePolicy', {}).replySubmit('start-if-idle', 'windows-turn')
      .replyAcknowledged('session/updateConfig', { [goalReadLifecycle.runtimeConfigOutcomeField]: {} });
    const projection = new WindowsRuntimePolicyProjection({ isNativeLocal: id => id === 'chosen', request: (method, params) => client.requestWithTimeout(method, params) });
    const { service, state } = serviceWith(client, root, undefined, { runtimePolicyProjection: projection });
    applySessionRuntimePolicy('chosen', { policy: { ...policy } }, root);
    const saved = JSON.stringify(sessionRuntimePolicy('chosen', root));
    state.rememberSession('other', 'other-live', {});
    try {
      await service.resolveLiveSession('chosen');
      const init = rowAt(client.sent('session/start'), 0, 'projected start').init as Record<string, Json>, config = init.config as Record<string, Json>;
      assertDeepEqual({ approvalPolicy: config.approval_policy, sandboxMode: config.sandbox_mode, approvalsReviewer: config.approvals_reviewer, networkAllowed: init.networkAllowed },
        { approvalPolicy: 'on-request', sandboxMode: 'read-only', approvalsReviewer: 'user', networkAllowed: false }, 'startup uses the complete temporary read-only tuple');
      assertEqual(object(config.webSearch)?.access, access ?? 'cached', 'startup derives freshness from effective isolation without losing explicit intent');
      const capturedRoots = [...state.hostWritableRoots('chosen')];
      assert(capturedRoots.length > 0, 'host resource ownership remains captured independently');
      assertEqual(JSON.stringify(sessionRuntimePolicy('chosen', root)), saved, 'startup never freezes the temporary policy');
      client.reply('engine/windowsSandboxReadiness', { status: 'updateRequired' });
      await service.send('chosen', { text: 'Constrained turn' });
      const temporary = rowAt(client.sent('session/setRuntimePolicy'), 0, 'temporary admission');
      assertDeepEqual(temporary, { sessionId: 'windows-bound', approvalPolicy: 'on-request', sandboxMode: 'read-only', approvalsReviewer: 'user', networkAllowed: false }, 'an already-bound writer is projected again at admission');
      assert(client.calls.findIndex(call => call.method === 'session/setRuntimePolicy') < client.calls.findIndex(call => call.method === 'turn/submit' && (call.params as Record<string, Json>).mode === 'start-if-idle'), 'the effective policy reaches the engine before inference');
      assertDeepEqual(rowAt(client.sent('session/updateConfig'), 0, 'temporary search').update, { webSearchAccess: access ?? 'cached' }, 'temporary admission confirms derived or explicit freshness');
      state.clearTurnRunning('chosen');
      client.reply('engine/windowsSandboxReadiness', { status: 'ready' });
      await service.send('chosen', { text: 'Restored turn' });
      const restored = rowAt(client.sent('session/setRuntimePolicy'), 1, 'restored admission');
      assertDeepEqual(restored, { sessionId: 'windows-bound',
        approvalPolicy: policy.approvalPolicy, sandboxMode: policy.sandboxMode, approvalsReviewer: policy.approvalsReviewer, networkAllowed: policy.sandboxNetworkAllowed }, 'ready admission restores the exact frozen fields, including a read-only network grant');
      assertDeepEqual(rowAt(client.sent('session/updateConfig'), 1, 'restored search').update, { webSearchAccess: access ?? implicitAccess }, 'ready admission restores implicit freshness and preserves explicit intent');
      assertEqual(JSON.stringify(sessionRuntimePolicy('chosen', root)), saved, 'every original policy remains byte-stable in storage');
      assertDeepEqual(state.hostWritableRoots('chosen'), capturedRoots, 'projection never rewrites captured host resources');
      assert(client.sent('session/setRuntimePolicy').every(raw => object(raw)?.sessionId === 'windows-bound'), 'no other conversation is republished');
      assertEqual(client.sent('session/start').length, 1, 'readiness does not replace a healthy writer');
      assertEqual(client.sent('config/batchWrite').length, 0, 'no projection writes configuration');
    } finally { await service.shutdown(); }
  }
});

h.test('an unconfirmed effective search update prevents admission without rewriting the saved permission policy', async () => {
  const root = byoRoot(), client = new FakeClient().reply('config/read', { values: {}, resolved: {}, sources: {} })
    .reply('engine/windowsSandboxReadiness', { status: 'notConfigured' }).reply('session/start', { sessionId: 'search-unconfirmed' })
    .reply('session/setRuntimePolicy', {}).reply('session/close', {}).failWith('session/updateConfig');
  const projection = new WindowsRuntimePolicyProjection({ isNativeLocal: () => true, request: (method, params) => client.requestWithTimeout(method, params) });
  const { service } = serviceWith(client, root, undefined, { runtimePolicyProjection: projection });
  applySessionRuntimePolicy('thread', { policy: { ...presetRuntimePolicy('bypassPermissions') } }, root);
  const saved = JSON.stringify(sessionRuntimePolicy('thread', root));
  try {
    const error = await assertRejects(() => service.send('thread', { text: 'Wait for the confirmed configuration' }), 'search publication failure must reach admission');
    assert(String(error).includes('session/updateConfig'), 'the actual configuration failure is propagated');
    assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no turn starts before the existing configuration acknowledgment');
    assertEqual(JSON.stringify(sessionRuntimePolicy('thread', root)), saved, 'failed temporary publication never rewrites the saved selection');
  } finally { await service.shutdown(); }
});

h.test('folding a sidebar group or section never marks a live session stale', async () => {
  // A sidebar collapse write goes through settings:kv:set, which calls
  // configuration.settingsChanged(key). A non-exempt key marks every binding
  // stale, so the next session call would session/close + rebuild — side tasks
  // included, whose open panel rebuilds in place. Both sidebar rows are pure UI
  // chrome and must stay exempt. The literals are asserted so the contract
  // cannot drift from contracts/sidebar-collapse.ts.
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  const configuration = new SessionConfiguration({ state, configRoot: root, request: (method, params) => service.request(method, params), log: () => {} });
  await service.resolveLiveSession('thread');
  assertEqual(state.isStale('thread'), false, 'the session starts live');
  for (const key of ['sidebar.sections_collapsed', 'sidebar.project_expanded']) configuration.settingsChanged(key);
  assertEqual(state.isStale('thread'), false, 'a sidebar collapse write does not close a live session');
  assertEqual(client.sent('session/close').length, 0, 'no teardown was scheduled by a UI-only key');
});

h.test('acknowledging a feature-discovery hint never marks a live session stale', async () => {
  // The discovery ledger is written by ARRIVING at a screen, so this key moves on
  // exactly the click where the user is looking at a new feature. A non-exempt
  // write would mark every binding stale and rebuild the session on their next
  // message — side tasks included — which makes the hint cost the user their
  // conversation. The literals are asserted so
  // the exemption cannot drift from contracts/feature-onboarding.ts.
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  const configuration = new SessionConfiguration({ state, configRoot: root, request: (method, params) => service.request(method, params), log: () => {} });
  await service.resolveLiveSession('thread');
  assertEqual(state.isStale('thread'), false, 'the session starts live');
  for (const key of FEATURE_ONBOARDING_UI_STATE_KEYS) configuration.settingsChanged(key);
  assertEqual(state.isStale('thread'), false, 'a discovery-hint write does not close a live session');
  assertEqual(client.sent('session/close').length, 0, 'no teardown was scheduled by a UI-only key');
  // Deep comparison: assertEqual is referential, and two arrays holding the same
  // row names are still different objects.
  assertDeepEqual([...FEATURE_ONBOARDING_UI_STATE_KEYS], ['onboarding.feature_seen', 'onboarding.guide_seen', 'appearance.reading_mode'], 'the exempt rows are the ones the renderer writes');
});

h.test('retired model sources cannot replace a live BYO session or its saved preference', async () => {
  const root = byoRoot(), client = modelChangeClient(), { service, state } = serviceWith(client, root);
  await service.resolveLiveSession('thread'); const previous = state.sessionProvider('thread');
  const saved = resolveSessionAuth('thread', root);
  for (const source of ['klaus', 'local']) {
    for (const [mode, code] of [[`${source}:fixture`, 'BAD_REQUEST'], ['custom:fixture', 'INVALID_MODEL_SOURCE']] as const) {
      const failed = await assertRejects(async () => setSessionModel('thread', mode, source, root), 'retired source');
      assertEqual((failed as { code: string }).code, code, 'the retired mode or source is rejected before persistence');
      assertDeepEqual(resolveSessionAuth('thread', root), saved, 'the saved choice remains unchanged');
    }
  }
  assertDeepEqual(state.sessionProvider('thread'), previous, 'old BYO source remains the confirmed provider');
  assertEqual(client.sent('session/reconfigureModel').length, 0, 'no retired provider was installed');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no inference was submitted');
  await service.shutdown();
});

h.test('hosted messaging reserves admission before input preparation and releases only its terminal turn', async () => {
  const root = byoRoot(), client = new FakeClient();
  let releaseInput!: () => void, inputStarted = false;
  const { service, state, pushed } = serviceWith(client, root, undefined, { messageInput: async text => {
    if (text === 'inbound') { inputStarted = true; await new Promise<void>(resolve => { releaseInput = resolve; }); }
    return [{ type: 'text', text }];
  } });
  await service.client(); state.rememberSession('thread', 'live', {}, { source: 'custom', selection: 'custom:fixture' });
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method === 'turn/submit' && (params as Record<string, Json>).mode === 'start-if-idle') client.reply(method, acceptedTurnInput(params, 'ordinary-turn'));
    return original(method, params);
  };
  const first = service.sendAndWait('thread', { text: 'inbound' });
  await waitFor(() => inputStarted, 1000, 'input is preparing');
  await assertRejects(() => service.sendAndWait('thread', { text: 'duplicate' }), 'duplicate hosted reservation');
  await assertRejects(() => service.send('thread', { text: 'UI turn' }), 'ordinary send cannot take the reserved slot');
  releaseInput(); await waitFor(() => client.sentSubmit('start-if-idle').length === 1, 1000, 'one turn admitted');
  const start = rowAt(client.sentSubmit('start-if-idle'), 0, 'start'), id = String(start.submissionId);
  assertEqual(start.sessionId, 'live', 'same engine session');
  assert(id.startsWith('channel-'), 'host chooses correlation before submitting');
  client.emit('event', { type: 'productEvent', method: 'item/completed', params: { sessionId: 'live', submissionId: id, item: { type: 'agent_message', text: 'reply' } } });
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: id, result: {} } });
  assertDeepEqual(await first, { reply: 'reply' }, 'hosted final reply');
  assertEqual(pushed.filter(event => (event as Record<string, Json>).type === 'user_message').length, 1, 'one visible incoming message');
  assertEqual(state.isWorking('thread'), false, 'terminal clears only the owned running state');
  await service.shutdown();
});

h.test('friend delegation persists status and origin metadata on the engine turn and live user frame', async () => {
  const root = byoRoot(), client = new FakeClient().reply('engine/readSessionSummary', { session: { id: 'thread' } });
  const { service, state, pushed } = serviceWith(client, root);
  await service.client(); state.rememberSession('thread', 'live', {}, { source: 'custom', selection: 'custom:fixture' });
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method === 'turn/submit' && (params as Record<string, Json>).mode === 'start-if-idle') client.reply(method, acceptedTurnInput(params, 'ordinary-turn'));
    return original(method, params);
  };
  const sender = { userId: 'peer', displayName: 'Peer', friendshipId: 'friendship' };
  const result = await service.deliverDelegation('thread', { text: 'Host status envelope', displayText: 'Task declined', external: true,
    sender, replyToRequestId: 'origin', requestCreatedAt: 1234, friendStatus: 'rejected', statusDetail: 'Task declined' });
  assertEqual(result.ok, true, 'the existing delivery route admits the reply');
  const metadata = { externalFriendMessage: true, displayText: 'Task declined', sender, replyToRequestId: 'origin', requestCreatedAt: 1234, friendStatus: 'rejected', statusDetail: 'Task declined' };
  const start = rowAt(client.sentSubmit('start-if-idle'), 0, 'friend reply start');
  assertDeepEqual(object(start.options)?.displayMetadata, metadata, 'engine persistence retains local display fields');
  const frame = pushed.filter(event => (event as Record<string, Json>).type === 'user_message')[0] as Record<string, Json>;
  assertDeepEqual(object(object(frame.message)?.message)?.localRender, metadata, 'the live row retains the same fields');
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: start.submissionId, result: {} } });
  await service.shutdown();
});

h.test('hosted messaging pushes the display snapshot with the admitted user frame', async () => {
  const root = byoRoot(), client = new FakeClient();
  const { service, state, pushed } = serviceWith(client, root);
  await service.client(); state.rememberSession('thread', 'live', {}, { source: 'custom', selection: 'custom:fixture' });
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method === 'turn/submit' && (params as Record<string, Json>).mode === 'start-if-idle') client.reply(method, acceptedTurnInput(params, 'ordinary-turn'));
    return original(method, params);
  };
  const turn = service.sendAndWait('thread', { text: 'envelope body', displayMetadata: { externalFriendMessage: true, displayText: 'Sender: hello' } });
  await waitFor(() => client.sentSubmit('start-if-idle').length === 1, 1000, 'turn admitted');
  const start = rowAt(client.sentSubmit('start-if-idle'), 0, 'start');
  assertDeepEqual(object(start.options)?.displayMetadata, { externalFriendMessage: true, displayText: 'Sender: hello' }, 'the engine receives the snapshot for its metadata row');
  const id = String(start.submissionId);
  client.emit('event', { type: 'productEvent', method: 'item/completed', params: { sessionId: 'live', submissionId: id, item: { type: 'agent_message', text: 'reply' } } });
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: id, result: {} } });
  await turn;
  const frame = pushed.filter(event => (event as Record<string, Json>).type === 'user_message').map(event => event as Record<string, Json>)[0]!;
  const inner = object(object(frame.message)?.message) ?? {};
  assertEqual(inner.content, 'envelope body', 'the model-facing text still rides the frame');
  assertDeepEqual(inner.localRender, { externalFriendMessage: true, displayText: 'Sender: hello' }, 'the live bubble renders the snapshot, not the envelope');
  await service.shutdown();
});

h.test('hosted messaging cancellation cannot release the next turn on an interrupt ACK', async () => {
  const root = byoRoot(), client = new FakeClient(), { service, state } = serviceWith(client, root);
  await service.client(); state.rememberSession('thread', 'live', {});
  client.reply('turn/interrupt', {});
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method === 'turn/submit' && (params as Record<string, Json>).mode === 'start-if-idle') client.reply(method, acceptedTurnInput(params, 'ordinary-turn'));
    return original(method, params);
  };
  const controller = new AbortController(), reply = service.sendAndWait('thread', { text: 'message' }, controller.signal); void reply.catch(() => {});
  await waitFor(() => client.sentSubmit('start-if-idle').length === 1, 1000, 'started');
  controller.abort(new Error('channel disconnected'));
  await waitFor(() => client.sent('turn/interrupt').length === 1, 1000, 'interrupt ACK');
  await assertRejects(() => service.send('thread', { text: 'new turn' }), 'reservation remains after interrupted UI state');
  const id = rowAt(client.sentSubmit('start-if-idle'), 0, 'start').submissionId;
  assertDeepEqual(client.sent('turn/interrupt'), [{ sessionId: 'live', origin: 'targeted-turn', expectedTurnId: id }], 'hosted cancellation fences its actual start reservation without reusing the control correlation');
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: id, result: {} } });
  await assertRejects(() => reply, 'cancelled reply is not sent');
  const againController = new AbortController(); againController.abort();
  const error = await assertRejects(() => service.sendAndWait('thread', { text: 'again' }, againController.signal), 'already cancelled next request');
  assertEqual((error as { name: string }).name, 'AbortError', 'previous reservation was released');
  await service.shutdown();
});

h.test('hosted messaging cannot bypass an unavailable engine model provider', async () => {
  const root = freshRoot(), client = new FakeClient().failWith('model/selection/resolve'), { service, state } = serviceWith(client, root);
  const failure = await assertRejects(() => service.sendAndWait('thread', { text: 'request' }), 'unavailable provider');
  assertEqual((failure as { code?: string }).code, 'MODEL_PROVIDER_UNAVAILABLE', 'the resolver refusal reaches the channel caller');
  assertEqual(client.sent('session/start').length, 0, 'no unavailable session was started');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'channel origin does not bypass provider resolution');
  assertEqual(state.liveSession('thread'), undefined, 'the failed request has no live binding');
  await service.shutdown();
});

h.test('confirmed session deletion cascades stored preferences and legacy sidecars while retaining its workspace by default', async () => {
  const root = byoRoot(), client = new FakeClient().replyAcknowledged('session/deleteSession', { deleted: { threadId: 'thread', deleted: true } });
  const { service } = serviceWith(client, root);
  setSessionModel('thread', 'custom:fixture', 'custom', root); bindSessionWorkdir('thread', join(root, 'bound-project'), root);
  const project = join(root, 'projects', 'old-project'), scratch = join(root, 'sessions', 'thread'); mkdirSync(project, { recursive: true }); mkdirSync(scratch, { recursive: true });
  for (const suffix of ['.jsonl', '.thinking.json', '.session-meta.json']) writeFileSync(join(project, 'thread' + suffix), 'old');
  writeFileSync(join(project, 'retained.jsonl'), 'other thread'); writeFileSync(join(scratch, 'owned.txt'), 'keep workspace');
  await service.deleteSession('thread');
  assertEqual(readFileSync(join(scratch, 'owned.txt'), 'utf8'), 'keep workspace', 'ordinary delete preserves generated files');
  assertEqual(readFileSync(join(project, 'retained.jsonl'), 'utf8'), 'other thread', 'other conversations remain');
  for (const suffix of ['.jsonl', '.thinking.json', '.session-meta.json']) assert(!existsSync(join(project, 'thread' + suffix)), 'the confirmed deleted thread sidecar is gone');
  assertEqual((await import('../main/services/settings')).withSettingsDb(root, db => Number(db.prepare('SELECT COUNT(*) AS count FROM session_main_models WHERE session_id=?').get('thread')?.count)), 0, 'deleted model preference is removed');
  await service.shutdown();
});
h.test('workspace deletion waits for shared resource quiescence and removes only the own scratch directory', async () => {
  const root = byoRoot(), client = new FakeClient().replyAcknowledged('session/deleteSession', { deleted: { threadId: 'thread', deleted: true } });
  let enter = false, release!: () => void, unlocked = false; const gate = new Promise<void>(resolve => { release = resolve; });
  const scratch = join(root, 'sessions', 'thread'), project = join(root, 'bound-project'); mkdirSync(scratch, { recursive: true }); mkdirSync(project);
  writeFileSync(join(scratch, 'owned.txt'), 'remove'); writeFileSync(join(project, 'keep.txt'), 'keep'); bindSessionWorkdir('thread', project, root);
  const { service } = serviceWith(client, root, undefined, { beforeRemoveWorkspace: async path => { assertEqual(path, scratch, 'only the managed scratch path is leased'); enter = true; await gate; return () => { unlocked = true; }; } });
  const deletion = service.deleteSession('thread', true); await waitFor(() => enter, 2000, 'quiescence requested');
  assertEqual(client.sent('session/deleteSession').length, 0, 'engine history is retained while native writers drain'); assert(existsSync(scratch), 'scratch is retained while in use');
  release(); await deletion;
  assert(!existsSync(scratch), 'owned scratch directory removed after confirmed engine deletion'); assertEqual(readFileSync(join(project, 'keep.txt'), 'utf8'), 'keep', 'a bound project is never a checkbox deletion target');
  assert(unlocked, 'resource lease released after removal'); await service.shutdown();
});
h.test('refused engine deletion and substituted scratch links preserve local files and metadata', async () => {
  const root = byoRoot(), client = new FakeClient().replyAcknowledged('session/deleteSession', { deleted: false, error: 'writer is locked' });
  const scratch = join(root, 'sessions', 'thread'), outside = freshRoot(); mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'own.txt'), 'preserved');
  setSessionModel('thread', 'custom:fixture', 'custom', root); let released = false;
  const { service } = serviceWith(client, root, undefined, { beforeRemoveWorkspace: async () => () => { released = true; } });
  await assertRejects(() => service.deleteSession('thread', true), 'engine refused to release its writer');
  assert(existsSync(join(scratch, 'own.txt')), 'workspace retained after engine refusal'); assert(released, 'failed operation releases its reservation');
  assertEqual((await import('../main/services/settings')).withSettingsDb(root, db => Number(db.prepare('SELECT COUNT(*) AS count FROM session_main_models WHERE session_id=?').get('thread')?.count)), 1, 'unconfirmed deletion retains model preference');
  rmSync(scratch, { recursive: true }); writeFileSync(join(outside, 'keep.txt'), 'outside'); symlinkSync(outside, scratch, 'dir');
  const calls = client.calls.length; await assertRejects(() => service.deleteSession('thread', true), 'substituted workspace cannot be deleted');
  assertEqual(client.calls.length, calls, 'unsafe scratch is rejected before deleting engine history'); assertEqual(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside', 'symlink target preserved');
  await assertRejects(() => service.deleteSession('../escape', true), 'path-like identity rejected'); await service.shutdown();
});

h.test('only a matching confirmed engine deletion authorizes local metadata and workspace removal', async () => {
  const root = byoRoot(), scratch = join(root, 'sessions', 'thread'), project = join(root, 'projects', 'old-project');
  mkdirSync(scratch, { recursive: true }); mkdirSync(project, { recursive: true });
  writeFileSync(join(scratch, 'keep.txt'), 'keep'); writeFileSync(join(project, 'thread.jsonl'), 'history');
  setSessionModel('thread', 'custom:fixture', 'custom', root);
  const client = new FakeClient(); let released = 0;
  const { service } = serviceWith(client, root, undefined, { beforeRemoveWorkspace: async () => () => { released++; } });
  const outcomes: Json[] = [true, {}, { threadId: 'other', deleted: true }, { threadId: 'thread', deleted: false }];
  for (const outcome of outcomes) {
    client.replyAcknowledged('session/deleteSession', { deleted: outcome });
    await assertRejects(() => service.deleteSession('thread', true), 'an unrelated or incomplete result cannot authorize deletion');
    assertEqual(readFileSync(join(scratch, 'keep.txt'), 'utf8'), 'keep', 'workspace retained');
    assertEqual(readFileSync(join(project, 'thread.jsonl'), 'utf8'), 'history', 'legacy history retained');
    assertEqual((await import('../main/services/settings')).withSettingsDb(root, db => Number(db.prepare('SELECT COUNT(*) AS count FROM session_main_models WHERE session_id=?').get('thread')?.count)), 1, 'metadata retained');
  }
  assertEqual(released, 4, 'all failed removals release their shared resource lease');
  client.replyAcknowledged('session/deleteSession', { deleted: { threadId: 'thread', deleted: true } });
  await service.deleteSession('thread', true);
  assert(!existsSync(scratch), 'retry after an actual confirmation removes the workspace');
  await service.shutdown();
});

h.test('a mobile request cancelled while preparing input cannot admit a turn', async () => {
  const client = new FakeClient().reply('session/start', { sessionId: 'mobile-live' });
  let preparing = false, release!: () => void;
  const input = new Promise<void>(resolve => { release = resolve; });
  const { service, state } = serviceWith(client, byoRoot(), undefined, { messageInput: async () => { preparing = true; await input; return 'mobile text'; } });
  const row = await service.newSession() as { id: string }, signal = new AbortController();
  const sending = service.withEngineOwner(service.engine()!, signal.signal, () => service.send(row.id, { text: 'mobile text' }));
  const rejected = assertRejects(() => sending, 'cancelled input cannot be sent');
  await waitFor(() => preparing, 2000, 'input preparation entered'); signal.abort(); release(); await rejected;
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no turn was admitted after cancellation');
  assertEqual(state.isWorking(row.id), false, 'the conversation remains idle'); await service.shutdown();
});

h.test('cancellation after the engine accepted a mobile turn preserves its actual running state', async () => {
  const signal = new AbortController(), client = new FakeClient().reply('session/start', { sessionId: 'mobile-live' }).replySubmit('start-if-idle', 'accepted-mobile-turn');
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => { const result = await original(method, params); if (method === 'turn/submit' && (params as Record<string, Json>).mode === 'start-if-idle') signal.abort(); return result; };
  const { service, state } = serviceWith(client, byoRoot()); const row = await service.newSession() as { id: string };
  await assertRejects(() => service.withEngineOwner(service.engine()!, signal.signal, () => service.send(row.id, { text: 'admitted mobile text' })), 'the cancelled caller gets no success');
  assertEqual(state.runningTurnId(row.id), object(client.sentSubmit('start-if-idle')[0])?.submissionId, 'an accepted turn is still tracked by the shared desktop owner');
  assertEqual(state.isWorking(row.id), true, 'disconnecting the phone cannot manufacture a completed turn'); await service.shutdown();
});

h.test('a stale mobile scope cannot attach a replacement engine after an await', async () => {
  let attaches = 0;
  const old = new FakeClient(), replacement = new FakeClient();
  const { service } = serviceWith(old, byoRoot(), undefined, { manager: {
    attach: async () => ({ client: ++attaches === 1 ? old : replacement, generation: attaches }), shutdownAll: async () => {},
  } });
  await service.client(); const owner = service.engine()!;
  old.closed = true;
  await assertRejects(() => service.client(), 'the ordinary caller observes connection loss');
  await assertRejects(() => service.withEngineOwner(owner, new AbortController().signal, () => service.request('config/read', {})), 'the old phone request cannot retry into a new owner');
  assertEqual(attaches, 1, 'no replacement was spawned for a stale request');
  assertEqual(await service.client(), replacement, 'a fresh desktop request can attach normally'); await service.shutdown();
});

h.test('accepted content generates once at the first turn and persists one generated title', async () => {
  const root = byoRoot(), client = new FakeClient()
    .replySubmit('start-if-idle', 'turn-title')
    .reply('engine/listSessions', { sessions: { items: [{ id: 'thread', title: 'New Chat' }] } })
    .reply('engine/readSessionSummary', { session: { id: 'thread', title: 'New Chat' } })
    .reply('session/generateTitle', { generatedTitle: { threadId: 'thread', title: { title: 'Generated conversation title', persisted: false } } })
    .reply('session/updateTitle', { title: { threadId: 'thread', title: 'Generated conversation title' } });
  const { service, state, pushed } = serviceWith(client, root);
  await service.client(); state.rememberSession('thread', 'live', {});
  await service.send('thread', { text: 'First content in this conversation' });
  assertEqual(rowAt(await service.listSessions(), 0, 'untitled sidebar').title, 'New Chat', 'accepted content never publishes a placeholder');
  assertEqual(readSessionTitle('thread', root), undefined, 'accepted content writes no title record');
  client.emit('event', { type: 'productEvent', method: 'turn/started', params: { sessionId: 'live', turnId: 'turn-title' } });
  await waitFor(() => readSessionTitle('thread', root)?.source === 'ai', 1000, 'the first turn generates and persists one title');
  const terminal = { type: 'turnCompleted' as const, params: { sessionId: 'live', turnId: 'turn-title', result: { stopReason: 'completed', finalText: 'Done.' } } };
  client.emit('event', terminal);
  await waitFor(() => readSessionTitle('thread', root)?.source === 'ai', 1000, 'generated title is acknowledged and persisted');
  client.emit('event', terminal);
  assertEqual(rowAt(await service.listSessions(), 0, 'generated sidebar').title, 'Generated conversation title', 'the list retains the generated title');
  assertEqual(client.sent('session/generateTitle').length, 1, 'duplicate completion cannot generate again');
  assertDeepEqual(pushed.filter(value => (value as Record<string, Json>).type === 'session_title_updated'), [
    { type: 'session_title_updated', sessionId: 'thread', title: 'Generated conversation title' },
  ], 'the generated title updates the existing sidebar row');
  await service.shutdown();
});

h.test('a friend dispatch generates its title from the accepted send like a local first turn', async () => {
  const root = byoRoot(), client = new FakeClient()
    .reply('engine/listSessions', { sessions: { items: [{ id: 'thread', title: 'New Chat' }] } })
    .reply('engine/readSessionSummary', { session: { id: 'thread', title: 'New Chat' } })
    .reply('session/generateTitle', { generatedTitle: { threadId: 'thread', title: { title: '查询电脑配置', persisted: false } } })
    .reply('session/updateTitle', { title: { threadId: 'thread', title: '查询电脑配置' } });
  let dispatchSawRecord = false;
  const logs: string[] = [];
  const { service, state } = serviceWith(client, root, undefined, {
    friendDispatch: async () => {
      dispatchSawRecord = readSessionTitle('thread', root) === undefined;
      return true;
    },
    log: (kind, detail) => logs.push(`${kind}: ${detail}`),
  });
  await service.client(); state.rememberSession('thread', 'live', {});
  const mention = '@friend-2158597b-d2f5-48a9-a883-4d7f809de5aa';
  await service.send('thread', {
    text: `${mention} 你电脑配置是什么`,
    displayMetadata: {
      displayText: `${mention} 你电脑配置是什么`,
      composerReferences: [{ kind: 'friend', id: '2158597b-d2f5-48a9-a883-4d7f809de5aa' }],
    },
  });
  assert(dispatchSawRecord, 'delivery starts with no published title');
  await waitFor(() => readSessionTitle('thread', root)?.source === 'ai', 2000, `friend dispatch generates its title; logs=${logs.join(' | ')}; calls=${JSON.stringify(client.sent('session/generateTitle'))}`);
  const generation = object(client.sent('session/generateTitle')[0]);
  assert(String(generation?.prompt).includes('你电脑配置是什么'), 'the human message is the title input');
  assert(!String(generation?.prompt).includes('@friend-'), 'the friend routing token is stripped');
  await service.shutdown();
});

h.test('an appended friend message titles its conversation without a turn, past the friend name placeholder', async () => {
  const root = byoRoot(), client = new FakeClient()
    .reply('engine/readSessionSummary', { session: { id: 'thread', title: 'Nick', hostMetadata: { friend: { friendshipId: 'f1', userId: 'u1', displayName: 'Nick' } } } })
    .reply('session/appendDisplayMessage', { appended: true })
    .reply('session/generateTitle', { generatedTitle: { threadId: 'thread', title: { title: '约周末爬山', persisted: false } } })
    .reply('session/updateTitle', { title: { threadId: 'thread', title: '约周末爬山' } });
  const logs: string[] = [];
  const { service, state } = serviceWith(client, root, undefined, { log: (kind, detail) => logs.push(`${kind}: ${detail}`) });
  await service.client(); state.rememberSession('thread', 'live', {});
  // A status note this computer wrote is not the conversation's words.
  await service.appendDisplayMessage('thread', 'friend-moved-x', '<friend-status about="Nick" at="21:00">\nmoved\n</friend-status>', { externalFriendMessage: true, friendStatus: 'moved', displayText: 'moved' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assertEqual(client.sent('session/generateTitle').length, 0, 'a status note starts no title request');
  await service.appendDisplayMessage('thread', 'friend-message-1', '<friend-message from="Nick" purpose="notice" at="21:05">\n周末一起爬山吗\n</friend-message>',
    { externalFriendMessage: true, friendIntent: 'notice', displayText: '周末一起爬山吗', sender: { displayName: 'Nick' } });
  await waitFor(() => readSessionTitle('thread', root)?.source === 'ai', 2000, `appended message generates a title; logs=${logs.join(' | ')}`);
  const prompt = String(object(client.sent('session/generateTitle')[0])?.prompt);
  assert(prompt.includes('周末一起爬山吗'), 'the written words are the title input');
  assert(!prompt.includes('friend-message') && !prompt.includes('Nick'), 'the friend tags are not title input');
  assertEqual(client.sent('session/generateTitle').length, 1, 'one generation attempt');
  await service.shutdown();
});

h.test('setup lifecycle reconciliation announces unhappy terminal setup once per process', async () => {
  assertDeepEqual(setupLifecycleNotices(recoveryVectors.setupLifecycle.reply, 'thread'), [recoveryVectors.setupLifecycle.notice], 'only an unhappy terminal setup becomes a warning');

  const root = byoRoot(), client = new FakeClient()
    .reply('session/start', { sessionId: 'setup-live' })
    .reply('session/setupLifecycle', { setupLifecycle: { idempotencyResults: {
      bad: { requestId: 'req-bad', status: 'persistence_failed', error: 'disk' },
    } } });
  const { service, pushed } = serviceWith(client, root);
  const row = await service.newSession() as Record<string, Json>;
  const id = String(row.id);
  await waitFor(() => pushed.some(value => object(value)?.content === 'setup req-bad: persistence_failed (disk)'), 1000, 'activation setup warning');
  client.reply('engine/listSessions', { sessions: { items: [{ id, title: 'Existing title' }], nextCursor: null } });
  client.reply('engine/readSessionSummary', { session: { id, title: 'Existing title' } });
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'setup-live', turnId: 'turn', result: { stopReason: 'completed', finalText: 'Done' } } });
  await waitFor(() => client.sent('session/setupLifecycle').length === 2, 1000, 'post-turn setup reconciliation');
  assertEqual(pushed.filter(value => object(value)?.content === 'setup req-bad: persistence_failed (disk)').length, 1, 'the replayed snapshot does not duplicate its warning');
  assertEqual(object(pushed.find(value => object(value)?.content === 'setup req-bad: persistence_failed (disk)'))?.sessionId, id, 'the warning targets the renderer conversation identity');
  await service.shutdown();
});

h.test('a stopped turn never generates a title and an acknowledged rename survives a stale engine list', async () => {
  const root = byoRoot(), client = new FakeClient()
    .reply('engine/listSessions', { sessions: { items: [{ id: 'thread', title: 'New Chat' }] } })
    .reply('session/updateTitle', { title: { threadId: 'thread', title: 'My conversation' } });
  const { service, state } = serviceWith(client, root);
  await service.client(); state.rememberSession('thread', 'live', {});
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'stopped', result: { stopReason: 'aborted' } } });
  await service.rename('thread', 'My conversation');
  assertEqual(readSessionTitle('thread', root)?.source, 'custom', 'manual title provenance is durable');
  assertEqual(rowAt(await service.listSessions(), 0, 'renamed sidebar').title, 'My conversation', 'a stale list cannot replace the user title');
  assertEqual(client.sent('session/generateTitle').length, 0, 'stopping never starts title inference');
  await service.shutdown();
});

// ---------------------------------------------------------------------------
// 9. The client-owned follow-up queue: dispatch after a completed turn, pause
//    after an interruption.
//
// This is the half of the queue that is NOT durable storage (client-queue.test.ts
// covers that). What is pinned here is the routing in `afterTurnTerminal`, where
// the host decides whether a terminal event drains the queue or pauses it. The bug
// it guards against is real and was shipped once during this work: a user stop
// arrives as `turnCompleted` with `stopReason: "aborted"`, which reaches the router
// with `generateTitle` still true, so reading only that flag dispatched the queue
// the user had just asked to stop.
// ---------------------------------------------------------------------------

/**
 * A service whose `onEvent` is the REAL event pump, as production wires it
 * (app/runtime.ts). That matters for these tests rather than being incidental:
 * the pump's projection is what clears the running-turn state, and `send` refuses
 * a session that is still working. Without the pump the dispatch below would be
 * rejected as TURN_IN_PROGRESS and the test would measure the busy guard instead
 * of the routing it exists to pin.
 */
function queueService(client: FakeClient, root: string, overrides: Pick<SessionServiceDeps, 'messageInput' | 'runtimePolicyProjection'> = {}): { service: SessionService; state: HostState; pushed: Json[]; forwarder: ChatEventForwarder } {
  const state = new HostState();
  const pushed: Json[] = [];
  const forwarder = new ChatEventForwarder(() => {});
  let pump!: SessionEventPump;
  const manager: EngineAttacherLike = {
    attach: async () => ({ client, generation: 1 }),
    shutdownAll: async () => { client.closed = true; },
  };
  const service = new SessionService({
    manager, state,
    spawnOptions: () => ({ command: '/bin/true', args: [], env: [] }),
    pushChatEvents: events => pushed.push(...events),
    configRoot: root, ...overrides,
    onEvent: (event, generation) => pump.receive(event, generation),
  });
  pump = new SessionEventPump({ state, forwarder, emit: () => {}, currentGeneration: () => service.engine()?.generation, log: () => {} });
  return { service, state, pushed, forwarder };
}

function queueClient(): FakeClient {
  const client = new FakeClient()
    .reply('session/start', { sessionId: 'live' })
    .replySubmit('start-if-idle', 'dispatched-turn')
    .reply('session/modelRuntime', { revision: 0 })
    .reply('config/read', { resolved: { model: 'default' }, sources: { model: 'defaults' } });
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method === 'turn/submit' && (params as Record<string, Json>).mode === 'start-if-idle' && typeof obj(params).submissionId === 'string') {
      client.calls.push({ method, params }); return acceptedTurnInput(params);
    }
    return original(method, params);
  };
  return client;
}

/**
 * `object` here is the arguments.ts one, which answers `undefined` for a
 * non-object rather than `{}`. These assertions chain straight off the result, so
 * they narrow through this instead of sprinkling optional access at every step.
 */
function obj(value: unknown): Record<string, Json> {
  return object(value) ?? {};
}

/** The rows of a `clientQueueSnapshot` reply, narrowed without a blind cast. */
function queueRows(reply: Json): Json[] {
  const items = obj(obj(reply).snapshot).items;
  return Array.isArray(items) ? items : [];
}

function queueItem(text: string): Json {
  return { id: text, displayText: text, finalText: text, media: [], liveAttachments: [] };
}

async function knownBusyAutomaticQueue() {
  const client = queueClient(), root = byoRoot(), f = queueService(client, root);
  let engineIdle = false, successfulAdmissions = 0;
  client.queue.admit = async params => {
    if (!engineIdle) return { status: 'not-submitted', submissionId: params.submissionId!, reason: { code: 'not-idle', activeTurnId: 'external-lease' } };
    successfulAdmissions++; return acceptedTurnInput(params);
  };
  try {
    await f.service.resolveLiveSession('thread');
    client.queue.changed = (threadId, revision) => client.emit('event', { type: 'productEvent', method: 'thread/queue/changed', params: { threadId, revision } });
    await f.service.clientQueueAdd('thread', { id: 'known-busy', item: queueItem('Preserve known busy input'), dispatchIfIdle: true });
    await waitFor(() => {
      const latest = f.pushed.findLast(event => obj(event).type === 'client_queue_snapshot');
      const rows = obj(latest).items;
      return client.sentQueue('start-if-idle').length === 1 && Array.isArray(rows)
        && rows.some(row => obj(row).id === 'known-busy' && obj(row).dispatching !== true);
    }, 2000, 'the first definite engine busy refusal releases the automatic preparation claim');
    assertEqual(f.state.isWorking('thread'), false, 'the host is idle after definite non-admission');
    return { ...f, client, root, makeEngineIdle: () => { engineIdle = true; }, successfulAdmissions: () => successfulAdmissions };
  } catch (error) { await f.service.shutdown(); f.forwarder.close(); throw error; }
}

h.test('an automatic known-busy deferral resumes after the engine becomes idle without another event', async () => {
  const f = await knownBusyAutomaticQueue();
  try {
    const revision = f.client.queue.document('thread').revision, before = f.client.calls.length;
    // The lease becomes idle without any queue mutation or host terminal event.
    f.makeEngineIdle();
    assertEqual(f.client.queue.document('thread').revision, revision, 'releasing the external lease does not mutate queued input');
    try {
      await waitFor(() => f.successfulAdmissions() === 1 && f.client.queue.document('thread').rows.length === 0
        && f.pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 2000,
      'known-busy queued input eventually admits after the external lease is idle without a new notification');
    } catch (error) {
      throw new Error(`${String(error)}; observed=${JSON.stringify({ hostIdle: !f.state.isWorking('thread'), startAttempts: f.client.sentQueue('start-if-idle').length,
        successfulAdmissions: f.successfulAdmissions(), rows: f.client.queue.document('thread').rows.map(row => ({ id: row.clientUserMessageId, pausedReason: row.pausedReason ?? null, dispatching: row.dispatching ?? null })) })}`);
    }
    assertEqual(f.successfulAdmissions(), 1, 'only one successful admission consumes the queued instruction');
    assertEqual(f.pushed.filter(event => obj(event).type === 'queued_follow_up_dispatched').length, 1, 'one actual admission publishes one sent bubble');
    assertEqual(f.client.sentSubmit('start-if-idle').length, 0, 'automatic deferral never bypasses the atomic queue start');
    assertDeepEqual(f.client.calls.slice(before).filter(call => call.method.startsWith('thread/queue/') && !['thread/queue/list', 'thread/queue/start'].includes(call.method)), [], 'no new queue mutation supplies the missing wakeup');
  } finally { await f.service.shutdown(); f.forwarder.close(); }
});

h.test('Stop and closing prevent a known-busy automatic deferral from retrying', async () => {
  for (const fence of ['stop', 'closing'] as const) {
    const f = await knownBusyAutomaticQueue(); let releaseClose: (() => void) | undefined, closing: Promise<() => void> | undefined;
    try {
      if (fence === 'stop') {
        f.state.markTurnRunning('thread', 'stop-owner');
        assertEqual(obj(await f.service.interrupt('thread')).accepted, true, 'the actual Stop operation is accepted');
        f.client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'stop-owner', result: { stopReason: 'aborted' } } });
        assertEqual(obj(obj(await f.service.clientQueueSnapshot('thread')).snapshot).interrupted, true, 'Stop durably pauses the deferred input');
      } else {
        f.client.reply('session/close', {});
        const original = f.client.requestWithTimeout.bind(f.client); let entered = false;
        f.client.requestWithTimeout = async (method, params) => {
          if (method === 'session/close') { entered = true; await new Promise<void>(resolve => { releaseClose = resolve; }); }
          return original(method, params);
        };
        closing = f.service.quiesceDirectory(await f.service.directory('thread')); void closing.catch(() => {});
        await waitFor(() => entered && f.service.isSessionClosing('thread'), 2000, 'the real close holds the thread admission fence');
      }
      f.makeEngineIdle(); await new Promise(resolve => setTimeout(resolve, 2000));
      assertEqual(f.client.sentQueue('start-if-idle').length, 1, `${fence} prevents another queue admission attempt`);
      assertEqual(f.successfulAdmissions(), 0, `${fence} cannot issue the retained input`);
      assertEqual(f.client.queue.document('thread').rows[0]?.clientUserMessageId, 'known-busy', `${fence} keeps the original queued instruction`);
    } finally {
      releaseClose?.(); const release = await closing?.catch(() => undefined); release?.();
      await f.service.shutdown(); f.forwarder.close();
    }
  }
});

h.test('an automatic unknown admission never retries when the engine later becomes idle', async () => {
  const client = queueClient(), { service, state, pushed, forwarder } = queueService(client, byoRoot());
  let engineIdle = false, successfulAdmissions = 0;
  client.queue.admit = async params => {
    if (!engineIdle) throw { kind: 'timeout', method: 'thread/queue/start' };
    successfulAdmissions++; return acceptedTurnInput(params);
  };
  try {
    await service.resolveLiveSession('thread');
    client.queue.changed = (threadId, revision) => client.emit('event', { type: 'productEvent', method: 'thread/queue/changed', params: { threadId, revision } });
    await service.clientQueueAdd('thread', { id: 'unknown-auto', item: queueItem('Unknown automatic input'), dispatchIfIdle: true });
    await waitFor(() => pushed.some(event => obj(event).type === 'client_queue_snapshot' && Array.isArray(obj(event).items)
      && (obj(event).items as Json[]).some(row => obj(row).id === 'unknown-auto' && obj(row).unconfirmed === true)), 2000, 'the issued admission settles as unknown');
    const saved = structuredClone(client.queue.document('thread').rows), workingBefore = state.isWorking('thread');
    engineIdle = true; await new Promise(resolve => setTimeout(resolve, 2000));
    assertEqual(state.isWorking('thread'), workingBefore, 'an unobserved external lease change does not reinterpret unknown admission state');
    assertEqual(client.sentQueue('start-if-idle').length, 1, 'no timer or idle observation can reissue unknown input');
    assertEqual(successfulAdmissions, 0, 'unknown input has no fabricated success');
    assertDeepEqual(client.queue.document('thread').rows, saved, 'the exact unknown engine reservation remains saved');
    assert(!pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 'uncertainty cannot create a confirmed sent bubble');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('an external queue changed notification hydrates a cold view and dispatches idle input once', async () => {
  const client = queueClient(), { service, state, pushed, forwarder } = queueService(client, byoRoot());
  await service.client(); state.rememberSession('thread', 'live', {});
  client.queue.changed = (threadId, revision) => client.emit('event', { type: 'productEvent', method: 'thread/queue/changed', params: { threadId, revision } });
  try {
    await client.queue.request('thread/queue/add', { threadId: 'thread', clientUserMessageId: 'external-queued',
      input: [{ type: 'text', text: 'External queued input' }], clientMetadata: { item: queueItem('External queued input') } });
    await waitFor(() => pushed.some(event => obj(event).type === 'queued_follow_up_dispatched' && obj(event).id === 'external-queued'), 2000, 'external changed reaches the idle production dispatcher without a warmed view');
    assertEqual(client.sentQueue('start-if-idle').length, 1, 'one external row admits exactly one strict next turn');
    assertEqual(client.sentSubmit('start-if-idle').length, 0, 'external input never bypasses atomic queue admission');
    assertEqual(client.queue.document('thread').rows.length, 0, 'the engine consumes the external row');
    assertEqual(pushed.filter(event => obj(event).type === 'queued_follow_up_dispatched').length, 1, 'notification recursion cannot duplicate the submitted bubble');
  } finally { client.queue.changed = () => {}; await service.shutdown(); forwarder.close(); }
});

h.test('an atomic not-idle refusal retains strict queued input until the competing turn ends', async () => {
  const client = queueClient(), { service, state, pushed, forwarder } = queueService(client, byoRoot());
  let refuse = true, rejectAdmission!: () => void;
  client.queue.admit = async params => {
    if (params.mode !== 'start-if-idle' || !refuse) return acceptedTurnInput(params);
    refuse = false;
    return new Promise(resolve => { rejectAdmission = () => resolve({ status: 'not-submitted', submissionId: params.submissionId!, reason: { code: 'not-idle', activeTurnId: 'competing-turn' } }); });
  };
  try {
    await service.resolveLiveSession('thread');
    await service.clientQueueAdd('thread', { id: 'server-race', item: queueItem('Keep exact queued input'), dispatchIfIdle: true });
    await waitFor(() => typeof rejectAdmission === 'function', 1000, 'submission awaits atomic routing reply');
    client.emit('event', { type: 'productEvent', method: 'turn/started', params: { sessionId: 'live', submissionId: 'competing-turn', detail: { type: 'turn.started', turnId: 'competing-core' } } });
    rejectAdmission();
    await waitFor(async () => obj(queueRows(await service.clientQueueSnapshot('thread'))[0]).dispatching !== true, 2000, 'structured refusal releases claim');
    assertEqual(state.isWorking('thread'), true, 'refusal cannot clear the external running turn');
    assertEqual(state.runningSubmissionId('thread'), 'competing-turn', 'external facade identity survives');
    assertEqual(state.runningTurnId('thread'), 'competing-core', 'external engine identity survives');
    const row = rowAt(queueRows(await service.clientQueueSnapshot('thread')), 0, 'retained strict input');
    assertEqual(row.id, 'server-race', 'refusal preserves the row identity');
    assertEqual(obj(row.item).finalText, 'Keep exact queued input', 'refusal preserves payload');
    assert(row.pausedReason == null && row.unconfirmed !== true, 'safe busy refusal remains eligible after terminal');
    assertEqual(client.sentQueue('start-if-idle').length, 1, 'busy reply does not retry immediately');
    assertEqual(client.sentQueue('steer').length, 0, 'strict queue cannot degrade to steering');
    assert(!pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 'refusal creates no sent bubble');
    client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'competing-turn', result: { stopReason: 'completed' } } });
    await waitFor(async () => queueRows(await service.clientQueueSnapshot('thread')).length === 0, 2000, 'next terminal retries retained input once');
    assertEqual(client.sentQueue('start-if-idle').length, 2, 'one attempt after each admission opportunity');
    assertEqual(pushed.filter(event => obj(event).type === 'queued_follow_up_dispatched').length, 1, 'one admitted bubble after retry');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('a manual atomic not-idle refusal stays successfully queued without pausing or duplicating input', async () => {
  const client = queueClient(), { service, pushed, forwarder } = queueService(client, byoRoot());
  try {
    await service.resolveLiveSession('thread');
    await service.clientQueueAdd('thread', { id: 'manual-busy', item: queueItem('Preserve the manual instruction') });
    client.queue.admit = async params => ({ status: 'not-submitted', submissionId: params.submissionId!, reason: { code: 'not-idle', activeTurnId: 'external-turn' } });
    const result = obj(await service.clientQueueDeliver('thread', 'manual-busy'));
    assertEqual(result.ok, true, 'safe busy admission remains a successful queue operation');
    assertEqual(result.queued, true, 'the instruction stays owned by the engine queue');
    const retained = rowAt(queueRows(await service.clientQueueSnapshot('thread')), 0, 'manual busy row');
    assertEqual(retained.id, 'manual-busy', 'the original identity survives');
    assertEqual(obj(retained.item).finalText, 'Preserve the manual instruction', 'the exact original input survives');
    assert(retained.dispatching !== true && retained.unconfirmed !== true && retained.pausedReason == null, 'definite engine busy releases preparation without marking failure or uncertainty');
    assertEqual(client.sentQueue('start-if-idle').length, 1, 'one user activation issues one atomic attempt');
    assertEqual(client.sentSubmit('start-if-idle').length, 0, 'safe busy cannot fallback to direct admission');
    assert(!pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 'not-idle refusal draws no sent bubble');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('structured steer refusal keeps the original client queue row available for an explicit decision', async () => {
  const client = queueClient(), { service, state, pushed, forwarder } = queueService(client, byoRoot());
  client.queue.admit = async params => params.mode === 'steer'
    ? { status: 'not-submitted', submissionId: params.submissionId!, reason: { code: 'expected-turn-mismatch' } }
    : acceptedTurnInput(params);
  try {
    await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'displayed-turn');
    await service.clientQueueAdd('thread', { id: 'refused-steer', item: queueItem('Preserve original instruction') });
    const result = obj(await service.clientQueueDeliver('thread', 'refused-steer'));
    assertEqual(result.ok, false, 'structured refusal is definitive');
    const row = rowAt(queueRows(await service.clientQueueSnapshot('thread')), 0, 'retained refused steer');
    assertEqual(row.id, 'refused-steer', 'original identity survives');
    assertEqual(obj(row.item).finalText, 'Preserve original instruction', 'original payload survives');
    assert(row.dispatching !== true && row.unconfirmed !== true, 'safe refusal clears claim without uncertainty');
    assertEqual(client.sentQueue('steer').length, 1, 'one issued attempt');
    assertEqual(client.sentQueue('start-if-idle').length, 0, 'no fallback start');
    assert(!pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 'refused input has no sent bubble');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('a strict-queue admission race leaves no ghost bubble and dispatches once after the competing turn', async () => {
  let release!: () => void, held = false;
  const client = queueClient(), { service, state, pushed, forwarder } = queueService(client, byoRoot());
  await service.resolveLiveSession('thread');
  await service.clientQueueAdd('thread', { id: 'raced', item: queueItem('Queued race') });
  client.queue.beforeRequest = async method => {
    if (method !== 'thread/queue/list' || held) return;
    held = true; await new Promise<void>(resolve => { release = resolve; });
  };
  state.markTurnRunning('thread', 'previous');
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'previous', result: { stopReason: 'completed' } } });
  await waitFor(() => typeof release === 'function', 1000, 'authoritative queued input inspection waits');
  let engineTurn: string | null = 'competing';
  client.queue.admit = async params => engineTurn
    ? { status: 'not-submitted', submissionId: params.submissionId!, reason: { code: 'not-idle', activeTurnId: engineTurn } }
    : acceptedTurnInput(params);
  state.markTurnRunning('thread', 'competing'); release();
  await waitFor(async () => queueRows(await service.clientQueueSnapshot('thread')).length === 1 && obj(queueRows(await service.clientQueueSnapshot('thread'))[0]).dispatching !== true, 1000, 'busy admission releases the claim');
  assertEqual(client.sentQueue('start-if-idle').length, 0, 'the newly observed competing turn prevents an admission before issuance');
  assert(!pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 'no user bubble is drawn for a refused admission');
  engineTurn = null;
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'competing', result: { stopReason: 'completed' } } });
  await waitFor(() => pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 2000, 'the next terminal admits the queue');
  assertEqual(pushed.filter(event => obj(event).type === 'queued_follow_up_dispatched').length, 1, 'one admitted bubble is drawn');
  assertEqual(client.sentQueue('start-if-idle').length, 1, 'one later strict admission never becomes a steer');
  await service.shutdown(); forwarder.close();
});

h.test('remote queued-row steering cannot move from its displayed turn into a replacement turn', async () => {
  const { service, state, forwarder } = queueService(queueClient(), byoRoot());
  await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'core-B', 'facade-B');
  await service.clientQueueAdd('thread', { id: 'fenced', item: queueItem('Follow displayed turn') });
  assertEqual(obj(await service.clientQueueDeliver('thread', 'fenced', undefined, 'facade-A', true)).code, 'steer_turn_changed', 'stale target is refused before taking ownership');
  assertEqual(obj(await service.clientQueueDeliver('thread', 'fenced', undefined, undefined, true)).code, 'steer_turn_required', 'running remote actions require a known fence');
  assertEqual(queueRows(await service.clientQueueSnapshot('thread')).length, 1, 'refusals leave the exact row intact');
  await service.shutdown(); forwarder.close();
});

const queueSteeringIdentity = (JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/follow-up-queue-vectors.json'), 'utf8')) as {
  steeringIdentity: { rendererTurnId: string; facadeTurnId: string; nextRendererTurnId: string; nextFacadeTurnId: string; text: string };
}).steeringIdentity;

for (const identity of ['rendererTurnId', 'facadeTurnId'] as const) h.test(`queued steering binds the current ${identity} to its facade submission`, async () => {
  const vector = queueSteeringIdentity;
  const client = queueClient().replySubmit('steer');
  const { service, state, pushed, forwarder } = queueService(client, byoRoot());
  try {
    await service.resolveLiveSession('thread'); state.markTurnRunning('thread', vector.facadeTurnId);
    client.emit('event', { type: 'productEvent', method: 'turn/started', params: {
      sessionId: 'live', submissionId: vector.facadeTurnId, detail: { type: 'turn.started', turnId: vector.rendererTurnId },
    } });
    assertEqual(state.runningTurnId('thread'), vector.rendererTurnId, 'production events expose the engine UUID to the renderer');
    assertEqual(state.runningSubmissionId('thread'), vector.facadeTurnId, 'the host retains the separate facade fence');
    const added = obj(await service.clientQueueAdd('thread', { id: 'visible-steer', item: queueItem(vector.text) }));
    const revision = obj(added.snapshot).revision as number;
    const result = obj(await service.clientQueueDeliver('thread', 'visible-steer', revision, vector[identity], true));
    assertEqual(result.ok, true, 'the currently displayed queued message is admitted');
    const request = rowAt(client.sentQueue('steer'), 0, 'queued steer');
    assertEqual(request.expectedTurnId, vector.facadeTurnId, 'only the captured facade identity reaches the engine');
    assertEqual(request.mode, 'steer', 'the input enters the running turn');
    assertEqual(client.sentQueue('steer').length, 1, 'the message is submitted exactly once');
    assertEqual(client.sentQueue('start-if-idle').length, 0, 'steering never starts a replacement turn');
    assertEqual(queueRows(await service.clientQueueSnapshot('thread')).length, 0, 'confirmed admission removes the saved queue row');
    assert(pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 'the submitted message reaches the transcript');
    assertEqual(state.isWorking('thread'), true, 'the current turn continues running');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('queued steering rejects both retired identities before claiming the message', async () => {
  const vector = queueSteeringIdentity;
  const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
  try {
    await service.resolveLiveSession('thread'); state.markTurnRunning('thread', vector.nextRendererTurnId, vector.nextFacadeTurnId);
    await service.clientQueueAdd('thread', { id: 'stale-steer', item: queueItem(vector.text) });
    for (const expected of [vector.rendererTurnId, vector.facadeTurnId]) {
      const result = obj(await service.clientQueueDeliver('thread', 'stale-steer', undefined, expected, true));
      assertEqual(result.code, 'steer_turn_changed', 'a previous UI or facade identity cannot address the replacement turn');
      const row = obj(queueRows(await service.clientQueueSnapshot('thread'))[0]);
      assert(row.dispatching !== true, 'the refusal never claims the saved message');
      assert(row.pausedReason == null, 'the unattempted message is not marked as failed');
    }
    assertEqual(client.sentQueue('steer').length, 0, 'no old instruction reaches the new turn');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('queued steering keeps its captured facade fence across asynchronous input preparation', async () => {
  const vector = queueSteeringIdentity;
  let prepared!: () => void, held = false;
  const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
  try {
    await service.resolveLiveSession('thread'); state.markTurnRunning('thread', vector.rendererTurnId, vector.facadeTurnId);
    await service.clientQueueAdd('thread', { id: 'delayed-steer', item: queueItem(vector.text) });
    client.queue.beforeRequest = async method => {
      if (method !== 'thread/queue/list' || held) return;
      held = true; await new Promise<void>(resolve => { prepared = resolve; });
    };
    const delivery = service.clientQueueDeliver('thread', 'delayed-steer', undefined, vector.rendererTurnId, true);
    await waitFor(() => typeof prepared === 'function', 1000, 'queued input preparation started');
    state.markTurnRunning('thread', vector.nextRendererTurnId, vector.nextFacadeTurnId);
    prepared();
    assertEqual(obj(await delivery).ok, false, 'the accepted UI alias cannot migrate to another facade turn');
    assertEqual(client.sentQueue('steer').length, 0, 'the delayed instruction never enters the replacement turn');
    assertEqual(queueRows(await service.clientQueueSnapshot('thread')).length, 1, 'the original message stays saved after refusal');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('queued steering requires a known running target without claiming idle or unidentified rows', async () => {
  const vector = queueSteeringIdentity;
  const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
  try {
    await service.resolveLiveSession('thread');
    await service.clientQueueAdd('thread', { id: 'unknown-steer', item: queueItem(vector.text) });
    assertEqual(obj(await service.clientQueueDeliver('thread', 'unknown-steer', undefined, undefined, true)).code, 'steer_turn_changed', 'a running-turn action cannot become an idle send');
    state.markTurnRunning('thread', vector.rendererTurnId, '');
    assertEqual(obj(await service.clientQueueDeliver('thread', 'unknown-steer', undefined, vector.rendererTurnId, true)).code, 'steer_turn_required', 'an unidentified facade cannot produce an unguarded steer');
    assertEqual(queueRows(await service.clientQueueSnapshot('thread')).length, 1, 'both refusals preserve the queue row');
    assertEqual(client.sentQueue('steer').length, 0, 'no unguarded steer is issued');
    assertEqual(client.sentQueue('start-if-idle').length, 0, 'no fallback turn starts');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('file steering keeps original display text and attachment metadata away from engine path references', async () => {
  const client = new FakeClient().replySubmit('steer'), { service, state, pushed } = serviceWith(client, byoRoot());
  await service.client();
  state.rememberSession('thread', 'live', {}); state.markTurnRunning('thread', 'facade-turn');
  await service.followUp('thread', { text: 'Review document\n\nAttached:\n- /managed/uploads/notes.txt', displayText: 'Review document', expectedTurnId: 'facade-turn', displayMetadata: { displayText: 'Review document', attachments: [{ type: 'file', name: 'notes.txt' }] }, mobileAttachments: [{ path: '/managed/uploads/notes.txt', name: 'notes.txt', type: 'file' }] });
  const steer = rowAt(client.sentSubmit('steer'), 0, 'file steer admission');
  assert(!pushed.some(event => obj(event).type === 'follow_up_status' && obj(event).state === 'applied'), 'admission alone cannot apply file input');
  client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: steer.submissionId, steered: { applied: true } } } });
  const applied = pushed.find(event => obj(event).type === 'follow_up_status' && obj(event).state === 'applied');
  assertEqual(obj(applied).text, 'Review document', 'status text stays user-facing');
  assertEqual(obj(obj(applied).displayMetadata).displayText, 'Review document', 'names and safe display data survive the live receipt');
  assert(JSON.stringify(rowAt(client.sentSubmit('steer'), 0, 'file steer').input).includes('/managed/uploads/notes.txt'), 'only model input carries the read path');
  await service.shutdown();
});

h.test('strict Queue arriving after terminal starts once and never resumes interrupted rows', async () => {
  const { service, state, forwarder } = queueService(queueClient(), byoRoot());
  const client = await service.client() as FakeClient;
  await service.resolveLiveSession('thread');
  assertEqual(obj(await service.clientQueueSnapshot('thread')).followUpTurnId, null, 'idle queue has no steering fence');
  await service.clientQueueAdd('thread', { id: 'idle-arrival', item: queueItem('After terminal'), dispatchIfIdle: true });
  await waitFor(async () => client.sentQueue('start-if-idle').length === 1 && queueRows(await service.clientQueueSnapshot('thread')).length === 0, 2000, 'idle admission is dispatched');
  assertEqual(client.sentQueue('steer').length, 0, 'strict queue cannot use steer');
  await service.clientQueueAdd('thread', { id: 'paused', item: queueItem('Paused after stop') });
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: state.runningSubmissionId('thread')!, result: { stopReason: 'aborted' } } });
  await waitFor(async () => obj(obj(await service.clientQueueSnapshot('thread')).snapshot).interrupted === true, 2000, 'Stop pauses the queue');
  await service.clientQueueAdd('thread', { id: 'idle-paused-arrival', item: queueItem('After stop'), dispatchIfIdle: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assertEqual(client.sentQueue('start-if-idle').length, 1, 'an idle arrival never auto-resumes a stopped queue');
  assertEqual(state.isWorking('thread'), false, 'the stopped state remains idle');
  await service.shutdown(); forwarder.close();
});

h.test('mobile steering fences the facade ID before preparing attachments and exposes that exact fence', async () => {
  let preparations = 0;
  const client = new FakeClient(), { service, state } = serviceWith(client, byoRoot(), undefined, { messageInput: async () => { preparations++; return 'input'; } });
  await service.client();
  state.rememberSession('thread', 'live', {}); state.markTurnRunning('thread', 'ui-core-id', 'facade-active');
  assertEqual(obj(await service.clientQueueSnapshot('thread')).followUpTurnId, 'facade-active', 'queue controls expose canonical admission identity');
  const stale = obj(await service.followUp('thread', { text: 'Steer old task', expectedTurnId: 'ui-core-id' }));
  assertEqual(stale.ok, false, 'UI core alias is not a valid facade fence');
  assertEqual(preparations, 0, 'a stale steer does not prepare attachments');
  assertEqual(client.sentSubmit('steer').length, 0, 'a stale steer never reaches the engine');
  client.replySubmit('steer');
  assertEqual(obj(await service.followUp('thread', { text: 'Steer current task', expectedTurnId: 'facade-active' })).ok, true, 'captured facade fence is accepted');
  assertEqual(rowAt(client.sentSubmit('steer'), 0, 'strict steer').expectedTurnId, 'facade-active', 'engine receives exact visible fence');
  state.clearTurnRunning('thread'); assertEqual(obj(await service.clientQueueSnapshot('thread')).followUpTurnId, null, 'terminal clears the fence');
  await service.shutdown();
});

h.test('manual queued delivery retains a durable claim while engine admission waits', async () => {
  const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
  await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'active');
  await service.clientQueueAdd('thread', { id: 'manual', item: queueItem('Send now') });
  let acknowledge!: (value: unknown) => void;
  client.queue.admit = async params => params.mode === 'steer'
    ? new Promise<Json>(resolve => { acknowledge = resolve as (value: unknown) => void; })
    : acceptedTurnInput(params);
  const delivery = service.clientQueueDeliver('thread', 'manual', 1);
  try {
  await waitFor(() => typeof acknowledge === 'function', 1000, 'manual steer awaits ACK');
  const retained = rowAt(queueRows(await service.clientQueueSnapshot('thread')), 0, 'manual durable claim');
  assertEqual(retained.dispatching, true, 'the row remains in the durable queue while admission is pending');
  assertEqual(obj(await service.clientQueueRemove('thread', 'manual')).ok, false, 'a phone cannot delete an in-flight claim');
  const busy = obj(await service.clientQueueDeliver('thread', 'manual'));
  assertEqual(busy.ok, true, 'an in-flight request remains successfully queued');
  assertEqual(busy.queued, true, 'the caller retains the authoritative queued state');
  assertDeepEqual(busy.snapshot, obj(await service.clientQueueSnapshot('thread')).snapshot, 'busy reply returns the current snapshot');
  assertEqual(client.sentQueue('steer').length, 1, 'a second send-now cannot duplicate it');
  acknowledge(acceptedTurnInput(client.sentQueue('steer')[0]!));
  assertEqual(obj(await delivery).ok, true, 'manual admission settles');
  assertEqual(queueRows(await service.clientQueueSnapshot('thread')).length, 0, 'only confirmed admission releases the row');
  assertEqual(client.sentQueue('steer').length, 1, 'exactly one injection');
  } finally {
    acknowledge?.(acceptedTurnInput(client.sentQueue('steer')[0] ?? {}));
    await delivery.catch(() => {});
    await service.shutdown(); forwarder.close();
  }
});

h.test('a busy manual queue request retains the later row without issuing another admission RPC', async () => {
  const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
  await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'active');
  await service.clientQueueAdd('thread', { id: 'first-manual', item: queueItem('First instruction') });
  await service.clientQueueAdd('thread', { id: 'second-manual', item: queueItem('Second instruction') });
  let acknowledge!: (value: unknown) => void;
  client.queue.admit = async params => params.mode === 'steer'
    ? new Promise<Json>(resolve => { acknowledge = resolve as (value: unknown) => void; })
    : acceptedTurnInput(params);
  const first = service.clientQueueDeliver('thread', 'first-manual');
  try {
    await waitFor(() => typeof acknowledge === 'function', 1000, 'first row owns admission');
    const second = obj(await service.clientQueueDeliver('thread', 'second-manual'));
    assertEqual(second.ok, true, 'busy enqueue is not a false delivery failure');
    assertEqual(second.queued, true, 'later row stays queued');
    assertDeepEqual(second.snapshot, obj(await service.clientQueueSnapshot('thread')).snapshot, 'busy response returns authoritative snapshot');
    const rows = queueRows(await service.clientQueueSnapshot('thread'));
    assertDeepEqual(rows.map(row => obj(row).id), ['first-manual', 'second-manual'], 'busy request preserves both row identities and order');
    assertEqual(obj(rows[0]).dispatching, true, 'first row keeps ownership');
    assert(obj(rows[1]).dispatching !== true, 'later row cannot claim concurrently');
    assertEqual(client.sentQueue('steer').length, 1, 'second row issues no admission RPC');
    acknowledge(acceptedTurnInput(client.sentQueue('steer')[0]!)); await first;
    assertDeepEqual(queueRows(await service.clientQueueSnapshot('thread')).map(row => obj(row).id), ['second-manual'], 'first acceptance leaves the later payload queued');
  } finally {
    acknowledge?.(acceptedTurnInput(client.sentQueue('steer')[0] ?? {}));
    await first.catch(() => {});
    await service.shutdown(); forwarder.close();
  }
});

h.test('client, manual-engine and automatic-engine queued admissions each project the current conversation', async () => {
  const root = byoRoot(), client = queueClient().reply('engine/windowsSandboxReadiness', { status: 'ready' }).reply('session/setRuntimePolicy', {}).reply('session/close', {})
    .replyAcknowledged('session/updateConfig', { [goalReadLifecycle.runtimeConfigOutcomeField]: {} });
  const original = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params) => {
    if (method === 'session/resumeQueued' || method === 'session/resumePending') {
      client.calls.push({ method, params });
      return { pendingResume: { started: true, turnId: obj(params).submissionId } };
    }
    return original(method, params);
  };
  const projection = new WindowsRuntimePolicyProjection({ isNativeLocal: id => id === 'thread', request: (method, params) => client.requestWithTimeout(method, params) });
  const { service, state, forwarder } = queueService(client, root, { runtimePolicyProjection: projection });
  applySessionRuntimePolicy('thread', { policy: { ...presetRuntimePolicy('bypassPermissions') } }, root);
  const saved = JSON.stringify(sessionRuntimePolicy('thread', root));
  try {
    await service.resolveLiveSession('thread');
    client.reply('engine/windowsSandboxReadiness', { status: 'notConfigured' });
    await service.clientQueueAdd('thread', { id: 'windows-queued', item: queueItem('Queued work') });
    assertEqual(obj(await service.clientQueueDeliver('thread', 'windows-queued')).ok, true, 'client-owned input starts through ordinary admission');
    assertEqual(client.sent('session/setRuntimePolicy').length, 1, 'client-owned queued input projects before start');
    state.clearTurnRunning('thread');
    const pending = { revision: 1, status: 'authoritative', items: [{ state: 'pending', mutable: true,
      message: { uuid: 'engine-windows-input', value: 'Engine input', mode: 'prompt', priority: 'next' } }] };
    client.reply('session/queueSnapshot', { queueSnapshot: pending }); state.installQueueSnapshot('thread', pending);
    assertEqual(obj(await service.continueTurn('thread')).ok, true, 'manual engine continuation is admitted');
    assertEqual(client.sent('session/setRuntimePolicy').length, 2, 'manual engine continuation projects before resumeQueued');
    const active = state.runningSubmissionId('thread');
    assert(typeof active === 'string', 'manual continuation owns a concrete turn');
    client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: active, result: { stopReason: 'completed' } } });
    await waitFor(() => client.sent('session/resumePending').length === 1, 1000, 'automatic queued continuation reaches admission');
    assertEqual(client.sent('session/setRuntimePolicy').length, 3, 'automatic engine continuation projects before resumePending');
    for (const raw of client.sent('session/setRuntimePolicy')) assertDeepEqual(raw, {
      sessionId: 'live', approvalPolicy: 'on-request', sandboxMode: 'read-only', approvalsReviewer: 'user', networkAllowed: false,
    }, 'all queue sources use the same effective tuple');
    for (const method of ['thread/queue/start', 'session/resumeQueued', 'session/resumePending']) {
      const index = client.calls.findIndex(call => call.method === method);
      assert(index > 0 && client.calls.slice(0, index).some(call => call.method === 'session/setRuntimePolicy'), 'a policy publication precedes ' + method);
    }
    assertEqual(JSON.stringify(sessionRuntimePolicy('thread', root)), saved, 'queued projection leaves the saved full policy intact');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('a completed turn dispatches the client queue as an ordinary new turn', async () => {
  const root = byoRoot(), client = queueClient();
  const { service, state, pushed, forwarder } = queueService(client, root);
  await service.resolveLiveSession('thread');
  state.markTurnRunning('thread', 'first');

  const snapshotPushesBefore = pushed.filter(event => obj(event).type === 'client_queue_snapshot').length;
  const added = obj(await service.clientQueueAdd('thread', { id: 'queued-one', item: queueItem('Then summarise') }));
  assertEqual(added.ok, true, 'the row was stored by the engine');
  assertEqual(rowAt(queueRows(added), 0, 'the stored row').id, 'queued-one', 'the reply snapshot names the row');
  assertEqual(pushed.filter(event => obj(event).type === 'client_queue_snapshot').length - snapshotPushesBefore, 1, 'storing publishes exactly one new snapshot');

  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'first', result: { stopReason: 'completed' } } });
  await waitFor(() => client.sentQueue('start-if-idle').length === 1, 2000, 'the queued message becomes the next turn');
  assertDeepEqual(client.queue.admissions[0]?.row.input, [{ type: 'text', text: 'Then summarise' }], 'stored native model-visible input is what the engine receives');

  // The host cannot draw the bubble itself (the engine never echoes a user
  // message), so it announces the row it sent and the renderer draws it.
  await waitFor(() => pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 2000, 'the dispatched row announces its bubble');
  const announced = pushed.find(event => obj(event).type === 'queued_follow_up_dispatched');
  assertEqual(obj(announced).id, 'queued-one', 'the announcement names the row that was sent');
  await waitFor(async () => queueRows(await service.clientQueueSnapshot('thread')).length === 0, 2000, 'the queue drains');
  assertEqual(client.sentQueue('start-if-idle').length, 1, 'one queued message is exactly one new turn, never a loop');
  await service.shutdown(); forwarder.close();
});

h.test('a user interruption pauses the client queue instead of draining it', async () => {
  const root = byoRoot(), client = queueClient();
  const { service, state, pushed, forwarder } = queueService(client, root);
  await service.resolveLiveSession('thread');
  state.markTurnRunning('thread', 'first');
  await service.clientQueueAdd('thread', { id: 'queued-one', item: queueItem('Then summarise') });

  // `stopReason: "aborted"` is what the Stop button produces, and it must not send.
  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'first', result: { stopReason: 'aborted' } } });
  await waitFor(() => pushed.some(event => {
    const row = obj(event);
    return row.type === 'client_queue_snapshot' && row.interrupted === true;
  }), 2000, 'the interruption marks the whole queue paused');
  assertEqual(client.sentQueue('start-if-idle').length, 0, 'an interrupted turn never dispatches what the user just stopped');

  const paused = queueRows(await service.clientQueueSnapshot('thread'));
  assertEqual(paused.length, 1, 'the queued message survives the interruption');
  assertEqual(obj(rowAt(paused, 0, 'the paused row')).pausedReason, undefined, 'an interruption is not a delivery failure, so no Retry reason is attached');

  // Resume is the user's explicit decision, and it dispatches what the pause held.
  const resumed = obj(await service.clientQueueResume('thread'));
  assertEqual(resumed.ok, true, 'resume is accepted');
  await waitFor(() => client.sentQueue('start-if-idle').length === 1, 2000, 'resume dispatches the paused head row');
  await service.shutdown(); forwarder.close();
});


h.test('uncertain client-queue steer retains a durable non-dispatchable copy until a correlated receipt', async () => {
  const client = new FakeClient().reply('session/start', { sessionId: 'live' })
    .reply('session/modelRuntime', { revision: 0 }).reply('config/read', { resolved: { model: 'default' }, sources: { model: 'defaults' } });
  const { service, state, pushed, forwarder } = queueService(client, byoRoot());
  await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'running-wire-id');
  client.queue.admit = async () => { throw { kind: 'timeout', method: 'thread/queue/start' }; };
  const displayMetadata = { displayText: 'Already issued', composerReferences: [{ kind: 'browser-tab', id: 'snapshot' }] };
  await service.clientQueueAdd('thread', { id: 'queued-one', item: { ...obj(queueItem('Already issued')), displayMetadata } });
  assertEqual(obj(await service.clientQueueDeliver('thread', 'queued-one')).ok, true, 'client ownership is consumed after issuance');
  const retained = rowAt(queueRows(await service.clientQueueSnapshot('thread')), 0, 'uncertain durable copy');
  assertEqual(retained.unconfirmed, true, 'unknown admission is explicit and durable');
  assertEqual(obj(await service.clientQueueDeliver('thread', 'queued-one')).code, 'queue_delivery_unknown', 'retry requires an explicit user decision');
  await service.clientQueueResume('thread'); assertEqual(client.sentQueue('steer').length, 1, 'resume never resends unknown input');
  const steer = obj(client.sentQueue('steer')[0]);
  assertDeepEqual(steer.displayMetadata, displayMetadata, 'queued steer preserves the stored composer snapshot');
  const notice = pushed.find(event => obj(event).type === 'follow_up_status' && obj(event).state === 'unconfirmed');
  assertEqual(obj(notice).messageId, steer.queueMessageId, 'uncertainty uses the durable engine UUID');
  assert(!pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 'unknown admission draws a waiting row, not a confirmed sent bubble');
  client.queue.confirm(String(steer.threadId), String(steer.submissionId), 'steered');
  client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: steer.submissionId, steered: { applied: true } } } });
  assert(pushed.some(event => obj(event).type === 'follow_up_status' && obj(event).state === 'applied'), 'late application replaces uncertainty');
  assertEqual(queueRows(await service.clientQueueSnapshot('thread')).length, 0, 'only a correlated actual application releases the durable copy');
  assertEqual(client.sentQueue('steer').length, 1, 'no automatic resend');
  await service.shutdown(); forwarder.close();
});

for (const mode of ['manual', 'automatic'] as const) {
  h.test(`an admitted ${mode} queued turn survives a lost start acknowledgement without a retry copy`, async () => {
    const client = queueClient(), { service, state, pushed, forwarder } = queueService(client, byoRoot());
    client.queue.admit = async params => {
      client.emit('event', { type: 'productEvent', method: 'turn/started', params: {
        sessionId: 'live', submissionId: params.submissionId!, detail: { type: 'turn.started', turnId: 'accepted-core-turn' },
      } });
      return acceptedTurnInput(params);
    };
    client.queue.afterCommit = async method => { if (method === 'thread/queue/start') throw { kind: 'timeout', method }; };
    try {
      await service.resolveLiveSession('thread');
      await service.clientQueueAdd('thread', { id: 'accepted-queued', item: queueItem('Accepted exactly once'), dispatchIfIdle: mode === 'automatic' });
      if (mode === 'manual') assertEqual(obj(await service.clientQueueDeliver('thread', 'accepted-queued')).ok, true, 'the start event proves admission even when the ACK is lost');
      await waitFor(async () => client.sentQueue('start-if-idle').length === 1 && queueRows(await service.clientQueueSnapshot('thread')).every(row => obj(row).dispatching !== true), 2000, 'the queued attempt settles its claim');
      assertEqual(queueRows(await service.clientQueueSnapshot('thread')).length, 0, 'admitted input cannot remain as a retryable saved row');
      assertEqual(state.isWorking('thread'), true, 'the accepted engine turn remains running');
      assertEqual(pushed.filter(event => obj(event).type === 'queued_follow_up_dispatched').length, 1, 'exactly one accepted user bubble is published');
      await service.clientQueueDeliver('thread', 'accepted-queued');
      await service.clientQueueResume('thread');
      assertEqual(client.sentQueue('start-if-idle').length, 1, 'later queue actions cannot admit the same input twice');
      assertEqual(client.sentQueue('steer').length, 0, 'an already admitted row cannot become a duplicate steer');
    } finally { await service.shutdown(); forwarder.close(); }
  });
}

for (const mode of ['manual', 'automatic'] as const) for (const receipt of ['started', 'completed'] as const) {
  h.test(`an issued ${mode} queued turn with no ACK stays uncertain until its own late ${receipt} event`, async () => {
    const client = queueClient(), { service, state, pushed, forwarder } = queueService(client, byoRoot());
    client.queue.admit = async () => { throw { kind: 'timeout', method: 'thread/queue/start' }; };
    try {
      await service.resolveLiveSession('thread');
      await service.clientQueueAdd('thread', { id: 'unknown-start', item: queueItem('Keep this issued input'), dispatchIfIdle: mode === 'automatic' });
      if (mode === 'manual') await service.clientQueueDeliver('thread', 'unknown-start');
      await waitFor(async () => client.sentQueue('start-if-idle').length === 1 && queueRows(await service.clientQueueSnapshot('thread')).every(row => obj(row).dispatching !== true), 2000, 'the issued attempt settles its durable claim');
      const retained = rowAt(queueRows(await service.clientQueueSnapshot('thread')), 0, 'the durable uncertain input');
      assertEqual(retained.unconfirmed, true, 'a lost ACK cannot classify issued input as a normal failure');
      assertEqual(obj(await service.clientQueueDeliver('thread', 'unknown-start')).code, 'queue_delivery_unknown', 'Retry cannot duplicate unknown input');
      await service.clientQueueResume('thread');
      assertEqual(client.sentQueue('start-if-idle').length, 1, 'Resume never reissues an unknown start');
      const request = obj(client.sentQueue('start-if-idle')[0]);
      client.emit('event', { type: 'productEvent', method: 'turn/started', params: {
        sessionId: 'foreign-live', submissionId: request.submissionId, detail: { type: 'turn.started', turnId: 'foreign-session-turn' },
      } });
      client.emit('event', { type: 'productEvent', method: 'turn/started', params: {
        sessionId: 'live', submissionId: 'foreign-submission', detail: { type: 'turn.started', turnId: 'foreign-turn' },
      } });
      assertEqual(queueRows(await service.clientQueueSnapshot('thread')).length, 1, 'another session or submission cannot consume the saved copy');
      assertEqual(pushed.filter(event => obj(event).type === 'queued_follow_up_dispatched').length, 0, 'unrelated admission cannot manufacture a sent bubble');
      client.emit('event', { type: 'turnCompleted', params: {
        sessionId: 'live', turnId: 'foreign-submission', result: { stopReason: 'completed' },
      } });
      await waitFor(() => !state.isWorking('thread'), 1000, 'the unrelated turn settles before the original receipt arrives');
      client.queue.confirm(String(request.threadId), String(request.submissionId), 'started');
      if (receipt === 'started') {
        client.emit('event', { type: 'productEvent', method: 'turn/started', params: {
          sessionId: 'live', submissionId: request.submissionId, detail: { type: 'turn.started', turnId: 'late-core-turn' },
        } });
      } else {
        client.emit('event', { type: 'turnCompleted', params: {
          sessionId: 'live', turnId: request.submissionId, result: { stopReason: 'completed' },
        } });
      }
      await waitFor(async () => queueRows(await service.clientQueueSnapshot('thread')).length === 0, 2000, 'only the correlated engine receipt releases the saved copy');
      await waitFor(() => pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 2000, 'late engine confirmation publishes its original complete input');
      assertEqual(pushed.filter(event => obj(event).type === 'queued_follow_up_dispatched').length, 1, 'late confirmation publishes the accepted input once');
      assertEqual(state.isWorking('thread'), receipt === 'started', 'a terminal receipt cannot resurrect the accepted turn');
      assertEqual(client.sentQueue('start-if-idle').length, 1, 'reconciliation observes the original input instead of resending it');
    } finally { await service.shutdown(); forwarder.close(); }
  });
}

h.test('a removed stopped row keeps its pause through the host wire restore receipt', async () => {
  const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
  try {
    await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'before-stop');
    await service.clientQueueAdd('thread', { id: 'paused-undo', item: queueItem('Do not resume me') });
    client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'before-stop', result: { stopReason: 'aborted' } } });
    const before = obj(await service.clientQueueSnapshot('thread'));
    assertEqual(obj(before.snapshot).interrupted, true, 'the stopped row is durably paused');
    const removed = obj(await service.clientQueueRemove('thread', 'paused-undo', Number(obj(before.snapshot).revision), { id: 'undo-stopped', fingerprint: 'a'.repeat(64) }));
    assertEqual(obj(removed.removed).pausedReason, undefined, 'the renderer receives the redacted wire row');
    const restored = obj(await service.clientQueueRestore('thread', { row: removed.removed!, requireRemovedReceipt: true }));
    assertEqual(restored.ok, true, 'the durable receipt authorizes restoring the unchanged row');
    assertEqual(obj(restored.snapshot).interrupted, true, 'Undo restores the raw interruption state, not the redacted wire reason');
    assertEqual(client.sentQueue('start-if-idle').length, 0, 'Undo does not restart the paused message');
  } finally { await service.shutdown(); forwarder.close(); }
});

for (const admitted of [false, true]) {
  h.test(`resuming mixed queued sources ${admitted ? 'unpauses client rows after engine admission' : 'preserves the client pause after engine refusal'}`, async () => {
    const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
    const original = client.requestWithTimeout.bind(client);
    let release!: () => void;
    client.requestWithTimeout = async (method, params) => {
      if (method !== 'session/resumeQueued') return original(method, params);
      client.calls.push({ method, params });
      await new Promise<void>(resolve => { release = resolve; });
      const request = obj(params), pendingResume = admitted ? { started: true, turnId: request.submissionId } : { started: false, reason: 'interrupted' };
      client.emit('event', { type: 'rawSessionEvent', params: { sessionId: request.sessionId, event: { submissionId: request.submissionId, pendingResume } } });
      return { pendingResume };
    };
    try {
      await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'before-mixed-stop');
      await service.clientQueueAdd('thread', { id: 'local-after-engine', item: queueItem('Wait after the engine input') });
      client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'before-mixed-stop', result: { stopReason: 'aborted' } } });
      const engineSnapshot: Json = { revision: 1, status: 'authoritative', items: [{ state: 'pending', mutable: true, message: { uuid: 'engine-pending', value: 'Engine-owned input', mode: 'prompt', priority: 'now' } }] };
      state.installQueueSnapshot('thread', obj(engineSnapshot));
      client.reply('session/queueSnapshot', { queueSnapshot: engineSnapshot });
      const resuming = Promise.resolve(service.clientQueueResume('thread'));
      await waitFor(() => typeof release === 'function', 1000, 'the mixed Resume admits engine work first');
      assertEqual(obj(obj(await service.clientQueueSnapshot('thread')).snapshot).interrupted, true, 'client input remains paused while engine admission is unresolved');
      assertEqual(client.sentSubmit('start-if-idle').length, 0, 'the local queue cannot race the engine continuation');
      release();
      const result = obj(await resuming);
      assertEqual(result.ok, admitted, 'Resume reports the actual engine admission outcome');
      assertEqual(obj(obj(await service.clientQueueSnapshot('thread')).snapshot).interrupted, !admitted, 'only accepted engine continuation clears the local interruption');
      assertEqual(client.sentSubmit('start-if-idle').length, 0, 'client input waits until the admitted engine chain finishes');
    } finally { release?.(); await service.shutdown(); forwarder.close(); }
  });
}

h.test('a new Stop while mixed Resume awaits its ACK remains paused after the stale ACK', async () => {
  const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
  const original = client.requestWithTimeout.bind(client);
  let release!: () => void, continueSubmissionId = '';
  client.requestWithTimeout = async (method, params) => {
    if (method !== 'session/resumeQueued') return original(method, params);
    client.calls.push({ method, params });
    const request = obj(params); continueSubmissionId = String(request.submissionId);
    client.emit('event', { type: 'rawSessionEvent', params: { sessionId: request.sessionId, event: {
      submissionId: request.submissionId, pendingResume: { started: true, turnId: request.submissionId },
    } } });
    await new Promise<void>(resolve => { release = resolve; });
    return { pendingResume: { started: true, turnId: request.submissionId } };
  };
  try {
    await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'old-stopped-turn');
    await service.clientQueueAdd('thread', { id: 'paused-after-second-stop', item: queueItem('Wait for both Stops') });
    client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'old-stopped-turn', result: { stopReason: 'aborted' } } });
    const engineSnapshot: Json = { revision: 1, status: 'authoritative', items: [{ state: 'pending', mutable: true, message: { uuid: 'engine-pending', value: 'Engine-owned input', mode: 'prompt', priority: 'now' } }] };
    state.installQueueSnapshot('thread', obj(engineSnapshot));
    client.reply('session/queueSnapshot', { queueSnapshot: engineSnapshot });
    const resuming = Promise.resolve(service.clientQueueResume('thread'));
    await waitFor(() => typeof release === 'function', 1000, 'engine admission is observed before its delayed ACK');
    assertEqual(obj(obj(await service.clientQueueSnapshot('thread')).snapshot).interrupted, false, 'actual admission clears the previous interruption promptly');
    client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: continueSubmissionId, result: { stopReason: 'aborted' } } });
    assertEqual(obj(obj(await service.clientQueueSnapshot('thread')).snapshot).interrupted, true, 'the newly stopped continuation pauses the client input again');
    release(); await resuming;
    assertEqual(obj(obj(await service.clientQueueSnapshot('thread')).snapshot).interrupted, true, 'a late ACK cannot clear the newer Stop');
    assertEqual(client.sentQueue('start-if-idle').length, 0, 'the delayed outcome cannot dispatch user-stopped input');
    assertEqual(state.isWorking('thread'), false, 'a late ACK cannot resurrect the stopped continuation');
  } finally { release?.(); await service.shutdown(); forwarder.close(); }
});

for (const freshPending of [false, true]) {
  h.test(`queue Resume trusts fresh ${freshPending ? 'pending engine input' : 'empty engine input'} over the opposite cached snapshot`, async () => {
    const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
    const pending: Json = { state: 'pending', mutable: true, message: { uuid: 'engine-pending', value: 'Engine-owned input', mode: 'prompt', priority: 'now' } };
    const original = client.requestWithTimeout.bind(client);
    client.requestWithTimeout = async (method, params) => {
      if (method !== 'session/resumeQueued') return original(method, params);
      client.calls.push({ method, params });
      const request = obj(params), pendingResume = { started: true, turnId: request.submissionId };
      client.emit('event', { type: 'rawSessionEvent', params: { sessionId: request.sessionId, event: { submissionId: request.submissionId, pendingResume } } });
      return { pendingResume };
    };
    try {
      await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'before-stale-resume');
      await service.clientQueueAdd('thread', { id: 'after-stale-engine', item: queueItem('Client input after inspection') });
      client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'before-stale-resume', result: { stopReason: 'aborted' } } });
      state.installQueueSnapshot('thread', { revision: 1, status: 'authoritative', items: freshPending ? [] : [pending] });
      client.reply('session/queueSnapshot', { queueSnapshot: { revision: 2, status: 'authoritative', items: freshPending ? [pending] : [] } });
      assertEqual(obj(await service.clientQueueResume('thread')).ok, true, 'the fresh queue can resume');
      if (!freshPending) await waitFor(() => client.sentQueue('start-if-idle').length === 1, 1000, 'the client input starts after the fresh empty snapshot');
      assertEqual(client.sent('session/resumeQueued').length, freshPending ? 1 : 0, 'only freshly confirmed engine input enters the engine continuation');
      assertEqual(client.sentQueue('start-if-idle').length, freshPending ? 0 : 1, 'a stale cache cannot start an empty turn or race pending engine input');
      if (!freshPending) assertDeepEqual(client.queue.admissions[0]?.row.input, [{ type: 'text', text: 'Client input after inspection' }], 'the one admitted turn contains the saved native client message');
      assertEqual(obj(obj(await service.clientQueueSnapshot('thread')).snapshot).interrupted, false, 'the accepted route clears the previous interruption');
    } finally { await service.shutdown(); forwarder.close(); }
  });
}

h.test('a stale client queue revision refuses mixed Resume before issuing engine work', async () => {
  const client = queueClient(), { service, state, forwarder } = queueService(client, byoRoot());
  try {
    await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'before-stale-revision');
    await service.clientQueueAdd('thread', { id: 'stale-resume', item: queueItem('Do not admit stale input') });
    client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'before-stale-revision', result: { stopReason: 'aborted' } } });
    const snapshot: Json = { revision: 1, status: 'authoritative', items: [{ state: 'pending', mutable: true, message: { uuid: 'engine-pending', value: 'Engine-owned input', mode: 'prompt', priority: 'now' } }] };
    state.installQueueSnapshot('thread', obj(snapshot)); client.reply('session/queueSnapshot', { queueSnapshot: snapshot });
    const before = obj(obj(await service.clientQueueSnapshot('thread')).snapshot);
    let refused = false;
    try { refused = obj(await service.clientQueueResume('thread', true, Number(before.revision) - 1)).ok === false; }
    catch { refused = true; }
    assert(refused, 'a stale queue action is refused');
    assertEqual(client.sent('session/resumeQueued').length, 0, 'stale client ownership cannot admit engine input');
    assertEqual(client.sentQueue('start-if-idle').length, 0, 'stale client ownership cannot start a fallback turn');
    assertEqual(obj(obj(await service.clientQueueSnapshot('thread')).snapshot).interrupted, true, 'a refused action keeps the user-stopped queue paused');
  } finally { await service.shutdown(); forwarder.close(); }
});

h.test('Stop before queued continuation admission reaches the engine and keeps a late receipt paused', async () => {
  const client = queueClient().reply('turn/interrupt', {}), { service, state, forwarder } = queueService(client, byoRoot());
  const original = client.requestWithTimeout.bind(client);
  let release!: () => void;
  client.requestWithTimeout = async (method, params) => {
    if (method !== 'session/resumeQueued') return original(method, params);
    client.calls.push({ method, params });
    await new Promise<void>(resolve => { release = resolve; });
    const request = obj(params), pendingResume = { started: true, turnId: request.submissionId };
    client.emit('event', { type: 'rawSessionEvent', params: { sessionId: request.sessionId, event: { submissionId: request.submissionId, pendingResume } } });
    return { pendingResume };
  };
  try {
    await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'old-stopped-resume');
    await service.clientQueueAdd('thread', { id: 'stop-before-admission', item: queueItem('Keep waiting after Stop') });
    client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'old-stopped-resume', result: { stopReason: 'aborted' } } });
    const snapshot: Json = { revision: 1, status: 'authoritative', items: [{ state: 'pending', mutable: true, message: { uuid: 'engine-pending', value: 'Engine-owned input', mode: 'prompt', priority: 'now' } }] };
    state.installQueueSnapshot('thread', obj(snapshot)); client.reply('session/queueSnapshot', { queueSnapshot: snapshot });
    const resuming = Promise.resolve(service.clientQueueResume('thread')); void resuming.catch(() => {});
    await waitFor(() => typeof release === 'function', 1000, 'the continuation request was issued without an admission receipt');
    assertEqual(obj(await service.interrupt('thread')).accepted, true, 'Stop recognizes the issued pending continuation');
    await waitFor(() => client.sent('turn/interrupt').length === 1, 1000, 'the named interrupt cancels the engine reservation');
    release(); await resuming;
    assertEqual(obj(obj(await service.clientQueueSnapshot('thread')).snapshot).interrupted, true, 'late admission cannot clear the newer user interruption');
    assertEqual(state.isWorking('thread'), false, 'late admission cannot resurrect a user-stopped continuation');
    assertEqual(client.sentQueue('start-if-idle').length, 0, 'client input remains saved rather than racing the stopped engine');
  } finally { release?.(); await service.shutdown(); forwarder.close(); }
});

h.test('a retired connection cannot confirm a queued start through its temporary observer', async () => {
  const client = queueClient(), { service, state, pushed, forwarder } = queueService(client, byoRoot());
  let release!: () => void, started: Record<string, Json> = {};
  client.queue.admit = async params => {
    started = { ...params, sessionId: 'live' };
    await new Promise<void>(resolve => { release = resolve; });
    throw { kind: 'closed', method: 'thread/queue/start' };
  };
  try {
    await service.resolveLiveSession('thread');
    await service.clientQueueAdd('thread', { id: 'retired-start', item: queueItem('Retain uncertain old input') });
    const delivering = service.clientQueueDeliver('thread', 'retired-start');
    await waitFor(() => typeof release === 'function', 1000, 'the queued start awaits its old connection');
    client.emit('event', { type: 'streamClosed' });
    assertEqual(state.liveSession('thread'), undefined, 'the old engine binding is retired');
    client.emit('event', { type: 'productEvent', method: 'turn/started', params: {
      sessionId: started.sessionId, submissionId: started.submissionId, detail: { type: 'turn.started', turnId: 'retired-core-turn' },
    } });
    release(); await delivering;
    assertEqual(pushed.filter(event => obj(event).type === 'queued_follow_up_dispatched').length, 0, 'a retired client cannot publish an admission bubble');
    assertEqual(rowAt(queueRows(await service.clientQueueSnapshot('thread')), 0, 'the uncertain old input').unconfirmed, true, 'unknown retired admission keeps its durable saved copy');
  } finally { release?.(); await service.shutdown(); forwarder.close(); }
});


h.test('confirmed engine removal before steer ACK does not restore a client retry row', async () => {
  let confirmRemoval!: (messageId: string) => void;
  const client = new FakeClient().reply('session/start', { sessionId: 'live' })
    .reply('session/modelRuntime', { revision: 0 }).reply('config/read', { resolved: { model: 'default' }, sources: { model: 'defaults' } })
    .reply('session/removeQueued', { queueMutation: { status: 'applied', snapshot: { revision: 2, status: 'authoritative', items: [] } } });
  const { service, state, pushed, forwarder } = queueService(client, byoRoot());
  confirmRemoval = messageId => service.queuedInputRemoved('thread', messageId);
  client.queue.admit = async steer => {
    client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'live', event: { queueSnapshot: {
      revision: 1, status: 'authoritative', items: [{ state: 'pending', mutable: true, message: { uuid: steer.queueMessageId! } }],
    } } } });
    // Model an already-admitted input removed by its owner before its ACK.
    confirmRemoval(String(steer.queueMessageId));
    return acceptedTurnInput(steer);
  };
  await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'running-wire-id');
  await service.clientQueueAdd('thread', { id: 'queued-one', item: queueItem('Owner deletes during admission') });
  assertEqual(obj(await service.clientQueueDeliver('thread', 'queued-one')).ok, true, 'deleted payload is consumed');
  assertEqual(queueRows(await service.clientQueueSnapshot('thread')).length, 0, 'no restored retry row');
  assert(!pushed.some(event => obj(event).type === 'queued_follow_up_dispatched'), 'removed input draws no phantom bubble');
  assert(pushed.some(event => obj(event).type === 'follow_up_status' && obj(event).state === 'removed'), 'removed terminal is explicit');
  await service.shutdown(); forwarder.close();
});

h.test('a failed current continuation reconciles older unresolved input while stale failures spare newer input', async () => {
  class CorrelatedSteerClient extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method !== 'turn/submit' || (params as Record<string, Json>).mode !== 'steer') return super.requestWithTimeout(method, params);
      this.calls.push({ method, params }); return { submissionId: obj(params).submissionId };
    }
  }
  const client = new CorrelatedSteerClient().reply('session/start', { sessionId: 'live' })
    .reply('session/modelRuntime', { revision: 0 }).reply('config/read', { resolved: { model: 'default' }, sources: { model: 'defaults' } });
  const { service, state, pushed, forwarder } = queueService(client, byoRoot());
  await service.resolveLiveSession('thread'); state.markTurnRunning('thread', 'original-wire');
  await service.followUp('thread', { text: 'Older pending input' });
  const older = obj(client.sentSubmit('steer')[0]);
  client.emit('event', { type: 'productEvent', method: 'turn/started', params: { sessionId: 'live', submissionId: 'continuation-wire', detail: { turnId: 'continuation-core' } } });
  await service.followUp('thread', { text: 'Newer pending input' });
  const newer = obj(client.sentSubmit('steer')[1]);
  client.reply('session/queueSnapshot', { queueSnapshot: { revision: 1, status: 'authoritative', items: [
    { state: 'pending', message: { uuid: String(older.queueMessageId) } }, { state: 'pending', message: { uuid: String(newer.queueMessageId) } },
  ] } });
  client.emit('event', { type: 'productEvent', method: 'turn/failed', params: { sessionId: 'live', submissionId: 'original-wire', detail: { error: { code: 'internal', message: 'Original turn failed' } } } });
  await waitFor(() => pushed.some(event => obj(event).messageId === older.queueMessageId && obj(event).state === 'pending'), 2000, 'older input reconciles');
  assert(!pushed.some(event => obj(event).messageId === newer.queueMessageId && obj(event).state === 'pending'), 'stale old failure cannot downgrade newer input');
  client.emit('event', { type: 'productEvent', method: 'turn/failed', params: { sessionId: 'live', submissionId: 'continuation-wire', detail: { error: { code: 'internal', message: 'Continuation failed' } } } });
  await waitFor(() => pushed.some(event => obj(event).messageId === newer.queueMessageId && obj(event).state === 'pending'), 2000, 'current continuation reconciles session queue');
  assertEqual(pushed.filter(event => obj(event).messageId === older.queueMessageId && obj(event).state === 'pending').length, 2, 'older unresolved observer is included at continuation failure');
  assertEqual(state.queueSnapshot('thread')?.revision, 1, 'terminal reconciliation also updates the host mirror used for guarded removal');
  assertEqual(client.sent('session/resumeQueued').length, 0, 'failed continuation does not resume itself');
  await service.shutdown(); forwarder.close();
});

h.test('a dispatch failure puts the row back paused instead of losing it', async () => {
  const root = byoRoot();
  // A typed invalid-input refusal proves non-admission, so the exact saved row
  // remains paused and an explicit retry can prepare it again.
  const client = new FakeClient()
    .reply('session/start', { sessionId: 'live' })
    .reply('session/modelRuntime', { revision: 0 })
    .reply('config/read', { resolved: { model: 'default' }, sources: { model: 'defaults' } });
  const { service, state, forwarder } = queueService(client, root);
  client.queue.admit = async params => ({ status: 'not-submitted', submissionId: params.submissionId!, reason: { code: 'invalid-input' } });
  await service.resolveLiveSession('thread');
  state.markTurnRunning('thread', 'first');
  await service.clientQueueAdd('thread', { id: 'queued-one', item: queueItem('Then summarise') });

  client.emit('event', { type: 'turnCompleted', params: { sessionId: 'live', turnId: 'first', result: { stopReason: 'completed' } } });
  await waitFor(async () => {
    const rows = queueRows(await service.clientQueueSnapshot('thread'));
    return rows.length === 1 && typeof obj(rows[0]).pausedReason === 'string';
  }, 2000, 'a failed dispatch returns the row to the queue, paused');

  const rows = queueRows(await service.clientQueueSnapshot('thread'));
  const failed = rowAt(rows, 0, 'the returned row');
  assertEqual(failed.id, 'queued-one', 'the same row came back rather than a duplicate or a loss');
  assert(String(failed.pausedReason ?? '').length > 0, 'the row carries a failure reason so the user can retry it');
  assertEqual(client.sentQueue('start-if-idle').length, 1, 'a failure does not retry in a loop');
  await service.shutdown(); forwarder.close();
});


h.test('an invalid engine model identity cannot start a session or replace its saved source', async () => {
  for (const resolved of [
    { source: 'codex', selection: 'custom:model' },
    { source: 'custom', selection: 'codex:model' },
    { source: 'custom', selection: '' },
  ]) {
    const root = byoRoot(), client = new FakeClient().reply('model/selection/resolve', resolved);
    setSessionModel('thread', 'custom:model', 'custom', root);
    const { service, state } = serviceWith(client, root);
    try {
      const failure = await assertRejects(() => service.resolveLiveSession('thread'), 'invalid model identity');
      assertEqual((failure as { code?: string }).code, 'MODEL_SELECTION_UNAVAILABLE', 'an inconsistent resolver reply is rejected');
      assertDeepEqual(client.sent('model/selection/resolve'), [{ source: 'custom', selection: 'custom:model' }], 'the saved source was resolved once');
      assertEqual(client.sent('session/start').length, 0, 'no session starts with a mismatched model');
      assertEqual(state.liveSession('thread'), undefined, 'no live binding is recorded');
      const saved = resolveSessionAuth('thread', root);
      assert(saved.kind === 'engineModel', 'the saved BYO choice remains available');
      assertEqual(saved.source, 'custom', 'the saved source remains unchanged');
    } finally { await service.shutdown(); }
  }
});

const asyncQuestionRecord = { requestId: 'async-question-1', turnId: 'engine-turn-1', toolCallId: 'question-tool-1', state: 'pending',
  answers: { 'Which format?': 'List' }, request: { prompt: 'Choose', attachmentsSupported: true, questions: [
    { question: 'Which format?', options: [{ label: 'List' }, { label: 'Paragraph' }] },
    { question: 'Which language?', options: [{ label: 'Chinese' }, { label: 'English' }] },
  ] } };
const asyncQuestionPayload = { requestId: 'async-question-1', turnId: 'engine-turn-1', clientResponseId: 'client-response-1', answers: { 'Which language?': 'Chinese' } };
const asyncQuestionReply = { accepted: true, requestId: 'async-question-1', turnId: 'engine-turn-1', clientResponseId: 'client-response-1',
  userMessageId: 'answer-user-1', state: 'answered' };
const questionHydration = JSON.parse(readFileSync(vectorPath('async-user-question-vectors.json'), 'utf8')).hydration as {
  dormant: Json; startsEngine: boolean; priority: string;
};

h.test('question hydration leaves dormant historical sessions and an unattached engine asleep', async () => {
  const client = new FakeClient(); let attaches = 0;
  const { service } = serviceWith(client, freshRoot(), undefined, { manager: {
    attach: async () => { attaches++; return { client, generation: 1 }; }, shutdownAll: async () => { client.closed = true; },
  } });
  const cards = await Promise.all(Array.from({ length: 100 }, (_, index) => service.pendingQuestions(`dormant-${index}`)));
  for (const card of cards) assertDeepEqual(card, questionHydration.dormant, 'no live registry means no answerable requests');
  assertEqual(attaches > 0, questionHydration.startsEngine, 'sidebar recovery does not start the engine');
  assertEqual(client.calls.length, 0, 'dormant hydration does not resolve models, replay history or subscribe');
  await service.client();
  assertDeepEqual(await service.pendingQuestions('attached-but-dormant'), questionHydration.dormant, 'an attached engine does not make history live');
  assertEqual(client.calls.length, 0, 'attached dormant hydration still needs no facade request');
  await service.shutdown();
});

h.test('question hydration preserves private and shutdown admission checks without recovery', async () => {
  const client = new FakeClient();
  const { service } = serviceWith(client, freshRoot(), undefined, { isPrivateThread: id => id === 'private-thread' });
  await assertRejects(() => service.pendingQuestions('private-thread'), 'private history is not exposed by the dormant fast path');
  await assertRejects(() => service.pendingQuestions('ordinary-thread', () => { throw new Error('Renderer retired'); }), 'renderer ownership is checked before the fast path');
  await service.shutdown();
  await assertRejects(() => service.pendingQuestions('ordinary-thread'), 'shutdown cannot return an apparently recoverable registry');
  assertEqual(client.calls.length, 0, 'rejected recovery never enters the engine');
});

h.test('asynchronous question hydration translates session identities without opening or pausing a turn', async () => {
  const client = new FakeClient().reply('session/getPendingQuestions', { questions: [asyncQuestionRecord] });
  const { service, state } = serviceWith(client, freshRoot());
  await service.client(); state.rememberSession('question-renderer', 'question-engine', {});
  const cards = await service.pendingQuestions('question-renderer') as Array<Record<string, Json>>;
  assertDeepEqual(client.sent('session/getPendingQuestions'), [{ sessionId: 'question-engine' }], 'getter uses the bound engine namespace');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'hydration never starts a new turn');
  assertEqual(state.isWorking('question-renderer'), false, 'hydration does not synthesize runtime activity');
  assertEqual(state.pendingForSession('question-renderer').length, 0, 'hydration never parks a blocking reverse request');
  assertDeepEqual([cards[0]?.requestId, cards[0]?.turnId, cards[0]?.toolCallId, cards[0]?.responseChannel],
    ['async-question-1', 'engine-turn-1', 'question-tool-1', 'async-question'], 'original request owner and tool identity survive recovery');
  assertDeepEqual(cards[0]?.answers, asyncQuestionRecord.answers, 'answered subset survives recovery');
  await service.shutdown();
});

h.test('asynchronous question answers require current binding and preserve partial acknowledgements and duplicate response ids', async () => {
  const client = new FakeClient().reply('session/answerQuestion', { ...asyncQuestionReply, state: 'pending' });
  let inputs = 0;
  const { service, state } = serviceWith(client, freshRoot(), undefined, { onInput: () => { inputs++; } });
  await service.client(); state.rememberSession('question-renderer', 'question-engine', {}); state.markTurnRunning('question-renderer', 'engine-turn-1');
  for (let retry = 0; retry < 2; retry++) assertDeepEqual(await service.answerQuestion('question-renderer', asyncQuestionPayload),
    { ...asyncQuestionReply, state: 'pending' }, 'accepted partial submission does not claim the full batch is answered');
  assertDeepEqual(client.sent('session/answerQuestion'), Array.from({ length: 2 }, () => ({ ...asyncQuestionPayload, sessionId: 'question-engine' })),
    'duplicate retries preserve the same client response id for engine deduplication');
  assertEqual(inputs, 2, 'accepted answers count as human input');
  assert(state.isWorking('question-renderer'), 'answering never opens or completes a turn in the host');
  state.forgetSession('question-renderer');
  await assertRejects(() => service.answerQuestion('question-renderer', asyncQuestionPayload), 'retired session cannot submit to a replacement connection');
  assertEqual(client.sent('session/answerQuestion').length, 2, 'expired answer never enters engine facade');
  await service.shutdown();
});

h.test('late pending snapshots and question answers cannot cross a retired binding', async () => {
  for (const method of ['session/getPendingQuestions', 'session/answerQuestion']) {
    const client = new FakeClient(); let reading = false, release!: (value: unknown) => void;
    const original = client.requestWithTimeout.bind(client);
    client.requestWithTimeout = async (name, params) => name === method
      ? (reading = true, new Promise(resolve => { release = resolve; })) : original(name, params);
    const { service, state } = serviceWith(client, freshRoot());
    await service.client(); state.rememberSession('question-renderer', 'old-question-engine', {}); state.markTurnRunning('question-renderer', 'engine-turn-1');
    const call = method === 'session/getPendingQuestions' ? service.pendingQuestions('question-renderer') : service.answerQuestion('question-renderer', asyncQuestionPayload);
    const rejected = assertRejects(() => call, 'late question reply is rejected');
    await waitFor(() => reading, 1000, 'question facade read captured');
    state.rememberSession('question-renderer', 'new-question-engine', {});
    release(method === 'session/getPendingQuestions' ? { questions: [asyncQuestionRecord] } : asyncQuestionReply);
    await rejected;
    await service.shutdown();
  }
});

h.test('durable accepted question answers retain their receipt when the original turn retires during persistence', async () => {
  const client = new FakeClient();
  const { service, state } = serviceWith(client, freshRoot());
  await service.client(); state.rememberSession('question-renderer', 'question-engine', {});
  for (const retired of ['cancelled', 'expired']) {
    const reply = { ...asyncQuestionReply, state: retired };
    client.reply('session/answerQuestion', reply);
    assertDeepEqual(await service.answerQuestion('question-renderer', asyncQuestionPayload), reply,
      'an accepted durable answer is not turned into a host error by terminal admission state');
  }
  await service.shutdown();
});

h.test('question attachment transformation validates scope and checks binding again before submitting', async () => {
  const transformed = { 'Which language?': [{ type: 'image', mimeType: 'image/png', base64: 'AA==' }] };
  const client = new FakeClient().reply('session/getPendingQuestions', { questions: [asyncQuestionRecord] }).reply('session/answerQuestion', asyncQuestionReply);
  const inputGroups = { 'Which language?': [{ path: '/uploaded/fixture.png', name: 'fixture.png', type: 'image/png', size: 1 }] };
  let transformCalls = 0;
  const { service, state } = serviceWith(client, freshRoot(), undefined, { answerAttachments: async groups => {
    transformCalls++; assertDeepEqual(groups, inputGroups, 'only uploaded attachment descriptors enter the existing transformer'); return transformed;
  } });
  await service.client(); state.rememberSession('question-renderer', 'question-engine', {}); state.markTurnRunning('question-renderer', 'engine-turn-1');
  await service.answerQuestion('question-renderer', { ...asyncQuestionPayload, attachments: inputGroups });
  assertDeepEqual(client.sent('session/answerQuestion'), [{ ...asyncQuestionPayload, sessionId: 'question-engine', attachments: transformed }], 'engine receives only transformed content blocks');
  client.reply('session/getPendingQuestions', { questions: [] });
  assertDeepEqual(await service.answerQuestion('question-renderer', { ...asyncQuestionPayload, attachments: inputGroups }), asyncQuestionReply,
    'a completed request can still receive the authoritative idempotent acknowledgement');
  assertDeepEqual(client.sent('session/answerQuestion')[1], { ...asyncQuestionPayload, sessionId: 'question-engine', attachments: transformed },
    'an attachment retry keeps its original response identity and content');
  await assertRejects(() => service.answerQuestion('question-renderer', { ...asyncQuestionPayload, attachments: { 'Which format?': inputGroups['Which language?'] } }), 'attachments cannot be smuggled into an unanswered key');
  assertEqual(transformCalls, 2, 'invalid scope is rejected before any attachment read');
  await service.shutdown();
});

h.test('question attachment I/O cannot submit after the session is retired and engine rejections are explicit', async () => {
  const client = new FakeClient().reply('session/getPendingQuestions', { questions: [asyncQuestionRecord] }).reply('session/answerQuestion', asyncQuestionReply);
  let reading = false, release!: (value: Record<string, Json>) => void;
  const { service, state } = serviceWith(client, freshRoot(), undefined, { answerAttachments: () => {
    reading = true; return new Promise(resolve => { release = resolve; });
  } });
  await service.client(); state.rememberSession('question-renderer', 'question-engine', {}); state.markTurnRunning('question-renderer', 'engine-turn-1');
  const response = service.answerQuestion('question-renderer', { ...asyncQuestionPayload, attachments: { 'Which language?': [{ path: '/uploaded/fixture.png' }] } });
  const rejected = assertRejects(() => response, 'retired attachment response cannot submit');
  await waitFor(() => reading, 1000, 'attachment read captured'); state.forgetSession('question-renderer'); release({});
  await rejected; assertEqual(client.sent('session/answerQuestion').length, 0, 'retired I/O never forwards an answer');
  state.rememberSession('question-renderer', 'question-engine', {});
  client.reply('session/answerQuestion', { accepted: false, error: 'The question owner turn has ended' });
  const error = await assertRejects(() => service.answerQuestion('question-renderer', asyncQuestionPayload), 'explicit engine rejection remains rejected');
  assertEqual(error instanceof Error && error.message, 'The question owner turn has ended', 'rejection retains the original engine reason');
  client.reply('session/answerQuestion', { ...asyncQuestionReply, turnId: 'different-turn' });
  await assertRejects(() => service.answerQuestion('question-renderer', asyncQuestionPayload), 'mismatched acknowledgement is not success');
  await service.shutdown();
});

function approvedFriendWireFixture(mode: FriendTaskGrant['mode'] = 'auto-edit') {
  const parent = freshRoot(), root = join(parent, 'profile'), resources = join(parent, 'resources');
  mkdirSync(root); mkdirSync(resources); mkdirSync(join(resources, 'read')); mkdirSync(join(resources, 'write'));
  kvSet('auth_mode', 'custom', root); kvSet('composer.permission_mode', 'bypassPermissions', root);
  const store = new FriendTaskStore(root);
  const message: FriendMessage = { kind: 'task', requestId: 'wire-request', friendshipId: 'wire-friend', senderUserId: 'wire-peer', senderDisplayName: 'Peer', senderDeviceId: 'peer-device', sourceThreadId: 'peer-origin', prompt: 'Approved task', sentAt: Date.now() };
  const grant: FriendTaskGrant = { deviceId: 'local-device', mode, computerUse: false, apps: [], directories: [{ path: join(resources, 'read'), access: 'read' }, { path: join(resources, 'write'), access: 'write' }], remember: false, network: false };
  const admitted = store.admit('wire-owner', 'local-device', message, 'wire-fingerprint', null).task;
  store.update('wire-owner', admitted.id, ['pending'], { status: 'starting', grant });
  const friendScope = { accountId: 'wire-owner', friendshipId: message.friendshipId, friendUserId: message.senderUserId, taskId: admitted.id, grant, active: true };
  return { root, resources, store, taskId: admitted.id, friendScope };
}
h.test('friend initialization uses the ordinary runtime and no longer requires task-scope capability', async () => {
  const f = approvedFriendWireFixture(), client = new FakeClient().reply('session/start', { sessionId: 'friend-wire-engine' });
  const { service } = serviceWith(client, f.root);
  try {
    await service.newSession({ friendScope: f.friendScope });
    assertEqual(client.sent('session/start').length, 1, 'A friend conversation starts through the ordinary session facade');
    const config = object(object(rowAt(client.sent('session/start'), 0, 'Friend start').init)?.config)!;
    assertEqual(config.taskResourceScope, undefined, 'Friend conversations do not receive a task resource scope');
  } finally { await service.shutdown(); }
});
h.test('friend initialization seeds the grant policy and initial roots without exposing the friends parent', async () => {
  const f = approvedFriendWireFixture(), client = new FakeClient().reply('session/start', { sessionId: 'friend-wire-engine' });
  const { service } = serviceWith(client, f.root);
  try {
    const row = await service.newSession({ friendScope: f.friendScope }) as Record<string, Json>;
    const init = rowAt(client.sent('session/start'), 0, 'Friend start').init as Record<string, Json>, config = init.config as Record<string, Json>;
    assertEqual(init.permissionMode, undefined, 'Legacy modes do not reach the engine');
    assertEqual(config.taskResourceScope, undefined, 'The ordinary runtime carries no task resource scope');
    const roots = ((object(config?.sandbox_workspace_write ?? {})?.writable_roots ?? []) as string[])
      .filter(root => !root.includes(join('visualizations', '')));
    assertDeepEqual(roots, [join(f.root, 'friends', 'wire-friend'), join(f.resources, 'write')], 'Only this friendship folder and owner-granted writable roots seed the sandbox');
    assert(!roots.includes(join(f.root, 'friends')), 'The parent folder never exposes other friendships');
    assertDeepEqual((sessionRuntimePolicy(String(row.id), f.root) as { policy?: unknown } | undefined)?.policy ?? null, presetRuntimePolicy('auto'), 'The friend conversation freezes the grant preset as its own policy row');
    const instructions = String(init.developerInstructions);
    assert(instructions.includes('### Inline Visualizations'), 'A friend conversation receives the same visualization support as an ordinary one');
    assert(instructions.includes('The conversation\'s current permission settings govern local access.'), 'The model is pointed at the ordinary live permission policy');
    await assertRejects(() => service.forkSession(String(row.id)), 'Friend task cannot fork');
    assertEqual(client.sent('session/forkLive').length, 0, 'No fork facade starts');
  } finally { await service.shutdown(); }
});
const friendShellExecution = (JSON.parse(readFileSync(vectorPath('friends-messaging-vectors.json'), 'utf8')) as {
  shellExecution: {
    injectedCommandAskRules: string[];
    sandboxMode: string;
    sandboxModeByPreset: Record<FriendExecutionPreset, string>;
    presets: Array<{ preset: FriendExecutionPreset; grantMode: FriendTaskGrant['mode']; approvalPolicy: string; approvalsReviewer: string }>;
  };
}).shellExecution;
for (const expected of friendShellExecution.presets) h.test(`friend ${expected.preset} uses its execution policy without blanket command approval rules`, async () => {
  const f = approvedFriendWireFixture(expected.grantMode), client = new FakeClient().reply('session/start', { sessionId: 'friend-preset-engine' });
  const { service } = serviceWith(client, f.root);
  try {
    await service.newSession({ friendScope: f.friendScope });
    const config = object(object(rowAt(client.sent('session/start'), 0, 'friend preset start').init)?.config)!;
    assertDeepEqual(config.ask ?? [], friendShellExecution.injectedCommandAskRules, 'The host does not override the execution preset with blanket command ask rules');
    assertDeepEqual({ approvalPolicy: config.approval_policy, approvalsReviewer: config.approvals_reviewer, sandboxMode: config.sandbox_mode },
      { approvalPolicy: expected.approvalPolicy, approvalsReviewer: expected.approvalsReviewer, sandboxMode: friendShellExecution.sandboxModeByPreset[expected.preset] },
      'The grant seeds the ordinary preset instead of a separate friend policy');
    assertEqual(config.taskResourceScope, undefined, 'Every preset uses the ordinary runtime without a task scope');
    const roots = ((object(config?.sandbox_workspace_write ?? {})?.writable_roots ?? []) as string[])
      .filter(root => !root.includes(join('visualizations', '')));
    assertDeepEqual(roots, [join(f.root, 'friends', 'wire-friend'), join(f.resources, 'write')], 'The initial roots stay the same across presets');
  } finally { await service.shutdown(); }
});
h.test('friend full access survives rebuild and turn admission as the ordinary unrestricted policy', async () => {
  const f = approvedFriendWireFixture(), client = new FakeClient()
    .reply('config/read', { values: {}, resolved: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' }, sources: {} })
    .reply('session/start', { sessionId: 'friend-wire-engine' }).reply('session/close', {})
    .reply('engine/windowsSandboxReadiness', { status: 'ready' }).reply('session/setRuntimePolicy', {})
    .replySubmit('start-if-idle', 'friend-turn').replyAcknowledged('session/updateConfig', { [goalReadLifecycle.runtimeConfigOutcomeField]: {} });
  let scopedId = '';
  const projection = new WindowsRuntimePolicyProjection({ isNativeLocal: id => id === scopedId, request: (method, params) => client.requestWithTimeout(method, params) });
  const { service, state } = serviceWith(client, f.root, undefined, { runtimePolicyProjection: projection });
  try {
    const row = await service.newSession({ friendScope: f.friendScope }) as Record<string, Json>;
    scopedId = String(row.id);
    applySessionRuntimePolicy(scopedId, { policy: { ...presetRuntimePolicy('bypassPermissions') } }, f.root);
    state.markStale(scopedId);
    await service.send(scopedId, { text: 'Run with the selected full-access preset' });
    const started = rowAt(client.sent('session/start'), 1, 'full-access friend rebuild');
    const config = object(object(started.init)?.config)!;
    assertDeepEqual(config.ask ?? [], friendShellExecution.injectedCommandAskRules, 'A rebuild cannot restore blanket command ask rules after a preset change');
    assertEqual(config.approval_policy, 'never', 'rebuild preserves the selected bypass policy');
    assertEqual(config.sandbox_mode, 'danger-full-access', 'full access is the ordinary unrestricted sandbox');
    assertEqual(config.taskResourceScope, undefined, 'full access carries no task resource scope');
    const admission = rowAt(client.sent('session/setRuntimePolicy'), 0, 'full-access friend admission');
    assertDeepEqual({ approvalPolicy: admission.approvalPolicy, sandboxMode: admission.sandboxMode, networkAllowed: admission.networkAllowed },
      { approvalPolicy: 'never', sandboxMode: 'danger-full-access', networkAllowed: true }, 'turn admission preserves the conversation selection');
  } finally { await service.shutdown(); }
});
h.test('temporary Windows policy does not reintroduce a friend task scope', async () => {
  const f = approvedFriendWireFixture(), client = new FakeClient().reply('session/start', { sessionId: 'friend-windows' })
    .reply('engine/windowsSandboxReadiness', { status: 'notConfigured' });
  const projection = new WindowsRuntimePolicyProjection({ isNativeLocal: () => true, request: (method, params) => client.requestWithTimeout(method, params) });
  const { service } = serviceWith(client, f.root, undefined, { runtimePolicyProjection: projection });
  try {
    await service.newSession({ friendScope: f.friendScope });
    const init = rowAt(client.sent('session/start'), 0, 'confined projected start').init as Record<string, Json>, config = init.config as Record<string, Json>;
    assertEqual(config.sandbox_mode, 'read-only', 'native preparation temporarily constrains execution');
    assertEqual(config.taskResourceScope, undefined, 'the temporary Windows policy leaves the ordinary runtime in place');
  } finally { await service.shutdown(); }
});

h.test('a claimed friend scope cannot start without a matching persisted active owner approval', async () => {
  const f = approvedFriendWireFixture(), client = new FakeClient(); const { service } = serviceWith(client, f.root);
  try {
    f.store.update('wire-owner', f.taskId, ['starting'], { status: 'pending' });
    await assertRejects(() => service.newSession({ friendScope: f.friendScope }), 'The task field does not substitute for an owner approval');
    assertEqual(client.sent('session/start').length, 0, 'No engine start bypasses the inbox approval');
  } finally { await service.shutdown(); }
});

h.test('owner sends and mid-turn follow-ups work before friend approval while hosted friend execution still waits', async () => {
  const f = approvedFriendWireFixture(), client = new FakeClient().reply('session/start', { sessionId: 'parked-owner-live' })
    .replySubmit('start-if-idle', 'owner-first').replySubmit('steer');
  const { service, state } = serviceWith(client, f.root);
  try {
    f.store.update('wire-owner', f.taskId, ['starting'], { status: 'pending', grant: undefined });
    const row = await service.newSession({ friendScope: { ...f.friendScope, active: false } }) as Record<string, Json>;
    const id = String(row.id);
    assertEqual(friendConversationGrant(f.root, id, f.friendScope), undefined, 'a parked scope is not approval');
    await service.send(id, { text: 'My own question in this conversation' });
    assertEqual(client.sent('turn/submit').length, 1, 'owner input starts normally before a friend is admitted');
    const steered = await service.followUp(id, { text: 'My additional instruction' }) as Record<string, Json>;
    assertEqual(steered.ok, true, 'owner follow-ups use ordinary turn permissions');
    assertEqual(client.sent('turn/submit').length, 2, 'the owner follow-up reaches the engine');
    assertEqual(friendConversationGrant(f.root, id, f.friendScope), undefined, 'owner input never approves inbound friend execution');
    state.clearTurnRunning(id);
    await assertRejects(() => service.sendAndWait(id, { text: 'An unapproved friend request', displayMetadata: { externalFriendMessage: true } }), 'hosted friend execution still needs the first approval');
    assertEqual(client.sent('turn/submit').length, 2, 'no unapproved inbound request reaches inference');
  } finally { await service.shutdown(); }
});
h.test('a completed friend request cannot prevent its owner from starting the next turn', async () => {
  const f = approvedFriendWireFixture(), client = new FakeClient().reply('session/start', { sessionId: 'completed-owner-live' })
    .replySubmit('start-if-idle', 'owner-next');
  const { service } = serviceWith(client, f.root);
  try {
    const row = await service.newSession({ friendScope: f.friendScope }) as Record<string, Json>, id = String(row.id);
    f.store.update('wire-owner', f.taskId, ['starting'], { status: 'completed', threadId: id });
    deactivateFriendSession(f.root, id);
    assertEqual(friendSessionScope(f.root, id)!.active, false, 'the previous request has ended');
    assert(friendConversationGrant(f.root, id, f.friendScope), 'conversation approval remains durable');
    await service.send(id, { text: 'Ask my friend what they did today' });
    assertEqual(client.sent('turn/submit').length, 1, 'the owner can continue after request completion');
  } finally { await service.shutdown(); }
});

h.test('live skill addition, editing and removal preserve the running session binding', async () => {
  const root = byoRoot(), discovery = new ExtensionDiscovery({ configRoot: root });
  const client = new FakeClient().reply('session/start', { sessionId: 'skills-live' })
    .replyAcknowledged('session/setSkills', { skillsUpdated: true });
  const { service, state } = serviceWith(client, root, undefined, { extensions: discovery });
  try {
    const session = await service.newSession() as Record<string, Json>, id = String(session.id);
    state.markTurnRunning(id, 'existing-turn');
    const directory = join(root, 'skills', 'live-skill'); mkdirSync(directory, { recursive: true });
    const path = join(directory, 'SKILL.md');
    writeFileSync(path, '---\nname: live-skill\ndescription: Added live\n---\nFirst body');
    discovery.invalidateSkills(); await service.publishSkillChanges();
    const added = rowAt(client.sent('session/setSkills'), 0, 'skill update');
    assert((added.skills as Record<string, Json>[]).some(skill => skill.name === 'live-skill' && skill.body === 'First body'), 'new skill reaches the existing engine session');
    writeFileSync(path, '---\nname: live-skill\ndescription: Edited live\n---\nSecond body');
    discovery.invalidateSkills(); await service.publishSkillChanges();
    const edited = rowAt(client.sent('session/setSkills'), 1, 'edited skill update');
    assert((edited.skills as Record<string, Json>[]).some(skill => skill.name === 'live-skill' && skill.body === 'Second body'), 'edited skill replaces the previous definition');
    rmSync(directory, { recursive: true }); discovery.invalidateSkills(); await service.publishSkillChanges();
    const removed = rowAt(client.sent('session/setSkills'), 2, 'removed skill update');
    assert(!(removed.skills as Record<string, Json>[]).some(skill => skill.name === 'live-skill'), 'removed skill is no longer published');
    await service.publishSkillChanges();
    assertEqual(client.sent('session/setSkills').length, 3, 'unchanged catalog does not publish duplicate updates');
    assertEqual(state.liveSession(id), 'skills-live', 'binding remains unchanged');
    assertEqual(state.runningTurnId(id), 'existing-turn', 'running turn identity remains unchanged');
    assertEqual(state.isStale(id), false, 'skill changes do not schedule a session rebuild');
    assertEqual(client.sent('session/close').length, 0, 'publication never closes the running session');
    assertEqual(client.sent('session/start').length, 1, 'publication never starts a replacement session');
  } finally { await service.shutdown(); }
});

h.test('turn admission retries failed skill publication and never silently uses an old catalog', async () => {
  const root = byoRoot(), discovery = new ExtensionDiscovery({ configRoot: root });
  const client = new FakeClient().reply('session/start', { sessionId: 'skills-admission' })
    .replySubmit('start-if-idle', 'skills-turn').replyAcknowledged('session/setSkills', { error: 'skill publication refused' });
  const { service, state } = serviceWith(client, root, undefined, { extensions: discovery });
  try {
    const session = await service.newSession() as Record<string, Json>, id = String(session.id);
    const directory = join(root, 'skills', 'next-turn'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), '---\nname: next-turn\ndescription: Newly installed\n---\nNew instructions');
    discovery.invalidateSkills();
    await assertRejects(() => service.publishSkillChanges(), 'rejected update stays observable');
    assert(!state.skillCatalog(id)?.skills.some(skill => object(skill)?.name === 'next-turn'), 'unconfirmed update is not recorded as applied');
    await assertRejects(() => service.send(id, { text: 'Use the installed skill' }), 'turn refuses stale skill state');
    assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no turn begins with a known failed catalog update');
    client.replyAcknowledged('session/setSkills', { skillsUpdated: true });
    await service.send(id, { text: 'Use the installed skill' });
    const lastUpdate = client.calls.map(call => call.method).lastIndexOf('session/setSkills');
    assert(lastUpdate < client.calls.findIndex(call => call.method === 'turn/submit' && (call.params as Record<string, Json>).mode === 'start-if-idle'), 'publication settles before turn start');
    assert(state.skillCatalog(id)?.skills.some(skill => object(skill)?.name === 'next-turn'), 'next admission records the confirmed replacement');
    assertEqual(client.sent('session/start').length, 1, 'retry preserves the original session');
  } finally { await service.shutdown(); }
});

h.test('queued continuation applies the latest skill catalog before admitting pending input', async () => {
  const root = byoRoot(), discovery = new ExtensionDiscovery({ configRoot: root });
  const client = new FakeClient().reply('session/start', { sessionId: 'queued-skills-live' })
    .replyAcknowledged('session/setSkills', { skillsUpdated: true })
    .reply('session/resumePending', { pendingResume: { started: true } });
  const { service, state } = serviceWith(client, root, undefined, { extensions: discovery });
  try {
    await service.resolveLiveSession('queued-skills-thread');
    const queue = { revision: 3, status: 'authoritative', items: [{ state: 'pending', mutable: true,
      message: { uuid: 'queued-skill-message', value: 'Use the new skill', mode: 'prompt', priority: 'next' } }] };
    client.reply('session/queueSnapshot', { queueSnapshot: queue }); state.installQueueSnapshot('queued-skills-thread', queue);
    state.markTurnRunning('queued-skills-thread', 'old-skills-turn');
    const directory = join(root, 'skills', 'queued-skill'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), '---\nname: queued-skill\ndescription: Available for queued input\n---\nNew queued instructions');
    discovery.invalidateSkills();
    client.emit('event', { type: 'turnCompleted', params: { sessionId: 'queued-skills-live', turnId: 'old-skills-turn', result: { stopReason: 'completed' } } });
    await waitFor(() => client.sent('session/resumePending').length === 1, 1000, 'queued skill admission');
    assertEqual(client.sent('session/setSkills').length, 1, 'queue admission publishes a missed background update');
    assert(client.calls.findIndex(call => call.method === 'session/setSkills') < client.calls.findIndex(call => call.method === 'session/resumePending'), 'the catalog is confirmed before queued inference');
    assertEqual(client.sent('session/close').length, 0, 'queued inference keeps its original writer');
  } finally { await service.shutdown(); }
});

h.test('explicit goal objectives activate dormant and retired chats through the ordinary configuration fences', async () => {
  for (const phase of ['dormant', 'retired']) {
    const root = byoRoot(), client = modelChangeClient().reply('session/close', {});
    const { service, state } = serviceWith(client, root);
    const queries = new SessionQueries(service, state, root);
    if (phase === 'retired') {
      await service.resolveLiveSession('thread');
      state.forgetSession('thread');
    }
    client.reply('engine/readSessionSummary', { session: { id: 'thread' } });
    client.reply('session/goal', { goalPursuitEligible: true, goalRevision: 0 });
    client.reply('session/setGoal', { threadGoal: { threadId: 'thread', goalId: 'generation', objective: 'Implement the reviewed objective', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAtMs: 1, updatedAtMs: 1 }, goalRevision: 1, goalAdmission: 'scheduled' });
    await queries.setGoal('thread', { objective: 'Implement the reviewed objective', submit: true, clientRequestId: `goal-${phase}`, expectedGoalId: null });
    assertEqual(state.liveSession('thread'), 'live', phase + ' thread is activated before explicit submission');
    const mutation = rowAt(client.sent('session/setGoal'), 0, 'goal mutation');
    assertEqual(mutation.sessionId, 'live', 'actual live identity');
    assertEqual(mutation.threadId, 'thread', 'persistent identity retained');
    assertEqual(mutation.origin, 'user', 'authentic explicit user provenance');
    assert(client.calls.findLastIndex(call => call.method === 'session/start') < client.calls.findIndex(call => call.method === 'session/setGoal'), 'provider configuration precedes goal admission');
    assertEqual(client.sentSubmit('start-if-idle').length, 0, 'only the engine admits the objective turn');
    await service.shutdown();
  }
});

h.test('a newly created local chat prepares its first goal before any model turn', async () => {
  const root = byoRoot(), client = modelChangeClient();
  const { service, state } = serviceWith(client, root), queries = new SessionQueries(service, state, root);
  const created = obj(await service.newSession()), id = String(created.id);
  assert(state.liveSession(id), 'session:new establishes the authoritative local binding before returning its row');
  await service.assertExistingWorkflowThread(id);
  client.reply('engine/readSessionSummary', { session: null });
  client.reply('session/goal', { goalPursuitEligible: true, goalRevision: 0 });
  await service.assertGoalPursuitEligible(id);
  const prepared = await queries.objectives.prepare(id, { text: 'First goal objective' });
  assertEqual(prepared.objective, 'First goal objective', 'a fresh local chat is eligible');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'preparation does not run the model');
  assertEqual(client.sent('engine/readSessionSummary').length, 1, 'an exact live lazy binding remains eligible before its saved rollout exists');
  await service.shutdown();
});

h.test('SSH workspace objective files remain on the single engine host', async () => {
  const root = byoRoot(), client = modelChangeClient();
  bindSessionWorkdir('ssh-thread', 'ssh://fixture-host/work/project', root);
  const { service, state } = serviceWith(client, root);
  const queries = new SessionQueries(service, state, root);
  assertEqual(await service.directory('ssh-thread'), 'ssh://fixture-host/work/project', 'actual workspace binding is remote');
  const png = join(root, 'local-image.png'); writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const prepared = await queries.objectives.prepare('ssh-thread', { text: 'Inspect the remote workspace', images: [{ path: png }], pastes: [{ text: 'Full reference text' }] });
  assert(prepared.objective.includes(join(root, 'goal-objectives')), 'owned objective files live on the actual engine host');
  assert(!prepared.objective.includes('ssh://'), 'host paths are never mislabeled as remote file paths');
  await service.resolveLiveSession('ssh-thread');
  const init = rowAt(client.sent('session/start'), 0, 'remote init').init as Record<string, Json>;
  assert(String(init.cwd).startsWith(root), 'remote workspace still uses a local engine directory');
  assert(String(init.developerInstructions).includes('fixture-host'), 'remote execution instructions retain the SSH target');
  await queries.objectives.discard('ssh-thread', prepared.preparationId!); await service.shutdown();
});

h.test('notification pending policy excludes its current terminal and correlates real queued claims without engine activation', async () => {
  const root = freshRoot(), client = new FakeClient(), { service, state } = serviceWith(client, root);
  const id = 'notification-root', notices: DesktopNotice[] = [];
  await service.client();
  state.rememberSession(id, 'notification-engine', {}); state.markTurnRunning(id, 'core-P', 'P');
  let policyChecks = 0;
  const policy = (owner: string, terminal: string, active: Array<{ parentId: string; id: string }> = []): boolean => {
    const calls = client.calls.length + client.queue.calls.length;
    const pending = service.hasPendingNotificationWork(owner, terminal, active);
    assertEqual(client.calls.length + client.queue.calls.length, calls, 'notification policy never activates, reads or mutates the engine');
    policyChecks++;
    return pending;
  };
  assert(policy(id, 'P'), 'missing engine mirror is unknown rather than empty');
  state.installQueueSnapshot(id, { revision: 1, status: 'authoritative', items: [] });
  const tracker = new AgentTaskTracker();
  const notifications = new DesktopNotifications({ focused: () => false, setting: () => undefined, rendererId: () => id,
    isPrivate: () => false, isBackground: () => false, show: row => notices.push(row), sound: () => {}, log: () => {},
    pendingPresentation: (owner, terminal) => policy(owner, terminal, tracker.activeConversations()) });
  const notify = (submissionId: string, core: string): void => {
    notifications.observeEngine({ type: 'productEvent', method: 'turn/started', params: { sessionId: 'notification-engine', submissionId, detail: { turnId: core } } });
    notifications.observeEngine({ type: 'turnCompleted', params: { sessionId: 'notification-engine', turnId: submissionId, terminalNotificationDisposition: 'inherit', result: { stopReason: 'completed', finalText: `Done ${submissionId}` } } });
  };
  notify('P', 'core-P'); assertEqual(notices.length, 1, 'still-working current terminal does not self-suppress');
  const unconfirmed = async (itemId: string, submissionId: string): Promise<void> => {
    await service.clientQueueAdd(id, { id: itemId, item: queueItem(itemId) });
    const row = client.queue.document(id).rows.find(row => row.clientUserMessageId === itemId)!;
    client.queue.admit = async () => { throw { kind: 'timeout', method: 'thread/queue/start' }; };
    await assertRejects(() => client.queue.request('thread/queue/start', { threadId: id, queuedSubmissionId: row.id, submissionId, mode: 'start-if-idle' }), 'fixture retains an actual unknown engine admission');
    await service.clientQueueSnapshot(id);
  };
  await unconfirmed('own', 'S');
  state.markTurnRunning(id, 'core-S', 'S');
  const ownedSnapshot = structuredClone(client.queue.document(id).rows); notify('S', 'core-S');
  assertEqual(notices.length, 2, 'own correlated unconfirmed claim does not hide its terminal');
  assertDeepEqual(client.queue.document(id).rows, ownedSnapshot, 'notification policy does not mutate the engine-owned receipt');
  await service.clientQueueRemove(id, 'own');
  await unconfirmed('other', 'other-S');
  state.markTurnRunning(id, 'core-T', 'T'); notify('T', 'core-T');
  assertEqual(notices.length, 2, 'another unconfirmed claim remains pending');
  await service.clientQueueRemove(id, 'other');
  await service.clientQueueAdd(id, { id: 'paused', item: queueItem('paused') });
  await client.queue.request('thread/queue/pause', { threadId: id, reason: 'Paused' });
  await service.clientQueueSnapshot(id);
  assertEqual(policy(id, 'T'), false, 'paused durable queue head is not runnable');
  state.installQueueSnapshot(id, { revision: 2, status: 'authoritative', items: [{ state: 'pending', message: { priority: 'next', value: 'next input' } }] });
  assert(policy(id, 'T'), 'actual runnable engine queue preserves pending policy');
  state.installQueueSnapshot(id, { revision: 3, status: 'authoritative', items: [] });
  tracker.reconcile(id, { child: { id: 'child', agentId: 'actual-agent', status: 'running', isBackground: true } });
  assert(policy(id, 'T', tracker.activeConversations()), 'real task tracker rows retain ancestor ownership without a Goal');
  tracker.reconcile(id, { child: { id: 'child', agentId: 'actual-agent', status: 'completed' } });
  assertEqual(policy(id, 'T', tracker.activeConversations()), false, 'completed actual task releases the independent gate');
  assert(policyChecks >= 7, 'every notification policy read is checked for zero engine or provider RPCs');
  notifications.close(); await service.shutdown();
});

h.test('a cold persisted conversation retains its previous source before saving a model change', async () => {
  const root = byoRoot(), client = new FakeClient()
    .reply('engine/readSessionSummary', { session: { id: 'cold-thread' } })
    .reply('session/start', { sessionId: 'retained-source' });
  setSessionModel('cold-thread', 'custom:large-source', 'custom', root);
  const { service, state } = serviceWith(client, root), changes: string[] = [];
  const composer = new ComposerService({ configRoot: root, request: async () => ({}), push: () => {},
    beforeSessionModelChange: id => service.prepareModelChange(id),
    onSessionConfigChanged: change => { changes.push(readSessionModel(change.sessionId!, root).mode); } });
  try {
    await composer.setModel({ sessionId: 'cold-thread', mode: 'custom:small-source', source: 'custom' });
    const started = rowAt(client.sent('session/start'), 0, 'old source start');
    assertEqual(object(started.init)?.modelSelection, 'custom:large-source', 'the resume captures the saved old model');
    assertEqual(state.liveSession('cold-thread'), 'retained-source', 'publication can now retain the old inference bundle');
    assertEqual(readSessionModel('cold-thread', root).mode, 'custom:small-source', 'the requested selection is then saved');
    assertDeepEqual(changes, ['custom:small-source'], 'the existing publication callback sees the new selection');
    await service.prepareModelChange('cold-thread');
    assertEqual(client.sent('session/start').length, 1, 'an existing live binding is reused');
  } finally { await service.shutdown(); }
});

h.test('model preparation does not initialize default-only or missing draft conversations', async () => {
  const root = byoRoot(), client = new FakeClient().reply('engine/readSessionSummary', { session: null });
  const { service } = serviceWith(client, root);
  try {
    await service.prepareModelChange(''); await service.prepareModelChange('__draft'); await service.prepareModelChange('not-persisted');
    assertEqual(client.sent('session/start').length, 0, 'only persisted conversations can initialize an old source');
    assertEqual(client.sent('engine/readSessionSummary').length, 1, 'internal and empty identities do not query the engine');
  } finally { await service.shutdown(); }
});

h.test('an unavailable previous source does not prevent selecting another provider', async () => {
  const root = byoRoot(), client = new FakeClient().reply('engine/readSessionSummary', { session: { id: 'cold-thread' } }).failWith('session/start');
  const diagnostics: string[] = [];
  const { service, pushed } = serviceWith(client, root, undefined, { log: kind => { diagnostics.push(kind); } });
  setSessionModel('cold-thread', 'custom:unavailable-source', 'custom', root);
  const composer = new ComposerService({ configRoot: root, request: async () => ({}), push: () => {},
    beforeSessionModelChange: id => service.prepareModelChange(id), onSessionConfigChanged: () => {} });
  try {
    await composer.setModel({ sessionId: 'cold-thread', mode: 'custom:replacement-source', source: 'custom' });
    assertEqual(readSessionModel('cold-thread', root).mode, 'custom:replacement-source', 'old credentials cannot trap the picker');
    assert(diagnostics.includes('model-context-source-unavailable'), 'failed preparation remains diagnosable');
    assert(!pushed.some(event => object(event)?.type === 'api_error'), 'best-effort preparation adds no startup error to the transcript');
  } finally { await service.shutdown(); }
});

h.test('model changes recheck request ownership after asynchronous source preparation', async () => {
  const root = byoRoot();
  setSessionModel('thread', 'custom:original-source', 'custom', root);
  let cancelled = false;
  const composer = new ComposerService({ configRoot: root, request: async () => ({}), push: () => {},
    beforeSessionModelChange: async () => { cancelled = true; }, onSessionConfigChanged: () => {} });
  await assertRejects(() => composer.setModel({ sessionId: 'thread', mode: 'custom:new-source', source: 'custom' },
    () => { if (cancelled) throw new Error('Request owner was retired'); }), 'cancelled owner cannot save a selection');
  assertEqual(readSessionModel('thread', root).mode, 'custom:original-source', 'the original preference survives');
});



h.test('notice conversations publish their group before a turn and accept ordinary owner input', async () => {
  const root=byoRoot(), group={accountId:'owner',friendshipId:'friend-one',friendUserId:'peer'};
  const client=new FakeClient().reply('session/start',{sessionId:'notice-live'}).replyAcknowledged('session/updateTitle',{title:{title:'Peer'}}).replySubmit('start-if-idle');
  const published:Record<string,Json>[]=[];
  const {service}=serviceWith(client,root,undefined,{friendAccountId:()=>group.accountId,onThreadRow:row=>published.push(row)});
  try {
    const row=object(await service.newSession({title:'Peer',friendConversationGroup:group}))!;
    const id=String(row.id);
    assertEqual(row.friendGroupId,group.friendshipId,'the initial row belongs to the friend');
    assertEqual(published.find(value=>value.id===id)?.friendGroupId,group.friendshipId,'the first published row is grouped');
    assertEqual(friendSessionScope(root,id),undefined,'grouping creates no friend task scope');
    await service.send(id,{text:'Summarize this notice into my local todo list.'});
    assertEqual(client.sentSubmit('start-if-idle').length,1,'the owner can start a local task');
    assertEqual(object(object(client.sent('session/start')[0])?.init)?.taskResourceScope,undefined,'no task resource scope is attached');
  } finally { await service.shutdown(); }
});

h.test('catalog recovers old notice groups and removes cached ownership after an account switch', async () => {
  const root=freshRoot(), messages=new FriendMessageStore(root);
  let accountId:string|undefined='owner';
  const metadata={externalFriendMessage:true,friendIntent:'notice',sender:{friendshipId:'friend-one',userId:'peer'}};
  messages.append({accountId:'owner',sessionId:'legacy-notice',id:'first-notice',timestamp:100,text:'A notice',metadata});
  messages.append({accountId:'owner',sessionId:'ordinary',id:'linked-notice',timestamp:100,text:'A reply',metadata:{...metadata,replyToMessageId:'original-request'}});
  const client=new FakeClient().reply('engine/listSessions',{sessions:{items:[
    {id:'legacy-notice',title:'Peer',createdAt:1,updatedAt:2},
    {id:'ordinary',title:'My project task',createdAt:1,updatedAt:2},
  ],nextCursor:null}});
  const {service}=serviceWith(client,root,undefined,{friendAccountId:()=>accountId});
  const find=(rows:Json[],id:string)=>object(rows.find(row=>object(row)?.id===id))!;
  try {
    const rows=await service.listSessions();
    assertEqual(find(rows,'legacy-notice').friendGroupId,'friend-one','old notice is recovered into the friendship');
    assertEqual(find(rows,'ordinary').friendGroupId,undefined,'linked replies do not move the original chat');
    accountId='other-owner';
    const cached={...find(rows,'legacy-notice')};
    client.reply('engine/listSessions',{sessions:{items:[cached],nextCursor:null}});
    assertEqual(find(await service.listSessions(),'legacy-notice').friendGroupId,undefined,'cached group is not exposed to another account');
    accountId=undefined;
    assertEqual(find(await service.listSessions(),'legacy-notice').friendGroupId,undefined,'signed-out lists do not retain the group');
  } finally { await service.shutdown(); }
});

function seedFriendConsumer(client:FakeClient,originTurnId:string) {
  const saved={threadId:'thread',history:[{type:'user',uuid:'original-input',content:[{type:'text',text:'Resolve A and inspect B.'}]}],historyTurnIds:{'original-input':originTurnId},turnFinalMessageIds:{},turnStatuses:{},turnStartedAtMs:{},turnFinishedAtMs:{},turnDurations:{},turnCancelledTools:{},turnErrors:{},turnErrorKinds:{},agentNotifications:[]};
  client.capabilities={taskIdentity:true};
  client.reply('engine/readThreadHistory',saved).reply('session/taskIdentity',{taskIdentity:{taskId:'consumer',generation:'instance',fingerprint:'requirements',status:'pending'}}).reply('session/goal',{threadGoal:null,goalRevision:0});
  return saved;
}

h.test('friend continuations bind saved history to the engine turn while steering with the submission identity', async () => {
  const identity = (JSON.parse(readFileSync(vectorPath('friends-messaging-vectors.json'), 'utf8')) as {
    asyncInteraction: { continuationIdentity: { engineTurnId: string; submissionId: string } };
  }).asyncInteraction.continuationIdentity;
  const client = new FakeClient().reply('engine/readSessionSummary', {session:{id:'thread'}})
    .reply('session/history',{history:[]}).reply('session/queueSnapshot',{queueSnapshot:{items:[]}}).replySubmit('steer');
  seedFriendConsumer(client,identity.engineTurnId);
  const {service,state}=serviceWith(client,byoRoot());
  await service.client();
  state.rememberSession('thread','live',{}, {source:'custom',selection:'custom:fixture'});
  state.markTurnRunning('thread',identity.submissionId);
  const pump = new SessionEventPump({state,currentGeneration:()=>1,emit:()=>{},log:()=>{},
    forwarder:new ChatEventForwarder(()=>{})});
  try {
    assert(identity.engineTurnId !== identity.submissionId,'the fixture uses distinct history and submission identities');
    pump.receive({type:'productEvent',method:'turn/started',params:{sessionId:'live',
      submissionId:identity.submissionId,detail:{type:'turn.started',turnId:identity.engineTurnId}}},1);
    const association=await service.captureFriendContinuation('thread','aliased-reply','consumer');
    assertEqual(association.taskId,identity.engineTurnId,'the persisted origin matches saved history');
    const result=await service.deliverFriendFollowUp('thread',{id:'aliased-reply',originTurnId:association.taskId,text:'Result A',association});
    assertEqual(result.admitted,true,'the original engine turn accepts the result');
    const steered=rowAt(client.sentSubmit('steer'),0,'friend reply steer');
    assertEqual(steered.expectedTurnId,identity.submissionId,'wire admission retains its submission fence');
    assertEqual(client.sentSubmit('steer').length,1,'the result is admitted once');
    assertEqual(client.sentSubmit('start-if-idle').length,0,'a running turn does not start a duplicate turn');
  } finally { await service.shutdown(); }
});

h.test('friend follow-ups distinguish the original running turn from unrelated work', async () => {
  for (const same of [true, false]) {
    const client = new FakeClient().reply('engine/readSessionSummary', {session:{id:'thread'}}).reply('session/history',{history:[]}).reply('session/queueSnapshot',{queueSnapshot:{items:[]}}).replySubmit('steer');
    seedFriendConsumer(client,'original');
    const {service,state}=serviceWith(client,byoRoot());await service.client();
    state.rememberSession('thread','live',{}, {source:'custom',selection:'custom:fixture'});state.markTurnRunning('thread','original','original-submission');
    const association=await service.captureFriendContinuation('thread','reply-event','consumer');
    state.markTurnRunning('thread',same?'original':'other',same?'original-submission':'other-submission');
    const result=await service.deliverFriendFollowUp('thread',{id:'reply-event',originTurnId:'original',text:'Result A',association});
    assertEqual(result.admitted,same,'only the original task accepts mid-turn input');
    assertEqual(client.sentSubmit('steer').length,same?1:0,'unrelated turn receives no external result');
    if(same)assertEqual(object(client.sentSubmit('steer')[0])?.submissionId,'steer-friend-follow-up-reply-event','stable steer identity');
    await service.shutdown();
  }
});
h.test('friend follow-up replay recognizes consumed history and pending queue identities',async()=>{
  for(const source of ['history','queue']){
    const client=new FakeClient().reply('engine/readSessionSummary',{session:{id:'thread'}})
      .reply('session/history',source==='history'?{history:[{subtype:'user_display',text:JSON.stringify({friendFollowUpId:'event'})}]}:{history:[]})
      .reply('session/queueSnapshot',{queueSnapshot:{items:source==='queue'?[{message:{uuid:'friend-follow-up-event'}}]:[]}});
    const {service,state}=serviceWith(client,byoRoot());await service.client();state.rememberSession('thread','live',{}, {source:'custom',selection:'custom:fixture'});
    assertEqual((await service.deliverFriendFollowUp('thread',{id:'event',originTurnId:null,text:'A'})).admitted,true,'replay is already admitted');
    assertEqual(client.sentSubmit('start-if-idle').length,0,'no duplicate idle turn');assertEqual(client.sentSubmit('steer').length,0,'no duplicate steer');
    await service.shutdown();
  }
});
h.test('friend idle follow-up has a stable turn identity and checks cancellation immediately before admission',async()=>{
  for(const cancelled of [false,true]){
    let current=true;
    const client=new FakeClient().reply('engine/readSessionSummary',{session:{id:'thread'}}).reply('session/history',{history:[]}).reply('session/queueSnapshot',{queueSnapshot:{items:[]}}).replySubmit('start-if-idle');
    seedFriendConsumer(client,'old-turn');
    const {service,state}=serviceWith(client,byoRoot(),undefined,{messageInput:async text=>{if(cancelled)current=false;return [{type:'text',text}];}});
    await service.client();state.rememberSession('thread','live',{}, {source:'custom',selection:'custom:fixture'});state.markTurnRunning('thread','old-turn','old-submission');
    const association=await service.captureFriendContinuation('thread','idle-event','consumer');state.clearTurnRunning('thread');
    const run=()=>service.deliverFriendFollowUp('thread',{id:'idle-event',originTurnId:'old-turn',text:'A',association,assertCurrent(){if(!current)throw Error('cancelled before admission');}});
    if(cancelled)await assertRejects(run,'cancelled authorization prevents issue');else assertEqual((await run()).admitted,true,'idle related turn admitted');
    assertEqual(client.sentSubmit('start-if-idle').length,cancelled?0:1,'cancellation checked at issue');
    if(!cancelled)assertEqual(object(client.sentSubmit('start-if-idle')[0])?.submissionId,'friend-follow-up-idle-event','stable idle submission');
    await service.shutdown();
  }
});
h.test('owner corrections delay friend admission until the consuming step is reconciled',async()=>{
  for(const completed of [false,true]){
    const client=new FakeClient().reply('engine/readSessionSummary',{session:{id:'thread'}}).reply('session/history',{history:[]}).reply('session/queueSnapshot',{queueSnapshot:{items:[]}}).replySubmit('steer').replySubmit('start-if-idle');
    const saved=seedFriendConsumer(client,'original');
    const {service,state}=serviceWith(client,byoRoot());await service.client();state.rememberSession('thread','live',{}, {source:'custom',selection:'custom:fixture'});state.markTurnRunning('thread','original','original-submission');
    try{
      await assertRejects(()=>service.captureFriendContinuation('thread','step'),'a missing consuming task cannot be inferred');
      const association=await service.captureFriendContinuation('thread','step','consumer');
      client.reply('session/queueSnapshot',{queueSnapshot:{items:[{state:'pending',message:{priority:'now',uuid:'owner-update'}}]}});
      assertEqual((await service.deliverFriendFollowUp('thread',{id:'event',originTurnId:'original',text:'A result',association})).admitted,false,'queued owner input is handled before external work');
      client.reply('session/queueSnapshot',{queueSnapshot:{items:[]}});
      client.reply('engine/readThreadHistory',{...saved,history:[...saved.history,{type:'user',uuid:'owner-update',content:[{type:'text',text:completed?'A is complete; continue B.':'Add another check to B.'}]}],historyTurnIds:{...saved.historyTurnIds,'owner-update':'original'}});
      const request={id:'event',originTurnId:'original',text:'A result',association};
      await assertRejects(()=>service.deliverFriendFollowUp('thread',request),'the active owner update is processed first');
      assertEqual(client.sentSubmit('steer').length,0,'the correction receives no external injection');
      state.clearTurnRunning('thread');
      if(completed)client.reply('session/taskIdentity',{taskIdentity:{taskId:'consumer',generation:'instance',fingerprint:'requirements',status:'completed'}});
      const result=await service.deliverFriendFollowUp('thread',request);
      assertEqual(result.admitted,!completed,'only a still-unresolved consuming step continues after owner processing');
      assertEqual(client.sentSubmit('start-if-idle').length,completed?0:1,'an unrelated B update delays but does not cancel A');
      const legacy=await service.deliverFriendFollowUp('thread',{id:'legacy',originTurnId:'original',text:'Old result'});
      assertEqual(legacy.obsolete,true,'unbound legacy work remains display-only');
    }finally{await service.shutdown();}
  }
});
h.test('friend continuation rechecks the exact consuming task and original saved input',async()=>{
  for(const change of ['none','completed','edited-input','edited-task','recycled-task']){
    const saved=(text:string)=>({threadId:'thread',history:[{type:'user',uuid:'original-input',content:[{type:'text',text}]}],historyTurnIds:{'original-input':'original-turn'},
      turnFinalMessageIds:{},turnStatuses:{},turnStartedAtMs:{},turnFinishedAtMs:{},turnDurations:{},turnCancelledTools:{},turnErrors:{},turnErrorKinds:{},agentNotifications:[]});
    const identity={taskId:'consumer',generation:'task-incarnation',fingerprint:'task-semantic-content',status:'pending',subject:'Resolve A',description:'Use the friend result'};
    const client=new FakeClient().reply('engine/readSessionSummary',{session:{id:'thread'}})
      .reply('engine/readThreadHistory',saved('Resolve A and independently inspect B.'))
      .reply('session/taskIdentity',{taskIdentity:identity}).reply('session/goal',{threadGoal:null,goalRevision:0})
      .reply('session/history',{history:[]}).reply('session/queueSnapshot',{queueSnapshot:{items:[]}}).replySubmit('start-if-idle');
    client.capabilities={taskIdentity:true};
    const {service,state}=serviceWith(client,byoRoot());await service.client();
    state.rememberSession('thread','live',{}, {source:'custom',selection:'custom:fixture'});state.markTurnRunning('thread','original-turn','original-submission');
    try{
      const association=await service.captureFriendContinuation('thread','external-step','consumer');
      assertEqual(association.stepId,'external-step','the host owns the request step identity');
      state.clearTurnRunning('thread');
      if(change==='completed')client.reply('session/taskIdentity',{taskIdentity:{...identity,status:'completed'}});
      if(change==='edited-task')client.reply('session/taskIdentity',{taskIdentity:{...identity,fingerprint:'new-requirements'}});
      if(change==='recycled-task')client.reply('session/taskIdentity',{taskIdentity:{...identity,generation:'different-incarnation'}});
      if(change==='edited-input')client.reply('engine/readThreadHistory',saved('A was replaced with another request.'));
      if(change==='none')client.reply('engine/readThreadHistory',{...saved('Resolve A and independently inspect B.'),history:[
        ...saved('Resolve A and independently inspect B.').history,
        {type:'user',uuid:'other-input',content:[{type:'text',text:'An unrelated later task.'}]},
      ],historyTurnIds:{'original-input':'original-turn','other-input':'later-turn'}});
      const result=await service.deliverFriendFollowUp('thread',{id:'reply-event',originTurnId:'original-turn',text:'Result A',association});
      assertEqual(result.admitted,change==='none','only unchanged unresolved work is admitted');
      assertEqual(client.sentSubmit('start-if-idle').length,change==='none'?1:0,'obsolete work starts no model turn');
      if(change!=='none')assertEqual(result.obsolete,true,'obsolete association closes automatic continuation');
    }finally{await service.shutdown();}
  }
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'session-wire-result.json'), 'session-wire');
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A temp dir that will not delete is not a test failure.
    }
  }
  process.exit(failed);
})();
