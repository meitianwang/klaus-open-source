import type { ClientEvent } from '../main/engine/protocol';
import type { TerminalNotificationDisposition } from '../contracts/planning-goals';
import type { Json } from '../main/ipc/contract';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeNotifications, NotificationAuthorization, notificationGroup, notificationProbeRequested, parseNotificationGroup, type NativeNotificationApi, type NativeNotificationHandle, type NativeNotificationOptions, type NotificationTarget } from '../main/app/notifications';
import { ChatEventForwarder, SessionEventPump } from '../main/sessions/events';
import { HostState } from '../main/services/host-state';
import { DesktopNotifications, goalContinuationDecision, terminalNotificationDisposition, notificationBody, notificationSummary, type DesktopNotice } from '../main/services/notifications';
import { object } from '../main/services/service-types';
import { hasActiveNotificationDescendant, notificationQueuePending } from '../main/services/notification-pending';
import { notificationToEvent } from '../main/engine/protocol';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';

const h = new Harness();
function fixture(rendererId: (id: string) => string | undefined = id => id === 'engine' ? 'thread' : id === 'private-engine' ? 'private-thread' : undefined) {
  const notices: DesktopNotice[] = [], sounds: string[] = [], logs: string[] = [], settings = new Map<string, string>();
  const broadcasts: Array<{ channel: string; payload: Json }> = [];
  const mobile: Array<{ id: string; turnId: string; failed: boolean }> = [];
  let focused = false, background = false, failDisplay = false, pending = false;
  const pendingReads: Array<{ id: string; turnId: string }> = [];
  const service = new DesktopNotifications({ focused: () => focused, setting: key => settings.get(key),
    rendererId, isBackground: () => background, isPrivate: id => id === 'private-thread',
    show: notice => { if (failDisplay) throw new Error('OS denied banner'); notices.push(notice); }, sound: kind => sounds.push(kind), log: message => logs.push(message),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    mobileOutcome: (id, turnId, failed) => mobile.push({ id, turnId, failed }),
    pendingPresentation: (id, turnId) => { pendingReads.push({ id, turnId }); return pending; },
  });
  const start = (submission = 'submission', turn = 'actual', goalId?: string) => service.observeEngine({ type: 'productEvent', method: 'turn/started', params: { sessionId: 'engine', submissionId: submission, detail: { turnId: turn, ...(goalId ? { goalContinuation: true, inputOrigin: 'automatic', goalId } : {}) } } });
  const finish = (reason = 'completed', text = 'Finished work', id = 'submission', disposition?: TerminalNotificationDisposition) => service.observeEngine({ type: 'turnCompleted', params: { sessionId: 'engine', turnId: id, ...(disposition ? { terminalNotificationDisposition: disposition } : {}), result: { stopReason: reason, finalText: text } } });
  const decision = (value: { decisionId: string; priorSubmissionId: string; sessionId?: string; goalId?: string; successorSubmissionId?: string; pending: boolean; continued?: boolean; priorCompletionNotificationDisposition?: TerminalNotificationDisposition }) => service.observeEngine({ type: 'productEvent', method: 'goal.continuation', params: { sessionId: 'engine',
    ...(!value.pending ? { priorCompletionNotificationDisposition: value.continued ? 'suppress' : 'inherit' } : {}), ...value } });
  return { service, notices, sounds, mobile, logs, settings, broadcasts, start, finish, decision, pendingReads, pending: (value: boolean) => { pending = value; },
    focus: (value: boolean) => { focused = value; }, background: (value: boolean) => { background = value; }, failDisplay: () => { failDisplay = true; } };
}
h.test('live task outcome uses its persisted title and one Unicode-safe summary', () => {
  const f = fixture(); f.service.remember({ id: 'thread', title: '  Migration\nreview ' }); f.start(); f.finish('completed', '  Added\n tests\t😀 ');
  assertDeepEqual(f.notices, [{ title: 'Migration review', subtitle: 'Task completed', body: 'Added tests 😀', sessionId: 'thread' }], 'task context retained');
  assertDeepEqual(f.sounds, ['done'], 'bare sound identity');
  assertEqual([...notificationSummary('😀'.repeat(200))].length, 180, 'Unicode code points bounded');
  assert(notificationSummary('😀'.repeat(200)).endsWith('…'), 'truncation is explicit');
});
h.test('a reserved goal successor suppresses completion only after actual admission', () => {
  const f = fixture(); f.start();
  const common = { decisionId: 'decision', priorSubmissionId: 'submission', goalId: 'generation', successorSubmissionId: 'next' };
  f.decision({ ...common, pending: true }); f.finish('completed', 'Intermediate progress');
  assertEqual(f.notices.length, 0, 'ongoing goal is not reported achieved');
  assertEqual(f.sounds.length, 0, 'no completion sound between goal turns');
  assertEqual(f.mobile.length, 0, 'mobile completion is held with the desktop outcome');
  f.start('next', 'next-turn', 'generation'); f.decision({ ...common, pending: false, continued: true });
  f.finish('completed', 'Objective achieved', 'next');
  assertEqual(f.notices[0]?.body, 'Objective achieved', 'true terminal outcome remains visible');
  assertDeepEqual(f.mobile, [{ id: 'thread', turnId: 'next', failed: false }], 'only final admitted work completes');
});

h.test('a refused reserved successor releases the captured ordinary completion exactly once', () => {
  const f = fixture(); f.start();
  const common = { decisionId: 'refused', priorSubmissionId: 'submission', goalId: 'generation' };
  f.decision({ ...common, pending: true }); f.finish('completed', 'Saved the changes');
  f.finish('completed', 'Duplicate core result', 'actual');
  f.decision({ ...common, pending: false, continued: false });
  f.decision({ ...common, pending: false, continued: false });
  f.decision({ ...common, pending: true });
  assertDeepEqual(f.notices.map(row => row.body), ['Saved the changes'], 'refusal restores the real predecessor outcome');
  assertDeepEqual(f.sounds, ['done'], 'one ordinary completion cue');
  assertDeepEqual(f.mobile, [{ id: 'thread', turnId: 'submission', failed: false }], 'mobile uses captured predecessor identity');
});
h.test('resolved decisions arriving before their predecessor terminal result preserve the decision', () => {
  for (const continued of [false, true]) {
    const f = fixture(); f.start();
    const common = { decisionId: 'early', priorSubmissionId: 'submission' };
    f.decision({ ...common, pending: true }); f.decision({ ...common, pending: false, continued }); f.finish();
    assertEqual(f.notices.length, continued ? 0 : 1, `early resolution continued=${continued}`);
    f.service.observeEngine({ type: 'streamClosed' });
    assertEqual(f.notices.length, continued ? 0 : 1, 'settled predecessor has no orphan task on disconnect');
  }
});
h.test('absence of a continuation decision leaves ordinary completion policy intact', () => {
  const reasons = ['feature disabled', 'Plan-only work', 'queued human input', 'blocked goal', 'complete goal', 'no goal'];
  for (const reason of reasons) {
    const f = fixture(); f.start();
    f.service.observeEngine({ type: 'sessionEvent', params: { sessionId: 'engine', event: { threadGoal: { goalId: 'generation', status: 'active' } } } });
    f.finish('completed', reason);
    assertEqual(f.notices[0]?.body, reason, `${reason} without a reserved successor remains visible`);
    assertEqual(f.mobile.length, 1, 'ordinary mobile outcome remains visible');
  }
  const empty = fixture(); empty.start(); empty.finish('completed', '');
  assertEqual(empty.notices.length + empty.mobile.length, 0, 'an empty no-progress final remains ordinarily quiet');
});
h.test('decision vectors reject ambiguous resolutions without suppressing ordinary completion', () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/planning-goals-vectors.json'), 'utf8')) as {
    goalContinuation: { cases: Array<{ value: unknown; valid: boolean }> };
  };
  for (const row of vectors.goalContinuation.cases) {
    assertEqual(!!goalContinuationDecision(row.value), row.valid, 'decision codec matches committed vector');
    if (row.valid) continue;
    const f = fixture(); f.start();
    f.service.observeEngine({ type: 'productEvent', method: 'goal.continuation', params: row.value as never }); f.finish();
    assertEqual(f.notices.length, 1, 'invalid event never creates a hold');
  }
});
h.test('a replacement turn and late decisions cannot release an old completion into new work', () => {
  const f = fixture(); f.start();
  const old = { decisionId: 'old-decision', priorSubmissionId: 'submission', goalId: 'old-goal' };
  f.decision({ ...old, pending: true }); f.finish('completed', 'Old result');
  f.start('human', 'human-core');
  f.decision({ ...old, pending: false, continued: false }); f.decision({ ...old, pending: true });
  f.finish('completed', 'New result', 'human');
  assertDeepEqual(f.notices.map(row => row.body), ['New result'], 'old decision never completes replacement work');
});
h.test('late resolution identities cannot settle a newer decision or another goal generation', () => {
  const f = fixture(); f.start();
  const old = { decisionId: 'old', priorSubmissionId: 'submission', goalId: 'old-goal' };
  f.decision({ ...old, pending: true }); f.finish('completed', 'Old result');
  f.start('next', 'next-core', 'new-goal');
  const next = { decisionId: 'new', priorSubmissionId: 'next', goalId: 'new-goal', successorSubmissionId: 'after' };
  f.decision({ ...next, pending: true }); f.finish('completed', 'New result', 'next');
  f.decision({ ...old, pending: false, continued: false });
  f.decision({ ...next, goalId: 'old-goal', pending: false, continued: false });
  f.decision({ ...next, successorSubmissionId: 'wrong-successor', pending: false, continued: false });
  assertEqual(f.notices.length, 0, 'unrelated decisions cannot release the current hold');
  f.decision({ ...next, pending: false, continued: false });
  assertDeepEqual(f.notices.map(row => row.body), ['New result'], 'only the exact current decision can release');
});
h.test('the session event pump rejects a prior engine generation before notification observation', () => {
  const f = fixture(), state = new HostState();
  state.rememberSession('thread', 'engine', {});
  let generation = 1;
  const forwarder = new ChatEventForwarder(() => {});
  const pump = new SessionEventPump({ state, forwarder, emit: () => {}, log: () => {}, currentGeneration: () => generation,
    observe: event => f.service.observeEngine(event) });
  const emit = (event: ClientEvent, sourceGeneration = generation) => pump.receive(event, sourceGeneration);
  const pending: ClientEvent = { type: 'productEvent', method: 'goal.continuation', params: { sessionId: 'engine', decisionId: 'same-wire-id', priorSubmissionId: 'submission', pending: true } };
  emit({ type: 'productEvent', method: 'turn/started', params: { sessionId: 'engine', submissionId: 'submission' } }); emit(pending);
  emit({ type: 'turnCompleted', params: { sessionId: 'engine', turnId: 'submission', result: { stopReason: 'completed', finalText: 'Old engine result' } } });
  f.service.resetEngine(); generation = 2;
  emit({ type: 'productEvent', method: 'turn/started', params: { sessionId: 'engine', submissionId: 'submission' } }); emit(pending);
  emit({ type: 'turnCompleted', params: { sessionId: 'engine', turnId: 'submission', result: { stopReason: 'completed', finalText: 'New engine result' } } });
  const refused: ClientEvent = { type: 'productEvent', method: 'goal.continuation', params: { sessionId: 'engine', decisionId: 'same-wire-id', priorSubmissionId: 'submission', pending: false, continued: false, priorCompletionNotificationDisposition: 'inherit' } };
  emit(refused, 1); assertEqual(f.notices.length, 0, 'stale stream cannot release a reused decision identity');
  emit(refused, 2); assertDeepEqual(f.notices.map(row => row.body), ['New engine result'], 'current stream can resolve its own decision');
  forwarder.close();
});
h.test('an admitted decision cannot be downgraded by a contradictory late refusal', () => {
  const f = fixture(); f.start();
  const common = { decisionId: 'admitted', priorSubmissionId: 'submission' };
  f.decision({ ...common, pending: true }); f.decision({ ...common, pending: false, continued: true });
  f.decision({ ...common, pending: false, continued: false }); f.finish();
  assertEqual(f.notices.length, 0, 'confirmed admission stays silent');
});
h.test('explicit interruption, forget, reset and close silently discard held predecessor completions', () => {
  for (const teardown of ['interrupted', 'forget', 'resetEngine', 'close'] as const) {
    const f = fixture(); f.start();
    const common = { decisionId: teardown, priorSubmissionId: 'submission' };
    f.decision({ ...common, pending: true }); f.finish();
    if (teardown === 'interrupted' || teardown === 'forget') f.service[teardown]('thread'); else f.service[teardown]();
    f.decision({ ...common, pending: false, continued: false }); f.service.observeEngine({ type: 'streamClosed' });
    assertEqual(f.notices.length + f.mobile.length, 0, `${teardown} remains quiet`);
  }
});
h.test('unexpected disconnect reports a held predecessor as engine failure once', () => {
  for (const body of ['', 'Intermediate work']) {
    const f = fixture(); f.start(); f.decision({ decisionId: 'pending', priorSubmissionId: 'submission', pending: true }); f.finish('completed', body);
    f.service.observeEngine({ type: 'streamClosed' }); f.service.observeEngine({ type: 'streamClosed' });
    assertEqual(f.notices[0]?.subtitle, 'Task failed', 'engine exit does not release success');
    assertEqual(f.notices[0]?.body, 'The engine connection closed unexpectedly. Please retry.', 'existing failure message retained');
    assertDeepEqual(f.mobile, [{ id: 'thread', turnId: 'submission', failed: true }], 'owned mobile failure occurs once even without predecessor final text');
  }
});
h.test('unexpected disconnect owns an active successor once rather than failing its held predecessor too', () => {
  const f = fixture(); f.start();
  f.decision({ decisionId: 'pending', priorSubmissionId: 'submission', goalId: 'generation', successorSubmissionId: 'next', pending: true }); f.finish();
  f.start('next', 'next-core', 'generation'); f.service.observeEngine({ type: 'streamClosed' });
  assertEqual(f.notices.length, 1, 'one task owns the engine exit');
  assertDeepEqual(f.mobile, [{ id: 'thread', turnId: 'next', failed: true }], 'active successor owns failure identity');
});
h.test('ordinary failure, auth and aborted predecessors cannot later become successful held completions', () => {
  for (const reason of ['network', 'auth_failed', 'aborted']) {
    const f = fixture(); f.start();
    const common = { decisionId: reason, priorSubmissionId: 'submission' };
    f.decision({ ...common, pending: true }); f.finish(reason, 'Failed to finish');
    f.decision({ ...common, pending: false, continued: false });
    assertEqual(f.notices.length, reason === 'aborted' ? 0 : 1, 'existing non-completion policy retained');
    assert(!f.notices.some(row => row.subtitle === 'Task completed'), 'failure does not invent success');
  }
});
h.test('goal decision storage and captured completion bodies stay bounded', () => {
  const f = fixture(id => id);
  for (let index = 0; index <= 1024; index++) {
    const sessionId = `session-${index}`;
    f.service.observeEngine({ type: 'productEvent', method: 'turn/started', params: { sessionId, submissionId: 'prior' } });
    f.decision({ sessionId, decisionId: `decision-${index}`, priorSubmissionId: 'prior', pending: true });
    f.service.observeEngine({ type: 'turnCompleted', params: { sessionId, turnId: 'prior', result: { stopReason: 'completed', finalText: '😀'.repeat(1000) } } });
  }
  assertEqual(f.notices.length, 0, 'capacity cannot promote an unresolved ordinary completion');
  f.decision({ sessionId: 'session-1', decisionId: 'decision-1', priorSubmissionId: 'prior', pending: false, continued: false });
  assertEqual(f.notices.length, 1, 'a valid remaining disposition releases its captured outcome');
  assertEqual([...f.notices[0]!.body].length, 180, 'captured completion stores only a bounded summary');
  assertEqual(f.logs.length, 1, 'capacity diagnostic is inspectable');
  f.service.close(); f.service.observeEngine({ type: 'streamClosed' });
  assertEqual(f.notices.length, 1, 'closing bounded pending storage stays quiet');
});

h.test('terminal Plan presentation suppresses completed work without inventing a successor', () => {
  const f = fixture(); f.start();
  f.service.observeEngine({ type: 'sessionEvent', params: { sessionId: 'engine', event: { planning: { mode: 'plan' }, threadGoal: { status: 'active' } } } });
  f.finish('completed', 'Plan prepared', 'submission', 'suppress');
  f.service.observeEngine({ type: 'streamClosed' });
  assertEqual(f.notices.length + f.mobile.length + f.sounds.length, 0, 'suppression is presentation, not pending launch ownership');
  f.start('paused', 'paused-core'); f.finish('completed', 'Paused goal ordinary reply', 'paused', 'inherit');
  assertEqual(f.notices[0]?.body, 'Paused goal ordinary reply', 'inherit retains ordinary delivery');
});
h.test('failed work inherits independent pending policy without an active-Goal failure bypass', () => {
  const f = fixture();
  const failure = (id: string, disposition: TerminalNotificationDisposition) => {
    f.start(id, `${id}-core`, 'generation');
    f.service.observeEngine(notificationToEvent('turn/failed', { sessionId: 'engine', submissionId: id, terminalNotificationDisposition: disposition,
      detail: { type: 'turn.failed', error: { code: 'internal', message: `Failed ${id}` } } }));
  };
  failure('ordinary', 'inherit');
  f.pending(true); failure('pending-child', 'inherit');
  f.pending(false); failure('explicit-suppressed', 'suppress');
  assertDeepEqual(f.notices.map(row => row.body), ['Failed ordinary'], 'Goal identity alone cannot hide a failure; other gates still can');
  assertDeepEqual(f.mobile, [{ id: 'thread', turnId: 'ordinary', failed: true }], 'inherit never forces mobile delivery');
  assertEqual(terminalNotificationDisposition('notify'), undefined, 'only the named disposition enum is valid');
});
h.test('a refused factory attempt suppresses the predecessor and preserves one typed successor failure', () => {
  const f = fixture(); f.start('prior', 'prior-core');
  const common = { decisionId: 'factory', priorSubmissionId: 'prior', successorSubmissionId: 'successor', goalId: 'generation' };
  f.decision({ ...common, pending: true }); f.finish('completed', 'Predecessor done', 'prior', 'inherit');
  f.start('successor', 'successor-core', 'generation');
  f.decision({ ...common, pending: false, continued: false, priorCompletionNotificationDisposition: 'suppress' });
  assertEqual(f.notices.length, 0, 'actual false launch does not imply predecessor Done');
  const failure = { sessionId: 'engine', submissionId: 'successor', terminalNotificationDisposition: 'inherit', detail: { type: 'turn.failed', error: { code: 'internal', message: 'Provider factory failed' } } };
  f.service.observeEngine(notificationToEvent('turn/failed', failure));
  f.finish('error', '', 'successor', 'inherit'); f.decision({ ...common, pending: false, continued: false, priorCompletionNotificationDisposition: 'suppress' });
  assertDeepEqual(f.notices.map(row => [row.subtitle, row.body]), [['Task failed', 'Provider factory failed']], 'only actual typed error is eligible');
  assertDeepEqual(f.mobile, [{ id: 'thread', turnId: 'successor', failed: true }], 'successor owns the failure');
  assertEqual(failure.detail.error.message, 'Provider factory failed', 'raw diagnostic data remains intact');
});
h.test('a suppressed successful carrier cannot consume a later typed failure of the same actual turn', () => {
  for (const gate of ['allow', 'pending', 'suppress'] as const) {
    const f = fixture(); f.start('same-turn', 'core-same-turn');
    f.finish('completed', 'Provisional completion', 'same-turn', 'suppress');
    f.pending(gate === 'pending');
    const failure = { sessionId: 'engine', submissionId: 'same-turn', terminalNotificationDisposition: gate === 'suppress' ? 'suppress' : 'inherit',
      detail: { type: 'turn.failed', error: { code: 'internal', message: 'Original settlement diagnostic' } } };
    f.service.observeEngine(notificationToEvent('turn/failed', failure));
    f.finish('error', 'Original settlement diagnostic', 'same-turn', 'inherit');
    assertEqual(f.notices.length, gate === 'allow' ? 1 : 0, 'typed failure keeps independent remaining policy and deduplication');
    if (gate === 'allow') {
      assertEqual(f.notices[0]?.body, 'Original settlement diagnostic', 'actual diagnostic survives');
      assertDeepEqual(f.mobile, [{ id: 'thread', turnId: 'same-turn', failed: true }], 'one failure owns the same facade identity');
      assertDeepEqual(f.sounds, ['input'], 'no provisional Done cue or alias duplicate');
    }
    assertEqual(failure.detail.error.message, 'Original settlement diagnostic', 'raw error remains intact under every gate');
  }
});
h.test('terminal suppression remains authoritative when a later prior disposition inherits', () => {
  const f = fixture(); f.start();
  const common = { decisionId: 'monotonic', priorSubmissionId: 'submission' };
  f.decision({ ...common, pending: true }); f.finish('completed', 'Suppressed terminal', 'submission', 'suppress');
  f.decision({ ...common, pending: false, continued: false, priorCompletionNotificationDisposition: 'inherit' });
  assertEqual(f.notices.length + f.mobile.length, 0, 'inherit cannot revive terminal-suppressed success');
});
h.test('malformed exact resolutions clean only their held success and emit a bounded protocol diagnostic', () => {
  const f = fixture(); f.start();
  const common = { sessionId: 'engine', decisionId: 'malformed', priorSubmissionId: 'submission', goalId: 'generation', successorSubmissionId: 'next' };
  f.decision({ ...common, pending: true }); f.finish();
  const invalid = { ...common, pending: false, continued: false };
  f.service.observeEngine(notificationToEvent('goal.continuation', invalid));
  f.service.observeEngine(notificationToEvent('goal.continuation', invalid));
  f.service.observeEngine({ type: 'streamClosed' });
  assertEqual(f.notices.length + f.mobile.length, 0, 'missing field never falls back to Done or fabricates task failure');
  assertDeepEqual(f.logs, ['Goal continuation presentation contract mismatch'], 'one bounded diagnostic, without raw payload');
  f.start('next', 'next-core'); f.finish('completed', 'Later ordinary turn', 'next');
  assertEqual(f.notices[0]?.body, 'Later ordinary turn', 'other turns remain usable');
});
h.test('a malformed or stale identity cannot retire the current pending presentation', () => {
  const f = fixture(); f.start();
  const common = { sessionId: 'engine', decisionId: 'current', priorSubmissionId: 'submission', goalId: 'generation', successorSubmissionId: 'next' };
  f.decision({ ...common, pending: true }); f.finish();
  for (const mismatch of [{ decisionId: 'retired' }, { priorSubmissionId: 'old' }, { goalId: undefined }, { successorSubmissionId: 'wrong' }]) {
    f.service.observeEngine(notificationToEvent('goal.continuation', { ...common, ...mismatch, pending: false, continued: false }));
  }
  f.decision({ ...common, pending: false, continued: false, priorCompletionNotificationDisposition: 'inherit' });
  assertEqual(f.notices.length, 1, 'unrelated malformed records did not consume the real predecessor');
});
h.test('suppression or exact malformed cleanup before the predecessor terminal cannot revive its ordinary success', () => {
  for (const kind of ['suppress', 'malformed']) {
    const f = fixture(); f.start();
    const common = { sessionId: 'engine', decisionId: kind, priorSubmissionId: 'submission', successorSubmissionId: 'next', goalId: 'generation' };
    f.decision({ ...common, pending: true });
    f.service.observeEngine(notificationToEvent('goal.continuation', { ...common, pending: false, continued: false,
      ...(kind === 'suppress' ? { priorCompletionNotificationDisposition: 'suppress' } : {}) }));
    f.finish('completed', 'Late success', 'actual', 'inherit');
    assertEqual(f.notices.length + f.mobile.length, 0, 'a core UUID alias cannot bypass consumed success');
    f.service.observeEngine(notificationToEvent('turn/failed', { sessionId: 'engine', submissionId: 'actual', terminalNotificationDisposition: 'inherit', detail: { error: { code: 'internal', message: 'Independent same-turn failure' } } }));
    f.finish('error', 'Independent same-turn failure', 'actual', 'inherit');
    assertDeepEqual(f.notices.map(row => row.body), ['Independent same-turn failure'], 'success-only cleanup cannot consume the same actual turn failure or duplicate its alias');
  }
  const f = fixture(); f.start();
  const common = { sessionId: 'engine', decisionId: 'raw-failure', priorSubmissionId: 'submission' };
  f.decision({ ...common, pending: true });
  f.service.observeEngine(notificationToEvent('goal.continuation', { ...common, pending: false, continued: false }));
  f.service.observeEngine(notificationToEvent('turn/failed', { sessionId: 'engine', submissionId: 'submission', terminalNotificationDisposition: 'inherit', detail: { error: { code: 'internal', message: 'Independent raw failure' } } }));
  assertEqual(f.notices[0]?.body, 'Independent raw failure', 'success-only cleanup cannot consume an independent typed failure');
});
h.test('pending notification ancestry uses known runtime state and real parent chains without Goal requirements', () => {
  const summaries: Json[] = [{ id: 'middle', parentThreadId: 'root' }, { id: 'child', parentThreadId: 'middle', runtimeStatus: { type: 'active', activeFlags: ['waitingOnApproval'] } }];
  assert(hasActiveNotificationDescendant('root', summaries, []), 'an indirect active ordinary child suppresses its ancestor');
  assert(hasActiveNotificationDescendant('root', summaries, [{ id: 'child', runtimeStatus: { type: 'needs_resume' } }]), 'unloaded cache falls back to authoritative summary activity');
  assert(!hasActiveNotificationDescendant('root', summaries, [{ id: 'child', runtimeStatus: { type: 'idle' } }]), 'known inactive cache supersedes stale active summary');
  assert(hasActiveNotificationDescendant('root', [], [{ id: 'child', source: JSON.stringify({ subagent: { parentThreadId: 'root' } }), runtimeStatus: { type: 'active', activeFlags: ['waitingOnUserInput'] } }]), 'known source parent and waiting-input activity remain active');
  assert(!hasActiveNotificationDescendant('root', [{ id: 'child', parentThreadId: 'missing', runtimeStatus: { type: 'active' } }, { id: 'missing', parentThreadId: 'child' }], []), 'cycles terminate without inventing a root parent');
  assert(!hasActiveNotificationDescendant('root', [{ id: 'unknown', parentThreadId: 'root' }], []), 'missing runtime status is not active evidence');
  assertEqual(notificationQueuePending(undefined), true, 'unknown queue head is not empty');
  assertEqual(notificationQueuePending(null), false, 'null is a known empty head');
  assertEqual(notificationQueuePending({ pausedReason: 'Stopped' }), false, 'a paused head is not runnable');
  assertEqual(notificationQueuePending({ pausedReason: null }), true, 'a runnable head is pending');
});

h.test('placeholder and UUID titles fall back while meaningful titles keep the declared code-point limit', () => {
  const placeholders = ['New Chat', 'Chat', '新对话', '550e8400-e29b-41d4-a716-446655440000'];
  for (const title of placeholders) {
    const f = fixture(); f.service.remember({ id: 'thread', title }); f.start(); f.finish();
    assertEqual(f.notices[0]?.title, 'Task thread', `${title} is not user-visible task context`);
  }
  const f = fixture(), title = '🙂'.repeat(220); f.service.remember({ id: 'thread', title }); f.start(); f.finish();
  const titleVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/session-title-vectors.json'), 'utf8'));
  assertEqual([...String(f.notices[0]?.title)].length, titleVector.truncation.maxChars, 'meaningful title uses the declared code-point limit');
});
h.test('desktop and sound preferences are independent and focused foreground tasks stay quiet', () => {
  const f = fixture(); f.focus(true); f.start(); f.finish(); assertEqual(f.sounds.length + f.notices.length, 0, 'focused');
  f.focus(false); f.settings.set('notification.desktop', 'off'); f.start('b', 'bb'); f.finish('completed', 'Done', 'b');
  assertDeepEqual(f.sounds, ['done'], 'sound only'); assertEqual(f.notices.length, 0, 'desktop disabled');
  f.settings.set('notification.desktop', 'on'); f.settings.set('notification.sound', 'off'); f.start('c', 'cc'); f.finish('completed', 'Done', 'c');
  assertEqual(f.notices.length, 1, 'desktop enabled'); assertEqual(f.sounds.length, 1, 'sound disabled');
});
h.test('an OS banner error does not suppress the separately enabled sound', () => {
  const f = fixture(); f.failDisplay(); f.start(); f.finish(); assertDeepEqual(f.sounds, ['done'], 'independent sound'); assertEqual(f.logs.length, 1, 'error inspectable');
});
h.test('duplicate aliases and stale completions never notify a second time', () => {
  const f = fixture(); f.start(); f.finish(); f.finish('completed', 'duplicate', 'actual'); f.finish();
  f.start('old', 'old-actual'); f.start('new', 'new-actual'); f.finish('completed', 'old before new', 'old'); f.finish('completed', 'new result', 'new'); f.finish('completed', 'old after new', 'old-actual');
  assertDeepEqual(f.notices.map(row => row.body), ['Finished work', 'new result'], 'only current terminal outcomes');
});
h.test('aborted, empty and private-session outcomes stay quiet; authentication asks for input', () => {
  const f = fixture(); f.start(); f.finish('aborted'); f.start('empty', 'e'); f.finish('completed', '', 'empty');
  f.start('error-only', 'error-only-actual');
  f.service.observeEngine({ type: 'turnCompleted', params: { sessionId: 'engine', turnId: 'error-only', result: { stopReason: 'completed', error: 'not a final reply' } } });
  f.service.observeEngine({ type: 'productEvent', method: 'turn/started', params: { sessionId: 'private-engine', submissionId: 'private', detail: { turnId: 'private-turn' } } });
  f.service.observeEngine({ type: 'turnCompleted', params: { sessionId: 'private-engine', turnId: 'private', result: { stopReason: 'completed', finalText: 'private' } } });
  assertEqual(f.notices.length, 0, 'no false completion'); f.start('auth', 'a'); f.finish('auth_failed', 'raw credential data', 'auth');
  assertEqual(f.notices[0]?.body, 'Sign in required', 'actionable auth body'); assertDeepEqual(f.sounds, ['input'], 'input cue');
  f.start('auth-event', 'auth-event-actual');
  f.service.observeEngine({ type: 'productEvent', method: 'turn/failed', params: { sessionId: 'engine', submissionId: 'auth-event', detail: { error: { code: 'auth_failed', message: 'Session expired' } } } });
  assertEqual(f.notices[1]?.body, 'Session expired', 'live authentication failure keeps its actionable detail');
});
h.test('terminal failure and unexpected engine exit preserve task ownership', () => {
  const f = fixture(); f.start();
  const event: ClientEvent = { type: 'productEvent', method: 'turn/failed', params: { sessionId: 'engine', submissionId: 'submission', detail: { error: { code: 'network', message: 'Connection refused' } } } };
  f.service.observeEngine(event); f.service.observeEngine(event); assertEqual(f.notices[0]?.subtitle, 'Task failed', 'failure title');
  f.start('next', 'next-actual'); f.service.observeEngine({ type: 'streamClosed' }); f.service.observeEngine({ type: 'streamClosed' });
  assertEqual(f.notices.length, 2, 'one failure per live turn');
  f.service.resetEngine(); f.start(); f.finish(); assertEqual(f.notices.length, 3, 'a replacement engine can reuse wire identities');
});
h.test('an accepted user interruption cannot become a failure if the engine disconnects', () => {
  const f = fixture(); f.start(); f.service.interrupted('thread'); f.service.observeEngine({ type: 'streamClosed' });
  assertEqual(f.notices.length + f.sounds.length, 0, 'stopped work stays quiet across disconnect');
});
h.test('permission and elicitation prompts have stable request identities', () => {
  const question = 'Which environment should be deployed? ' + 'context '.repeat(30);
  const f = fixture(); f.service.input('permission:request', { requestId: '1:approval:call', sessionId: 'thread', message: 'Allow the selected write?' });
  f.service.input('permission:request', { requestId: '1:approval:call', sessionId: 'thread', message: 'duplicate' });
  f.service.input('elicit:request', { requestId: '1:elicit:call', sessionId: 'thread', prompt: question });
  f.service.input('elicit:request', { requestId: '1:elicit:empty', sessionId: 'thread' });
  assertDeepEqual(f.notices.map(row => row.body), ['Allow the selected write?', question, 'Waiting for your answer'], 'input bodies and fallback');
  assertEqual(notificationBody(' ', 'fallback'), ' ', 'only an empty prompt uses the fallback');
});
h.test('scheduled outcomes and channel failures are visible while focused without duplicate turn banners', () => {
  const f = fixture(); f.focus(true); f.background(true); f.start(); f.finish(); assertEqual(f.notices.length, 0, 'scheduler owns its terminal notice');
  f.service.cronOutcome({ sessionId: 'thread', taskName: 'Daily check', status: 'success', error: 'Bash: exited 1', reply: 'Tool did not work' });
  f.service.channelFailure('Telegram', 'Reconnect failed');
  assertEqual(f.notices[0]?.subtitle, 'Task failed', 'soft scheduled failure is explicit'); assertEqual(f.notices[1]?.title, 'Channel connection failed: Telegram', 'channel identity');
  assertDeepEqual(f.sounds, ['input', 'input'], 'focused background exceptions');
});
h.test('a friend request banner announces the sender and carries the task id even while focused', () => {
  const f = fixture(); f.focus(true); f.settings.set('language', 'zh');
  f.service.friendRequest('  Ada  Lovelace  ', 'Help draft the launch announcement.', 'task-42');
  assertEqual(f.notices.length, 1, 'a pending friend task notifies regardless of window focus');
  assertEqual(f.notices[0]?.title, 'Ada Lovelace 发来好友任务', 'the sender names the banner in the owner language');
  assertEqual(f.notices[0]?.body, 'Help draft the launch announcement.', 'the request text is the banner body');
  assertEqual(f.notices[0]?.friendTaskId, 'task-42', 'the banner keeps the task a click should authorize');
  assertEqual(f.notices[0]?.sessionId, undefined, 'a friend task has no conversation yet, so no session group');
  assertDeepEqual(f.sounds, ['input'], 'an approval prompt uses the input cue');
});
h.test('the failed-runs-only notification policy silently skips successful runs', () => {
  const f = fixture(); f.focus(true); f.background(true); f.start(); f.finish();
  f.service.cronOutcome({ sessionId: 'thread', taskName: 'Quiet success', status: 'success', error: null, reply: 'Done', notificationPolicy: 'failed_runs_only' });
  assertEqual(f.notices.length, 0, 'success under failed-runs-only stays silent');
  f.service.cronOutcome({ sessionId: 'thread-2', taskName: 'Loud failure', status: 'failed', error: 'boom', reply: '', notificationPolicy: 'failed_runs_only' });
  assertEqual(f.notices.length, 1, 'failures still notify under the policy');
  f.service.cronOutcome({ sessionId: 'thread-3', taskName: 'Verbose success', status: 'success', error: null, reply: 'Done', notificationPolicy: 'all_runs' });
  assertEqual(f.notices.length, 2, 'all-runs policy announces success');
});
h.test('shutdown prevents late events, prompts and outcomes from reviving notification state', () => {
  const f = fixture(); f.start(); f.service.close(); f.service.observeEngine({ type: 'streamClosed' }); f.finish();
  f.service.input('permission:request', { requestId: 'x', sessionId: 'thread' }); f.service.channelFailure('QQ', 'closed');
  f.service.cronOutcome({ sessionId: 'thread', taskName: 'Closed', status: 'failed', error: 'shutdown', reply: '' });
  assertEqual(f.notices.length + f.sounds.length, 0, 'normal shutdown is silent');
});

class FakeNativeNotification implements NativeNotificationHandle {
  readonly id: string;
  readonly groupId?: string;
  readonly listeners = new Map<string, (...args: unknown[]) => void>();
  shown = 0;
  cleared = 0;
  constructor(readonly options: NativeNotificationOptions) { this.id = options.id; this.groupId = options.groupId; }
  once(event: 'click' | 'close' | 'failed', listener: (...args: unknown[]) => void): void { this.listeners.set(event, listener); }
  removeAllListeners(): void { this.cleared++; this.listeners.clear(); }
  show(): void { this.shown++; }
  emit(event: 'click' | 'close' | 'failed', ...args: unknown[]): void { this.listeners.get(event)?.(...args); }
}

function nativeFixture(history: FakeNativeNotification[] = []) {
  const created: FakeNativeNotification[] = [];
  const api: NativeNotificationApi = {
    isSupported: () => true,
    create: options => { const notice = new FakeNativeNotification(options); created.push(notice); return notice; },
    history: async () => history,
  };
  return { api, created };
}

h.test('native banners are silent, uniquely identified, grouped by session and route clicks', async () => {
  const f = nativeFixture(), opened: Array<NotificationTarget | undefined> = [], logs: string[] = [];
  const service = new NativeNotifications({ open: async target => { opened.push(target); }, log: value => logs.push(value) }, f.api, () => 'klaus-fixed-id');
  service.show({ title: 'Task', subtitle: 'Task completed', body: 'Done', sessionId: 'thread-1' });
  assertDeepEqual(f.created[0]?.options, { id: 'klaus-fixed-id', groupId: 'thread-1', title: 'Task', subtitle: 'Task completed', body: 'Done', silent: true }, 'native options retain identity and independent sound policy');
  assertEqual(f.created[0]?.shown, 1, 'banner shown once');
  f.created[0]?.emit('click');
  await waitFor(() => opened.length === 1, 1000, 'native click routed');
  assertDeepEqual(opened, [{ kind: 'session', sessionId: 'thread-1' }], 'click opens the owning session');
  assertEqual(logs.length, 0, 'healthy notification stays quiet in diagnostics');
});

h.test('a friend-task banner routes its click to the authorization page and survives a restart through its group', async () => {
  // The click target rides in the groupId because a delivered banner is restored
  // from Notification Center with only its group preserved, so a session-shaped
  // id and a friend task must be distinguishable from that one field.
  assertEqual(notificationGroup({ kind: 'session', sessionId: 'thread-1' }), 'thread-1', 'a session keeps its bare id as the group');
  assertEqual(notificationGroup({ kind: 'friend-task', taskId: 'task-9' }), 'friend-task:task-9', 'a friend task is tagged');
  assertDeepEqual(parseNotificationGroup('friend-task:task-9'), { kind: 'friend-task', taskId: 'task-9' }, 'the tag routes back to the friend task');
  assertDeepEqual(parseNotificationGroup('thread-1'), { kind: 'session', sessionId: 'thread-1' }, 'an untagged group is a session');
  assertEqual(parseNotificationGroup('friend-task:'), undefined, 'an empty friend task id routes nowhere');
  assertEqual(parseNotificationGroup(undefined), undefined, 'a group-less banner only shows the window');

  const f = nativeFixture(), opened: Array<NotificationTarget | undefined> = [];
  const service = new NativeNotifications({ open: async target => { opened.push(target); }, log: () => {} }, f.api, () => 'klaus-fixed-id');
  service.show({ title: 'Friend task from Ada', body: 'Draft the announcement', friendTaskId: 'task-9' });
  assertEqual(f.created[0]?.options.groupId, 'friend-task:task-9', 'the friend task id is carried in the group so a restart keeps the click target');
  f.created[0]?.emit('click');
  await waitFor(() => opened.length === 1, 1000, 'live friend-task click routed');
  assertDeepEqual(opened, [{ kind: 'friend-task', taskId: 'task-9' }], 'click targets the friend task, not a session');

  // A banner restored from Notification Center after a restart still routes to
  // the friend task, decoding its target from the persisted group alone.
  const restored = new FakeNativeNotification({ id: 'klaus-old', groupId: 'friend-task:task-9', title: 'Friend task', body: 'Draft', silent: true });
  const g = nativeFixture([restored]), reopened: Array<NotificationTarget | undefined> = [];
  const restoredService = new NativeNotifications({ open: async target => { reopened.push(target); }, log: () => {} }, g.api);
  await restoredService.restore();
  restored.emit('click');
  await waitFor(() => reopened.length === 1, 1000, 'restored friend-task click routed');
  assertDeepEqual(reopened, [{ kind: 'friend-task', taskId: 'task-9' }], 'a restored banner still reaches its approval');
});

h.test('delivered macOS history restores session clicks and shutdown does not dismiss banners', async () => {
  const old = new FakeNativeNotification({ id: 'klaus-old-id', groupId: 'thread-old', title: 'Old', body: 'Finished', silent: true });
  const f = nativeFixture([old]), opened: Array<NotificationTarget | undefined> = [];
  const service = new NativeNotifications({ open: async target => { opened.push(target); }, log: () => {} }, f.api);
  await service.restore();
  old.emit('click');
  await waitFor(() => opened.length === 1, 1000, 'restored click routed');
  assertDeepEqual(opened, [{ kind: 'session', sessionId: 'thread-old' }], 'restored group identity is the session id');
  const live = new FakeNativeNotification({ id: 'klaus-live-id', groupId: 'thread-live', title: 'Live', body: 'Finished', silent: true });
  const second = nativeFixture(); second.api.create = () => live;
  const retained = new NativeNotifications({ open: async () => {}, log: () => {} }, second.api, () => 'klaus-live-id');
  retained.show({ title: 'Live', body: 'Finished', sessionId: 'thread-live' });
  retained.close();
  assert(live.cleared > 0, 'shutdown detaches process listeners');
  assertEqual(live.shown, 1, 'shutdown leaves the delivered banner in Notification Center');
});

h.test('notification authorization honors the banner setting and serializes concurrent asks', async () => {
  let enabled = false, requests = 0;
  const logs: string[] = [];
  let finish!: (value: string) => void;
  const service = new NotificationAuthorization({ enabled: () => enabled,
    request: () => { requests++; return new Promise(resolve => { finish = resolve; }); }, log: value => logs.push(value) });
  await service.ensure();
  assertEqual(requests, 0, 'disabled desktop banners never ask');
  enabled = true;
  const first = service.ensure(), second = service.ensure();
  assertEqual(requests, 0, 'authorization starts asynchronously once');
  await Promise.resolve();
  assertEqual(requests, 1, 'startup and settings writes share one ask');
  finish('denied');
  await Promise.all([first, second]);
  assertEqual(logs.length, 1, 'denial is diagnosable');
  service.close(); await service.ensure();
  assertEqual(requests, 1, 'shutdown prevents a late ask');
});
h.test('the packaged notification diagnostic has an explicit argument gate', () => {
  assertEqual(notificationProbeRequested(['/Applications/Klaus.app/Contents/MacOS/Klaus', '--notification-probe']), true, 'probe argument recognized');
  assertEqual(notificationProbeRequested(['/Applications/Klaus.app/Contents/MacOS/Klaus']), false, 'ordinary startup is untouched');
});
h.test('friend message arrival broadcasts to renderers and banners only while unfocused', () => {
  const focused = fixture(); focused.focus(true);
  focused.service.friendMessage({ sessionId: 'thread', friendId: 'friend-a', senderName: 'Nick', preview: '今天天气不错', wantReply: false });
  assertEqual(focused.broadcasts.length, 1, 'a focused window still learns about the arrival');
  assertEqual(focused.broadcasts[0]!.channel, 'friends:message-arrived', 'renderer contract channel');
  assert(object(focused.broadcasts[0]!.payload).muted === false, 'unmuted payload flag');
  assertEqual(focused.notices.length, 0, 'a focused window owns the reminder itself');
  const away = fixture();
  away.service.friendMessage({ sessionId: 'thread', friendId: 'friend-a', senderName: 'Nick', preview: '今天天气不错', wantReply: true });
  assertEqual(away.notices.length, 1, 'an unfocused window raises the banner');
  assertEqual(away.notices[0]!.title, 'Nick (friend)', 'english banner title names the sender');
  assertEqual(away.notices[0]!.body, '今天天气不错', 'banner body is the message preview');
  assertEqual(away.notices[0]!.sessionId, 'thread', 'clicking routes into the friend session');
  assert(object(away.broadcasts[0]!.payload).wantReply === true, 'wantReply rides the payload');
  assertDeepEqual(away.sounds, ['input'], 'arrival reuses the input cue');
  const zh = fixture(); zh.settings.set('language', 'zh');
  zh.service.friendMessage({ sessionId: 'thread', friendId: 'friend-a', senderName: 'Nick', preview: 'hello', wantReply: false });
  assertEqual(zh.notices[0]!.title, 'Nick（好友）', 'chinese banner title');
});
h.test('muted friends keep the unread broadcast but skip the banner', () => {
  const f = fixture(); f.settings.set('notification.mutedFriends', '["friend-a"]');
  f.service.friendMessage({ sessionId: 'thread', friendId: 'friend-a', senderName: 'Nick', preview: 'muted hello', wantReply: false });
  assertEqual(f.broadcasts.length, 1, 'the renderer ledger still learns about a muted message');
  assert(object(f.broadcasts[0]!.payload).muted === true, 'muted payload flag');
  assertEqual(f.notices.length, 0, 'a muted friend raises no banner');
  const broken = fixture(); broken.settings.set('notification.mutedFriends', 'not json');
  broken.service.friendMessage({ sessionId: 'thread', friendId: 'friend-a', senderName: 'Nick', preview: 'x', wantReply: false });
  assertEqual(broken.notices.length, 1, 'an unreadable mute list mutes nobody');
});
h.test('friend banners respect the desktop gate and bound their text', () => {
  const off = fixture(); off.settings.set('notification.desktop', 'off');
  off.service.friendMessage({ sessionId: 'thread', friendId: 'friend-a', senderName: 'Nick', preview: 'quiet', wantReply: false });
  assertEqual(off.notices.length, 0, 'the desktop gate silences the banner');
  assertEqual(off.broadcasts.length, 1, 'the gate never hides the in-app ledger');
  const long = fixture();
  long.service.friendMessage({ sessionId: 'thread', friendId: 'friend-a', senderName: 'Nick', preview: '字'.repeat(200), wantReply: false });
  const preview = String(object(long.broadcasts[0]!.payload).preview ?? '');
  assert([...preview].length <= 120 && preview.endsWith('…'), 'broadcast preview bounded at 120 chars');
  assert([...long.notices[0]!.body].length <= 80 && long.notices[0]!.body.endsWith('…'), 'banner body bounded at 80 chars');
});
void h.finish(join(__dirname, 'notifications-result.json'), 'notifications').then(code => { process.exitCode = code; });
