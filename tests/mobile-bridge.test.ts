import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { MOBILE_BRIDGE_CHANNELS } from '../main/ipc/handlers/mobile-bridge';
import { REMOTE_THREAD_OPERATIONS } from '../main/services/remote-thread-client';
import { MOBILE_FEATURES, attachmentUpload, elicitationResponse, mediaItems, permissionResponse, questionAnswer } from '../main/services/mobile/protocol';
import { mobileMediaPreview, MOBILE_MEDIA_PREVIEW_LIMIT } from '../main/services/mobile/previews';
import type { JsonObject } from '../main/services/service-types';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';
import type { Json } from '../main/ipc/contract';
import { projectRows, projectWorkspaceGroups } from '../main/services/mobile/projection';
import { ensureProfileScopedDeviceSeed, mobileDeviceId, MobileSettingsStore } from '../main/services/mobile/settings';
import { MobileRelay } from '../main/services/mobile/relay';
import { ClientMessageChunks, ReliableDelivery, ReliableDeliveryStore, stopSocket } from '../main/services/mobile/transport';
import { activeFollowEvents, followQuestions } from '../main/services/mobile/follow-snapshot';
import { MobileTaskStreams } from '../main/services/mobile/task-stream';
import { object, string } from '../main/services/service-types';
import { withSettingsDb } from '../main/services/settings';
import { Harness, sleep, waitFor } from './harness';
import { mobileFixture } from './mobile-fixture';
import { AttachmentService } from '../main/services/attachments';
import { WorkspaceStore } from '../main/services/workspaces';
import { registerMobileModelConfigTests } from './mobile-model-config-tests';
import { registerMobileNewChatTests } from './mobile-new-chat-tests';
import { registerMobileFollowUpTests } from './mobile-follow-up-tests';

const h = new Harness(), deadline = setTimeout(() => { process.stderr.write('Mobile fixture exceeded 90 seconds\n'); process.exit(1); }, 90_000);

const transcriptVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-transcript-vectors.json'), 'utf8')) as Record<string, JsonObject>;
const interactionVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-transcript-interaction-vectors.json'), 'utf8')) as Record<string, JsonObject>;
const remoteStreamVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-remote-stream-vectors.json'), 'utf8')) as Record<string, JsonObject>;
const questionVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-question-vectors.json'), 'utf8')) as Record<string, JsonObject>;
function clientChunks(seq: number, message: JsonObject): JsonObject[] {
  const encoded = Buffer.from(JSON.stringify(message)), width = 96 * 1024;
  const count = Math.ceil(encoded.length / width);
  return Array.from({ length: count }, (_, index) => ({
    type: 'client_message_chunk', seq, index, count,
    data: encoded.subarray(index * width, (index + 1) * width).toString('base64'),
  }));
}
async function resumePhone(f: Awaited<ReturnType<typeof mobileFixture>>, clientId: string, lastServerSeq = 0, serverChunks: JsonObject[] = [], pendingMessages: JsonObject[] = []) {
  const client = await f.connect(); await client.next('hello');
  client.socket.send(JSON.stringify({ type: 'transport_resume', clientId, lastServerSeq, chunkAcknowledgements: true, serverChunks, pendingMessages }));
  const ready = await client.next('transport_ready'); return { ...client, ready };
}
void (async () => {
  await h.test('profile-scoped device seed moves a development profile onto its own device identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-seed-'));
    try {
      const machine = () => Promise.resolve('shared-machine-identifier');
      const store = new MobileSettingsStore(root, 'https://relay.example');
      const before = store.read();
      const shared = await mobileDeviceId(root, 'user-seed', 'darwin', machine);
      assert.equal(await mobileDeviceId(root, 'user-seed', 'darwin', machine), shared, 'the machine identity is stable before seeding');
      assert.equal(ensureProfileScopedDeviceSeed(root), true);
      const scoped = await mobileDeviceId(root, 'user-seed', 'darwin', machine);
      assert.notEqual(scoped, shared, 'seeding drops the cached machine-derived identity');
      assert.equal(await mobileDeviceId(root, 'user-seed', 'darwin', machine), scoped, 'the seeded identity is stable');
      const after = store.read();
      assert.notEqual(after.relayId, before.relayId, 'seeding rotates the relay bridge the old identity claimed');
      assert.equal(ensureProfileScopedDeviceSeed(root), true, 'a seeded profile keeps its seed');
      assert.equal(await mobileDeviceId(root, 'user-seed', 'darwin', machine), scoped, 'a second launch keeps the seeded identity');
      assert.equal(store.read().relayId, after.relayId, 'a second launch keeps the rotated bridge');
      const other = await mkdtemp(join(tmpdir(), 'klaus-mobile-seed-other-'));
      try {
        assert.equal(ensureProfileScopedDeviceSeed(other), true);
        assert.notEqual(await mobileDeviceId(other, 'user-seed', 'darwin', machine), scoped, 'two development profiles get distinct identities');
      } finally { await rm(other, { recursive: true, force: true }); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await h.test('fixture teardown closes outbound clients even when a test leaves one connected', async () => {
    const f = await mobileFixture(); let client: Awaited<ReturnType<typeof f.connect>> | undefined;
    try { await f.enable(); client = await f.connect(); await client.next('hello'); }
    finally { await f.close(); }
    assert.equal(client!.socket.readyState, WebSocket.CLOSED);
  });
  await registerMobileFollowUpTests(h);
  await registerMobileNewChatTests(h);
  await registerMobileModelConfigTests(h);

  await h.test('inline visualization routes return bounded content only for the current known session', async () => {
    let current: Awaited<ReturnType<typeof mobileFixture>> | undefined;
    const f = await mobileFixture({ inlineVisualizationPreview: async (sessionId, path): Promise<JsonObject> => {
      if (path === '/replaced') current!.replaceOwner();
      if (path === '/account-changed') current!.account({ userId: 'other', token: 'other' });
      if (path === '/denied') return { error: 'path outside the visualization directory' };
      if (path === '/large') return { html: 'x'.repeat(1024 * 1024 + 1) };
      return { html: '<button>ready</button>', sessionId };
    } });
    current = f;
    try {
      await f.enable();
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/inline-visualization', { path: '/page' }, {})).status, 401);
      assert.equal((await f.request('POST', '/api/mobile/sessions/missing/inline-visualization', { path: '/page' })).status, 404);
      const page = await f.request('POST', '/api/mobile/sessions/s1/inline-visualization', { path: '/page' });
      assert.deepEqual(page.body, { sessionId: 's1', html: '<button>ready</button>' });
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/inline-visualization', { path: '/denied' })).status, 403);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/inline-visualization', { path: '/large' })).status, 403);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/inline-visualization', { path: '/replaced' })).status, 409);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/inline-visualization', { path: '/account-changed' })).status, 401);
      assert(!f.calls.some(row => row.channel === 'artifacts:read'), 'inline pages never bypass their whitelist through the generic reader');
    } finally { await f.close(); }
  });
  await h.test('created-thread summary reads expose only validated unarchived canonical rows', async () => {
    const f = await mobileFixture({ catalogRow: async (id): Promise<JsonObject | null> => id === 's1' ? { id: 's1', title: 'Canonical chat', workdir: '/project', archived: false, updatedAt: 42 }
      : id === 's2' ? { id: 's2', archived: true } : null });
    try {
      await f.enable();
      const reply = await f.request('GET', '/api/mobile/sessions/s1/summary');
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, { sessionId: 's1', session: { id: 's1', title: 'Canonical chat', workdir: '/project', archived: false, updatedAt: 42, isWorking: false } });
      assert.equal((await f.request('GET', '/api/mobile/sessions/s2/summary')).status, 404);
      assert.equal((await f.request('GET', '/api/mobile/sessions/missing/summary')).status, 404);
      assert.equal((await f.request('GET', '/api/mobile/sessions/s1/summary', undefined, {})).status, 401);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/summary', {})).status, 404);
    } finally { await f.close(); }
  });
  await h.test('six channels default the bridge on while preserving explicit opt-out, token entropy and null pairing fields', async () => {
    const f = await mobileFixture(); try {
      assert.deepEqual(f.registry.channels(), [...MOBILE_BRIDGE_CHANNELS].sort());
      const status = f.status(); assert.equal(status.enabled, true); assert.equal(status.running, false); assert.equal(status.port, 27189);
      assert.equal(status.accountLinked, false); assert.equal(status.relayConnected, false);
      assert.equal(status.allowLockedComputerUse, false);
      assert.equal(status.keepAwakeWhilePluggedIn, undefined);
      // Direct-connect descriptors are gone: a phone reaches this desktop only through the relay.
      for (const key of ['host', 'lanEnabled', 'localBaseUrl', 'pairingUrl', 'localPairingUrl', 'relayPairingUrl', 'qrcodeDataUrl']) assert.equal(status[key], undefined);
      assert.deepEqual(status.features, MOBILE_FEATURES); assert.equal(Buffer.from(string(status.token), 'base64url').length, 32); assert.equal(Buffer.from(string(status.relayId), 'base64url').length, 18);
      assert.equal(status.relayError, null);
      assert.deepEqual(object(object(await f.bridge.get()).settings), status); assert.equal(f.cloudRequests.length, 0); assert.equal(f.relays.length, 0);
      const keys = withSettingsDb(f.root, db => db.prepare('SELECT key FROM settings ORDER BY key').all()).map(row => row.key);
      assert.deepEqual(keys, ['mobile_bridge.relay_id', 'mobile_bridge.relay_secret', 'mobile_bridge.token']);
      f.updateStatus(await f.bridge.set({ enabled: false })); assert.equal(f.status().enabled, false); assert.equal(f.status().running, false);
      assert.equal(withSettingsDb(f.root, db => db.prepare('SELECT value FROM settings WHERE key=?').get('mobile_bridge.enabled') as { value?: string }).value, '0');
      assert.equal(object(object(await f.bridge.get()).settings).enabled, false);
    } finally { await f.close(); }
  });
  await h.test('account login starts the default bridge, logout stops it, and explicit opt-out stays off', async () => {
    const f = await mobileFixture(); try {
      assert.equal(f.status().enabled, true); assert.equal(f.status().running, false);
      f.account({ token: 'fixture-account-token', userId: 'fixture-user' });
      f.updateStatus(await f.bridge.refreshAccount());
      await waitFor(() => f.relays.length === 1, 2000, 'Default bridge starts after account login');
      assert.equal(f.status().running, true);
      f.account(undefined); f.updateStatus(await f.bridge.refreshAccount());
      assert.equal(f.status().enabled, true); assert.equal(f.status().running, false);
      f.updateStatus(await f.bridge.set({ enabled: false }));
      f.account({ token: 'fixture-account-token', userId: 'fixture-user' });
      f.updateStatus(await f.bridge.refreshAccount());
      assert.equal(f.status().enabled, false); assert.equal(f.status().running, false);
      assert.equal(f.relays.length, 1);
    } finally { await f.close(); }
  });
  await h.test('device management exposes only product fields, removes peers, unregisters self and reports revoked auth', async () => {
    const f = await mobileFixture(); try {
      f.account({ token: 'fixture-account-token', userId: 'fixture-user' });
      await f.enable();
      await waitFor(() => f.cloudRequests.some(row => row.path.endsWith('/register')), 2000, 'Device registration');
      f.cloudDevices([{
        id: 'peer-device', name: 'Studio Mac', platform: 'darwin', status: 'online', lastSeenAt: 123,
        updatedAt: 122, appVersion: '1.2.3', isCurrent: false,
        relayId: 'must-not-reach-renderer', relayBaseUrl: 'https://secret.invalid/relay', features: { hidden: true },
      }]);
      const listed = object(await f.bridge.listDevices());
      assert.equal(listed.ok, true); assert.equal(listed.accountLinked, true);
      assert.deepEqual(listed.devices, [{ id: 'peer-device', name: 'Studio Mac', platform: 'darwin', status: 'online', lastSeenAt: 123, appVersion: '1.2.3', isCurrent: false }]);

      assert.equal(object(await f.bridge.removeDevice({ deviceId: 'peer-device' })).ok, true);
      assert(f.cloudRequests.some(row => row.request.method === 'DELETE' && row.path === '/api/mobile/devices/peer-device'));

      f.updateStatus(await f.bridge.set({ enabled: false }));
      assert.equal(f.status().enabled, false); assert.equal(f.status().running, false);
      assert(f.cloudRequests.some(row => row.request.method === 'POST' && row.path === '/api/mobile/devices/unregister'));

      f.cloudStatus(401);
      const rejected = object(await f.bridge.removeDevice({ deviceId: 'peer-device' }));
      assert.equal(rejected.ok, false); assert.equal(rejected.status, 401); assert.equal(f.authorizationExpired(), 1);
    } finally { await f.close(); }
  });
  await h.test('real loopback HTTP authenticates before parsing and keeps token header precedence', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); assert.equal((await f.request('GET', '/healthz', undefined, {})).status, 200);
      assert.equal((await f.request('GET', '/api/mobile/bootstrap', undefined, {})).status, 401);
      assert.equal((await f.request('GET', '/api/mobile/bootstrap?token=' + f.status().token, undefined, { authorization: 'bEaReR wrong' })).status, 401);
      assert.equal((await f.request('GET', '/api/mobile/bootstrap?token=' + f.status().token, undefined, {})).status, 200);
      assert.equal((await f.request('GET', '/api/mobile/bootstrap', undefined, { 'x-klaus-mobile-token': string(f.status().token) })).status, 200);
      const options = await f.request('OPTIONS', '/api/mobile/bootstrap', undefined, {}); assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), null);
      const invalid = await fetch('http://127.0.0.1:' + f.status().port + '/api/mobile/sessions', { method: 'POST', body: 'not json' }); assert.equal(invalid.status, 401); await invalid.body?.cancel();
      assert.equal((await f.request('GET', '/private', undefined, {})).status, 404); assert.equal(f.relays.length, 0);
    } finally { await f.close(); }
  });
  await h.test('protocol v3 bootstrap projects roots and advertises revisioned reliable task streams', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); f.bridge.noteRendererSession([{ sessionId: 's2' }]);
      f.bridge.publishEngineEvent({ type: 'stream_mode', sessionId: 's2', mode: 'requesting' }, f.owner());
      const { body } = await f.request('GET', '/api/mobile/bootstrap');
      assert.equal(body.protocolVersion, remoteStreamVector.protocolVersion);
      assert.equal(object(body.features).taskStream, object(remoteStreamVector.features).taskStream);
      assert.equal(object(body.features).reliableTransport, object(remoteStreamVector.features).reliableTransport);
      assert.equal(body.activeSessionId, 's2'); assert.deepEqual(object(body.desktopState).runningSessionIds, ['s2']);
      assert.deepEqual(body.projects, [{ workdir: f.root, label: 'Fixture root', updatedAt: 20, conversationCount: 5 }, { workdir: 'C:\\Projects\\Windows', label: 'Windows', updatedAt: 10, conversationCount: 1 }, { workdir: 'C:\\Projects\\Empty', label: 'Empty Windows root', updatedAt: 1, conversationCount: 0 }]);
      const commands = body.slashCommands as { name: string }[]; assert.deepEqual(commands.map(row => row.name), ['mcp-check', 'plain', 'plugin:cmd', 'run-skill']);
      // The engine list still carries the CLI-only compaction row; the phone's
      // projection drops it because the phone has no manual compaction surface.
      assert(f.commands.some(row => row.name === 'compact'), 'fixture engine list carries the CLI-only row');
      assert(!commands.some(row => row.name === 'compact'), 'CLI-only compaction row never reaches the phone');
      const runtime = object(body.runtimeConfig); assert.deepEqual((runtime.mainModelOptions as { value: string }[]).map(row => row.value), ['auto', 'subscription:fixture', 'custom:fixture']);
      assert.deepEqual((runtime.outputStyleOptions as { label: string }[]).map(row => row.label), ['Normal', 'Learning', 'plugin-style']);
      assert.equal((object(body.composerAddMenu).items as unknown[]).length, 7);
      assert(f.calls.some(row => row.channel === 'session:get-main-model' && row.payload.sessionId === 's2'));
      assert(f.calls.filter(row => row.channel === 'engine:slashCommands').every(row => row.payload.remoteControl === true));
    } finally { await f.close(); }
  });
  await h.test('HTTP session actions use existing workdirs, history guard and non-wiping deletion', async () => {
    const f = await mobileFixture(); try {
      await f.enable();
      const unknown = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'unknown-workdir', workdir: '/unknown-fixture', initialMessage: { text: 'First turn' } }); assert.equal(unknown.status, 403);
      const empty = await f.request('POST', '/api/mobile/sessions', { workdir: 'C:\\Projects\\Empty' }); assert.equal(empty.status, 400); assert.equal(object(empty.body.error).type, 'initial_message_required');
      assert.equal((await f.request('POST', '/api/mobile/active-workdir', { workdir: f.root })).status, 202);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s2/workdir', { workdir: f.root })).status, 409);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/workdir', { workdir: 'C:\\Projects\\Empty' })).status, 202);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/workdir', { workdir: null })).status, 202);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/rename', { title: ' Renamed ' })).body.title, 'Renamed');
      assert.equal((await f.request('GET', '/api/mobile/sessions/missing/history')).status, 404);
      const exported = await f.request('POST', '/api/mobile/sessions/s1/export'); assert.equal(exported.status, 202); assert(string(exported.body.url).endsWith('/Fixture%20export.md'));
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/debug-report')).body.feedbackId, 'fixture-report');
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/stop')).status, 202);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/delete')).status, 202);
      assert.equal(f.calls.find(row => row.channel === 'session:delete')!.payload.wipeWorkspace, false);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s%2F2/delete')).status, 400);
    } finally { await f.close(); }
  });
  await h.test('draft promotion creates and sends once, preserves early events, and rolls back failed first turns', async () => {
    const f = await mobileFixture(); try {
      await f.enable();
      const socket = await f.connect(); await socket.next('hello');
      socket.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' })); await socket.next('history');
      const before = f.sessions.length;
      const payload = { clientDraftId: 'phone-draft-1', workdir: 'C:\\Projects\\Empty', initialMessage: { text: 'First mobile turn', clientMessageId: 'phone-message-1' } };
      const [first, duplicate] = await Promise.all([
        f.request('POST', '/api/mobile/sessions', payload),
        f.request('POST', '/api/mobile/sessions', payload),
      ]);
      assert.equal(first.status, 201); assert.equal(duplicate.status, 201);
      assert.equal(first.body.id, duplicate.body.id); assert.equal(first.body.accepted, true);
      assert.equal(first.body.workdir, 'C:\\Projects\\Empty');
      assert.equal(f.sessions.length, before + 1);
      assert.equal(f.calls.filter(row => row.channel === 'session:new').length, 1);
      assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.payload.text, 'First mobile turn');
      const promotedId = string(first.body.id); assert(promotedId);
      f.bridge.publishEngineEvent({ type: 'text_delta', sessionId: promotedId, text: 'Early first-turn output' }, f.owner());
      const early = await socket.next('engine_event'); assert.equal(object(early.event).text, 'Early first-turn output');

      const beforeFailure = f.sessions.length;
      f.intercept(async channel => channel === 'chat:send' ? { ok: false, error: 'fixture_first_turn_failed' } : undefined);
      const failed = await f.request('POST', '/api/mobile/sessions', {
        clientDraftId: 'phone-draft-failure',
        initialMessage: { text: 'Do not leave an empty chat', clientMessageId: 'phone-message-failure' },
      });
      assert.equal(failed.status, 500);
      assert.equal(f.sessions.length, beforeFailure);
      assert(f.calls.some(row => row.channel === 'session:delete' && row.payload.wipeWorkspace === false));
    } finally { await f.close(); }
  });
  await h.test('rejected interrupts preserve the active turn and pending interactions over HTTP and WebSocket', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      f.bridge.publishEngineEvent({ type: 'stream_mode', sessionId: 's1', mode: 'requesting' }, f.owner());
      f.bridge.publishEngineEvent({ type: 'tool_start', sessionId: 's1', toolCallId: 'active-tool', toolName: 'bash' }, f.owner());
      f.bridge.publishPermissionRequest({ sessionId: 's1', requestId: 'active-approval' }, f.owner()); await client.next('permission_pending');
      f.bridge.publishElicitationRequest({ sessionId: 's1', requestId: 'active-question' }, f.owner()); await client.next('elicit_pending');
      const vector = transcriptVector.interrupt!;
      for (const answer of vector.rejectedResults as Json[]) {
        f.intercept(async channel => channel === 'chat:interrupt' ? answer : undefined);
        const response = await f.request('POST', '/api/mobile/sessions/s1/stop');
        assert.equal(response.status, vector.rejectedStatus); assert.equal(object(response.body.error).type, vector.rejectedCode); assert.notEqual(response.body.ok, true);
        assert.deepEqual(object((await f.request('GET', '/api/mobile/desktop-state')).body.desktopState).runningSessionIds, ['s1']);
      }
      client.socket.send(JSON.stringify({ type: 'stop_generation', sessionId: 's1' }));
      assert.equal((await client.next('error')).code, vector.rejectedCode);
      assert(!client.messages.some(row => row.type === 'action_result' || ['permission_resolved', 'permission_cancelled', 'elicit_resolved', 'elicit_cancelled'].includes(string(row.type))));
      assert(!client.messages.some(row => row.type === 'engine_event' && ['interrupted', 'done', 'tool_end'].includes(string(object(row.event).type))));
      assert.equal((await f.request('POST', '/api/mobile/permissions/respond', { requestId: 'active-approval', decision: 'deny' })).status, 202);
      assert.equal((await f.request('POST', '/api/mobile/elicitations/respond', { requestId: 'active-question', response: { kind: 'decline' } })).status, 202);
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('unconfirmed stops preserve explicit pause diagnostics over HTTP and WebSocket', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      const interrupted = { ok: true, accepted: true, confirmed: false, interruptionError: 'The engine did not confirm interruption', goalPauseError: 'Pause storage failed' };
      f.intercept(async channel => channel === 'chat:interrupt' ? interrupted : undefined);
      const response = await f.request('POST', '/api/mobile/sessions/s1/stop', { expectedTurnId: 'held' });
      assert.equal(response.status, 202); assert.equal(response.body.ok, false); assert.equal(response.body.confirmed, false);
      assert.equal(response.body.interruptionError, interrupted.interruptionError); assert.equal(response.body.goalPauseError, interrupted.goalPauseError);
      client.socket.send(JSON.stringify({ type: 'stop_generation', sessionId: 's1', expectedTurnId: 'held' }));
      const result = await client.next('action_result');
      assert.equal(result.ok, false); assert.equal(result.accepted, true); assert.equal(result.confirmed, false);
      assert.equal(result.interruptionError, interrupted.interruptionError); assert.equal(result.goalPauseError, interrupted.goalPauseError);
      assert.deepEqual(f.calls.filter(row => row.channel === 'chat:interrupt').map(row => row.payload), [{ sessionId: 's1', expectedTurnId: 'held' }, { sessionId: 's1', expectedTurnId: 'held' }], 'uncertainty never removes the original guard');
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('accepted stops retain the expected turn guard and explicitly acknowledge acceptance', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      const vector = transcriptVector.interrupt!, expectedTurnId = string(vector.expectedTurnId);
      f.intercept(async channel => channel === 'chat:interrupt' ? vector.accepted : undefined);
      const response = await f.request('POST', '/api/mobile/sessions/s1/stop', { expectedTurnId });
      assert.equal(response.status, 202); assert.deepEqual(response.body, { ok: true, sessionId: 's1', accepted: true });
      assert.deepEqual(f.calls.filter(row => row.channel === 'chat:interrupt').map(row => row.payload), [{ sessionId: 's1', expectedTurnId }]);
      client.socket.send(JSON.stringify({ type: 'stop_generation', sessionId: 's1', expectedTurnId: 'turn-2' }));
      assert.deepEqual(await client.next('action_result'), { type: 'action_result', action: 'stop_generation', ok: true, sessionId: 's1', accepted: true });
      assert.deepEqual(f.calls.filter(row => row.channel === 'chat:interrupt').at(-1)!.payload, { sessionId: 's1', expectedTurnId: 'turn-2' });
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/stop', { expectedTurnId: 7 })).status, 400);
      assert.equal(f.calls.filter(row => row.channel === 'chat:interrupt').length, 2);
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('a removed desktop selection cannot break an empty phone bootstrap', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); f.bridge.noteRendererSession([{ sessionId: 'removed' }]); f.sessions.splice(0);
      const bootstrap = await f.request('GET', '/api/mobile/bootstrap'); assert.equal(bootstrap.status, 200); assert.equal(bootstrap.body.activeSessionId, null);
      assert(f.calls.filter(row => row.channel === 'engine:slashCommands' || row.channel === 'session:get-main-model').every(row => !row.payload.sessionId));
    } finally { await f.close(); }
  });
  await h.test('runtime updates validate all fields first and return the actual updated projection', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); f.bridge.noteRendererSession([{ sessionId: 's1' }]);
      const before = f.calls.length; assert.equal((await f.request('POST', '/api/mobile/runtime-config', { mainModel: 'high', authMode: 'removed-source' })).status, 400);
      assert(!f.calls.slice(before).some(row => row.channel.startsWith('session:set')));
      for (const source of ['qoder', 'qwenwork', 'workbuddy', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark']) {
        const allowed = await f.request('POST', '/api/mobile/runtime-config', { sessionId: 's1', mainModel: source + ':fixture', authMode: source });
        assert.equal(allowed.status, 202); assert.equal(object(allowed.body.runtimeConfig).authMode, source);
      }
      for (const retired of ['klaus', 'local']) {
        assert.equal((await f.request('POST', '/api/mobile/runtime-config', { mainModel: retired + ':fixture', authMode: retired })).status, 400);
      }
      const response = await f.request('POST', '/api/mobile/runtime-config', { sessionId: 's1', mainModel: 'custom:fixture', thinkingLevel: 'xhigh', authMode: 'codex', outputStyle: 'Learning' });
      assert.equal(response.status, 202); assert.equal(object(response.body.runtimeConfig).mainModel, 'custom:fixture'); assert.equal(object(response.body.runtimeConfig).thinkingLevel, 'xhigh');
      assert(f.calls.some(row => row.channel === 'session:set-main-model' && row.payload.sessionId === 's1'));
      f.intercept(async channel => channel === 'session:rename' ? { ok: false, error: 'fixture_write_failed' } : undefined);
      const failed = await f.request('POST', '/api/mobile/sessions/s1/rename', { title: 'Fail' }); assert.equal(failed.status, 500); assert.equal(object(failed.body.error).type, 'fixture_write_failed');
    } finally { await f.close(); }
  });
  await h.test('runtime compatibility writes cannot inherit or redirect to the renderer session', async () => {
    const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-runtime-scope-vectors.json'), 'utf8'));
    const f = await mobileFixture();
    try {
      await f.enable(); f.bridge.noteRendererSession([{ sessionId: vector.rendererSessionId }]);
      for (const payload of vector.invalidWrites) {
        const before = f.calls.length;
        const reply = await f.request('POST', '/api/mobile/runtime-config', payload);
        assert.equal(reply.status, payload.sessionId === 'missing' ? 404 : 400);
        assert(!f.calls.slice(before).some(row => row.channel.startsWith('session:set')));
      }
      const before = f.calls.length;
      assert.equal((await f.request('POST', '/api/mobile/runtime-config', vector.sessionWrite)).status, 202);
      assert.deepEqual(f.calls.slice(before).filter(row => row.channel.startsWith('session:set')).map(row => row.payload), [
        { mode: 'custom:fixture', sessionId: 's2' }, { level: 'high', sessionId: 's2' }
      ]);
      const defaultStart = f.calls.length;
      assert.equal((await f.request('POST', '/api/mobile/runtime-config', vector.defaultWrite)).status, 202);
      assert.deepEqual(f.calls.slice(defaultStart).filter(row => row.channel === 'session:set-thinking-level').map(row => row.payload), [{ level: 'medium' }]);
    } finally { await f.close(); }
  });
  await h.test('unconfirmed output styles never report a successful configuration update', async () => {
    const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-runtime-scope-vectors.json'), 'utf8'));
    const rejections: Array<{ answer: JsonObject; status: number; type: string }> = [
      { answer: { ok: false, error: 'unknown_style' }, status: 500, type: 'unknown_style' },
      { answer: {}, status: 409, type: 'runtime_configuration_rejected' }
    ];
    for (const rejection of rejections) {
      const f = await mobileFixture();
      try {
        await f.enable();
        f.intercept(async channel => channel === 'settings:output-styles:set' ? rejection.answer : undefined);
        const response = await f.request('POST', '/api/mobile/runtime-config', vector.rejectedStyleWrite);
        assert.equal(response.status, rejection.status, JSON.stringify(response));
        assert.equal(object(response.body.error).type, rejection.type, JSON.stringify(response));
      } finally { await f.close(); }
    }
  });
  await h.test('generic attachments persist as private managed path references and dedupe by session', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const payload = { text: '', clientMessageId: 'same', media: [{ type: 'file', data: Buffer.from('fixture bytes').toString('base64'), filename: '..\\escape/file.txt', mimeType: 'text/plain' }] };
      const first = await f.request('POST', '/api/mobile/sessions/s1/messages', payload); assert.equal(first.status, 202); assert.equal(first.body.accepted, true);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/messages', payload)).body.duplicate, true);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s2/messages', payload)).body.duplicate, undefined);
      await waitFor(() => f.sent.length === 2, 2000, 'Actual attachment dispatch');
      assert.deepEqual(f.sent[0]!.files, []); assert.deepEqual(f.sent[0]!.payload.media, []);
      const attachedPath = string(f.sent[0]!.payload.text).split('Attached:\n- ')[1]!;
      assert.equal(readFileSync(attachedPath, 'utf8'), 'fixture bytes'); assert(attachedPath.startsWith(join(f.root, 'uploads')));
      assert.equal(object((object(f.sent[0]!.payload.displayMetadata).attachments as JsonObject[])[0]).name, '..escapefile.txt');
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/messages', { text: '/plain argument' })).status, 202);
      await waitFor(() => f.sent.length === 3, 2000, 'Approved slash dispatch');
    } finally { await f.close(); }
  });
  await h.test('media and permission vectors enforce bytes, alphabet, MIME and suggestion bounds', async () => {
    assert.throws(() => mediaItems([{ data: 'AA==', mimeType: 'image/gif' }]), /JPEG/);
    assert.throws(() => mediaItems([{ type: 'file', data: 'AB==' }]), /base64/);
    assert.throws(() => mediaItems(Array(9).fill({ data: 'AA==', mimeType: 'image/png' })), /Too many/);
    assert.throws(() => mediaItems([{ type: 'file', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }]), /too large/);
    assert.equal(mediaItems([{ data: 'data:image/png;base64,\n AA==', filename: '../photo' }])[0]!.filename, '..photo');
    assert.equal(mediaItems([{ data: 'AA==', mimeType: 'image/png', filename: 'photo' }])[0]!.filename, 'photo.png');
    assert.equal((permissionResponse({ decision: 'allow', acceptedSuggestionIndices: Array(25).fill(0) }).acceptedSuggestionIndices as unknown[]).length, 20);
    assert.throws(() => permissionResponse({ decision: 'allow', acceptedSuggestionIndices: [51] }), /invalid index/);
  });
  await h.test('reliable delivery chunks large messages, resumes by cursor and deduplicates client sequence numbers', () => {
    const delivery = new ReliableDelivery();
    const frames = delivery.enqueue({ type: 'fixture_large', body: 'x'.repeat(240 * 1024) });
    assert(frames.length > 1); assert(frames.every(frame => frame.type === 'server_message_chunk' && Buffer.byteLength(JSON.stringify(frame)) < 150 * 1024));
    const replay = delivery.replay(0); assert.equal(replay.stale, false); assert.deepEqual(replay.frames, frames); assert.equal(replay.latestSeq, 1);
    const bytes = Buffer.concat(frames.sort((a, b) => Number(a.index) - Number(b.index)).map(frame => Buffer.from(string(frame.data), 'base64')));
    assert.equal(object(JSON.parse(bytes.toString())).type, 'fixture_large');
    assert.equal(delivery.acceptClient(1), 'accept'); delivery.commitClient(1);
    assert.equal(delivery.acceptClient(1), 'duplicate'); assert.equal(delivery.acceptClient(3), 'gap');
    delivery.acknowledge(2); assert.deepEqual(delivery.replay(0).frames, frames, 'a future receipt cannot discard pending messages');
    delivery.acknowledge(1); assert.deepEqual(delivery.replay(1).frames, []);
  });
  await h.test('client chunks drop a broken assembly, ignore retransmits and complete only in segment order', () => {
    const chunks = new ClientMessageChunks(), message = { type: 'send_message', text: '图'.repeat(50_000) };
    const frames = clientChunks(1, message);
    assert.equal(chunks.receive(frames[0]!), undefined);
    assert.equal(chunks.receive(frames[0]!), undefined, 'a retransmitted part is ignored');
    assert.deepEqual(chunks.receipts(), [{ seq: 1, count: 2, receivedIndexes: [0] }]);
    // A part that disagrees with the assembly metadata discards the assembly.
    assert.equal(chunks.receive({ ...frames[1]!, count: 3 }), undefined);
    assert.deepEqual(chunks.receipts(), []);
    // A non-zero first part cannot start an assembly: the rest would be spliced.
    assert.equal(chunks.receive(frames[1]!), undefined);
    assert.equal(chunks.receive(frames[0]!), undefined);
    assert.deepEqual(chunks.receive(frames[1]!), { type: 'client_message', seq: 1, message });
    const invalidFrames: JsonObject[] = [
      { ...frames[0]!, seq: 0 }, { ...frames[0]!, index: 2 }, { ...frames[0]!, count: 3000 },
      { ...frames[0]!, data: 'AB==' }, { ...frames[0]!, data: ' '.repeat(10) },
      { ...frames[0]!, message_size_bytes: -1 },
      { type: 'client_message_chunk', seq: 2, index: 0, count: 1, data: Buffer.from([0xff]).toString('base64') },
      { type: 'client_message_chunk', seq: 2, index: 0, count: 1, data: Buffer.from('[]').toString('base64') },
    ];
    for (const frame of invalidFrames) assert.equal(chunks.receive(frame), undefined, 'invalid parts are dropped, not fatal');
    // Partial assemblies are bounded; the oldest is evicted rather than closing the connection.
    for (let seq = 1; seq <= 130; seq++) assert.equal(chunks.receive({ ...frames[0]!, seq }), undefined);
    assert.equal(chunks.receipts().length, 128);
    chunks.clear(); assert.equal(chunks.receive(frames[0]!), undefined);
  });
  await h.test('segmented framing is chosen per advertised level and both shapes reassemble', () => {
    const large = { type: 'fixture_large', body: 'x'.repeat(240 * 1024) };
    // Sender grid: an unheard peer keeps the older shape, a level 4 peer gets the newer one.
    const legacyFrames = new ReliableDelivery().enqueue(large, 'legacy');
    const nextFrames = new ReliableDelivery().enqueue(large, 'next');
    assert(legacyFrames.length > 1 && nextFrames.length > 1);
    assert(legacyFrames.every(frame => frame.type === 'server_message_chunk' && frame.message_size_bytes === undefined));
    assert(legacyFrames.every(frame => Buffer.byteLength(JSON.stringify(frame)) <= 150 * 1024));
    assert(nextFrames.every(frame => frame.type === 'server_message_chunk' && typeof frame.message_size_bytes === 'number'));
    assert(nextFrames.every(frame => Buffer.byteLength(JSON.stringify(frame)) <= 150 * 1024));
    // Default is the older shape until a peer is observed.
    assert.deepEqual(new ReliableDelivery().enqueue(large), legacyFrames);
    // Cursor is the delivered watermark, carried on every frame of either shape.
    for (const frame of [...legacyFrames, ...nextFrames]) assert.equal(typeof frame.cursor, 'string');

    // Receiver grid: both shapes reassemble to the same logical message.
    const reassemble = (frames: JsonObject[]): JsonObject | undefined => {
      const chunks = new ClientMessageChunks(); let result: JsonObject | undefined;
      for (const frame of frames) {
        // All parts of one logical message share its sequence number.
        const part: JsonObject = { type: 'client_message_chunk', seq: 1,
          index: Number(frame.index), count: Number(frame.count), data: String(frame.data) };
        if (typeof frame.message_size_bytes === 'number') part.message_size_bytes = frame.message_size_bytes;
        result = chunks.receive(part);
      }
      return result;
    };
    const expected = (_frames: JsonObject[]): JsonObject =>
      ({ type: 'client_message', seq: 1, message: large });
    assert.deepEqual(reassemble(legacyFrames), expected(legacyFrames), 'legacy sender, newer receiver');
    assert.deepEqual(reassemble(nextFrames), expected(nextFrames), 'newer sender, newer receiver');
    // A newer sender never emits its shape to an unheard peer, which is the
    // compatibility guarantee: the older receiver only ever sees legacy frames.
    assert(legacyFrames.every(frame => frame.message_size_bytes === undefined), 'legacy peer never receives the newer shape');
  });
  await h.test('a peer keeps the older framing until it advertises the newer level', async () => {
    const f = await mobileFixture();
    try {
      await f.enable();
      const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'transport_resume', clientId: 'phone-chunk', lastServerSeq: 0 }));
      await client.next('transport_ready');
      const before = client.messages.filter(row => row.type === 'server_message_chunk');
      // No message yet: the advertisement itself is the only signal.
      client.socket.send(JSON.stringify({ type: 'transport_ping', skipHistory: true, chunking: 4 }));
      const pong = await client.next('transport_pong');
      assert.equal(object(pong).type, 'transport_pong');
      assert.deepEqual(before, []);
    } finally { await f.close(); }
  });
  await h.test('a phone-started turn stays remote-origin only until that turn settles', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const a = await f.connect(); await a.next('hello');
      a.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' })); await a.next('history');
      assert.equal(f.bridge.isRemoteOriginSession('s1'), false, 'an idle session carries no remote marker');
      a.socket.send(JSON.stringify({ type: 'send_message', sessionId: 's1', text: '/not-approved', clientMessageId: 'origin-1' }));
      await a.next('error');
      assert.equal(f.bridge.isRemoteOriginSession('s1'), true, 'the phone started this turn');
      // The turn ending drops the marker, so a later local turn in this session is free.
      f.bridge.publishEngineEvent({ type: 'done', sessionId: 's1' }, f.owner());
      assert.equal(f.bridge.isRemoteOriginSession('s1'), false, 'a settled turn no longer gates local work');
      await stopSocket(a.socket);
    } finally { await f.close(); }
  });
  await h.test('segment receipts skip only retained parts and a bare sequence acknowledgement trims through the cursor', () => {
    const delivery = new ReliableDelivery(); delivery.resumeChunkReceipts(true, []);
    const frames = delivery.enqueue({ type: 'large_response', body: 'x'.repeat(240 * 1024) });
    const later = delivery.enqueue({ type: 'later_response' });
    delivery.acknowledgeChunk(1, 0, frames.length);
    // A segment receipt only skips the part the receiver kept; the envelope stays queued.
    assert.deepEqual(delivery.replay(0).frames, [...frames.slice(1), ...later]);
    delivery.resumeChunkReceipts(true, []);
    assert.deepEqual(delivery.replay(0).frames, [...frames, ...later], 'receiver cache loss requires replaying the whole envelope');
    delivery.resumeChunkReceipts(true, [{ seq: 1, count: frames.length, receivedIndexes: [0] }]);
    assert.deepEqual(delivery.replay(0).frames, [...frames.slice(1), ...later]);
    delivery.acknowledgeChunk(1, 1, frames.length + 1);
    assert.deepEqual(delivery.replay(0).frames, [...frames.slice(1), ...later], 'invalid segment metadata cannot erase a part');
    // A bare sequence acknowledgement is the (seq, MAX) cursor: it trims through
    // that envelope, so replay resumes after it.
    delivery.acknowledge(2);
    assert.deepEqual(delivery.replay(2).frames, []);
    assert.equal(delivery.snapshot().messages.length, 0);
    assert.throws(() => delivery.resumeChunkReceipts(true, [{ seq: 1, count: 3, receivedIndexes: [0, 0] }]), /Invalid partial/);
  });
  await h.test('reliable delivery persists outbound replay and committed client cursors across bridge restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-transport-')), path = join(root, 'state.json');
    try {
      const first = new ReliableDeliveryStore(path); await first.ready(); const delivery = first.get('fixture_phone');
      const frames = delivery.enqueue({ type: 'fixture_persisted', value: 1 });
      assert.equal(delivery.acceptClient(1), 'accept'); delivery.commitClient(1);
      const cursors = object(JSON.parse(readFileSync(path + '.client-cursors', 'utf8')));
      assert.equal(object(object(cursors.clients).fixture_phone).lastClientSeq, 1, 'the committed inbound cursor is durable before its ACK');
      await first.close();
      const second = new ReliableDeliveryStore(path); await second.ready(); const restored = second.get('fixture_phone');
      assert.deepEqual(restored.replay(0).frames, frames); assert.equal(restored.acceptClient(1), 'duplicate');
      await second.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await h.test('expired replay payloads cannot erase durable inbound mutation identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-cursor-')), path = join(root, 'state.json');
    try {
      const first = new ReliableDeliveryStore(path); await first.ready(); const delivery = first.get('phone_with_old_replay');
      delivery.enqueue({ type: 'old_response' }); delivery.commitClient(1); await first.close();
      await rm(path + '.sqlite');
      const touchedAt = Date.now() - 10 * 60_000;
      const state = delivery.snapshot(); state.messages[0]!.createdAt = touchedAt;
      await writeFile(path, JSON.stringify({ version: 1, clients: { phone_with_old_replay: { touchedAt, state } } }));
      await writeFile(path + '.client-cursors', JSON.stringify({ version: 1, clients: { phone_with_old_replay: { touchedAt, lastClientSeq: 1 } } }));
      const second = new ReliableDeliveryStore(path); await second.ready(); const restored = second.get('phone_with_old_replay');
      assert.equal(restored.replay(0).stale, true); assert.equal(restored.acceptClient(1), 'duplicate');
      assert.equal(restored.acceptClient(2), 'accept'); await second.close();
      await rm(path);
      await rm(path + '.sqlite');
      const third = new ReliableDeliveryStore(path);
      await third.ready();
      assert.equal(third.get('phone_with_old_replay').committedClientSeq(), 1, 'the independent receipt file survives a missing replay journal');
      await third.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await h.test('task delta queues use frame-sized text drains and bounded 50ms command output', async () => {
    const frames: JsonObject[] = [], streams = new MobileTaskStreams((_sessionId, frame) => frames.push(frame));
    streams.follow('s');
    streams.publish('s', { type: 'text_delta', sessionId: 's', messageId: 'm', text: 'x'.repeat(60) });
    await waitFor(() => frames.length === 3, 1000, 'Three animation-frame text patches');
    assert.deepEqual(frames.map(frame => frame.acceptedTextChanges), [24, 24, 12]);

    frames.length = 0;
    streams.publish('s', { type: 'text_delta', sessionId: 's', messageId: 'm', text: 'y'.repeat(240) });
    streams.publish('s', { type: 'done', sessionId: 's' });
    await waitFor(() => frames.some(frame => (frame.patches as JsonObject[]).some(patch => object(patch.value).type === 'done')), 1000, 'Terminal event after bounded drain');
    const doneIndex = frames.findIndex(frame => (frame.patches as JsonObject[]).some(patch => object(patch.value).type === 'done'));
    assert.equal(doneIndex, Number(object(object(remoteStreamVector.taskStream).textBatch).maximumDrainFrames));

    frames.length = 0;
    streams.publish('s', { type: 'progress', sessionId: 's', toolCallId: 'tool', content: 'z'.repeat(25_000) });
    await waitFor(() => frames.length === 1, 1000, 'Bounded output patch');
    const output = string(object((frames[0]!.patches as JsonObject[])[0]!.value).content);
    assert(output.startsWith('[output truncated]\n'));
    assert.equal(output.length, 20_000 + '[output truncated]\n'.length);

    frames.length = 0;
    const cursor = streams.current('s'); streams.unfollow('s');
    streams.publish('s', { type: 'done', sessionId: 's' });
    assert.equal(streams.replay('s', cursor)?.length, 1, 'a temporary zero-follower interval must remain replayable');
    streams.reset();
    assert.equal(streams.replay('s', cursor), undefined, 'a service restart must invalidate the old in-memory stream epoch');
  });
  await h.test('project rows group a worktree session under its origin project', async () => {
    // A worktree directory is never a project identity. The host resolves membership into
    // `projectRoot` (`sessions/service.ts:1828`); keying by `workdir` gave every worktree its own
    // phantom project on the phone and made "new chat in project" impossible for the real project,
    // because `knownWorkdir` validates against exactly these rows.
    const projects = projectRows(
      [
        { id: 'main-session', workdir: '/repo', updatedAt: 30 },
        { id: 'worktree-session', workdir: '/repo/.klaus/worktrees/feature', projectRoot: '/repo', updatedAt: 40 },
        { id: 'workspace-session', workdir: '/elsewhere', workspaceId: 'ws-1', projectRoot: '/elsewhere', updatedAt: 50 },
      ],
      { roots: [{ path: '/repo', label: 'Repo', updatedAt: 1, conversationCount: 0 }] },
    );
    const repo = projects.find(row => row.workdir === '/repo')!;
    assert.equal(repo.conversationCount, 2, 'the worktree session must count toward its origin project');
    assert.equal(repo.updatedAt, 40, 'the newest member advances the project recency');
    assert(!projects.some(row => String(row.workdir).includes('worktrees')), 'no phantom worktree project');
    assert(!projects.some(row => row.workdir === '/elsewhere'), 'workspace-bound sessions stay out of the project list');
  });
  await h.test('workspace groups project to the phone with their bound sessions', async () => {
    // The desktop sidebar shows multi-folder workspace groups; `projectRows` skips their sessions
    // by design, so without this projection a phone never sees the group or its conversations.
    const groups = projectWorkspaceGroups(
      [
        { id: 'ws-a', workdir: '/space/a', workspaceId: 'ws-1', updatedAt: 50 },
        { id: 'ws-b', workdir: '/space/a', workspaceId: 'ws-1', updatedAt: 30 },
        { id: 'loose', workdir: '/repo', updatedAt: 90 },
        { id: 'gone', workdir: '/space/x', workspaceId: 'ws-deleted', updatedAt: 80 },
      ],
      [
        { id: 'ws-1', name: 'Space', roots: ['/space/a', '/space/b'] },
        { id: 'ws-empty', name: 'Empty', roots: [] },
        { id: '', name: 'No id', roots: ['/space/c'] },
      ],
    );
    assert.deepEqual(groups, [{ id: 'ws-1', name: 'Space', roots: ['/space/a', '/space/b'], updatedAt: 50, conversationCount: 2 }],
      'empty-root and id-less groups are dropped; unknown workspace ids never fabricate a group');
    const f = await mobileFixture(); try {
      await f.enable();
      const state = object((await f.request('GET', '/api/mobile/desktop-state')).body.desktopState);
      assert.deepEqual(state.workspaces, [{ id: 'ws-fixture', name: 'Fixture space', roots: [join(f.root, 'space-a'), join(f.root, 'space-b')], updatedAt: 0, conversationCount: 0 }]);
      const created = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'ws-draft', workspaceId: 'ws-fixture', initialMessage: { text: 'In the space' } });
      assert.equal(created.status, 201);
      assert.equal(object(created.body).workspaceId, 'ws-fixture');
      const call = f.calls.filter(row => row.channel === 'session:new').at(-1)!;
      assert.equal(call.payload.workspaceId, 'ws-fixture'); assert.equal(call.payload.workdir, undefined);
      const unknown = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'ws-bad', workspaceId: 'ws-nope', initialMessage: { text: 'Nope' } });
      assert.equal(unknown.status, 403); assert.equal(object(unknown.body.error).type, 'unknown_workspace');
    } finally { await f.close(); }
  });
  await h.test('mobile working state follows the desktop turn contract, not every event', async () => {
    const f = await mobileFixture(); try {
      await f.enable();
      const running = async (): Promise<string[]> => object((await f.request('GET', '/api/mobile/desktop-state')).body.desktopState).runningSessionIds as string[];
      // Only the frame that OPENS a turn counts as working. `stream_mode` precedes every delta
      // and its other modes (responding/thinking/tool-use/idle) must not re-light a settled turn.
      f.bridge.publishEngineEvent({ type: 'stream_mode', sessionId: 's1', mode: 'requesting' }, f.owner());
      assert.deepEqual(await running(), ['s1']);
      f.bridge.publishEngineEvent({ type: 'done', sessionId: 's1' }, f.owner());
      assert.deepEqual(await running(), []);
      f.bridge.publishEngineEvent({ type: 'stream_mode', sessionId: 's1', mode: 'idle' }, f.owner());
      assert.deepEqual(await running(), [], 'an idle mode frame must not resurrect a finished turn');
      f.bridge.publishEngineEvent({ type: 'stream_mode', sessionId: 's1', mode: 'responding' }, f.owner());
      assert.deepEqual(await running(), [], 'a responding mode frame alone must not resurrect a finished turn');
      // A NON-terminal api_error is a follow-up or compaction notice: the turn is still running,
      // so the phone must not be told it ended (turn-termination-vectors.json).
      f.bridge.publishEngineEvent({ type: 'stream_mode', sessionId: 's1', mode: 'requesting' }, f.owner());
      f.bridge.publishEngineEvent({ type: 'api_error', sessionId: 's1', error: 'transient', terminal: false }, f.owner());
      assert.deepEqual(await running(), ['s1'], 'a non-terminal api_error must leave the turn running');
      f.bridge.publishEngineEvent({ type: 'api_error', sessionId: 's1', error: 'provider failed', terminal: true }, f.owner());
      assert.deepEqual(await running(), [], 'a terminal api_error ends the turn');
      f.bridge.publishEngineEvent({ type: 'stream_mode', sessionId: 's1', mode: 'requesting' }, f.owner());
      f.bridge.publishEngineEvent({ type: 'interrupted', sessionId: 's1' }, f.owner());
      assert.deepEqual(await running(), [], 'a user stop ends the turn');
    } finally { await f.close(); }
  });
  await h.test('WebSocket hello precedes requests, scopes events, accepts send and reports unknown commands', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const a = await f.connect(), b = await f.connect();
      a.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' }));
      await a.next('history'); assert.equal(a.messages[0]?.type, 'hello'); await a.next('hello'); await b.next('hello');
      b.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 's2' })); await b.next('history');
      f.bridge.publishEngineEvent({ type: 'text', sessionId: 's1', text: 'fixture-stream' }, f.owner());
      assert.equal(object((await a.next('engine_event')).event).text, 'fixture-stream'); await sleep(30); assert(!b.messages.some(row => row.type === 'engine_event'));
      a.socket.send(JSON.stringify({ type: 'send_message', sessionId: 's1', text: '/not-approved', clientMessageId: 'bad' }));
      assert.equal((await a.next('error')).code, 'unknown_slash_command'); assert.equal(f.sent.length, 0);
      assert(!a.messages.some(frame => frame.type === 'message_accepted'), 'a rejected turn must never be reported as accepted');
      a.socket.send('[]'); assert.equal((await a.next('error')).code, 'invalid_json');
      a.socket.send(JSON.stringify({ type: 'arbitrary_ipc', channel: 'settings:kv:set' })); assert.equal((await a.next('error')).code, 'unknown_message_type');
      a.socket.send(JSON.stringify({ type: 'rename_session', sessionId: 's1', title: 'Socket title' })); assert.equal((await a.next('action_result')).action, 'rename_session');
      await Promise.all([stopSocket(a.socket), stopSocket(b.socket)]);
    } finally { await f.close(); }
  });
  await h.test('connection hello and mutation admission do not wait for provider catalogs', async () => {
    const f = await mobileFixture(); let release!: () => void;
    try {
      await f.enable(); let entered = false;
      f.intercept(async channel => {
        if (channel !== 'session:get-main-model-options') return undefined;
        entered = true; await new Promise<void>(resolve => { release = resolve; }); return { options: [] };
      });
      const client = await f.connect(); const hello = await client.next('hello');
      assert.equal(object(hello.features).taskHistoryRead, 1);
      assert.equal(hello.runtimeConfig, undefined, 'initial readiness has no provider catalog dependency');
      await waitFor(() => entered, 1000, 'Background provider catalog started');
      client.socket.send(JSON.stringify({ type: 'rename_session', sessionId: 's1', title: 'Ready before models' }));
      assert.equal((await client.next('action_result')).ok, true);
      release(); await client.next('sessions_changed'); await stopSocket(client.socket);
    } finally { release?.(); await f.close(); }
  });
  await h.test('failed composer discovery preserves the healthy connection and session catalog', async () => {
    const f = await mobileFixture(); try {
      await f.enable();
      f.intercept(async channel => { if (channel === 'engine:slashCommands' || channel === 'session:get-main-model-options') throw new Error('Temporary model service outage'); return undefined; });
      const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1', transportRequestId: 'read-during-outage', historyRead: true }));
      assert.equal((await client.next('task_history')).transportRequestId, 'read-during-outage');
      assert.equal((await client.next('task_snapshot')).transportRequestId, 'read-during-outage');
      assert.equal(client.socket.readyState, WebSocket.OPEN); await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('composer discovery retries on the same socket after a temporary outage', async () => {
    const f = await mobileFixture({ composerRetryDelaysMs: [10] }); try {
      await f.enable(); let failures = 0;
      f.intercept(async channel => { if (channel === 'engine:slashCommands' && failures++ === 0) throw new Error('Temporary discovery error'); return undefined; });
      const client = await f.connect(); await client.next('hello');
      await waitFor(() => failures === 1, 1000, 'Initial composer discovery failed'); f.replaceOwner();
      await waitFor(() => client.messages.some(row => row.type === 'sessions_changed' && Array.isArray(row.slashCommands)), 3000, 'Composer restored on healthy socket');
      assert.equal(client.socket.readyState, WebSocket.OPEN); assert.equal(failures, 2); await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('the atomic cursor restores unfinished items without duplicating complete saved messages', () => {
    const projected = activeFollowEvents({ coveredMessageIds: ['complete-answer'], activeItems: [
      { turnId: 't', item: { id: 'complete-answer', type: 'agent_message', text: 'Already saved' } },
      { turnId: 't', item: { id: 'partial-answer', type: 'agent_message', text: 'Still generating', phase: 'final_answer' } },
      { turnId: 't', item: { id: 'thought', type: 'stream_reasoning', text: 'Thinking' } },
      { turnId: 't', item: { id: 'tool', type: 'command_execution', command: 'pwd', status: 'in_progress', aggregatedOutput: '/project' } },
    ] }, 's1').map(row => object(row.event));
    assert.equal(projected.some(row => row.messageId === 'complete-answer'), false);
    assert.deepEqual(projected.filter(row => row.type === 'text_delta'), [{ type: 'text_delta', text: 'Still generating', messageId: 'partial-answer', phase: 'final_answer', sessionId: 's1', turnId: 't' }]);
    assert.equal(projected.find(row => row.type === 'thinking_delta')?.thinking, 'Thinking');
    assert.equal(object(projected.find(row => row.type === 'tool_start')?.args).command, 'pwd');
    assert.equal(projected.find(row => row.type === 'progress')?.content, '/project');
    assert(projected.every(row => row.turnId === 't' && row.sessionId === 's1'));
  });
  await h.test('saved tool starts cannot hide active results or retained command output', () => {
    const rows = activeFollowEvents({ coveredMessageIds: ['tool'], coveredToolResults: [], activeItems: [
      { turnId: 't', item: { id: 'tool', type: 'tool_call', toolName: 'Bash', arguments: { command: 'pwd' }, result: 'completed output', status: 'completed' } },
      { turnId: 't', item: { id: 'tool-progress-stdout', type: 'tool_progress', toolUseId: 'tool', event: { type: 'stdout', chunk: 'retained stdout' } } },
    ] }, 's1').map(row => object(row.event));
    assert.equal(rows.find(row => row.type === 'tool_end')?.content, 'completed output');
    assert.equal(rows.find(row => row.type === 'progress')?.content, 'retained stdout');
    assert.equal(activeFollowEvents({ coveredMessageIds: ['tool'], coveredToolResults: [{ turnId: 't', toolUseId: 'tool' }], activeItems: [
      { turnId: 't', item: { id: 'tool', type: 'tool_call', status: 'completed', result: 'covered' } },
    ] }, 's1').length, 0);
  });
  await h.test('tool coverage is scoped by turn and never erases the diff snapshot', () => {
    const rows = activeFollowEvents({ coveredToolResults: [{ turnId: 'past', toolUseId: 'recycled' }], activeItems: [
      { turnId: 'current', item: { id: 'recycled', type: 'tool_call', toolName: 'Bash', arguments: {}, result: 'new output', status: 'completed' } },
      { turnId: 'past', item: { id: 'recycled-progress-file', type: 'tool_progress', toolUseId: 'recycled', event: { type: 'file_change', change: { path: '/changed.ts', kind: 'modified', added: 3, removed: 1 } } } },
      { turnId: 'current', item: { id: 'recycled-progress-stdout', type: 'tool_progress', toolUseId: 'recycled', truncated: true, event: { type: 'stdout', chunk: 'retained tail' } } },
    ] }, 's1').map(row => object(row.event));
    assert.equal(rows.find(row => row.type === 'tool_end')?.content, 'new output');
    assert.equal(object((rows.find(row => row.type === 'diff_update')?.changes as Json[])?.[0]).path, '/changed.ts');
    assert.equal(rows.find(row => row.type === 'progress')?.content, '[output truncated]\nretained tail');
  });
  await h.test('active task followers retain runtime interest through hydration and independent phone cleanup', async () => {
    const changed: string[] = [];
    const f = await mobileFixture({ sessionInterestChanged: id => changed.push(id) }); let release!: () => void;
    try {
      await f.enable(); const first = await f.connect(), second = await f.connect();
      await first.next('hello'); await second.next('hello'); let entered = false;
      f.intercept(async channel => { if (channel !== 'session:follow' || entered) return undefined;
        entered = true; await new Promise<void>(resolve => { release = resolve; }); return undefined; });
      first.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      await waitFor(() => entered, 1000, 'First follow is hydrating');
      assert.equal(f.bridge.hasSessionInterest('s1'), true, 'pending hydration owns interest');
      second.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      await second.next('task_snapshot'); release(); await first.next('task_snapshot');
      first.socket.send(JSON.stringify({ type: 'unfollow_task', sessionId: 's1' })); await sleep(20);
      assert.equal(f.bridge.hasSessionInterest('s1'), true, 'a sibling phone still follows');
      await stopSocket(second.socket);
      await waitFor(() => !f.bridge.hasSessionInterest('s1'), 1000, 'socket teardown drops the final interest');
      assert(changed.filter(id => id === 's1').length >= 4, 'interest transitions notify the retirement owner');
      assert.equal(f.bridge.hasSessionInterest('unrelated'), false);
      await stopSocket(first.socket);
    } finally { release?.(); await f.close(); }
  });
  await h.test('selected chat history has a reserved lane while two background resumes are stalled', async () => {
    const f = await mobileFixture(); const releases: Array<() => void> = [];
    try {
      await f.enable(); f.sessions.push({ id: 's3', title: 'Selected', updatedAt: 30 });
      const client = await f.connect(); await client.next('hello'); let blocked = 0;
      f.intercept(async (channel, payload) => {
        if (channel !== 'session:follow' || payload.sessionId === 's3') return undefined;
        blocked++; await new Promise<void>(resolve => releases.push(resolve)); return undefined;
      });
      for (const sessionId of ['s1', 's2']) client.socket.send(JSON.stringify({ type: 'follow_task', sessionId, transportRequestId: sessionId, historyRead: true }));
      await waitFor(() => blocked === 2, 1000, 'Two background restores blocked');
      client.messages.splice(0);
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's3', transportRequestId: 'selected', historyRead: true, foreground: true }));
      assert.equal((await client.next('task_history')).sessionId, 's3');
      assert.equal((await client.next('task_snapshot')).sessionId, 's3');
      for (const release of releases) release(); await stopSocket(client.socket);
    } finally { for (const release of releases) release(); await f.close(); }
  });
  await h.test('read-first history displays before a slow live follow and keeps its exact final cut', async () => {
    const f = await mobileFixture(); let release!: () => void;
    try {
      await f.enable(); f.histories.set('s1', [{ id: 'u1', uuid: 'u1', role: 'user', text: 'Saved before initialization', timestamp: 0 }]);
      const client = await f.connect(); await client.next('hello'); let entered = false;
      f.intercept(async channel => { if (channel !== 'session:follow') return undefined; entered = true; await new Promise<void>(resolve => { release = resolve; }); return {
        mode: 'snapshot', streamId: 'engine-s1', revision: 4, messages: f.histories.get('s1')!,
      }; });
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1', transportRequestId: 'read-first', historyRead: true }));
      const early = await client.next('task_history');
      assert.equal(object(early.history).sessionId, 's1'); assert.equal(early.transportRequestId, 'read-first');
      await waitFor(() => entered, 1000, 'Live follow initialization blocked');
      assert.equal(client.messages.some(row => row.type === 'task_snapshot'), false);
      f.bridge.publishEngineEvent({ type: 'text_delta', sessionId: 's1', sourceStreamId: 'engine-s1', sourceRevision: 4, text: 'covered' }, f.owner());
      f.bridge.publishEngineEvent({ type: 'text_delta', sessionId: 's1', sourceStreamId: 'engine-s1', sourceRevision: 5, text: 'later' }, f.owner());
      release(); const final = await client.next('task_snapshot');
      assert.equal(final.transportRequestId, 'read-first');
      assert.deepEqual((final.liveEvents as JsonObject[]).map(event => object(event.event).text), ['later']);
      await stopSocket(client.socket);
    } finally { release?.(); await f.close(); }
  });
  await h.test('a superseded saved read cannot overwrite its replacement follow', async () => {
    const f = await mobileFixture(); let release!: () => void;
    try {
      await f.enable(); const client = await f.connect(); await client.next('hello'); let reads = 0;
      f.intercept(async channel => { if (channel !== 'session:read' || ++reads !== 1) return undefined; await new Promise<void>(resolve => { release = resolve; }); return { messages: [{ id: 'stale', role: 'user', text: 'old', timestamp: 0 }] }; });
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1', transportRequestId: 'old-read', historyRead: true }));
      await waitFor(() => reads === 1, 1000, 'First saved read blocked');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1', transportRequestId: 'new-read', historyRead: true }));
      assert.equal((await client.next('task_history')).transportRequestId, 'new-read');
      assert.equal((await client.next('task_snapshot')).transportRequestId, 'new-read');
      release(); await sleep(30);
      assert.equal(client.messages.some(row => row.transportRequestId === 'old-read'), false);
      await stopSocket(client.socket);
    } finally { release?.(); await f.close(); }
  });
  await h.test('a ready phone reacquires a missing engine and invalidates the old stream epoch', async () => {
    let acquisitions = 0;
    const f = await mobileFixture({ ensureEngineOwner: async signal => { signal.throwIfAborted(); acquisitions++; } });
    try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1', transportRequestId: 'initial' }));
      const initial = await client.next('task_snapshot');
      f.replaceOwner(); f.dropOwner();
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1', transportRequestId: 'after-engine-loss' }));
      const gap = await client.next('task_gap'); assert.equal(gap.transportRequestId, undefined, 'engine replacement is an unsolicited invalidation');
      const restored = await client.next('task_snapshot'); assert.equal(restored.transportRequestId, 'after-engine-loss');
      assert.notEqual(restored.streamId, initial.streamId); assert.equal(acquisitions, 1);
      assert.equal(client.socket.readyState, WebSocket.OPEN); await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('v3 task stream snapshots, batches revisioned patches and replays unacked frames after reconnect', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const first = await f.connect(); await first.next('hello');
      first.socket.send(JSON.stringify({ type: 'transport_resume', clientId: 'fixture_phone', lastServerSeq: 0 }));
      await first.next('transport_ready');
      first.socket.send(JSON.stringify({ type: 'client_message', seq: 1, message: { type: 'follow_task', sessionId: 's1' } }));
      await first.next('client_ack');
      await waitFor(() => first.messages.some(row => row.type === 'server_message' && object(row.message).type === 'task_snapshot'), 3000, 'Revisioned task snapshot');
      const snapshotEnvelope = first.messages.splice(first.messages.findIndex(row => row.type === 'server_message' && object(row.message).type === 'task_snapshot'), 1)[0]!;
      const snapshot = object(snapshotEnvelope.message); assert.equal(snapshot.sessionId, 's1', JSON.stringify(snapshot)); assert.equal(snapshot.revision, 0, JSON.stringify(snapshot));
      const streamId = string(snapshot.streamId); assert(streamId);
      // The phone decodes the nested history with a REQUIRED sessionId; `session:follow`
      // itself does not return one, so the bridge must add it or the frame is thrown away.
      const history = object(snapshot.history);
      for (const key of (object(object(remoteStreamVector.taskStream).snapshot).historyRequiredFields as Json[] ?? []) as string[]) {
        assert(history[key] !== undefined, 'snapshot history must carry ' + key + ': ' + JSON.stringify(snapshot));
      }

      const listCalls = f.calls.filter(row => row.channel === 'session:list').length;
      f.bridge.publishEngineEvent({ type: 'text_delta', sessionId: 's1', sourceStreamId: 'engine-s1', sourceRevision: 1, text: 'alpha' }, f.owner());
      f.bridge.publishEngineEvent({ type: 'text_delta', sessionId: 's1', sourceStreamId: 'engine-s1', sourceRevision: 2, text: 'beta' }, f.owner());
      await waitFor(() => first.messages.some(row => row.type === 'server_message' && object(row.message).type === 'task_patch'), 3000, 'Batched task patch');
      const patchEnvelope = first.messages.find(row => row.type === 'server_message' && object(row.message).type === 'task_patch')!;
      const patch = object(patchEnvelope.message); assert.equal(patch.streamId, streamId, JSON.stringify(patch)); assert.equal(patch.baseRevision, 0, JSON.stringify(patch)); assert.equal(patch.revision, 1, JSON.stringify(patch));
      assert.equal((patch.patches as Json[]).length, 2, JSON.stringify(patch)); assert.equal(f.calls.filter(row => row.channel === 'session:list').length, listCalls, 'text deltas must not refresh the session catalog');

      const second = await f.connect(); await second.next('hello');
      second.socket.send(JSON.stringify({ type: 'transport_resume', clientId: 'fixture_phone', lastServerSeq: Number(snapshotEnvelope.seq) }));
      await second.next('transport_ready');
      await waitFor(() => first.socket.readyState === WebSocket.CLOSED, 3000, 'New transport replaces the old socket for one client ID');
      await waitFor(() => second.messages.some(row => row.type === 'server_message' && row.seq === patchEnvelope.seq), 3000, 'Unacked server replay');
      const replay = second.messages.find(row => row.type === 'server_message' && row.seq === patchEnvelope.seq)!;
      assert.deepEqual(replay.message, patchEnvelope.message);
      await stopSocket(second.socket);
    } finally { await f.close(); }
  });
  await h.test('a chunked reliable snapshot drains in order without tripping socket backpressure', async () => {
    const f = await mobileFixture(); try {
      const largeText = 'x'.repeat(400 * 1024);
      f.intercept(async channel => channel === 'session:follow' ? {
        mode: 'snapshot', streamId: 'engine-s1', revision: 0, sessionId: 's1',
        messages: [{ id: 'large-answer', role: 'assistant', text: largeText, timestamp: 1 }],
      } : undefined);
      await f.enable(); const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'transport_resume', clientId: 'large_snapshot_phone', lastServerSeq: 0 }));
      await client.next('transport_ready');
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 1, message: { type: 'follow_task', sessionId: 's1' } }));
      await client.next('client_ack');
      // Admission and hydration have independent completion boundaries. Waiting
      // for history here must not hold later sends behind a transport receipt.
      await waitFor(() => {
        const frames = client.messages.filter(frame => frame.type === 'server_message_chunk');
        return frames.length > 0 && frames.length === Number(frames[0]!.count);
      }, 3_000, 'Every snapshot chunk drains after admission');
      const chunks = client.messages.filter(frame => frame.type === 'server_message_chunk');
      assert(chunks.length > 2, 'the fixture snapshot must exercise the serialized multi-frame sender');
      assert.equal(chunks.length, Number(chunks[0]!.count), 'the snapshot is complete before reconstruction');
      const encoded = Buffer.concat(chunks.sort((a, b) => Number(a.index) - Number(b.index)).map(frame => Buffer.from(string(frame.data), 'base64')));
      const snapshot = object(JSON.parse(encoded.toString()));
      assert.equal(snapshot.type, 'task_snapshot');
      assert.equal(string(object((object(snapshot.history).messages as JsonObject[])[0]).text).length, largeText.length);
      assert.equal(client.socket.readyState, WebSocket.OPEN, 'a bounded large snapshot must not be mistaken for a slow consumer');
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('a rejected image advances its receipt and preserves the next text send across reconnect', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await resumePhone(f, 'rejected_image_phone');
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 1, message: {
        type: 'send_message', sessionId: 's1', text: 'bad image', clientMessageId: 'image-request',
        media: [{ type: 'image', mimeType: 'image/png', data: 'invalid' }],
      } }));
      await waitFor(() => client.messages.some(row => row.type === 'server_message' && object(row.message).type === 'error'), 1000, 'Image rejection');
      const error = object(client.messages.find(row => row.type === 'server_message' && object(row.message).type === 'error')!.message);
      assert.equal(error.clientMessageId, 'image-request'); assert.equal(error.sessionId, 's1'); assert.equal(error.clientSeq, 1);
      assert.equal((await client.next('client_ack')).seq, 1);
      await stopSocket(client.socket);
      const next = await resumePhone(f, 'rejected_image_phone');
      next.socket.send(JSON.stringify({ type: 'client_message', seq: 2, message: { type: 'send_message', sessionId: 's1', text: 'text after failure', clientMessageId: 'text-request' } }));
      assert.equal((await next.next('client_ack')).seq, 2);
      await waitFor(() => f.sent.length === 1, 1000, 'Text after rejected image');
      assert.equal(f.sent[0]!.payload.text, 'text after failure');
      assert(!next.messages.some(row => row.type === 'client_gap'));
    } finally { await f.close(); }
  });
  await h.test('transport admission precedes turn acceptance and a replacement socket receives the eventual result once', async () => {
    const f = await mobileFixture(); let release!: () => void; let entered = false;
    try {
      await f.enable(); const client = await resumePhone(f, 'pending_acceptance_phone');
      const blocked = new Promise<void>(resolve => { release = resolve; });
      f.intercept(async channel => { if (channel === 'chat:send') { entered = true; await blocked; } return undefined; });
      const frame = { type: 'client_message', seq: 1, message: { type: 'send_message', sessionId: 's1', clientMessageId: 'pending-turn', text: 'wait for admission' } };
      client.socket.send(JSON.stringify(frame)); await client.next('client_ack');
      await waitFor(() => entered, 1000, 'Turn admission pending');
      assert(!client.messages.some(row => object(row.message).type === 'message_accepted'));
      const next = await resumePhone(f, 'pending_acceptance_phone');
      next.socket.send(JSON.stringify(frame)); await next.next('client_ack');
      release(); await waitFor(() => next.messages.some(row => object(row.message).type === 'message_accepted'), 1000, 'Result on replacement socket');
      const accepted = next.messages.filter(row => object(row.message).type === 'message_accepted');
      assert.equal(accepted.length, 1); assert.equal(object(accepted[0]!.message).clientMessageId, 'pending-turn');
      assert.equal(f.sent.length, 1); assert.equal(f.calls.filter(row => row.channel === 'chat:send').length, 1);
    } finally { release?.(); await f.close(); }
  });
  await h.test('a turn rejection after its transport receipt remains correlated and does not stall later sends', async () => {
    const f = await mobileFixture(); let release!: () => void;
    try {
      await f.enable(); const client = await resumePhone(f, 'late_rejection_phone');
      const blocked = new Promise<void>(resolve => { release = resolve; });
      f.intercept(async (channel, payload) => {
        if (channel === 'chat:send' && payload.text === 'reject this turn') { await blocked; return { ok: false, error: 'fixture_turn_rejected' }; }
        return undefined;
      });
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 1, message: { type: 'send_message', sessionId: 's1', clientMessageId: 'rejected-turn', text: 'reject this turn' } }));
      await client.next('client_ack'); release();
      await waitFor(() => client.messages.some(row => object(row.message).type === 'error'), 1000, 'Rejected turn response');
      const rejected = object(client.messages.find(row => object(row.message).type === 'error')!.message);
      assert.equal(rejected.clientMessageId, 'rejected-turn'); assert.equal(rejected.sessionId, 's1');
      assert.equal(rejected.action, 'send_message'); assert.equal(rejected.clientSeq, 1); assert.equal(typeof rejected.requestId, 'string');
      assert(!client.messages.some(row => object(row.message).type === 'message_accepted'));
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 2, message: { type: 'send_message', sessionId: 's1', clientMessageId: 'next-turn', text: 'this turn works' } }));
      await client.next('client_ack'); await waitFor(() => f.sent.length === 1, 1000, 'Send after turn rejection');
      assert.equal(f.sent[0]!.payload.text, 'this turn works');
    } finally { release?.(); await f.close(); }
  });
  await h.test('a restored admitted request without its business result becomes explicitly unknown and is never silently resent', async () => {
    const f = await mobileFixture(); try {
      // This is the durable state after receipt admission, with the process lost
      // before its asynchronous engine admission produced a response journal.
      const path = join(f.root, 'mobile-transport-v1.json');
      await writeFile(path + '.client-cursors', JSON.stringify({ version: 1, clients: {
        restarted_phone: { touchedAt: Date.now(), lastClientSeq: 1 },
      } }));
      await f.enable();
      const client = await resumePhone(f, 'restarted_phone', 0, [], [
        { sessionId: 's1', clientMessageId: 'uncertain-image', clientSeq: 1 },
        { sessionId: 's1', clientMessageId: 'not-admitted-yet', clientSeq: 2 },
      ]);
      await waitFor(() => client.messages.some(row => object(row.message).code === 'outcome_unknown'), 1000, 'Explicit unknown business outcome');
      const response = object(client.messages.find(row => object(row.message).code === 'outcome_unknown')!.message);
      assert.equal(response.clientMessageId, 'uncertain-image'); assert.equal(response.sessionId, 's1');
      assert.equal(response.clientSeq, 1); assert.equal(response.action, 'send_message');
      assert(!client.messages.some(row => object(row.message).clientMessageId === 'not-admitted-yet'));
      assert.equal(f.sent.length, 0); assert(!f.calls.some(row => row.channel === 'chat:send'));
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 2, message: { type: 'send_message', sessionId: 's1', clientMessageId: 'new-user-message', text: 'send after checking delivery' } }));
      await client.next('client_ack'); await waitFor(() => f.sent.length === 1, 1000, 'Uncertainty does not break subsequent transport');
    } finally { await f.close(); }
  });
  await h.test('business receipt recovery repeats a retained result without dispatching its message again', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await resumePhone(f, 'recover_result_phone');
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 1, message: { type: 'send_message', sessionId: 's1', clientMessageId: 'recover-result', text: 'accepted once' } }));
      await client.next('client_ack');
      await waitFor(() => client.messages.some(row => object(row.message).type === 'message_accepted'), 1000, 'Original acceptance');
      const receipt = client.messages.find(row => object(row.message).type === 'message_accepted')!;
      client.socket.send(JSON.stringify({ type: 'server_ack', seq: receipt.seq })); await stopSocket(client.socket);
      const next = await resumePhone(f, 'recover_result_phone', Number(receipt.seq), [], [{ sessionId: 's1', clientMessageId: 'recover-result' }]);
      await waitFor(() => next.messages.some(row => object(row.message).type === 'message_accepted'), 1000, 'Recovered acceptance');
      assert.equal(f.sent.length, 1); assert.equal(f.calls.filter(row => row.channel === 'chat:send').length, 1);
      assert(!next.messages.some(row => object(row.message).code === 'outcome_unknown'));
    } finally { await f.close(); }
  });
  await h.test('a full replay journal drains as one ordered writer job instead of causing a reconnect loop', async () => {
    const f = await mobileFixture(); try {
      const store = new ReliableDeliveryStore(join(f.root, 'mobile-transport-v1.json'));
      await store.ready();
      const delivery = store.get('full_replay_phone');
      for (let index = 0; index < 1024; index++) delivery.enqueue({ type: 'fixture_replay', index });
      await store.close(); await f.enable(); const client = await resumePhone(f, 'full_replay_phone');
      await waitFor(() => client.messages.filter(row => row.type === 'server_message').length === 1024, 3000, 'All journal frames arrive');
      assert.equal(client.socket.readyState, WebSocket.OPEN);
      assert.deepEqual(client.messages.filter(row => row.type === 'server_message').map(row => row.seq), Array.from({ length: 1024 }, (_, index) => index + 1));
      client.socket.send(JSON.stringify({ type: 'server_ack', seq: 1024 }));
    } finally { await f.close(); }
  });
  await h.test('large image upload uses bounded frames and duplicate replay dispatches it only once', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await resumePhone(f, 'image_upload_phone');
      const image = Buffer.concat([Buffer.from(PNG_FIXTURE_BASE64, 'base64'), Buffer.alloc(8 * 1024 * 1024)]);
      const frames = clientChunks(1, { type: 'send_message', sessionId: 's1', text: 'inspect photo', clientMessageId: 'large-image',
        media: [{ type: 'image', mimeType: 'image/png', filename: 'photo.png', data: image.toString('base64') }] });
      assert(frames.length > 64);
      for (const frame of frames) { assert(Buffer.byteLength(JSON.stringify(frame)) < 150 * 1024); client.socket.send(JSON.stringify(frame)); }
      assert.equal((await client.next('client_ack')).seq, 1);
      await waitFor(() => f.sent.length === 1, 2000, 'Image reaches the engine owner');
      assert.equal(f.sent[0]!.files[0], image.toString('utf8'));
      const last = Math.max(...client.messages.filter(row => row.type === 'server_message').map(row => Number(row.seq)), 0);
      await stopSocket(client.socket); const next = await resumePhone(f, 'image_upload_phone', last);
      for (const frame of frames) next.socket.send(JSON.stringify(frame));
      await next.next('client_ack'); await sleep(30);
      assert.equal(f.sent.length, 1); assert.equal(next.socket.readyState, WebSocket.OPEN);
    } finally { await f.close(); }
  });
  await h.test('an interrupted partial image upload reassembles exactly once after resuming', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await resumePhone(f, 'partial_image_phone');
      const image = Buffer.concat([Buffer.from(PNG_FIXTURE_BASE64, 'base64'), Buffer.alloc(512 * 1024)]);
      const frames = clientChunks(1, { type: 'send_message', sessionId: 's1', text: 'resume photo', clientMessageId: 'partial-image',
        media: [{ type: 'image', mimeType: 'image/png', data: image.toString('base64') }] });
      for (const frame of frames.slice(0, 2)) client.socket.send(JSON.stringify(frame));
      await waitFor(() => client.messages.filter(row => row.type === 'client_chunk_ack').length === 2, 1000, 'Individual fragment receipts');
      assert(!client.messages.some(row => row.type === 'client_ack'), 'fragments alone cannot acknowledge the logical message');
      assert.equal(f.sent.length, 0); await stopSocket(client.socket);
      const next = await resumePhone(f, 'partial_image_phone');
      assert.deepEqual(next.ready.clientChunks, [{ seq: 1, count: frames.length, receivedIndexes: [0, 1] }]);
      for (const frame of frames.slice(2)) next.socket.send(JSON.stringify(frame));
      await next.next('client_ack'); await waitFor(() => f.sent.length === 1, 1000, 'Resumed upload');
      assert.equal(f.sent[0]!.files[0], image.toString('utf8'));
    } finally { await f.close(); }
  });
  await h.test('a resumed downstream snapshot sends only fragments the phone still lacks', async () => {
    const f = await mobileFixture(); try {
      f.histories.set('s1', [{ type: 'assistant', text: 'x'.repeat(400 * 1024) }]);
      await f.enable(); const client = await resumePhone(f, 'partial_snapshot_phone');
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 1, message: { type: 'follow_task', sessionId: 's1' } }));
      await client.next('client_ack');
      // Transport admission precedes asynchronous snapshot hydration.
      await waitFor(() => client.messages.some(row => row.type === 'server_message_chunk'), 1000, 'Snapshot chunk stream started');
      const { seq, count } = client.messages.find(row => row.type === 'server_message_chunk')!;
      const snapshotFrames = () => client.messages.filter(row => row.type === 'server_message_chunk' && row.seq === seq);
      await waitFor(() => snapshotFrames().length === count, 1000, 'Complete snapshot chunk stream');
      const frames = snapshotFrames();
      assert(frames.length > 3);
      client.socket.send(JSON.stringify({ type: 'server_chunk_ack', seq, count, index: 0 }));
      await stopSocket(client.socket);
      const next = await resumePhone(f, 'partial_snapshot_phone', 0, [{ seq: seq!, count: count!, receivedIndexes: [0] }]);
      await waitFor(() => next.messages.filter(row => row.type === 'server_message_chunk').length === frames.length - 1, 1000, 'Only missing snapshot fragments');
      assert(!next.messages.some(row => row.type === 'server_message_chunk' && row.index === 0));
      const received = [frames[0]!, ...next.messages.filter(row => row.type === 'server_message_chunk')];
      const encoded = Buffer.concat(received.sort((a, b) => Number(a.index) - Number(b.index)).map(row => Buffer.from(string(row.data), 'base64')));
      assert.equal(object(JSON.parse(encoded.toString())).type, 'task_snapshot');
      for (const frame of received) next.socket.send(JSON.stringify({ type: 'server_chunk_ack', seq, count, index: frame.index }));
      next.socket.send(JSON.stringify({ type: 'server_ack', seq }));
    } finally { await f.close(); }
  });
  await h.test('acknowledgements stay responsive while a task snapshot waits for the engine', async () => {
    const f = await mobileFixture(); let release!: () => void; let entered = false;
    try {
      await f.enable(); const client = await resumePhone(f, 'ack_control_phone');
      const blocked = new Promise<void>(resolve => { release = resolve; });
      f.intercept(async channel => { if (channel === 'session:follow') { entered = true; await blocked; } return undefined; });
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 1, message: { type: 'follow_task', sessionId: 's1' } }));
      await waitFor(() => entered, 1000, 'Slow follow admitted');
      for (let index = 0; index < 150; index++) {
        client.socket.send(JSON.stringify({ type: 'server_ack', seq: 0 }));
        client.socket.send(JSON.stringify({ type: 'task_ack', sessionId: 's1', streamId: 'engine-s1', revision: 0 }));
      }
      await sleep(30); assert.equal(client.socket.readyState, WebSocket.OPEN);
      release(); await client.next('client_ack');
    } finally { release?.(); await f.close(); }
  });
  await h.test('a task snapshot joins engine history with concurrent engine and interaction events exactly once', async () => {
    const f = await mobileFixture(); let release!: () => void; let entered = false;
    try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      f.intercept(async channel => {
        if (channel !== 'session:follow') return undefined;
        entered = true; await new Promise<void>(resolve => { release = resolve; });
        return { mode: 'snapshot', streamId: 'engine-s1', revision: 0, sessionId: 's1', messages: [] };
      });
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      await waitFor(() => entered, 1000, 'Atomic engine snapshot entered');
      f.bridge.publishEngineEvent({ type: 'text_delta', sessionId: 's1', sourceStreamId: 'engine-s1', sourceRevision: 1, text: 'after-cut' }, f.owner());
      f.bridge.publishPermissionRequest({ type: 'permission_pending', sessionId: 's1', requestId: 'during-cut', toolName: 'bash' }, f.owner());
      release();
      const snapshot = await client.next('task_snapshot');
      const all = [...snapshot.liveEvents as JsonObject[], ...snapshot.interactions as JsonObject[]];
      assert.equal(all.filter(frame => frame.requestId === 'during-cut').length, 1, 'the interaction crosses the cut exactly once');
      assert(all.some(frame => frame.type === 'engine_event' && object(frame.event).text === 'after-cut'), 'post-history engine event is retained');
      await sleep(30); assert(!client.messages.some(frame => frame.type === 'task_patch'), 'events through the snapshot revision are not repeated as patches');
      await stopSocket(client.socket);
    } finally { release?.(); await f.close(); }
  });
  await h.test('interaction frames reach a phone that follows another session, with an awaiting badge', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      await client.next('task_snapshot');
      // A follower of s1 used to be silently excluded from every other session's interaction
      // frames: the desktop turn blocked on s2's approval never reached the phone at all.
      f.bridge.publishPermissionRequest({ sessionId: 's2', requestId: 'other-approval', toolName: 'bash' }, f.owner());
      const frame = await client.next('permission_pending');
      assert.equal(frame.requestId, 'other-approval');
      const states = client.messages.filter(row => row.type === 'desktop_state_changed').map(row => object(row.desktopState));
      assert(states.some(state => (state.awaitingInteractionSessionIds as Json[] ?? []).includes('s2')),
        'the awaiting-interaction projection must name the blocked session');
      f.bridge.publishDesktopStateEvent('engine_status', { status: 'reconnecting' }, f.owner());
      const status = await client.next('engine_event');
      assert.equal(object(status.event).type, 'engine_status');
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('workflow relay preserves completed goal accounting, null clears and planning question identities', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' })); await client.next('history');
      const completed = { threadId: 's1', goalId: 'goal', objective: 'Finish the objective', status: 'complete', tokensUsed: 42, timeUsedSeconds: 9, createdAtMs: 1, updatedAtMs: 2 };
      for (const payload of [{ sessionId: 's1', goal: completed, goalRevision: 3 }, { sessionId: 's1', goal: null, goalRevision: 4 }]) {
        f.bridge.publishDesktopStateEvent('goal_updated', payload, f.owner());
        assert.deepEqual((await client.next('engine_event')).event, { ...payload, type: 'goal_updated' });
      }
      const question = { sessionId: 's1', requestId: 'question', turnId: 'turn', toolCallId: 'tool', status: 'pending', optional: true, questions: [] };
      f.bridge.publishDesktopStateEvent('planning_input_requested', question, f.owner());
      assert.deepEqual((await client.next('engine_event')).event, { ...question, type: 'planning_input_requested' });
      const resolution = { ...question, status: 'skipped', answers: {} };
      f.bridge.publishDesktopStateEvent('planning_input_resolved', resolution, f.owner());
      assert.deepEqual((await client.next('engine_event')).event, { ...resolution, type: 'planning_input_resolved' });
      f.bridge.publishDesktopStateEvent('goal_updated', { sessionId: 's1', goal: completed, goalRevision: 99 }, { ...f.owner(), generation: 99 });
      await sleep(10);
      assert(!client.messages.some(frame => object(frame.event).goalRevision === 99), 'a replaced owner cannot publish stale workflow state');
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('permission replies require the original engine generation and resolve only once', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const a = await f.connect(); await a.next('hello');
      f.bridge.publishPermissionRequest({ sessionId: 's1', requestId: 'p1', toolName: 'fixture', toolInput: { x: 1 } }, f.owner());
      assert.equal((await a.next('permission_pending')).requestId, 'p1');
      assert.equal((await f.request('POST', '/api/mobile/permissions/p1/respond', { decision: 'allow', updatedInput: { x: 2 } })).status, 202);
      assert.equal((await a.next('permission_resolved')).decision, 'allow'); assert.equal((await f.request('POST', '/api/mobile/permissions/p1/respond', { decision: 'deny' })).status, 409);
      const old = f.owner(); f.bridge.publishPermissionRequest({ requestId: 'p2', sessionId: 's1' }, old); f.replaceOwner();
      assert.equal((await f.request('POST', '/api/mobile/permissions/p2/respond', { decision: 'allow' })).status, 409);
      const count = f.calls.filter(row => row.channel === 'permission:respond').length;
      f.bridge.publishPermissionRequest({ requestId: 'p3', sessionId: 's1' }, old);
      assert.equal((await f.request('POST', '/api/mobile/permissions/p3/respond', { decision: 'allow' })).status, 409);
      assert.equal(f.calls.filter(row => row.channel === 'permission:respond').length, count); await stopSocket(a.socket);
    } finally { await f.close(); }
  });
  await h.test('rotation closes sockets, invalidates tokens and drains accepted message cancellation', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const token = f.status().token, a = await f.connect(); await a.next('hello');
      let entered = false, drained = false;
      f.intercept(async (channel, _payload, context) => { if (channel !== 'chat:send') return undefined; entered = true; await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { drained = true; resolve(); }, { once: true })); context.signal.throwIfAborted(); return null; });
      await f.request('POST', '/api/mobile/sessions/s1/messages', { text: 'pending' }); await waitFor(() => entered, 2000, 'Dispatch entered');
      f.updateStatus(await f.bridge.rotateToken()); assert(drained); assert.notEqual(f.status().token, token); await waitFor(() => a.socket.readyState === WebSocket.CLOSED, 1000, 'Old socket closed');
      assert.equal((await f.request('GET', '/api/mobile/bootstrap', undefined, { authorization: 'Bearer ' + token })).status, 401);
      assert.equal(f.sent.length, 0);
    } finally { await f.close(); }
  });
  await h.test('occupied preferred port falls back to a real ephemeral loopback listener', async () => {
    const f = await mobileFixture(), occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
    try { const address = occupied.address(); assert(address && typeof address !== 'string'); f.updateStatus(await f.bridge.set({ enabled: true, port: address.port }));
      assert.notEqual(f.status().port, address.port); assert.equal((await f.request('GET', '/healthz')).status, 200);
      const livePort = f.status().port; f.updateStatus(await f.bridge.set({ enabled: false })); assert.equal(f.status().running, false); await assert.rejects(fetch('http://127.0.0.1:' + livePort + '/healthz'));
    } finally { await f.close(); await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });
  await h.test('friends transport starts at account bootstrap while disabled phone and native routes remain closed', async () => {
    const received: JsonObject[] = [];
    const f = await mobileFixture({ friendMessage: async message => { received.push(message as unknown as JsonObject); return { accepted: true, taskId: 'pending-real-task', awaitingAuthorization: true }; } });
    try {
      f.updateStatus(await f.bridge.set({ enabled: false }));
      f.account({ token: 'fixture-account-token', userId: 'fixture-user' });
      f.updateStatus(await f.bridge.startFromSettings());
      assert.equal(f.status().enabled, false); assert.equal(f.status().running, false); assert.equal(f.status().friendTransportRunning, true);
      const transport = await f.bridge.ensureFriendTransport();
      assert.equal(transport.connected, true);
      f.updateStatus(await f.bridge.get());
      assert.equal(f.status().relayConnected, false); assert.equal(f.status().friendTransportConnected, true);
      const registration = f.cloudRequests.find(row => row.path.endsWith('/register'))!;
      assert.equal(registration.payload.deviceId, transport.deviceId); assert.equal(object(registration.payload.features).friendsMessaging, 2);
      const relay = f.relays[0]!, hello = relay.frames.find(row => row.type === 'desktop_hello')!;
      assert.equal(hello.friendsMessaging, 2); assert.equal(hello.remoteAccessEnabled, false);
      assert.equal((await f.request('GET', '/api/mobile/bootstrap')).status, 403);
      assert.equal((await f.request('POST', '/api/mobile/desktop/invoke', { channel: 'projects:list' })).status, 403);
      await assert.rejects(f.connect(), /401/u);
      relay.socket.send(JSON.stringify({ type: 'http_request', requestId: 'forbidden-remote', method: 'GET', path: '/api/mobile/bootstrap' }));
      await waitFor(() => relay.frames.some(row => row.requestId === 'forbidden-remote'), 1000, 'Disabled remote request refusal');
      assert.equal(relay.frames.find(row => row.requestId === 'forbidden-remote')!.status, 403);
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_open', clientId: 'forbidden-phone' }));
      await waitFor(() => relay.frames.some(row => row.type === 'mobile_ws_close' && row.clientId === 'forbidden-phone'), 1000, 'Disabled phone refusal');
      relay.socket.send(JSON.stringify({ type: 'friend_message', requestId: 'friend-relay-request', message: { kind: 'task', requestId: 'sender-request' } }));
      await waitFor(() => relay.frames.some(row => row.type === 'friend_message_response' && row.requestId === 'friend-relay-request'), 1000, 'Pending friend admission');
      const admitted = relay.frames.find(row => row.requestId === 'friend-relay-request')!;
      assert.equal(admitted.taskId, 'pending-real-task'); assert.equal(admitted.awaitingAuthorization, true); assert.equal(admitted.threadId, undefined);
      assert.equal(received.length, 1); assert.equal(f.calls.length, 0, 'Pending friend reception never dispatches engine or remote controls');
      const initialDeviceId = transport.deviceId;
      f.updateStatus(await f.bridge.set({ enabled: true }));
      assert.equal((await f.bridge.ensureFriendTransport()).deviceId, initialDeviceId);
      f.updateStatus(await f.bridge.get()); assert.equal(f.status().running, true);
      assert.equal((await f.request('GET', '/api/mobile/bootstrap')).status, 200);
      f.updateStatus(await f.bridge.set({ enabled: false }));
      assert.equal((await f.bridge.ensureFriendTransport()).deviceId, initialDeviceId);
      f.updateStatus(await f.bridge.get()); assert.equal(f.status().running, false); assert.equal(f.status().friendTransportConnected, true);
      assert.equal(f.cloudRequests.some(row => row.path.endsWith('/unregister')), false);
      const liveHello = f.relays.at(-1)!.frames.find(row => row.type === 'desktop_hello')!;
      assert.equal(liveHello.remoteAccessEnabled, false);
      assert.equal((await f.request('GET', '/api/mobile/bootstrap')).status, 403);
    } finally { await f.close(); }
  });
  await h.test('a friends-only relay cannot publish phone notifications while enabled remote access still can', async () => {
    const f = await mobileFixture({ friendMessage: async () => ({ accepted: true, taskId: 'pending-task', awaitingAuthorization: true }) });
    try {
      f.updateStatus(await f.bridge.set({ enabled: false })); f.account({ token: 'fixture-account-token', userId: 'fixture-user' });
      f.updateStatus(await f.bridge.startFromSettings()); await f.bridge.ensureFriendTransport();
      const disabled = f.relays.at(-1)!;
      f.bridge.publishTaskNotice('s1', 'disabled-phone-notice', false);
      await sleep(80); assert.equal(disabled.frames.filter(row => row.type === 'push_event').length, 0);
      f.updateStatus(await f.bridge.set({ enabled: true })); await f.bridge.ensureFriendTransport();
      const enabled = f.relays.at(-1)!;
      f.bridge.publishTaskNotice('s1', 'enabled-phone-notice', false);
      await waitFor(() => enabled.frames.some(row => row.type === 'push_event'), 1000, 'Explicit remote access phone notification');
      assert.equal(object(enabled.frames.find(row => row.type === 'push_event')!.event).eventId, 'done:s1:enabled-phone-notice');
      // This notice is still unacknowledged and persisted when the relay restarts.
      f.updateStatus(await f.bridge.set({ enabled: false })); await f.bridge.ensureFriendTransport();
      const friendOnly = f.relays.at(-1)!;
      f.bridge.publishTaskNotice('s1', 'disabled-after-restart', false);
      await sleep(80); assert.equal(friendOnly.frames.filter(row => row.type === 'push_event').length, 0);
      f.updateStatus(await f.bridge.set({ enabled: true })); await f.bridge.ensureFriendTransport();
      const restored = f.relays.at(-1)!;
      await waitFor(() => restored.frames.some(row => row.type === 'push_event'), 1000, 'Enabled remote access restores pending phone notices');
      assert(restored.frames.filter(row => row.type === 'push_event').every(row => object(row.event).eventId === 'done:s1:enabled-phone-notice'));
      f.bridge.publishTaskNotice('s1', 'enabled-after-restart', false);
      await waitFor(() => restored.frames.some(row => row.type === 'push_event' && object(row.event).eventId === 'done:s1:enabled-after-restart'), 1000, 'Enabled phone notifications continue after reconfiguration');
    } finally { await f.close(); }
  });
  await h.test('friends readiness requires successful current-protocol registration rather than a legacy heartbeat fallback', async () => {
    const f = await mobileFixture({ friendMessage: async () => ({ accepted: true, taskId: 'pending-task', awaitingAuthorization: true }) });
    try {
      f.account({ token: 'fixture-account-token', userId: 'fixture-user' }); f.cloudStatus(503, 200);
      f.updateStatus(await f.bridge.startFromSettings());
      const ready = f.bridge.ensureFriendTransport();
      await waitFor(() => f.cloudRequests.some(row => row.path.endsWith('/register')), 1000, 'Failed friend registration');
      assert.equal(f.cloudRequests.some(row => row.path.endsWith('/heartbeat')), false); assert.equal(f.relays.length, 0);
      f.cloudStatus(200); assert.equal((await ready).connected, true);
    } finally { await f.close(); }
  });
  await h.test('trusted v2 revocations and connection lifecycle hooks remain active with remote access disabled', async () => {
    const revoked: string[] = []; let connected = 0, disconnected = 0, releaseRevocation: () => void = () => {};
    const waiting = new Promise<void>(resolve => { releaseRevocation = resolve; });
    const f = await mobileFixture({
      friendMessage: async () => ({ accepted: true, taskId: 'pending-task', awaitingAuthorization: true }),
      friendRevoked: async id => { revoked.push(id); await waiting; },
      friendConnected: () => { connected++; }, friendDisconnected: () => { disconnected++; },
    });
    try {
      f.updateStatus(await f.bridge.set({ enabled: false })); f.account({ token: 'fixture-account-token', userId: 'fixture-user' });
      f.updateStatus(await f.bridge.startFromSettings()); await f.bridge.ensureFriendTransport();
      assert.equal(connected, 1);
      const relay = f.relays[0]!, friendshipId = '11111111-1111-4111-8111-111111111111';
      relay.socket.send(JSON.stringify({ type: 'desktop_hello_ack', friendsMessaging: 2, remoteAccessEnabled: false }));
      relay.socket.send(JSON.stringify({ type: 'friend_revoked', friendshipId: '../malformed' }));
      relay.socket.send(JSON.stringify({ type: 'friend_revoked', friendshipId }));
      await waitFor(() => revoked.length === 1, 1000, 'Trusted revocation callback');
      assert.deepEqual(revoked, [friendshipId]); assert.equal(connected, 1, 'Duplicate acknowledgement does not re-run reconciliation');
      const restart = f.bridge.restart();
      await Promise.race([restart, sleep(1000).then(() => { throw new Error('Restart waited for the parent-owned revocation job'); })]);
      releaseRevocation();
      await f.bridge.ensureFriendTransport(); assert.equal(connected, 2); assert.equal(disconnected, 1);
      f.relays.at(-1)!.socket.terminate();
      await waitFor(() => disconnected === 2, 1000, 'Disconnected scope reconciliation');
      await waitFor(() => connected === 3, 2000, 'Reconnected scope reconciliation');
      f.updateStatus(await f.bridge.get()); assert.equal(f.status().enabled, false); assert.equal(f.status().running, false);
    } finally { releaseRevocation(); await f.close(); }
  });
  await h.test('friends readiness rejects an old relay without a v2 acknowledgement within ten seconds', async () => {
    const f = await mobileFixture({ acknowledgeFriendHello: false, friendMessage: async () => ({ accepted: true, taskId: 'pending-task', awaitingAuthorization: true }) });
    try {
      f.updateStatus(await f.bridge.set({ enabled: false }));
      f.account({ token: 'fixture-account-token', userId: 'fixture-user' }); f.updateStatus(await f.bridge.startFromSettings());
      const started = Date.now();
      await assert.rejects(f.bridge.ensureFriendTransport(), error => object(error).code === 'friends_transport_unavailable');
      assert(Date.now() - started < 10_500); f.updateStatus(await f.bridge.get());
      assert.equal(f.status().friendTransportConnected, false); assert.equal(f.status().running, false);
    } finally { await f.close(); }
  });
  await h.test('relay v1 handshake hashes the pairing token and forwards real HTTP and local WebSockets', async () => {
    const f = await mobileFixture(); try {
      f.account({ token: 'fixture-account-token', userId: 'fixture-user' }); await f.enable();
      await waitFor(() => !!f.relays[0]?.frames.some(row => row.type === 'desktop_hello'), 2000, 'Relay hello'); const relay = f.relays[0]!;
      const hello = relay.frames.find(row => row.type === 'desktop_hello')!; assert.equal(hello.protocolVersion, 1); assert.equal(hello.mobileTokenHash, createHash('sha256').update(string(f.status().token)).digest('hex'));
      assert.equal(relay.request.headers.authorization, 'Bearer fixture-account-token'); assert(!JSON.stringify(hello).includes(string(f.status().token)));
      relay.socket.send(JSON.stringify({ type: 'http_request', requestId: 'r1', method: 'GET', path: '/api/mobile/bootstrap' }));
      await waitFor(() => relay.frames.some(row => row.requestId === 'r1'), 2000, 'Relayed HTTP'); const answer = relay.frames.find(row => row.requestId === 'r1')!;
      assert.equal(answer.status, 200); assert.equal(object(JSON.parse(string(answer.body))).protocolVersion, 3);
      relay.socket.send(JSON.stringify({ type: 'http_request', requestId: 'escape', method: 'GET', path: 'http://example.invalid/' }));
      await waitFor(() => relay.frames.some(row => row.requestId === 'escape'), 2000, 'Relay path rejection'); assert.equal(relay.frames.find(row => row.requestId === 'escape')!.code, 'desktop_request_failed');
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_open', clientId: 'phone' }));
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_message', clientId: 'phone', data: JSON.stringify({ type: 'subscribe', sessionId: 's1' }) }));
      await waitFor(() => relay.frames.some(row => row.type === 'mobile_ws_message' && object(JSON.parse(string(row.data))).type === 'history'), 2000, 'Relayed socket history');
      const mobileFrames = relay.frames.filter(row => row.type === 'mobile_ws_message'); assert.equal(object(JSON.parse(string(mobileFrames[0]!.data))).type, 'hello');
      await waitFor(() => f.cloudRequests.length > 0, 2000, 'Device registration'); const registration = f.cloudRequests[0]!;
      assert.equal(registration.request.headers.authorization, 'Bearer fixture-account-token'); assert.equal(registration.payload.relayId, f.status().relayId); assert.equal(string(registration.payload.deviceId).length, 64);
      assert.equal(relay.request.headers['x-klaus-device-id'], registration.payload.deviceId);
      assert.equal(object(registration.payload.features).threadCommunication, 1);
      assert.equal(object(object(await f.bridge.get()).settings).relayConnected, true);
    } finally { await f.close(); }
  });
  await h.test('relay heartbeat fallback, 401 stop and restart drain connection generations', async () => {
    const f = await mobileFixture(); try {
      f.cloudStatus(503); f.account({ token: 'fixture-token', userId: 'fixture-user' }); await f.enable();
      await waitFor(() => f.cloudRequests.some(row => row.path.endsWith('/heartbeat')), 2000, 'Fallback heartbeat');
      f.cloudStatus(401); await waitFor(async () => object(object(await f.bridge.get()).settings).relayConnected === false && f.cloudRequests.some(row => row.path.endsWith('/register')), 2000, 'Rejected account stops relay');
      await waitFor(() => f.relays.every(row => row.socket.readyState === WebSocket.CLOSED), 2000, 'Relay closed after 401');
      const count = f.relays.length; await sleep(100); assert.equal(f.relays.length, count);
      f.cloudStatus(200); f.updateStatus(await f.bridge.refreshAccount()); await waitFor(() => f.relays.length > count, 2000, 'Explicit account refresh restarts');
      const newRelay = f.relays.at(-1)!; newRelay.socket.terminate(); await waitFor(() => f.relays.length > count + 1, 2000, 'Transient close reconnects');
      await f.bridge.close(); const after = f.relays.length; await sleep(80); assert.equal(f.relays.length, after); assert(f.relays.every(row => row.socket.readyState === WebSocket.CLOSED));
    } finally { await f.close(); }
  });
  await h.test('relay flow control pauses only its target phone and resumes queued downstream messages', async () => {
    const f = await mobileFixture(); try {
      f.account({ token: 'fixture-token', userId: 'fixture-user' }); await f.enable();
      await waitFor(() => !!f.relays[0]?.frames.length, 1000, 'Relay connected'); const relay = f.relays[0]!;
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_open', clientId: 'slow_phone' }));
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_flow', clientId: 'slow_phone', paused: true }));
      for (const clientId of ['slow_phone', 'healthy_phone']) {
        if (clientId === 'healthy_phone') relay.socket.send(JSON.stringify({ type: 'mobile_ws_open', clientId }));
        relay.socket.send(JSON.stringify({ type: 'mobile_ws_message', clientId, data: JSON.stringify({ type: 'subscribe', sessionId: 's1' }) }));
      }
      const historyFor = (clientId: string) => relay.frames.filter(row => row.type === 'mobile_ws_message' && row.clientId === clientId && object(JSON.parse(string(row.data))).type === 'history');
      await waitFor(() => historyFor('healthy_phone').length === 1, 1000, 'Other phone remains responsive');
      assert.equal(historyFor('slow_phone').length, 0); assert.equal(relay.socket.readyState, WebSocket.OPEN);
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_flow', clientId: 'slow_phone', paused: false }));
      await waitFor(() => historyFor('slow_phone').length === 1, 1000, 'Paused phone resumes without reconnecting');
      assert.equal(historyFor('healthy_phone').length, 1); assert.equal(f.relays.length, 1);
    } finally { await f.close(); }
  });
  await h.test('socket pings keep idle relay connections alive and stop with their generation', async () => {
    const f = await mobileFixture({ socketHeartbeatMs: 15, socketPongTimeoutMs: 100 });
    try {
      f.account({ token: 'fixture-token', userId: 'fixture-user' }); await f.enable();
      await waitFor(() => !!f.relays[0]?.frames.length, 1000, 'Relay connected'); const relay = f.relays[0]!;
      let pings = 0; relay.socket.on('ping', () => { pings++; });
      await waitFor(() => pings >= 4, 1000, 'Matching WebSocket pongs');
      assert.equal(f.relays.length, 1); assert.equal(relay.socket.readyState, WebSocket.OPEN);
      await f.bridge.close(); const finalPings = pings;
      await sleep(60); assert.equal(pings, finalPings); assert.equal(f.relays.length, 1);
    } finally { await f.close(); }
  });
  await h.test('a relay without matching pongs reconnects even when HTTP heartbeat still succeeds', async () => {
    const events: string[] = [];
    const f = await mobileFixture({ socketHeartbeatMs: 20, socketPongTimeoutMs: 80, log: event => events.push(event) });
    try {
      f.account({ token: 'fixture-token', userId: 'fixture-user' }); await f.enable();
      await waitFor(() => !!f.relays[0]?.frames.length, 1000, 'Relay connected'); const relay = f.relays[0]!;
      await waitFor(() => f.cloudRequests.filter(row => row.path.endsWith('/register')).length >= 2, 1000, 'Periodic HTTP registration heartbeat');
      const sendPong = relay.socket.pong.bind(relay.socket);
      relay.socket.pong = () => { sendPong('wrong-generation'); };
      await waitFor(() => f.relays.length > 1, 1500, 'A missed socket pong reconnects');
      assert(events.includes('relay_pong_timeout'));
      assert(f.cloudRequests.filter(row => row.path.endsWith('/register')).length >= 2, 'the unrelated HTTP heartbeat does not hide a dead socket');
      assert.equal(relay.socket.readyState, WebSocket.CLOSED);
    } finally { await f.close(); }
  });
  await h.test('every operation another computer may request reaches the destination conversation tools', async () => {
    const received: string[] = [];
    const f = await mobileFixture({ threadRequest: async (name, _payload, context) => { context.assertCurrent(); received.push(name); return { ok: true, operation: name }; } });
    const payload = { caller: { hostId: 'peer', threadId: 'source' }, requestId: 'request-1', arguments: {} };
    try {
      f.account({ token: 'token', userId: 'user' }); await f.enable();
      for (const operation of REMOTE_THREAD_OPERATIONS) {
        const response = await f.request('POST', '/api/mobile/thread-tools/' + operation, payload);
        assert.equal(response.status, 200, operation + ' is routed to the conversation tools');
        assert.equal(response.body.operation, operation);
      }
      assert.deepEqual(received, [...REMOTE_THREAD_OPERATIONS]);
      for (const operation of ['fork_thread', 'wait_threads', 'session_op', '']) {
        assert.equal((await f.request('POST', '/api/mobile/thread-tools/' + operation, payload)).status, 404, operation + ' stays local');
      }
      assert.equal((await f.request('GET', '/api/mobile/thread-tools/list_projects')).status, 404, 'only POST reaches the conversation tools');
      assert.deepEqual(received, [...REMOTE_THREAD_OPERATIONS]);
    } finally { await f.close(); }
  });
  await h.test('remote thread requests remain bound to the account that started their bridge', async () => {
    let delivered = 0;
    const f = await mobileFixture({ threadRequest: async (_name, _payload, context) => { context.assertCurrent(); delivered++; return { ok: true }; } });
    const payload = { caller: { hostId: 'peer', threadId: 'source' }, requestId: 'message-1', arguments: { threadId: 's1', prompt: 'hi' } };
    try {
      f.account({ token: 'old-token', userId: 'old-user' }); await f.enable();
      assert.equal((await f.request('POST', '/api/mobile/thread-tools/send_message_to_thread', payload)).status, 200);
      f.account({ token: 'new-token', userId: 'new-user' });
      assert.equal((await f.request('POST', '/api/mobile/thread-tools/send_message_to_thread', payload)).status, 401);
      assert.equal(delivered, 1);
      f.updateStatus(await f.bridge.refreshAccount());
      assert.equal((await f.request('POST', '/api/mobile/thread-tools/send_message_to_thread', payload)).status, 200);
      assert.equal(delivered, 2);
    } finally { await f.close(); }
  });
  await h.test('a late registration response cannot expire a replacement account', async () => {
    for (const status of [401, 503]) {
      const f = await mobileFixture();
      let account = { token: 'old-token', userId: 'old-user' }, expired = 0, requested = false;
      let finish!: (value: Response) => void;
      const response = new Promise<Response>(resolve => { finish = resolve; });
      const relay = new MobileRelay({ ...new MobileSettingsStore(f.root, f.relayURL, {}).read(), localBaseURL: 'http://127.0.0.1:1' }, {
        configRoot: f.root, account: () => account, machineIdentifier: async () => 'fixture-machine',
        authorizationExpired: () => { expired++; }, fetch: async () => { requested = true; return response; }, retryDelaysMs: [10],
      });
      try {
        relay.start(); await waitFor(() => requested, 2000, 'Pending old-account registration');
        account = { token: 'new-token', userId: 'new-user' };
        finish(new Response('{}', { status })); await sleep(50);
        assert.equal(expired, 0); assert.equal(relay.status().connected, false);
      } finally { await relay.close(); await f.close(); }
    }
  });
  await h.test('account-scoped device identity retains stored legacy seed on Windows and macOS', async () => {
    const f = await mobileFixture(); try {
      withSettingsDb(f.root, db => db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('mobile_bridge.device_seed', 'legacy-seed'));
      const expected = createHash('sha256').update('klaus-mobile-bridge:v1\0user-a\0fallback:legacy-seed').digest('hex');
      assert.equal(await mobileDeviceId(f.root, 'user-a', 'win32', async () => { throw new Error('Seed must win'); }), expected);
      assert.equal(await mobileDeviceId(f.root, 'user-a', 'darwin', async () => 'new-machine'), expected);
      assert.notEqual(await mobileDeviceId(f.root, 'user-b', 'win32', async () => undefined), expected);
    } finally { await f.close(); }
  });
  await h.test('authenticated malformed and declared oversized HTTP bodies fail before product actions', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const origin = 'http://127.0.0.1:' + f.status().port;
      const invalid = await fetch(origin + '/api/mobile/runtime-config', { method: 'POST', headers: { authorization: 'Bearer ' + f.status().token }, body: '{invalid' });
      assert.equal(invalid.status, 400); assert.equal(object(object(await invalid.json()).error).type, 'invalid_json');
      assert.equal((await f.request('POST', '/api/mobile/runtime-config', [])).status, 400);
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(origin + '/api/mobile/sessions', { method: 'POST', headers: { authorization: 'Bearer ' + f.status().token, 'content-length': 28 * 1024 * 1024 + 1 } }, response => { response.resume(); response.once('end', () => { resolve(response.statusCode!); request.destroy(); }); });
        request.once('error', reject); request.flushHeaders();
      });
      assert.equal(status, 413); assert(!f.calls.some(row => row.channel === 'session:new'));
    } finally { await f.close(); }
  });
  await h.test('an engine replacement rejects an in-flight bootstrap before any later dispatch', async () => {
    const f = await mobileFixture(); let release!: () => void;
    try {
      await f.enable(); let entered = false;
      f.intercept(async channel => { if (channel !== 'session:list' || entered) return undefined; entered = true; await new Promise<void>(resolve => { release = resolve; }); return f.sessions; });
      const pending = f.request('GET', '/api/mobile/bootstrap'); await waitFor(() => entered, 1000, 'Bootstrap owner captured'); f.replaceOwner(); release();
      const response = await pending; assert.equal(response.status, 409); assert.equal(object(response.body.error).type, 'engine_replaced');
      assert.deepEqual(f.calls.map(row => row.channel), ['session:list']);
    } finally { release?.(); await f.close(); }
  });
  await h.test('permission events during bootstrap queue after hello and cancellation cannot restore a failed reply', async () => {
    const f = await mobileFixture(); let release!: () => void;
    try {
      await f.enable(); let entered = false;
      f.intercept(async channel => { if (channel !== 'session:list' || entered) return undefined; entered = true; await new Promise<void>(resolve => { release = resolve; }); return f.sessions; });
      const client = await f.connect(); await waitFor(() => entered, 1000, 'Hello bootstrap pending');
      f.bridge.publishPermissionRequest({ sessionId: 's1', requestId: 'p-before-hello' }, f.owner()); release(); await client.next('permission_pending'); assert.equal(client.messages[0]?.type, 'hello');
      let replying = false;
      f.intercept(async channel => { if (channel !== 'permission:respond') return undefined; replying = true; await new Promise<void>(resolve => { release = resolve; }); return { ok: false, error: 'fixture_cancelled' }; });
      const answer = f.request('POST', '/api/mobile/permissions/p-before-hello/respond', { decision: 'allow' }); await waitFor(() => replying, 1000, 'Permission dispatch pending');
      f.bridge.publishEngineEvent({ type: 'permission_cancelled', sessionId: 's1', requestId: 'p-before-hello' }, f.owner()); release(); assert.equal((await answer).status, 500);
      assert.equal((await f.request('POST', '/api/mobile/permissions/p-before-hello/respond', { decision: 'allow' })).status, 409); await stopSocket(client.socket);
    } finally { release?.(); await f.close(); }
  });
  await h.test('all WebSocket mutation verbs return their current action_result shapes', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      for (const payload of [{ type: 'set_runtime_config', sessionId: 's1', mainModel: 'low' }, { type: 'stop_generation', sessionId: 's1' }, { type: 'delete_session', sessionId: 's2' }]) {
        client.socket.send(JSON.stringify(payload)); const result = await client.next('action_result'); assert.equal(result.action, payload.type); assert.equal(result.ok, true);
      }
      f.bridge.publishPermissionRequest({ sessionId: 's1', requestId: 'p-ws' }, f.owner()); await client.next('permission_pending');
      client.socket.send(JSON.stringify({ type: 'permission_respond', requestId: 'p-ws', decision: 'deny' }));
      assert.deepEqual(await client.next('action_result'), { type: 'action_result', action: 'permission_respond', ok: true, requestId: 'p-ws' }); await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('relay client-id replacement cannot let an old close remove its live successor', async () => {
    const f = await mobileFixture(); try {
      f.account({ token: 'fixture-token', userId: 'fixture-user' }); await f.enable(); await waitFor(() => !!f.relays[0]?.frames.length, 1000, 'Relay connected'); const relay = f.relays[0]!;
      const count = () => relay.frames.filter(row => row.type === 'mobile_ws_message' && object(JSON.parse(string(row.data))).type === 'hello').length;
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_open', clientId: 'same-client' })); await waitFor(() => count() === 1, 1000, 'First local socket');
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_open', clientId: 'same-client' })); await waitFor(() => count() === 2, 1000, 'Replacement local socket');
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_message', clientId: 'same-client', data: JSON.stringify({ type: 'subscribe', sessionId: 's2' }) }));
      await waitFor(() => relay.frames.some(row => row.type === 'mobile_ws_message' && object(JSON.parse(string(row.data))).type === 'history'), 1000, 'Replacement remains routable');
      assert(!relay.frames.some(row => row.type === 'mobile_ws_close'));
      relay.socket.send(JSON.stringify({ type: 'mobile_ws_close', clientId: 'same-client' }));
    } finally { await f.close(); }
  });
  await h.test('history forwards the per-turn metadata the fold needs', async () => {
    const f = await mobileFixture(); try {
      await f.enable();
      // `session:history` returns turn metadata BESIDE `messages`; forwarding only the rows left
      // the phone unable to tell a completed turn from a stopped one, so it could not apply the
      // desktop's collapse rule (an interrupted turn must stay expanded).
      f.intercept(async channel => channel === 'session:history' ? {
        messages: [{ id: 's1-0', role: 'assistant', text: 'answer', timestamp: 0, turnId: 't1' }],
        turnStatuses: { t1: 'interrupted' }, turnDurations: { t1: 1123 },
        turnErrors: { t1: 'Provider error' },
      } : undefined);
      const { body } = await f.request('GET', '/api/mobile/sessions/s1/history');
      assert.deepEqual(object(body).turnStatuses, { t1: 'interrupted' });
      assert.deepEqual(object(body).turnDurations, { t1: 1123 });
      assert.equal((body.messages as unknown[]).length, 1);
      // Turn failures and future transcript metadata must survive the transport unchanged.
      assert.deepEqual(body.turnErrors, { t1: 'Provider error' });

      // A host that sends no metadata must still yield a decodable response.
      f.intercept(async channel => channel === 'session:history' ? { messages: [] } : undefined);
      const bare = await f.request('GET', '/api/mobile/sessions/s1/history');
      assert.deepEqual(object(bare.body).turnStatuses, {});
      assert.deepEqual(object(bare.body).turnDurations, {});
      assert.deepEqual(bare.body.messages, []);
    } finally { await f.close(); }
  });
  await h.test('relay disconnection cancels the real local HTTP request and does not publish its stale answer', async () => {
    const f = await mobileFixture(); try {
      f.account({ token: 'fixture-token', userId: 'fixture-user' }); await f.enable(); await waitFor(() => !!f.relays[0]?.frames.length, 1000, 'Relay connected');
      let entered = false, cancelled = false;
      f.intercept(async (channel, _payload, context) => { if (channel !== 'session:history') return undefined; entered = true;
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true })); context.signal.throwIfAborted(); return [];
      });
      const relay = f.relays[0]!; relay.socket.send(JSON.stringify({ type: 'http_request', requestId: 'stale-http', method: 'GET', path: '/api/mobile/sessions/s1/history' }));
      await waitFor(() => entered, 1000, 'Relayed local history entered'); relay.socket.terminate();
      await waitFor(() => cancelled, 1000, 'Local dispatch abort propagated'); await waitFor(() => f.relays.length > 1, 1000, 'Next relay generation');
      assert(!f.relays.some(row => row.frames.some(frame => frame.requestId === 'stale-http')));
    } finally { await f.close(); }
  });
  await h.test('elicitation vectors retain their response channel and resolve independently of approvals', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      const card = transcriptVector.elicitation!, response = transcriptVector.response!;
      f.bridge.publishElicitationRequest(card, f.owner());
      assert.deepEqual(await client.next('elicit_pending'), { ...card, type: 'elicit_pending' });
      const id = encodeURIComponent(string(card.requestId));
      assert.equal((await f.request('POST', '/api/mobile/permissions/' + id + '/respond', { decision: 'allow' })).status, 409);
      assert.equal((await f.request('POST', '/api/mobile/elicitations/' + id + '/respond', response)).status, 202);
      assert.deepEqual(await client.next('elicit_resolved'), { type: 'elicit_resolved', sessionId: 's1', requestId: card.requestId, ...response });
      assert.deepEqual(f.calls.filter(row => row.channel === 'elicit:respond').map(row => row.payload), [{ requestId: card.requestId, ...response }]);
      assert.equal((await f.request('POST', '/api/mobile/elicitations/' + id + '/respond', response)).status, 409);

      f.bridge.publishElicitationRequest({ requestId: 'mcp-form', sessionId: 's1', type: 'mcp-elicit', requestedSchema: { type: 'object' } }, f.owner());
      assert.equal((await client.next('elicit_pending')).elicitationType, 'mcp-elicit');
      client.socket.send(JSON.stringify({ type: 'elicit_respond', requestId: 'mcp-form', response: { kind: 'accept', values: { enabled: true } } }));
      assert.deepEqual(await client.next('action_result'), { type: 'action_result', action: 'elicit_respond', ok: true, requestId: 'mcp-form' });
      assert.deepEqual(object((await client.next('elicit_resolved')).response), { kind: 'accept', values: { enabled: true } });
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('JSON response endpoints preserve opaque request IDs and their response contracts', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      const vector = transcriptVector.interactionTransport!;
      for (const requestId of vector.requestIds as string[]) {
        f.bridge.publishPermissionRequest({ sessionId: 's1', requestId }, f.owner()); await client.next('permission_pending');
        f.bridge.publishElicitationRequest({ sessionId: 's1', requestId }, f.owner()); await client.next('elicit_pending');
        for (const kind of ['permission', 'elicit'] as const) {
          const path = string(vector[kind === 'permission' ? 'permissionEndpoint' : 'elicitationEndpoint']);
          const response: JsonObject = kind === 'permission' ? { decision: 'allow', updatedInput: { path: 'result.txt' }, acceptedSuggestionIndices: [0] }
            : { response: { kind: 'accept', values: { enabled: true, destination: 'result.txt' } } };
          const answer = await f.request('POST', path, { requestId, ...response });
          assert.equal(answer.status, 202); assert.deepEqual(answer.body, { ok: true, requestId });
          assert.deepEqual(await client.next(kind + '_resolved'), { type: kind + '_resolved', sessionId: 's1', requestId, ...response });
          assert.deepEqual(f.calls.filter(row => row.channel === kind + ':respond').at(-1)!.payload, { requestId, ...response });
          assert.equal((await f.request('POST', path, { requestId, ...response })).status, vector.expiredStatus);
        }
      }
      for (const requestId of [null, 12, '', ' ', 'invalid\0id']) {
        assert.equal((await f.request('POST', string(vector.permissionEndpoint), { requestId, decision: 'deny' })).status, 400);
        assert.equal((await f.request('POST', string(vector.elicitationEndpoint), { requestId, response: { kind: 'decline' } })).status, 400);
      }
      assert.equal((await f.request('POST', string(vector.permissionEndpoint), { decision: 'deny' })).status, 400);
      assert.equal((await f.request('POST', string(vector.elicitationEndpoint), { response: { kind: 'decline' } })).status, 400);
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('late successful replies reject ownership lost to cancellation or a desktop response', async () => {
    const f = await mobileFixture(); let release: (() => void) | undefined;
    try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      const vector = transcriptVector.interactionTransport!;
      for (const kind of ['permission', 'elicit'] as const) for (const resolution of ['cancelled', 'resolved'] as const) {
        const requestId = kind + '-' + resolution;
        if (kind === 'permission') f.bridge.publishPermissionRequest({ sessionId: 's1', requestId }, f.owner());
        else f.bridge.publishElicitationRequest({ sessionId: 's1', requestId }, f.owner());
        await client.next(kind + '_pending');
        let entered = false;
        f.intercept(async channel => {
          if (channel !== kind + ':respond') return undefined;
          entered = true; await new Promise<void>(resolve => { release = resolve; }); return { ok: true };
        });
        const path = string(vector[kind === 'permission' ? 'permissionEndpoint' : 'elicitationEndpoint']);
        const response: JsonObject = kind === 'permission' ? { decision: 'allow' } : { response: { kind: 'accept', values: ['One'] } };
        const answer = f.request('POST', path, { requestId, ...response });
        await waitFor(() => entered, 1000, 'Mobile reply dispatch pending');
        if (resolution === 'cancelled') f.bridge.publishEngineEvent({ type: kind + '_cancelled', sessionId: 's1', requestId }, f.owner());
        else f.bridge.noteRendererResponse(kind + ':respond', [{ requestId, ...(kind === 'permission' ? { decision: 'deny' } : { response: { kind: 'decline' } }) }]);
        await client.next(kind + '_' + resolution); release!(); release = undefined;
        const result = await answer;
        assert.equal(result.status, vector.expiredStatus); assert.equal(object(result.body.error).type, kind + '_expired'); assert.notEqual(result.body.ok, true);
        assert.equal((await f.request('POST', path, { requestId, ...response })).status, vector.expiredStatus);
        f.intercept(undefined);
      }
      await stopSocket(client.socket);
    } finally { release?.(); await f.close(); }
  });
  await h.test('subscribing restores parked questions and desktop responses close the phone cards', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      f.intercept(async channel => channel === 'permission:pending' ? [{ sessionId: 's1', requestId: 'parked-approval', toolName: 'bash' }]
        : channel === 'elicit:pending' ? [transcriptVector.elicitation!] : undefined);
      client.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' })); await client.next('history');
      assert.equal((await client.next('permission_pending')).responseChannel, 'permission');
      const card = await client.next('elicit_pending'); assert.equal(card.requestId, transcriptVector.elicitation!.requestId);
      f.bridge.noteRendererResponse('elicit:respond', [{ requestId: card.requestId!, response: { kind: 'decline' } }]);
      assert.deepEqual((await client.next('elicit_resolved')).response, { kind: 'decline' });
      f.bridge.noteRendererResponse('permission:respond', [{ requestId: 'parked-approval', decision: 'deny' }]);
      assert.equal((await client.next('permission_resolved')).decision, 'deny');
      assert.equal((await f.request('POST', '/api/mobile/elicitations/' + encodeURIComponent(string(card.requestId)) + '/respond', transcriptVector.response!)).status, 409);
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('elicitation cancellation and engine replacement cannot revive or misroute an answer', async () => {
    const f = await mobileFixture(); let release!: () => void;
    try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      f.bridge.publishElicitationRequest({ requestId: 'cancel-question', sessionId: 's1', options: ['One'] }, f.owner()); await client.next('elicit_pending');
      let replying = false;
      f.intercept(async channel => { if (channel !== 'elicit:respond') return undefined; replying = true; await new Promise<void>(resolve => { release = resolve; }); return { ok: false, error: 'fixture_cancelled' }; });
      const answer = f.request('POST', '/api/mobile/elicitations/cancel-question/respond', { response: { kind: 'accept', values: ['One'] } });
      await waitFor(() => replying, 1000, 'Elicitation dispatch pending');
      assert.equal((await f.request('POST', '/api/mobile/elicitations/cancel-question/respond', { response: { kind: 'decline' } })).status, 409);
      f.bridge.publishEngineEvent({ type: 'elicit_cancelled', sessionId: 's1', requestId: 'cancel-question' }, f.owner());
      assert.equal((await client.next('elicit_cancelled')).requestId, 'cancel-question'); release();
      assert.equal((await answer).status, 500);
      assert.equal((await f.request('POST', '/api/mobile/elicitations/cancel-question/respond', { response: { kind: 'decline' } })).status, 409);
      f.bridge.publishElicitationRequest({ requestId: 'old-question', sessionId: 's1' }, f.owner());
      f.replaceOwner();
      assert.equal((await f.request('POST', '/api/mobile/elicitations/old-question/respond', { response: { kind: 'decline' } })).status, 409);
      assert.equal(f.calls.filter(row => row.channel === 'elicit:respond').length, 1);
      await stopSocket(client.socket);
    } finally { release?.(); await f.close(); }
  });
  await h.test('elicitation validation accepts native and MCP answers without accepting permission decisions', async () => {
    assert.deepEqual(elicitationResponse({ response: { kind: 'accept', values: ['A', 'B'] } }), { response: { kind: 'accept', values: ['A', 'B'] } });
    assert.deepEqual(elicitationResponse({ response: { kind: 'accept', values: { enabled: true, count: 3 } } }), { response: { kind: 'accept', values: { enabled: true, count: 3 } } });
    for (const value of [{ decision: 'allow' }, { response: { kind: 'allow' } }, { response: { kind: 'accept', values: 'A' } }, { response: { kind: 'accept', values: [true] } }, { response: { kind: 'answers', answers: [] } }, { response: { kind: 'answers', answers: { a: false } } }]) {
      assert.throws(() => elicitationResponse(value));
    }
  });
  await h.test('child history preserves turn metadata and nested live tool media stays in its parent subscription', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const a = await f.connect(), b = await f.connect(); await a.next('hello'); await b.next('hello');
      a.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' })); await a.next('history');
      b.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 's2' })); await b.next('history');
      f.intercept(async channel => channel === 'agents:snapshot' ? { tasks: { 'spawn-tool': { agentId: 'child-1', agentName: 'Scout', avatarId: 2, status: 'running' } } }
        : channel === 'agents:history' ? transcriptVector.childHistory! : undefined);
      const agents = await f.request('GET', '/api/mobile/sessions/s1/agents');
      assert.deepEqual(agents.body.agents, [{ id: 'child-1', taskId: 'spawn-tool', toolCallId: 'spawn-tool', agentId: 'child-1', agentName: 'Scout', avatarId: 2, status: 'running' }]);
      const history = await f.request('GET', '/api/mobile/sessions/s1/agents/child-1/history');
      assert.deepEqual(history.body, { ...transcriptVector.childHistory, sessionId: 's1', agentId: 'child-1' });
      assert(f.calls.some(row => row.channel === 'agents:history' && row.payload.agentId === 'child-1' && row.payload.sessionId === 's1'));
      const before = f.calls.filter(row => row.channel === 'agents:history').length;
      assert.equal((await f.request('GET', '/api/mobile/sessions/missing/agents/child-1/history')).status, 404);
      assert.equal((await f.request('GET', '/api/mobile/sessions/s1/agents/child%2Fbad/history')).status, 400);
      assert.equal(f.calls.filter(row => row.channel === 'agents:history').length, before);
      f.bridge.publishEngineEvent(transcriptVector.childEvent!, f.owner());
      assert.deepEqual((await a.next('engine_event')).event, transcriptVector.childEvent);
      await sleep(20); assert(!b.messages.some(row => row.type === 'engine_event'));
      await stopSocket(a.socket); await stopSocket(b.socket);
    } finally { await f.close(); }
  });
  await h.test('authenticated media preview reuses canonical session scope and bounded binary transport', async () => {
    const f = await mobileFixture(), other = await mobileFixture(); try {
      await f.enable(); const path = join(f.root, 'preview.png'), outside = join(other.root, 'secret.png');
      await writeFile(path, Buffer.from(PNG_FIXTURE_BASE64, 'base64')); await writeFile(outside, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
      await symlink(outside, join(f.root, 'outside.png'));
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/media', { path }, {})).status, 401);
      const preview = await f.request('POST', '/api/mobile/sessions/s1/media', { path });
      assert.equal(preview.status, 200); assert.equal(preview.body.mimeType, 'image/png'); assert.equal(preview.body.data, PNG_FIXTURE_BASE64);
      assert.equal((await f.request('POST', '/api/mobile/sessions/missing/media', { path })).status, 404);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/media', { path: outside })).status, 403);
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/media', { path: join(f.root, 'outside.png') })).status, 403);
      const text = join(f.root, 'secret.txt'); await writeFile(text, 'Private text');
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/media', { path: text })).status, 415);
      let cancelled = false;
      await assert.rejects(mobileMediaPreview({ grant: async () => 'klaus-media://file/fixture', respond: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        headers: { 'content-type': 'image/png', 'content-length': String(MOBILE_MEDIA_PREVIEW_LIMIT + 1) },
      }) }, 's1', path, new AbortController().signal), /16 MiB/);
      assert.equal(cancelled, true);
    } finally { await f.close(); await other.close(); }
  });
  await h.test('file and diagram previews retain the session identity and do not invoke renderer windows', async () => {
    const f = await mobileFixture({ diagramPreview: (sessionId, id) => ({ document: { id, sessionId, pages: [] }, icons: { 'fixture:icon': 'M0 0' } }) }); try {
      await f.enable();
      f.intercept(async (channel, payload): Promise<Json | undefined> => channel === 'artifacts:read' ? payload.filePath === '/forbidden' ? { error: 'path outside preview scope' }
        : { filePath: payload.filePath!, fileName: 'file.ts', content: 'const value = 1;', size: 16, truncated: false, binary: false, encoding: 'utf8' } : undefined);
      const file = await f.request('POST', '/api/mobile/sessions/s1/file-preview', { path: '/fixture/file.ts' });
      assert.equal(file.status, 200); assert.equal(file.body.content, 'const value = 1;'); assert.equal(file.body.sessionId, 's1');
      assert.equal((await f.request('POST', '/api/mobile/sessions/s1/file-preview', { path: '/forbidden' })).status, 403);
      const diagram = await f.request('GET', '/api/mobile/sessions/s1/diagrams/diagram-1');
      assert.deepEqual(diagram.body, { sessionId: 's1', document: { id: 'diagram-1', sessionId: 's1', pages: [] }, icons: { 'fixture:icon': 'M0 0' } });
      assert.equal((await f.request('GET', '/api/mobile/sessions/missing/diagrams/diagram-1')).status, 404);
      assert(!f.calls.some(row => ['artifacts:open-window', 'workspace:open', 'digram:export'].includes(row.channel)));
    } finally { await f.close(); }
  });
  await h.test('a tiny-message flood cannot grow the WebSocket work queue without a bound', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); let cancelled = false;
      f.intercept(async (channel, _payload, context) => { if (channel !== 'session:list') return undefined;
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true })); context.signal.throwIfAborted(); return [];
      });
      const client = await f.connect(); for (let index = 0; index < 100; index++) client.socket.send('{}');
      await waitFor(() => client.socket.readyState === WebSocket.CLOSED && cancelled, 2000, 'Queue overflow closes and drains the peer');
    } finally { await f.close(); }
  });
  await h.test('interaction scenes stay on the live emitter vocabulary', async () => {
    // These scenes drive the iOS parity UI tests. They used to be an orphan vector: nothing on
    // the desktop read them, and the subagent scene still carried `teammate_spawned`, a type
    // the host emitter no longer produces (`engine-events.ts`: the emission surface is silent).
    const retired = ['teammate_spawned', 'teammate_messages', 'team_created', 'mcp_auth_url', 'context_collapse_stats', 'tombstone', 'plan_update'];
    const scenes = object(interactionVector.scenes);
    for (const [name, value] of Object.entries(scenes)) {
      const frames = value as JsonObject[];
      for (const frame of frames) {
        assert(!retired.includes(string(frame.type)), `scene ${name} carries retired type ${string(frame.type)}`);
      }
    }
    // The phone app replays the same scenes; its copy is checked against this vector by the
    // phone app's own repository.
  });
  await h.test('optional questions recover capability metadata without a blocking interaction registry', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      const question = questionVector.question!;
      f.intercept(async channel => channel === 'question:pending' ? [question] : undefined);
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      const snapshot = await client.next('task_snapshot');
      assert.deepEqual(snapshot.questions, [question]);
      assert.deepEqual(snapshot.interactions, [{ type: 'engine_event', event: { ...question, type: 'question_requested', recovered: true } }]);
      assert.equal(f.calls.filter(row => row.channel === 'question:pending').length, 1);
      assert(!f.calls.some(row => row.channel === 'session:new' || row.channel === 'chat:interrupt'));
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  await h.test('question snapshot cuts retain concurrent requests and partial answers but never revive closed questions', async () => {
    const question = questionVector.question!, pending = { type: 'engine_event', event: { ...questionVector.partial!, type: 'question_resolved' } };
    assert.deepEqual(followQuestions([question], 's1', [pending]), {
      questions: [{ ...question, answers: questionVector.partial!.answers }],
      interactions: [{ type: 'engine_event', event: { ...question, answers: questionVector.partial!.answers, type: 'question_requested', recovered: true } }],
    });
    const requested = { type: 'engine_event', event: { ...question, type: 'question_requested' } };
    assert.deepEqual(followQuestions([], 's1', [requested]), { questions: [question], interactions: [] });
    const closed = { type: 'engine_event', event: { ...questionVector.closed!, type: 'question_resolved' } };
    assert.deepEqual(followQuestions([question], 's1', [requested, closed]), { questions: [], interactions: [] });
    assert.deepEqual(followQuestions([question], 's1', [closed, requested, pending]), { questions: [], interactions: [] });
    const alreadyAnswered = { ...question, answers: { 'Which details?': 'Screenshots', 'Which format?': 'Three bullets' } };
    assert.deepEqual(followQuestions([alreadyAnswered], 's1', [requested, pending]).questions, [alreadyAnswered]);
    const done = { type: 'engine_event', event: { type: 'done', sessionId: 's1', turnId: question.turnId! } };
    assert.deepEqual(followQuestions([question], 's1', [done, requested]), { questions: [], interactions: [] });
    assert.deepEqual(followQuestions([question], 's1', [{ ...done, event: { ...done.event, turnId: 'another-turn' } }]).questions, [question]);
    assert.deepEqual(followQuestions([question], 's1', [{ ...closed, event: { ...object(closed.event), turnId: 'another-turn' } }]).questions, [question]);
    assert.throws(() => followQuestions({}, 's1', []), /invalid pending question list/);

    const f = await mobileFixture(); let release!: () => void; let entered = false;
    try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      f.intercept(async channel => {
        if (channel !== 'question:pending') return undefined;
        entered = true; await new Promise<void>(resolve => { release = resolve; }); return [question];
      });
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      await waitFor(() => entered, 1000, 'Pending question snapshot blocked');
      f.bridge.publishDesktopStateEvent('question_resolved', questionVector.closed!, f.owner()); release();
      const snapshot = await client.next('task_snapshot');
      assert.deepEqual(snapshot.questions, []); assert.deepEqual(snapshot.interactions, []);
      assert((snapshot.liveEvents as JsonObject[]).some(frame => object(frame.event).type === 'question_resolved'));
      await stopSocket(client.socket);
    } finally { release?.(); await f.close(); }
  });
  await h.test('optional question answer endpoint returns confirmed identities and preserves retry payloads', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); f.intercept(async channel => channel === 'question:answer' ? questionVector.confirmed : undefined);
      for (let retry = 0; retry < 2; retry++) {
        const answer = await f.request('POST', '/api/mobile/questions/answer', questionVector.answer);
        assert.equal(answer.status, 202); assert.deepEqual(answer.body, questionVector.confirmed);
      }
      assert.deepEqual(f.calls.filter(row => row.channel === 'question:answer').map(row => row.payload), [questionVector.answer, questionVector.answer]);
      assert.equal((await f.request('POST', '/api/mobile/questions/answer', { ...questionVector.answer, sessionId: 'missing-session' })).status, 404);
      for (const key of ['sessionId', 'requestId', 'turnId', 'clientResponseId']) {
        assert.equal((await f.request('POST', '/api/mobile/questions/answer', { ...questionVector.answer, [key]: ' ' })).status, 400);
      }
      for (const answers of [{}, [], { 'Which details?': 7 }] as Json[]) assert.throws(() => questionAnswer({ ...questionVector.answer, answers }));
      assert.equal(f.calls.filter(row => row.channel === 'question:answer').length, 2);
      assert(!f.calls.some(row => row.channel === 'chat:interrupt' || row.channel === 'permission:respond' || row.channel === 'elicit:respond'));
      f.intercept(async channel => { if (channel !== 'question:answer') return undefined; f.replaceOwner(); return questionVector.confirmed; });
      assert.equal((await f.request('POST', '/api/mobile/questions/answer', questionVector.answer)).status, 409);
    } finally { await f.close(); }
  });
  await h.test('question uploads use the host cache and attachment answers preserve per-question descriptors', async () => {
    const f = await mobileFixture(), workspaces = new WorkspaceStore({ configRoot: f.root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
    const attachments = new AttachmentService(workspaces);
    try {
      await f.enable(); f.intercept(async (channel, payload) => channel === 'chat:upload' ? attachments.upload(payload)
        : channel === 'question:answer' ? questionVector.confirmed : undefined);
      const uploaded = await f.request('POST', '/api/mobile/attachments', questionVector.upload);
      assert.equal(uploaded.status, 201); assert.equal(uploaded.body.size, 6); assert.equal(uploaded.body.lineCount, 1);
      assert.equal(uploaded.body.name, 'notes.txt'); assert.equal(uploaded.body.type, 'text/plain');
      assert(string(uploaded.body.path).startsWith(join(f.root, 'uploads') + '/'));
      const groups = { 'Which details?': [uploaded.body] }, answer: JsonObject = { ...questionVector.answer!, attachments: groups };
      assert.equal((await f.request('POST', '/api/mobile/questions/answer', answer)).status, 202);
      assert.deepEqual(f.calls.filter(row => row.channel === 'question:answer').at(-1)!.payload, answer);
      const response = { kind: 'answers', answers: answer.answers!, attachments: groups };
      assert.deepEqual(elicitationResponse({ response }), { response });
      assert.deepEqual(await attachments.answerAttachments(groups), {});
      for (const buffer of ['', 'a Gk=', 'aG==', {}]) {
        assert.equal((await f.request('POST', '/api/mobile/attachments', { ...questionVector.upload, buffer })).status, 400);
      }
      const limits = questionVector.attachmentLimits!;
      assert.throws(() => attachmentUpload({ name: 'large.png', type: 'image/png', buffer: 'A'.repeat(Math.ceil(Number(limits.image) / 3) * 4 + 4) }), /too large/);
      assert.throws(() => attachmentUpload({ name: 'large.bin', type: 'application/octet-stream', buffer: 'A'.repeat(Math.ceil(Number(limits.general) / 3) * 4 + 4) }), /too large/);
      assert.throws(() => questionAnswer({ ...answer, attachments: { 'Unanswered question': [uploaded.body] } }), /answered questions/);
      assert.throws(() => elicitationResponse({ response: { ...response, attachments: { 'Which details?': Array(21).fill(uploaded.body) } } }), /Too many/);
      const client = await f.connect(); await client.next('hello');
      f.bridge.publishElicitationRequest({ sessionId: 's1', requestId: 'attachment-question', attachmentsSupported: true }, f.owner());
      assert.equal((await client.next('elicit_pending')).attachmentsSupported, true);
      assert.equal((await f.request('POST', '/api/mobile/elicitations/respond', { requestId: 'attachment-question', response })).status, 202);
      assert.deepEqual(object((await client.next('elicit_resolved')).response), response);
      await stopSocket(client.socket);
    } finally { await attachments.close(); await f.close(); }
  });
  await h.test('permission receipts retain authoritative answers from desktop and phone responders', async () => {
    const f = await mobileFixture(); try {
      await f.enable(); const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's2' })); await client.next('task_snapshot');
      for (const source of ['desktop', 'phone']) {
        f.bridge.publishPermissionRequest({ sessionId: 's1', requestId: source }, f.owner()); await client.next('permission_pending');
        const payload = { requestId: source, ...questionVector.permissionReceipt! };
        if (source === 'desktop') f.bridge.noteRendererResponse('permission:respond', [payload]);
        else assert.equal((await f.request('POST', '/api/mobile/permissions/respond', payload)).status, 202);
        assert.deepEqual(await client.next('permission_resolved'), { type: 'permission_resolved', sessionId: 's1', ...payload });
      }
      await stopSocket(client.socket);
    } finally { await f.close(); }
  });
  process.exitCode = await h.finish(join(__dirname, 'mobile-bridge-result.json'), 'mobile-bridge'); clearTimeout(deadline);
})().catch(error => { clearTimeout(deadline); process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
