import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { visualArtifact, legacyDiagramArtifact } from '../main/visuals/artifacts';
import { restoreLegacyDiagramCards } from '../main/digram/history';
import { DigramStore } from '../main/digram/store';
import { emptyDocument } from '../main/digram/model';
import { projectSessionHistory } from '../main/sessions/history';
import { mapChatEvents } from '../main/ipc/project';
import { object } from '../main/services/service-types';
import type { Json } from '../main/ipc/contract';
import { assertDeepEqual, assertEqual, Harness } from './harness';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-visual-artifacts-'));
const cases = JSON.parse(readFileSync(join(__dirname, '../../tests/vectors/visual-artifacts.json'), 'utf8')) as Array<{name:string;tool:string;result:Json;expected:Json}>;
const replay = (tool: string, result: Json, owner: string): Json => projectSessionHistory({ history: [
  { type: 'assistant', uuid: 'message', content: [{ type: 'tool_use', id: 'call', name: tool, input: {} }] },
  { type: 'tool_result', toolUseId: 'call', ...object(result) },
] }, owner, root);
const replayResult = (history: Json): Record<string, Json> => {
  const rows = object(history).messages;
  const blocks = object(Array.isArray(rows) ? rows[0] : undefined).contentBlocks;
  return object(object(Array.isArray(blocks) ? blocks[0] : undefined).__result);
};

for (const vector of cases) h.test(vector.name, () => assertDeepEqual(visualArtifact(vector.tool, vector.result) ?? null, vector.expected, 'committed artifact shape'));

h.test('a real product envelope and persisted tool result retain the same clickable artifact', () => {
  const artifact = { kind: 'diagram', id: 'architecture', title: 'Architecture' };
  const result = { content: [{ type: 'text', text: JSON.stringify({ artifact }) }] };
  const live = mapChatEvents({ type: 'productEvent', method: 'item/completed', params: {
    sessionId: 'owner', item: { type: 'tool_call', id: 'call', toolName: 'mcp__klaus-digram__digram_open', result },
  } });
  assertDeepEqual(live[0]?.artifact, artifact, 'live card');
  assertDeepEqual(replayResult(replay('mcp__klaus-digram__digram_open', result, 'owner')).artifact, artifact, 'history card');
});

// The regression this whole projection exists to prevent: a 3D tool published an
// artifact that no layer recognised, so the conversation never offered a way to
// open the panel the agent had just drawn into. Both the live event and the
// reloaded history have to carry the card.
h.test('a 3D scene result carries one clickable card through the live event and the reloaded history', () => {
  const artifact = { kind: 'model3d', id: 'm3d-bewd', title: 'Blue-Eyes' };
  const result = { content: [{ type: 'text', text: JSON.stringify({ artifact }) }] };
  const live = mapChatEvents({ type: 'productEvent', method: 'item/completed', params: {
    sessionId: 'owner', item: { type: 'tool_call', id: 'call', toolName: 'mcp__klaus-model3d__model3d_scene', result },
  } });
  assertDeepEqual(live[0]?.artifact, artifact, 'live card');
  assertDeepEqual(replayResult(replay('mcp__klaus-model3d__model3d_scene', result, 'owner')).artifact, artifact, 'history card');
});

h.test('an interface design result carries one clickable card through the live event and the reloaded history', () => {
  const artifact = { kind: 'prototype', id: 'design-1', title: 'Plants vs. Zombies' };
  const result = { content: [{ type: 'text', text: JSON.stringify({ artifact }) }] };
  const live = mapChatEvents({ type: 'productEvent', method: 'item/completed', params: {
    sessionId: 'owner', item: { type: 'tool_call', id: 'call', toolName: 'mcp__klaus-prototype__prototype_open', result },
  } });
  assertDeepEqual(live[0]?.artifact, artifact, 'live card');
  assertDeepEqual(replayResult(replay('mcp__klaus-prototype__prototype_open', result, 'owner')).artifact, artifact, 'history card');
});

h.test('a modelling verb that created the document implicitly still cards it', () => {
  const artifact = { kind: 'model3d', id: 'implicit', title: 'Untitled' };
  const result = { content: [
    { type: 'text', text: JSON.stringify({ artifact }) },
    { type: 'text', text: JSON.stringify({ name: 'Cube', type: 'MESH', objects: 1 }) },
  ] };
  const live = mapChatEvents({ type: 'productEvent', method: 'item/completed', params: {
    sessionId: 'owner', item: { type: 'tool_call', id: 'call', toolName: 'mcp__klaus-model3d__model3d_add', result },
  } });
  assertDeepEqual(live[0]?.artifact, artifact, 'the card rides a verb that is not model3d_scene');
});

h.test('a video result retains its work panel card in live and saved history', () => {
  const artifact = { kind: 'video-editing', id: 'video-1', title: 'Film' };
  const result = { content: [{ type: 'text', text: JSON.stringify({ artifact }) }] };
  const toolName = 'mcp__klaus-video-editing__video_editing_open';
  const live = mapChatEvents({ type: 'productEvent', method: 'item/completed', params: {
    sessionId: 'owner', item: { type: 'tool_call', id: 'call', toolName, result },
  } });
  assertDeepEqual(live[0]?.artifact, artifact, 'live video card');
  assertDeepEqual(replayResult(replay(toolName, result, 'owner')).artifact, artifact, 'saved video card');
});

h.test('legacy ownership is restored from a saved tool result and never reassigned to another task', () => {
  const store = new DigramStore(root), id = 'legacy';
  writeFileSync(store.path(id), JSON.stringify({ ...emptyDocument(id, 'Legacy', 'owner'), sessionId: undefined }));
  const result = { content: [{ type: 'text', text: JSON.stringify({ id, document: { title: 'Legacy' } }) }] };
  const owned = restoreLegacyDiagramCards(replay('digram_open', result, 'owner'), 'owner', store);
  assertEqual(store.load(id, 'owner').sessionId, 'owner', 'original history establishes ownership');
  assertEqual(object(replayResult(owned).artifact).id, id, 'restored card can open the owned document');
  const foreign = restoreLegacyDiagramCards(replay('digram_open', result, 'other'), 'other', store);
  assertEqual(replayResult(foreign).artifact, undefined, 'conflicting history does not create an actionable card');
  assertEqual(store.load(id, 'owner').sessionId, 'owner', 'the established owner is retained');
});

h.test('the legacy repair stays narrow: only digram_open, never a 3D result', () => {
  assertEqual(legacyDiagramArtifact('digram_edit', { content: [{ type: 'text', text: '{"id":"x","document":{"title":"T"}}' }] }), undefined, 'a non-open diagram verb is not repaired');
  assertEqual(legacyDiagramArtifact('model3d_scene', { content: [{ type: 'text', text: '{"id":"x","document":{"title":"T"}}' }] }), undefined, 'a 3D result never takes the diagram legacy path');
});

void h.finish(join(__dirname, 'visual-artifacts-result.json'), 'visual-artifacts').then(code => {
  rmSync(root, { recursive: true, force: true }); process.exit(code);
});
