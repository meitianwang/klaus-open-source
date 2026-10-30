import { join } from 'node:path';
import { Matrix4 } from 'three/src/math/Matrix4.js';
import { bindSkin, createRig, deformSkinnedMesh, evaluateGeometryGraph, meshNormals, poseRig, sampleRigAnimation, sculptMesh, setSkinWeights, unwrapMesh, upsertRigKeyframes, validateGeometryGraph, type AuthoringMesh, type GeometryGraph } from '../main/model3d/authoring';
import { assert, assertEqual, Harness } from './harness';

const h = new Harness();
const close = (a: number, b: number, message: string): void => assert(Math.abs(a - b) < 1e-7, `${message}: ${a} versus ${b}`);
const throws = (fn: () => unknown, match: string): void => {
  let error = ''; try { fn(); } catch (caught) { error = String(caught); }
  assert(error.includes(match), `Expected error containing ${match}, got ${error}`);
};
function grid(): AuthoringMesh {
  const positions: number[] = [], indices: number[] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) positions.push(x - 2, y - 2, 0);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const a = y * 5 + x, b = a + 1, c = a + 5, d = c + 1; indices.push(a, b, c, b, d, c); }
  return { name: 'Grid', primitive: null, primitiveParams: {}, positions, indices, normals: meshNormals(positions, indices), materials: [] };
}
function square(): AuthoringMesh {
  return { name: 'Square', primitive: null, primitiveParams: {}, positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 3], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], materials: ['Paint'], groups: [{ start: 0, count: 6, materialIndex: 0 }] };
}

h.test('draw and inflate deform only vertices inside the finite brush radius', () => {
  for (const brush of ['draw', 'inflate'] as const) {
    const input = grid(), original = JSON.stringify(input);
    const result = sculptMesh(input, [{ brush, point: { x: 0, y: 0, z: 0 }, radius: 0.8, strength: 0.25 }]);
    assertEqual(result.affectedVertices, 1, 'only the central vertex is affected'); close(result.mesh.positions![12 * 3 + 2]!, 0.2, 'central displacement is strength times radius');
    assertEqual(result.mesh.positions![0], -2, 'outer positions stay fixed'); assertEqual(JSON.stringify(input), original, 'source arrays are immutable');
    assert(result.mesh.normals!.every(Number.isFinite), 'normals are recomputed and finite');
  }
});

h.test('smooth averages neighboring geometry, flatten projects to the brush plane, and crease pinches inward', () => {
  const bump = grid(); bump.positions![12 * 3 + 2] = 1;
  const smooth = sculptMesh(bump, [{ brush: 'smooth', point: { x: 0, y: 0, z: 1 }, radius: 0.5, strength: 1 }]);
  close(smooth.mesh.positions![38]!, 0, 'isolated bump moves to neighbor mean');
  const raised = grid(); raised.positions![38] = 0.3;
  const flat = sculptMesh(raised, [{ brush: 'flatten', point: { x: 0, y: 0, z: 0 }, radius: 0.8, strength: 1, normal: { x: 0, y: 0, z: 1 } }]);
  assert(flat.mesh.positions![38]! < 0.3 && flat.mesh.positions![38]! >= 0, 'flatten approaches the plane');
  const crease = sculptMesh(grid(), [{ brush: 'crease', point: { x: 0.5, y: 0, z: 0 }, radius: 0.8, strength: 1, normal: { x: 0, y: 0, z: 1 } }]);
  assert(crease.mesh.positions![36]! > 0 && crease.mesh.positions![38]! < 0, 'crease pinches a nearby vertex tangentially and indents it');
});

h.test('grab translates local vertices with falloff and invalid stroke batches are atomic', () => {
  const input = grid(); const original = JSON.stringify(input);
  const grabbed = sculptMesh(input, [{ brush: 'grab', point: { x: 0, y: 0, z: 0 }, radius: 0.8, strength: 0.5, delta: { x: 2, y: 0, z: 1 } }]);
  close(grabbed.mesh.positions![36]!, 1, 'grab moves the center in x'); close(grabbed.mesh.positions![38]!, 0.5, 'grab moves the center in z');
  throws(() => sculptMesh(input, [{ brush: 'draw', point: { x: 0, y: 0, z: 0 }, radius: 1, strength: 1 }, { brush: 'grab', point: { x: 0, y: 0, z: 0 }, radius: 1, strength: 1 }]), 'explicit delta');
  assertEqual(JSON.stringify(input), original, 'failed strokes do not touch caller arrays');
  throws(() => sculptMesh(input, [{ brush: 'draw', point: { x: NaN, y: 0, z: 0 }, radius: 1, strength: 1 }]), 'finite');
});

h.test('UV seams produce separate atlas islands and duplicate every per-vertex channel', () => {
  const input = square();
  input.colors = Array.from({ length: 12 }, (_, i) => i / 12); input.uvs1 = [0, 0, 1, 0, 1, 1, 0, 1];
  input.skinIndices = Array(16).fill(0); input.skinWeights = Array.from({ length: 16 }, (_, i) => i % 4 === 0 ? 1 : 0);
  input.morphTargets = [{ name: 'Smile', positions: Array.from({ length: 12 }, (_, i) => i / 100) }];
  const original = JSON.stringify(input), result = unwrapMesh(input, { seams: [[0, 2]] });
  assertEqual(result.islands.length, 2, 'the shared diagonal is a chart seam'); assertEqual(result.mesh.positions!.length / 3, 6, 'both diagonal endpoints are duplicated');
  for (let v = 0; v < result.sourceVertexIndices.length; v++) {
    const originalVertex = result.sourceVertexIndices[v]!;
    close(result.mesh.colors![v * 3]!, input.colors[originalVertex * 3]!, 'colors follow seam vertices');
    close(result.mesh.uvs1![v * 2]!, input.uvs1[originalVertex * 2]!, 'second UV channel follows seam vertices');
    close(result.mesh.skinWeights![v * 4]!, 1, 'normalized weights follow seam vertices');
    const morphs = result.mesh.morphTargets as Array<{ positions: number[] }>;
    close(morphs[0]!.positions[v * 3]!, originalVertex * 3 / 100, 'morph deltas follow seam vertices');
  }
  assert(result.mesh.uvs!.every(v => Number.isFinite(v) && v >= 0 && v <= 1), 'the atlas lies within the texture');
  assertEqual(JSON.stringify(result.mesh.groups), JSON.stringify(input.groups), 'material ranges retain face order');
  assertEqual(JSON.stringify(input), original, 'unwrap does not modify the source');
});

h.test('coplanar connected triangles remain one UV island and folded surfaces are charted', () => {
  const flat = unwrapMesh(square()); assertEqual(flat.islands.length, 1, 'a planar quad has one island'); assertEqual(flat.mesh.positions!.length, 12, 'shared vertices are retained within the island');
  const box = evaluateGeometryGraph({ nodes: [{ id: 'box', type: 'primitive', kind: 'cube' }], output: 'box' });
  const mapped = unwrapMesh(box); assertEqual(mapped.islands.length, 6, 'the six box sides become separate charts');
  for (let i = 0; i < mapped.islands.length; i++) for (let j = i + 1; j < mapped.islands.length; j++) {
    const [ax, ay, aw, ah] = mapped.islands[i]!.rect, [bx, by, bw, bh] = mapped.islands[j]!.rect;
    assert(ax + aw <= bx + 1e-12 || bx + bw <= ax + 1e-12 || ay + ah <= by + 1e-12 || by + bh <= ay + 1e-12, 'packed island cells have no interior overlap');
  }
});

h.test('spherical and cylindrical projections avoid non-finite poles and crossing-seam U interpolation', () => {
  const sphere = evaluateGeometryGraph({ nodes: [{ id: 'ball', type: 'primitive', kind: 'uv_sphere', params: { segments: 12, rings: 6 } }], output: 'ball' });
  for (const method of ['spherical', 'cylindrical'] as const) {
    const result = unwrapMesh(sphere, { method, axis: 'y' });
    assert(result.mesh.uvs!.every(v => Number.isFinite(v) && v >= 0 && v <= 1), `${method} has finite packed UVs`);
    assertEqual(result.mesh.indices!.length, sphere.indices!.length, 'projection preserves triangles');
  }
  throws(() => unwrapMesh(square(), { seams: [[0, 999]] }), 'seam vertex');
});

h.test('geometry DAGs transform, mirror, array and subdivide real geometry', () => {
  const graph: GeometryGraph = { nodes: [
    { id: 'plane', type: 'primitive', kind: 'plane', params: { size: 2 } },
    { id: 'move', type: 'transform', input: 'plane', translation: { x: 3, y: 0, z: 0 } },
    { id: 'mirror', type: 'mirror', input: 'move', axis: 'x' },
    { id: 'array', type: 'array', input: 'mirror', count: 2, offset: { x: 0, y: 0, z: 2 } },
    { id: 'sub', type: 'subdivide', input: 'array', iterations: 1 },
  ], output: 'sub' };
  const output = evaluateGeometryGraph(graph); assertEqual(output.indices!.length / 3, 32, 'two planes, two copies, four-way subdivision');
  const xs = output.positions!.filter((_, i) => i % 3 === 0), zs = output.positions!.filter((_, i) => i % 3 === 2);
  assertEqual(Math.min(...xs), -4, 'mirror reflected translated vertices'); assertEqual(Math.max(...xs), 4, 'original translated vertices remain');
  assertEqual(Math.max(...zs), 2, 'array geometry has actual offset vertices'); assertEqual(output.uvs!.length, output.positions!.length / 3 * 2, 'subdivision interpolates UVs');
  const normals = meshNormals(output.positions!, output.indices!); assert(normals.every(Number.isFinite), 'mirror winding and subdivision yield finite normals');
});

h.test('geometry graph validation rejects cycles, missing inputs, oversized arrays and malformed profiles', () => {
  throws(() => validateGeometryGraph({ nodes: [{ id: 'a', type: 'array', input: 'b', count: 1, offset: { x: 0, y: 0, z: 0 } }, { id: 'b', type: 'array', input: 'a', count: 1, offset: { x: 0, y: 0, z: 0 } }], output: 'a' }), 'cycle');
  throws(() => validateGeometryGraph({ nodes: [{ id: 'a', type: 'subdivide', input: 'absent' }], output: 'a' }), 'Missing');
  throws(() => evaluateGeometryGraph({ nodes: [{ id: 'p', type: 'primitive', kind: 'plane' }, { id: 'a', type: 'array', input: 'p', count: 257, offset: { x: 0, y: 0, z: 0 } }], output: 'a' }), 'array count');
  throws(() => evaluateGeometryGraph({ nodes: [{ id: 'x', type: 'profile', profile: [[0, 0], [1, 1], [0, 1], [1, 0]], depth: 2 }], output: 'x' }), 'self-intersect');
  throws(() => evaluateGeometryGraph({ nodes: [{ id: 'p', type: 'primitive', kind: 'plane' }, { id: 's', type: 'transform', input: 'p', scale: { x: 0, y: 1, z: 1 } }], output: 's' }), 'singular');
});

h.test('profile and curved sweep author capped meshes with finite normals and editable UVs', () => {
  const profile: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const node of [{ id: 'extrusion', type: 'profile' as const, profile, depth: 4 }, { id: 'tube', type: 'sweep' as const, profile, path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }, { x: 1, y: 0, z: 4 }] }]) {
    const mesh = evaluateGeometryGraph({ nodes: [node], output: node.id });
    assert(mesh.indices!.length / 3 >= 12, 'sides and both caps have triangles'); assert(mesh.normals!.every(Number.isFinite), 'transported frames produce finite normals'); assertEqual(mesh.uvs!.length, mesh.positions!.length / 3 * 2, 'every vertex has a UV');
    assert(mesh.normals!.some(v => Math.abs(v) > 0.99), 'there are unit cap or side normals');
  }
});

h.test('topology edits protect skin and morph arrays until explicit bake is requested', () => {
  const mesh = square(); mesh.skinIndices = Array(16).fill(0); mesh.skinWeights = Array.from({ length: 16 }, (_, i) => i % 4 === 0 ? 1 : 0); mesh.morphTargets = [{ positions: Array(12).fill(0) }];
  const graph: GeometryGraph = { nodes: [{ id: 'source', type: 'source', mesh }, { id: 'sub', type: 'subdivide', input: 'source' }], output: 'sub' };
  throws(() => evaluateGeometryGraph(graph), 'explicit bakeProtectedAttributes');
  graph.nodes[1] = { id: 'sub', type: 'subdivide', input: 'source', bakeProtectedAttributes: true };
  const result = evaluateGeometryGraph(graph); assertEqual(result.skinWeights, undefined, 'confirmed topology bake removes stale binding'); assertEqual(result.morphTargets, undefined, 'confirmed topology bake removes stale morph deltas'); assertEqual(result.indices!.length / 3, 8, 'subdivision changes triangle topology');
  assertEqual(mesh.skinWeights.length, 16, 'source skin is intact');
});

h.test('rig creation computes inverse world binds through parent transforms', () => {
  const rig = createRig([{ name: 'root', position: { x: 2, y: 0, z: 0 } }, { name: 'tip', parent: 'root', position: { x: 0, y: 1, z: 0 } }]);
  assertEqual(rig.objects[1]!.parent, 'root', 'joint hierarchy is retained'); close(rig.jointWorldMatrices[1]![12]!, 2, 'child inherits root x'); close(rig.jointWorldMatrices[1]![13]!, 1, 'child local y is applied');
  for (let i = 0; i < 2; i++) {
    const identity = new Matrix4().fromArray(rig.jointWorldMatrices[i]!).multiply(new Matrix4().fromArray(rig.skin.inverseBindMatrices.slice(i * 16, i * 16 + 16))).toArray();
    identity.forEach((value, c) => close(value, c % 5 === 0 ? 1 : 0, 'world times inverse bind is identity'));
  }
  throws(() => createRig([{ name: 'a', parent: 'b' }, { name: 'b', parent: 'a' }]), 'cycle');
});

h.test('automatic binding has normalized four-slot weights and rest deformation preserves vertices', () => {
  const mesh = square(), rig = createRig([{ name: 'root' }, { name: 'tip', parent: 'root', position: { x: 0, y: 1, z: 0 } }]);
  const bound = bindSkin(mesh, rig), boundRig = { ...rig, skin: bound.skin };
  for (let v = 0; v < 4; v++) close(bound.mesh.skinWeights!.slice(v * 4, v * 4 + 4).reduce((a, b) => a + b, 0), 1, 'weights sum to one');
  const rest = deformSkinnedMesh(bound.mesh, boundRig); rest.positions!.forEach((value, i) => close(value, mesh.positions![i]!, 'rest pose retains source positions'));
  assertEqual(mesh.skinWeights, undefined, 'binding does not mutate source mesh');
});

h.test('joint posing deforms weighted geometry without object scaling and retains inverse binds', () => {
  const rig = createRig([{ name: 'root' }, { name: 'tip', parent: 'root', position: { x: 0, y: 1, z: 0 } }]);
  const bound = bindSkin(square(), rig), edited = setSkinWeights(bound.mesh, [{ vertex: 1, indices: [0], weights: [3] }], 2);
  const posed = poseRig({ ...rig, skin: bound.skin }, [{ bone: 'root', rotationEuler: { x: 0, y: 0, z: Math.PI / 2 } }]);
  const deformed = deformSkinnedMesh(edited.mesh, posed); close(deformed.positions![3]!, 0, 'x rotates to zero'); close(deformed.positions![4]!, 1, 'x rotates into y');
  assertEqual(JSON.stringify(posed.skin.inverseBindMatrices), JSON.stringify(bound.skin.inverseBindMatrices), 'posing preserves rest binds'); assertEqual(posed.objects[0]!.transform.scale.x, 1, 'joint deformation keeps unit object scale');
  close(posed.jointWorldMatrices[1]![12]!, -1, 'joint hierarchy follows parent rotation');
});

h.test('skin binding handles a transformed mesh rest frame and manual weights reject bad joint references', () => {
  const mesh = square(), rig = createRig([{ name: 'root' }]), world = new Matrix4().makeTranslation(5, 2, 0).toArray();
  const bound = bindSkin(mesh, rig, { meshWorldMatrix: world }), boundRig = { ...rig, skin: bound.skin };
  const rest = deformSkinnedMesh(bound.mesh, boundRig, { meshWorldMatrix: world }); rest.positions!.forEach((v, i) => close(v, mesh.positions![i]!, 'mesh-local rest frame is retained'));
  const posed = poseRig(boundRig, [{ bone: 'root', translation: { x: 1, y: 0, z: 0 } }]); close(deformSkinnedMesh(bound.mesh, posed, { meshWorldMatrix: world }).positions![0]!, 1, 'world joint translation reaches mesh-local vertices');
  throws(() => setSkinWeights(bound.mesh, [{ vertex: 0, indices: [2], weights: [1] }], 1), 'joint index');
});

h.test('joint animation keys are sorted, replace existing times, interpolate translations and slerp rotations', () => {
  const rig = createRig([{ name: 'root' }]);
  let tracks = upsertRigKeyframes(rig, [], [
    { object: 'root', path: 'translation', time: 1, value: [2, 0, 0] },
    { object: 'root', path: 'translation', time: 0, value: [0, 0, 0] },
    { object: 'root', path: 'rotation', time: 0, value: [0, 0, 0, 1] },
    { object: 'root', path: 'rotation', time: 1, value: [0, 0, 1, 0] },
  ]);
  close(sampleRigAnimation(rig, tracks, 0.5).objects[0]!.transform.location.x, 1, 'translation interpolates');
  const middle = sampleRigAnimation(rig, tracks, 0.5); close(middle.jointWorldMatrices[0]![0]!, 0, 'half rotation is ninety degrees'); close(middle.jointWorldMatrices[0]![1]!, 1, 'half rotation is proper quaternion slerp');
  tracks = upsertRigKeyframes(rig, tracks, [{ object: 'root', path: 'translation', time: 1, value: [4, 0, 0], interpolation: 'STEP' }]);
  assertEqual(tracks[0]!.times.length, 2, 'replacing a time adds no duplicate'); close(sampleRigAnimation(rig, tracks, 0.5).objects[0]!.transform.location.x, 0, 'step interpolation retains earlier key');
});

void h.finish(join(__dirname, 'model3d-authoring-result.json'), 'model3d-authoring').then(code => { process.exitCode = code; });
