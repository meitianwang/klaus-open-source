import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';
import type { Json } from '../main/ipc/contract';
import type { EngineClientLike } from '../main/sessions/service';
import { readStoredHistory } from '../main/sessions/stored-history';
import { projectSessionHistory } from '../main/sessions/history';
import { Harness, assertDeepEqual, assertEqual, assertRejects } from './harness';

type Row = Record<string, Json>;
const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/stored-history-vectors.json'), 'utf8')) as {
  reply: Row; expectedMessageUuids: string[]; expectedAssistantBlockTypes: string[];
  resultPairing: Array<{ name: string; messages: Json[]; turnIds: Row; expected: string[] }>;
};
class Client extends EventEmitter implements EngineClientLike {
  calls: Array<{ method: string; params: Json }> = [];
  reply: unknown = structuredClone(vector.reply);
  isClosed(): boolean { return false; }
  async requestWithTimeout(method: string, params: Json): Promise<unknown> { this.calls.push({ method, params }); return this.reply; }
}

h.test('complete stored transcript retains original grouping, signatures, tool identity and durable turn state', async () => {
  const client = new Client();
  const raw = await readStoredHistory(client, 'saved-thread', () => {});
  assertDeepEqual(raw, vector.reply, 'complete wire envelope is retained');
  const projected = projectSessionHistory(raw, 'renderer') as Row;
  const messages = projected.messages as Row[], assistant = messages[1]!, blocks = assistant.contentBlocks as Row[];
  assertDeepEqual(messages.map(message => message.uuid), vector.expectedMessageUuids, 'original assistant row is never split');
  assertDeepEqual(blocks.map(block => block.type), vector.expectedAssistantBlockTypes, 'thinking, text and tools remain together');
  assertEqual(blocks[0]!.signature, 'original-signature', 'stored thinking signature');
  assertEqual(blocks[2]!.name, 'Bash', 'original command alias');
  assertEqual(((blocks[2]!.__result as Row).content as Row[])[0]!.text, 'saved output', 'tool result remains expandable');
  assertEqual(assistant.isFinalReply, true, 'original final identity');
  for (const field of ['turnFinalMessageIds', 'turnStatuses', 'turnStartedAtMs', 'turnFinishedAtMs', 'turnDurations', 'turnCancelledTools', 'turnErrors', 'turnErrorKinds', 'agentNotifications']) {
    assertDeepEqual(projected[field], vector.reply[field], field);
  }
  assertDeepEqual(client.calls, [{ method: 'engine/readThreadHistory', params: { threadId: 'saved-thread', limit: 100, itemsView: 'full' } }], 'one provider-free named facade');
});

h.test('a paged history assembles oldest-first and stops on an unchanged cursor', async () => {
  const newest = structuredClone(vector.reply) as Row;
  const older = structuredClone(vector.reply) as Row;
  newest.history = (newest.history as Row[]).slice(-1);
  older.history = (older.history as Row[]).slice(0, 2);
  const pages = [
    { ...newest, page: { order: 'newest_first', limit: 100, nextCursor: 'older-page', hasMore: true } },
    { ...older, page: { order: 'newest_first', limit: 100, nextCursor: null, hasMore: false } },
  ];
  const client = new Client();
  let served = 0;
  client.requestWithTimeout = async (method: string, params: Json) => { client.calls.push({ method, params }); return pages[served++] ?? pages[1]; };
  const raw = await readStoredHistory(client, 'saved-thread', () => {}) as Row;
  assertEqual(served, 2, 'both pages were read');
  assertDeepEqual((raw.history as Row[]).map(row => row.uuid), [...(older.history as Row[]).map(row => row.uuid), ...(newest.history as Row[]).map(row => row.uuid)], 'pages assemble oldest-first');
  assertEqual((client.calls[1]!.params as Row).cursor, 'older-page', 'the second page continues at the cursor');
  const stuck = new Client();
  let stuckServed = 0;
  const stuckPage = { ...newest, page: { order: 'newest_first', limit: 100, nextCursor: 'same', hasMore: true } };
  stuck.requestWithTimeout = async (method: string, params: Json) => { stuck.calls.push({ method, params }); stuckServed += 1; return stuckPage; };
  await assertRejects(() => readStoredHistory(stuck, 'saved-thread', () => {}), 'an unchanged cursor is refused instead of looping');
  assertEqual(stuckServed, 2, 'the refusal stops after the repeated cursor');
});

h.test('paged saved goal turn provenance retains every captured generation without loading a provider', async () => {
  const automatic = { goalContinuation: true, inputOrigin: 'automatic', goalId: 'generation' };
  const human = { goalContinuation: false, inputOrigin: 'user' };
  const pages = [
    { ...structuredClone(vector.reply), turnGoalMetadata: { recent: automatic }, page: { hasMore: true, nextCursor: 'older' } },
    { ...structuredClone(vector.reply), turnGoalMetadata: { first: human }, page: { hasMore: false } },
  ];
  const client = new Client(); let index = 0;
  client.requestWithTimeout = async (method, params) => { client.calls.push({ method, params }); return pages[index++]; };
  const raw = await readStoredHistory(client, 'saved-thread', () => {});
  assertDeepEqual(raw.turnGoalMetadata, { recent: automatic, first: human }, 'each page contributes captured turn metadata');
  const projected = projectSessionHistory(raw, 'saved-thread') as Row;
  assertDeepEqual(projected.turnGoalMetadata, raw.turnGoalMetadata, 'history hydration preserves the complete authoritative table');
  assertEqual(client.calls.every(call => call.method === 'engine/readThreadHistory'), true, 'saved provenance never starts inference');
});

h.test('saved child reads preserve both identities without invoking the parent provider', async () => {
  const client = new Client(); client.reply = { ...vector.reply, agentId: 'child', meta: null, surfacedTools: ['Bash'] };
  const reply = await readStoredHistory(client, 'saved-thread', () => {}, 'child');
  assertEqual(reply.agentId, 'child', 'child ownership returned');
  assertDeepEqual(client.calls, [{ method: 'engine/readSubagentHistory', params: { threadId: 'saved-thread', agentId: 'child' } }], 'no session/start or provider lookup');
});

h.test('reused tool identities cannot attach a later result to an older card', () => {
  for (const entry of vector.resultPairing) {
    const projected = projectSessionHistory({ history: entry.messages, historyTurnIds: entry.turnIds }, 'renderer') as Row;
    const actual = (projected.messages as Row[]).filter(message => message.role === 'assistant').map(message => {
      const block = (message.contentBlocks as Row[])[0]!;
      return (((block.__result as Row).content as Row[])[0]!).text;
    });
    assertDeepEqual(actual, entry.expected, entry.name);
  }
});

h.test('wrong identities and incomplete snapshots reject instead of rendering empty history', async () => {
  for (const reply of [null, {}, { error: 'missing transcript' }, { ...vector.reply, threadId: 'other' },
    { ...vector.reply, history: null }, { ...vector.reply, history: [null] },
    { ...vector.reply, turnCancelledTools: null }, { ...vector.reply, agentNotifications: null }]) {
    const client = new Client(); client.reply = reply;
    await assertRejects(() => readStoredHistory(client, 'saved-thread', () => {}), 'invalid history rejected');
  }
  const client = new Client(); client.reply = { ...vector.reply, agentId: 'other' };
  await assertRejects(() => readStoredHistory(client, 'saved-thread', () => {}, 'child'), 'wrong child rejected');
});

h.test('stored canonical failures retain all source fields and accept unknown diagnostics without mutating cached maps', async () => {
  const diagnostics = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/provider-error-details-vectors.json'), 'utf8')) as { historyCases: Array<{ name: string; input: Row; expectedText: string; expectedKind: string }> };
  for (const row of diagnostics.historyCases) {
    const client = new Client();
    const original: Row = { ...vector.reply, ...row.input, futureHistoryField: { version: 2 } };
    Object.freeze(original.turnErrors);
    Object.freeze(original.turnErrorKinds);
    Object.freeze(original.turnErrorDetails);
    client.reply = Object.freeze(original);
    const before = JSON.stringify(original);
    const raw = await readStoredHistory(client, 'saved-thread', () => {});
    const projected = projectSessionHistory(raw, 'renderer') as Row;
    assertDeepEqual(projected.turnErrorDetails, original.turnErrorDetails, row.name + ': complete nested source retained');
    assertEqual((projected.turnErrors as Row)['turn-payload'], row.expectedText, row.name + ': identity');
    assertEqual((projected.turnErrorKinds as Row)['turn-payload'], row.expectedKind, row.name + ': failure classification');
    assertEqual(JSON.stringify(original), before, row.name + ': frozen cached maps remain untouched');
    assertDeepEqual(raw.futureHistoryField, original.futureHistoryField, row.name + ': unrelated unknown fields remain compatible');
  }
  const invalid = new Client(); invalid.reply = { ...vector.reply, turnErrorDetails: [] };
  await assertRejects(() => readStoredHistory(invalid, 'saved-thread', () => {}), 'malformed optional error map is rejected');
});

h.test('a retired owner cannot publish a completed saved read', async () => {
  const client = new Client();
  await assertRejects(() => readStoredHistory(client, 'saved-thread', () => { throw new Error('retired engine'); }), 'generation and deletion guard is checked after the read');
});

h.test('large original messages remain readable without a new total-history cutoff', async () => {
  const client = new Client(), text = 'x'.repeat(64 * 1024 * 1024 + 1);
  client.reply = { ...vector.reply, history: [{ type: 'user', uuid: 'large', content: [{ type: 'text', text }] }] };
  const reply = await readStoredHistory(client, 'saved-thread', () => {});
  assertEqual((((reply.history as Row[])[0]!.content as Row[])[0]!.text as string).length, text.length, 'entire message remains present');
});

h.test('stored screenshot bytes preserve an exact deleted source alias for the final reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-history-image-alias-'));
  try {
    const sourcePath = join(root, 'deleted capture.png');
    const raw: Json = { history: [
      { type: 'assistant', uuid: 'capture', content: [{ type: 'tool_use', id: 'image-call', name: 'browser_screenshot', input: {} }] },
      { type: 'tool_result', uuid: 'result', toolUseId: 'image-call', content: [
        { type: 'text', text: 'Saved: ' + JSON.stringify(sourcePath) },
        { type: 'image', mimeType: 'image/png', base64: PNG_FIXTURE_BASE64 },
      ] },
      { type: 'assistant', uuid: 'final', content: [{ type: 'text', text: `![verified](<${sourcePath}>)` }] },
    ] };
    const history = projectSessionHistory(raw, 'owner', root) as Row;
    const card = ((history.messages as Row[])[0]!.contentBlocks as Row[])[0]!;
    const image = (((card.__result as Row).content as Row[]).find(row => row.type === 'image'))!;
    assertEqual(image.sourcePath, sourcePath, 'original source identity survives replay');
    assertEqual(String(image.path).startsWith(join(root, 'media')), true, 'actual bytes recover into scoped media pool');
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('stored generated images retain the same bytes and source alias before and after a workspace move', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-history-image-stability-'));
  try {
    const sourcePath = join(root, 'generated.png'), bytes = Buffer.from(PNG_FIXTURE_BASE64, 'base64');
    const output: Json = { contentItems: [
      { type: 'inputImage', imageUrl: 'data:image/png;base64,' + PNG_FIXTURE_BASE64 },
      { type: 'inputText', text: `Saved: ${sourcePath}` },
    ] };
    for (const withOutput of [false, true]) {
      await writeFile(sourcePath, bytes);
      const raw: Json = { history: [
        { type: 'assistant', uuid: 'generate', content: [{ type: 'tool_use', id: 'image-call', name: 'generate_image', input: {} }] },
        { type: 'tool_result', uuid: 'result', toolUseId: 'image-call', content: [
          { type: 'image', mimeType: 'image/png', base64: PNG_FIXTURE_BASE64 },
          { type: 'text', text: `Saved: ${sourcePath}` },
        ], ...(withOutput ? { output } : {}) },
      ] };
      const projectImage = (): Row => {
        const history = projectSessionHistory(raw, 'owner', root) as Row;
        const card = ((history.messages as Row[])[0]!.contentBlocks as Row[])[0]!;
        return ((card.__result as Row).content as Row[]).find(row => row.type === 'image')!;
      };
      const initial = projectImage();
      assertEqual(initial.sourcePath, sourcePath, 'an existing generated file retains its reply reference');
      assertEqual(String(initial.path).startsWith(join(root, 'media')), true, 'replay snapshots bytes while the source still exists');
      await rename(sourcePath, join(root, `moved-${withOutput}.png`));
      assertDeepEqual(projectImage(), initial, 'a workspace move cannot change the replayed image path or alias');
      assertEqual(readFileSync(String(initial.path)).equals(bytes), true, 'the replayed image survives removal of its source path');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('summary display companions preserve directory and same-name image identity without adding rows', () => {
  const localRender = { displayText: 'inspect assets', attachments: [
    { type: 'directory', path: '/project/assets', name: 'assets' },
    { type: 'image', path: '/project/assets/assets.png', name: 'assets', mimeType: 'image/png' },
  ], composerDocument: { version: 1, content: [{ type: 'text', text: 'inspect assets' }] } };
  const projected = projectSessionHistory({
    history: [{ type: 'user', uuid: 'user-a', content: [{ type: 'text', text: 'native input' }] },
      { type: 'assistant', uuid: 'final-a', content: [{ type: 'text', text: 'done' }] }],
    presentationRecords: [{ type: 'system', uuid: 'display-a', subtype: 'user_display', text: JSON.stringify({ messageUuid: 'user-a', localRender }) }],
    historyTurnIds: { 'user-a': 'turn-a', 'final-a': 'turn-a' }, turnFinalMessageIds: { 'turn-a': 'final-a' },
  }, 'owner') as Row;
  const rows = projected.messages as Row[];
  assertDeepEqual(rows.map(row => row.uuid), ['user-a', 'final-a'], 'raw summary anchors alone produce visible rows');
  assertDeepEqual(rows[0]!.localRender, localRender, 'directory, image and document retain their exact distinct identities');
  assertEqual(rows[0]!.turnId, 'turn-a', 'the companion does not change turn ownership');
  assertEqual(rows[1]!.isFinalReply, true, 'the final summary anchor remains final');
});

h.test('single-item pages attach display companions without leaking another page or thread', () => {
  const user = { type: 'user', uuid: 'shared-id', content: [{ type: 'text', text: 'native input' }] };
  const display = { type: 'system', subtype: 'user_display', text: JSON.stringify({ messageUuid: 'shared-id', localRender: { displayText: 'first thread', attachments: [] } }) };
  const first = projectSessionHistory({ history: [user], presentationRecords: [display] }, 'first') as Row;
  assertEqual(((first.messages as Row[])[0]!.localRender as Row).displayText, 'first thread', 'a one-row page receives its separate display');
  const companionOnly = projectSessionHistory({ history: [display] }, 'first') as Row;
  assertDeepEqual(companionOnly.messages, [], 'the following envelope-only raw page does not invent a visible message');
  const other = projectSessionHistory({ history: [user], presentationRecords: [] }, 'second') as Row;
  assertEqual((other.messages as Row[])[0]!.localRender, undefined, 'the projection retains no cross-thread or cross-generation display cache');
});

h.test('display companions use the last valid envelope and cannot project arbitrary sidecar messages', () => {
  const display = (localRender: Json, messageUuid = 'user-a') => ({ type: 'system', subtype: 'user_display', text: JSON.stringify({ messageUuid, localRender }) });
  const projected = projectSessionHistory({
    history: [display({ displayText: 'older' }), { type: 'user', uuid: 'user-a', content: [{ type: 'text', text: 'native' }] }],
    presentationRecords: [display({ displayText: 'current', attachments: [] }), display(null), display([]),
      { type: 'system', subtype: 'user_display', text: '{invalid' },
      { type: 'assistant', uuid: 'unrelated', content: [{ type: 'text', text: 'hidden' }] }, display({ displayText: 'other' }, 'other-user')],
  }, 'owner') as Row;
  assertEqual((projected.messages as Row[]).length, 1, 'sidecar records never add transcript rows');
  assertEqual(((projected.messages as Row[])[0]!.localRender as Row).displayText, 'current', 'invalid later envelopes cannot erase the last valid render');
});

void h.finish(join(__dirname, 'stored-history-result.json'), 'stored-history').then(code => { process.exitCode = code; });
