import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientEvent } from '../main/engine/protocol';
import type { Json } from '../main/ipc/contract';
import { mapChatEvents, projectEngineEvent } from '../main/ipc/project';
import { HostState } from '../main/services/host-state';
import { splitDynamicToolMedia } from '../main/services/tool-media';
import { MediaFiles } from '../main/services/media-files';
import { savedImageMarkdown } from '../main/services/media';
import { captureResultText, saveScreenshot } from '../main/browser/page-capture';
import { ChatEventForwarder, SessionEventPump } from '../main/sessions/events';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';

const h = new Harness(), roots: string[] = [];
process.env.KLAUS_TEST = '1';
const png = Buffer.from(PNG_FIXTURE_BASE64, 'base64');
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/tool-media-vectors.json'), 'utf8')) as {
  poolFileName: string;
  cases: Array<{ name: string; result: Json; expected: Json }>;
  terminalCases: Array<{ name: string; status: string; error?: Json; expected: Record<string, Json> }>;
};

function substitute(value: Json, replacements: Record<string, string>): Json {
  if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (match, key: string) => replacements[key] ?? match);
  if (Array.isArray(value)) return value.map(item => substitute(item, replacements));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, replacements)]));
  return value;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-tool-media-'));
  roots.push(root);
  const configRoot = join(root, 'profile'), workspace = join(root, 'workspace');
  const savedA = join(workspace, 'first.png'), savedB = join(workspace, 'second.PNG');
  await mkdir(workspace);
  await writeFile(savedA, png); await writeFile(savedB, png);
  const replacements = { savedA, savedB, missing: join(workspace, 'missing.png'), directory: workspace,
    poolFile: join(configRoot, 'media', vector.poolFileName), imageUrl: `data:image/png;base64,${PNG_FIXTURE_BASE64}` };
  return { root, configRoot, replacements, materialize: (value: Json) => substitute(value, replacements) };
}

function toolItem(result: Json, status = 'completed', error?: Json): Record<string, Json> {
  return { type: 'tool_call', id: 'capture', toolName: 'screenshot', status, result, ...(error === undefined ? {} : { error }) };
}

function completed(item: Record<string, Json>, method = 'item/completed', sessionId = 'engine-session'): ClientEvent {
  return { type: 'productEvent', method, params: { sessionId, item } };
}

function imageResult(imageUrl: string): Json {
  return { contentItems: [{ type: 'inputText', text: 'Screenshot ready' }, { type: 'inputImage', imageUrl }], success: true };
}

function pumpFixture(configRoot?: string) {
  const state = new HostState();
  state.rememberSession('conversation', 'engine-session', {});
  const delivered: Json[] = [];
  const emit = (_channel: string, payload: Json): void => { if (Array.isArray(payload)) delivered.push(...payload); };
  const forwarder = new ChatEventForwarder(emit);
  const pump = new SessionEventPump({ state, forwarder, emit, configRoot, currentGeneration: () => 1, log: () => {} });
  return { state, delivered, forwarder, pump };
}

for (const row of vector.cases) {
  h.test(row.name, async () => {
    const f = await fixture(), expected = f.materialize(row.expected);
    assertDeepEqual(splitDynamicToolMedia(f.materialize(row.result), f.configRoot) ?? null, expected, 'committed media contract');
    const media = expected !== null && typeof expected === 'object' && !Array.isArray(expected) ? expected.media : undefined;
    const pooled = Array.isArray(media) && media.some(item => item !== null && typeof item === 'object' && !Array.isArray(item) && item.path === f.replacements.poolFile);
    assertEqual(existsSync(f.replacements.poolFile), pooled, 'only a visible pooled image writes bytes');
    if (pooled) {
      assertDeepEqual(await readdir(join(f.configRoot, 'media')), [vector.poolFileName], 'atomic storage leaves no temporary file');
      assert((await readFile(f.replacements.poolFile)).equals(png), 'pooled bytes preserve the image');
    } else assertEqual(existsSync(f.configRoot), false, 'text and rejected media do not create a profile');
    assert((await readFile(f.replacements.savedA)).equals(png), 'first saved source is unchanged');
    assert((await readFile(f.replacements.savedB)).equals(png), 'second saved source is unchanged');
  });
}

for (const row of vector.terminalCases) {
  for (const method of ['item/updated', 'item/completed']) {
    h.test(`${method}: ${row.name}`, async () => {
      const f = await fixture(), p = pumpFixture(f.configRoot);
      p.pump.receive(completed(toolItem(imageResult(f.replacements.imageUrl), row.status, row.error), method), 1);
      p.forwarder.close();
      assertDeepEqual(p.delivered, [f.materialize(row.expected)], 'terminal event keeps its tool identity, status and separate media');
      assertEqual(existsSync(f.replacements.poolFile), row.error === undefined, 'an explicit error prevents media writes');
    });
  }
}

h.test('child tool media uses the parent profile and stays inside its child stream', async () => {
  const f = await fixture(), p = pumpFixture(f.configRoot);
  p.pump.receive({ type: 'rawSessionEvent', params: { sessionId: 'engine-session', event: { subagentEvent: {
    agentId: 'child-agent', event: { type: 'item.completed', item: toolItem(imageResult(f.replacements.imageUrl)) },
  } } } }, 1);
  p.forwarder.close();
  const nested = { ...vector.terminalCases[0]!.expected };
  delete nested.sessionId;
  assertDeepEqual(p.delivered, [{ type: 'agent_progress', sessionId: 'conversation', agentId: 'child-agent', event: f.materialize(nested) }], 'image is attributed to the child without creating a parent tool card');
  assert((await readFile(f.replacements.poolFile)).equals(png), 'child image bytes use the explicit parent host profile');
});

h.test('duplicate terminal deliveries share one immutable pooled image', async () => {
  const f = await fixture(), result = imageResult(f.replacements.imageUrl);
  const first = splitDynamicToolMedia(result, f.configRoot);
  assertDeepEqual(splitDynamicToolMedia(result, f.configRoot), first, 'repeat projection keeps the same path');
  assertDeepEqual(await readdir(join(f.configRoot, 'media')), [vector.poolFileName], 'identical bytes produce one file');
  assert((await readFile(f.replacements.poolFile)).equals(png), 'repeat storage preserves complete image bytes');
});

h.test('live tool images survive a later move and replacement of the generated file', async () => {
  const f = await fixture(), p = pumpFixture(f.configRoot);
  const result: Json = { contentItems: [
    { type: 'inputImage', imageUrl: f.replacements.imageUrl },
    { type: 'inputText', text: `Saved: ${f.replacements.savedA}` },
  ] };
  p.pump.receive(completed(toolItem(result)), 1); p.forwarder.close();
  const media = (p.delivered[0] as Record<string, Json>).media as Array<Record<string, Json>>;
  assertDeepEqual(media, [{ path: f.replacements.poolFile, sourcePath: f.replacements.savedA, mimeType: 'image/png' }], 'live delivery owns a stable copy and the original reference');
  await rename(f.replacements.savedA, join(f.root, 'moved.png'));
  assert((await readFile(String(media[0]!.path))).equals(png), 'moving the generated file cannot break the live image');
  const files = new MediaFiles(async (_path, sessionId) => sessionId === 'conversation');
  try {
    const url = await files.grant(String(media[0]!.path), 'conversation');
    const response = await files.respond(new Request(url));
    assertEqual(response.status, 200, 'the renderer media route still serves the image after the source move');
    assert(Buffer.from(await response.arrayBuffer()).equals(png), 'the route delivers the original image bytes');
  } finally { files.close(); }
  assertDeepEqual(splitDynamicToolMedia(result, f.configRoot)!.media, media, 'reopening after a move preserves image identity and aliases');
  await writeFile(f.replacements.savedA, Buffer.concat([png, Buffer.from('replacement')]));
  assertDeepEqual(splitDynamicToolMedia(result, f.configRoot)!.media, media, 'reusing the original filename does not change the returned image');
  assert((await readFile(String(media[0]!.path))).equals(png), 'the transcript retains the original bytes after replacement');
});

h.test('stateless projectors and pumps without a profile remain pure', async () => {
  const f = await fixture(), result = imageResult(f.replacements.imageUrl), event = completed(toolItem(result));
  const expected = [{ type: 'tool_end', sessionId: 'engine-session', toolName: 'screenshot', toolCallId: 'capture', isError: false, content: JSON.stringify(result) }];
  assertDeepEqual(mapChatEvents(event), expected, 'the base projector has no implicit profile');
  assertDeepEqual(projectEngineEvent(event), expected, 'full projection without a media callback also stays pure');
  const p = pumpFixture();
  p.pump.receive(event, 1); p.forwarder.close();
  assertDeepEqual(p.delivered, expected.map(row => ({ ...row, sessionId: 'conversation' })), 'a profile must be explicitly wired by the host');
  assertEqual(existsSync(f.configRoot), false, 'stateless projection creates no fixture profile');
});

h.test('old generations and unbound sessions cannot materialize images', async () => {
  const f = await fixture(), p = pumpFixture(f.configRoot), item = toolItem(imageResult(f.replacements.imageUrl));
  p.pump.receive(completed(item), 0);
  p.forwarder.flush();
  assertDeepEqual(p.delivered, [], 'old generation is dropped before projection');
  assertEqual(existsSync(f.configRoot), false, 'old generation cannot create a media pool');
  p.pump.receive(completed(item, 'item/completed', 'retired-engine-session'), 1);
  p.forwarder.close();
  assertEqual(existsSync(f.configRoot), false, 'an unknown session cannot write into the active profile');
  assertDeepEqual(p.delivered, mapChatEvents(completed(item, 'item/completed', 'retired-engine-session')), 'unbound events preserve the base projection contract');
});

h.test('separate host profiles never share media paths', async () => {
  const a = await fixture(), b = await fixture(), pa = pumpFixture(a.configRoot), pb = pumpFixture(b.configRoot);
  const event = completed(toolItem(imageResult(a.replacements.imageUrl)));
  pa.pump.receive(event, 1); pb.pump.receive(event, 1);
  pa.forwarder.close(); pb.forwarder.close();
  assertDeepEqual(pa.delivered, [a.materialize(vector.terminalCases[0]!.expected)], 'first host uses its own profile');
  assertDeepEqual(pb.delivered, [b.materialize(vector.terminalCases[0]!.expected)], 'second host uses its own profile');
  assert((await readFile(a.replacements.poolFile)).equals(png) && (await readFile(b.replacements.poolFile)).equals(png), 'each explicitly configured profile owns its bytes');
});


h.test('declared MCP and Code Mode image codecs preserve saved paths with commas and multiline context', async () => {
  const f = await fixture(), path = join(f.root, '截图, final result.png');
  await writeFile(path, png);
  const text = 'Saved: ' + JSON.stringify(path) + '\nhttps://fixture.invalid/page\n<app_state>approved</app_state>';
  const results: Json[] = [
    { content: [{ type: 'text', text }, { type: 'image', data: PNG_FIXTURE_BASE64, mimeType: 'image/png' }], structuredContent: { path, saved: true } },
    { type: 'result', contentItems: [{ type: 'input_text', text }, { type: 'input_image', image_url: f.replacements.imageUrl }] },
    { contentItems: [{ type: 'input_text', text }, { type: 'input_image', imageUrl: f.replacements.imageUrl }] },
  ];
  for (const result of results) {
    const split = splitDynamicToolMedia(result, f.configRoot)!;
    assertEqual(split.content, text, 'text context survives projection');
    assertDeepEqual(split.media, [{ path: f.replacements.poolFile, sourcePath: path, mimeType: 'image/png' }], 'the returned bytes retain their exact saved reference');
  }
});
h.test('strict image path slots do not shift a later capture into a missing first capture', async () => {
  const f = await fixture(), gone = join(f.root, 'removed.png');
  const result: Json = { contentItems: [{ type: 'inputText', text: 'Saved: ' + JSON.stringify([gone, f.replacements.savedB]) },
    { type: 'inputImage', imageUrl: f.replacements.imageUrl }, { type: 'inputImage', imageUrl: f.replacements.imageUrl }] };
  const split = splitDynamicToolMedia(result, f.configRoot)!;
  assertDeepEqual(split.media.map(item => item.path), [f.replacements.poolFile, f.replacements.poolFile], 'identical images share one pooled copy');
  assertDeepEqual(split.media.map(item => item.sourcePath), [gone, f.replacements.savedB], 'each image consumes its own source slot');
});
h.test('builtin browser result retains capture context without leaking image bytes into text', async () => {
  const f = await fixture();
  const split = splitDynamicToolMedia({ ok: true, operation: 'browser_screenshot', response: {
    url: 'https://fixture.invalid/page', title: 'Fixture UI', text: 'visible details', message: 'capture completed',
    value: { path: f.replacements.savedA, saved: true, dataUrl: f.replacements.imageUrl, mimeType: 'image/png' }, artifacts: [],
  } }, f.configRoot)!;
  for (const fragment of ['Fixture UI', 'visible details', 'capture completed', 'https://fixture.invalid/page']) assert(split.content.includes(fragment), fragment);
  assert(!split.content.includes(PNG_FIXTURE_BASE64), 'the text channel does not carry image base64');
  assertDeepEqual(split.media, [{ path: f.replacements.poolFile, sourcePath: f.replacements.savedA, mimeType: 'image/png' }], 'capture bytes remain available independently of the saved file');
  const pathOnly = splitDynamicToolMedia({ ok: true, operation: 'browser_screenshot', response: {
    value: { path: f.replacements.savedA, saved: true }, artifacts: [{ kind: 'screenshot', path: f.replacements.savedA }],
  } }, f.configRoot)!;
  assertDeepEqual(pathOnly.media, [{ path: f.replacements.savedA, mimeType: 'image/png' }], 'captures without inline bytes retain their saved file');
});

h.test('a deleted exact Saved path retains its image provenance when bytes recover into the pool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-image-alias-'));
  try {
    const sourcePath = join(root, 'browser-shot-real.jpg');
    const result = splitDynamicToolMedia({ contentItems: [
      { type: 'inputText', text: 'Saved: ' + JSON.stringify(sourcePath) },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,' + PNG_FIXTURE_BASE64 },
    ] }, root)!;
    assertEqual(result.media[0]!.sourcePath, sourcePath, 'exact original reference survives');
    assert(readFileSync(String(result.media[0]!.path)).equals(Buffer.from(PNG_FIXTURE_BASE64, 'base64')), 'the fallback is the declared original image bytes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('saved captures publish the exact ready-to-embed reference with escaped filename characters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-verified embed-'));
  try {
    const result = saveScreenshot({ data: PNG_FIXTURE_BASE64, mimeType: 'image/png' }, root);
    assertEqual(result.markdown, savedImageMarkdown(String(result.path)), 'producer returns complete matching embed');
    assert(readFileSync(String(result.path)).equals(png), 'the embed names the actual written capture');
    const text = captureResultText(result, 'https://fixture.invalid');
    assert(text.includes('Embed: ' + result.markdown), 'the model-visible browser text contains that exact embed');
    assert(!text.includes(PNG_FIXTURE_BASE64), 'the embed does not leak image bytes into prose');
    assertEqual(captureResultText({ ...result, saved: false }, 'unsaved'), 'unsaved', 'process captures never advertise a saved embed');
    assert(savedImageMarkdown(join(root, 'literal%20 #?.png')).includes('literal%2520%20%23%3F.png'), 'file URL retains literal percent, spaces and reserved filename characters');
  } finally { await rm(root, { recursive: true, force: true }); }
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'tool-media-result.json'), 'tool-media');
  for (const root of roots) await rm(root, { recursive: true, force: true });
  process.exit(failed);
})();
