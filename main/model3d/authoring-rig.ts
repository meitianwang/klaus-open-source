import { Euler } from 'three/src/math/Euler.js';
import { Matrix3 } from 'three/src/math/Matrix3.js';
import { Matrix4 } from 'three/src/math/Matrix4.js';
import { Quaternion } from 'three/src/math/Quaternion.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import type { Object3DRecord, Vec3 } from './model';
import { boundedInteger, cloneMesh, customMesh, finite, finiteVec, validateAuthoringMesh, type AuthoringMesh } from './authoring-mesh';

export interface BoneSpec { name: string; parent?: string; position?: Vec3; rotationEuler?: Vec3; rotationQuaternion?: number[]; scale?: Vec3 }
export type RigObject = Object3DRecord & { parent?: string; joint?: boolean; transform: Object3DRecord['transform'] & { rotationQuaternion?: number[]; matrix?: number[] } };
export interface RigSkin { name: string; joints: string[]; inverseBindMatrices: number[]; skeleton?: string }
export interface RigBuild { objects: RigObject[]; skin: RigSkin; jointWorldMatrices: number[][] }
export interface RigPose { bone: string; translation?: Vec3; rotationEuler?: Vec3; rotationQuaternion?: number[]; scale?: Vec3 }
export interface BindOptions { maxInfluences?: number; falloff?: number; meshWorldMatrix?: number[] }
export interface RigAnimationTrack { object: string; path: 'translation' | 'rotation' | 'scale'; times: number[]; values: number[]; interpolation: 'LINEAR' | 'STEP' }
export interface RigKeyframe { object: string; path: RigAnimationTrack['path']; time: number; value: number[]; interpolation?: RigAnimationTrack['interpolation'] }

function matrixFromArray(value: number[], label: string): Matrix4 {
  if (!Array.isArray(value) || value.length !== 16 || !value.every(Number.isFinite)) throw new Error(`${label} must contain sixteen finite values`);
  const matrix = new Matrix4().fromArray(value);
  if (!Number.isFinite(matrix.determinant()) || Math.abs(matrix.determinant()) < 1e-12) throw new Error(`${label} must have a finite, invertible determinant`);
  return matrix;
}
function quaternion(value: number[], label: string): Quaternion {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) throw new Error(`${label} must contain four finite values`);
  const q = new Quaternion(...value as [number, number, number, number]);
  if (q.lengthSq() < 1e-12) throw new Error(`${label} cannot be zero`);
  return q.normalize();
}
function objectMatrix(object: RigObject): Matrix4 {
  if (object.transform.matrix) return matrixFromArray(object.transform.matrix, `${object.name} local matrix`);
  const location = finiteVec(object.transform.location, 'joint location'), rotation = finiteVec(object.transform.rotationEuler, 'joint rotation'), scale = finiteVec(object.transform.scale, 'joint scale');
  const q = object.transform.rotationQuaternion ? quaternion(object.transform.rotationQuaternion, 'joint quaternion') : new Quaternion().setFromEuler(new Euler(rotation.x, rotation.y, rotation.z, 'XYZ'));
  const matrix = new Matrix4().compose(new Vector3(location.x, location.y, location.z), q, new Vector3(scale.x, scale.y, scale.z));
  if (!Number.isFinite(matrix.determinant()) || Math.abs(matrix.determinant()) < 1e-12) throw new Error('Joint scale must have a finite, invertible determinant');
  return matrix;
}

/** Parent transforms may belong to non-joint scene objects. */
export function rigFromObjects(skin: RigSkin, objects: readonly RigObject[]): RigBuild {
  boundedInteger(objects.length, 1, 4096, 'rig scene object count');
  boundedInteger(skin.joints.length, 1, 256, 'joint count');
  if (new Set(skin.joints).size !== skin.joints.length) throw new Error('Skin joint names must be unique');
  if (skin.inverseBindMatrices.length !== skin.joints.length * 16 || !skin.inverseBindMatrices.every(Number.isFinite)) throw new Error('Skin needs one finite inverse bind matrix per joint');
  const byName = new Map<string, RigObject>();
  for (const object of objects) { if (byName.has(object.name)) throw new Error('Rig object names must be unique'); byName.set(object.name, object); }
  const cache = new Map<string, Matrix4>(), active = new Set<string>();
  const world = (name: string): Matrix4 => {
    const cached = cache.get(name); if (cached) return cached;
    if (active.has(name)) throw new Error(`Rig hierarchy contains a cycle at ${name}`);
    const object = byName.get(name); if (!object) throw new Error(`Rig object not found: ${name}`);
    active.add(name);
    const matrix = objectMatrix(object); if (object.parent) matrix.premultiply(world(object.parent));
    if (!matrix.elements.every(Number.isFinite) || !Number.isFinite(matrix.determinant()) || Math.abs(matrix.determinant()) < 1e-12) throw new Error('Joint world transform must be finite and invertible');
    active.delete(name); cache.set(name, matrix); return matrix;
  };
  // Validate even unused ancestors; a malformed hierarchy should not be saved.
  for (const name of byName.keys()) world(name);
  for (let i = 0; i < skin.joints.length; i++) matrixFromArray(skin.inverseBindMatrices.slice(i * 16, i * 16 + 16), 'inverse bind matrix');
  return { objects: structuredClone([...objects]), skin: structuredClone(skin), jointWorldMatrices: skin.joints.map(name => world(name).toArray()) };
}

export function createRig(bones: readonly BoneSpec[], name = 'Rig'): RigBuild {
  boundedInteger(bones.length, 1, 256, 'bone count');
  if (!name || name.length > 160) throw new Error('Rig name must be a nonempty string of at most 160 characters');
  const names = new Set<string>();
  const objects: RigObject[] = bones.map(bone => {
    if (!bone.name || bone.name.length > 160 || names.has(bone.name)) throw new Error('Bone names must be unique nonempty strings');
    names.add(bone.name);
    const object: RigObject = { name: bone.name, type: 'EMPTY', joint: true, visible: true, modifiers: [], transform: { location: finiteVec(bone.position ?? { x: 0, y: 0, z: 0 }, 'bone position'), rotationEuler: finiteVec(bone.rotationEuler ?? { x: 0, y: 0, z: 0 }, 'bone rotation'), scale: finiteVec(bone.scale ?? { x: 1, y: 1, z: 1 }, 'bone scale') } };
    if (bone.parent) object.parent = bone.parent;
    if (bone.rotationQuaternion) object.transform.rotationQuaternion = quaternion(bone.rotationQuaternion, 'bone quaternion').toArray();
    return object;
  });
  const skin: RigSkin = { name, joints: bones.map(b => b.name), inverseBindMatrices: bones.flatMap(() => Array.from(new Matrix4().toArray())) };
  const roots = objects.filter(o => !o.parent); if (roots.length === 1) skin.skeleton = roots[0]!.name;
  const rig = rigFromObjects(skin, objects);
  rig.skin.inverseBindMatrices = rig.jointWorldMatrices.flatMap(matrix => Array.from(new Matrix4().fromArray(matrix).invert().toArray()));
  return rig;
}

function distanceToSegment(point: Vector3, a: Vector3, b: Vector3): number {
  const delta = b.clone().sub(a), length = delta.lengthSq();
  if (length < 1e-20) return point.distanceTo(a);
  const t = Math.max(0, Math.min(1, point.clone().sub(a).dot(delta) / length));
  return point.distanceTo(a.clone().addScaledVector(delta, t));
}

/** Smooth distance-to-bone binding; four weights per vertex are always stored. */
export function bindSkin(input: AuthoringMesh, rig: RigBuild, options: BindOptions = {}): { mesh: AuthoringMesh; skin: RigSkin } {
  validateAuthoringMesh(input);
  const maxInfluences = boundedInteger(options.maxInfluences ?? 4, 1, 4, 'skin influences');
  const falloff = finite(options.falloff ?? 2, 'binding falloff'); if (falloff <= 0 || falloff > 8) throw new Error('Binding falloff must be in (0,8]');
  const validated = rigFromObjects(rig.skin, rig.objects);
  const meshWorld = options.meshWorldMatrix ? matrixFromArray(options.meshWorldMatrix, 'mesh world matrix') : new Matrix4();
  const heads = validated.jointWorldMatrices.map(m => new Vector3().setFromMatrixPosition(new Matrix4().fromArray(m)));
  const childIndices = validated.skin.joints.map(joint => validated.skin.joints.map((name, i) => ({ name, i })).filter(child => validated.objects.find(o => o.name === child.name)?.parent === joint).map(child => child.i));
  const mesh = cloneMesh(input); mesh.skinIndices = []; mesh.skinWeights = [];
  const point = new Vector3();
  for (let vertex = 0; vertex < mesh.positions!.length / 3; vertex++) {
    point.fromArray(mesh.positions!, vertex * 3).applyMatrix4(meshWorld);
    const candidates = heads.map((head, joint) => {
      let distance = point.distanceTo(head);
      for (const child of childIndices[joint]!) distance = Math.min(distance, distanceToSegment(point, head, heads[child]!));
      return { joint, distance };
    }).sort((a, b) => a.distance - b.distance || a.joint - b.joint).slice(0, maxInfluences);
    // The ratio formulation avoids overflow for vertices exactly on a bone.
    const nearest = Math.max(candidates[0]!.distance, 1e-8);
    const weights = candidates.map(c => (nearest / Math.max(c.distance, 1e-8)) ** falloff), total = weights.reduce((sum, weight) => sum + weight, 0);
    for (let i = 0; i < 4; i++) { mesh.skinIndices.push(candidates[i]?.joint ?? 0); mesh.skinWeights.push(i < weights.length ? weights[i]! / total : 0); }
  }
  const skin = structuredClone(validated.skin);
  // A binding is made in the current rest pose, in this mesh's local space.
  skin.inverseBindMatrices = validated.jointWorldMatrices.flatMap(matrix => Array.from(new Matrix4().fromArray(matrix).invert().multiply(meshWorld).toArray()));
  validateAuthoringMesh(mesh); return { mesh, skin };
}

export function setSkinWeights(input: AuthoringMesh, edits: Array<{ vertex: number; indices: number[]; weights: number[] }>, jointCount: number): { mesh: AuthoringMesh; affectedVertices: number } {
  validateAuthoringMesh(input); boundedInteger(jointCount, 1, 256, 'joint count');
  if (!input.skinIndices || !input.skinWeights) throw new Error('Weight editing requires a bound mesh');
  const mesh = cloneMesh(input), affected = new Set<number>();
  for (const edit of edits) {
    boundedInteger(edit.vertex, 0, mesh.positions!.length / 3 - 1, 'weight vertex');
    boundedInteger(edit.indices.length, 1, 4, 'weight influence count');
    if (edit.indices.length !== edit.weights.length || new Set(edit.indices).size !== edit.indices.length) throw new Error('Each weight edit needs equal arrays and unique joint indices');
    for (const index of edit.indices) boundedInteger(index, 0, jointCount - 1, 'joint index');
    if (!edit.weights.every(weight => Number.isFinite(weight) && weight >= 0)) throw new Error('Weights must be finite and nonnegative');
    const total = edit.weights.reduce((sum, weight) => sum + weight, 0); if (!Number.isFinite(total) || total <= 0) throw new Error('Weights must have a finite positive sum');
    for (let i = 0; i < 4; i++) { mesh.skinIndices![edit.vertex * 4 + i] = edit.indices[i] ?? 0; mesh.skinWeights![edit.vertex * 4 + i] = (edit.weights[i] ?? 0) / total; }
    affected.add(edit.vertex);
  }
  validateAuthoringMesh(mesh); return { mesh, affectedVertices: affected.size };
}

/** Absolute local joint poses preserve the original rest-pose inverse binds. */
export function poseRig(rig: RigBuild, poses: readonly RigPose[]): RigBuild {
  const objects = structuredClone(rig.objects);
  for (const pose of poses) {
    if (!rig.skin.joints.includes(pose.bone)) throw new Error(`Pose joint not found: ${pose.bone}`);
    const object = objects.find(o => o.name === pose.bone)!;
    if (object.transform.matrix) {
      const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3(); objectMatrix(object).decompose(position, rotation, scale);
      object.transform.location = { x: position.x, y: position.y, z: position.z }; object.transform.rotationQuaternion = rotation.toArray(); object.transform.scale = { x: scale.x, y: scale.y, z: scale.z }; delete object.transform.matrix;
    }
    if (pose.translation) object.transform.location = finiteVec(pose.translation, 'pose translation');
    if (pose.scale) object.transform.scale = finiteVec(pose.scale, 'pose scale');
    if (pose.rotationEuler && pose.rotationQuaternion) throw new Error('A pose must specify either Euler or quaternion rotation');
    if (pose.rotationEuler) { object.transform.rotationEuler = finiteVec(pose.rotationEuler, 'pose Euler'); delete object.transform.rotationQuaternion; }
    if (pose.rotationQuaternion) object.transform.rotationQuaternion = quaternion(pose.rotationQuaternion, 'pose quaternion').toArray();
  }
  return rigFromObjects(rig.skin, objects);
}

/** CPU evaluation for native pose baking and deterministic deformation checks. */
export function deformSkinnedMesh(input: AuthoringMesh, rig: RigBuild, options: Pick<BindOptions, 'meshWorldMatrix'> = {}): AuthoringMesh {
  validateAuthoringMesh(input); if (!input.skinIndices || !input.skinWeights) throw new Error('Pose deformation requires skin indices and weights');
  const validated = rigFromObjects(rig.skin, rig.objects), inverseMesh = options.meshWorldMatrix ? matrixFromArray(options.meshWorldMatrix, 'mesh world matrix').invert() : new Matrix4();
  const matrices = validated.jointWorldMatrices.map((world, i) => inverseMesh.clone().multiply(new Matrix4().fromArray(world)).multiply(new Matrix4().fromArray(validated.skin.inverseBindMatrices.slice(i * 16, i * 16 + 16))));
  const normalMatrices = matrices.map(matrix => new Matrix3().getNormalMatrix(matrix));
  const mesh = customMesh(cloneMesh(input)), p = new Vector3(), result = new Vector3(), normal = new Vector3(), resultNormal = new Vector3();
  for (let v = 0; v < mesh.positions!.length / 3; v++) {
    p.fromArray(input.positions!, v * 3); result.set(0, 0, 0); resultNormal.set(0, 0, 0);
    if (input.normals) normal.fromArray(input.normals, v * 3);
    for (let i = 0; i < 4; i++) {
      const joint = input.skinIndices[v * 4 + i]!, weight = input.skinWeights[v * 4 + i]!;
      if (joint >= matrices.length) throw new Error('A skin index is outside this rig');
      if (weight === 0) continue;
      result.addScaledVector(p.clone().applyMatrix4(matrices[joint]!), weight);
      if (input.normals) resultNormal.addScaledVector(normal.clone().applyMatrix3(normalMatrices[joint]!), weight);
    }
    result.toArray(mesh.positions!, v * 3); if (mesh.normals) resultNormal.normalize().toArray(mesh.normals, v * 3);
  }
  delete mesh.skinIndices; delete mesh.skinWeights; delete mesh.tangents;
  validateAuthoringMesh(mesh); return mesh;
}

export function upsertRigKeyframes(rig: RigBuild, inputTracks: readonly RigAnimationTrack[], keyframes: readonly RigKeyframe[]): RigAnimationTrack[] {
  const tracks = structuredClone([...inputTracks]);
  boundedInteger(keyframes.length, 1, 10_000, 'keyframe count');
  for (const key of keyframes) {
    if (!rig.skin.joints.includes(key.object)) throw new Error(`Animation joint not found: ${key.object}`);
    if (!['translation', 'rotation', 'scale'].includes(key.path)) throw new Error('Unknown joint animation path');
    finite(key.time, 'key time'); if (key.time < 0) throw new Error('Key times cannot be negative');
    const width = key.path === 'rotation' ? 4 : 3;
    if (!Array.isArray(key.value) || key.value.length !== width || !key.value.every(Number.isFinite)) throw new Error(`Joint keyframe requires ${width} finite values`);
    if (key.interpolation && !['LINEAR', 'STEP'].includes(key.interpolation)) throw new Error('Native keyframes support LINEAR or STEP interpolation');
    const value = key.path === 'rotation' ? quaternion(key.value, 'key rotation').toArray() : key.value.slice();
    let track = tracks.find(t => t.object === key.object && t.path === key.path);
    if (!track) { track = { object: key.object, path: key.path, times: [], values: [], interpolation: key.interpolation ?? 'LINEAR' }; tracks.push(track); }
    if (key.interpolation) track.interpolation = key.interpolation;
    const entries = track.times.map((time, i) => ({ time, value: track!.values.slice(i * width, (i + 1) * width) })).filter(entry => entry.time !== key.time);
    entries.push({ time: key.time, value }); entries.sort((a, b) => a.time - b.time);
    track.times = entries.map(e => e.time); track.values = entries.flatMap(e => e.value);
  }
  return tracks;
}

export function sampleRigAnimation(rig: RigBuild, tracks: readonly RigAnimationTrack[], time: number): RigBuild {
  finite(time, 'sample time');
  const poses = new Map<string, RigPose>();
  for (const track of tracks) {
    if (!rig.skin.joints.includes(track.object)) throw new Error(`Animation joint not found: ${track.object}`);
    const width = track.path === 'rotation' ? 4 : 3;
    if (!['translation', 'rotation', 'scale'].includes(track.path) || !['LINEAR', 'STEP'].includes(track.interpolation) || !track.times.length || track.values.length !== track.times.length * width || !track.times.every((t, i) => Number.isFinite(t) && t >= 0 && (i === 0 || t > track.times[i - 1]!)) || !track.values.every(Number.isFinite)) throw new Error('Invalid native joint animation track');
    let left = 0; while (left + 1 < track.times.length && track.times[left + 1]! <= time) left++;
    const right = Math.min(left + 1, track.times.length - 1), amount = track.interpolation === 'STEP' || left === right ? 0 : Math.max(0, Math.min(1, (time - track.times[left]!) / (track.times[right]! - track.times[left]!)));
    const a = track.values.slice(left * width, (left + 1) * width), b = track.values.slice(right * width, (right + 1) * width), pose = poses.get(track.object) ?? { bone: track.object };
    if (track.path === 'rotation') pose.rotationQuaternion = quaternion(a, 'track rotation').slerp(quaternion(b, 'track rotation'), amount).toArray();
    else { const value = a.map((v, i) => v + (b[i]! - v) * amount); pose[track.path === 'translation' ? 'translation' : 'scale'] = { x: value[0]!, y: value[1]!, z: value[2]! }; }
    poses.set(track.object, pose);
  }
  return poseRig(rig, [...poses.values()]);
}
