import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { object, string, type JsonObject } from '../main/services/service-types';
import { ClientFollowUpQueue, QueueMutationError, snapshotToWire, rowToWire, INTERRUPTED_QUEUE_REASON } from '../main/sessions/client-queue';
import { AttachmentService } from '../main/services/attachments';
import { WorkspaceStore } from '../main/services/workspaces';
import { Harness, waitFor } from './harness';
import { mobileFixture } from './mobile-fixture';

const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-follow-up-vectors.json'), 'utf8')) as {
  feature: JsonObject; defaultMode: string; modeKey: string; queueMessage: JsonObject; steerMessage: JsonObject; queueAck: JsonObject; steerAck: JsonObject;
  confirmedAdmissionMayOmitSnapshot: boolean;
};
async function fixture() {
  const f = await mobileFixture(), queue = new ClientFollowUpQueue(f.root);
  const workspace = new WorkspaceStore({ configRoot: f.root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const attachments = new AttachmentService(workspace);
  let turnId: string | null = 'facade-turn', steerResult: JsonObject = { ok: true, messageId: 'steer-visible' };
  let intercept: ((channel: string, payload: JsonObject) => Promise<Json | undefined>) | undefined;
  f.intercept(async (channel, payload) => {
    const override = await intercept?.(channel, payload); if (override !== undefined) return override;
    const id = string(payload.sessionId), wire = () => ({ ok: true, snapshot: snapshotToWire(queue.snapshot(id)), followUpTurnId: turnId });
    try { switch (channel) {
      case 'chat:upload': return attachments.upload(payload);
      case 'chat:client-queue-snapshot': return wire();
      case 'chat:client-queue-add': queue.add(id, string(payload.id), object(payload.item)); return wire();
      case 'chat:client-queue-remove': {
        const removed = queue.remove(id, string(payload.id), typeof payload.expectedRevision === 'number' ? payload.expectedRevision : undefined, payload.clientMutationId ? { id: string(payload.clientMutationId), fingerprint: string(payload.mutationFingerprint) } : undefined);
        return { ...wire(), ...(removed.removed ? { removed: rowToWire(removed.removed) } : {}) };
      }
      case 'chat:client-queue-restore': {
        const row = object(payload.row); queue.restore(id, { id: string(row.id), item: object(row.item), createdAt: Number(row.createdAt), pausedReason: typeof row.pausedReason === 'string' ? row.pausedReason : null }, { beforeId: typeof payload.beforeId === 'string' ? payload.beforeId : null }, false, typeof payload.expectedRevision === 'number' ? payload.expectedRevision : undefined, payload.requireRemovedReceipt === true); return wire();
      }
      case 'chat:client-queue-reorder': queue.reorder(id, string(payload.id), typeof payload.beforeId === 'string' ? payload.beforeId : null); return wire();
      case 'chat:client-queue-resume': queue.resumeInterrupted(id, INTERRUPTED_QUEUE_REASON); return wire();
      case 'chat:client-queue-deliver': { const claim = queue.claim(id, string(payload.id)); queue.commitClaim(id, claim.row.id); return wire(); }
      case 'chat:client-queue-clear': queue.clear(id); return wire();
      case 'chat:follow-up': return payload.expectedTurnId === turnId ? steerResult : { ok: false, error: 'The turn changed' };
      default: return undefined;
    } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof QueueMutationError ? { code: error.code } : {}) }; }
  });
  await f.enable();
  return { f, queue, turn: (id: string | null) => { turnId = id; }, steer: (result: JsonObject) => { steerResult = result; }, intercept: (next: typeof intercept) => { intercept = next; },
    close: async () => { await attachments.close(); await f.close(); } };
}
export async function registerMobileFollowUpTests(h: Harness): Promise<void> {
  await h.test('confirmed remote queue admission remains accepted when its snapshot is unavailable', async () => {
    const x = await fixture(), { f } = x;
    try {
      x.intercept(async (channel, payload) => {
        if (channel !== 'chat:client-queue-add') return undefined;
        x.queue.add(string(payload.sessionId), string(payload.id), object(payload.item));
        return { ok: true };
      });
      const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify(vectors.queueMessage));
      const ack = await client.next('message_accepted');
      assert.equal(ack.queueId, vectors.queueAck.queueId);
      assert.equal(Object.hasOwn(ack, 'snapshot'), !vectors.confirmedAdmissionMayOmitSnapshot);
      const read = await f.request('GET', '/api/mobile/sessions/s1/queue');
      assert.equal(read.status, 200);
      const rows = object(read.body.snapshot).items as JsonObject[];
      assert.equal(rows.length, 1); assert.equal(rows[0]!.id, ack.queueId);
      assert.equal(f.calls.filter(row => row.channel === 'chat:client-queue-add').length, 1);
    } finally { await x.close(); }
  });
  await h.test('follow-up capability and computer preference are projected without moving queued rows', async () => {
    const x = await fixture(), { f } = x;
    try {
      const bootstrap = await f.request('GET', '/api/mobile/bootstrap');
      assert.equal(object(bootstrap.body.features).followUpQueue, vectors.feature.followUpQueue);
      assert.equal(object(bootstrap.body.runtimeConfig).followUpMode, vectors.defaultMode);
      const client = await f.connect(); await client.next('hello');
      x.queue.add('s1', 'kept', { finalText: 'Already queued', media: [] });
      const write = await f.request('POST', '/api/mobile/runtime-config', { followUpMode: 'steer' });
      assert.equal(write.status, 202); assert.equal(object(write.body.runtimeConfig).followUpMode, 'steer');
      const event = await client.next('runtime_config_changed'); assert.equal(object(event.runtimeConfig).followUpMode, 'steer');
      assert.equal(x.queue.snapshot('s1').items[0]?.id, 'kept');
      assert(f.calls.some(row => row.channel === 'settings:kv:set' && row.payload.key === vectors.modeKey && row.payload.value === 'steer'));
      assert.equal((await f.request('POST', '/api/mobile/runtime-config', { followUpMode: 'other' })).status, 400);
    } finally { await x.close(); }
  });
  await h.test('Queue persists uploaded bytes and deduplicates immutable send identity over real HTTP and WebSocket', async () => {
    const x = await fixture(), { f } = x;
    try {
      const client = await f.connect(); await client.next('hello');
      const request = { ...vectors.queueMessage, media: [{ type: 'file', mimeType: 'text/plain', filename: 'notes.txt', data: Buffer.from('durable queue bytes').toString('base64') }] };
      client.socket.send(JSON.stringify(request));
      const ack = await client.next('message_accepted');
      for (const [key, value] of Object.entries(vectors.queueAck)) assert.equal(ack[key], value);
      const queued = x.queue.snapshot('s1').items[0]!;
      const descriptor = object((queued.item.mobileAttachments as JsonObject[])[0]);
      assert.equal(await readFile(string(descriptor.path), 'utf8'), 'durable queue bytes');
      assert(string(descriptor.path).startsWith(join(f.root, 'uploads')));
      assert.equal(await import('../main/services/attachments').then(module => module.buildMessageInput(string(queued.item.finalText), queued.item.media as Json[])), 'Review the final diff\n\nAttached:\n- ' + string(descriptor.path));
      assert.deepEqual(queued.item.media, [], 'generic files use real engine path references, never invalid inline media');
      assert.equal(f.calls.filter(row => row.channel === 'chat:send' || row.channel === 'chat:follow-up').length, 0);
      const post = await f.request('POST', '/api/mobile/sessions/s1/messages', request);
      assert.equal(post.status, 202); assert.equal(post.body.duplicate, true);
      assert.equal(x.queue.snapshot('s1').items.length, 1); assert.equal(f.calls.filter(row => row.channel === 'chat:upload').length, 1);
      const changed = await f.request('POST', '/api/mobile/sessions/s1/messages', { ...request, text: 'Different intent' });
      assert.equal(changed.status, 409); assert.equal(object(changed.body.error).type, 'message_identity_conflict');
      const read = await f.request('GET', '/api/mobile/sessions/s1/queue'); assert.equal(read.status, 200); assert.equal(read.body.followUpTurnId, 'facade-turn');
      assert.equal(object(read.body.snapshot).revision, 1);
      f.updateStatus(await f.bridge.restart());
      const replacement = await f.connect(); await replacement.next('hello'); replacement.socket.send(JSON.stringify(request));
      const restoredAck = await replacement.next('message_accepted'); assert.equal(restoredAck.queueId, 'mobile-phone-one');
      assert.equal(x.queue.snapshot('s1').items.length, 1); assert.equal(f.calls.filter(row => row.channel === 'chat:upload').length, 1, 'a pending durable row owns the cold retry');
    } finally { await x.close(); }
  });
  await h.test('Steer fences the captured turn, returns admission metadata and never falls back to ordinary send', async () => {
    const x = await fixture(), { f } = x;
    try {
      const client = await f.connect(); await client.next('hello'); client.socket.send(JSON.stringify(vectors.steerMessage));
      const ack = await client.next('message_accepted');
      for (const [key, value] of Object.entries(vectors.steerAck)) assert.equal(ack[key], value);
      x.steer({ ok: false, unconfirmed: true, messageId: 'steer-uncertain' });
      client.socket.send(JSON.stringify({ ...vectors.steerMessage, clientMessageId: 'uncertain', text: 'Uncertain steer' }));
      const uncertain = await client.next('message_accepted'); assert.equal(uncertain.followUpState, 'unconfirmed'); assert.equal(uncertain.messageId, 'steer-uncertain');
      x.turn('new-turn'); client.socket.send(JSON.stringify({ ...vectors.steerMessage, clientMessageId: 'stale' }));
      const error = await client.next('error'); assert.equal(error.code, 'steer_rejected');
      assert.equal(f.calls.filter(row => row.channel === 'chat:send').length, 0);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/messages', { text: 'missing turn', followUpMode: 'steer', clientMessageId: 'bad' })).status, 400);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/messages', { text: 'bad mode', followUpMode: 'unknown', clientMessageId: 'bad' })).status, 400);
    } finally { await x.close(); }
  });
  await h.test('queue controls require current session scope, immutable mutation receipts and exact undo proof', async () => {
    const x = await fixture(), { f } = x;
    try {
      x.queue.add('s1', 'a', { finalText: 'first', media: [] }); x.queue.add('s1', 'b', { finalText: 'second', media: [] });
      assert.equal((await f.request('GET', '/api/mobile/sessions/missing/queue')).status, 404);
      assert.equal((await f.request('GET', '/api/mobile/sessions/s1/queue', undefined, {})).status, 401);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/queue/remove', { id: 'a' })).status, 400);
      const remove = { id: 'a', expectedRevision: 2, clientMutationId: 'remove-one' };
      const removed = await f.request('POST', '/api/mobile/sessions/s1/queue/remove', remove);
      assert.equal(removed.status, 200); assert.equal(object(removed.body.removed).id, 'a');
      assert.deepEqual((await f.request('POST', '/api/mobile/sessions/s1/queue/remove', remove)).body, removed.body);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/queue/remove', { ...remove, id: 'b' })).status, 409);
      f.updateStatus(await f.bridge.restart());
      const replay = await f.request('POST', '/api/mobile/sessions/s1/queue/remove', remove);
      assert.equal(replay.status, 200); assert.deepEqual(replay.body.removed, removed.body.removed, 'atomic removal receipt survives bridge restart');
      const row = object(removed.body.removed);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s2/queue/restore', { row, clientMutationId: 'foreign' })).status, 409);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/queue/restore', { row: { ...row, item: { finalText: 'injected', media: [{ path: '/etc/passwd' }] } }, clientMutationId: 'changed' })).status, 409);
      const restored = await f.request('POST', '/api/mobile/sessions/s1/queue/restore', { row, beforeId: 'b', clientMutationId: 'undo-one' });
      assert.equal(restored.status, 200); assert.deepEqual((object(restored.body.snapshot).items as JsonObject[]).map(item => item.id), ['a', 'b']);
      const deliver = { id: 'a', clientMutationId: 'deliver-once', expectedTurnId: 'facade-turn' };
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/queue/deliver', deliver)).status, 200);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/queue/deliver', deliver)).status, 200);
      assert.equal(f.calls.filter(call => call.channel === 'chat:client-queue-deliver').length, 1);
    } finally { await x.close(); }
  });
  await h.test('queue draft handoff keeps original files and refuses stale revisions or unowned media paths', async () => {
    const x = await fixture(), { f } = x;
    try {
      const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ ...vectors.queueMessage, text: '', media: [{ type: 'file', filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('full original file').toString('base64') }] }));
      await client.next('message_accepted');
      const read = await f.request('GET', '/api/mobile/sessions/s1/queue/mobile-phone-one/draft');
      assert.equal(read.body.text, '', 'file-only editing must not expose or duplicate the managed attachment path block');
      assert.equal(read.status, 200); assert.equal(read.body.expectedRevision, 1); assert.equal(Buffer.from(string(object((read.body.media as JsonObject[])[0]).data), 'base64').toString(), 'full original file');
      x.queue.add('s1', 'later', { finalText: 'later', media: [] });
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/queue/remove', { id: 'mobile-phone-one', expectedRevision: read.body.expectedRevision, clientMutationId: 'stale-edit' })).status, 409);
      const revisionError = await f.request('POST', '/api/mobile/sessions/s1/queue/remove', { id: 'mobile-phone-one', expectedRevision: read.body.expectedRevision, clientMutationId: 'stale-edit-again' });
      assert.equal(object(revisionError.body.error).type, 'queue_revision_changed');
      assert.equal(x.queue.snapshot('s1').items.length, 2);
      await writeFile(join(f.root, 'private.txt'), 'private'); await symlink(join(f.root, 'private.txt'), join(f.root, 'uploads', 'unsafe.txt'));
      x.queue.add('s1', 'unsafe', { finalText: 'unsafe', media: [{ path: join(f.root, 'uploads', 'unsafe.txt'), name: 'unsafe.txt', mimeType: 'text/plain' }] });
      assert.equal((await f.request('GET', '/api/mobile/sessions/s1/queue/unsafe/draft')).status, 403);
      x.queue.claim('s1', 'later');
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/queue/remove', { id: 'later', clientMutationId: 'inflight' })).status, 409);
      assert.equal(x.queue.snapshot('s1').items.find(row => row.id === 'later')?.dispatching, true);
    } finally { await x.close(); }
  });
  await h.test('all queued status and dispatched events retain session scope on the mobile stream', async () => {
    const x = await fixture(), { f } = x;
    try {
      const client = await f.connect(); await client.next('hello'); client.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' })); await client.next('history');
      const events: JsonObject[] = [{ type: 'client_queue_snapshot', revision: 5, interrupted: true, items: [] }, { type: 'queued_follow_up_dispatched', id: 'row', item: { finalText: 'run' } }, { type: 'follow_up_status', messageId: 'message', state: 'unconfirmed' }];
      for (const event of events) {
        f.bridge.publishEngineEvent({ ...event, sessionId: 's1' }, f.owner());
        const frame = await client.next('engine_event'); assert.deepEqual(frame.event, { ...event, sessionId: 's1' });
      }
      f.bridge.publishEngineEvent({ type: 'client_queue_snapshot', sessionId: 's2', revision: 6, items: [] }, f.owner());
      await waitFor(() => !client.messages.some(row => object(row.event).sessionId === 's2'), 100, 'foreign queue remains outside subscription');
    } finally { await x.close(); }
  });
}
