import { mediaInputMime } from '../shared/media-input';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { buildMessageInput } from '../main/services/attachments';
import { ComposerService } from '../main/services/composer';
import { setSessionModel } from '../main/services/session-store';
import { validateInput } from '../main/sessions/queue';
import { SessionService } from '../main/sessions/service';
import { MobileFollowUpControls, followUpPayload, uploadFollowUpMedia } from '../main/services/mobile/follow-ups';
import { mediaItems } from '../main/services/mobile/protocol';
import { HostState } from '../main/services/host-state';
import { projectSessionHistory } from '../main/sessions/history';
import { editPrepareFromRow } from '../main/sessions/lifecycle';
import { object } from '../main/services/service-types';
import { Harness, assert, assertEqual, assertDeepEqual, assertRejects } from './harness';

const h = new Harness(), roots: string[] = [];
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/media-input-vectors.json'), 'utf8'));
const root = (): string => { const path = mkdtempSync(join(tmpdir(), 'klaus-media-input-')); roots.push(path); return path; };
const native = (mimeType = 'audio/wav', base64 = 'UklGRg==') => ({ type: 'media', mimeType, base64, filename: 'voice.wav' });

h.test('native audio and video preserve exact MIME and bytes while unsupported candidates remain references', async () => {
  const folder = root();
  const candidates = vector.fixtures.map((row: { name: string; mimeType: string; base64: string }) => {
    const path = join(folder, row.name); writeFileSync(path, Buffer.from(row.base64, 'base64'));
    assertEqual(mediaInputMime(row.name, row.mimeType), row.mimeType, 'native descriptor preserves parameters');
    return { type: 'media', path, name: row.name, mimeType: row.mimeType };
  });
  const text = 'Attached:\n' + candidates.map((row: { path: string }) => '- ' + row.path).join('\n');
  assertDeepEqual(await buildMessageInput(text, candidates, vector.allowed), [{ type: 'text', text },
    ...vector.fixtures.map((row: { name: string; mimeType: string; base64: string }) => ({ type: 'media', filename: row.name, mimeType: row.mimeType, base64: row.base64 }))], 'exact typed facade input');
  assertEqual(await buildMessageInput(text, candidates, []), text, 'unsupported model receives original references without unread native parts');
  assertEqual(await buildMessageInput(text, [candidates[1]], ['audio/webm']), text, 'MIME parameters are not silently erased');
  assertEqual(mediaInputMime('voice.mp3'), 'audio/mpeg', 'native descriptor infers audio');
  assertEqual(mediaInputMime('clip.mp4'), 'video/mp4', 'native descriptor infers video');
});

h.test('native media reads and typed queued input enforce bounded bytes and parts', async () => {
  const folder = root(), path = join(folder, 'empty.wav'); writeFileSync(path, '');
  await assertRejects(() => buildMessageInput('', [{ type: 'media', path, mimeType: 'audio/wav' }], ['audio/wav']), 'empty media fails before submission');
  writeFileSync(path, Buffer.alloc(vector.limits.fileBytes + 1));
  await assertRejects(() => buildMessageInput('', [{ type: 'media', path, mimeType: 'audio/wav' }], ['audio/wav']), 'media file ceiling');
  validateInput([native('audio/wav', Buffer.alloc(vector.limits.fileBytes).toString('base64'))], 'antigravity');
  for (const row of vector.fixtures) validateInput([{ type: 'media', mimeType: row.mimeType, base64: row.base64, filename: row.name }], 'antigravity');
  for (const invalid of [[native('audio/*')], [native('application/pdf')], [native('audio/wav', 'bad')], [native('audio/wav', 'aG==')], [{ ...native(), path: '/tmp/hidden' }],
    Array.from({ length: vector.limits.parts + 1 }, () => native()), Array.from({ length: 3 }, () => native('audio/wav', Buffer.alloc(16 * 1024 * 1024).toString('base64')))]) {
    let rejected = false; try { validateInput(invalid, 'antigravity'); } catch { rejected = true; }
    assert(rejected, 'malformed or over-budget typed input is refused');
  }
  const queued = [native()]; const saved = JSON.stringify(queued); validateInput(queued, 'antigravity');
  assertEqual(JSON.stringify(queued), saved, 'queue validation retains media semantics without converting to text or images');
});

h.test('model capability lookup follows independent main and side session selections and rejects a delayed switch', async () => {
  const folder = root();
  setSessionModel('main', 'antigravity:audio', 'antigravity', folder, { updateDefaults: false });
  setSessionModel('side', 'kimi:text', 'kimi', folder, { updateDefaults: false });
  const requests: string[] = [];
  let delayed: (() => Promise<void>) | undefined;
  const composer = new ComposerService({ configRoot: folder, push() {}, onSessionConfigChanged() {}, request: async (method, params) => {
    const fields = object(params);
    requests.push(method + ':' + String(fields.source ?? ''));
    if (method === 'model/selection/resolve') return { source: fields.source ?? null, selection: fields.selection ?? null };
    if (method === 'antigravity/models') { await delayed?.(); return { models: [{ key: 'audio', capabilities: { mediaInputMimeTypes: vector.allowed } }] }; }
    if (method === 'kimi/models') return { models: [{ key: 'text' }] };
    return {};
  } });
  assertDeepEqual(await composer.mediaInputMimeTypes('side'), [], 'side model cannot inherit main media support');
  assertDeepEqual(await composer.mediaInputMimeTypes('main'), vector.allowed, 'main resolves its exact selected row');
  assert(!requests.includes('kimi/models:') && requests.includes('antigravity/models:'), 'ordinary sources do not query native media capabilities');
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  delayed = () => pending;
  const loading = composer.mediaInputMimeTypes('main');
  await new Promise(resolve => setImmediate(resolve));
  setSessionModel('main', 'kimi:text', 'kimi', folder, { updateDefaults: false }); release();
  await assertRejects(() => loading, 'late capability result cannot route a newer selected model');
});

h.test('host media routing fences session ownership and model revisions around asynchronous reads', async () => {
  const folder = root(); setSessionModel('side', 'antigravity:audio', 'antigravity', folder, { updateDefaults: false });
  const state = new HostState(); state.rememberSession('side', 'engine-side', {});
  let release!: (value: string[]) => void;
  const pending = new Promise<string[]>(resolve => { release = resolve; });
  let reads = 0;
  const service = Object.create(SessionService.prototype) as SessionService;
  Object.assign(service, { deleted: new Set(), assertPublicThread() {}, deps: { state, configRoot: folder,
    mediaInputMimeTypes: async (sessionId: string) => { assertEqual(sessionId, 'side', 'owning session is used'); return pending; },
    messageInput: async () => { reads++; return [native()]; },
  } });
  const prepare = (service as unknown as { materializeMessageInput(id: string, text: string, media: Json[]): Promise<Json> }).materializeMessageInput.bind(service);
  const first = prepare('side', '', [{ type: 'media', path: '/uploads/voice.wav', mimeType: 'audio/wav' }]);
  state.markModelChanged('side'); release(['audio/wav']);
  await assertRejects(() => first, 'a switched model refuses a stale route');
  assertEqual(reads, 0, 'no bytes read after invalidation');
  const second = prepare('side', '', [{ type: 'media', path: '/uploads/voice.wav', mimeType: 'audio/wav' }]);
  state.rememberSession('side', 'replacement-engine', {});
  await assertRejects(() => second, 'replaced session refuses stale routing');
});

h.test('cold replay pools exact codec aliases and opaque declared media without MIME loss', () => {
  for (const mimeType of ['audio/webm;codecs=opus', 'audio/x-wav', 'video/audio/s16le', 'video/videoframe/jpeg2000']) {
    const folder = root();
    const projected = object(projectSessionHistory({ history: [{ type: 'user', uuid: 'one', content: [native(mimeType)] }], historyTurnIds: {} }, 'session', folder));
    const block = object((object((projected.messages as Json[])[0]).contentBlocks as Json[])[0]);
    assertEqual(block.type, 'media', 'native media remains recoverable');
    assertEqual(block.mimeType, mimeType, 'exact declared MIME survives pooling');
    assertEqual(readFileSync(String(block.path)).toString('base64'), 'UklGRg==', 'bytes survive cold replay');
  }
});

h.test('history and edit preparation keep native media as visible file attachments without duplicates', () => {
  const folder = root(), media = native();
  const history = object(projectSessionHistory({ history: [{ type: 'user', uuid: 'one', content: [media] }], historyTurnIds: {} }, 'session', folder));
  const row = object((history.messages as Json[])[0]);
  const block = object((row.contentBlocks as Json[])[0]);
  assertEqual(block.type, 'media', 'typed replay kind');
  assertEqual(block.mimeType, 'audio/wav', 'typed MIME retained');
  assertEqual(readFileSync(String(block.path)).toString('base64'), media.base64, 'pooled bytes retained');
  const restored = editPrepareFromRow('one', row, {});
  assertEqual(object(restored.attachments[0]).mimeType, 'audio/wav', 'edit preserves the native MIME');
  const original = join(folder, 'voice.wav'); writeFileSync(original, Buffer.from(media.base64, 'base64'));
  const metadata = { displayText: '', attachments: [{ type: 'file', path: original, name: 'voice.wav', mimeType: 'audio/wav' }] };
  const projected = object(projectSessionHistory({ history: [{ type: 'user', uuid: 'one', content: [media] },
    { type: 'system', subtype: 'user_display', text: JSON.stringify({ messageUuid: 'one', localRender: metadata }) }], historyTurnIds: {} }, 'session', folder));
  const recorded = object((projected.messages as Json[])[0]);
  assertEqual((recorded.contentBlocks as Json[]).length, 0, 'recorded file card suppresses a duplicate pooled card');
  assertDeepEqual(editPrepareFromRow('one', recorded, metadata).attachments, [{ path: original, name: 'voice.wav', mimeType: 'audio/wav' }], 'edit restores one original identity');
});

h.test('missing original media replays and edits through its pooled copy with one attachment identity', () => {
  const folder = root(), original = join(folder, 'missing.webm'), mimeType = 'audio/webm;codecs=opus';
  const media = { ...native(mimeType), filename: 'recording.webm' };
  const metadata = { displayText: 'Review', attachments: [{ type: 'file', path: original, name: media.filename, mimeType }] };
  const text = 'Review\n\nAttached:\n- ' + original;
  const projected = object(projectSessionHistory({ history: [{ type: 'user', uuid: 'one', content: [{ type: 'text', text }, media] },
    { type: 'system', subtype: 'user_display', text: JSON.stringify({ messageUuid: 'one', localRender: metadata }) }], historyTurnIds: {} }, 'session', folder));
  const row = object((projected.messages as Json[])[0]), restored = object((object(row.localRender).attachments as Json[])[0]);
  assert(stringPath(restored.path) !== original && existsSync(String(restored.path)), 'cold replay uses the existing pooled copy');
  assertEqual(restored[vector.replay.identityAlias], original, 'the missing original remains an identity alias');
  assertEqual(restored.mimeType, mimeType, 'codec parameters survive fallback');
  assertEqual((row.contentBlocks as Json[]).filter(value => object(value).type === 'media').length, 0, 'one visible file card');
  const prepared = editPrepareFromRow('one', row, metadata);
  assertEqual(prepared.attachments.length, 1, 'the raw Attached block cannot re-add the missing original alias');
  assertEqual(object(prepared.attachments[0]).path, restored.path, 'editing reads the pooled bytes');
  assertEqual(object(prepared.attachments[0]).mimeType, mimeType, 'editing retains the exact MIME');
  assertEqual(object((object(prepared.displayMetadata).attachments as Json[])[0]).path, restored.path, 'edit metadata uses the reconciled identity');
});

h.test('replay pairs same-name native media by exact MIME rather than hiding a distinct attachment', () => {
  const folder = root(), original = join(folder, 'voice.wav'); writeFileSync(original, 'source');
  const audio = native(), video = { ...native('video/mp4'), filename: 'voice.wav' };
  const metadata = { displayText: '', attachments: [{ type: 'file', path: original, name: 'voice.wav', mimeType: 'audio/wav' }] };
  const projected = object(projectSessionHistory({ history: [{ type: 'user', uuid: 'one', content: [video, audio] },
    { type: 'system', subtype: 'user_display', text: JSON.stringify({ messageUuid: 'one', localRender: metadata }) }], historyTurnIds: {} }, 'session', folder));
  const blocks = object((projected.messages as Json[])[0]).contentBlocks as Json[];
  assertEqual(blocks.length, 1, 'only the exact recorded attachment is suppressed');
  assertEqual(object(blocks[0]).mimeType, 'video/mp4', 'different media sharing a display name remains visible');
});

h.test('phone queue editing deduplicates native candidate paths and keeps exact MIME on resubmission', async () => {
  const folder = root(); mkdirSync(join(folder, 'uploads'));
  const path = join(realpathSync(folder), 'uploads', 'recording.webm'), mimeType = 'audio/webm;codecs=opus'; writeFileSync(path, Buffer.from('UklGRg==', 'base64'));
  const item = { finalText: 'Review\n\nAttached:\n- ' + path, displayText: 'Review',
    media: [{ type: 'media', path, name: 'recording.webm', mimeType }],
    liveAttachments: [{ type: 'file', path, name: 'recording.webm', mimeType }] };
  const controls = new MobileFollowUpControls(folder);
  const draft = await controls.draft(async (channel) => {
    assertEqual(channel, 'chat:client-queue-snapshot', 'draft only reads its owning queue');
    return { ok: true, snapshot: { revision: 3, items: [{ id: 'native', item }] } };
  }, 'session', 'native');
  const attachments = draft.media as Json[];
  assertEqual(attachments.length, 1, 'candidate and reference share one phone draft attachment');
  assertEqual(object(attachments[0]).mimeType, mimeType, 'phone draft preserves codec parameters');
  const incoming = mediaItems(attachments, 'antigravity');
  assertEqual(incoming[0]?.mimeType, mimeType, 'phone upload parser retains exact native MIME');
  const descriptors = await uploadFollowUpMedia(async (channel, payload) => {
    assertEqual(channel, 'chat:upload', 'resubmission uses the existing upload cache');
    assertEqual(object(payload).type, mimeType, 'resubmission forwards exact MIME');
    return { path: path + '.resaved', name: 'recording.webm', type: mimeType };
  }, incoming);
  const replacement = followUpPayload('Review', descriptors, 'antigravity'), candidate = object((replacement.media as Json[])[0]);
  assertEqual(candidate.type, vector.mobile.nativeCandidateType, 'phone resubmission retains native routing eligibility');
  assertEqual(candidate.mimeType, mimeType, 'host routing receives the exact MIME');
  assertEqual(object((replacement.liveAttachments as Json[])[0]).type, 'file', 'the visible card remains a file');
  assertEqual(object((object(replacement.displayMetadata).attachments as Json[])[0]).mimeType, mimeType, 'cold replay receives native MIME metadata');
  const secondPath = join(realpathSync(folder), 'uploads', 'second.webm'); writeFileSync(secondPath, 'second');
  const second = { type: 'media', path: secondPath, name: 'recording.webm', mimeType };
  const twoFiles = { ...item, finalText: item.finalText + '\n- ' + secondPath,
    media: [...item.media, second], liveAttachments: [...item.liveAttachments, { ...second, type: 'file' }] };
  const distinct = await controls.draft(async () => ({ ok: true, snapshot: { revision: 4, items: [{ id: 'native', item: twoFiles }] } }), 'session', 'native');
  assertEqual((distinct.media as Json[]).length, 2, 'same-name files with distinct paths remain separate');
});

h.test('phone native MIME parsing preserves codecs and explicit opaque media formats', () => {
  for (const mimeType of ['audio/webm;codecs=opus', 'video/audio/s16le', 'video/videoframe/jpeg2000']) {
    const media = mediaItems([{ type: 'file', mimeType, filename: 'media.bin', data: 'UklGRg==' }], 'antigravity');
    assertEqual(media[0]?.mimeType, mimeType, 'declared exact native MIME');
  }
  assertEqual(mediaItems([{ type: 'file', filename: 'recording.webm', data: 'data:audio/webm;codecs=opus;base64,UklGRg==' }], 'antigravity')[0]?.mimeType,
    'audio/webm;codecs=opus', 'codec data URL is parsed without discarding parameters');
});

function stringPath(value: Json | undefined): string { return typeof value === 'string' ? value : ''; }

void (async () => { const failed = await h.finish(join(__dirname, 'media-inputs-result.json'), 'media-inputs');
  for (const path of roots) rmSync(path, { recursive: true, force: true }); process.exitCode = failed; })();
