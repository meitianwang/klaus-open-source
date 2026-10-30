import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, relative, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AnimationClip3D, AnimationTrack3D, Material3D, MeshBlock, Model3DDocument, Object3DRecord, Skin3D, Texture3D, TextureSlot3D } from './model';
import { defaultMaterial, safeName, zeroVec, oneVec, emptyDocument, parseDocument, validateDocumentLinks } from './model';
import { composeTransform, convertAxisMatrix, convertRotationQuaternion, identityMatrix, invertMatrix, matrixToTransform, quaternionFromEuler, quaternionToEuler, yUpToZUpVector, zUpToYUpVector } from './scene-math';

/** Local glTF 2.0 authoring, with bounded binary decoding and no browser loader. */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_EXPORT_BYTES = MAX_IMPORT_BYTES;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TEXTURE_BYTES = 64 * 1024 * 1024;
const MAX_ACCESSOR_VALUES = 16_000_000;
const MAX_TOTAL_VALUES = 32_000_000;
const MAX_RECORDS = 10000;
const SUPPORTED_EXTENSIONS = new Set(['KHR_texture_transform', 'KHR_materials_emissive_strength']);

type GltfRecord = Record<string, any>;
interface GltfJson extends GltfRecord {
  asset: { version: string; minVersion?: string };
  accessors?: GltfRecord[]; bufferViews?: GltfRecord[]; buffers?: GltfRecord[];
  meshes?: GltfRecord[]; nodes?: GltfRecord[]; materials?: GltfRecord[];
  textures?: GltfRecord[]; images?: GltfRecord[]; samplers?: GltfRecord[];
  skins?: GltfRecord[]; animations?: GltfRecord[]; scenes?: GltfRecord[];
  extensionsRequired?: string[];
}
export interface ImportedMesh {
  name: string; positions: number[]; normals: number[]; indices: number[];
  uvs?: number[]; skinIndices?: number[]; skinWeights?: number[];
  material?: { name: string; baseColor: number[]; metallic: number; roughness: number };
}
export type ImportedScene = Pick<Model3DDocument, 'meshes' | 'materials' | 'objects' | 'textures' | 'skins' | 'clips'>;
/** The optional scene payload preserves rich data through the existing array API. */
export type ImportedMeshes = ImportedMesh[] & { scene?: ImportedScene };
export interface ExportDocumentOptions { objects?: string[]; meshes?: Record<string, MeshBlock> }

export function extensionOf(path: string): string { return extname(String(path)).toLowerCase(); }
async function assertReadableFile(path: string, cap = MAX_IMPORT_BYTES): Promise<void> {
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  if (info.size > cap) throw new Error(`${path} exceeds the ${cap / 1024 / 1024} MiB import limit`);
}
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid glTF ${label}.`);
  return value;
}
function finiteVector(value: unknown, size: number, fallback: number[], label: string): number[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length !== size || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`Invalid glTF ${label}.`);
  return [...value];
}
function scalar(value: unknown, fallback: number, label: string, min = -Infinity, max = Infinity): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid glTF ${label}.`);
  return value;
}
function record(value: unknown, label: string): GltfRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid glTF ${label}.`);
  return value as GltfRecord;
}
function assertExtensions(value: GltfRecord, allowed: string[], label: string): void {
  if (value.extensions === undefined) return;
  for (const key of Object.keys(record(value.extensions, `${label} extensions`))) if (!allowed.includes(key)) throw new Error(`Unsupported glTF ${label} extension: ${key}.`);
}
function table(json: GltfJson, key: string): GltfRecord[] {
  const values = json[key];
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_RECORDS) throw new Error(`Invalid or excessive glTF ${key}.`);
  return values.map((value, index) => record(value, `${key}[${index}]`));
}
function axisValues(values: number[], width = 3, importing = true, scale = false): number[] {
  const result = [...values];
  for (let i = 0; i < values.length; i += width) {
    result[i] = values[i]!;
    result[i + 1] = scale ? values[i + 2]! : importing ? -values[i + 2]! : values[i + 2]!;
    result[i + 2] = scale ? values[i + 1]! : importing ? values[i + 1]! : -values[i + 1]!;
  }
  return result;
}

/** Intrinsic XYZ rotation, followed by scale and translation, matching the panel. */
export function transformGeometry(positions: Float32Array, normals: Float32Array,
  transform: { location: number[]; rotation_euler: number[]; scale: number[]; matrix?: number[] }): { positions: Float32Array; normals: Float32Array } {
  const vector = (values: number[], fallback: number): { x: number; y: number; z: number } => ({ x: values[0] ?? fallback, y: values[1] ?? fallback, z: values[2] ?? fallback });
  const matrix = transform.matrix ?? composeTransform({ location: vector(transform.location, 0), rotationEuler: vector(transform.rotation_euler, 0), scale: vector(transform.scale, 1) });
  const outPositions = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) for (let axis = 0; axis < 3; axis++) outPositions[i + axis] = matrix[axis]! * positions[i]! + matrix[4 + axis]! * positions[i + 1]! + matrix[8 + axis]! * positions[i + 2]! + matrix[12 + axis]!;
  const outNormals = new Float32Array(normals);
  if (normals.length === positions.length) {
    const inverse = invertMatrix(matrix);
    for (let i = 0; i < normals.length; i += 3) {
      const x = inverse[0]! * normals[i]! + inverse[1]! * normals[i + 1]! + inverse[2]! * normals[i + 2]!;
      const y = inverse[4]! * normals[i]! + inverse[5]! * normals[i + 1]! + inverse[6]! * normals[i + 2]!;
      const z = inverse[8]! * normals[i]! + inverse[9]! * normals[i + 1]! + inverse[10]! * normals[i + 2]!;
      const length = Math.hypot(x, y, z) || 1;
      outNormals.set([x / length, y / length, z / length], i);
    }
  }
  return { positions: outPositions, normals: outNormals };
}

function readContainer(bytes: Buffer, path: string): { json: GltfJson; binary?: Buffer } {
  const glb = extensionOf(path) === '.glb' || bytes.length >= 4 && bytes.readUInt32LE(0) === 0x46546c67;
  if (!glb) return { json: record(JSON.parse(bytes.toString('utf8')), 'document') as GltfJson };
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a complete GLB container.');
  if (bytes.readUInt32LE(4) !== 2) throw new Error('GLB version 2 is required.');
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error('GLB declared length does not match the file.');
  let json: GltfJson | undefined, binary: Buffer | undefined, offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('GLB has a truncated chunk header.');
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    if (length % 4 || end > bytes.length) throw new Error('GLB chunk is misaligned or exceeds the file.');
    if (offset === 12 && type !== 0x4e4f534a) throw new Error('GLB must start with a JSON chunk.');
    if (type === 0x4e4f534a) {
      if (json) throw new Error('GLB contains duplicate JSON chunks.');
      json = record(JSON.parse(bytes.subarray(start, end).toString('utf8')), 'document') as GltfJson;
    } else if (type === 0x004e4942) {
      if (binary) throw new Error('GLB contains duplicate binary chunks.');
      binary = bytes.subarray(start, end);
    }
    offset = end;
  }
  if (!json) throw new Error('GLB has no JSON chunk.');
  return { json, binary };
}
interface ImportContext { json: GltfJson; buffers: Buffer[]; root: string; bytes: number; decodedValues: number; accessors: Map<number, number[]> }
async function readUri(uri: unknown, context: ImportContext, cap: number): Promise<{ bytes: Buffer; mime?: string }> {
  if (typeof uri !== 'string') throw new Error('glTF resource has no valid URI.');
  const data = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  let bytes: Buffer, mime: string | undefined;
  if (data) {
    if (data[2]!.length > Math.ceil(cap * 4 / 3) + 4 || data[2]!.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data[2]!)) throw new Error('Invalid or oversized glTF data URI.');
    bytes = Buffer.from(data[2]!, 'base64'); mime = data[1];
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.includes('?') || uri.includes('#') || uri.includes('\0')) throw new Error('Only embedded or local relative glTF resources are allowed.');
    let decoded: string;
    try { decoded = decodeURIComponent(uri); } catch { throw new Error('Invalid glTF resource URI encoding.'); }
    if (isAbsolute(decoded) || decoded.includes('\\')) throw new Error('Absolute glTF resource paths are not allowed.');
    const candidate = resolve(context.root, decoded), relativePath = relative(context.root, candidate);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('glTF resource escapes its asset directory.');
    const actual = await realpath(candidate), actualRelative = relative(context.root, actual);
    if (actualRelative.startsWith('..') || isAbsolute(actualRelative)) throw new Error('glTF resource symlink escapes its asset directory.');
    await assertReadableFile(actual, cap); bytes = await readFile(actual);
  }
  if (bytes.length > cap) throw new Error('glTF resource exceeds its size limit.');
  context.bytes += bytes.length;
  if (context.bytes > MAX_IMPORT_BYTES) throw new Error('glTF resources exceed the aggregate 256 MiB limit.');
  return { bytes, ...(mime ? { mime } : {}) };
}
async function loadContext(path: string): Promise<ImportContext> {
  await assertReadableFile(path);
  const actual = await realpath(path), bytes = await readFile(actual);
  const { json, binary } = readContainer(bytes, path);
  if (json.asset?.version !== '2.0') throw new Error('glTF asset version 2.0 is required.');
  if (json.asset.minVersion && json.asset.minVersion !== '2.0') throw new Error('The glTF minimum version is unsupported.');
  if (json.extensionsRequired !== undefined && (!Array.isArray(json.extensionsRequired) || json.extensionsRequired.some(name => typeof name !== 'string' || !SUPPORTED_EXTENSIONS.has(name)))) throw new Error(`This glTF requires unsupported extensions: ${String(json.extensionsRequired)}.`);
  assertExtensions(json, [], 'document');
  for (const key of ['accessors', 'bufferViews', 'buffers', 'meshes', 'nodes', 'materials', 'textures', 'images', 'samplers', 'skins', 'animations', 'scenes']) table(json, key);
  const context: ImportContext = { json, buffers: [], root: dirname(actual), bytes: bytes.length, decodedValues: 0, accessors: new Map() };
  for (const [index, buffer] of table(json, 'buffers').entries()) {
    assertExtensions(buffer, [], 'buffer');
    const length = integer(buffer.byteLength, 'buffer byteLength', 0, MAX_IMPORT_BYTES);
    const payload = buffer.uri !== undefined ? (await readUri(buffer.uri, context, MAX_IMPORT_BYTES)).bytes : index === 0 && binary ? binary : undefined;
    if (!payload || payload.length < length || buffer.uri === undefined && payload.length > length + 3) throw new Error('glTF buffer length does not match its resource.');
    context.buffers.push(payload.subarray(0, length));
  }
  for (const [index] of table(json, 'bufferViews').entries()) bufferView(context, index);
  return context;
}
function bufferView(context: ImportContext, index: number): { view: GltfRecord; bytes: Buffer } {
  const view = context.json.bufferViews?.[integer(index, 'bufferView index')];
  if (!view) throw new Error(`glTF bufferView ${index} is missing.`);
  assertExtensions(view, [], 'bufferView');
  const buffer = context.buffers[integer(view.buffer, 'buffer index')];
  const offset = integer(view.byteOffset ?? 0, 'bufferView offset'), length = integer(view.byteLength, 'bufferView length');
  if (!buffer || offset + length > buffer.length) throw new Error('glTF bufferView exceeds its buffer.');
  return { view, bytes: buffer.subarray(offset, offset + length) };
}
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENT_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function component(bytes: Buffer, offset: number, kind: number, normalized: boolean): number {
  let value: number;
  switch (kind) {
    case 5120: value = bytes.readInt8(offset); return normalized ? Math.max(-1, value / 127) : value;
    case 5121: value = bytes.readUInt8(offset); return normalized ? value / 255 : value;
    case 5122: value = bytes.readInt16LE(offset); return normalized ? Math.max(-1, value / 32767) : value;
    case 5123: value = bytes.readUInt16LE(offset); return normalized ? value / 65535 : value;
    case 5125: return bytes.readUInt32LE(offset);
    case 5126: return bytes.readFloatLE(offset);
    default: throw new Error('Unsupported glTF accessor component type.');
  }
}
function readAccessor(context: ImportContext, index: number, width?: number): number[] {
  integer(index, 'accessor index');
  const accessor = context.json.accessors?.[index];
  if (!accessor) throw new Error(`glTF accessor ${index} is missing.`);
  assertExtensions(accessor, [], 'accessor');
  const components = COMPONENT_COUNT[accessor.type], bytesPerComponent = COMPONENT_BYTES[accessor.componentType];
  if (!components || !bytesPerComponent || width !== undefined && components !== width) throw new Error(`glTF accessor ${index} has an unsupported or mismatched type.`);
  if (accessor.type === 'MAT4' && accessor.componentType !== 5126 || accessor.normalized && ![5120, 5121, 5122, 5123].includes(accessor.componentType)) throw new Error('Invalid glTF matrix or normalized component type.');
  if (accessor.normalized !== undefined && typeof accessor.normalized !== 'boolean') throw new Error('glTF accessor normalization must be boolean.');
  const cached = context.accessors.get(index); if (cached) return cached;
  const count = integer(accessor.count, 'accessor count', 1, MAX_ACCESSOR_VALUES), length = count * components;
  if (length > MAX_ACCESSOR_VALUES || (context.decodedValues += length) > MAX_TOTAL_VALUES) throw new Error('glTF decoded accessor data exceeds its limit.');
  const values = new Array<number>(length).fill(0), itemBytes = components * bytesPerComponent;
  const offset = integer(accessor.byteOffset ?? 0, 'accessor offset');
  const decode = (bytes: Buffer, start: number, stride: number, into: number[], items: number): void => {
    if (start % bytesPerComponent || stride < itemBytes || start + (items - 1) * stride + itemBytes > bytes.length) throw new Error('glTF accessor reads outside its bufferView or is misaligned.');
    for (let item = 0; item < items; item++) for (let c = 0; c < components; c++) {
      const value = component(bytes, start + item * stride + c * bytesPerComponent, accessor.componentType, accessor.normalized === true);
      if (!Number.isFinite(value)) throw new Error('glTF accessor contains non-finite values.');
      into[item * components + c] = value;
    }
  };
  if (accessor.bufferView !== undefined) {
    const { view, bytes } = bufferView(context, accessor.bufferView);
    const stride = view.byteStride === undefined ? itemBytes : integer(view.byteStride, 'byteStride', 4, 252);
    if (view.byteStride !== undefined && (stride % 4 || stride % bytesPerComponent)) throw new Error('glTF accessor has an invalid interleaved stride.');
    if (((view.byteOffset ?? 0) + offset) % bytesPerComponent) throw new Error('glTF accessor is not component-aligned.');
    decode(bytes, offset, stride, values, count);
  } else if (offset || !accessor.sparse) throw new Error('glTF accessor has no bufferView or sparse data.');
  if (accessor.sparse !== undefined) {
    const sparse = record(accessor.sparse, 'sparse accessor'), sparseCount = integer(sparse.count, 'sparse count', 1, count);
    const indices = record(sparse.indices, 'sparse indices'), replacements = record(sparse.values, 'sparse values');
    if (![5121, 5123, 5125].includes(indices.componentType)) throw new Error('glTF sparse indices must be unsigned integers.');
    const iv = bufferView(context, indices.bufferView), vv = bufferView(context, replacements.bufferView);
    if (iv.view.byteStride !== undefined || vv.view.byteStride !== undefined) throw new Error('Sparse glTF bufferViews cannot have a byteStride.');
    const io = integer(indices.byteOffset ?? 0, 'sparse indices offset'), vo = integer(replacements.byteOffset ?? 0, 'sparse values offset'), ib = COMPONENT_BYTES[indices.componentType]!;
    if (io % ib || ((iv.view.byteOffset ?? 0) + io) % ib || io + sparseCount * ib > iv.bytes.length || ((vv.view.byteOffset ?? 0) + vo) % bytesPerComponent) throw new Error('Invalid glTF sparse accessor bounds or alignment.');
    const decoded = new Array<number>(sparseCount * components); decode(vv.bytes, vo, itemBytes, decoded, sparseCount);
    let previous = -1;
    for (let i = 0; i < sparseCount; i++) {
      const target = component(iv.bytes, io + i * ib, indices.componentType, false);
      if (target <= previous || target >= count) throw new Error('glTF sparse indices are not unique, ascending and in range.');
      for (let c = 0; c < components; c++) values[target * components + c] = decoded[i * components + c]!;
      previous = target;
    }
  }
  context.accessors.set(index, values); return values;
}
function attribute(context: ImportContext, index: number, width: number, kinds: number[], label: string): number[] {
  const values = readAccessor(context, index, width), a = context.json.accessors![index]!;
  if (!kinds.includes(a.componentType) || a.componentType !== 5126 && a.normalized !== true && label !== 'joints' && label !== 'indices') throw new Error(`glTF ${label} has an invalid component type or normalization.`);
  if ((label === 'joints' || label === 'indices') && a.normalized) throw new Error(`glTF ${label} cannot be normalized.`);
  return values;
}
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 255]! ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function validateImage(bytes: Buffer, mime: string): { width: number; height: number } {
  let width = 0, height = 0;
  if (mime === 'image/png') {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid glTF PNG image.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let offset = 8, data = false, ended = false;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) throw new Error('Truncated glTF PNG chunk.');
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length, kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (end > bytes.length || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw new Error('Invalid glTF PNG chunk bounds or checksum.');
      if (kind === 'IHDR' && (offset !== 8 || length !== 13)) throw new Error('Invalid glTF PNG header.');
      if (kind === 'IDAT') data = true;
      if (kind === 'IEND') { if (length !== 0 || end !== bytes.length) throw new Error('Invalid glTF PNG end chunk.'); ended = true; }
      offset = end;
    }
    if (!data || !ended) throw new Error('Incomplete glTF PNG image.');
  } else if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) throw new Error('Invalid glTF JPEG image.');
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7) break;
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else throw new Error(`Unsupported glTF image MIME type: ${mime}.`);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64_000_000) throw new Error('glTF image dimensions are invalid or exceed the pixel limit.');
  return { width, height };
}
/** Shared image inspection for bounded local texture imports. */
export function inspectTextureImage(bytes: Buffer, mimeType: string): { width: number; height: number } {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Texture image exceeds the 32 MiB limit.');
  return validateImage(bytes, mimeType);
}
async function importTextures(context: ImportContext, doc: Model3DDocument): Promise<string[]> {
  const images: Array<{ mimeType: Texture3D['mimeType']; dataBase64: string; width: number; height: number }> = []; let total = 0;
  for (const image of table(context.json, 'images')) {
    assertExtensions(image, [], 'image');
    if ((image.uri === undefined) === (image.bufferView === undefined)) throw new Error('glTF image needs exactly one resource source.');
    let bytes: Buffer, mime: string | undefined = image.mimeType;
    if (image.uri !== undefined) { const resource = await readUri(image.uri, context, MAX_IMAGE_BYTES); bytes = resource.bytes; mime ??= resource.mime; }
    else bytes = bufferView(context, image.bufferView).bytes;
    if (bytes.length > MAX_IMAGE_BYTES || (total += bytes.length) > MAX_TEXTURE_BYTES) throw new Error('glTF texture image data exceeds its limit.');
    if (!mime) mime = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : undefined;
    const dimensions = validateImage(bytes, mime ?? 'unknown');
    images.push({ mimeType: mime as Texture3D['mimeType'], dataBase64: bytes.toString('base64'), ...dimensions });
  }
  return table(context.json, 'textures').map((texture, index) => {
    assertExtensions(texture, [], 'texture');
    const image = images[integer(texture.source, 'texture source')];
    if (!image) throw new Error('glTF texture references a missing image.');
    const name = safeName(texture.name, `Texture_${index + 1}`, Object.keys(doc.textures!));
    const sampler = texture.sampler === undefined ? undefined : context.json.samplers?.[integer(texture.sampler, 'sampler index')];
    if (texture.sampler !== undefined && !sampler) throw new Error('glTF texture references a missing sampler.');
    if (sampler) assertExtensions(sampler, [], 'sampler');
    doc.textures![name] = { name, ...image, ...(sampler ? { sampler: {
      ...(sampler.magFilter !== undefined ? { magFilter: sampler.magFilter } : {}), ...(sampler.minFilter !== undefined ? { minFilter: sampler.minFilter } : {}),
      ...(sampler.wrapS !== undefined ? { wrapS: sampler.wrapS } : {}), ...(sampler.wrapT !== undefined ? { wrapT: sampler.wrapT } : {}),
    } } : {}) };
    return name;
  });
}
function textureSlot(raw: GltfRecord, textures: string[], kind: string): TextureSlot3D {
  assertExtensions(raw, ['KHR_texture_transform'], 'textureInfo');
  const texture = textures[integer(raw.index, 'texture index')]; if (!texture) throw new Error('glTF material references a missing texture.');
  const slot: TextureSlot3D = { texture, texCoord: integer(raw.texCoord ?? 0, 'texture coordinate set', 0, 1) };
  if (kind === 'normalTexture') slot.scale = scalar(raw.scale, 1, 'normal scale');
  if (kind === 'occlusionTexture') slot.strength = scalar(raw.strength, 1, 'occlusion strength', 0, 1);
  const transform = raw.extensions?.KHR_texture_transform;
  if (transform !== undefined) {
    const t = record(transform, 'texture transform');
    slot.transform = { offset: finiteVector(t.offset, 2, [0, 0], 'texture offset'), scale: finiteVector(t.scale, 2, [1, 1], 'texture scale'), rotation: scalar(t.rotation, 0, 'texture rotation'),
      ...(t.texCoord !== undefined ? { texCoord: integer(t.texCoord, 'texture transform coordinate set', 0, 1) } : {}) };
  }
  return slot;
}
function importMaterials(context: ImportContext, doc: Model3DDocument, textures: string[]): string[] {
  return table(context.json, 'materials').map((raw, index) => {
    assertExtensions(raw, ['KHR_materials_emissive_strength'], 'material');
    const name = safeName(raw.name, `Material_${index + 1}`, Object.keys(doc.materials));
    const pbr = raw.pbrMetallicRoughness === undefined ? {} : record(raw.pbrMetallicRoughness, 'PBR material'); assertExtensions(pbr, [], 'PBR material');
    const baseColor = finiteVector(pbr.baseColorFactor, 4, [1, 1, 1, 1], 'base color');
    const emissiveColor = finiteVector(raw.emissiveFactor, 3, [0, 0, 0], 'emissive color');
    if ([...baseColor, ...emissiveColor].some(value => value < 0 || value > 1)) throw new Error('glTF material factors must be within 0–1.');
    const material: Material3D = { name, baseColor, metallic: scalar(pbr.metallicFactor, 1, 'metallic factor', 0, 1), roughness: scalar(pbr.roughnessFactor, 1, 'roughness factor', 0, 1),
      emissiveColor, emissiveStrength: scalar(raw.extensions?.KHR_materials_emissive_strength?.emissiveStrength, 1, 'emissive strength', 0), alpha: baseColor[3]!,
      alphaMode: raw.alphaMode ?? 'OPAQUE', alphaCutoff: scalar(raw.alphaCutoff, 0.5, 'alpha cutoff', 0, 1), doubleSided: raw.doubleSided === true };
    if (!['OPAQUE', 'MASK', 'BLEND'].includes(material.alphaMode!)) throw new Error('Invalid glTF alpha mode.');
    for (const key of ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'] as const) {
      const info = key === 'baseColorTexture' || key === 'metallicRoughnessTexture' ? pbr[key] : raw[key];
      if (info !== undefined) material[key] = textureSlot(record(info, 'textureInfo'), textures, key);
    }
    doc.materials[name] = material; return name;
  });
}
function importMeshes(context: ImportContext, doc: Model3DDocument, materials: string[]): string[] {
  let fallbackMaterial: string | undefined;
  return table(context.json, 'meshes').map((raw, meshIndex) => {
    assertExtensions(raw, [], 'mesh');
    if (!Array.isArray(raw.primitives) || !raw.primitives.length || raw.primitives.length > 1024) throw new Error('glTF mesh has invalid or excessive primitives.');
    const name = safeName(raw.name, `Mesh_${meshIndex + 1}`, Object.keys(doc.meshes));
    const block: MeshBlock = { name, primitive: null, primitiveParams: {}, positions: [], indices: [], materials: [], groups: [] };
    const shared = new Map<string, { offset: number; count: number }>();
    const attributes: Array<[string, keyof MeshBlock, number, number[]]> = [['NORMAL', 'normals', 3, [5126]], ['TEXCOORD_0', 'uvs', 2, [5126, 5121, 5123]], ['TEXCOORD_1', 'uvs1', 2, [5126, 5121, 5123]], ['TANGENT', 'tangents', 4, [5126]], ['JOINTS_0', 'skinIndices', 4, [5121, 5123]], ['WEIGHTS_0', 'skinWeights', 4, [5126, 5121, 5123]], ['COLOR_0', 'colors', 4, [5126, 5121, 5123]]];
    let morphCount: number | undefined, hasSkin: boolean | undefined;
    for (const rawPrimitive of raw.primitives) {
      const primitive = record(rawPrimitive, 'primitive'); assertExtensions(primitive, [], 'primitive');
      if (primitive.mode !== undefined && primitive.mode !== 4) throw new Error(`Only TRIANGLES primitives are supported (found mode ${primitive.mode}).`);
      const attrs = record(primitive.attributes, 'primitive attributes');
      for (const key of Object.keys(attrs)) if (!['POSITION', ...attributes.map(a => a[0])].includes(key)) throw new Error(`Unsupported glTF vertex attribute: ${key}.`);
      const rawPositions = attribute(context, attrs.POSITION, 3, [5126], 'positions');
      const vertexCount = rawPositions.length / 3;
      const isSkinned = attrs.JOINTS_0 !== undefined || attrs.WEIGHTS_0 !== undefined;
      if (isSkinned && (attrs.JOINTS_0 === undefined || attrs.WEIGHTS_0 === undefined) || hasSkin !== undefined && isSkinned !== hasSkin) throw new Error('All primitives in a skinned mesh need matching joint and weight attributes.');
      hasSkin = isSkinned;
      const targets = primitive.targets ?? [];
      if (!Array.isArray(targets) || targets.length > 128 || morphCount !== undefined && targets.length !== morphCount) throw new Error('glTF mesh has inconsistent or excessive morph targets.');
      morphCount = targets.length;
      const sorted = (value: GltfRecord): GltfRecord => Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
      const signature = JSON.stringify([sorted(attrs), targets.map((target: unknown) => sorted(record(target, 'morph target')))]);
      let allocation = shared.get(signature);
      if (!allocation) {
        const offset = block.positions!.length / 3; allocation = { offset, count: vertexCount }; shared.set(signature, allocation);
        for (const value of axisValues(rawPositions)) block.positions!.push(value);
        for (const [semantic, field, width, kinds] of attributes) {
          let values: number[] | undefined;
          if (attrs[semantic] !== undefined) {
            const accessor = context.json.accessors?.[attrs[semantic]];
            const readWidth = semantic === 'COLOR_0' && accessor?.type === 'VEC3' ? 3 : width;
            values = attribute(context, attrs[semantic], readWidth, kinds, semantic === 'JOINTS_0' ? 'joints' : semantic);
            if (values.length !== vertexCount * readWidth) throw new Error('glTF vertex attributes have mismatched counts.');
            if (semantic === 'NORMAL' || semantic === 'TANGENT') values = axisValues(values, width);
            if (readWidth === 3 && semantic === 'COLOR_0') values = values.flatMap((_, i, all) => i % 3 === 0 ? [all[i]!, all[i + 1]!, all[i + 2]!, 1] : []);
          }
          const data = block[field] as number[] | undefined;
          if (values || data) {
            const into = data ?? new Array<number>(offset * width).fill(field === 'colors' ? 1 : 0);
            for (const value of values ?? new Array<number>(vertexCount * width).fill(field === 'colors' ? 1 : 0)) into.push(value);
            (block as unknown as Record<string, unknown>)[field] = into;
          }
        }
        if (targets.length) {
          block.morphTargets ??= targets.map((_: unknown, i: number) => ({ name: typeof raw.extras?.targetNames?.[i] === 'string' ? raw.extras.targetNames[i] : `Morph_${i + 1}` }));
          targets.forEach((rawTarget: unknown, i: number) => {
            const target = record(rawTarget, 'morph target'), out = block.morphTargets![i]!;
            for (const key of Object.keys(target)) if (key !== 'POSITION' && key !== 'NORMAL') throw new Error(`Unsupported glTF morph attribute: ${key}.`);
            for (const [semantic, field] of [['POSITION', 'positions'], ['NORMAL', 'normals']] as const) {
              const values = target[semantic] === undefined ? undefined : axisValues(attribute(context, target[semantic], 3, [5126], 'morph delta'));
              if (values && values.length !== vertexCount * 3) throw new Error('glTF morph target vertex count does not match its base.');
              if (values || out[field]) { out[field] ??= new Array<number>(offset * 3).fill(0); for (const value of values ?? new Array<number>(vertexCount * 3).fill(0)) out[field]!.push(value); }
            }
          });
        }
      }
      const indices = primitive.indices === undefined ? Array.from({ length: vertexCount }, (_, i) => i) : attribute(context, primitive.indices, 1, [5121, 5123, 5125], 'indices');
      if (indices.length % 3 || indices.some(i => !Number.isInteger(i) || i < 0 || i >= vertexCount)) throw new Error('glTF primitive has invalid triangle indices.');
      let material: string;
      if (primitive.material !== undefined) { material = materials[integer(primitive.material, 'material index')]!; if (!material) throw new Error('glTF primitive references a missing material.'); }
      else { fallbackMaterial ??= safeName('Material', 'Material', Object.keys(doc.materials)); material = fallbackMaterial; doc.materials[material] ??= { ...defaultMaterial(material), baseColor: [1, 1, 1, 1], metallic: 1, roughness: 1 }; }
      const shading = doc.materials[material]!;
      for (const slot of ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'] as const) if (shading[slot]) {
        const coord = shading[slot]!.transform?.texCoord ?? shading[slot]!.texCoord ?? 0;
        if (attrs[`TEXCOORD_${coord}`] === undefined) throw new Error('Textured glTF primitive is missing its texture coordinate attribute.');
      }
      let materialIndex = block.materials.indexOf(material); if (materialIndex < 0) { materialIndex = block.materials.length; block.materials.push(material); }
      block.groups!.push({ start: block.indices!.length, count: indices.length, materialIndex });
      for (const index of indices) block.indices!.push(index + allocation.offset);
    }
    if (raw.weights !== undefined) finiteVector(raw.weights, morphCount ?? 0, [], 'mesh morph weights');
    doc.meshes[name] = block; return name;
  });
}
function importNodes(context: ImportContext, doc: Model3DDocument, meshes: string[]): string[] {
  const nodes = table(context.json, 'nodes');
  if (table(context.json, 'scenes').length > 1) throw new Error('Multiple glTF scenes are not supported in a single document.');
  const names = nodes.map((node, i) => {
    const name = safeName(node.name, `Node_${i + 1}`, doc.objects.map(o => o.name));
    assertExtensions(node, [], 'node');
    if (node.camera !== undefined) throw new Error('glTF cameras are not supported by this import.');
    let transform: Object3DRecord['transform'];
    if (node.matrix !== undefined) {
      if (node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined) throw new Error('glTF node cannot combine matrix and TRS transforms.');
      const matrix = finiteVector(node.matrix, 16, [], 'node matrix');
      transform = matrixToTransform(convertAxisMatrix(matrix, true));
    } else {
      const translation = yUpToZUpVector(finiteVector(node.translation, 3, [0, 0, 0], 'node translation'));
      const rotation = finiteVector(node.rotation, 4, [0, 0, 0, 1], 'node rotation');
      if (Math.abs(Math.hypot(...rotation) - 1) > 1e-4) throw new Error('glTF node rotation quaternion is not normalized.');
      const quaternion = convertRotationQuaternion(rotation, true);
      const scale = axisValues(finiteVector(node.scale, 3, [1, 1, 1], 'node scale'), 3, true, true);
      transform = { location: { x: translation[0]!, y: translation[1]!, z: translation[2]! }, rotationEuler: quaternionToEuler(quaternion), rotationQuaternion: quaternion, scale: { x: scale[0]!, y: scale[1]!, z: scale[2]! } };
    }
    const mesh = node.mesh === undefined ? undefined : meshes[integer(node.mesh, 'node mesh')];
    if (node.mesh !== undefined && !mesh) throw new Error('glTF node references a missing mesh.');
    const out: Object3DRecord = { name, type: mesh ? 'MESH' : 'EMPTY', ...(mesh ? { mesh } : {}), transform, modifiers: [], visible: true };
    const defaultWeights = node.weights ?? (node.mesh === undefined ? undefined : context.json.meshes?.[node.mesh]?.weights);
    if (defaultWeights !== undefined) out.morphInfluences = finiteVector(defaultWeights, mesh ? doc.meshes[mesh]!.morphTargets?.length ?? 0 : 0, [], 'node morph weights');
    doc.objects.push(out); return name;
  });
  for (const [index, node] of nodes.entries()) {
    if (node.children !== undefined && (!Array.isArray(node.children) || node.children.length > MAX_RECORDS)) throw new Error('Invalid glTF node children.');
    for (const child of node.children ?? []) {
      const childName = names[integer(child, 'child node')]; if (!childName) throw new Error('glTF child node is missing.');
      const out = doc.objects[child]!; if (out.parent !== undefined) throw new Error('glTF node has multiple parents.'); out.parent = names[index]!;
    }
  }
  for (const scene of table(context.json, 'scenes')) {
    assertExtensions(scene, [], 'scene');
    if (scene.nodes !== undefined && !Array.isArray(scene.nodes)) throw new Error('Invalid glTF scene roots.');
    for (const index of scene.nodes ?? []) if (!names[integer(index, 'scene node')] || doc.objects[index]!.parent) throw new Error('Invalid glTF scene root.');
  }
  if (context.json.scene !== undefined) integer(context.json.scene, 'scene index', 0, Math.max(0, table(context.json, 'scenes').length - 1));
  if (!nodes.length) for (const mesh of meshes) doc.objects.push({ name: safeName(mesh, mesh, doc.objects.map(o => o.name)), mesh, type: 'MESH', transform: { location: zeroVec(), rotationEuler: zeroVec(), scale: oneVec() }, modifiers: [], visible: true });
  return names;
}
function importSkins(context: ImportContext, doc: Model3DDocument, nodes: string[]): void {
  const names = table(context.json, 'skins').map((raw, index) => {
    assertExtensions(raw, [], 'skin');
    if (!Array.isArray(raw.joints) || !raw.joints.length || raw.joints.length > 1024) throw new Error('glTF skin has invalid or excessive joints.');
    const joints = raw.joints.map((j: unknown) => { const name = nodes[integer(j, 'skin joint')]; if (!name) throw new Error('glTF skin joint is missing.'); doc.objects[Number(j)]!.joint = true; return name; });
    if (new Set(joints).size !== joints.length) throw new Error('glTF skin contains duplicate joints.');
    const bind = raw.inverseBindMatrices === undefined ? joints.flatMap(() => identityMatrix()) : attribute(context, raw.inverseBindMatrices, 16, [5126], 'inverse bind matrices');
    if (bind.length !== joints.length * 16) throw new Error('glTF skin inverse-bind count does not match its joints.');
    const inverseBindMatrices: number[] = []; for (let i = 0; i < bind.length; i += 16) inverseBindMatrices.push(...convertAxisMatrix(bind.slice(i, i + 16), true));
    const name = safeName(raw.name, `Skin_${index + 1}`, Object.keys(doc.skins!));
    const skeleton = raw.skeleton === undefined ? undefined : nodes[integer(raw.skeleton, 'skin skeleton')];
    if (raw.skeleton !== undefined && !skeleton) throw new Error('glTF skin skeleton is missing.');
    doc.skins![name] = { name, joints, inverseBindMatrices, ...(skeleton ? { skeleton } : {}) }; return name;
  });
  table(context.json, 'nodes').forEach((node, index) => { if (node.skin !== undefined) { const skin = names[integer(node.skin, 'node skin')]; if (!skin) throw new Error('glTF node references a missing skin.'); doc.objects[index]!.skin = skin; } });
}
function animationValues(values: number[], path: AnimationTrack3D['path'], importing: boolean): number[] {
  if (path === 'weights') return [...values];
  if (path !== 'rotation') return axisValues(values, 3, importing, path === 'scale');
  const result: number[] = []; for (let i = 0; i < values.length; i += 4) result.push(...convertRotationQuaternion(values.slice(i, i + 4), importing)); return result;
}
function importAnimations(context: ImportContext, doc: Model3DDocument, nodes: string[]): void {
  table(context.json, 'animations').forEach((animation, index) => {
    assertExtensions(animation, [], 'animation');
    if (!Array.isArray(animation.channels) || !Array.isArray(animation.samplers) || animation.channels.length > MAX_RECORDS || animation.samplers.length > MAX_RECORDS) throw new Error('Invalid or excessive glTF animation records.');
    const name = safeName(animation.name, `Clip_${index + 1}`, Object.keys(doc.clips!));
    const tracks: AnimationTrack3D[] = [], seen = new Set<string>();
    for (const rawChannel of animation.channels) {
      const channel = record(rawChannel, 'animation channel'); assertExtensions(channel, [], 'animation channel');
      const target = record(channel.target, 'animation target'); assertExtensions(target, [], 'animation target');
      const object = nodes[integer(target.node, 'animation target node')]; if (!object) throw new Error('glTF animation target is missing.');
      if (!['translation', 'rotation', 'scale', 'weights'].includes(target.path)) throw new Error(`Unsupported glTF animation path: ${target.path}.`);
      const path = target.path as AnimationTrack3D['path'];
      if (seen.has(`${object}/${path}`)) throw new Error('glTF animation has duplicate channels for one target path.'); seen.add(`${object}/${path}`);
      if (path !== 'weights' && doc.objects[Number(target.node)]!.transform.matrix) throw new Error('glTF TRS animation cannot target a matrix node.');
      const sampler = record(animation.samplers[integer(channel.sampler, 'animation sampler')], 'animation sampler'); assertExtensions(sampler, [], 'animation sampler');
      const interpolation = sampler.interpolation ?? 'LINEAR'; if (!['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation)) throw new Error('Unsupported glTF animation interpolation.');
      const times = attribute(context, sampler.input, 1, [5126], 'animation times');
      if (times.some((t, i) => t < 0 || i > 0 && t <= times[i - 1]!)) throw new Error('glTF animation times must be nonnegative and strictly increasing.');
      const out = doc.objects[Number(target.node)]!, width = path === 'rotation' ? 4 : path === 'weights' ? (out.mesh ? doc.meshes[out.mesh]!.morphTargets?.length ?? 0 : 0) : 3;
      const values = attribute(context, sampler.output, path === 'weights' ? 1 : width, [5126], 'animation values');
      if (!width || values.length !== times.length * width * (interpolation === 'CUBICSPLINE' ? 3 : 1)) throw new Error('glTF animation keyframe counts do not match.');
      if (path === 'rotation') for (let i = interpolation === 'CUBICSPLINE' ? 4 : 0; i < values.length; i += interpolation === 'CUBICSPLINE' ? 12 : 4) if (Math.abs(Math.hypot(...values.slice(i, i + 4)) - 1) > 1e-4) throw new Error('glTF animation rotation key is not normalized.');
      tracks.push({ object, path, times: [...times], values: animationValues(values, path, true), interpolation });
    }
    doc.clips![name] = { name, tracks };
  });
}

/** Import rich local .glb/.gltf data without baking hierarchy or rigging. */
export async function importGltfScene(path: string): Promise<ImportedScene> {
  const context = await loadContext(path), doc = emptyDocument('', 'Imported', '');
  const textures = await importTextures(context, doc), materials = importMaterials(context, doc, textures);
  const meshes = importMeshes(context, doc, materials); if (!meshes.length) throw new Error('This glTF contains no triangle meshes.');
  const nodes = importNodes(context, doc, meshes); importSkins(context, doc, nodes); importAnimations(context, doc, nodes);
  const parsed = parseDocument(doc);
  return { meshes: parsed.meshes, materials: parsed.materials, objects: parsed.objects, textures: parsed.textures, skins: parsed.skins, clips: parsed.clips };
}
export async function importGltf(path: string): Promise<ImportedMeshes> {
  const scene = await importGltfScene(path);
  const imported: ImportedMeshes = Object.values(scene.meshes).map(mesh => {
    const material = mesh.materials[0] ? scene.materials[mesh.materials[0]] : undefined;
    return { name: mesh.name, positions: mesh.positions!, normals: mesh.normals ?? [], indices: mesh.indices!, ...(mesh.uvs ? { uvs: mesh.uvs } : {}), ...(mesh.skinIndices ? { skinIndices: mesh.skinIndices, skinWeights: mesh.skinWeights } : {}),
      ...(material ? { material: { name: material.name, baseColor: material.baseColor, metallic: material.metallic, roughness: material.roughness } } : {}) };
  });
  imported.scene = scene; return imported;
}

/** Merge rich scene datablocks with collision-safe remapping of every reference. */
export function mergeImported(doc: Model3DDocument, imported: ImportedMesh[], origin: string): string[] {
  const scene = (imported as ImportedMeshes).scene;
  if (!scene) {
    const local = emptyDocument('', 'Imported', '');
    for (const item of imported) {
      if (!item.positions.length || !item.indices.length) continue;
      const name = safeName(item.name, 'Imported', Object.keys(local.meshes));
      const material = item.material ? safeName(item.material.name, 'Material', Object.keys(local.materials)) : undefined;
      if (material) local.materials[material] = { ...defaultMaterial(material), ...item.material!, name: material };
      local.meshes[name] = { name, primitive: null, primitiveParams: {}, positions: [...item.positions], indices: [...item.indices], ...(item.normals.length === item.positions.length ? { normals: [...item.normals] } : {}), ...(item.uvs ? { uvs: [...item.uvs] } : {}), materials: material ? [material] : [] };
      local.objects.push({ name, mesh: name, type: 'MESH', transform: { location: zeroVec(), rotationEuler: zeroVec(), scale: oneVec() }, modifiers: [], visible: true });
    }
    if (!local.objects.length) throw new Error('The import produced no usable geometry.');
    const array = [...imported] as ImportedMeshes; array.scene = local; return mergeImported(doc, array, origin);
  }
  doc.textures ??= {}; doc.skins ??= {}; doc.clips ??= {};
  const mapNames = (source: Record<string, unknown>, taken: string[], fallback: string): Map<string, string> => {
    const map = new Map<string, string>(); for (const key of Object.keys(source)) { const name = safeName(key, fallback, taken); map.set(key, name); taken.push(name); } return map;
  };
  const textures = mapNames(scene.textures ?? {}, Object.keys(doc.textures), 'Texture'), materials = mapNames(scene.materials, Object.keys(doc.materials), 'Material');
  const meshes = mapNames(scene.meshes, Object.keys(doc.meshes), 'Mesh'), skins = mapNames(scene.skins ?? {}, Object.keys(doc.skins), 'Skin'), clips = mapNames(scene.clips ?? {}, Object.keys(doc.clips), 'Clip');
  const objects = mapNames(Object.fromEntries(scene.objects.map(o => [o.name, o])), doc.objects.map(o => o.name), 'Object');
  for (const [name, texture] of Object.entries(scene.textures ?? {})) doc.textures[textures.get(name)!] = { ...structuredClone(texture), name: textures.get(name)! };
  for (const [name, material] of Object.entries(scene.materials)) {
    const next = structuredClone(material); next.name = materials.get(name)!;
    for (const slot of ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'] as const) if (next[slot]) next[slot]!.texture = textures.get(next[slot]!.texture)!;
    doc.materials[next.name] = next;
  }
  for (const [name, mesh] of Object.entries(scene.meshes)) { const next = structuredClone(mesh); next.name = meshes.get(name)!; next.materials = next.materials.map(m => materials.get(m)!); doc.meshes[next.name] = next; }
  for (const source of scene.objects) {
    const next = structuredClone(source); next.name = objects.get(source.name)!;
    if (next.mesh) next.mesh = meshes.get(next.mesh)!; if (next.parent) next.parent = objects.get(next.parent)!; if (next.skin) next.skin = skins.get(next.skin)!;
    doc.objects.push(next);
  }
  for (const [name, skin] of Object.entries(scene.skins ?? {})) { const next = structuredClone(skin); next.name = skins.get(name)!; next.joints = next.joints.map(j => objects.get(j)!); if (next.skeleton) next.skeleton = objects.get(next.skeleton)!; doc.skins[next.name] = next; }
  for (const [name, clip] of Object.entries(scene.clips ?? {})) { const next = structuredClone(clip); next.name = clips.get(name)!; next.tracks.forEach(track => { track.object = objects.get(track.object)!; }); doc.clips[next.name] = next; }
  validateDocumentLinks(doc); void origin; return scene.objects.map(o => objects.get(o.name)!);
}

class GltfWriter {
  parts: Buffer[] = []; views: GltfRecord[] = []; accessors: GltfRecord[] = []; length = 0;
  append(bytes: Buffer, target?: number): number {
    const padding = (4 - this.length % 4) % 4;
    if (padding) { this.parts.push(Buffer.alloc(padding)); this.length += padding; }
    if (this.length + bytes.length > MAX_EXPORT_BYTES) throw new Error('The export exceeds the 256 MiB limit.');
    const index = this.views.length;
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length, ...(target ? { target } : {}) });
    this.parts.push(bytes); this.length += bytes.length; return index;
  }
  accessor(values: number[], width: number, type: string, componentType = 5126, target?: number, bounds = false): number {
    const stride = COMPONENT_BYTES[componentType]!;
    if (!values.length || values.length % width || values.length > MAX_ACCESSOR_VALUES) throw new Error('Cannot export an empty, mismatched or oversized accessor.');
    const bytes = Buffer.alloc(values.length * stride);
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      if (!Number.isFinite(value)) throw new Error('Cannot export a non-finite attribute.');
      if (componentType === 5126) {
        if (!Number.isFinite(Math.fround(value))) throw new Error('An exported attribute exceeds float32 range.'); bytes.writeFloatLE(value, i * stride);
      } else if (componentType === 5123) bytes.writeUInt16LE(integer(value, 'exported joint index', 0, 65535), i * stride);
      else bytes.writeUInt32LE(integer(value, 'exported vertex index', 0, 0xffffffff), i * stride);
    }
    const accessor: GltfRecord = { bufferView: this.append(bytes, target), componentType, count: values.length / width, type };
    if (bounds) {
      accessor.min = new Array<number>(width).fill(Infinity); accessor.max = new Array<number>(width).fill(-Infinity);
      for (let i = 0; i < values.length; i++) { const axis = i % width; accessor.min[axis] = Math.min(accessor.min[axis], values[i]!); accessor.max[axis] = Math.max(accessor.max[axis], values[i]!); }
    }
    this.accessors.push(accessor); return this.accessors.length - 1;
  }
  binary(): Buffer { const padding = (4 - this.length % 4) % 4; return Buffer.concat([...this.parts, Buffer.alloc(padding)]); }
}
function selectedObjects(doc: Model3DDocument, requested?: string[]): Object3DRecord[] {
  const byName = new Map(doc.objects.map(object => [object.name, object]));
  const selected = new Set(requested ?? doc.objects.map(object => object.name));
  for (const name of selected) if (!byName.has(name)) throw new Error(`Export object '${name}' is missing.`);
  const roots = new Set(selected);
  for (const object of doc.objects) {
    let parent = object.parent, depth = 0;
    while (parent && depth++ < 256) { if (roots.has(parent)) { selected.add(object.name); break; } parent = byName.get(parent)?.parent; }
  }
  const include = (name: string): void => {
    const object = byName.get(name); if (!object) throw new Error(`Export dependency '${name}' is missing.`);
    selected.add(name); if (object.parent && !selected.has(object.parent)) include(object.parent);
  };
  for (const name of [...selected]) {
    const object = byName.get(name)!; include(name);
    if (object.skin) { const skin = doc.skins?.[object.skin]; if (!skin) throw new Error(`Export skin '${object.skin}' is missing.`); skin.joints.forEach(include); if (skin.skeleton) include(skin.skeleton); }
  }
  return doc.objects.filter(object => selected.has(object.name));
}
/** Native frame tracks become a named clip at the scene's time origin. */
function exportClips(doc: Model3DDocument): AnimationClip3D[] {
  const clips = Object.values(doc.clips ?? {}), tracks: AnimationTrack3D[] = [];
  for (const object of doc.objects) {
    const targeted = new Set<string>();
    for (const [nativePath, keys] of Object.entries(object.animation ?? {})) {
      if (!keys.length) continue;
      const path: AnimationTrack3D['path'] = nativePath === 'location' ? 'translation'
        : nativePath === 'rotation_euler' || nativePath === 'rotation_quaternion' ? 'rotation'
          : nativePath === 'scale' ? 'scale' : nativePath === 'morph_weights' ? 'weights'
            : (() => { throw new Error(`Unsupported native animation path '${nativePath}'.`); })();
      if (targeted.has(path)) throw new Error(`Object '${object.name}' has conflicting native rotation tracks.`);
      targeted.add(path);
      const width = path === 'weights' ? (object.mesh ? doc.meshes[object.mesh]?.morphTargets?.length ?? 0 : 0) : nativePath === 'rotation_quaternion' ? 4 : 3;
      const ordered = [...keys].sort((a, b) => a.frame - b.frame);
      if (!width || ordered.some((key, i) => key.value.length !== width || key.frame < doc.scene.frameStart || i > 0 && key.frame <= ordered[i - 1]!.frame)) throw new Error(`Native animation '${object.name}.${nativePath}' has invalid values, duplicate frames or keys before scene.frameStart.`);
      let sampled = ordered;
      if (nativePath === 'rotation_euler' && ordered.length > 1) {
        // Sampling at the authoring frame rate preserves multi-axis Euler poses;
        // converting just endpoints would change the interpolation path.
        const first = ordered[0]!.frame, last = ordered.at(-1)!.frame;
        if (last - first > 10000) throw new Error('Native Euler animation exceeds the 10000-frame sampling limit.');
        sampled = []; let next = 1;
        for (let frame = first; frame <= last; frame++) {
          while (next < ordered.length - 1 && ordered[next]!.frame < frame) next++;
          const a = ordered[next - 1]!, b = ordered[next]!, t = (frame - a.frame) / (b.frame - a.frame);
          sampled.push({ frame, value: a.value.map((value, i) => value + (b.value[i]! - value) * t) });
        }
      }
      const times = sampled.map(key => (key.frame - doc.scene.frameStart) / doc.scene.fps);
      const values: number[] = []; let previous: number[] | undefined;
      for (const key of sampled) {
        let value = nativePath === 'rotation_euler' ? quaternionFromEuler(key.value[0]!, key.value[1]!, key.value[2]!) : [...key.value];
        if (path === 'rotation') {
          if (Math.abs(Math.hypot(...value) - 1) > 1e-4) throw new Error('Native quaternion animation requires normalized keys.');
          if (previous && value.reduce((sum, component, i) => sum + component * previous![i]!, 0) < 0) value = value.map(component => -component);
          previous = value;
        }
        for (const component of value) values.push(component);
      }
      tracks.push({ object: object.name, path, times, values, interpolation: 'LINEAR' });
    }
  }
  if (tracks.length) clips.push({ name: safeName('Scene animation', 'Scene animation', clips.map(clip => clip.name)), tracks });
  return clips;
}
function encodeScene(doc: Model3DDocument, options: ExportDocumentOptions): { json: GltfRecord; binary: Buffer } {
  validateDocumentLinks(doc);
  const writer = new GltfWriter(), objects = selectedObjects(doc, options.objects), clips = exportClips(doc);
  const nodeIndex = new Map(objects.map((object, index) => [object.name, index]));
  const meshIndex = new Map<string, number>(), materialIndex = new Map<string, number>(), textureIndex = new Map<string, number>(), skinIndex = new Map<string, number>();
  const meshes: GltfRecord[] = [], materials: GltfRecord[] = [], textures: GltfRecord[] = [], images: GltfRecord[] = [], samplers: GltfRecord[] = [], skins: GltfRecord[] = [], extensions = new Set<string>();
  const imageIndex = new Map<string, number>();
  const writeTexture = (name: string): number => {
    const existing = textureIndex.get(name); if (existing !== undefined) return existing;
    const texture = doc.textures?.[name]; if (!texture) throw new Error(`Texture '${name}' is missing.`);
    const bytes = Buffer.from(texture.dataBase64, 'base64'); if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Export texture exceeds its size limit.'); validateImage(bytes, texture.mimeType);
    const hash = createHash('sha256').update(texture.mimeType).update(bytes).digest('hex'); let source = imageIndex.get(hash);
    if (source === undefined) { source = images.length; images.push({ name: texture.name, bufferView: writer.append(bytes), mimeType: texture.mimeType }); imageIndex.set(hash, source); }
    const index = textures.length; textures.push({ name: texture.name, source, ...(texture.sampler ? { sampler: samplers.length } : {}) });
    if (texture.sampler) samplers.push({ ...texture.sampler }); textureIndex.set(name, index); return index;
  };
  const writeSlot = (slot: TextureSlot3D): GltfRecord => {
    const result: GltfRecord = { index: writeTexture(slot.texture), ...(slot.texCoord !== undefined ? { texCoord: slot.texCoord } : {}), ...(slot.scale !== undefined ? { scale: slot.scale } : {}), ...(slot.strength !== undefined ? { strength: slot.strength } : {}) };
    if (slot.transform) { result.extensions = { KHR_texture_transform: structuredClone(slot.transform) }; extensions.add('KHR_texture_transform'); }
    return result;
  };
  const writeMaterial = (name: string): number => {
    const existing = materialIndex.get(name); if (existing !== undefined) return existing;
    const material = doc.materials[name]; if (!material) throw new Error(`Material '${name}' is missing.`);
    const baseColor = [material.baseColor[0]!, material.baseColor[1]!, material.baseColor[2]!, material.alpha];
    if ([...baseColor, material.metallic, material.roughness, ...material.emissiveColor].some(value => !Number.isFinite(value) || value < 0 || value > 1) || !Number.isFinite(material.emissiveStrength) || material.emissiveStrength < 0) throw new Error(`Material '${name}' has invalid PBR factors.`);
    const output: GltfRecord = { name: material.name, pbrMetallicRoughness: { baseColorFactor: baseColor, metallicFactor: material.metallic, roughnessFactor: material.roughness }, emissiveFactor: material.emissiveColor,
      alphaMode: material.alphaMode ?? (material.alpha < 1 ? 'BLEND' : 'OPAQUE'), ...(material.alphaCutoff !== undefined ? { alphaCutoff: material.alphaCutoff } : {}), doubleSided: material.doubleSided ?? false };
    for (const slot of ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'] as const) if (material[slot]) {
      const info = writeSlot(material[slot]!); if (slot === 'baseColorTexture' || slot === 'metallicRoughnessTexture') output.pbrMetallicRoughness[slot] = info; else output[slot] = info;
    }
    if (material.emissiveStrength !== 1) { output.extensions = { KHR_materials_emissive_strength: { emissiveStrength: material.emissiveStrength } }; extensions.add('KHR_materials_emissive_strength'); }
    const index = materials.length; materials.push(output); materialIndex.set(name, index); return index;
  };
  const writeMesh = (name: string): number => {
    const existing = meshIndex.get(name); if (existing !== undefined) return existing;
    const mesh = options.meshes?.[name] ?? doc.meshes[name]; if (!mesh?.positions?.length) throw new Error(`Mesh '${name}' requires evaluated geometry before export.`);
    const attributes: GltfRecord = { POSITION: writer.accessor(axisValues(mesh.positions, 3, false), 3, 'VEC3', 5126, 34962, true) };
    for (const [field, semantic, width, componentType] of [
      ['normals', 'NORMAL', 3, 5126], ['uvs', 'TEXCOORD_0', 2, 5126], ['uvs1', 'TEXCOORD_1', 2, 5126], ['tangents', 'TANGENT', 4, 5126], ['colors', 'COLOR_0', 4, 5126], ['skinIndices', 'JOINTS_0', 4, 5123], ['skinWeights', 'WEIGHTS_0', 4, 5126],
    ] as const) if (mesh[field]) {
      const values = field === 'normals' || field === 'tangents' ? axisValues(mesh[field]!, width, false) : mesh[field]!;
      if (values.length !== mesh.positions.length / 3 * width) throw new Error(`Mesh '${name}' has mismatched attributes.`);
      attributes[semantic] = writer.accessor(values, width, `VEC${width}`, componentType, 34962);
    }
    const indices = mesh.indices ?? Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
    if (indices.length % 3 || indices.some(i => !Number.isInteger(i) || i < 0 || i >= mesh.positions!.length / 3)) throw new Error(`Mesh '${name}' has invalid triangle indices.`);
    const targets = mesh.morphTargets?.map(target => {
      const output: GltfRecord = {};
      for (const [field, semantic] of [['positions', 'POSITION'], ['normals', 'NORMAL']] as const) if (target[field]) {
        if (target[field]!.length !== mesh.positions!.length) throw new Error('Morph target count does not match exported base mesh.');
        output[semantic] = writer.accessor(axisValues(target[field]!, 3, false), 3, 'VEC3', 5126, 34962);
      }
      if (!Object.keys(output).length) throw new Error('Cannot export an empty morph target.'); return output;
    });
    const groups = mesh.groups?.length ? mesh.groups : [{ start: 0, count: indices.length, materialIndex: 0 }];
    let cursor = 0;
    const primitives = [...groups].sort((a, b) => a.start - b.start).map(group => {
      if (group.start !== cursor || group.count % 3 || group.count < 0 || group.start + group.count > indices.length) throw new Error(`Mesh '${name}' material groups overlap or leave geometry uncovered.`);
      cursor += group.count;
      const material = mesh.materials[group.materialIndex];
      return { attributes, indices: writer.accessor(indices.slice(group.start, group.start + group.count), 1, 'SCALAR', 5125, 34963), mode: 4, ...(material ? { material: writeMaterial(material) } : {}), ...(targets?.length ? { targets } : {}) };
    });
    if (cursor !== indices.length) throw new Error(`Mesh '${name}' material groups do not cover all triangles.`);
    const index = meshes.length; meshes.push({ name: mesh.name, primitives, ...(targets?.length ? { extras: { targetNames: mesh.morphTargets!.map((target, i) => target.name ?? `Morph_${i + 1}`) } } : {}) }); meshIndex.set(name, index); return index;
  };
  const writeSkin = (name: string): number => {
    const existing = skinIndex.get(name); if (existing !== undefined) return existing;
    const skin = doc.skins?.[name]; if (!skin) throw new Error(`Skin '${name}' is missing.`);
    const matrices: number[] = [];
    for (let i = 0; i < skin.inverseBindMatrices.length; i += 16) matrices.push(...convertAxisMatrix(skin.inverseBindMatrices.slice(i, i + 16), false));
    const joints = skin.joints.map(joint => { const index = nodeIndex.get(joint); if (index === undefined) throw new Error('Export selection omitted a skin joint.'); return index; });
    const index = skins.length; skins.push({ name: skin.name, joints, inverseBindMatrices: writer.accessor(matrices, 16, 'MAT4'), ...(skin.skeleton ? { skeleton: nodeIndex.get(skin.skeleton) } : {}) }); skinIndex.set(name, index); return index;
  };
  const animatedTRS = new Set(clips.flatMap(clip => clip.tracks.filter(track => track.path !== 'weights').map(track => track.object)));
  const nodes = objects.map(object => {
    if (object.type === 'CAMERA' || object.type === 'LIGHT') throw new Error('Export cameras and lights are not supported by the glTF scene writer.');
    const node: GltfRecord = { name: object.name };
    if (object.mesh) node.mesh = writeMesh(object.mesh);
    if (object.transform.matrix) {
      if (animatedTRS.has(object.name)) throw new Error(`Animated object '${object.name}' needs a TRS transform rather than a matrix.`);
      node.matrix = convertAxisMatrix(object.transform.matrix, false);
    } else {
      node.translation = zUpToYUpVector([object.transform.location.x, object.transform.location.y, object.transform.location.z]);
      const q = object.transform.rotationQuaternion ?? matrixToTransform(composeTransform({ ...object.transform, scale: oneVec(), location: zeroVec() })).rotationQuaternion!;
      node.rotation = convertRotationQuaternion(q, false);
      node.scale = [object.transform.scale.x, object.transform.scale.z, object.transform.scale.y];
    }
    if (object.skin) node.skin = writeSkin(object.skin);
    if (object.morphInfluences) node.weights = [...object.morphInfluences];
    const children = objects.filter(child => child.parent === object.name).map(child => nodeIndex.get(child.name)!); if (children.length) node.children = children;
    return node;
  });
  if (!meshes.length) throw new Error('Nothing to export: the selection has no geometry.');
  const animations = clips.map(clip => {
    const channels: GltfRecord[] = [], animationSamplers: GltfRecord[] = [];
    for (const track of clip.tracks) {
      const target = nodeIndex.get(track.object); if (target === undefined) continue;
      const values = animationValues(track.values, track.path, false), width = track.path === 'rotation' ? 4 : track.path === 'weights' ? 1 : 3;
      if (track.times.some((time, i) => i > 0 && Math.fround(time) <= Math.fround(track.times[i - 1]!))) throw new Error('Animation times collapse after float32 conversion.');
      animationSamplers.push({ input: writer.accessor(track.times, 1, 'SCALAR', 5126, undefined, true), output: writer.accessor(values, width, width === 1 ? 'SCALAR' : `VEC${width}`), interpolation: track.interpolation });
      channels.push({ sampler: animationSamplers.length - 1, target: { node: target, path: track.path } });
    }
    return { name: clip.name, channels, samplers: animationSamplers };
  }).filter(clip => clip.channels.length);
  const binary = writer.binary();
  const json: GltfRecord = { asset: { version: '2.0', generator: 'Klaus 3D Studio' }, scene: 0, scenes: [{ nodes: objects.filter(object => !object.parent || !nodeIndex.has(object.parent)).map(object => nodeIndex.get(object.name)!) }],
    nodes, meshes, materials, accessors: writer.accessors, bufferViews: writer.views, buffers: [{ byteLength: binary.length }],
    ...(textures.length ? { textures, images, samplers } : {}), ...(skins.length ? { skins } : {}), ...(animations.length ? { animations } : {}), ...(extensions.size ? { extensionsUsed: [...extensions], extensionsRequired: [...extensions] } : {}) };
  return { json, binary };
}
function glbPayload(json: GltfRecord, binary: Buffer): Buffer {
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 0x20)]);
  const length = 12 + 8 + jsonBytes.length + 8 + binary.length;
  if (length > MAX_EXPORT_BYTES) throw new Error('The export exceeds the 256 MiB limit.');
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBytes.length); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binary.length); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBytes, bh, binary]);
}
/** Export local datablocks with hierarchy, instances, PBR, rigging and clips. */
export async function exportDocumentGlb(path: string, doc: Model3DDocument, options: ExportDocumentOptions = {}): Promise<number> {
  // Validation also bounds externally constructed documents before allocation.
  const parsed = parseDocument(doc), { json, binary } = encodeScene(parsed, options);
  let payload: Buffer;
  if (extensionOf(path) === '.gltf') { json.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`; payload = Buffer.from(JSON.stringify(json), 'utf8'); }
  else payload = glbPayload(json, binary);
  if (payload.length > MAX_EXPORT_BYTES) throw new Error('The export exceeds the 256 MiB limit.');
  await mkdir(dirname(resolve(path)), { recursive: true }); await writeFile(path, payload); return payload.length;
}
export const exportDocumentGltf = exportDocumentGlb;
/** Backward-compatible geometry export; callers with a document use the rich API. */
export async function exportGlb(path: string, entries: Array<{ name: string; positions: Float32Array; normals: Float32Array; indices: Uint32Array; material?: { baseColor: number[]; metallic: number; roughness: number; name: string }; uvs?: Float32Array }>): Promise<number> {
  const doc = emptyDocument('', 'Exported', '');
  for (const entry of entries) {
    if (!entry.positions.length) continue;
    const name = safeName(entry.name, 'Mesh', Object.keys(doc.meshes)); let material: string | undefined;
    if (entry.material) { material = safeName(entry.material.name, 'Material', Object.keys(doc.materials)); doc.materials[material] = { ...defaultMaterial(material), ...entry.material, name: material, alpha: entry.material.baseColor[3] ?? 1 }; }
    doc.meshes[name] = { name, primitive: null, primitiveParams: {}, positions: Array.from(entry.positions), indices: Array.from(entry.indices), ...(entry.normals.length === entry.positions.length ? { normals: Array.from(entry.normals) } : {}), ...(entry.uvs ? { uvs: Array.from(entry.uvs) } : {}), materials: material ? [material] : [] };
    doc.objects.push({ name, type: 'MESH', mesh: name, transform: { location: zeroVec(), rotationEuler: zeroVec(), scale: oneVec() }, modifiers: [], visible: true });
  }
  if (!doc.objects.length) throw new Error('Nothing to export: the selection has no evaluated geometry.');
  return exportDocumentGlb(path, doc);
}

/** OBJ import: v / vn / f lines, triangulated with a simple fan. */
export async function importObj(path: string): Promise<ImportedMesh[]> {
  await assertReadableFile(path);
  const text = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  const positions: number[][] = [];
  const normals: number[][] = [];
  const faces: Array<Array<{ v: number; n: number }>> = [];
  let currentName = 'Mesh';
  const groups = new Map<string, Array<Array<{ v: number; n: number }>>>();
  groups.set(currentName, faces);

  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const keyword = parts[0];
    if (keyword === 'v') {
      const [x, y, z] = parts.slice(1).map(Number);
      if (![x, y, z].every(Number.isFinite)) throw new Error('OBJ has a malformed vertex line.');
      // OBJ is Y-up right-handed; this document is Z-up. Swap so an imported
      // model stands upright in the document.
      positions.push([x!, -z!, y!]);
    } else if (keyword === 'vn') {
      const [x, y, z] = parts.slice(1).map(Number);
      if (![x, y, z].every(Number.isFinite)) throw new Error('OBJ has a malformed normal line.');
      normals.push([x!, -z!, y!]);
    } else if (keyword === 'o' || keyword === 'g') {
      currentName = safeName(parts.slice(1).join(' ').trim(), `Mesh_${groups.size + 1}`, groups.keys());
      const existing = groups.get(currentName);
      if (!existing) {
        const created: Array<Array<{ v: number; n: number }>> = [];
        groups.set(currentName, created);
      }
    } else if (keyword === 'f') {
      const corners = parts.slice(1).map(entry => {
        const fields = entry.split('/');
        const v = Number(fields[0]);
        const n = fields[2] !== undefined && fields[2] !== '' ? Number(fields[2]) : 0;
        if (!Number.isFinite(v) || v === 0) throw new Error(`OBJ face references an invalid vertex: '${entry}'`);
        return { v: v > 0 ? v - 1 : positions.length + v, n: n > 0 ? n - 1 : n < 0 ? normals.length + n : -1 };
      });
      if (corners.length < 3) throw new Error('OBJ has a degenerate face.');
      (groups.get(currentName) ?? faces).push(corners);
    } else if (keyword === 'usemtl' || keyword === 'mtllib' || keyword === 's' || keyword === 'vt' || keyword === '#' || !keyword) {
      // Textures, materials libraries and smoothing groups are intentionally
      // skipped: OBJ materials live in a separate .mtl we do not read.
      continue;
    }
  }
  const meshes: ImportedMesh[] = [];
  for (const [name, groupFaces] of groups) {
    if (!groupFaces.length) continue;
    const outPositions: number[] = [];
    const outNormals: number[] = [];
    const outIndices: number[] = [];
    const indexByKey = new Map<string, number>();
    let completeNormals = true;
    for (const corners of groupFaces) {
      const indices: number[] = [];
      for (const corner of corners) {
        const position = positions[corner.v];
        if (!position) throw new Error(`OBJ face references vertex ${corner.v + 1}, which does not exist.`);
        const key = `${corner.v}/${corner.n}`;
        let index = indexByKey.get(key);
        if (index === undefined) {
          index = outPositions.length / 3;
          indexByKey.set(key, index);
          outPositions.push(position[0]!, position[1]!, position[2]!);
          const normal = corner.n >= 0 ? normals[corner.n] : undefined;
          if (!normal) completeNormals = false;
          outNormals.push(normal?.[0] ?? 0, normal?.[1] ?? 0, normal?.[2] ?? 0);
        }
        indices.push(index);
      }
      // Fan triangulation: correct for convex polygons, which is what nearly
      // every exporter writes. A concave polygon would need real ear-clipping.
      for (let index = 1; index + 1 < indices.length; index++) {
        outIndices.push(indices[0]!, indices[index]!, indices[index + 1]!);
      }
    }
    meshes.push({ name, positions: outPositions, normals: completeNormals ? outNormals : [], indices: outIndices });
  }
  if (!meshes.length) throw new Error('This OBJ contains no faces.');
  return meshes;
}


/** Export selected objects as Wavefront OBJ (text, Y-up like every other OBJ). */
export async function exportObj(
  path: string,
  entries: Array<{ name: string; positions: Float32Array; normals: Float32Array; indices: Uint32Array }>,
): Promise<number> {
  const lines: string[] = ['# Exported by Klaus 3D Studio'];
  let vertexOffset = 1;
  for (const entry of entries) {
    if (!entry.positions.length) continue;
    lines.push(`o ${entry.name}`);
    // Geometry arrives already baked into world space (Z-up document). OBJ is
    // Y-up right-handed, so swap once here — the same swap importGltf/exportGlb
    // use, so a round trip through either format preserves orientation.
    for (let vertex = 0; vertex < entry.positions.length; vertex += 3) {
      const x = (entry.positions[vertex]!).toFixed(6);
      const y = (entry.positions[vertex + 2]!).toFixed(6);
      const z = (-(entry.positions[vertex + 1]!)).toFixed(6);
      lines.push(`v ${x} ${y} ${z}`);
    }
    for (let vertex = 0; vertex < entry.normals.length; vertex += 3) {
      lines.push(`vn ${(entry.normals[vertex]!).toFixed(6)} ${(entry.normals[vertex + 2]!).toFixed(6)} ${(-entry.normals[vertex + 1]!).toFixed(6)}`);
    }
    const hasNormals = entry.normals.length === entry.positions.length;
    for (let index = 0; index + 2 < entry.indices.length; index += 3) {
      const a = (entry.indices[index]! + vertexOffset);
      const b = (entry.indices[index + 1]! + vertexOffset);
      const c = (entry.indices[index + 2]! + vertexOffset);
      lines.push(hasNormals ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
    }
    vertexOffset += entry.positions.length / 3;
  }
  if (vertexOffset === 1) throw new Error('Nothing to export: every selected object had empty geometry.');
  const text = lines.join('\n') + '\n';
  if (Buffer.byteLength(text) > MAX_EXPORT_BYTES) throw new Error('The export exceeds the 256 MiB limit.');
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, text, 'utf8');
  return Buffer.byteLength(text);
}


/** Count geometry after decoding an exported file. */
export async function verifyGlb(path: string): Promise<{ meshes: number; triangles: number }> {
  const imported = await importGltf(path);
  return { meshes: imported.length, triangles: imported.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0) };
}
