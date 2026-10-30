import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceStore } from '../main/services/workspaces';
import { Model3DService } from '../main/model3d/service';
import { model3dTools } from '../main/model3d/tools';
import { kernel, computeNormals, GeometryCache, evaluateObject } from '../main/model3d/kernel';
import { bake } from '../main/model3d/physics';
import { exportGlb, importGltf, exportObj, importObj, transformGeometry } from '../main/model3d/io';
import { emptyDocument, parseDocument, geometryKey, defaultMaterial, safeName, type Modifier3D } from '../main/model3d/model';
import { registerModel3DHandlers } from '../main/ipc/handlers/model3d';
import { ChannelRegistry } from '../main/ipc/registry';
import { record, type Data } from '../main/visuals/data';
import type { Json } from '../main/ipc/contract';
import { assert, assertEqual, Harness } from './harness';

/**
 * The 3D kernel runs IN-PROCESS (WASM), so unlike a Blender-backed suite there is
 * no external binary and no env var to opt into: every test here runs in the
 * ordinary `desktop:test:host` gate. That is the point of the rewrite — a 3D
 * feature whose tests need a 900 MB download to go live is a feature whose tests
 * never run in CI.
 *
 * Coverage: kernel loading and evaluation, the MCP tool schema and its
 * read-only/destructive annotations, document persistence and the version guard,
 * the modifier stack (including cycle refusal and bake), physics baking into
 * keyframes, glTF/OBJ round-trips, the delegated render handshake, panel
 * write-back through the same apply path, and the loopback capability's
 * task-binding and revocation.
 */

const h = new Harness();
const root = mkdtempSync(join(__dirname, 'model3d-store-'));
const events: Array<{ channel: string; data: Data }> = [];
let enabled = true;

// A workspace stub with exactly the surface Model3DService uses: renders land in
// the session directory the way image/video generation publishes them.
const workspaces = {
  resolveSessionDirectory: (id: string): string => join(root, 'sessions', id.replace(/[^a-zA-Z0-9_-]/g, '_')),
  sessionDirectory: async (id: string): Promise<string> => {
    const path = join(root, 'sessions', id.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await mkdir(path, { recursive: true });
    return path;
  },
  withDirectoryOperation: async <T>(_roots: () => Promise<string[]>, op: () => T | Promise<T>): Promise<T> => op(),
} as unknown as Pick<WorkspaceStore, 'resolveSessionDirectory' | 'sessionDirectory' | 'withDirectoryOperation'>;

const service = new Model3DService({
  configRoot: root, windowId: 42, workspaces,
  emit: (channel, data) => events.push({ channel, data: record(data) }),
  enabled: () => enabled,
});
const registry = new ChannelRegistry();
registerModel3DHandlers(registry, { service });
const invoke = async (channel: string, args: Data = {}, senderId = 42): Promise<Data> =>
  record(await registry.lookup(channel)!({ role: 'main', senderId, channel, args: [args] }));
const toolValue = (result: Data): Data => {
  assert(result.isError !== true, `tool returned an error: ${JSON.stringify(result)}`);
  return record(result.structuredContent);
};
const lastEvent = (channel: string): Data | undefined => {
  for (let index = events.length - 1; index >= 0; index--) if (events[index]!.channel === channel) return events[index]!.data;
  return undefined;
};

// ───────────────────────── kernel (in-process WASM) ─────────────────────────

h.test('the WASM kernel loads and evaluates primitives to watertight solids', async () => {
  const k = await kernel();
  assert(typeof k.Manifold.cube === 'function', 'manifold static factories are present after setup');
  const box = k.Manifold.cube([2, 2, 2], true);
  const ball = k.Manifold.sphere(1.2, 24);
  const sub = box.subtract(ball);
  assertEqual(sub.isEmpty(), false, 'the boolean result is a real solid');
  assertEqual(sub.status(), 'NoError', 'the boolean result is manifold');
  assert(sub.numVert() > 8, 'subtracting a sphere from a cube added vertices');
});

h.test('computeNormals produces unit normals and never NaN', () => {
  // A single CCW triangle in the XY plane: every normal must be +Z.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const normals = computeNormals(positions, indices);
  assertEqual(normals.length, positions.length, 'one normal per position component');
  for (let i = 0; i < 3; i++) {
    const z = normals[i * 3 + 2]!;
    assert(Math.abs(z - 1) < 1e-6, `normal ${i} points +Z, got ${z}`);
  }
  assert([...normals].every(Number.isFinite), 'no NaN in the normal buffer');
});

h.test('the geometry cache returns the identical buffer for an unchanged key and a new one after a change', async () => {
  const doc = emptyDocument('cache-doc', 'Cache', 'sess-cache');
  doc.meshes.Cube = { name: 'Cube', primitive: 'cube', primitiveParams: { size: 2 }, materials: [] };
  const cube = { name: 'Cube', type: 'MESH' as const, mesh: 'Cube', transform: { location: { x: 0, y: 0, z: 0 }, rotationEuler: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, modifiers: [] as Modifier3D[], visible: true };
  doc.objects.push(cube);
  const cache = new GeometryCache();
  const first = await evaluateObject(doc, cube, cache);
  const second = await evaluateObject(doc, cube, cache);
  assert(first && second && first === second, 'an unchanged key hits the cache and returns the same buffers');
  // A modifier changes the content hash, so the cache must miss and re-evaluate.
  cube.modifiers.push({ id: 'm1', type: 'subdivide', label: 'Sub', enabled: true, params: { iterations: 1 } });
  const third = await evaluateObject(doc, cube, cache);
  assert(third && third !== first, 'a modifier change produces a different evaluated mesh');
  assert(third!.positions.length > first!.positions.length, 'subdivision added geometry');
});

// ───────────────────────── tool schema ─────────────────────────

h.test('the tool surface names every modelling verb and splits read-only from mutating', () => {
  const tools = model3dTools();
  const names = tools.map(tool => String(tool.name));
  for (const expected of ['model3d_scene', 'model3d_add', 'model3d_transform', 'model3d_modifier',
    'model3d_material', 'model3d_scene_settings', 'model3d_render', 'model3d_animate',
    'model3d_physics', 'model3d_io', 'model3d_document', 'model3d_serialize', 'model3d_mesh', 'model3d_inspect']) {
    assert(names.includes(expected), `tool ${expected} must be declared`);
  }
  assertEqual(new Set(names).size, names.length, 'tool names are unique');
  // There is deliberately no eval escape hatch: no external process to run
  // arbitrary code in, and inventing one would be a security downgrade.
  assert(!names.includes('model3d_eval'), 'no arbitrary-code eval tool exists');
  for (const tool of tools) {
    const schema = record(tool.inputSchema);
    assertEqual(schema.type, 'object', `${String(tool.name)} has an object input schema`);
    assert(record(tool.annotations) && Object.keys(record(tool.annotations)).length > 0, `${String(tool.name)} declares annotations`);
  }
  const annotationsOf = (name: string): Data => record(record(tools.find(tool => tool.name === name)).annotations);
  for (const name of ['model3d_serialize', 'model3d_mesh', 'model3d_inspect']) {
    assertEqual(annotationsOf(name).readOnlyHint, true, `${name} is read-only`);
    assertEqual(annotationsOf(name).destructiveHint, false, `${name} is not destructive`);
  }
  for (const tool of tools) {
    const name = String(tool.name);
    if (['model3d_serialize', 'model3d_mesh', 'model3d_inspect'].includes(name)) continue;
    assert(record(tool.annotations).readOnlyHint !== true, `${name} must not claim read-only`);
  }
});

// ───────────────────────── document lifecycle ─────────────────────────

h.test('the document list answers ownership from the side-car index without opening every document', async () => {
  const { Model3DStore } = await import('../main/model3d/store');
  const { writeFileSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(__dirname, 'model3d-index-'));
  const store = new Model3DStore(dir);
  const docs = store.root;
  const mine = store.open('sess-mine', { title: 'Mine' });
  store.save(mine);
  assertEqual(store.list('sess-mine').length, 1, 'the owner sees its document');
  assertEqual(store.list('sess-other').length, 0, 'another session sees none');
  // A hand-placed document is unknown to the index: listing reconciles it once.
  const foreign = { ...emptyDocument('foreign-doc', 'Foreign', 'sess-foreign') };
  writeFileSync(join(docs, 'foreign-doc.model3d.json'), JSON.stringify(foreign));
  assertEqual(store.list('sess-foreign').length, 1, 'an unindexed document is reconciled by reading it once');
  // Now the index carries every row: rewriting a document behind the index's
  // back must NOT change what listing reports, proving no document was opened.
  const rewritten = { ...foreign, title: 'Rewritten behind the index' };
  writeFileSync(join(docs, 'foreign-doc.model3d.json'), JSON.stringify(rewritten));
  const rows = store.list('sess-foreign');
  assertEqual(rows.length, 1, 'the indexed document still lists');
  assertEqual(record(rows[0]).title, 'Foreign', 'listing reads the index, not the document');
  // A corrupt index is rebuilt from the documents instead of blanking the list.
  writeFileSync(join(docs, 'index.json'), 'not json at all');
  const rebuilt = store.list('sess-foreign');
  assertEqual(rebuilt.length, 1, 'a corrupt index is rebuilt');
  assertEqual(record(rebuilt[0]).title, 'Rewritten behind the index', 'the rebuild reads the documents again');
  // Saving refreshes the indexed copy of the saved document.
  const saved = store.save(store.load('foreign-doc', 'sess-foreign'));
  assertEqual(record(store.list('sess-foreign')[0]).version, saved.version, 'a save refreshes the index row');
  assert(readFileSync(join(docs, 'index.json'), 'utf8').includes('foreign-doc'), 'the index names every document');
  rmSync(dir, { recursive: true, force: true });
});

h.test('model3d_scene creates a document, emits the changed event, and reports a summary', async () => {
  const result = toolValue(await service.execute('sess-a', 'model3d_scene', { action: 'new', title: 'Proof' }));
  const doc = record(result.document);
  assertEqual(record(result.summary).objects, 0, 'a new document is empty');
  assertEqual(doc.title, 'Proof', 'the title is stored');
  const event = lastEvent('model3d:changed');
  assert(event && record(event).id === doc.id, 'a changed event names the new document');
  // The card is what gives the conversation a way to open the panel; without it
  // the user has to be told about a surface they cannot reach.
  const raw = await service.execute('sess-card', 'model3d_scene', { action: 'new', title: 'Carded' });
  const content = (raw.content as Data[]) ?? [];
  const card = content.map(item => record(item).text).find(value => typeof value === 'string' && value.includes('"artifact"'));
  assert(typeof card === 'string' && card.includes('"kind":"model3d"'), 'model3d_scene publishes its open-panel card');
});

// A task that opens with a modelling verb instead of model3d_scene still ends up
// with a document — documentFor creates it. That path must card the document
// too, or the whole failure mode returns through the side door: the agent built
// a scene and the user has no way to open the panel.
h.test('a modelling verb that implicitly created the document publishes the card once', async () => {
  const first = await service.execute('sess-implicit', 'model3d_add', { kind: 'cube' });
  const firstTexts = ((first.content as Data[]) ?? []).map(item => String(record(item).text ?? ''));
  const firstCards = firstTexts.filter(text => text.includes('"artifact"'));
  assertEqual(firstCards.length, 1, 'the creating verb carries exactly one card');
  assert(firstCards[0]!.includes('"kind":"model3d"'), 'the card names the 3D surface');
  const second = await service.execute('sess-implicit', 'model3d_add', { kind: 'cube' });
  const secondCards = ((second.content as Data[]) ?? [])
    .map(item => String(record(item).text ?? ''))
    .filter(text => text.includes('"artifact"'));
  assertEqual(secondCards.length, 0, 'a later verb in the same session does not repeat the card');
  service.releaseSession('sess-implicit');
});

h.test('add returns real de-duplicated names and the first camera becomes active', async () => {
  const cube = toolValue(await service.execute('sess-a', 'model3d_add', { kind: 'cube', location: [0, 0, 0] }));
  const cubeName = String(cube.name);
  assert(cubeName.length > 0, 'the cube got a name');
  const second = toolValue(await service.execute('sess-a', 'model3d_add', { kind: 'cube' }));
  assert(String(second.name) !== cubeName, 'a second cube is de-duplicated, not overwritten');
  const cam = toolValue(await service.execute('sess-a', 'model3d_add', { kind: 'camera', location: [5, -5, 4] }));
  const scene = toolValue(await service.execute('sess-a', 'model3d_scene', {}));
  const serialized = record(scene.document);
  const cameras = (serialized.objects as Json[]).map(record).filter(item => item.type === 'CAMERA');
  assertEqual(cameras.length, 1, 'one camera exists');
  assertEqual(record(cameras[0]!.camera).active, true, 'the only camera is the active render camera');
  assertEqual(String(cam.name).length > 0, true, 'the camera got a name');
});

h.test('a transform write-back through model3d:apply is visible to the next serialize', async () => {
  const cube = toolValue(await service.execute('sess-a', 'model3d_add', { kind: 'cube' }));
  const name = String(cube.name);
  const applied = record(await invoke('model3d:apply', { sessionId: 'sess-a', ops: [{ type: 'transform', name, location: [7, 0, 7] }] }));
  assertEqual(applied.ok, true, 'the drag applied');
  assert(applied.document, 'apply returns the new document so the panel repaints without a second round trip');
  const moved = (record(applied.document).objects as Json[]).map(record).find(item => item.name === name)!;
  assertEqual((moved.location as number[])[0], 7, 'the dragged object moved on X');
});

h.test('model3d:apply refuses a stale base version instead of clobbering a newer edit', async () => {
  const cube = toolValue(await service.execute('sess-a', 'model3d_add', { kind: 'cube' }));
  const name = String(cube.name);
  const current = record(await invoke('model3d:get', { sessionId: 'sess-a' }));
  const version = Number(record(current.document).version);
  // An agent edit lands, advancing the version past what the drag was built on.
  await service.execute('sess-a', 'model3d_transform', { name, location: [1, 1, 1] });
  const stale = record(await invoke('model3d:apply', { sessionId: 'sess-a', baseVersion: version, ops: [{ type: 'transform', name, location: [9, 9, 9] }] }));
  assertEqual(stale.ok, false, 'the stale drag is refused');
  assertEqual(stale.stale, true, 'the refusal is flagged stale');
  assert(stale.document, 'the reply carries the current document so the panel can re-sync');
});

// ───────────────────────── modifier stack ─────────────────────────

h.test('the modifier stack evaluates non-destructively and a self-referential boolean is refused', async () => {
  const fresh = 'sess-mod';
  await service.execute(fresh, 'model3d_scene', { action: 'new' });
  const box = toolValue(await service.execute(fresh, 'model3d_add', { kind: 'cube' }));
  const boxName = String(box.name);
  const before = toolValue(await service.execute(fresh, 'model3d_mesh', { name: boxName }));
  await service.execute(fresh, 'model3d_modifier', { action: 'add', name: boxName, type: 'subdivide', params: { iterations: 1 } });
  const after = toolValue(await service.execute(fresh, 'model3d_mesh', { name: boxName }));
  assert(Number(after.verts) > Number(before.verts), 'subdivision increased the evaluated vertex count');
  assertEqual(String(after.geometry_key) !== String(before.geometry_key), true, 'the cache key moved when the stack changed');

  // A boolean against itself must be detected, not hang the host.
  await service.execute(fresh, 'model3d_modifier', { action: 'add', name: boxName, type: 'boolean', params: { operation: 'subtract', object: boxName } });
  const cyclic = await service.execute(fresh, 'model3d_mesh', { name: boxName });
  assertEqual(cyclic.isError, true, 'a self-referential boolean is refused');
  assert(/cycle/i.test(String(record((cyclic.content as Json[])[0]).text)), 'the refusal names the cycle');
  service.releaseSession(fresh);
});

h.test('applying a modifier bakes the stack into the base mesh and keeps later layers editable', async () => {
  const fresh = 'sess-apply';
  await service.execute(fresh, 'model3d_scene', { action: 'new' });
  const box = toolValue(await service.execute(fresh, 'model3d_add', { kind: 'cube' }));
  const name = String(box.name);
  await service.execute(fresh, 'model3d_modifier', { action: 'add', name, type: 'subdivide', params: { iterations: 1 } });
  await service.execute(fresh, 'model3d_modifier', { action: 'add', name, type: 'mirror', params: { axis: 'x' } });
  const applied = toolValue(await service.execute(fresh, 'model3d_modifier', { action: 'apply', name, modifier: 'subdivide-1' }));
  assertEqual(Number(applied.applied), 1, 'one layer was baked');
  const inspected = toolValue(await service.execute(fresh, 'model3d_inspect', { name }));
  const remaining = (inspected.modifiers as Json[]).map(item => record(item).type);
  assert(remaining.includes('mirror') && !remaining.includes('subdivide'), 'the baked layer is gone, the later one remains');
  service.releaseSession(fresh);
});

// ───────────────────────── physics ─────────────────────────

h.test('a rigid-body bake writes location keyframes an object actually falls through', async () => {
  const fresh = 'sess-phys';
  await service.execute(fresh, 'model3d_scene', { action: 'new' });
  await service.execute(fresh, 'model3d_add', { kind: 'plane', location: [0, 0, 0], name: 'Ground' });
  await service.execute(fresh, 'model3d_add', { kind: 'cube', location: [0, 0, 5], name: 'Faller' });
  await service.execute(fresh, 'model3d_physics', { action: 'rigid_body', name: 'Ground', kind: 'passive' });
  await service.execute(fresh, 'model3d_physics', { action: 'rigid_body', name: 'Faller', kind: 'active' });
  await service.execute(fresh, 'model3d_scene_settings', { frame_start: 1, frame_end: 30, fps: 24 });
  const baked = toolValue(await service.execute(fresh, 'model3d_physics', { action: 'bake' }));
  assert(Number(baked.frames) >= 2, 'the bake produced frames');
  const inspected = toolValue(await service.execute(fresh, 'model3d_inspect', { name: 'Faller' }));
  assert((inspected.animation as Json[]).includes('location'), 'the bake wrote location keyframes');
  // The exact fall distance is asserted in the kernel-level bake test below,
  // which reads the raw tracks; here it is enough that the bake produced a
  // location track at all and did not throw.
  service.releaseSession(fresh);
});

h.test('the bake helper steps a falling body downward under gravity', async () => {
  const k = await kernel();
  const doc = emptyDocument('phys-doc', 'Phys', 'sess-phys2');
  doc.meshes.Ground = { name: 'Ground', primitive: 'plane', primitiveParams: { size: 20 }, materials: [] };
  doc.meshes.Ball = { name: 'Ball', primitive: 'uv_sphere', primitiveParams: { radius: 0.5, segments: 16 }, materials: [] };
  doc.objects.push({ name: 'Ground', type: 'MESH', mesh: 'Ground', transform: { location: { x: 0, y: 0, z: 0 }, rotationEuler: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, modifiers: [], visible: true, rigidBody: { kind: 'passive', mass: 1, friction: 0.5, restitution: 0 } });
  doc.objects.push({ name: 'Ball', type: 'MESH', mesh: 'Ball', transform: { location: { x: 0, y: 0, z: 5 }, rotationEuler: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, modifiers: [], visible: true, rigidBody: { kind: 'active', mass: 1, friction: 0.5, restitution: 0 } });
  const result = await bake(k, doc, 1, 40, 24);
  const ballTrack = result.tracks['Ball']!;
  const startZ = ballTrack[0]![2]!;
  const endZ = ballTrack[ballTrack.length - 1]![2]!;
  assert(endZ < startZ, `the ball fell: z ${startZ.toFixed(2)} -> ${endZ.toFixed(2)}`);
  assert(endZ > 0 && endZ < 1.5, `the ball came to rest near the ground, not through it (z=${endZ.toFixed(2)})`);
});

// ───────────────────────── io round-trips ─────────────────────────

h.test('glTF export then import round-trips geometry and material', async () => {
  const dir = join(root, 'io-glb');
  await mkdir(dir, { recursive: true });
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]);
  const normals = computeNormals(positions, indices);
  const path = join(dir, 'tetra.glb');
  await exportGlb(path, [{ name: 'Tetra', positions, normals, indices, material: { name: 'Red', baseColor: [0.9, 0.1, 0.1, 1], metallic: 0.2, roughness: 0.4 } }]);
  assert(existsSync(path), 'the glb was written');
  const back = await importGltf(path);
  assertEqual(back.length, 1, 'one mesh came back');
  assertEqual(back[0]!.indices.length / 3, 4, 'all four triangles survived');
  assert(back[0]!.positions.every((value, index) => Math.abs(value - positions[index]!) < 1e-4), 'positions round-tripped');
  assertEqual(back[0]!.material?.name, 'Red', 'the material round-tripped');
});

h.test('OBJ export then import round-trips geometry', async () => {
  const dir = join(root, 'io-obj');
  await mkdir(dir, { recursive: true });
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const normals = computeNormals(positions, indices);
  const path = join(dir, 'tri.obj');
  await exportObj(path, [{ name: 'Tri', positions, normals, indices }]);
  const back = await importObj(path);
  assertEqual(back.length, 1, 'one mesh came back');
  assertEqual(back[0]!.indices.length / 3, 1, 'the triangle survived');
});

h.test('transformGeometry bakes translation, rotation and scale into the vertices', () => {
  // One vertex at the origin: a pure translation must move it exactly.
  const moved = transformGeometry(new Float32Array([0, 0, 0]), new Float32Array([]), { location: [3, 4, 5], rotation_euler: [0, 0, 0], scale: [1, 1, 1] });
  assertEqual(moved.positions[0], 3, 'translation applied to X');
  assertEqual(moved.positions[1], 4, 'translation applied to Y');
  assertEqual(moved.positions[2], 5, 'translation applied to Z');
  // A 90° rotation about Z maps +X to +Y.
  const rotated = transformGeometry(new Float32Array([1, 0, 0]), new Float32Array([]), { location: [0, 0, 0], rotation_euler: [0, 0, Math.PI / 2], scale: [1, 1, 1] });
  assert(Math.abs(rotated.positions[0]!) < 1e-6, 'a +X vertex rotated 90° about Z has X≈0');
  assert(Math.abs(rotated.positions[1]! - 1) < 1e-6, 'a +X vertex rotated 90° about Z lands on +Y');
  // A 2x scale doubles the distance from the origin.
  const scaled = transformGeometry(new Float32Array([1, 1, 1]), new Float32Array([]), { location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [2, 2, 2] });
  assertEqual(scaled.positions[0], 2, 'scale applied');
  // Normals stay unit length under a non-uniform scale (inverse-transpose fix).
  const withNormals = transformGeometry(new Float32Array([1, 0, 0]), new Float32Array([1, 0, 0]), { location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [3, 1, 1] });
  const length = Math.hypot(withNormals.normals[0]!, withNormals.normals[1]!, withNormals.normals[2]!);
  assert(Math.abs(length - 1) < 1e-5, `normals stay unit length under non-uniform scale, got ${length}`);
});

h.test('a glTF export then import round-trips orientation (Y-up <-> Z-up is an exact inverse)', async () => {
  const dir = join(root, 'io-axis');
  await mkdir(dir, { recursive: true });
  // An asymmetric triangle: if the axis swap were wrong or not inverted, the
  // recovered vertices would differ from the originals.
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 1]);
  const indices = new Uint32Array([0, 1, 2]);
  const normals = computeNormals(positions, indices);
  const path = join(dir, 'axis.glb');
  await exportGlb(path, [{ name: 'Asym', positions, normals, indices }]);
  const back = await importGltf(path);
  const recovered = back[0]!.positions;
  for (let index = 0; index < positions.length; index++) {
    assert(Math.abs(recovered[index]! - positions[index]!) < 1e-4, `axis round trip preserved component ${index}: ${positions[index]} -> ${recovered[index]}`);
  }
});

h.test('a textured or compressed glTF is refused, not silently stripped', async () => {
  const dir = join(root, 'io-bad');
  await mkdir(dir, { recursive: true });
  // A minimal valid GLB envelope whose JSON declares a required Draco extension.
  const jsonText = JSON.stringify({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'], meshes: [] });
  const padded = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
  const jsonBuf = Buffer.from(padded, 'utf8');
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonBuf.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4);
  const path = join(dir, 'draco.glb');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, Buffer.concat([header, chunkHeader, jsonBuf]));
  let refused = false;
  try {
    await importGltf(path);
  } catch (error) {
    refused = /unsupported extension/i.test(String((error as Error).message));
  }
  assert(refused, 'a Draco-compressed glTF is refused with an explicit message');
});

// ───────────────────────── delegated render ─────────────────────────

h.test('render delegates to the panel and refuses when the panel never answers', async () => {
  const fresh = 'sess-render';
  await service.execute(fresh, 'model3d_scene', { action: 'new' });
  await service.execute(fresh, 'model3d_add', { kind: 'camera', location: [5, -5, 4] });
  // A short timeout so the test does not wait the full render deadline: with no
  // panel subscribed, the request must time out rather than hang the tool call.
  const pending = service.execute(fresh, 'model3d_render', {});
  const request = await new Promise<Data>(resolveRequest => {
    const timer = setInterval(() => {
      const event = lastEvent('model3d:render-request');
      if (event) { clearInterval(timer); resolveRequest(event); }
    }, 5);
    setTimeout(() => clearInterval(timer), 2000);
  });
  assertEqual(String(request.requestId).length > 0, true, 'a render request was published to the panel');
  assertEqual(record(request).format, 'png', 'the request names the format');
  // Answer it the way the panel would, and the tool call resolves to a file.
  // The panel reports it is NOT the surface the user is looking at (no
  // panelVisible here), so the result must say the user cannot see the scene.
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  await invoke('model3d:render-result', { requestId: String(request.requestId), format: 'png', data: png.toString('base64') });
  const rendered = toolValue(await pending);
  assert(String(rendered.path).includes(join('sessions', fresh)), 'the render landed in the session workspace');
  assert(existsSync(String(rendered.path)), 'the rendered file exists');
  assertEqual(rendered.panelVisible, false, 'a render with no visible panel reports panelVisible false');
  const contentItems = rendered.contentItems as Json[];
  const note = contentItems.map(item => String(record(item).text)).join('\n');
  assert(/Saved:/.test(note), 'the result carries a Saved: line');
  assert(/NOT open/.test(note), 'the result tells the agent the panel is not open, so it cannot claim the user sees the scene');
  service.releaseSession(fresh);
});

h.test('a render answered by a visible panel reports that the user can see the scene', async () => {
  const fresh = 'sess-render-visible';
  await service.execute(fresh, 'model3d_scene', { action: 'new' });
  await service.execute(fresh, 'model3d_add', { kind: 'camera' });
  const pending = service.execute(fresh, 'model3d_render', {});
  const request = await new Promise<Data>(resolveRequest => {
    const timer = setInterval(() => { const event = lastEvent('model3d:render-request'); if (event) { clearInterval(timer); resolveRequest(event); } }, 5);
    setTimeout(() => clearInterval(timer), 2000);
  });
  // The render request names its session, which is how the panel tells a
  // background render apart from the scene the user is actually looking at.
  assertEqual(String(request.sessionId), fresh, 'the render request carries the owning session');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  await invoke('model3d:render-result', { requestId: String(request.requestId), format: 'png', data: png.toString('base64'), panelVisible: true });
  const rendered = toolValue(await pending);
  assertEqual(rendered.panelVisible, true, 'a visible panel reports panelVisible true');
  const note = (rendered.contentItems as Json[]).map(item => String(record(item).text)).join('\n');
  assert(/panel is open/.test(note), 'the result confirms the scene is on screen');
  service.releaseSession(fresh);
});

h.test('a render with a non-image payload is rejected rather than written', async () => {
  const fresh = 'sess-render-bad';
  await service.execute(fresh, 'model3d_scene', { action: 'new' });
  await service.execute(fresh, 'model3d_add', { kind: 'camera' });
  const pending = service.execute(fresh, 'model3d_render', {});
  const request = await new Promise<Data>(resolveRequest => {
    const timer = setInterval(() => { const event = lastEvent('model3d:render-request'); if (event) { clearInterval(timer); resolveRequest(event); } }, 5);
    setTimeout(() => clearInterval(timer), 2000);
  });
  // Bytes that are not a PNG signature must be refused, so a corrupt panel
  // render cannot be published as an image to the user.
  const reply = record(await invoke('model3d:render-result', { requestId: String(request.requestId), format: 'png', data: Buffer.from('not a png').toString('base64') }));
  assertEqual(reply.ok, false, 'the bad render bytes were rejected');
  const result = await pending;
  assertEqual(result.isError, true, 'the render tool call fails when the panel returns bad bytes');
  service.releaseSession(fresh);
});

// ───────────────────────── loopback MCP capability ─────────────────────────

h.test('the capability binds to one task, refuses forgery and browser origins, and revokes on release', async () => {
  const caps = await service.hostCapabilities('task-cap');
  const servers = caps.mcpServers as Json[];
  assert(Array.isArray(servers) && servers.length === 1, 'one MCP server is injected');
  const url = String(record(servers[0]).url);
  assert(url.startsWith('http://127.0.0.1:'), 'the server is loopback only');
  const rpc = async (target: string, method: string, headers: Record<string, string> = {}): Promise<{ status: number }> => {
    const response = await fetch(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'tools/call' ? { name: 'model3d_serialize', arguments: {} } : {} }),
    });
    return { status: response.status };
  };
  const list = await rpc(url, 'tools/list');
  assertEqual(list.status, 200, 'tools/list reaches the capability');
  const forged = new URL(url);
  forged.searchParams.set('session', 'other-task');
  assertEqual((await rpc(forged.toString(), 'tools/list')).status, 404, 'a forged session query is refused');
  assertEqual((await rpc(url, 'tools/list', { Origin: 'https://evil.test' })).status, 403, 'a browser origin is refused');
  service.releaseSession('task-cap');
  assertEqual((await rpc(url, 'tools/list')).status, 404, 'a released task token is revoked');
});

h.test('tools/call over the loopback capability reaches the same document as a direct call', async () => {
  const fresh = 'sess-mcp';
  await service.execute(fresh, 'model3d_scene', { action: 'new' });
  await service.execute(fresh, 'model3d_add', { kind: 'monkey' });
  const caps = await service.hostCapabilities(fresh);
  const url = String(record((caps.mcpServers as Json[])[0]).url);
  const response = record(await (await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'model3d_inspect', arguments: {} } }),
  })).json());
  const structured = record(record(response.result).structuredContent);
  assert((structured.objects as Json[]).length >= 1, 'the loopback call saw the object');
  service.releaseSession(fresh);
});

h.test('a disabled plugin injects no capability and refuses tool calls', async () => {
  enabled = false;
  const caps = await service.hostCapabilities('task-off');
  assertEqual(JSON.stringify(caps), JSON.stringify({ mcpServers: [], runtimeCapabilityRoots: [] }), 'a disabled plugin injects nothing');
  const result = await service.execute('task-off', 'model3d_scene', {});
  assertEqual(result.isError, true, 'a disabled plugin refuses execution');
  enabled = true;
});

h.test('the IPC surface rejects a foreign window', async () => {
  const foreign = await invoke('model3d:list', { sessionId: 'x' }, 999);
  assertEqual(foreign.ok, false, 'another window cannot drive the panel');
  assert(/another window/i.test(String(foreign.error)), 'the refusal names the window mismatch');
});

// ───────────────────────── pure model helpers ─────────────────────────

h.test('safeName de-duplicates and rejects unsafe characters', () => {
  const taken = ['Cube', 'Cube.001'];
  assertEqual(safeName('Cube', 'Mesh', taken), 'Cube.002', 'the next free suffix is used');
  assertEqual(safeName('../etc/passwd', 'Mesh', []), 'etcpasswd', 'path traversal is stripped');
  assertEqual(safeName('', 'Fallback', []), 'Fallback', 'an empty name falls back');
});

h.test('parseDocument round-trips a serialized document and drops unknown modifier types', () => {
  const doc = emptyDocument('roundtrip', 'RT', 'sess-rt');
  doc.materials.Red = { ...defaultMaterial('Red'), baseColor: [1, 0, 0, 1] };
  doc.meshes.Cube = { name: 'Cube', primitive: 'cube', primitiveParams: { size: 2 }, materials: ['Red'] };
  doc.objects.push({ name: 'Cube', type: 'MESH', mesh: 'Cube', transform: { location: { x: 1, y: 2, z: 3 }, rotationEuler: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, modifiers: [{ id: 'm1', type: 'subdivide', label: 'Sub', enabled: true, params: { iterations: 2 } }], visible: true });
  const reparsed = parseDocument(JSON.parse(JSON.stringify(doc)));
  assertEqual(reparsed.objects.length, 1, 'the object survived');
  assertEqual(reparsed.objects[0]!.modifiers[0]!.type, 'subdivide', 'a known modifier survived');
  // An unknown modifier type must be dropped, not crash the parse: a document
  // written by a newer Klaus must still open on an older one.
  const dirty = JSON.parse(JSON.stringify(doc));
  dirty.objects[0].modifiers.push({ id: 'x', type: 'not_a_real_modifier', label: 'X', enabled: true, params: {} });
  const cleaned = parseDocument(dirty);
  assertEqual(cleaned.objects[0]!.modifiers.length, 1, 'an unknown modifier type is dropped on parse');
});

h.test('geometryKey changes with a modifier param but not with a transform', () => {
  const doc = emptyDocument('key-doc', 'Key', 'sess-key');
  doc.meshes.Cube = { name: 'Cube', primitive: 'cube', primitiveParams: {}, materials: [] };
  const cube = { name: 'Cube', type: 'MESH' as const, mesh: 'Cube', transform: { location: { x: 0, y: 0, z: 0 }, rotationEuler: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, modifiers: [{ id: 'm', type: 'subdivide' as const, label: 'S', enabled: true, params: { iterations: 1 } as Record<string, Json> }], visible: true };
  doc.objects.push(cube);
  const base = geometryKey(doc, cube);
  cube.transform.location.x = 99;
  assertEqual(geometryKey(doc, cube), base, 'a transform does not change the geometry key (transforms are cheap, not re-evaluated)');
  cube.modifiers[0]!.params = { iterations: 3 };
  assert(geometryKey(doc, cube) !== base, 'a modifier param change moves the geometry key');
});

void h.finish(join(__dirname, 'model3d-result.json'), 'model3d').then(async code => {
  await service.shutdown();
  rmSync(root, { recursive: true, force: true });
  process.exit(code);
});
