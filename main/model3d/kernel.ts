import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../ipc/contract';
import { string } from '../services/service-types';
import {
  geometryKey, type Material3D, type MeshBlock, type Model3DDocument, type Modifier3D, type Object3DRecord, type PrimitiveKind,
} from './model';
import { invertMatrix, multiplyMatrices, worldMatrixOf } from './scene-math';

/**
 * The evaluation kernel: manifold (CAD boolean/mesh) + rapier (physics), both
 * WASM, both running in the Electron MAIN process.
 *
 * Why the main process and not the renderer: the panel's CSP is
 * `script-src 'self' 'unsafe-inline'` with no `wasm-unsafe-eval`, so the renderer
 * cannot compile WASM. The host also has to own the single document copy anyway
 * (same as digram) so an agent edit and a panel drag cannot fork it.
 *
 * Both libraries are loaded by injecting the wasm bytes (manifold) or via their
 * inlined base64 (rapier-compat). Neither resolves a file path at runtime, which
 * is what makes them survive being packed into an asar archive.
 *
 * Transforms live on the object, while modifier evaluation is real work, so evaluated geometry
 * is cached by `geometryKey` — a content hash of the mesh and every modifier
 * that feeds it. A drag moves an object and re-evaluates nothing.
 */

/** Evaluated geometry, ready for three.js with zero base64 round-trip. */
export interface EvaluatedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Material name per triangle, indexing the object's material slots. */
  triMaterials: number[];
  geometryKey: string;
  uvs?: Float32Array;
  uvs1?: Float32Array;
  tangents?: Float32Array;
  colors?: Float32Array;
  skinIndices?: Uint32Array;
  skinWeights?: Float32Array;
  groups?: Array<{ start: number; count: number; materialIndex: number }>;
  morphTargets?: Array<{ name?: string; positions?: Float32Array; normals?: Float32Array }>;
}

type RichMesh = MeshBlock & {
  normals?: number[]; uvs?: number[]; uvs1?: number[]; tangents?: number[]; colors?: number[];
  skinIndices?: number[]; skinWeights?: number[];
  groups?: Array<{ start: number; count: number; materialIndex: number }>;
  morphTargets?: Array<{ name?: string; positions?: number[]; normals?: number[] }>;
};
type Point = [number, number, number];
const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const times = (a: Point, t: number): Point => [a[0] * t, a[1] * t, a[2] * t];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Point): number => Math.sqrt(dot(a, a));
const unit = (a: Point): Point => times(a, 1 / (length(a) || 1));
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Content and relative operand transforms must both invalidate evaluated geometry. */
function evaluationKey(doc: Model3DDocument, record: Object3DRecord): string {
  // Both sides use one dependency key so a returned buffer matches its request.
  return geometryKey(doc, record);
}

/** A modifier must not silently destroy surface or deformation authoring data. */
function requireBakeForAttributedMesh(mesh: RichMesh): void {
  if (mesh.uvs?.length || mesh.uvs1?.length || mesh.tangents?.length || mesh.colors?.length
    || mesh.skinIndices?.length || mesh.skinWeights?.length || mesh.morphTargets?.length
    || new Set(mesh.groups?.map(g => g.materialIndex)).size > 1) {
    throw new Error('Topology modifiers require a geometry-only bake of textured, colored, skinned, morphed or multi-material meshes; authored attributes were preserved.');
  }
}

function validateAuthoredMesh(mesh: RichMesh): void {
  const positions = mesh.positions ?? [], indices = mesh.indices ?? [], vertices = positions.length / 3;
  if (positions.length % 3 || !positions.every(Number.isFinite) || indices.length % 3
    || !indices.every(i => Number.isInteger(i) && i >= 0 && i < vertices)) throw new Error('Custom mesh has invalid finite triangle positions or indices.');
  for (const [name, width] of [['normals',3],['uvs',2],['uvs1',2],['tangents',4],['skinIndices',4],['skinWeights',4]] as const) {
    const data = mesh[name];
    if (data && (data.length !== vertices * width || !data.every(Number.isFinite))) throw new Error(`Custom mesh ${name} must have ${width} finite components per vertex.`);
  }
  if (mesh.colors && (mesh.colors.length !== vertices * 3 && mesh.colors.length !== vertices * 4 || !mesh.colors.every(Number.isFinite))) throw new Error('Custom mesh colors require three or four finite components per vertex.');
  if (mesh.skinIndices && !mesh.skinIndices.every(i => Number.isInteger(i) && i >= 0 && i <= 65535)) throw new Error('Custom mesh skin indices must be unsigned 16-bit joint indices.');
  if (mesh.skinWeights && !mesh.skinWeights.every(w => w >= 0)) throw new Error('Custom mesh skin weights must be nonnegative.');
  for (const group of mesh.groups ?? []) if (![group.start,group.count,group.materialIndex].every(Number.isInteger) || group.start < 0 || group.count < 0 || group.start % 3 || group.count % 3 || group.start + group.count > indices.length || group.materialIndex < 0 || group.materialIndex >= Math.max(1,mesh.materials.length)) throw new Error('Custom mesh material groups must address complete triangles and existing slots.');
  for (const target of mesh.morphTargets ?? []) for (const data of [target.positions,target.normals]) if (data && (data.length !== positions.length || !data.every(Number.isFinite))) throw new Error('Custom mesh morph deltas must have three finite components per vertex.');
}

function rawSolidMesh(solid: any): { positions: Point[]; indices: number[] } {
  const mesh = solid.getMesh(), stride = mesh.numProp;
  const positions: Point[] = [];
  for (let i = 0; i < mesh.vertProperties.length; i += stride) positions.push([mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]]);
  return { positions, indices: Array.from(mesh.triVerts) };
}

function checkedSolid(solid: any, operation: string): any {
  if (solid.status() !== 'NoError' || solid.isEmpty() || !Number.isFinite(solid.volume()) || solid.volume() <= 0) {
    throw new Error(`${operation} produced no valid volume; reduce the amount or revise the source geometry.`);
  }
  return solid;
}

function solidMesh(kernelInstance: Kernel, positions: Point[], indices: number[], operation: string): any {
  return checkedSolid(solidFromMesh(kernelInstance, positions.flat(), indices), operation);
}

function convexPlanes(solid: any): Array<{ normal: Point; point: Point }> | null {
  const hull = solid.hull();
  const volume = solid.volume(), difference = Math.abs(hull.volume() - volume);
  hull.delete();
  if (difference > Math.max(1e-7, volume * 1e-5)) return null;
  const { positions, indices } = rawSolidMesh(solid), planes: Array<{ normal: Point; point: Point }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < indices.length; i += 3) {
    const a = positions[indices[i]!]!, b = positions[indices[i + 1]!]!, c = positions[indices[i + 2]!]!;
    const normal = unit(cross(sub(b, a), sub(c, a)));
    const key = [...normal, dot(normal, a)].map(v => v.toFixed(7)).join(',');
    if (!seen.has(key)) { seen.add(key); planes.push({ normal, point: a }); }
  }
  return planes;
}

/** Match a face-count request by searching geometric tolerance, retaining nonempty candidates. */
function decimatedSolid(solid: any, ratio: number): any {
  const target = Math.max(4, Math.round(solid.numTri() * clamp(ratio, .01, 1)));
  if (target >= solid.numTri()) return solid;
  const bounds = solid.boundingBox();
  const diagonal = length(sub(bounds.max, bounds.min));
  let low = 0, high = diagonal, best = solid, difference = Math.abs(solid.numTri() - target);
  for (let iteration = 0; iteration < 24; iteration++) {
    const tolerance = (low + high) / 2, candidate = solid.simplify(tolerance);
    const valid = candidate.status() === 'NoError' && !candidate.isEmpty() && candidate.volume() > 0;
    const count = valid ? candidate.numTri() : 0;
    const distance = valid ? Math.abs(count - target) : Infinity;
    if (distance < difference || distance === difference && valid && count > best.numTri()) {
      if (best !== solid) best.delete();
      best = candidate; difference = distance;
    } else candidate.delete();
    if (count > target) low = tolerance; else high = tolerance;
    if (difference === 0) break;
  }
  return best;
}

/** Unique mesh edges, optionally omitting coplanar triangulation diagonals. */
function solidEdges(solid: any, sharpOnly = false): { positions: Point[]; edges: Array<{ a: number; b: number; normals: Point[] }> } {
  const { positions, indices } = rawSolidMesh(solid);
  const edges = new Map<string, { a: number; b: number; normals: Point[] }>();
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    const n = unit(cross(sub(positions[tri[1]!]!, positions[tri[0]!]!), sub(positions[tri[2]!]!, positions[tri[0]!]!)));
    for (let j = 0; j < 3; j++) {
      const a = tri[j]!, b = tri[(j + 1) % 3]!, key = `${Math.min(a, b)}/${Math.max(a, b)}`;
      const edge = edges.get(key);
      if (edge) edge.normals.push(n); else edges.set(key, { a, b, normals: [n] });
    }
  }
  return { positions, edges: [...edges.values()].filter(e => !sharpOnly || e.normals.length !== 2 || dot(e.normals[0]!, e.normals[1]!) < .999999) };
}

/** Convex chamfer/fillet: intersect real edge-cutting half-spaces. Width is a face distance. */
function beveledSolid(solid: any, width: number, segments: number, angle: number): any {
  if (!convexPlanes(solid)) throw new Error('Bevel currently requires a convex solid; split a concave mesh into convex parts first.');
  const { positions, edges } = solidEdges(solid, true);
  if (edges.length > 2048) throw new Error('Bevel exceeds the 2048 edge budget; decimate the geometry-only source first.');
  let result = solid;
  for (const edge of edges) {
    if (edge.normals.length !== 2) continue;
    const [a, b] = edge.normals as [Point, Point], theta = Math.acos(clamp(dot(a, b), -1, 1));
    if (theta * 180 / Math.PI < angle || theta < 1e-5 || theta > Math.PI - 1e-5) continue;
    const point = positions[edge.a]!, bisector = unit(add(a, b));
    const edgeLength = length(sub(positions[edge.a]!, positions[edge.b]!));
    const amount = Math.min(width, edgeLength * .45);
    const radius = amount / Math.tan(theta / 2), center = sub(point, times(bisector, radius / Math.cos(theta / 2)));
    for (let step = 1; step <= segments; step++) {
      const t = step / (segments + 1);
      const normal = unit(add(times(a, Math.sin((1 - t) * theta)), times(b, Math.sin(t * theta))));
      const offset = segments === 1 ? dot(normal, point) - amount * Math.sin(theta / 2) : dot(normal, center) + radius;
      const cut = result.trimByPlane(times(normal, -1), -offset);
      if (result !== solid) result.delete();
      result = checkedSolid(cut, 'Bevel');
    }
  }
  return result;
}

/** Replace the surface with closed edge tubes and optional spherical junctions. */
function wireframeSolid(kernelInstance: Kernel, solid: any, thickness: number, segments: number, diagonals: boolean): any {
  const { positions, edges } = solidEdges(solid, !diagonals);
  if (edges.length > 2048) throw new Error('Wireframe exceeds the 2048 edge budget; reduce the source mesh first.');
  const radius = thickness / 2, parts: any[] = [], junctions = new Set<number>();
  for (const { a, b } of edges) {
    const start = positions[a]!, direction = sub(positions[b]!, start), size = length(direction);
    if (size < 1e-9) continue;
    const z = unit(direction), x = unit(cross(Math.abs(z[2]) < .9 ? [0, 0, 1] : [0, 1, 0], z)), y = cross(z, x);
    const matrix = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, ...start, 1];
    parts.push(kernelInstance.Manifold.cylinder(size, radius, radius, segments).transform(matrix));
    junctions.add(a); junctions.add(b);
  }
  for (const i of junctions) parts.push(kernelInstance.Manifold.sphere(radius, segments).translate(positions[i]));
  const result = checkedSolid(kernelInstance.Manifold.union(parts), 'Wireframe');
  for (const part of parts) part.delete();
  return result;
}

function profileSection(kernelInstance: Kernel, solid: any, params: Record<string, Json>, radialOffset = 0): any {
  const profile = params.profile;
  if (Array.isArray(profile)) {
    if (profile.length < 3 || profile.length > 512 || !profile.every(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v)))) {
      throw new Error('A profile requires 3–512 finite [radius, height] or [x, y] points.');
    }
    return new kernelInstance.CrossSection([profile]).translate([radialOffset, 0]);
  }
  const bounds = solid.boundingBox();
  return solid.slice((bounds.min[2] + bounds.max[2]) / 2).translate([radialOffset, 0]);
}

/** Revolve a radial-height profile, or sweep its capped section along a true helix. */
function screwSolid(kernelInstance: Kernel, solid: any, params: Record<string, Json>, number_: (k: string, d: number) => number): any {
  const bounds = solid.boundingBox();
  const defaultRadius = (bounds.max[0] - bounds.min[0]) * .75;
  const profile = profileSection(kernelInstance, solid, params, Array.isArray(params.profile) ? 0 : number_('radius', defaultRadius));
  if (profile.isEmpty() || profile.bounds().min[0] < 0) throw new Error('Screw profile must be nonempty and stay on the positive radial side of its axis.');
  const turns = clamp(number_('turns', 1), .01, 8), pitch = number_('pitch', 0);
  const steps = Math.min(512, Math.max(8, Math.round(number_('segments', 64) * turns)));
  if (pitch === 0) return checkedSolid(kernelInstance.Manifold.revolve(profile, steps, Math.min(360, turns * 360)), 'Screw');
  const temp = kernelInstance.Manifold.extrude(profile, .001), raw = rawSolidMesh(temp);
  const section: Point[] = [], sectionByKey = new Map<string, number>(), cap: number[] = [];
  const sectionIndex = (i: number): number => {
    const p = raw.positions[i]!, key = `${p[0].toFixed(8)},${p[1].toFixed(8)}`;
    const found = sectionByKey.get(key); if (found !== undefined) return found;
    const index = section.length; section.push(p); sectionByKey.set(key, index); return index;
  };
  for (let i = 0; i < raw.indices.length; i += 3) {
    const tri = raw.indices.slice(i, i + 3);
    if (tri.every(v => Math.abs(raw.positions[v]![2] - .001) < 1e-7)) cap.push(...tri.map(sectionIndex));
  }
  temp.delete();
  if (!cap.length || section.length * (steps + 1) > 100000) throw new Error('Screw exceeds the capped 100000 vertex budget or has no usable profile.');
  if (turns > 1 && Math.abs(pitch) <= profile.bounds().max[1] - profile.bounds().min[1]) throw new Error('Helical turns overlap; increase pitch beyond the profile height.');
  const edgeMap = new Map<string, { a: number; b: number; count: number }>();
  for (let i = 0; i < cap.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = cap[i + j]!, b = cap[i + (j + 1) % 3]!, key = `${Math.min(a, b)}/${Math.max(a, b)}`;
    const edge = edgeMap.get(key); if (edge) edge.count++; else edgeMap.set(key, { a, b, count: 1 });
  }
  const positions: Point[] = [], indices: number[] = [], n = section.length;
  for (let i = 0; i <= steps; i++) {
    const angle = i / steps * Math.PI * 2 * turns;
    for (const [radius, z] of section) positions.push([radius * Math.cos(angle), radius * Math.sin(angle), z + pitch * angle / (2 * Math.PI)]);
  }
  for (let i = 0; i < cap.length; i += 3) indices.push(cap[i]!, cap[i + 1]!, cap[i + 2]!, steps * n + cap[i]!, steps * n + cap[i + 2]!, steps * n + cap[i + 1]!);
  for (const { a, b, count } of edgeMap.values()) if (count === 1) for (let i = 0; i < steps; i++) {
    const r = i * n, next = (i + 1) * n;
    indices.push(r + a, next + b, r + b, r + a, next + a, next + b);
  }
  return solidMesh(kernelInstance, positions, indices, 'Screw');
}

/** Move an actual planar +Z cap and bridge only its boundary edges. */
function extrudedSolid(kernelInstance: Kernel, solid: any, distance: number, params: Record<string, Json>): any {
  const bounds = solid.boundingBox();
  if (Array.isArray(params.profile)) {
    const profile = profileSection(kernelInstance, solid, params);
    return checkedSolid(kernelInstance.Manifold.extrude(profile, Math.abs(distance)).translate([0, 0, distance < 0 ? distance : 0]), 'Extrude');
  }
  if (distance < 0) return checkedSolid(solid.trimByPlane([0, 0, -1], -(bounds.max[2] + distance)), 'Extrude');
  if (distance === 0) return solid;
  const { positions, indices } = rawSolidMesh(solid), cap: number[] = [], remaining: number[] = [];
  const eps = Math.max(1e-7, length(sub(bounds.max, bounds.min)) * 1e-7);
  for (let i = 0; i < indices.length; i += 3) {
    const tri = indices.slice(i, i + 3);
    (tri.every(v => Math.abs(positions[v]![2] - bounds.max[2]) <= eps) ? cap : remaining).push(...tri);
  }
  if (!cap.length) throw new Error('Extrude requires a planar +Z cap or an explicit 2D profile.');
  const duplicates = new Map<number, number>(), edges = new Map<string, { a: number; b: number; count: number }>();
  for (const i of cap) if (!duplicates.has(i)) { duplicates.set(i, positions.length); positions.push(add(positions[i]!, [0, 0, distance])); }
  for (let i = 0; i < cap.length; i += 3) {
    remaining.push(duplicates.get(cap[i]!)!, duplicates.get(cap[i + 1]!)!, duplicates.get(cap[i + 2]!)!);
    for (let j = 0; j < 3; j++) {
      const a = cap[i + j]!, b = cap[i + (j + 1) % 3]!, key = `${Math.min(a, b)}/${Math.max(a, b)}`;
      const edge = edges.get(key); if (edge) edge.count++; else edges.set(key, { a, b, count: 1 });
    }
  }
  for (const { a, b, count } of edges.values()) if (count === 1) remaining.push(a, b, duplicates.get(b)!, a, duplicates.get(b)!, duplicates.get(a)!);
  return solidMesh(kernelInstance, positions, remaining, 'Extrude');
}

/** Triangle distance with a bounding-volume hierarchy, used for local volumetric operations. */
function meshSignedDistance(solid: any): (point: Point) => number {
  const { positions, indices } = rawSolidMesh(solid);
  if (indices.length / 3 > 64000) throw new Error('Volumetric operations have a 64000 source-triangle budget; simplify the geometry-only source first.');
  type Triangle = { a: Point; b: Point; c: Point; center: Point; min: Point; max: Point };
  type Node = { min: Point; max: Point; triangles?: Triangle[]; left?: Node; right?: Node };
  const triangles: Triangle[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = positions[indices[i]!]!, b = positions[indices[i + 1]!]!, c = positions[indices[i + 2]!]!;
    triangles.push({ a, b, c, center: times(add(add(a, b), c), 1 / 3),
      min: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])],
      max: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])] });
  }
  function build(items: Triangle[]): Node {
    const min: Point = [Infinity, Infinity, Infinity], max: Point = [-Infinity, -Infinity, -Infinity];
    for (const tri of items) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, tri.min[axis]!); max[axis] = Math.max(max[axis]!, tri.max[axis]!);
    }
    if (items.length <= 8) return { min, max, triangles: items };
    const sizes = sub(max, min), axis = sizes.indexOf(Math.max(...sizes));
    items.sort((a, b) => a.center[axis]! - b.center[axis]!);
    const split = Math.floor(items.length / 2);
    return { min, max, left: build(items.slice(0, split)), right: build(items.slice(split)) };
  }
  const root = build(triangles);
  const boxDistance = (node: Node, p: Point): number => {
    let d = 0; for (let i = 0; i < 3; i++) d += Math.max(node.min[i]! - p[i]!, 0, p[i]! - node.max[i]!) ** 2;
    return d;
  };
  function triangleDistance(t: Triangle, p: Point): number {
    const ab = sub(t.b, t.a), ac = sub(t.c, t.a), ap = sub(p, t.a), d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
    const bp = sub(p, t.b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const d = sub(ap, times(ab, d1 / (d1 - d3))); return dot(d, d); }
    const cp = sub(p, t.c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const d = sub(ap, times(ac, d2 / (d2 - d6))); return dot(d, d); }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const d = sub(bp, times(sub(t.c, t.b), (d4 - d3) / ((d4 - d3) + (d5 - d6)))); return dot(d, d);
    }
    const denominator = 1 / (va + vb + vc), d = sub(ap, add(times(ab, vb * denominator), times(ac, vc * denominator)));
    return dot(d, d);
  }
  function nearest(node: Node, p: Point, best: number): number {
    if (boxDistance(node, p) >= best) return best;
    if (node.triangles) { for (const tri of node.triangles) best = Math.min(best, triangleDistance(tri, p)); return best; }
    const left = node.left!, right = node.right!;
    return boxDistance(left, p) < boxDistance(right, p) ? nearest(right, p, nearest(left, p, best)) : nearest(left, p, nearest(right, p, best));
  }
  const direction: Point = [1, .17320508075688773, .3713906763541037];
  function rayBox(node: Node, p: Point): boolean {
    let near = 0, far = Infinity;
    for (let i = 0; i < 3; i++) { near = Math.max(near, (node.min[i]! - p[i]!) / direction[i]!); far = Math.min(far, (node.max[i]! - p[i]!) / direction[i]!); }
    return near <= far;
  }
  function rayHits(node: Node, p: Point, hits: number[]): void {
    if (!rayBox(node, p)) return;
    if (!node.triangles) { rayHits(node.left!, p, hits); rayHits(node.right!, p, hits); return; }
    for (const tri of node.triangles) {
      const ab = sub(tri.b, tri.a), ac = sub(tri.c, tri.a), h = cross(direction, ac), det = dot(ab, h);
      if (Math.abs(det) < 1e-12) continue;
      const s = sub(p, tri.a), u = dot(s, h) / det; if (u < -1e-10 || u > 1 + 1e-10) continue;
      const q = cross(s, ab), v = dot(direction, q) / det; if (v < -1e-10 || u + v > 1 + 1e-10) continue;
      const distance = dot(ac, q) / det; if (distance > 1e-9) hits.push(distance);
    }
  }
  return p => {
    const distance = Math.sqrt(nearest(root, p, Infinity)); if (distance < 1e-9) return 0;
    const hits: number[] = []; rayHits(root, p, hits); hits.sort((a, b) => a - b);
    let count = 0; for (let i = 0; i < hits.length; i++) if (!i || Math.abs(hits[i]! - hits[i - 1]!) > 1e-7) count++;
    return count % 2 ? distance : -distance;
  };
}

function volumetricSolid(kernelInstance: Kernel, solid: any, resolution: number, inset = 0): any {
  const box = solid.boundingBox(), size = sub(box.max, box.min), longest = Math.max(...size);
  const step = inset ? Math.min(longest / resolution, Math.abs(inset) / 2) : longest / resolution;
  const padding = Math.max(0, -inset) + step * 2;
  const bounds = { min: sub(box.min, [padding, padding, padding]), max: add(box.max, [padding, padding, padding]) };
  const cells = sub(bounds.max, bounds.min).reduce((count, v) => count * Math.ceil(v / step), 1);
  if (!Number.isFinite(step) || step <= 0 || cells > 300000) throw new Error('Volumetric operation exceeds 300000 grid cells; reduce voxels, increase shell thickness, or split the object.');
  return checkedSolid(kernelInstance.Manifold.levelSet(meshSignedDistance(solid), bounds, step, inset), inset ? 'Surface offset' : 'Remesh');
}

function solidifiedSolid(kernelInstance: Kernel, solid: any, thickness: number, resolution: number, outside: boolean): any {
  if (thickness <= 0) throw new Error('Solidify thickness must be positive.');
  if (outside) {
    const outer = volumetricSolid(kernelInstance, solid, resolution, -thickness), shell = outer.subtract(solid); outer.delete();
    return checkedSolid(shell, 'Solidify');
  }
  const planes = convexPlanes(solid);
  let inner = solid;
  if (planes && planes.length <= 4096) {
    for (const { normal, point } of planes) {
      const next = inner.trimByPlane(times(normal, -1), -(dot(normal, point) - thickness));
      if (inner !== solid) inner.delete(); inner = next;
      checkedSolid(inner, 'Solidify inner offset');
    }
  } else inner = volumetricSolid(kernelInstance, solid, resolution, thickness);
  const shell = solid.subtract(inner); if (inner !== solid) inner.delete();
  return checkedSolid(shell, 'Solidify');
}

interface Kernel {
  Manifold: any;
  CrossSection: any;
  Mesh: any;
}

interface Rapier {
  World: any;
  RigidBodyDesc: any;
  ColliderDesc: any;
}

let kernelPromise: Promise<Kernel> | undefined;
let rapierPromise: Promise<Rapier> | undefined;

function wasmPath(): string {
  // Walk up from this compiled file (dist/main/model3d/) to the package root,
  // where node_modules lives — works both unpacked and inside asar, because
  // reading bytes is all we do with the wasm.
  const candidates = [
    join(__dirname, '../../../node_modules/manifold-3d/manifold.wasm'),
    join(__dirname, '../../node_modules/manifold-3d/manifold.wasm'),
    join(__dirname, '../../../../node_modules/manifold-3d/manifold.wasm'),
  ];
  for (const candidate of candidates) {
    try {
      const bytes = readFileSync(candidate);
      if (bytes.length > 1000) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('Could not locate manifold.wasm next to the packaged app');
}

/** Load manifold once per process. ESM-only, so it needs a dynamic import. */
export function kernel(): Promise<Kernel> {
  kernelPromise ??= (async () => {
    const bytes = readFileSync(wasmPath());
    const module = await import('manifold-3d/manifold.js');
    const factory = (module as { default?: unknown }).default ?? module;
    if (typeof factory !== 'function') throw new Error('manifold-3d did not export a factory');
    const instance = await (factory as (options: { wasmBinary: Uint8Array }) => Promise<any>)({ wasmBinary: bytes });
    instance.setup();
    return { Manifold: instance.Manifold, CrossSection: instance.CrossSection, Mesh: instance.Mesh };
  })();
  return kernelPromise;
}

/** Load rapier once per process. Its wasm is inlined, so no path resolution. */
export function physics(): Promise<Rapier> {
  rapierPromise ??= (async () => {
    const module = await import('@dimforge/rapier3d-compat');
    const rapier = ((module as { default?: any }).default ?? module) as Rapier & { init(): Promise<void>; version(): string };
    await rapier.init();
    return rapier;
  })();
  return rapierPromise;
}

/** Per-document evaluated-geometry cache. Invalidated by geometryKey changes. */
export class GeometryCache {
  private readonly entries = new Map<string, EvaluatedMesh>();
  private readonly limit: number;

  constructor(limit = 512) { this.limit = limit; }

  get(key: string): EvaluatedMesh | undefined { return this.entries.get(key); }

  set(key: string, mesh: EvaluatedMesh): void {
    // Bound the cache: a long modelling session can churn through many keys, and
    // each entry holds megabytes of typed arrays.
    if (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, mesh);
  }

  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}

const PRIMITIVE_PARAMS: Record<PrimitiveKind, Array<{ key: string; value: number }>> = {
  cube: [{ key: 'size', value: 2 }],
  uv_sphere: [{ key: 'radius', value: 1 }, { key: 'segments', value: 32 }, { key: 'rings', value: 16 }],
  ico_sphere: [{ key: 'radius', value: 1 }, { key: 'subdivisions', value: 2 }],
  cylinder: [{ key: 'radius', value: 1 }, { key: 'depth', value: 2 }, { key: 'segments', value: 32 }],
  cone: [{ key: 'radius', value: 1 }, { key: 'depth', value: 2 }, { key: 'segments', value: 32 }],
  torus: [{ key: 'majorRadius', value: 1 }, { key: 'minorRadius', value: 0.25 }, { key: 'majorSegments', value: 48 }, { key: 'minorSegments', value: 12 }],
  plane: [{ key: 'size', value: 2 }],
  grid: [{ key: 'size', value: 2 }, { key: 'subdivisions', value: 4 }],
  monkey: [{ key: 'size', value: 2 }],
  circle: [{ key: 'radius', value: 1 }, { key: 'segments', value: 32 }],
};

function num(params: Record<string, number>, key: string, fallback: number): number {
  const value = Number(params[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build the base solid for a primitive.
 *
 * Basic solids use native factories. An icosphere projects every refinement
 * midpoint onto its radius; the stylized monkey combines head, muzzle and ears.
 */
export function primitiveSolid(kernelInstance: Kernel, kind: PrimitiveKind, params: Record<string, number>): any {
  const { Manifold, CrossSection } = kernelInstance;
  switch (kind) {
    case 'cube': {
      const size = num(params, 'size', 2);
      return Manifold.cube([size, size, size], true);
    }
    case 'plane': {
      const size = num(params, 'size', 2);
      // A plane is a very thin box: keeping it a solid avoids every downstream
      // operation having to special-case zero-thickness geometry.
      return Manifold.cube([size, size, 0.002], true);
    }
    case 'uv_sphere': {
      const radius = num(params, 'radius', 1);
      const segments = Math.min(128, Math.max(3, Math.round(num(params, 'segments', 32))));
      const rings = Math.min(64, Math.max(2, Math.round(num(params, 'rings', 16))));
      const positions: Point[] = [[0,0,radius]], indices: number[] = [];
      for(let ring=1;ring<rings;ring++) {
        const phi=ring/rings*Math.PI;
        for(let j=0;j<segments;j++) { const theta=j/segments*Math.PI*2; positions.push([radius*Math.sin(phi)*Math.cos(theta),radius*Math.sin(phi)*Math.sin(theta),radius*Math.cos(phi)]); }
      }
      const bottom=positions.length;positions.push([0,0,-radius]);
      for(let j=0;j<segments;j++) {
        const next=(j+1)%segments;indices.push(0,1+j,1+next,bottom,1+(rings-2)*segments+next,1+(rings-2)*segments+j);
        for(let ring=0;ring<rings-2;ring++) { const a=1+ring*segments+j,b=1+ring*segments+next,c=b+segments,d=a+segments;indices.push(a,d,c,a,c,b); }
      }
      return solidMesh(kernelInstance,positions,indices,'UV sphere');
    }
    case 'ico_sphere': {
      const radius = num(params, 'radius', 1);
      const requested=Number(params.subdivisions ?? 2);
      const subdivisions = Math.min(5, Math.max(0, Math.round(Number.isFinite(requested)?requested:2)));
      const phi = (1 + Math.sqrt(5)) / 2;
      const positions: Point[] = [[-1,phi,0],[1,phi,0],[-1,-phi,0],[1,-phi,0],[0,-1,phi],[0,1,phi],[0,-1,-phi],[0,1,-phi],[phi,0,-1],[phi,0,1],[-phi,0,-1],[-phi,0,1]].map(p => times(unit(p as Point), radius));
      let indices = [0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1];
      for (let level = 0; level < subdivisions; level++) {
        const mids = new Map<string, number>(), refined: number[] = [];
        const midpoint = (a: number, b: number): number => {
          const key = `${Math.min(a,b)}/${Math.max(a,b)}`, found = mids.get(key); if (found !== undefined) return found;
          const index = positions.length; positions.push(times(unit(add(positions[a]!, positions[b]!)), radius)); mids.set(key,index); return index;
        };
        for (let i = 0; i < indices.length; i += 3) {
          const a = indices[i]!, b = indices[i+1]!, c = indices[i+2]!, ab = midpoint(a,b), bc = midpoint(b,c), ca = midpoint(c,a);
          refined.push(a,ab,ca,b,bc,ab,c,ca,bc,ab,bc,ca);
        }
        indices = refined;
      }
      return solidMesh(kernelInstance, positions, indices, 'Icosphere');
    }
    case 'cylinder': {
      const radius = num(params, 'radius', 1);
      const depth = num(params, 'depth', 2);
      const segments = Math.min(128, Math.max(3, Math.round(num(params, 'segments', 32))));
      return Manifold.cylinder(depth, radius, radius, segments, true);
    }
    case 'cone': {
      const radius = num(params, 'radius', 1);
      const depth = num(params, 'depth', 2);
      const segments = Math.min(128, Math.max(3, Math.round(num(params, 'segments', 32))));
      return Manifold.cylinder(depth, radius, 0, segments, true);
    }
    case 'torus': {
      const major = num(params, 'majorRadius', 1);
      const minor = num(params, 'minorRadius', 0.25);
      const majorSegments = Math.min(128, Math.max(6, Math.round(num(params, 'majorSegments', 48))));
      const minorSegments = Math.min(64, Math.max(3, Math.round(num(params, 'minorSegments', 12))));
      return Manifold.revolve(CrossSection.circle(minor, minorSegments).translate([major, 0]), majorSegments);
    }
    case 'grid': {
      const size = num(params, 'size', 2);
      const subdivisions = Math.min(64, Math.max(1, Math.round(num(params, 'subdivisions', 4))));
      const grid = Manifold.cube([size, size, 0.002], true);
      return subdivisions > 1 ? grid.refine(subdivisions) : grid;
    }
    case 'monkey': {
      const size = num(params, 'size', 2);
      const head = Manifold.sphere(size * .4, 32).scale([1,.8,1]);
      const muzzle = Manifold.sphere(size * .24, 24).scale([1,1,.65]).translate([0,-size*.28,-size*.1]);
      const ears = [-1,1].map(side => Manifold.sphere(size * .19, 24).scale([.7,.5,1]).translate([side*size*.42,0,0]));
      return Manifold.union([head,muzzle,...ears]);
    }
    case 'circle': {
      const radius = num(params, 'radius', 1);
      const segments = Math.min(128, Math.max(3, Math.round(num(params, 'segments', 32))));
      return Manifold.cylinder(0.002, radius, radius, segments, true);
    }
    default: {
      const exhausted: never = kind;
      throw new Error(`Unknown primitive: ${String(exhausted)}`);
    }
  }
}

/** Custom/imported mesh as a solid. Positions interleaved xyz + triangle indices. */
export function solidFromMesh(kernelInstance: Kernel, positions: number[], indices: number[]): any {
  const { Manifold, Mesh } = kernelInstance;
  const numProp = 3;
  const vertProperties = new Float32Array(positions);
  const triVerts = new Uint32Array(indices);
  const input = new Mesh({ numProp, vertProperties, triVerts });
  // Position-only CAD evaluation can weld coincident seams. The authored
  // surface/normal/UV vertices remain untouched in the document and viewport.
  input.merge();
  return Manifold.ofMesh(input);
}

/** Generate default positions/indices for a primitive so meshes are inspectable. */
export function primitiveTriangleCounts(kind: PrimitiveKind, params: Record<string, number>): { verts: number; tris: number } {
  const defaults = PRIMITIVE_PARAMS[kind] ?? [];
  const merged: Record<string, number> = {};
  for (const entry of defaults) merged[entry.key] = entry.value;
  for (const [key, value] of Object.entries(params)) if (Number.isFinite(Number(value))) merged[key] = Number(value);
  const segments = Math.round(merged.segments ?? merged.majorSegments ?? 32);
  switch (kind) {
    case 'uv_sphere': {
      const rings=Math.min(64,Math.max(2,Math.round(merged.rings??16))), sides=Math.min(128,Math.max(3,segments));
      return {verts:sides*(rings-1)+2,tris:sides*(rings-1)*2};
    }
    case 'cylinder': case 'cone': return { verts: segments * 4, tris: segments * 4 };
    case 'torus': return { verts: Math.round(merged.majorSegments ?? 48) * Math.round(merged.minorSegments ?? 12), tris: Math.round(merged.majorSegments ?? 48) * Math.round(merged.minorSegments ?? 12) * 2 };
    case 'plane': case 'circle': case 'grid': return { verts: 4, tris: 2 };
    case 'cube': return { verts: 8, tris: 12 };
    case 'ico_sphere': {
      const subdivisions = Math.min(5, Math.max(0, Math.round(merged.subdivisions ?? 2)));
      return { verts: 10 * 4 ** subdivisions + 2, tris: 20 * 4 ** subdivisions };
    }
    default: return { verts: 8, tris: 12 };
  }
}

/**
 * Apply one modifier to a solid.
 *
 * Operations have explicit geometry and complexity bounds. Surface/deformation
 * authoring data requires an explicit geometry-only bake before topology changes.
 */
export function applyModifier(
  kernelInstance: Kernel,
  solid: any,
  modifier: Modifier3D,
  context: { doc: Model3DDocument; self: Object3DRecord; visiting: Set<string> },
): any {
  const { Manifold } = kernelInstance;
  const params = modifier.params as Record<string, Json>;
  const number_ = (key: string, fallback: number): number => {
    const value = Number(params[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  switch (modifier.type) {
    case 'subdivide': {
      const iterations = Math.min(4, Math.max(1, Math.round(number_('iterations', 1))));
      const factor = Math.min(8, Math.max(2, Math.round(number_('factor', 2))));
      if (solid.numTri() * factor ** (2 * iterations) > 1000000) throw new Error('Subdivision exceeds the one-million-triangle budget.');
      let result = solid;
      for (let index = 0; index < iterations; index++) result = result.refine(factor);
      return result;
    }
    case 'mirror': {
      const axis = string(params.axis) || 'x';
      const index = axis === 'y' ? 1 : axis === 'z' ? 2 : 0;
      const scale = [1, 1, 1];
      scale[index] = -1;
      const mirrored = solid.scale(scale);
      // Mirroring flips winding, so the reflected copy is inside-out unless the
      // kernel re-orients it; union with the original keeps the result watertight.
      return booleanOp(kernelInstance, mirrored, solid, 'union');
    }
    case 'array': {
      const count = Math.min(256, Math.max(1, Math.round(number_('count', 2))));
      const offset = [number_('offsetX', 2), number_('offsetY', 0), number_('offsetZ', 0)];
      let result = solid;
      for (let index = 1; index < count; index++) {
        result = booleanOp(kernelInstance, result, solid.translate([offset[0]! * index, offset[1]! * index, offset[2]! * index]), 'union');
      }
      return result;
    }
    case 'boolean': {
      const operation = (['union', 'subtract', 'intersect'] as const).includes(string(params.operation) as 'union')
        ? string(params.operation) as 'union' | 'subtract' | 'intersect' : 'union';
      const otherName = string(params.object);
      if (!otherName) throw new Error('The boolean modifier needs an `object` to combine with');
      const other = context.doc.objects.find(item => item.name === otherName);
      if (!other) throw new Error(`No object named '${otherName}' for the boolean modifier`);
      // Evaluate the operand's own stack first. The same
      // visiting set is threaded through so a cycle (A booleans B, B booleans A)
      // is caught transitively instead of restarting detection at each hop.
      if (other.mesh && context.doc.meshes[other.mesh]) requireBakeForAttributedMesh(context.doc.meshes[other.mesh]! as RichMesh);
      const otherSolid = evaluateObjectSolid(kernelInstance, context.doc, other, context.visiting);
      if (!otherSolid) throw new Error(`'${otherName}' has no mesh to combine with`);
      // Bring the operand into this object's local space so the modifier stack
      // composes in one coordinate frame.
      const relative = multiplyMatrices(invertMatrix(worldMatrixOf(context.doc, context.self.name)), worldMatrixOf(context.doc, other.name));
      return booleanOp(kernelInstance, solid, otherSolid.transform(relative), operation);
    }
    case 'solidify': {
      const thickness = number_('thickness', 0.1);
      return solidifiedSolid(kernelInstance, solid, thickness, clamp(Math.round(number_('voxels', 32)),8,64), params.side === 'outside');
    }
    case 'bevel': {
      const width = number_('width', number_('amount', .1));
      if (width <= 0) throw new Error('Bevel width must be positive.');
      return beveledSolid(solid, width, clamp(Math.round(number_('segments', 1)),1,8), clamp(number_('angle',30),0,180));
    }
    case 'decimate': {
      return decimatedSolid(solid, number_('ratio', .5));
    }
    case 'smooth': {
      const factor = clamp(Math.round(number_('factor', 2)),2,4), iterations = clamp(Math.round(number_('iterations',1)),1,3);
      if (solid.numTri() * factor ** (2 * iterations) > 1000000) throw new Error('Smooth refinement exceeds the one-million-triangle budget.');
      let result = solid.smoothOut(clamp(number_('angle',60),0,180),clamp(number_('smoothness',.25),0,1));
      for(let i=0;i<iterations;i++) result=result.refine(factor);
      return checkedSolid(result,'Smooth');
    }
    case 'wireframe': {
      const thickness = number_('thickness', .05);
      if(thickness<=0) throw new Error('Wireframe thickness must be positive.');
      return wireframeSolid(kernelInstance, solid, thickness, clamp(Math.round(number_('segments',12)),6,32), params.includeDiagonals === true);
    }
    case 'triangulate': {
      // The kernel's surfaces already consist of triangles.
      return solid;
    }
    case 'remesh': {
      return volumetricSolid(kernelInstance, solid, clamp(Math.round(number_('voxels',32)),8,64));
    }
    case 'hull': return solid.hull();
    case 'screw': {
      return screwSolid(kernelInstance, solid, params, number_);
    }
    case 'extrude': {
      const distance = number_('distance', 1);
      return extrudedSolid(kernelInstance, solid, distance, params);
    }
    default: {
      const exhausted: never = modifier.type;
      throw new Error(`Unknown modifier: ${String(exhausted)}`);
    }
  }
}

export function booleanOp(kernelInstance: Kernel, left: any, right: any, operation: 'union' | 'subtract' | 'intersect'): any {
  switch (operation) {
    case 'union': return left.add(right);
    case 'subtract': return left.subtract(right);
    case 'intersect': return left.intersect(right);
    default: {
      const exhausted: never = operation;
      throw new Error(`Unknown boolean operation: ${String(exhausted)}`);
    }
  }
}

/**
 * Run an object's modifier stack.
 *
 * `visiting` is the in-progress set for Boolean operands: a modifier that
 * references an object which (directly or transitively) references back would
 * recurse forever, so cyclic operands are rejected.
 */
export function evaluateObjectSolid(
  kernelInstance: Kernel,
  doc: Model3DDocument,
  record: Object3DRecord,
  visiting: Set<string>,
): any | null {
  if (record.type !== 'MESH') return null;
  if (visiting.has(record.name)) throw new Error(`Modifier cycle detected at '${record.name}'`);
  const mesh = record.mesh ? doc.meshes[record.mesh] : undefined;
  if (!mesh) return null;
  if (mesh.positions && mesh.indices) validateAuthoredMesh(mesh as RichMesh);
  if (mesh.primitive === null && (!mesh.positions || !mesh.indices)) throw new Error('Custom mesh geometry is missing triangle positions or indices.');
  if (record.modifiers.some(m => m.enabled && m.type !== 'triangulate')) requireBakeForAttributedMesh(mesh as RichMesh);
  let solid = mesh.positions && mesh.indices && mesh.positions.length >= 9
    ? solidFromMesh(kernelInstance, mesh.positions, mesh.indices)
    : primitiveSolid(kernelInstance, mesh.primitive ?? 'cube', mesh.primitiveParams);
  visiting.add(record.name);
  try {
    for (const modifier of record.modifiers) {
      if (!modifier.enabled) continue;
      solid = applyModifier(kernelInstance, solid, modifier, { doc, self: record, visiting });
    }
  } finally {
    visiting.delete(record.name);
  }
  return solid;
}

/** Evaluate one object to typed arrays, using the cache when nothing changed. */
export async function evaluateObject(
  doc: Model3DDocument,
  record: Object3DRecord,
  cache: GeometryCache,
): Promise<EvaluatedMesh | null> {
  if (record.type !== 'MESH') return null;
  const key = evaluationKey(doc, record);
  const cached = cache.get(key);
  if (cached) return cached;
  const authored = record.mesh ? doc.meshes[record.mesh] as RichMesh | undefined : undefined;
  if (authored?.positions && authored.indices && !record.modifiers.some(m => m.enabled && m.type !== 'triangulate')) {
    validateAuthoredMesh(authored);
    const positions = new Float32Array(authored.positions), indices = new Uint32Array(authored.indices);
    const triMaterials = new Array(indices.length / 3).fill(0);
    for(const g of authored.groups ?? []) for(let i=g.start;i<g.start+g.count;i+=3) if(i<indices.length) triMaterials[Math.floor(i/3)]=g.materialIndex;
    const result: EvaluatedMesh = {positions,indices,normals:authored.normals?.length===positions.length?new Float32Array(authored.normals):computeNormals(positions,indices),triMaterials,geometryKey:key};
    for(const attr of ['uvs','uvs1','tangents','colors','skinWeights'] as const) if(authored[attr]) result[attr]=new Float32Array(authored[attr]);
    if(authored.skinIndices) result.skinIndices=new Uint32Array(authored.skinIndices);
    if(authored.groups) result.groups=authored.groups.map(g=>({...g}));
    if(authored.morphTargets) result.morphTargets=authored.morphTargets.map(m=>({...(m.name?{name:m.name}:{}),...(m.positions?{positions:new Float32Array(m.positions)}:{}),...(m.normals?{normals:new Float32Array(m.normals)}:{})}));
    cache.set(key,result);return result;
  }
  const kernelInstance = await kernel();
  const solid = evaluateObjectSolid(kernelInstance, doc, record, new Set());
  if (!solid || solid.isEmpty()) {
    const empty: EvaluatedMesh = {
      positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0),
      triMaterials: [], geometryKey: key,
    };
    cache.set(key, empty);
    return empty;
  }
  const mesh = solid.getMesh();
  const numProp = Math.max(3, mesh.numProp || 3);
  const raw = mesh.vertProperties as Float32Array | number[];
  const triangleVertices = mesh.triVerts as Uint32Array | number[];
  // Manifold stores per-vertex properties for EVERY property vertex, so a solid
  // with split normals has more property vertices than logical ones. Positions
  // are always the first three channels of each property vertex.
  const propertyVertexCount = raw.length / numProp;
  const positions = new Float32Array(propertyVertexCount * 3);
  for (let index = 0; index < propertyVertexCount; index++) {
    positions[index * 3] = raw[index * numProp] as number;
    positions[index * 3 + 1] = raw[index * numProp + 1] as number;
    positions[index * 3 + 2] = raw[index * numProp + 2] as number;
  }
  const indices = new Uint32Array(triangleVertices.length);
  for (let index = 0; index < triangleVertices.length; index++) indices[index] = triangleVertices[index] as number;
  const normals = computeNormals(positions, indices);
  const materialSlots = (record.mesh ? doc.meshes[record.mesh]?.materials : undefined) ?? [];
  const triMaterials = materialSlots.length
    ? new Array(indices.length / 3).fill(0)
    : [];
  const evaluated: EvaluatedMesh = { positions, normals, indices, triMaterials, geometryKey: key };
  cache.set(key, evaluated);
  return evaluated;
}

/**
 * Per-vertex normals accumulated from face normals.
 *
 * Manifold returns positions only (numProp 3), and asking it for more channels
 * requires a property callback per vertex. Accumulating here is both simpler and
 * faster than crossing the WASM boundary per vertex, and it matches what
 * three.js does internally for a geometry without normals.
 */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = (indices[index] as number) * 3;
    const b = (indices[index + 1] as number) * 3;
    const c = (indices[index + 2] as number) * 3;
    const ux = (positions[b] as number) - (positions[a] as number);
    const uy = (positions[b + 1] as number) - (positions[a + 1] as number);
    const uz = (positions[b + 2] as number) - (positions[a + 2] as number);
    const vx = (positions[c] as number) - (positions[a] as number);
    const vy = (positions[c + 1] as number) - (positions[a + 1] as number);
    const vz = (positions[c + 2] as number) - (positions[a + 2] as number);
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const offset of [a, b, c]) {
      normals[offset] = (normals[offset] as number) + nx;
      normals[offset + 1] = (normals[offset + 1] as number) + ny;
      normals[offset + 2] = (normals[offset + 2] as number) + nz;
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const x = normals[index] as number;
    const y = normals[index + 1] as number;
    const z = normals[index + 2] as number;
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length > 1e-12) {
      normals[index] = x / length;
      normals[index + 1] = y / length;
      normals[index + 2] = z / length;
    } else {
      // A degenerate face contributes no direction; +Z keeps the attribute
      // well-formed instead of emitting NaN into the GPU buffer.
      normals[index + 2] = 1;
    }
  }
  return normals;
}

/** Material datablock -> the subset three.js MeshStandardMaterial needs. */
export function materialForViewport(material: Material3D | undefined): Json | null {
  if (!material) return null;
  return {
    name: material.name,
    base_color: material.baseColor,
    metallic: material.metallic,
    roughness: material.roughness,
    alpha: material.alpha,
    emission_color: material.emissiveColor,
    emission_strength: material.emissiveStrength,
  };
}

export { PRIMITIVE_PARAMS };
export type { Kernel, Rapier };
