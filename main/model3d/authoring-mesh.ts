import type { MeshBlock, Vec3 } from './model';

/** Plain arrays make native authoring independent of the renderer and WASM. */
export interface AuthoringMesh extends MeshBlock {
  normals?: number[];
  uvs?: number[];
  uvs1?: number[];
  tangents?: number[];
  colors?: number[];
  skinIndices?: number[];
  skinWeights?: number[];
  groups?: Array<{ start: number; count: number; materialIndex: number }>;
  morphTargets?: Array<{ name?: string; positions?: number[]; normals?: number[] }>;
}

export const AUTHORING_LIMITS = { vertices: 500_000, triangles: 1_000_000, graphNodes: 128, strokes: 256 };
export const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
};
export function finiteVec(value: Vec3, label: string): Vec3 {
  if (!value || !['x', 'y', 'z'].every(key => typeof value[key as keyof Vec3] === 'number' && Number.isFinite(value[key as keyof Vec3]))) throw new Error(`${label} must contain finite x, y, z`);
  return { ...value };
}
export function positive(value: number, label: string): number {
  finite(value, label);
  if (value <= 0 || value > 1_000_000) throw new Error(`${label} must be greater than zero and at most 1000000`);
  return value;
}
export function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
export function validateAuthoringMesh(mesh: AuthoringMesh): void {
  const p = mesh.positions;
  if (!Array.isArray(p) || !p.length || p.length % 3 || p.length / 3 > AUTHORING_LIMITS.vertices || !p.every(Number.isFinite)) throw new Error('Authoring requires finite baked xyz positions within the vertex budget');
  const vertexCount = p.length / 3;
  const indices = mesh.indices;
  if (!Array.isArray(indices) || !indices.length || indices.length % 3 || indices.length / 3 > AUTHORING_LIMITS.triangles || !indices.every(i => Number.isInteger(i) && i >= 0 && i < vertexCount)) throw new Error('Authoring requires valid triangle indices within the triangle budget');
  for (const [key, width] of Object.entries({ normals: 3, uvs: 2, uvs1: 2, tangents: 4, skinIndices: 4, skinWeights: 4 })) {
    const values = mesh[key as keyof AuthoringMesh];
    if (values !== undefined && (!Array.isArray(values) || values.length !== vertexCount * width || !values.every(value => typeof value === 'number' && Number.isFinite(value)))) throw new Error(`${key} must contain ${width} finite values per vertex`);
  }
  if (mesh.colors !== undefined && (mesh.colors.length !== vertexCount * 3 && mesh.colors.length !== vertexCount * 4 || !mesh.colors.every(Number.isFinite))) throw new Error('colors must contain three or four finite values per vertex');
  if (mesh.skinIndices?.some(value => !Number.isInteger(value) || value < 0)) throw new Error('skinIndices must contain nonnegative integers');
  if (Boolean(mesh.skinIndices) !== Boolean(mesh.skinWeights)) throw new Error('skinIndices and skinWeights must be provided together');
  if (mesh.skinWeights) for (let i = 0; i < vertexCount; i++) {
    const weights = mesh.skinWeights.slice(i * 4, i * 4 + 4);
    if (weights.some(value => value < 0) || Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 0.001) throw new Error('Skin weights must be nonnegative and normalized per vertex');
  }
  for (const group of mesh.groups ?? []) if (![group.start, group.count, group.materialIndex].every(Number.isInteger) || group.start < 0 || group.count < 0 || group.start % 3 || group.count % 3 || group.start + group.count > indices.length || group.materialIndex < 0 || group.materialIndex >= mesh.materials.length) throw new Error('Material groups must address valid triangle ranges and material slots');
}

export function meshNormals(positions: readonly number[], indices: readonly number[]): number[] {
  const normals = Array<number>(positions.length).fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const abx = positions[b]! - positions[a]!, aby = positions[b + 1]! - positions[a + 1]!, abz = positions[b + 2]! - positions[a + 2]!;
    const acx = positions[c]! - positions[a]!, acy = positions[c + 1]! - positions[a + 1]!, acz = positions[c + 2]! - positions[a + 2]!;
    const x = aby * acz - abz * acy, y = abz * acx - abx * acz, z = abx * acy - aby * acx;
    for (const v of [a, b, c]) { normals[v] = normals[v]! + x; normals[v + 1] = normals[v + 1]! + y; normals[v + 2] = normals[v + 2]! + z; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    if (length > 1e-20) { normals[i] = normals[i]! / length; normals[i + 1] = normals[i + 1]! / length; normals[i + 2] = normals[i + 2]! / length; }
  }
  return normals;
}

export function cloneMesh(mesh: AuthoringMesh): AuthoringMesh { return structuredClone(mesh); }
export function customMesh(mesh: AuthoringMesh): AuthoringMesh { mesh.primitive = null; mesh.primitiveParams = {}; return mesh; }
export const edgeKey = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`;

/** Duplicate every known per-vertex channel with the same source-index map. */
export function duplicateMeshVertices(mesh: AuthoringMesh, source: readonly number[], indices: number[]): AuthoringMesh {
  const output = cloneMesh(mesh);
  const count = mesh.positions!.length / 3;
  const copy = (values: number[], width: number): number[] => source.flatMap(index => values.slice(index * width, (index + 1) * width));
  output.positions = copy(mesh.positions!, 3);
  for (const [key, width] of Object.entries({ normals: 3, uvs: 2, uvs1: 2, tangents: 4, skinIndices: 4, skinWeights: 4, colors: mesh.colors ? mesh.colors.length / count : 3 })) {
    const values = mesh[key as keyof AuthoringMesh];
    if (Array.isArray(values)) (output as unknown as Record<string, unknown>)[key] = copy(values as number[], width);
  }
  // A morph target may be stored as a named map or an ordered list; retain its
  // shape and duplicate only packed per-vertex numeric attribute arrays.
  const copyMorph = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (value.length === count * 3 && value.every(v => typeof v === 'number')) return copy(value as number[], 3);
      if (value.length === count * 4 && value.every(v => typeof v === 'number')) return copy(value as number[], 4);
      return value.map(copyMorph);
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyMorph(child)]));
    return value;
  };
  if (mesh.morphTargets !== undefined) output.morphTargets = copyMorph(mesh.morphTargets) as AuthoringMesh['morphTargets'];
  output.indices = indices;
  return customMesh(output);
}
