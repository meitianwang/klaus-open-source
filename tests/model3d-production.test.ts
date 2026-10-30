import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceStore } from '../main/services/workspaces';
import { Model3DService } from '../main/model3d/service';
import { decodeTexturePng, encodeTexturePng } from '../main/model3d/texture-edit';
import { findObject, geometryKey, type MeshBlock, type Model3DDocument } from '../main/model3d/model';
import { multiplyMatrices, worldMatrixOf } from '../main/model3d/scene-math';
import { record, type Data } from '../main/visuals/data';
import type { Json } from '../main/ipc/contract';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

/** Acceptance exercises the shipped host service, persisted documents and files. */
const h = new Harness();
const evidence = join(__dirname, '..', 'model3d-production-logs');
mkdirSync(evidence, { recursive: true });
const fixtureRoot = mkdtempSync(join(evidence, 'store-'));
const events: Array<{ channel: string; data: Data }> = [];
const workspace = {
  resolveSessionDirectory: (id: string) => join(fixtureRoot, 'sessions', id),
  sessionDirectory: async (id: string) => { const path = join(fixtureRoot, 'sessions', id); mkdirSync(path, { recursive: true }); return path; },
  withDirectoryOperation: async <T>(_roots: () => Promise<string[]>, operation: () => T | Promise<T>) => operation(),
} as unknown as Pick<WorkspaceStore, 'resolveSessionDirectory' | 'sessionDirectory' | 'withDirectoryOperation'>;
const service = new Model3DService({ configRoot: fixtureRoot, windowId: 97, workspaces: workspace, emit: (channel, data) => events.push({ channel, data: record(data) }), enabled: () => true });
const owner = 'production-character';
let id = '', boundSkin = '';
const call = async (verb: string, fields: Data = {}, session = owner): Promise<Data> => {
  const result = await service.execute(session, verb, fields);
  assert(result.isError !== true, `${verb}: ${JSON.stringify(result)}`);
  return record(result.structuredContent);
};
const read = (session = owner): Model3DDocument => service.store.load(service.store.resolveId(session), session);
const mesh = (document: Model3DDocument, name: string): MeshBlock => document.meshes[findObject(document, name)!.mesh!]!;
const near = (actual: number[], expected: number[], label: string) => {
  assertEqual(actual.length, expected.length, `${label} length`);
  actual.forEach((value, i) => assert(Math.abs(value - expected[i]!) < 1e-5, `${label}[${i}] expected ${expected[i]}, got ${value}`));
};
const failUnchanged = async (verb: string, fields: Data, pattern: RegExp, session = owner): Promise<void> => {
  const before = read(session), eventCount = events.length;
  const result = await service.execute(session, verb, fields);
  assert(result.isError === true, `${verb} must reject invalid input`);
  assert(pattern.test(JSON.stringify(result)), `Expected ${pattern}, got ${JSON.stringify(result)}`);
  assertDeepEqual(read(session), before, 'Rejected operation leaves document bytes, data and version unchanged');
  assertEqual(events.length, eventCount, 'Rejected operation publishes no scene changes');
};
const invoke = async (channel: string, fields: Data, session = owner): Promise<Data> => record(await service.invoke({ role: 'main', senderId: 97, channel, args: [{ sessionId: session, ...fields }] }));
const graph: Record<string, Json> = { nodes: [{ id: 'surface', type: 'primitive', kind: 'grid', params: { size: 2, subdivisions: 2 } }, { id: 'raised', type: 'transform', input: 'surface', translation: { x: 0, y: 0, z: 1 } }], output: 'raised' };

h.test('service creates an owned editable geometry graph with real open-surface vertices', async () => {
  const scene = await call('model3d_scene', { action: 'new', title: 'Character acceptance' }); id = String(scene.id);
  assert(id.length > 0 && existsSync(service.store.path(id)), 'An owned persisted document exists');
  const authored = await call('model3d_geometry', { name: 'Body', graph });
  assertEqual(authored.vertices, 9, 'Grid vertices'); assertEqual(authored.triangles, 8, 'Grid triangles');
  const document = read(); assertEqual(document.sessionId, owner, 'Task owner'); assertDeepEqual(mesh(document, 'Body').geometryGraph, graph, 'Editable graph is stored');
  assert(mesh(document, 'Body').positions!.every((value, i) => i % 3 !== 2 || value === 1), 'Graph translation affects the surface itself');
});
h.test('custom character patches accept morph deltas and recompute normals after position-only edits', async () => {
  await call('model3d_mesh_edit', { action: 'create', name: 'Face', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], morphTargets: [{ name: 'Expression', positions: [0, 0, 0.1, 0, 0, 0.1, 0, 0, 0.1] }] });
  await call('model3d_mesh_edit', { action: 'update', name: 'Face', positions: [0, 0, 0, 1, 0, 0, 0, 1, 1] });
  const face = mesh(read(), 'Face'); near(face.normals!.slice(0, 3), [0, -Math.SQRT1_2, Math.SQRT1_2], 'Normals match the edited triangle');
  assertEqual(face.morphTargets![0]!.positions!.length, face.positions!.length, 'Relative expression data is retained');
});
h.test('a bad brush in a multi-stroke operation fails without partial vertex edits or a new version', async () => {
  await failUnchanged('model3d_sculpt', { name: 'Body', strokes: [{ brush: 'draw', point: [0, 0, 1], radius: 0.6, strength: 0.2 }, { brush: 'grab', point: [0, 0, 1], radius: 0.6, strength: 0.2 }] }, /Grab requires/i);
});
h.test('sculpt edits a localized surface region while object scale and untouched vertices stay stable', async () => {
  const before = read(), original = mesh(before, 'Body').positions!.slice(), transform = structuredClone(findObject(before, 'Body')!.transform);
  const result = await call('model3d_sculpt', { name: 'Body', strokes: [{ brush: 'draw', point: [0, 0, 1], radius: 0.6, strength: 0.2, normal: [0, 0, 1] }] });
  const after = read(), changed = mesh(after, 'Body').positions!;
  assert(Number(result.affectedVertices) > 0, 'A brush reports affected vertices'); assert(changed.some((value, i) => value !== original[i]), 'Base vertex coordinates changed');
  near(changed.slice(0, 3), original.slice(0, 3), 'A distant surface vertex is untouched'); assertDeepEqual(findObject(after, 'Body')!.transform, transform, 'Sculpt is not object scaling');
});
h.test('chart unwrap publishes finite packed UVs and preserves morph values through vertex mapping', async () => {
  await call('model3d_uv', { name: 'Body', method: 'unwrap', options: { padding: 0.02, angleDegrees: 45 } });
  await call('model3d_uv', { name: 'Face', method: 'planar', options: { axis: 'z', padding: 0.02 } });
  const document = read();
  for (const name of ['Body', 'Face']) { const block = mesh(document, name); assertEqual(block.uvs!.length, block.positions!.length / 3 * 2, `${name} UV count`); assert(block.uvs!.every(value => Number.isFinite(value) && value >= 0 && value <= 1), `${name} UVs fit the texture`); }
  const face = mesh(document, 'Face'); near(face.morphTargets![0]!.positions!, new Array(face.positions!.length / 3).fill(0).flatMap(() => [0, 0, 0.1]), 'Morph deltas retained');
});
h.test('default texture painting writes RGB and raises alpha on a transparent PNG', async () => {
  await call('model3d_texture', { action: 'create', name: 'Paint', width: 5, height: 5, color: [0.2, 0.3, 0.4, 0] });
  const before = decodeTexturePng(Buffer.from(read().textures!.Paint!.dataBase64, 'base64')); assertEqual(before.width, 5, 'Actual PNG width'); assert(before.pixels.every((value, i) => i % 4 !== 3 || value === 0), 'Transparent source alpha');
  const painted = await call('model3d_texture', { action: 'paint', name: 'Paint', strokes: [{ uv: [0.5, 0.5], radius: 0.2, color: [1, 0, 0, 1], strength: 1 }] });
  assert(Number(painted.pixelsChanged) > 0, 'Pixel edits reported'); const image = decodeTexturePng(Buffer.from(read().textures!.Paint!.dataBase64, 'base64'));
  near(Array.from(image.pixels.slice(48, 52)), [255, 0, 0, 255], 'Opaque stroke on transparent canvas'); assertEqual(image.pixels[3], 0, 'Unpainted corner stays transparent');
});
h.test('explicit replace and erase texture strokes control alpha independently of source-over', async () => {
  await call('model3d_texture', { action: 'paint', name: 'Paint', strokes: [{ uv: [0.5, 0.5], radius: 0.2, color: [0, 1, 0, 0.5], mode: 'replace', strength: 1 }] });
  const replaced = decodeTexturePng(Buffer.from(read().textures!.Paint!.dataBase64, 'base64')); near(Array.from(replaced.pixels.slice(48, 52)), [0, 255, 0, 128], 'RGBA replacement');
  await call('model3d_texture', { action: 'create', name: 'Erase', width: 5, height: 5, color: [1, 1, 1, 1] });
  await call('model3d_texture', { action: 'paint', name: 'Erase', strokes: [{ uv: [0.5, 0.5], radius: 0.2, color: [1, 1, 1, 1], mode: 'erase', strength: 1 }] });
  const erased = decodeTexturePng(Buffer.from(read().textures!.Erase!.dataBase64, 'base64')); assertEqual(erased.pixels[51], 0, 'Eraser lowers center alpha to zero'); assertEqual(erased.pixels[3], 255, 'Eraser leaves distant pixels intact');
});
h.test('material texture assignment and updates remain shared across separate character parts', async () => {
  await call('model3d_material', { name: 'Skin', base_color: [0.8, 0.9, 1, 1], base_color_texture: 'Paint', alpha_mode: 'BLEND', double_sided: true, assign_to: ['Body', 'Face'], roughness: 0.7 });
  await call('model3d_material', { name: 'Skin', roughness: 0.25 }); const document = read();
  assertEqual(mesh(document, 'Body').materials[0], 'Skin', 'Body material slot'); assertEqual(mesh(document, 'Face').materials[0], 'Skin', 'Face material slot');
  assertEqual(Object.keys(document.materials).length, 1, 'Material update does not create duplicates'); assertEqual(document.materials.Skin!.roughness, 0.25, 'Shared roughness edit'); assertEqual(document.materials.Skin!.baseColorTexture!.texture, 'Paint', 'PNG texture reference');
});
h.test('rig creation and binding persist a bone hierarchy and normalized four-influence weights', async () => {
  await call('model3d_rig', { action: 'create', skin: 'CharacterRig', bones: [{ name: 'Hip', position: [0, 0, 0] }, { name: 'Tip', parent: 'Hip', position: [0, 0, 1] }] });
  const bound = await call('model3d_rig', { action: 'bind', skin: 'CharacterRig', name: 'Body' }); boundSkin = String(bound.skin);
  const document = read(), block = mesh(document, 'Body'); assertEqual(findObject(document, 'Tip')!.parent, 'Hip', 'Bone parent'); assert(findObject(document, 'Hip')!.joint && findObject(document, 'Tip')!.joint, 'Real joint metadata');
  assertEqual(findObject(document, 'Body')!.skin, boundSkin, 'Mesh references the bind-specific skin'); assertEqual(block.skinWeights!.length, block.positions!.length / 3 * 4, 'Four influences');
  for (let i = 0; i < block.skinWeights!.length; i += 4) assert(Math.abs(block.skinWeights!.slice(i, i + 4).reduce((sum, value) => sum + value, 0) - 1) < 1e-6, 'Per-vertex weights sum to one');
  assertEqual(document.skins![boundSkin]!.inverseBindMatrices.length, 32, 'Two inverse bind matrices');
});
h.test('weight painting and a normalized quaternion pose change a character skin palette', async () => {
  await call('model3d_rig', { action: 'set_weights', skin: boundSkin, name: 'Body', weights: [{ vertex: 0, joints: [0, 1], weights: [1, 3] }] });
  await call('model3d_rig', { action: 'pose', skin: boundSkin, poses: [{ name: 'Tip', rotation_quaternion: [0, 0, 2, 2] }] });
  const document = read(), block = mesh(document, 'Body'); near(block.skinWeights!.slice(0, 4), [0.25, 0.75, 0, 0], 'Painted normalized weights'); near(findObject(document, 'Tip')!.transform.rotationQuaternion!, [0, 0, Math.SQRT1_2, Math.SQRT1_2], 'Pose quaternion');
  const vertex = block.positions!.slice(0, 3), skin = document.skins![boundSkin]!, palette = multiplyMatrices(worldMatrixOf(document, 'Tip'), skin.inverseBindMatrices.slice(16, 32));
  const rotated = [0, 1, 2].map(axis => palette[axis]! * vertex[0]! + palette[4 + axis]! * vertex[1]! + palette[8 + axis]! * vertex[2]! + palette[12 + axis]!);
  const weighted = vertex.map((value, axis) => value * 0.25 + rotated[axis]! * 0.75);
  assert(weighted.some((value, axis) => Math.abs(value - vertex[axis]!) > 0.1), 'Bone motion changes a bound vertex');
});
h.test('quaternion keys and the playhead persist once and publish the updated scene', async () => {
  await call('model3d_animate', { action: 'frame_range', start: 1, end: 25, fps: 24 });
  await call('model3d_rig', { action: 'pose', skin: boundSkin, poses: [{ name: 'Tip', rotation_quaternion: [0, 0, 0, 1] }] });
  await call('model3d_animate', { action: 'keyframe', name: 'Tip', frame: 1, data_paths: ['rotation_quaternion'] });
  await call('model3d_rig', { action: 'pose', skin: boundSkin, poses: [{ name: 'Tip', rotation_quaternion: [0, 0, 2, 2] }] });
  await call('model3d_animate', { action: 'keyframe', name: 'Tip', frame: 25, data_paths: ['rotation_quaternion'] });
  const before = read().version, eventCount = events.length; await call('model3d_animate', { action: 'set_frame', frame: 13 }); const document = read();
  assertEqual(document.scene.currentFrame, 13, 'Persisted playhead'); assertEqual(document.version, before + 1, 'One playhead mutation'); assertEqual(events.length, eventCount + 1, 'One changed notification');
  const keys = findObject(document, 'Tip')!.animation!.rotation_quaternion!; assertDeepEqual(keys.map(key => key.frame), [1, 25], 'Key frames'); near(keys[1]!.value, [0, 0, Math.SQRT1_2, Math.SQRT1_2], 'Captured quaternion remains normalized');
});
h.test('graph replacement protects bound surfaces and leaves shared instances intact', async () => {
  await failUnchanged('model3d_geometry', { name: 'Body', graph }, /bound|morph-target/i);
  const session = 'shared-character'; await call('model3d_scene', { action: 'new' }, session); await call('model3d_geometry', { name: 'Shared', graph }, session);
  await invoke('model3d:apply', { baseVersion: read(session).version, ops: [{ type: 'duplicate', name: 'Shared' }] }, session);
  const before = read(session), originalName = findObject(before, 'Shared_copy')!.mesh!, original = structuredClone(before.meshes[originalName]);
  const replacement = { nodes: [{ id: 'new', type: 'primitive', kind: 'grid', params: { size: 3, subdivisions: 1 } }], output: 'new' };
  const result = await service.execute(session, 'model3d_geometry', { name: 'Shared', graph: replacement }); const after = read(session);
  if (result.isError === true) assertDeepEqual(after, before, 'Shared replacement refusal is atomic');
  else { assert(findObject(after, 'Shared')!.mesh !== originalName, 'Replacement detaches a shared datablock'); assertDeepEqual(after.meshes[originalName], original, 'Other instance retains original vertices'); }
});
h.test('the actual panel mesh channel delivers UV and skin buffers with the document geometry key', async () => {
  const document = read(), result = await invoke('model3d:mesh', { id, name: 'Body' });
  assert(result.positions instanceof Float32Array, 'Typed position payload'); assert(result.uvs instanceof Float32Array, 'Typed UV payload'); assert(result.skinIndices instanceof Uint16Array || result.skinIndices instanceof Uint32Array, 'Typed joint indices'); assert(result.skinWeights instanceof Float32Array, 'Typed weight payload');
  assertEqual(result.geometry_key, geometryKey(document, findObject(document, 'Body')!), 'Panel and document cache keys agree');
  assertEqual((result.uvs as unknown as Float32Array).length, mesh(document, 'Body').uvs!.length, 'All authored UV values delivered');
});
h.test('service GLB export/import and document reload retain the completed character data', async () => {
  const original = read(), path = join(evidence, 'native-character.glb'); await call('model3d_io', { action: 'export', path }); assert(readFileSync(path).readUInt32LE(0) === 0x46546c67, 'Service wrote a real GLB');
  const importedOwner = 'imported-character'; await call('model3d_scene', { action: 'new' }, importedOwner); await call('model3d_io', { action: 'import', path }, importedOwner); const back = read(importedOwner);
  const body = mesh(back, 'Body'), source = mesh(original, 'Body'); near(body.positions!, source.positions!, 'Exported sculpted base surface'); near(body.uvs!, source.uvs!, 'Exported UVs'); near(body.skinWeights!, source.skinWeights!, 'Exported weight paint');
  const skin = back.skins![findObject(back, 'Body')!.skin!]!; near(skin.inverseBindMatrices, original.skins![boundSkin]!.inverseBindMatrices, 'Bind matrices'); assertEqual(findObject(back, 'Tip')!.parent, 'Hip', 'Imported joint parent');
  assertEqual(back.materials.Skin!.baseColorTexture!.texture, 'Paint', 'Imported material texture'); assertEqual(back.textures!.Paint!.dataBase64, original.textures!.Paint!.dataBase64, 'Exact authored PNG bytes'); assertEqual(mesh(back, 'Face').morphTargets![0]!.name, 'Expression', 'Imported morph target');
  const clip = back.clips!['Scene animation']!, rotation = clip.tracks.find(track => track.object === 'Tip')!; near(rotation.times, [0, 1], 'Native frames become clip seconds'); near(rotation.values.slice(4), [0, 0, Math.SQRT1_2, Math.SQRT1_2], 'Exported quaternion keys');
  const documentPath = join(evidence, 'native-character.model3d.json'); await call('model3d_document', { action: 'save', path: documentPath }); const loadedOwner = 'loaded-character'; await call('model3d_scene', { action: 'new' }, loadedOwner); const loadedId = read(loadedOwner).id;
  await call('model3d_document', { action: 'load', path: documentPath }, loadedOwner); const loaded = read(loadedOwner);
  assertEqual(loaded.id, loadedId, 'Load keeps destination document identity'); assertEqual(loaded.sessionId, loadedOwner, 'Load keeps destination owner'); assertDeepEqual(loaded.meshes, original.meshes, 'All mesh attributes and editable graphs survive persistence'); assertDeepEqual(loaded.textures, original.textures, 'Texture persistence'); assertDeepEqual(loaded.skins, original.skins, 'Rig persistence'); assertDeepEqual(findObject(loaded, 'Tip')!.animation, findObject(original, 'Tip')!.animation, 'Native key persistence'); assertEqual(loaded.scene.currentFrame, 13, 'Playhead persistence');
});
h.test('stale saves and invalid or oversized texture imports leave the live document untouched', async () => {
  const stale = read(); await call('model3d_transform', { name: 'Face', location: [0.2, 0.1, 0] }); const current = read();
  const error = await assertRejects(async () => service.store.save(stale, stale.version), 'Stale document is rejected'); assert(/Stale 3D document/.test(String(error)), 'Explicit stale version error'); assertDeepEqual(read(), current, 'Stale save does not overwrite an agent edit');
  const bad = join(evidence, 'invalid.png'); writeFileSync(bad, Buffer.from('not a PNG')); await failUnchanged('model3d_texture', { action: 'import', name: 'Bad', path: bad }, /PNG signature/i);
  const large = join(evidence, 'oversized-file.png'); writeFileSync(large, Buffer.from([137,80,78,71,13,10,26,10])); truncateSync(large, 25 * 1024 * 1024); await failUnchanged('model3d_texture', { action: 'import', name: 'Large', path: large }, /24 MiB/i);
  const huge = encodeTexturePng(1, 1, new Uint8Array([255,255,255,255])); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20);
  let crc = 0xffffffff; for (const byte of huge.subarray(12, 29)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; } huge.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  const hugePath = join(evidence, 'oversized-header.png'); writeFileSync(hugePath, huge); await failUnchanged('model3d_texture', { action: 'import', name: 'Huge', path: hugePath }, /dimensions|pixel limit/i);
});

void h.finish(join(evidence, 'result.json'), 'model3d-production').then(async code => { await service.shutdown(); process.exitCode = code; });
