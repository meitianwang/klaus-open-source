import type { Json } from '../ipc/contract';
import { object, string } from '../services/service-types';
import { json } from '../visuals/data';
import { createHash } from 'node:crypto';

/**
 * The 3D document model.
 *
 * Separate datablocks keep geometry shared and editing non-destructive:
 *
 *   - DATABLOCKS ARE SEPARATE AND REFERENCED, NOT OWNED. Meshes and materials
 *     live in their own tables; an object only names them. One mesh can back
 *     several objects (an array of identical legs, say) and changing a material
 *     updates every object that uses it. Copying an object therefore does not
 *     duplicate geometry, and a shared material is edited in exactly one place.
 *
 *   - MODIFIERS ARE A NON-DESTRUCTIVE STACK. An object keeps its base mesh plus
 *     an ordered list of operations. Nothing is baked into the source data, so
 *     any layer can be re-ordered, re-tuned or removed later and the original
 *     is still intact.
 *
 *   - EVALUATION IS CACHED BY CONTENT HASH. Transforms are cheap (a matrix on
 *     the object), but a modifier stack is real work, so the evaluated geometry
 *     is keyed by a hash of everything that feeds it. A drag that only moves an
 *     object re-evaluates nothing; adding a Boolean re-evaluates that object.
 *
 * The local kernel evaluates supported modifier stacks. Imported rigging,
 * shading and animation remain document data rather than baked geometry.
 */

export const PRIMITIVES = ['cube', 'uv_sphere', 'ico_sphere', 'cylinder', 'cone', 'torus', 'plane', 'grid', 'monkey', 'circle'] as const;
export type PrimitiveKind = (typeof PRIMITIVES)[number];

export const MODIFIER_TYPES = [
  'subdivide', 'mirror', 'array', 'boolean', 'solidify', 'bevel', 'decimate', 'smooth', 'wireframe', 'triangulate', 'remesh', 'hull', 'screw', 'extrude',
] as const;
export type ModifierType = (typeof MODIFIER_TYPES)[number];

export type ObjectType = 'MESH' | 'CAMERA' | 'LIGHT' | 'EMPTY';
export type LightType = 'SUN' | 'POINT' | 'SPOT' | 'AREA';

export interface Vec3 { x: number; y: number; z: number }

export interface TextureSlot3D {
  texture: string;
  texCoord?: number;
  scale?: number;
  strength?: number;
  transform?: { offset: number[]; scale: number[]; rotation: number; texCoord?: number };
}

export interface Texture3D {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  dataBase64: string;
  width?: number;
  height?: number;
  sampler?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number };
}

export interface Skin3D {
  name: string;
  joints: string[];
  inverseBindMatrices: number[];
  skeleton?: string;
}

export interface AnimationTrack3D {
  object: string;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  times: number[];
  values: number[];
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}
export interface AnimationClip3D { name: string; tracks: AnimationTrack3D[] }

/** A material is a datablock: one record, referenced by many objects. */
export interface Material3D {
  name: string;
  baseColor: number[];
  metallic: number;
  roughness: number;
  emissiveColor: number[];
  emissiveStrength: number;
  alpha: number;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided?: boolean;
  baseColorTexture?: TextureSlot3D;
  metallicRoughnessTexture?: TextureSlot3D;
  normalTexture?: TextureSlot3D;
  occlusionTexture?: TextureSlot3D;
  emissiveTexture?: TextureSlot3D;
}

/** A mesh datablock: the base geometry an object starts from. */
export interface MeshBlock {
  name: string;
  /** Primitive this was generated from, if any. Custom meshes leave it null. */
  primitive: PrimitiveKind | null;
  primitiveParams: Record<string, number>;
  /** Positions, interleaved xyz, for imported or custom meshes. */
  positions?: number[];
  indices?: number[];
  normals?: number[];
  uvs?: number[];
  uvs1?: number[];
  tangents?: number[];
  colors?: number[];
  skinIndices?: number[];
  skinWeights?: number[];
  groups?: Array<{ start: number; count: number; materialIndex: number }>;
  morphTargets?: Array<{ name?: string; positions?: number[]; normals?: number[] }>;
  geometryGraph?: Record<string, Json>;
  /** Material names in slot order. */
  materials: string[];
}

/** One non-destructive layer in an object's modifier stack. */
export interface Modifier3D {
  /** Unique within the object; used to address it for edits and removal. */
  id: string;
  type: ModifierType;
  label: string;
  enabled: boolean;
  params: Record<string, Json>;
}

export interface Object3DRecord {
  name: string;
  type: ObjectType;
  /** Reference to a mesh datablock, not an embedded copy. */
  mesh?: string;
  parent?: string;
  joint?: boolean;
  skin?: string;
  morphInfluences?: number[];
  transform: { location: Vec3; rotationEuler: Vec3; scale: Vec3; rotationQuaternion?: number[]; matrix?: number[] };
  modifiers: Modifier3D[];
  visible: boolean;
  /** Camera/lights only. */
  camera?: { lens: number; clipStart: number; clipEnd: number };
  light?: { type: LightType; energy: number; color: number[] };
  /** Rigid-body physics. */
  rigidBody?: { kind: 'active' | 'passive'; mass: number; friction: number; restitution: number };
  /** Cloth simulation. */
  cloth?: { preset: string; mass: number; collider?: string };
  /** Animation channels: data path -> keyframes. */
  animation?: Record<string, Array<{ frame: number; value: number[] }>>;
}

export interface SceneSettings {
  // No `engine` and no `samples`: the panel renders with three.js's realtime
  // rasterizer, which has one shading path and no sample count. Advertising a
  // path-traced option the renderer cannot honour would be a promise the tool
  // surface cannot keep.
  resolutionX: number;
  resolutionY: number;
  frameStart: number;
  frameEnd: number;
  fps: number;
  activeCamera?: string;
  background: number[];
  renderEngine?: 'raster' | 'pathtrace';
  renderSamples?: number;
  renderBounces?: number;
  currentFrame?: number;
  activeClip?: string;
}

/** The whole document. One per task; the host owns the only copy. */
export interface Model3DDocument {
  id: string;
  sessionId: string;
  title: string;
  /** Bumped on every mutation so the panel can tell a stale copy from a new one. */
  version: number;
  updatedAtMs: number;
  meshes: Record<string, MeshBlock>;
  materials: Record<string, Material3D>;
  objects: Object3DRecord[];
  scene: SceneSettings;
  textures?: Record<string, Texture3D>;
  skins?: Record<string, Skin3D>;
  clips?: Record<string, AnimationClip3D>;
}

const MAX_NAME = 160;

function vec3Of(value: unknown, fallback: Vec3): Vec3 {
  if (value === undefined) return { ...fallback };
  if (Array.isArray(value)) {
    const vector = finiteArray(value, 'transform vector', 3);
    if (vector.length !== 3) throw new Error('A transform vector requires three components.');
    return { x: vector[0]!, y: vector[1]!, z: vector[2]! };
  }
  const record = object(value);
  const read = (key: string): number => {
    return finiteNumber(record[key], fallback[key as keyof Vec3]);
  };
  if (!Object.keys(record).length) return { ...fallback };
  return { x: read('x'), y: read('y'), z: read('z') };
}

export function zeroVec(): Vec3 { return { x: 0, y: 0, z: 0 }; }
export function oneVec(): Vec3 { return { x: 1, y: 1, z: 1 }; }

/** A safe, unique-by-construction name for a new datablock. */
export function safeName(value: unknown, fallback: string, taken: Iterable<string>): string {
  // Strip control characters, path separators and shell-hostile punctuation, then
  // trim leading/trailing dots and spaces: a name that began as `../etc/passwd`
  // collapses to `..etcpasswd`, whose leading dots would still read as a hidden or
  // relative path. This mirrors the filename-safety rule the digram store uses.
  const cleaned = String(value ?? '')
    .replace(/[\x00-\x1f/\\<>:"|?*]/g, '')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, MAX_NAME);
  const base = (['__proto__', 'constructor', 'prototype'].includes(cleaned) ? `${cleaned}_` : cleaned) || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  // A compact numbered suffix keeps duplicate names readable.
  for (let index = 1; index < 1000; index++) {
    const candidate = `${base}.${String(index).padStart(3, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function defaultMaterial(name: string): Material3D {
  return { name, baseColor: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.5, emissiveColor: [1, 1, 1], emissiveStrength: 0, alpha: 1 };
}

export function defaultScene(): SceneSettings {
  return {
    resolutionX: 640, resolutionY: 480,
    frameStart: 1, frameEnd: 250, fps: 24, background: [0.05, 0.05, 0.06, 1],
  };
}

export function emptyDocument(id: string, title: string, sessionId: string): Model3DDocument {
  return {
    id, sessionId, title, version: 1, updatedAtMs: Date.now(),
    meshes: {}, materials: {}, objects: [], scene: defaultScene(), textures: {}, skins: {}, clips: {},
  };
}

/** Re-validate an untrusted document (read from disk or over IPC). */
export function parseDocument(input: unknown): Model3DDocument {
  const raw = object(input);
  const doc = emptyDocument(string(raw.id), string(raw.title) || 'Untitled', string(raw.sessionId));
  doc.version = Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1;
  doc.updatedAtMs = Number.isFinite(Number(raw.updatedAtMs)) ? Number(raw.updatedAtMs) : Date.now();
  for (const key of ['meshes', 'materials', 'textures', 'skins', 'clips']) {
    if (Object.keys(object(raw[key])).length > 10000) throw new Error(`Too many 3D ${key} records.`);
    if (Object.keys(object(raw[key])).some(name => ['__proto__', 'constructor', 'prototype'].includes(name))) throw new Error(`Unsafe 3D ${key} record name.`);
  }
  if (Array.isArray(raw.objects) && raw.objects.length > 10000) throw new Error('Too many 3D objects.');
  for (const [name, value] of Object.entries(object(raw.meshes))) {
    const mesh = object(value);
    doc.meshes[name] = {
      name,
      primitive: (PRIMITIVES as readonly string[]).includes(string(mesh.primitive)) ? mesh.primitive as PrimitiveKind : null,
      primitiveParams: object(mesh.primitiveParams) as Record<string, number>,
      ...(mesh.positions !== undefined ? { positions: finiteArray(mesh.positions, `${name}.positions`, 3) } : {}),
      ...(mesh.indices !== undefined ? { indices: finiteArray(mesh.indices, `${name}.indices`, 3) } : {}),
      materials: Array.isArray(mesh.materials) ? mesh.materials.map(v => (typeof v === 'string' ? v : null)).filter((v): v is string => v !== null) : [],
    };
    const block = doc.meshes[name]!;
    for (const [key, value] of Object.entries(block.primitiveParams)) block.primitiveParams[key] = finiteNumber(value, 0);
    if (mesh.geometryGraph !== undefined) block.geometryGraph = json(object(mesh.geometryGraph)) as Record<string, Json>;
    const vertices = (block.positions?.length ?? 0) / 3;
    if (block.indices?.some(index => !Number.isInteger(index) || index < 0 || index >= vertices)) throw new Error(`${name} has an invalid vertex index.`);
    for (const [attribute, width] of Object.entries({ normals: 3, uvs: 2, uvs1: 2, tangents: 4, colors: 4, skinIndices: 4, skinWeights: 4 })) {
      if (mesh[attribute] === undefined) continue;
      const values = finiteArray(mesh[attribute], `${name}.${attribute}`, width);
      if (values.length !== vertices * width) throw new Error(`${name}.${attribute} does not match the vertex count.`);
      (block as unknown as Record<string, unknown>)[attribute] = values;
    }
    if (Boolean(block.skinIndices) !== Boolean(block.skinWeights)) throw new Error(`${name} requires both joint indices and weights.`);
    if (block.skinIndices?.some(index => !Number.isInteger(index) || index < 0 || index > 65535)) throw new Error(`${name} has invalid joint indices.`);
    if (block.skinWeights?.some(weight => weight < 0 || weight > 1)) throw new Error(`${name} has invalid skin weights.`);
    if (block.skinWeights) for (let vertex = 0; vertex < vertices; vertex++) {
      const weights = block.skinWeights.slice(vertex * 4, vertex * 4 + 4);
      if (Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 0.02) throw new Error(`${name} skin weights must sum to one for each vertex.`);
    }
    if (Array.isArray(mesh.groups)) {
      block.groups = mesh.groups.map(rawGroup => {
        const group = object(rawGroup);
        const start = Number(group.start), count = Number(group.count), materialIndex = Number(group.materialIndex);
        if (![start, count, materialIndex].every(Number.isSafeInteger) || start < 0 || count < 0 || start % 3 || count % 3 || start + count > (block.indices?.length ?? vertices) || materialIndex < 0 || materialIndex >= block.materials.length) throw new Error(`${name} has an invalid material group.`);
        return { start, count, materialIndex };
      });
    }
    if (Array.isArray(mesh.morphTargets)) {
      if (mesh.morphTargets.length > 128) throw new Error(`${name} has too many morph targets.`);
      block.morphTargets = mesh.morphTargets.map(rawTarget => {
        const target = object(rawTarget);
        const result: NonNullable<MeshBlock['morphTargets']>[number] = {};
        if (typeof target.name === 'string') result.name = target.name;
        for (const field of ['positions', 'normals'] as const) if (target[field] !== undefined) {
          const values = finiteArray(target[field], `${name}.morph.${field}`, 3);
          if (values.length !== vertices * 3) throw new Error(`${name} has a morph target with the wrong vertex count.`);
          result[field] = values;
        }
        if (!result.positions && !result.normals) throw new Error(`${name} has an empty morph target.`);
        return result;
      });
    }
  }
  for (const [name, value] of Object.entries(object(raw.materials))) {
    const material = object(value);
    doc.materials[name] = {
      name,
      baseColor: numericArray(material.baseColor, [0.8, 0.8, 0.8, 1]),
      metallic: finiteNumber(material.metallic, 0),
      roughness: finiteNumber(material.roughness, 0.5),
      emissiveColor: numericArray(material.emissiveColor, [1, 1, 1]),
      emissiveStrength: finiteNumber(material.emissiveStrength, 0),
      alpha: finiteNumber(material.alpha, 1),
    };
    const record = doc.materials[name]!;
    if (['OPAQUE', 'MASK', 'BLEND'].includes(string(material.alphaMode))) record.alphaMode = material.alphaMode as Material3D['alphaMode'];
    if (material.alphaCutoff !== undefined) record.alphaCutoff = finiteNumber(material.alphaCutoff, 0.5);
    if (typeof material.doubleSided === 'boolean') record.doubleSided = material.doubleSided;
    for (const slot of ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'] as const) {
      if (material[slot] !== undefined) record[slot] = parseTextureSlot(material[slot]);
    }
  }
  for (const rawObject of Array.isArray(raw.objects) ? raw.objects : []) {
    const item = object(rawObject);
    const name = string(item.name);
    if (!name) continue;
    const transform = object(item.transform);
    const modifiers: Modifier3D[] = [];
    for (const rawModifier of Array.isArray(item.modifiers) ? item.modifiers : []) {
      const modifier = object(rawModifier);
      const type = string(modifier.type) as ModifierType;
      if (!(MODIFIER_TYPES as readonly string[]).includes(type)) continue;
      modifiers.push({
        id: string(modifier.id) || `${type}-${modifiers.length}`,
        type, label: string(modifier.label) || type,
        enabled: modifier.enabled !== false,
        params: object(modifier.params) as Record<string, Json>,
      });
    }
    const record: Object3DRecord = {
      name,
      type: (['MESH', 'CAMERA', 'LIGHT', 'EMPTY'] as const).includes(string(item.type) as ObjectType) ? item.type as ObjectType : 'MESH',
      ...(typeof item.mesh === 'string' ? { mesh: item.mesh } : {}),
      transform: {
        location: vec3Of(transform.location, zeroVec()),
        rotationEuler: vec3Of(transform.rotationEuler, zeroVec()),
        scale: vec3Of(transform.scale, oneVec()),
      },
      modifiers,
      visible: item.visible !== false,
    };
    if (typeof item.parent === 'string') record.parent = item.parent;
    if (item.joint === true) record.joint = true;
    if (typeof item.skin === 'string') record.skin = item.skin;
    if (item.morphInfluences !== undefined) record.morphInfluences = finiteArray(item.morphInfluences, `${name}.morphInfluences`);
    if (transform.rotationQuaternion !== undefined) {
      record.transform.rotationQuaternion = finiteArray(transform.rotationQuaternion, `${name}.rotationQuaternion`, 4);
      if (record.transform.rotationQuaternion.length !== 4 || Math.hypot(...record.transform.rotationQuaternion) < 1e-12) throw new Error(`${name} has an invalid rotation quaternion.`);
    }
    if (transform.matrix !== undefined) {
      record.transform.matrix = finiteArray(transform.matrix, `${name}.matrix`, 16);
      const m = record.transform.matrix;
      if (m.length !== 16 || Math.abs(m[3]!) > 1e-8 || Math.abs(m[7]!) > 1e-8 || Math.abs(m[11]!) > 1e-8 || Math.abs(m[15]! - 1) > 1e-8) throw new Error(`${name} has a non-affine transform matrix.`);
    }
    if (object(item.camera) && Object.keys(object(item.camera)).length) {
      const camera = object(item.camera);
      record.camera = { lens: Number(camera.lens) || 50, clipStart: Number(camera.clipStart) || 0.1, clipEnd: Number(camera.clipEnd) || 1000 };
    }
    if (object(item.light) && Object.keys(object(item.light)).length) {
      const light = object(item.light);
      const kind = string(light.type).toUpperCase() as LightType;
      record.light = {
        type: (['SUN', 'POINT', 'SPOT', 'AREA'] as const).includes(kind) ? kind : 'POINT',
        energy: Number(light.energy) || 100,
        color: numericArray(light.color, [1, 1, 1]),
      };
    }
    const rigid = object(item.rigidBody);
    if (Object.keys(rigid).length) {
      record.rigidBody = {
        kind: string(rigid.kind) === 'passive' ? 'passive' : 'active',
        mass: Number(rigid.mass) || 1, friction: Number(rigid.friction) || 0.5, restitution: Number(rigid.restitution) || 0,
      };
    }
    const cloth = object(item.cloth);
    if (Object.keys(cloth).length) {
      record.cloth = { preset: string(cloth.preset) || 'cotton', mass: Number(cloth.mass) || 1,
        ...(typeof cloth.collider === 'string' ? { collider: cloth.collider } : {}) };
    }
    const animation = object(item.animation);
    if (Object.keys(animation).length) {
      record.animation = {};
      for (const [path, frames] of Object.entries(animation)) {
        if (!Array.isArray(frames)) continue;
        record.animation[path] = frames.map(object).map(frame => ({
          frame: boundedInteger(frame.frame ?? 1, 1, 1_000_000, 'animation frame'),
          value: finiteArray(frame.value, `${name}.animation.${path}`),
        })).filter(key => key.value.length);
      }
    }
    doc.objects.push(record);
  }
  let textureBytes = 0;
  for (const [name, value] of Object.entries(object(raw.textures))) {
    const texture = object(value);
    const mimeType = string(texture.mimeType);
    const dataBase64 = string(texture.dataBase64);
    if (!['image/png', 'image/jpeg'].includes(mimeType) || !dataBase64.length || dataBase64.length > 44_739_244 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) throw new Error(`${name} has invalid or oversized texture data.`);
    textureBytes += Math.floor(dataBase64.length * 3 / 4);
    if (textureBytes > 64 * 1024 * 1024) throw new Error('3D textures exceed the 64 MiB limit.');
    const sampler = object(texture.sampler);
    const record: Texture3D = { name, mimeType: mimeType as Texture3D['mimeType'], dataBase64 };
    if (texture.width !== undefined || texture.height !== undefined) {
      record.width = boundedInteger(texture.width, 1, 16384, 'texture width');
      record.height = boundedInteger(texture.height, 1, 16384, 'texture height');
      if (record.width * record.height > 64_000_000) throw new Error('3D texture dimensions exceed the pixel limit.');
    }
    if (Object.keys(sampler).length) {
      record.sampler = {};
      for (const key of ['magFilter', 'minFilter', 'wrapS', 'wrapT'] as const) if (sampler[key] !== undefined) {
        const allowed = key === 'magFilter' ? [9728, 9729] : key === 'minFilter' ? [9728, 9729, 9984, 9985, 9986, 9987] : [33071, 33648, 10497];
        const parsed = Number(sampler[key]);
        if (!allowed.includes(parsed)) throw new Error(`${name} has an invalid texture sampler.`);
        record.sampler[key] = parsed;
      }
    }
    doc.textures![name] = record;
  }
  for (const [name, value] of Object.entries(object(raw.skins))) {
    const skin = object(value);
    const joints = Array.isArray(skin.joints) ? skin.joints.map(value => string(value)) : [];
    if (!joints.length || joints.length > 1024 || joints.some(name => !name) || new Set(joints).size !== joints.length) throw new Error(`${name} has invalid skeleton joints.`);
    const inverseBindMatrices = finiteArray(skin.inverseBindMatrices, `${name}.inverseBindMatrices`, 16);
    if (inverseBindMatrices.length !== joints.length * 16) throw new Error(`${name} has an inverse-bind matrix count mismatch.`);
    for (let i = 0; i < inverseBindMatrices.length; i += 16) if (Math.abs(inverseBindMatrices[i + 3]!) > 1e-8 || Math.abs(inverseBindMatrices[i + 7]!) > 1e-8 || Math.abs(inverseBindMatrices[i + 11]!) > 1e-8 || Math.abs(inverseBindMatrices[i + 15]! - 1) > 1e-8) throw new Error(`${name} has a non-affine inverse-bind matrix.`);
    doc.skins![name] = { name, joints, inverseBindMatrices, ...(typeof skin.skeleton === 'string' ? { skeleton: skin.skeleton } : {}) };
  }
  for (const [name, value] of Object.entries(object(raw.clips))) {
    const clip = object(value);
    const tracks = Array.isArray(clip.tracks) ? clip.tracks : [];
    if (tracks.length > 10000) throw new Error(`${name} has too many animation tracks.`);
    doc.clips![name] = { name, tracks: tracks.map(rawTrack => {
      const track = object(rawTrack);
      const path = string(track.path), interpolation = string(track.interpolation) || 'LINEAR';
      if (!['translation', 'rotation', 'scale', 'weights'].includes(path) || !['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation)) throw new Error(`${name} has an unsupported animation track.`);
      const times = finiteArray(track.times, `${name}.times`), values = finiteArray(track.values, `${name}.values`);
      if (!times.length || times.some((time, index) => time < 0 || index > 0 && time <= times[index - 1]!)) throw new Error(`${name} has invalid animation times.`);
      return { object: string(track.object), path: path as AnimationTrack3D['path'], interpolation: interpolation as AnimationTrack3D['interpolation'], times, values };
    }) };
  }
  const scene = object(raw.scene);
  if (Object.keys(scene).length) {
    doc.scene = {
      ...defaultScene(),
      resolutionX: Number(scene.resolutionX) || 640,
      resolutionY: Number(scene.resolutionY) || 480,
      frameStart: boundedInteger(scene.frameStart ?? 1, 1, 1_000_000, 'scene start frame'),
      frameEnd: boundedInteger(scene.frameEnd ?? 250, 1, 1_000_000, 'scene end frame'),
      fps: finiteNumber(scene.fps, 24),
      ...(typeof scene.activeCamera === 'string' ? { activeCamera: scene.activeCamera } : {}),
      background: numericArray(scene.background, [0.05, 0.05, 0.06, 1]),
      ...(scene.renderEngine === 'raster' || scene.renderEngine === 'pathtrace' ? { renderEngine: scene.renderEngine } : {}),
      ...(scene.renderSamples !== undefined ? { renderSamples: boundedInteger(scene.renderSamples, 1, 4096, 'render samples') } : {}),
      ...(scene.renderBounces !== undefined ? { renderBounces: boundedInteger(scene.renderBounces, 1, 32, 'render bounces') } : {}),
      ...(scene.currentFrame !== undefined ? { currentFrame: boundedInteger(scene.currentFrame, 1, 1_000_000, 'current frame') } : {}),
      ...(typeof scene.activeClip === 'string' ? { activeClip: scene.activeClip } : {}),
    };
    if (doc.scene.fps <= 0 || doc.scene.fps > 240) throw new Error('Scene frame rate must be within (0, 240].');
  }
  validateDocumentLinks(doc);
  return doc;
}

function finiteNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('A 3D numeric field is not finite.');
  return number;
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const parsed = finiteNumber(value, min);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid 3D ${label}.`);
  return parsed;
}

function finiteArray(value: unknown, label: string, width = 1): number[] {
  if (!Array.isArray(value) || value.length > 16_000_000 || value.length % width || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${label} is not a bounded finite numeric array.`);
  return [...value] as number[];
}

function parseTextureSlot(value: unknown): TextureSlot3D {
  const slot = object(value);
  const texture = string(slot.texture);
  if (!texture) throw new Error('A material texture reference is missing.');
  const result: TextureSlot3D = { texture };
  for (const key of ['texCoord', 'scale', 'strength'] as const) if (slot[key] !== undefined) result[key] = finiteNumber(slot[key], 0);
  if (result.texCoord !== undefined && result.texCoord !== 0 && result.texCoord !== 1) throw new Error('Only texture coordinate sets 0 and 1 are supported.');
  if (slot.transform !== undefined) {
    const transform = object(slot.transform);
    const offset = finiteArray(transform.offset ?? [0, 0], 'texture offset', 2);
    const scale = finiteArray(transform.scale ?? [1, 1], 'texture scale', 2);
    if (offset.length !== 2 || scale.length !== 2) throw new Error('A texture transform requires two-component vectors.');
    result.transform = { offset, scale, rotation: finiteNumber(transform.rotation, 0) };
    if (transform.texCoord !== undefined) {
      const texCoord = finiteNumber(transform.texCoord, 0);
      if (texCoord !== 0 && texCoord !== 1) throw new Error('Only texture coordinate sets 0 and 1 are supported.');
      result.transform.texCoord = texCoord;
    }
  }
  return result;
}

/** Validate links after all datablocks have been decoded. */
export function validateDocumentLinks(doc: Model3DDocument): void {
  const objects = new Map<string, Object3DRecord>();
  for (const record of doc.objects) {
    if (objects.has(record.name)) throw new Error(`Duplicate scene object '${record.name}'.`);
    objects.set(record.name, record);
  }
  const checked = new Set<string>(), visiting = new Set<string>();
  const visit = (name: string): void => {
    if (checked.has(name)) return;
    if (visiting.has(name)) throw new Error(`Scene parent cycle at '${name}'.`);
    if (visiting.size > 256) throw new Error('Scene hierarchy exceeds the supported depth.');
    const record = objects.get(name);
    if (!record) throw new Error(`Scene parent '${name}' is missing.`);
    visiting.add(name);
    if (record.parent) visit(record.parent);
    visiting.delete(name);
    checked.add(name);
  };
  for (const record of doc.objects) {
    visit(record.name);
    if (record.mesh && !doc.meshes[record.mesh]) throw new Error(`Mesh '${record.mesh}' is missing.`);
    if (record.skin) {
      const skin = doc.skins?.[record.skin], mesh = record.mesh ? doc.meshes[record.mesh] : undefined;
      if (!skin || !mesh?.skinIndices || !mesh.skinWeights) throw new Error(`Object '${record.name}' has an incomplete skin binding.`);
      if (mesh.skinIndices.some(index => index >= skin.joints.length)) throw new Error(`Object '${record.name}' references a joint outside its skin.`);
    }
    if (record.morphInfluences && record.morphInfluences.length !== (record.mesh ? doc.meshes[record.mesh]?.morphTargets?.length ?? 0 : 0)) throw new Error(`Object '${record.name}' has a morph weight count mismatch.`);
  }
  for (const skin of Object.values(doc.skins ?? {})) {
    for (const joint of skin.joints) if (!objects.has(joint)) throw new Error(`Skin joint '${joint}' is missing.`);
    if (skin.skeleton && !objects.has(skin.skeleton)) throw new Error(`Skin skeleton '${skin.skeleton}' is missing.`);
  }
  for (const material of Object.values(doc.materials)) for (const slot of ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'] as const) {
    if (material[slot] && !doc.textures?.[material[slot]!.texture]) throw new Error(`Texture '${material[slot]!.texture}' is missing.`);
  }
  for (const clip of Object.values(doc.clips ?? {})) for (const track of clip.tracks) {
    const target = objects.get(track.object);
    if (!target) throw new Error(`Animation object '${track.object}' is missing.`);
    const width = track.path === 'rotation' ? 4 : track.path === 'weights' ? (target.mesh ? doc.meshes[target.mesh]?.morphTargets?.length ?? 0 : 0) : 3;
    if (!width || track.values.length !== track.times.length * width * (track.interpolation === 'CUBICSPLINE' ? 3 : 1)) throw new Error(`Animation '${clip.name}' has a keyframe value count mismatch.`);
    if (track.path === 'rotation') for (let i = track.interpolation === 'CUBICSPLINE' ? 4 : 0; i < track.values.length; i += track.interpolation === 'CUBICSPLINE' ? 12 : 4) {
      if (Math.abs(Math.hypot(...track.values.slice(i, i + 4)) - 1) > 1e-4) throw new Error(`Animation '${clip.name}' has a non-normalized rotation key.`);
    }
  }
}

function numericArray(value: unknown, fallback: number[]): number[] {
  if (value === undefined) return [...fallback];
  const numbers = finiteArray(value, 'color');
  if (numbers.length === fallback.length) return numbers;
  if (fallback.length === 4 && numbers.length === 3) return [...numbers, fallback[3]!];
  throw new Error('A color has the wrong component count.');
}

export function findObject(doc: Model3DDocument, name: string): Object3DRecord | undefined {
  return doc.objects.find(item => item.name === name);
}

export function objectNames(doc: Model3DDocument): string[] {
  return doc.objects.map(item => item.name);
}

/** Everything that feeds an object's evaluated geometry — the cache key. */
export function geometryKey(doc: Model3DDocument, record: Object3DRecord): string {
  const objects = new Map(doc.objects.map(item => [item.name, item]));
  const visiting = new Set<string>();
  const placement = (target: Object3DRecord, ancestors = new Set<string>()): unknown => {
    if (ancestors.has(target.name) || ancestors.size > 256) throw new Error('Scene parent cycle or excessive hierarchy depth.');
    ancestors.add(target.name);
    const parent = target.parent ? objects.get(target.parent) : undefined;
    return [target.transform, parent ? placement(parent, ancestors) : target.parent ?? null];
  };
  const inputs = (target: Object3DRecord): unknown => {
    if (visiting.has(target.name) || visiting.size > 256) throw new Error('Modifier dependency cycle or excessive dependency depth.');
    visiting.add(target.name);
    const modifiers = target.modifiers.filter(item => item.enabled).map(modifier => {
      const operand = typeof modifier.params.object === 'string' ? objects.get(modifier.params.object) : undefined;
      return [modifier.type, modifier.params, operand ? [inputs(operand), placement(operand), placement(target)] : null];
    });
    visiting.delete(target.name);
    const mesh = target.mesh ? doc.meshes[target.mesh] : null;
    return [mesh ?? null, modifiers];
  };
  // Hash all attribute values, not merely buffer lengths. Geometry edits and
  // nested operand edits must invalidate even when their topology is unchanged.
  return createHash('sha256').update(stableStringify(inputs(record))).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The compact scene graph the panel renders and drags against. */
export function serializeDocument(doc: Model3DDocument): Json {
  // Normalized through JSON before it crosses the IPC boundary: optional fields
  // such as `scene.activeCamera` carry `undefined`, which is not Json, and a
  // structurally-similar object would type-check but serialize inconsistently.
  return json({
    id: doc.id,
    title: doc.title,
    version: doc.version,
    objects: doc.objects.map(item => ({
      name: item.name,
      type: item.type,
      mesh: item.mesh ?? null,
      location: [item.transform.location.x, item.transform.location.y, item.transform.location.z],
      rotation_euler: [item.transform.rotationEuler.x, item.transform.rotationEuler.y, item.transform.rotationEuler.z],
      scale: [item.transform.scale.x, item.transform.scale.y, item.transform.scale.z],
      parent: item.parent ?? null,
      joint: item.joint ?? false,
      skin: item.skin ?? null,
      matrix: item.transform.matrix ?? null,
      rotation_quaternion: item.transform.rotationQuaternion ?? null,
      morph_influences: item.morphInfluences ?? null,
      rotationQuaternion: item.transform.rotationQuaternion ?? null,
      morphInfluences: item.morphInfluences ?? null,
      visible: item.visible,
      modifiers: item.modifiers.map(modifier => ({ id: modifier.id, type: modifier.type, label: modifier.label, enabled: modifier.enabled })),
      geometry_key: geometryKey(doc, item),
      // The material lives on the mesh datablock, not the object; resolve slot 0
      // here so the viewport can colour the object without a second lookup.
      material: (item.mesh ? doc.meshes[item.mesh]?.materials[0] : undefined) ?? null,
      materials: (item.mesh ? doc.meshes[item.mesh]?.materials : undefined) ?? [],
      camera: item.camera ? { active: doc.scene.activeCamera === item.name, ...item.camera } : null,
      light: item.light ?? null,
      rigid_body: item.rigidBody?.kind ?? null,
      cloth: item.cloth ? { preset: item.cloth.preset, collider: item.cloth.collider ?? null } : null,
      animated: item.animation ? Object.keys(item.animation) : [],
      animation: item.animation ?? {},
    })),
    materials: Object.values(doc.materials),
    meshes: Object.fromEntries(Object.entries(doc.meshes).map(([name, mesh]) => [name, {
      name: mesh.name, primitive: mesh.primitive, primitiveParams: mesh.primitiveParams,
      materials: mesh.materials, geometryGraph: mesh.geometryGraph ?? null,
      vertexCount: (mesh.positions?.length ?? 0) / 3,
      triangleCount: (mesh.indices?.length ?? 0) / 3,
      attributes: ['normals', 'uvs', 'uvs1', 'tangents', 'colors', 'skinIndices', 'skinWeights'].filter(key => Boolean((mesh as unknown as Record<string, unknown>)[key])),
      morphTargets: mesh.morphTargets?.map(target => ({ name: target.name ?? null, positions: Boolean(target.positions), normals: Boolean(target.normals) })) ?? [],
    }])),
    textures: doc.textures ?? {},
    skins: doc.skins ?? {},
    clips: doc.clips ?? {},
    scene: doc.scene,
    summary: {
      objects: doc.objects.length,
      meshes: Object.keys(doc.meshes).length,
      materials: Object.keys(doc.materials).length,
      cameras: doc.objects.filter(item => item.type === 'CAMERA').length,
      lights: doc.objects.filter(item => item.type === 'LIGHT').length,
      textures: Object.keys(doc.textures ?? {}).length,
      skins: Object.keys(doc.skins ?? {}).length,
      clips: Object.keys(doc.clips ?? {}).length,
    },
  });
}

export function documentSummary(doc: Model3DDocument): Json {
  return object(serializeDocument(doc)).summary ?? {};
}
