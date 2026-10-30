import { MobileModelConfigProjection } from '../main/services/mobile/model-config';
import { readSessionModel } from '../main/services/session-store';
import { withSettingsDb } from '../main/services/settings';
import { mobileFixture } from './mobile-fixture';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { validateInput, SessionQueue } from '../main/sessions/queue';
import { HostState } from '../main/services/host-state';
import type { SessionService } from '../main/sessions/service';
import { editPrepareFromRow } from '../main/sessions/lifecycle';
import { projectSessionHistory } from '../main/sessions/history';
import { object } from '../main/services/service-types';
import { uploadMime } from '../main/services/attachments';
import { extensionForMime, storeBytes, storeAntigravityMediaBytes } from '../main/services/media';
import { mediaItems } from '../main/services/mobile/protocol';
import { followUpPayload } from '../main/services/mobile/follow-ups';
import { Harness, assert, assertDeepEqual, assertEqual } from './harness';

const h = new Harness(), roots: string[] = [];
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/source-isolation-vectors.json'), 'utf8'));
const root = (): string => { const path = mkdtempSync(join(tmpdir(), 'klaus-source-isolation-')); roots.push(path); return path; };
const image = (data = 'AA==') => ({ type: 'image', base64: data, mimeType: 'image/png' });
const native = () => ({ type: 'media', base64: 'UklGRg==', mimeType: 'audio/webm;codecs=opus', filename: 'voice.webm' });
function refused(run: () => unknown): boolean { try { run(); return false; } catch { return true; } }

h.test('ordinary queued images retain their original count and base64 shape admission', () => {
  for (const source of vector.ordinarySources) {
    validateInput(Array.from({ length: vector.ordinaryQueueImageCount }, () => image()), source);
    validateInput([image(vector.ordinaryQueueNoncanonicalPadding)], source);
  }
  assert(refused(() => validateInput(Array.from({ length: vector.ordinaryQueueImageCount }, () => image()), 'antigravity')), 'native source retains its own aggregate limit');
  assert(refused(() => validateInput([image(vector.ordinaryQueueNoncanonicalPadding)], 'antigravity')), 'native source requires canonical encoding');
  validateInput([native()], 'antigravity');
  assert(refused(() => validateInput([native()])), 'an unspecified source does not enable native media');
});

h.test('the public queue edit dispatch selects the source policy without changing the facade request', async () => {
  const state = new HostState(); state.rememberSession('thread', 'engine-thread', {});
  const requests: unknown[] = [];
  const snapshot = { revision: 1, items: [{ state: 'pending', mutable: true, message: { uuid: 'queued', value: 'old' } }], status: 'authoritative' };
  const sessions = { request: async (method: string, params: Json) => { requests.push({ method, params }); return { queueMutation: { status: 'applied', snapshot } }; } } as unknown as SessionService;
  let source = 'custom';
  const queue = new SessionQueue(sessions, state, () => source);
  queue.snapshot = async () => ({ ok: true, snapshot });
  const payload = { sessionId: 'thread', request: { uuid: 'queued', mutationId: 'one', edit: { value: [native()] } } };
  assertEqual((await queue.mutate('edit', payload)).code, 'invalid-request', 'ordinary source is inert for native input');
  assertEqual(requests.length, 0, 'rejected native input never reaches the facade');
  source = 'antigravity';
  assertEqual((await queue.mutate('edit', payload)).ok, true, 'the native source remains editable');
  assertDeepEqual(requests, [{ method: 'session/editQueued', params: { sessionId: 'engine-thread', mutationId: 'one', uuid: 'queued', expectedRevision: 1, edit: { value: [native()] } } }], 'exact request identity and content are preserved');
});

h.test('unknown queue edits are rejected before source preferences are read or a facade mutation is sent', async () => {
  const folder = root(); readSessionModel('', folder);
  let sourceReads = 0, requests = 0;
  const sessions = {
    resolveLiveQueueSession: async () => { throw new Error('Unknown session'); },
    request: async () => { requests++; return {}; },
  } as unknown as SessionService;
  const queue = new SessionQueue(sessions, new HostState(), id => { sourceReads++; return readSessionModel(id, folder).source; });
  const reply = await queue.mutate('edit', { sessionId: 'unknown', request: { uuid: 'queued', mutationId: 'one', edit: { value: 'replacement' } } });
  assertEqual(reply.code, 'snapshot-unavailable', 'unknown session keeps the existing refusal');
  assertEqual(sourceReads, 0, 'source lookup never initializes an unknown conversation');
  assertEqual(withSettingsDb(folder, db => db.prepare('SELECT count(*) AS n FROM session_main_models WHERE session_id = ?').get('unknown')?.n), 0, 'no source preference is created');
  assertEqual(requests, 0, 'unknown queue mutation never reaches the facade');
});

h.test('unknown phone sends over HTTP and WebSocket cannot initialize preferences or dispatch a turn', async () => {
  const f = await mobileFixture();
  try {
    readSessionModel('', f.root); await f.enable();
    const client = await f.connect(); await client.next('hello');
    assertEqual((await f.request('POST', '/api/mobile/sessions/unknown-http/messages', { text: 'rejected' })).status, 404, 'unknown HTTP session is refused');
    client.socket.send(JSON.stringify({ type: 'send_message', sessionId: 'unknown-ws', text: 'rejected', clientMessageId: 'unknown-message' }));
    const error = await client.next('error');
    assertEqual(error.code, 'session_not_found', 'unknown WebSocket session keeps its refusal');
    assert(!client.messages.some(row => row.type === 'message_accepted'), 'unknown send is never accepted');
    for (const id of ['unknown-http', 'unknown-ws']) {
      assertEqual(withSettingsDb(f.root, db => db.prepare('SELECT count(*) AS n FROM session_main_models WHERE session_id = ?').get(id)?.n), 0, 'no preference row is created for ' + id);
    }
    assert(!f.calls.some(row => row.channel === 'chat:send' || row.channel === 'chat:upload'), 'unknown sends never upload or dispatch');
  } finally { await f.close(); }
});

h.test('ordinary phone model selection retains known-row eligibility and still rejects unknown identities', async () => {
  for (const source of [...vector.ordinarySources, 'antigravity']) {
    const projection = new MobileModelConfigProjection(async (channel): Promise<Json> => {
      if (channel === 'settings:models:list') return [{ id: 'known' }];
      if (channel === 'session:get-main-model-options') return { options: [{ value: `${source}:known`, label: 'Known', available: false }] };
      return { loggedIn: true };
    });
    await projection.validate({ source, selection: `${source}:known`, thinkingLevel: 'medium' }, false);
    let rejected = false;
    try { await projection.validate({ source, selection: `${source}:missing`, thinkingLevel: 'medium' }, false); } catch { rejected = true; }
    assert(rejected, 'unknown model identity stays unavailable for ' + source);
  }
});

h.test('ordinary MIME lookup remains narrow while the native adapter retains codec and opaque identities', () => {
  assertEqual(uploadMime('voice.webm', 'audio/webm;codecs=opus'), 'audio/webm', 'ordinary upload normalization is unchanged');
  assertEqual(uploadMime('voice.wav'), 'application/octet-stream', 'ordinary uploads do not infer new native formats');
  assertEqual(extensionForMime('video/audio/s16le'), undefined, 'opaque native formats do not expand the shared pool');
  const folder = root(), bytes = Buffer.from([1, 2, 3, 4]);
  assert(refused(() => storeBytes(bytes, 'video/audio/s16le', folder)), 'ordinary media rejects unknown unsniffable types');
  const nativePath = storeAntigravityMediaBytes(bytes, 'video/audio/s16le', folder);
  assert(nativePath.endsWith('.bin'), 'native opaque format uses its own stable pool extension');
  assertDeepEqual(readFileSync(nativePath), bytes, 'the native adapter preserves bytes');
});

h.test('ordinary edits keep the authoritative display envelope over unrelated projected metadata', () => {
  const original = { displayText: 'original text', attachments: [{ path: '/uploads/original.txt', name: 'original.txt' }] };
  const row = { text: 'model-facing text', contentBlocks: [{ type: 'text', text: 'model-facing text' }], localRender: { displayText: 'unrelated projection', attachments: [{ path: '/uploads/other.txt' }] } };
  const prepared = editPrepareFromRow('user-one', row, original);
  assertEqual(prepared.text, 'original text', 'ordinary text follows its display envelope');
  assertDeepEqual(prepared.displayMetadata, original, 'ordinary display metadata is not replaced');
  assertDeepEqual(prepared.attachments, [{ path: '/uploads/original.txt', name: 'original.txt' }], 'ordinary paths are not rewritten');
});

h.test('native replay recovers a vanished upload and editing reuses the pooled media once', () => {
  const folder = root(), absent = join(folder, 'removed.webm');
  const localRender = { displayText: 'listen', attachments: [{ type: 'file', path: absent, name: 'voice.webm', mimeType: 'audio/webm;codecs=opus' }] };
  const projected = object(projectSessionHistory({ history: [{ type: 'user', uuid: 'one', content: [native()] },
    { type: 'system', subtype: 'user_display', text: JSON.stringify({ messageUuid: 'one', localRender }) }], historyTurnIds: {} }, 'thread', folder));
  const row = object((projected.messages as Json[])[0]);
  assertDeepEqual(row.contentBlocks, [], 'the recorded file owns the one visible native attachment');
  const prepared = editPrepareFromRow('one', row, localRender), attachment = object(prepared.attachments[0]);
  assert(attachment.path !== absent, 'native edit uses the durable pool after the original disappears');
  assertEqual(attachment.originalPath, absent, 'native provenance survives');
  assertEqual(attachment.mimeType, native().mimeType, 'native MIME parameters survive');
  assertDeepEqual(readFileSync(String(attachment.path)), Buffer.from('UklGRg==', 'base64'), 'durable replay contains exact native bytes');
});

h.test('ordinary phone files keep reference payloads while the native source opts into media routing', () => {
  const descriptor = { type: 'file', path: '/uploads/voice.webm', name: 'voice.webm', mimeType: 'audio/webm;codecs=opus' };
  const ordinary = followUpPayload('listen', [descriptor]);
  assertDeepEqual(ordinary.media, [], 'ordinary phone files are references');
  assertDeepEqual(object(ordinary.displayMetadata).attachments, [{ type: 'file', name: 'voice.webm' }], 'ordinary display envelope stays unchanged');
  const input = [{ type: 'file', filename: 'voice.webm', mimeType: 'audio/webm;codecs=opus', data: 'UklGRg==' }];
  assertEqual(mediaItems(input)[0]?.mimeType, 'application/octet-stream', 'ordinary MIME admission stays narrow');
  const nativeInput = mediaItems(input, 'antigravity');
  assertEqual(nativeInput[0]?.mimeType, descriptor.mimeType, 'native phone input retains codec parameters');
  assertEqual(object((followUpPayload('listen', [descriptor], 'antigravity').media as Json[])[0]).type, 'media', 'native route stays explicit');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'source-isolation-result.json'), 'source-isolation');
  for (const path of roots) rmSync(path, { recursive: true, force: true });
  process.exitCode = failed;
})();
