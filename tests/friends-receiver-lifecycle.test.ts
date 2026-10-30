import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FriendsService, type FriendsDeps } from '../main/services/friends';
import { FriendTaskStore } from '../main/services/friend-task-store';
import { FriendMessageStore } from '../main/services/friend-message-store';
import { bindFriendSession, friendSessionScope } from '../main/services/friend-session-scope';
import { withSettingsTransaction } from '../main/services/settings';
import { IpcHandlerError } from '../main/ipc/registry';
import type { Json } from '../main/ipc/contract';
import type { FriendMessage, FriendTaskGrant } from '../shared/friends';
import { Harness, waitFor } from './harness';

const h = new Harness();
const OWNER = 'owner', PEER = 'peer', FRIEND = 'friend-one', LOCAL = 'local', REMOTE = 'remote';
const signal = () => new AbortController().signal;
const grant: FriendTaskGrant = { deviceId: LOCAL, mode: 'manual', computerUse: false, apps: [], directories: [], remember: false, network: false };
const grantJson = grant as unknown as Json;
type Internal = { syncInbox(): Promise<void>; drainSupplements(): Promise<void>; flushReplyOutbox(): Promise<void> };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'friends-receiver-lifecycle-'));
  const store = new FriendTaskStore(root), messages = new FriendMessageStore(root);
  const requests: Record<string, any>[] = [], created: string[] = [], retired: string[] = [], interrupted: string[] = [], idleRetired: string[] = [];
  const turns: Array<{ id: string; resolve(value: { reply: string | null }): void; reject(reason: unknown): void; done?: boolean }> = [];
  const busy = new Set<string>(), rejectNextOpen = new Set<string>();
  const settledListeners = new Set<() => void>();
  const relocated: string[] = [];
  let changes = 0, enabled = false, failReply = false, deliveryFailure = '', afterRetire: (() => void) | undefined, replyGate: Promise<void> | undefined, onStatus: ((requestId:string)=>void)|undefined;
  const deps: FriendsDeps = {
    configRoot: root, serverURL: 'https://fixture.invalid', account: () => ({ userId: OWNER, token: 'fixture-token' }), enabled: () => enabled,
    deviceId: async () => LOCAL, ensureTransport: async () => ({ deviceId: LOCAL, connected: true }), changed: () => { changes++; }, replyRetryDelays: [],
    onTurnSettled: listener => { settledListeners.add(listener); return () => { settledListeners.delete(listener); }; },
    relocateSession: async threadId => { relocated.push(threadId); },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>; requests.push(body);
      if(body.type==='send'&&body.kind==='reply'&&body.replyType==='completed'&&body.replyToRequestId==='root')await replyGate;
      if (body.type === 'send' && body.kind === 'reply' && failReply) throw new Error('Fixture reply network failure');
      if (body.type === 'delivery-status' && body.requestId === deliveryFailure) throw new Error('Fixture status network failure');
      if(body.type==='delivery-status')onStatus?.(String(body.requestId));
      const data = body.type === 'send' ? { accepted: true, delivered: false, receiverUserId: PEER, receiverDeviceId: REMOTE }
        : body.type === 'receiver' ? { selectedDeviceId: LOCAL, devices: [] }
        : body.type === 'inbox' ? { messages: [] }
        : body.type === 'delivery-status' ? { delivered: true }
        : { signedIn: true, selfUserId: OWNER, friends: [{ id: FRIEND, userId: PEER, displayName: 'Peer', avatarUrl: null, status: 'accepted', allowIncomingAgentTasks: true, peerAllowsAgentTasks: true, online: true }] };
      return new Response(JSON.stringify(data), { status: 200 });
    }, sessions: {
      newSession: async options => {
        const id = 'receiver-' + (created.length + 1); created.push(id);
        if (options?.friendScope) bindFriendSession(root, id, options.friendScope);
        return { id };
      },
      threadRow: async id => ({ id, isWorking: busy.has(id) }),
      // Busy while an owner turn is flagged or a hosted turn has not settled, like the real session service.
      canReuseFriendTaskSession: id => !busy.has(id) && !turns.some(turn => turn.id === id && !turn.done),
      retireIdleFriendTaskSession: async id => { idleRetired.push(id); afterRetire?.(); },
      retireFriendTaskSession: async id => { retired.push(id); },
      friendTurnId: id => busy.has(id) ? 'busy-turn' : null,
      interrupt: async id => { interrupted.push(id); return { ok: true }; },
      deliverDelegation: async () => { throw new Error('Display messages cannot start an AI delegation'); },
      sendAndWait: async (id, _payload, turnSignal) => {
        if (busy.has(id) || rejectNextOpen.delete(id)) throw new IpcHandlerError('TURN_IN_PROGRESS', 'Fixture conversation busy');
        const turn: (typeof turns)[number] = { id, resolve: () => {}, reject: () => {} };
        const settled = new Promise<{ reply: string | null }>((resolve, reject) => {
          turn.resolve = resolve; turn.reject = reject;
          turnSignal?.addEventListener('abort', () => reject(new IpcHandlerError('TURN_INTERRUPTED', 'Fixture task interrupted')), { once: true });
        });
        turns.push(turn);
        try { return await settled; } finally { turn.done = true; }
      },
    },
  };
  const service = new FriendsService(deps), internal = service as unknown as Internal;
  const incoming = (change: Partial<FriendMessage> = {}): FriendMessage => ({ protocolVersion: 3, kind: 'task', intent: 'request', onReply: 'display', requestId: 'root', friendshipId: FRIEND, senderUserId: PEER, senderDisplayName: 'Peer', senderDeviceId: REMOTE, sourceThreadId: 'peer-thread', prompt: 'Inspect A.', sentAt: Date.now(), ...change });
  const cancel = (change: Partial<FriendMessage> = {}) => incoming({ kind: 'cancel', intent: undefined, onReply: undefined, requestId: 'cancel-event', replyToRequestId: 'root', prompt: '', ...change });
  const reached = (id: string, status: string) => waitFor(() => store.get(OWNER, id)?.status === status, 1500, 'Task ' + status);
  /** The model delivers the task result from inside the running turn of conversation `id`. */
  const answer = (id: string, text: string, callId = 'result-' + Math.random().toString(16).slice(2)) =>
    service.execute('reply_to_friend', { prompt: text }, { sessionId: id, unattended: false, signal: signal(), assertCurrent() {} }, callId);
  return { root, store, messages, service, internal, requests, created, turns, busy, rejectNextOpen, retired, interrupted, idleRetired, relocated, incoming, cancel, reached, answer,
    settle: () => { for (const listener of [...settledListeners]) listener(); },
    changes: () => changes, enable: () => { enabled = true; }, failReplies: (value: boolean) => { failReply = value; }, failStatus: (requestId: string) => { deliveryFailure = requestId; }, afterRetire: (run: () => void) => { afterRetire = run; },
    holdReply: (gate: Promise<void>) => { replyGate = gate; },
    duringStatus: (run: (requestId:string)=>void) => { onStatus=run; },
    async close() { for (const turn of turns) turn.resolve({ reply: 'Fixture cleanup' }); await service.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
async function completedFirst(f: ReturnType<typeof fixture>) {
  const first = await f.service.receive(f.incoming(), signal());
  await f.service.approve({ taskId: first.taskId, grant: grantJson }); await f.reached(first.taskId, 'running');
  await waitFor(() => f.turns.length === 1, 1000, 'first turn');
  await f.answer('receiver-1', 'First result.');
  f.turns[0]!.resolve({ reply: 'Owner note: first result sent.' }); await f.reached(first.taskId, 'completed');
  await waitFor(() => friendSessionScope(f.root, 'receiver-1')?.active === false, 1000, 'first scope release');
  return first;
}

h.test('a busy paired conversation keeps its running grant and starts the next approved task when it idles', async () => {
  const f = fixture(); try {
    const first = await f.service.receive(f.incoming(), signal());
    await f.service.approve({ taskId: first.taskId, grant: grantJson }); await f.reached(first.taskId, 'running');
    await waitFor(() => f.turns.length === 1, 1000, 'first turn');
    // The first task is still running when the friend's next request from the same
    // conversation is approved: it parks in the paired conversation and waits.
    const second = await f.service.receive(f.incoming({ requestId: 'second' }), signal());
    await f.service.approve({ taskId: second.taskId, grant: grantJson });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(f.created, ['receiver-1'], 'a busy paired conversation never forks the pair');
    assert.equal(f.turns.length, 1, 'no turn starts while the conversation is busy');
    assert.equal(f.store.get(OWNER, second.taskId)?.status, 'starting');
    assert.equal(friendSessionScope(f.root, 'receiver-1')?.taskId, first.taskId, 'the running task keeps its own grant');
    assert.equal(friendSessionScope(f.root, 'receiver-1')?.active, true);
    // The first turn delivers and ends; the waiting task now takes the conversation.
    await f.answer('receiver-1', 'First result.');
    f.turns[0]!.resolve({ reply: 'Owner note: first done.' }); await f.reached(first.taskId, 'completed');
    f.settle();
    await f.reached(second.taskId, 'running');
    await waitFor(() => f.turns.length === 2, 3000, 'second turn');
    assert.equal(f.turns[1]!.id, 'receiver-1');
    assert.equal(friendSessionScope(f.root, 'receiver-1')?.taskId, second.taskId);
    assert.equal(friendSessionScope(f.root, 'receiver-1')?.active, true);
    assert(f.relocated.includes('receiver-1'), 'the approval location is bound before the turn');
  } finally { await f.close(); }
});
h.test('a paired conversation that is busy when an approval arrives is rebound only once it idles', async () => {
  const f = fixture(); try {
    const first = await completedFirst(f);
    // The owner starts a turn in the paired conversation before the next approval.
    f.busy.add('receiver-1');
    const second = await f.service.receive(f.incoming({ requestId: 'second' }), signal());
    await f.service.approve({ taskId: second.taskId, grant: grantJson });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.turns.length, 1, 'the approved task waits for the conversation');
    assert.equal(friendSessionScope(f.root, 'receiver-1')?.taskId, first.taskId, 'the earlier scope is untouched while waiting');
    assert.equal(friendSessionScope(f.root, 'receiver-1')?.active, false);
    f.busy.delete('receiver-1'); f.settle();
    await f.reached(second.taskId, 'running');
    await waitFor(() => f.turns.length === 2, 3000, 'second turn');
    assert.equal(f.turns[1]!.id, 'receiver-1');
    assert.deepEqual(f.created, ['receiver-1']);
    assert.equal(friendSessionScope(f.root, 'receiver-1')?.taskId, second.taskId);
  } finally { await f.close(); }
});
h.test('an approved task that loses the admission race waits again in the same conversation', async () => {
  const f = fixture(); try {
    const first = await completedFirst(f);
    // Another turn wins the admission race after the idle check passed.
    f.rejectNextOpen.add('receiver-1');
    const second = await f.service.receive(f.incoming({ requestId: 'second' }), signal());
    await f.service.approve({ taskId: second.taskId, grant: grantJson });
    await waitFor(() => f.turns.length === 2, 3000, 'the task starts once the conversation is free again');
    assert.equal(f.turns[1]!.id, 'receiver-1', 'the pair never forks');
    assert.deepEqual(f.created, ['receiver-1']);
    assert.equal(f.store.get(OWNER, second.taskId)?.status, 'running');
    assert.equal(f.store.get(OWNER, first.taskId)?.status, 'completed', 'the earlier task keeps its result');
    assert(!f.requests.some(row => row.kind === 'reply' && row.replyType === 'failed' && row.replyToRequestId === 'second'), 'losing a race is not a failure');
  } finally { await f.close(); }
});
h.test('an earlier task finishing reply delivery cannot deactivate a newer task scope', async () => {
  const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  try{
    const first=await f.service.receive(f.incoming(),signal());
    await f.service.approve({taskId:first.taskId,grant:grantJson});await f.reached(first.taskId,'running');
    await waitFor(()=>f.turns.length===1,1000,'first turn');f.holdReply(gate);
    // The result's delivery is held in flight while the first turn ends.
    void f.answer('receiver-1','First result.','first-result');
    await waitFor(()=>f.store.get(OWNER,first.taskId)?.replied===true,1000,'result handed over');
    f.turns[0]!.resolve({reply:'Owner note: first result sent.'});await f.reached(first.taskId,'completed');
    const second=await f.service.receive(f.incoming({requestId:'second'}),signal());
    await f.service.approve({taskId:second.taskId,grant:grantJson});await f.reached(second.taskId,'running');
    await waitFor(()=>f.turns.length===2,3000,'reused turn');
    assert.equal(f.turns[1]!.id,'receiver-1');release();
    await waitFor(()=>(f.service as unknown as {running:Map<string,unknown>}).running.has(first.taskId)===false,1000,'first task cleanup');
    assert.equal(friendSessionScope(f.root,'receiver-1')?.taskId,second.taskId);
    assert.equal(friendSessionScope(f.root,'receiver-1')?.active,true);
  }finally{release();await f.close();}
});

h.test('an invalid supplementary grant creates a durable terminal failure for the requester', async () => {
  const f = fixture(); try {
    const task = f.store.admit(OWNER, LOCAL, f.incoming(), 'root-fingerprint', null).task;
    f.store.update(OWNER, task.id, ['pending'], { status: 'needs-input', questionId: 'question', grant: { ...grant, directories: [{ path: join(f.root, 'missing'), access: 'read' }] } });
    f.store.enqueueSupplement(OWNER, task.id, f.incoming({ requestId: 'supplement', supplementToRequestId: 'root', questionId: 'question', prompt: 'Project A.' }), 'supplement-fingerprint');
    f.failReplies(true); await f.internal.drainSupplements();
    await waitFor(() => f.messages.pendingSends(OWNER).length === 1, 1000, 'durable failed reply');
    const failed = f.store.get(OWNER, task.id)!;
    assert.equal(failed.status, 'failed'); assert(failed.replyRequestId); assert.match(failed.replyText!, /could not continue/);
    const queued = f.messages.pendingSends(OWNER)[0]!;
    assert.equal(queued.replyType, 'failed'); assert.equal(queued.replyToRequestId, 'root');
    f.failReplies(false); await f.internal.flushReplyOutbox();
    assert.equal(f.messages.pendingSends(OWNER).length, 0);
    assert(f.requests.some(row => row.kind === 'reply' && row.replyType === 'failed' && row.requestId === queued.requestId));
    assert.equal(f.turns.length, 0);
  } finally { await f.close(); }
});

h.test('an identical cancellation is acknowledged once without duplicate interruption or terminal identity', async () => {
  const f = fixture(); try {
    const task = await f.service.receive(f.incoming(), signal());
    await f.service.approve({ taskId: task.taskId, grant: grantJson }); await f.reached(task.taskId, 'running');
    await waitFor(() => f.turns.length === 1, 1000, 'running task');
    await f.service.receive(f.cancel(), signal());
    const first = f.store.get(OWNER, task.taskId)!;
    await f.service.receive(f.cancel(), signal());
    assert.equal(f.store.get(OWNER, task.taskId)!.replyRequestId, first.replyRequestId);
    assert.equal(f.store.get(OWNER, task.taskId)!.status, 'cancelled');
    assert.deepEqual(f.interrupted, ['receiver-1']);
    await assert.rejects(f.service.receive(f.cancel({ sourceThreadId: 'different' }), signal()), /cancellation identity changed/);
  } finally { await f.close(); }
});

h.test('a cancellation received before its original request prevents later automatic execution', async () => {
  const f = fixture(); try {
    f.store.saveTemplate(OWNER, FRIEND, LOCAL, { ...grant, remember: true, policy: 'auto' });
    await f.service.receive(f.cancel(), signal()); await f.service.receive(f.cancel(), signal());
    const receipt = await f.service.receive(f.incoming(), signal());
    assert.equal(receipt.awaitingAuthorization, false);
    assert.equal(f.store.get(OWNER, receipt.taskId)!.status, 'cancelled');
    assert.equal(f.created.length, 0); assert.equal(f.turns.length, 0);
  } finally { await f.close(); }
});

h.test('cancellation state rolls back when its receipt cannot be registered', async () => {
  const f = fixture(); try {
    const task = await f.service.receive(f.incoming(), signal());
    withSettingsTransaction(f.root, db => db.exec("CREATE TRIGGER reject_cancel_receipt BEFORE INSERT ON friend_reply_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END"));
    await assert.rejects(f.service.receive(f.cancel(), signal()), /fixture receipt failure/);
    assert.equal(f.store.get(OWNER, task.taskId)!.status, 'pending');
    assert.equal(withSettingsTransaction(f.root, db => (db.prepare('SELECT COUNT(*) AS count FROM friend_task_cancellations').get() as { count: number }).count), 0);
    withSettingsTransaction(f.root, db => db.exec('DROP TRIGGER reject_cancel_receipt'));
    await f.service.receive(f.cancel(), signal());
    assert.equal(f.store.get(OWNER, task.taskId)!.status, 'cancelled');
  } finally { await f.close(); }
});

h.test('delivery polling publishes one batch refresh', async () => {
  const f = fixture(); try {
    for (const id of ['one', 'two']) await f.service.send(FRIEND, 'A notice', 'owner-thread', signal(), id, { intent: 'notice' });
    const before = f.changes(); f.enable(); await f.internal.syncInbox();
    assert.equal(f.changes() - before, 1);
    assert.equal(f.store.outbox(OWNER, 'one')!.status, 'delivered'); assert.equal(f.store.outbox(OWNER, 'two')!.status, 'delivered');
    await f.internal.syncInbox(); assert.equal(f.changes() - before, 1);
  } finally { await f.close(); }
});

h.test('a reply arriving during delivery polling is not overwritten by a delivery receipt',async()=>{
  const f=fixture();try{
    await f.service.send(FRIEND,'A request','owner-thread',signal(),'one',{intent:'request',onReply:'display'});
    f.duringStatus(id=>{
      const row=f.store.outbox(OWNER,id)!;
      f.store.putOutbox({...row,status:'replied',replyCompleted:true});
    });
    f.enable();await f.internal.syncInbox();
    assert.equal(f.store.outbox(OWNER,'one')!.status,'replied');
    assert.equal(f.store.outbox(OWNER,'one')!.replyCompleted,true);
  }finally{await f.close();}
});

h.test('delivery polling still publishes updates made before a later status request fails', async () => {
  const f = fixture(); try {
    for (const id of ['one', 'two']) await f.service.send(FRIEND, 'A notice', 'owner-thread', signal(), id, { intent: 'notice' });
    f.failStatus('two'); const before = f.changes(); f.enable(); await f.internal.syncInbox();
    assert.equal(f.changes() - before, 1);
    assert.equal(f.store.outbox(OWNER, 'one')!.status, 'delivered'); assert.equal(f.store.outbox(OWNER, 'two')!.status, 'sent');
  } finally { await f.close(); }
});

h.finish(__filename, 'friends-receiver-lifecycle').then(code => process.exitCode = code);
