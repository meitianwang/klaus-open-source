import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { exportDocumentGlb, exportGlb, importGltf, importGltfScene, mergeImported, transformGeometry } from '../main/model3d/io';
import { emptyDocument, parseDocument, geometryKey, serializeDocument, type Model3DDocument } from '../main/model3d/model';
import { composeTransform, convertAxisMatrix, identityMatrix, invertMatrix, multiplyMatrices, quaternionFromEuler, worldMatrixOf } from '../main/model3d/scene-math';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness();
const evidence = join(__dirname, '..', 'model3d-gltf-logs');
const root = join(evidence, 'fixture-source');
mkdirSync(root, { recursive: true });
function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type), content = Buffer.concat([name, data]); let crc = 0xffffffff;
  for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  const header = Buffer.alloc(4), footer = Buffer.alloc(4); header.writeUInt32BE(data.length); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, content, footer]);
}
const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(1); pngHeader.writeUInt32BE(1, 4); pngHeader[8] = 8; pngHeader[9] = 6;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', pngHeader), pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
const near = (actual: number[], expected: number[], label: string): void => {
  assertEqual(actual.length, expected.length, `${label} length`);
  actual.forEach((value, i) => assert(Math.abs(value - expected[i]!) < 1e-5, `${label}[${i}] expected ${expected[i]}, got ${value}`));
};

/** A real two-buffer fixture with interleaved vertices and sparse morph data. */
function fixture(): { json: any; buffers: Buffer[] } {
  const parts: Buffer[][] = [[], []], lengths = [0, 0], views: any[] = [], accessors: any[] = [];
  const addView = (bytes: Buffer, buffer = 0, byteStride?: number): number => {
    const pad = (4 - lengths[buffer]! % 4) % 4; if (pad) { parts[buffer]!.push(Buffer.alloc(pad)); lengths[buffer]! += pad; }
    const index = views.length; views.push({ buffer, byteOffset: lengths[buffer], byteLength: bytes.length, ...(byteStride ? { byteStride } : {}) });
    parts[buffer]!.push(bytes); lengths[buffer]! += bytes.length; return index;
  };
  const bytesOf = (values: number[], kind = 5126): Buffer => {
    const stride = kind === 5126 ? 4 : kind === 5123 ? 2 : 1, bytes = Buffer.alloc(values.length * stride);
    values.forEach((value, i) => { if (kind === 5126) bytes.writeFloatLE(value, i * stride); else if (kind === 5123) bytes.writeUInt16LE(value, i * stride); else bytes.writeUInt8(value, i); }); return bytes;
  };
  const addAccessor = (values: number[], width: number, type: string, buffer = 0, kind = 5126, normalized = false): number => {
    const index = accessors.length; accessors.push({ bufferView: addView(bytesOf(values, kind), buffer), componentType: kind, count: values.length / width, type, ...(normalized ? { normalized: true } : {}) }); return index;
  };
  const points = [-1, 0, 0, 1, 0, 0, 0, 1, 0, -1, 1, 0, 1, 1, 0, 0, 2, 0];
  const vertices: number[] = [];
  for (let v = 0; v < 6; v++) vertices.push(...points.slice(v * 3, v * 3 + 3), 0, 0, 1, v % 2, Math.floor(v / 2) / 2);
  const interleaved = addView(bytesOf(vertices), 0, 32);
  const position = accessors.length; accessors.push({ bufferView: interleaved, componentType: 5126, count: 6, type: 'VEC3' });
  const normal = accessors.length; accessors.push({ bufferView: interleaved, byteOffset: 12, componentType: 5126, count: 6, type: 'VEC3' });
  const uv = accessors.length; accessors.push({ bufferView: interleaved, byteOffset: 24, componentType: 5126, count: 6, type: 'VEC2' });
  const joints = addAccessor(Array.from({ length: 24 }, (_, i) => i >= 12 && i % 4 === 0 ? 1 : 0), 4, 'VEC4', 1, 5121);
  const weights = addAccessor(Array.from({ length: 24 }, (_, i) => i % 4 === 0 ? 255 : 0), 4, 'VEC4', 1, 5121, true);
  const firstIndices = addAccessor([0, 1, 2], 1, 'SCALAR', 0, 5123), secondIndices = addAccessor([3, 4, 5], 1, 'SCALAR', 0, 5123);
  const sparseIndexView = addView(bytesOf([4], 5123)), sparseDeltaView = addView(bytesOf([0, 0, 0.25]), 1);
  const morph = accessors.length; accessors.push({ componentType: 5126, count: 6, type: 'VEC3', sparse: { count: 1, indices: { bufferView: sparseIndexView, componentType: 5123 }, values: { bufferView: sparseDeltaView } } });
  const ib0 = identityMatrix(), ib1 = identityMatrix(); ib0[13] = -0.5; ib1[13] = -1.5;
  const bind = addAccessor([...ib0, ...ib1], 16, 'MAT4', 1);
  const times = addAccessor([0, 1], 1, 'SCALAR', 1);
  const rotation = addAccessor([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2], 4, 'VEC4', 1);
  const translation = addAccessor([0.2, 0, 0, 0, 0, 0, 0.2, 0, 0, 0.2, 0, 0, 0, 1, 0, 0.2, 0, 0], 3, 'VEC3', 1);
  const scale = addAccessor([2, 1, 0.5, 1, 2, 3], 3, 'VEC3', 1), morphWeights = addAccessor([0, 1], 1, 'SCALAR', 1);
  const attrs = { POSITION: position, NORMAL: normal, TEXCOORD_0: uv, JOINTS_0: joints, WEIGHTS_0: weights };
  const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], buffers: [{ byteLength: lengths[0], uri: 'mesh.bin' }, { byteLength: lengths[1], uri: 'rig.bin' }], bufferViews: views, accessors,
    images: [{ uri: 'texture.png', mimeType: 'image/png' }], samplers: [{ magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33648 }, { magFilter: 9729, wrapS: 10497, wrapT: 10497 }], textures: [{ name: 'Paint', source: 0, sampler: 0 }, { name: 'Detail', source: 0, sampler: 1 }],
    extensionsRequired: ['KHR_texture_transform', 'KHR_materials_emissive_strength'],
    materials: [{ name: 'Painted', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.2, 0.1, 0.6], metallicFactor: 0.2, roughnessFactor: 0.7, baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0.2, 0.3], scale: [0.5, 0.75], rotation: 0.1 } } }, metallicRoughnessTexture: { index: 0 } }, normalTexture: { index: 1, scale: 0.4 }, occlusionTexture: { index: 0, strength: 0.6 }, emissiveTexture: { index: 1 }, emissiveFactor: [0.2, 0.3, 0.4], extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2.5 } }, alphaMode: 'BLEND', doubleSided: true }, { name: 'Accent', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.3, 0.9, 1], metallicFactor: 0, roughnessFactor: 0 }, alphaMode: 'MASK', alphaCutoff: 0 }],
    meshes: [{ name: 'Character', weights: [0.25], extras: { targetNames: ['Smile'] }, primitives: [{ attributes: attrs, indices: firstIndices, material: 0, targets: [{ POSITION: morph }] }, { attributes: attrs, indices: secondIndices, material: 1, targets: [{ POSITION: morph }] }] }],
    nodes: [{ name: 'Root', translation: [1, 2, 3], rotation: [0, 0, Math.sin(0.2), Math.cos(0.2)], scale: [2, 1, 0.5], children: [1, 3, 4] }, { name: 'Hip', translation: [0, 0.5, 0], children: [2] }, { name: 'Tip', translation: [0, 1, 0] }, { name: 'Body', mesh: 0, skin: 0, weights: [0.4] }, { name: 'BodyInstance', mesh: 0, skin: 0, translation: [3, 0, 0] }],
    skins: [{ name: 'Rig', joints: [1, 2], skeleton: 1, inverseBindMatrices: bind }], animations: [{ name: 'Motion', samplers: [{ input: times, output: rotation }, { input: times, output: translation, interpolation: 'CUBICSPLINE' }, { input: times, output: scale, interpolation: 'STEP' }, { input: times, output: morphWeights }], channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }, { sampler: 1, target: { node: 3, path: 'translation' } }, { sampler: 2, target: { node: 0, path: 'scale' } }, { sampler: 3, target: { node: 3, path: 'weights' } }] }] };
  return { json, buffers: parts.map(chunks => Buffer.concat(chunks)) };
}
const source = fixture();
writeFileSync(join(root, 'mesh.bin'), source.buffers[0]!); writeFileSync(join(root, 'rig.bin'), source.buffers[1]!); writeFileSync(join(root, 'texture.png'), PNG);
writeFileSync(join(root, 'character.gltf'), JSON.stringify(source.json));
let doc: Model3DDocument;
let negativeIndex = 0;
const rejectFixture = async (mutate: (json: any) => void, expected: RegExp): Promise<void> => {
  const json = structuredClone(source.json); mutate(json); const path = join(root, `reject-${negativeIndex++}.gltf`); writeFileSync(path, JSON.stringify(json));
  const error = await assertRejects(() => importGltf(path), 'Invalid fixture must be rejected'); assert(expected.test(String(error)), `Expected ${expected}, got ${String(error)}`);
};

h.test('rich multi-buffer import preserves shared geometry, UVs and sparse morph deltas', async () => {
  const imported = await importGltf(join(root, 'character.gltf')); assertEqual(imported.length, 1, 'One mesh datablock'); assert(imported.scene, 'Rich scene payload');
  doc = emptyDocument('fixture', 'Character', 'session'); mergeImported(doc, imported, 'fixture');
  const mesh = doc.meshes.Character!; assertEqual(mesh.positions!.length, 18, 'Shared accessor vertices are not duplicated per primitive');
  assertDeepEqual(mesh.indices, [0, 1, 2, 3, 4, 5], 'Triangle groups'); assertEqual(mesh.groups!.length, 2, 'Two material slots');
  near(mesh.positions!.slice(6, 9), [0, 0, 1], 'File positive Y stands at document positive Z'); near(mesh.normals!.slice(0, 3), [0, -1, 0], 'Normals use document basis');
  near(mesh.uvs!.slice(0, 6), [0, 0, 1, 0, 0, 0.5], 'Interleaved UVs'); assertEqual(mesh.skinWeights![0], 1, 'Normalized byte weights');
  near(mesh.morphTargets![0]!.positions!.slice(12, 15), [0, -0.25, 0], 'Sparse delta converted as a vector');
});
h.test('parent hierarchy, instancing and bind pose survive import', () => {
  const objects = Object.fromEntries(doc.objects.map(o => [o.name, o])); assertEqual(objects.Tip!.parent, 'Hip', 'Joint parent'); assert(objects.Hip!.joint && objects.Tip!.joint, 'Bones flagged');
  assertEqual(objects.Body!.mesh, objects.BodyInstance!.mesh, 'Two instances share one datablock'); near([objects.Root!.transform.location.x, objects.Root!.transform.location.y, objects.Root!.transform.location.z], [1, -3, 2], 'Root transform axis');
  const rig = doc.skins!.Rig!; near(rig.inverseBindMatrices.slice(12, 15), [0, 0, -0.5], 'Inverse bind translation');
  const rootInverse = invertMatrix(worldMatrixOf(doc, 'Root'));
  for (let i = 0; i < rig.joints.length; i++) near(multiplyMatrices(multiplyMatrices(rootInverse, worldMatrixOf(doc, rig.joints[i]!)), rig.inverseBindMatrices.slice(i * 16, i * 16 + 16)), identityMatrix(), 'Rest skin palette');
});
h.test('PNG texture, PBR slots, texture transforms and alpha modes survive import', () => {
  const material = doc.materials.Painted!; assertEqual(Object.keys(doc.textures!).length, 2, 'Different samplers preserved'); assertEqual(doc.textures!.Paint!.dataBase64, PNG.toString('base64'), 'Exact image bytes');
  assertDeepEqual(doc.textures!.Paint!.sampler, source.json.samplers[0], 'Sampler'); assertDeepEqual(material.baseColorTexture!.transform, { offset: [0.2, 0.3], scale: [0.5, 0.75], rotation: 0.1 }, 'Texture transform');
  assertEqual(material.normalTexture!.scale, 0.4, 'Normal intensity'); assertEqual(material.emissiveStrength, 2.5, 'Emissive strength'); assertEqual(material.alphaMode, 'BLEND', 'Alpha mode'); assertEqual(material.doubleSided, true, 'Two-sided');
  assertEqual(doc.materials.Accent!.roughness, 0, 'Zero roughness preserved'); assertEqual(doc.materials.Accent!.alphaCutoff, 0, 'Zero cutoff preserved');
});
h.test('quaternion, cubic translation, step scale and morph animation are preserved', () => {
  const tracks = doc.clips!.Motion!.tracks; assertEqual(tracks.length, 4, 'Clip channels');
  near(tracks.find(t => t.path === 'rotation')!.values, [0, 0, 0, 1, 0, -Math.SQRT1_2, 0, Math.SQRT1_2], 'Quaternion conjugation');
  const cubic = tracks.find(t => t.path === 'translation')!; assertEqual(cubic.interpolation, 'CUBICSPLINE', 'Cubic interpolation'); near(cubic.values.slice(12, 15), [0, 0, 1], 'Cubic key value'); near(cubic.values.slice(0, 3), [0.2, 0, 0], 'Cubic tangent');
  near(tracks.find(t => t.path === 'scale')!.values, [2, 0.5, 1, 1, 3, 2], 'Scale axis'); assertEqual(tracks.find(t => t.path === 'scale')!.interpolation, 'STEP', 'Step interpolation'); near(tracks.find(t => t.path === 'weights')!.values, [0, 1], 'Morph weights');
});
h.test('sampled joint animation and a morph target deform a bound character vertex', () => {
  const pose = parseDocument(doc), tip = pose.objects.find(object => object.name === 'Tip')!;
  tip.transform.rotationQuaternion = pose.clips!.Motion!.tracks.find(track => track.path === 'rotation')!.values.slice(4, 8);
  const palette = multiplyMatrices(multiplyMatrices(invertMatrix(worldMatrixOf(pose, 'Root')), worldMatrixOf(pose, 'Tip')), pose.skins!.Rig!.inverseBindMatrices.slice(16, 32));
  const base = pose.meshes.Character!.positions!.slice(12, 15), delta = pose.meshes.Character!.morphTargets![0]!.positions!.slice(12, 15), morphed = base.map((value, i) => value + delta[i]!);
  const deformed = [0, 1, 2].map(axis => palette[axis]! * morphed[0]! + palette[4 + axis]! * morphed[1]! + palette[8 + axis]! * morphed[2]! + palette[12 + axis]!);
  near(deformed, [0.5, -0.25, 2.5], 'Quarter-turn joint motion and full morph');
});
h.test('real GLB and embedded glTF round trips retain rigs, textures, instances and clips', async () => {
  for (const extension of ['glb', 'gltf']) {
    const path = join(evidence, `character-roundtrip.${extension}`); const bytes = await exportDocumentGlb(path, doc); assert(bytes > 1000, 'A complete binary asset was written');
    const scene = await importGltfScene(path); const back = parseDocument({ ...doc, ...scene });
    for (const field of ['positions', 'normals', 'uvs', 'skinWeights'] as const) near(back.meshes.Character![field]!, doc.meshes.Character![field]!, `${extension} ${field}`);
    assertDeepEqual(back.meshes.Character!.indices, doc.meshes.Character!.indices, 'Indices'); assertEqual(back.meshes.Character!.positions!.length, 18, 'Shared multi-primitive vertices remain bounded');
    near(back.meshes.Character!.morphTargets![0]!.positions!, doc.meshes.Character!.morphTargets![0]!.positions!, 'Morph deltas'); near(back.skins!.Rig!.inverseBindMatrices, doc.skins!.Rig!.inverseBindMatrices, 'Bind matrices');
    assertDeepEqual(back.textures, doc.textures, 'Texture bytes and samplers'); assertDeepEqual(back.materials, doc.materials, 'PBR fields');
    assertEqual(back.objects.find(o => o.name === 'Body')!.mesh, back.objects.find(o => o.name === 'BodyInstance')!.mesh, 'Instance references');
    for (let i = 0; i < doc.clips!.Motion!.tracks.length; i++) { const a = back.clips!.Motion!.tracks[i]!, b = doc.clips!.Motion!.tracks[i]!; assertEqual(a.interpolation, b.interpolation, 'Interpolation'); near(a.values, b.values, 'Clip output'); }
    near(worldMatrixOf(back, 'BodyInstance'), worldMatrixOf(doc, 'BodyInstance'), 'World placement');
  }
});
h.test('selection closes over ancestors and skin dependencies without flattening', async () => {
  const path = join(evidence, 'character-selected.glb'); await exportDocumentGlb(path, doc, { objects: ['Body'] }); const scene = await importGltfScene(path);
  assertDeepEqual(scene.objects.map(o => o.name), ['Root', 'Hip', 'Tip', 'Body'], 'Ancestor and skeleton closure'); assertEqual(Object.keys(scene.skins!).length, 1, 'Skin exported');
  assertEqual(scene.objects.find(o => o.name === 'Body')!.parent, 'Root', 'Parent retained'); assertEqual(scene.clips!.Motion!.tracks.length, 4, 'Relevant rig and ancestor animation retained');
});
h.test('native frame channels export as a rigged clip with sampled XYZ rotations', async () => {
  const next = parseDocument(doc); next.scene.frameStart = 10; next.scene.fps = 2; next.scene.currentFrame = 11; next.scene.activeClip = 'Motion';
  next.objects.find(object => object.name === 'Body')!.animation = {
    location: [{ frame: 10, value: [0, 0, 0] }, { frame: 12, value: [0, 0, 1] }],
    scale: [{ frame: 10, value: [1, 1, 1] }, { frame: 12, value: [2, 3, 4] }],
    morph_weights: [{ frame: 10, value: [0] }, { frame: 12, value: [1] }],
  };
  next.objects.find(object => object.name === 'Tip')!.animation = { rotation_euler: [{ frame: 10, value: [0, 0, 0] }, { frame: 12, value: [0.4, 0.3, 0.2] }] };
  next.objects.find(object => object.name === 'Hip')!.animation = { rotation_quaternion: [{ frame: 10, value: [0, 0, 0, 1] }, { frame: 12, value: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }] };
  const persisted = parseDocument(next); const view = serializeDocument(persisted) as any; assertEqual(view.scene.currentFrame, 11, 'Current frame'); assertEqual(view.scene.activeClip, 'Motion', 'Active clip'); assertEqual(view.objects.find((object: any) => object.name === 'Tip').animation.rotation_euler.length, 2, 'Native keys exposed');
  const path = join(evidence, 'character-native-animation.glb'); await exportDocumentGlb(path, next); const back = await importGltfScene(path);
  const native = back.clips!['Scene animation']!; assertEqual(native.tracks.length, 5, 'All native channel kinds');
  const rotation = native.tracks.find(track => track.object === 'Tip' && track.path === 'rotation')!; near(rotation.times, [0, 0.5, 1], 'Scene start and FPS time origin'); near(rotation.values.slice(4, 8), quaternionFromEuler(0.2, 0.15, 0.1), 'Sampled multi-axis pose');
  near(native.tracks.find(track => track.object === 'Hip')!.values.slice(4), [0, 0, Math.SQRT1_2, Math.SQRT1_2], 'Native quaternion channel');
  near(native.tracks.find(track => track.path === 'weights')!.values, [0, 1], 'Native morph weights'); assert(back.clips!.Motion, 'Imported clip retained alongside native clip');
  const invalid = parseDocument(next); invalid.objects.find(object => object.name === 'Hip')!.animation!.rotation_euler = [{ frame: 10, value: [0, 0, 0] }];
  const error = await assertRejects(() => exportDocumentGlb(join(evidence, 'invalid-native.glb'), invalid), 'Conflicting channels refused'); assert(/conflicting native rotation/.test(String(error)), 'Explicit ambiguous channel error');
});
h.test('merge collisions remap independent materials, parents, bones and clip targets', async () => {
  const next = parseDocument(doc); const names = mergeImported(next, await importGltf(join(root, 'character.gltf')), 'second fixture');
  assert(names.includes('Root.001'), 'Unique root'); assertEqual(next.objects.find(o => o.name === 'Body.001')!.parent, 'Root.001', 'Remapped parent');
  assertEqual(next.objects.find(o => o.name === 'Body.001')!.skin, 'Rig.001', 'Remapped skin'); assertDeepEqual(next.skins!['Rig.001']!.joints, ['Hip.001', 'Tip.001'], 'Remapped bones');
  assertEqual(next.clips!['Motion.001']!.tracks[0]!.object, 'Tip.001', 'Remapped clip'); assertEqual(next.materials['Painted.001']!.baseColorTexture!.texture, 'Paint.001', 'Remapped texture');
  next.materials['Painted.001']!.roughness = 0.25; assertEqual(next.materials.Painted!.roughness, 0.7, 'Independent material maps');
});
h.test('matrix node shear and intrinsic XYZ geometry transforms round trip exactly', async () => {
  const local = emptyDocument('matrix', 'Matrix', 'session'); local.meshes.Character = structuredClone(doc.meshes.Character!); local.meshes.Character!.skinIndices = undefined; local.meshes.Character!.skinWeights = undefined; local.meshes.Character!.materials = []; local.meshes.Character!.groups = undefined;
  const matrix = identityMatrix(); matrix[4] = 0.25; matrix[0] = -2; matrix[12] = 3;
  local.objects.push({ name: 'Sheared', mesh: 'Character', type: 'MESH', transform: { location: { x: 3, y: 0, z: 0 }, rotationEuler: { x: 0, y: 0, z: 0 }, scale: { x: -2, y: 1, z: 1 }, matrix }, visible: true, modifiers: [] });
  const path = join(evidence, 'matrix.glb'); await exportDocumentGlb(path, local); const scene = await importGltfScene(path); near(scene.objects[0]!.transform.matrix!, matrix, 'Exact shear matrix');
  near(convertAxisMatrix(convertAxisMatrix(matrix, true), false), matrix, 'Matrix basis inverse');
  const transform = { location: [0, 0, 0], rotation_euler: [Math.PI / 2, Math.PI / 2, 0], scale: [2, 3, 4] };
  const baked = transformGeometry(new Float32Array([1, 0, 0]), new Float32Array([1, 0, 0]), transform); near(Array.from(baked.positions), [0, 2, 0], 'XYZ applies Z, Y, X'); near(Array.from(baked.normals), [0, 1, 0], 'Normal inverse transpose');
});
h.test('accessor bounds, normalization, missing references and required features fail explicitly', async () => {
  await rejectFixture(j => { j.bufferViews[0].byteStride = 10; }, /stride/i);
  await rejectFixture(j => { j.accessors[0].count = 16000001; }, /count|limit/i);
  await rejectFixture(j => { j.accessors[0].byteOffset = 184; }, /outside/i);
  await rejectFixture(j => { j.accessors[3].normalized = true; }, /normalized/i);
  await rejectFixture(j => { j.skins[0].joints = [1, 99]; }, /joint.*missing/i);
  await rejectFixture(j => { j.nodes[0].children.push(3); }, /multiple parents/i);
  await rejectFixture(j => { j.extensionsRequired = ['KHR_draco_mesh_compression']; }, /unsupported extensions/i);
  await rejectFixture(j => { j.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} }; }, /Unsupported.*extension/i);
  await rejectFixture(j => { j.meshes[0].primitives[0].targets[0].TANGENT = 0; }, /morph attribute/i);
  await rejectFixture(j => { j.animations[0].channels[0].target.path = 'unsupported'; }, /animation path/i);
});
h.test('network resources, path traversal, symlink escape and oversized image dimensions are refused', async () => {
  await rejectFixture(j => { j.buffers[0].uri = 'https://example.invalid/mesh.bin'; }, /local relative/i);
  await rejectFixture(j => { j.buffers[0].uri = '../outside.bin'; }, /escapes/i);
  await rejectFixture(j => { j.buffers[0].uri = '%2e%2e/outside.bin'; }, /escapes/i);
  writeFileSync(join(evidence, 'outside.bin'), source.buffers[0]!);
  try { symlinkSync(join(evidence, 'outside.bin'), join(root, 'escape.bin')); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  await rejectFixture(j => { j.buffers[0].uri = 'escape.bin'; }, /symlink escapes/i);
  const hugeHeader = Buffer.from(pngHeader); hugeHeader.writeUInt32BE(20000); const oversized = Buffer.concat([PNG.subarray(0, 8), pngChunk('IHDR', hugeHeader), PNG.subarray(33)]); writeFileSync(join(root, 'oversized.png'), oversized);
  await rejectFixture(j => { j.images[0].uri = 'oversized.png'; }, /pixel limit/i);
  await rejectFixture(j => { j.images[0].uri = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`; j.images[0].mimeType = 'image/svg+xml'; }, /Unsupported.*MIME/i);
});
h.test('untrusted document parsing and content hashes preserve values and detect same-size edits', () => {
  const next = parseDocument(doc); const body = next.objects.find(o => o.name === 'Body')!; const original = geometryKey(next, body);
  next.meshes.Character!.positions![0]! += 0.125; assert(geometryKey(next, body) !== original, 'Position content invalidates'); const changed = geometryKey(next, body);
  next.meshes.Character!.uvs![0]! += 0.1; assert(geometryKey(next, body) !== changed, 'UV content invalidates');
  body.modifiers.push({ id: 'boolean', type: 'boolean', label: 'Boolean', enabled: true, params: { object: 'BodyInstance', operation: 'union' } }); const dependency = geometryKey(next, body);
  next.objects.find(o => o.name === 'BodyInstance')!.transform.location.x += 1; assert(geometryKey(next, body) !== dependency, 'Operand placement invalidates');
  const graph = { nodes: [{ id: 'seed', type: 'mesh' }], output: 'seed' }; next.meshes.Character!.geometryGraph = graph; next.scene.renderEngine = 'pathtrace'; next.scene.renderSamples = 4; next.scene.renderBounces = 2;
  const parsed = parseDocument(next); assertDeepEqual(parsed.meshes.Character!.geometryGraph, graph, 'Graph persistence'); assertEqual(parsed.scene.renderSamples, 4, 'Render settings persistence');
  const view = serializeDocument(parsed) as any; assert(!('positions' in view.meshes.Character), 'Scene refresh does not send vertex buffers'); assertEqual(view.objects.find((o: any) => o.name === 'Body').materials.length, 2, 'All material slots exposed'); assertEqual(view.clips.Motion.tracks.length, 4, 'Clip data exposed');
  const malformed = structuredClone(doc); malformed.meshes.Character!.uvs![0] = NaN; let failed = false; try { parseDocument(malformed); } catch { failed = true; } assert(failed, 'Non-finite data is rejected, not filtered');
});
h.test('legacy geometry export/import API remains compatible and GLB byte lengths use UTF-8', async () => {
  const path = join(evidence, 'legacy.glb'); await exportGlb(path, [{ name: '龙', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), normals: new Float32Array(), indices: new Uint32Array([0, 1, 2]) }]);
  const bytes = readFileSync(path); assertEqual(bytes.readUInt32LE(8), bytes.length, 'Exact container size'); assertEqual(bytes.readUInt32LE(12) % 4, 0, 'UTF-8 JSON chunk aligned');
  const back = await importGltf(path); near(back[0]!.positions, [0, 0, 0, 1, 0, 0, 0, 0, 1], 'Legacy roundtrip');
  const malformed = Buffer.from(bytes); malformed.writeUInt32LE(bytes.length - 4, 8); const bad = join(evidence, 'bad-length.glb'); writeFileSync(bad, malformed); const error = await assertRejects(() => importGltf(bad), 'Header length rejected'); assert(/declared length/.test(String(error)), 'Header error is explicit');
});

void h.finish(join(evidence, 'result.json'), 'model3d-gltf').then(code => { process.exitCode = code; });
