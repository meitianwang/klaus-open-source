import { BoxGeometry } from 'three/src/geometries/BoxGeometry.js';
import { BufferGeometry } from 'three/src/core/BufferGeometry.js';
import { CylinderGeometry } from 'three/src/geometries/CylinderGeometry.js';
import { Euler } from 'three/src/math/Euler.js';
import { IcosahedronGeometry } from 'three/src/geometries/IcosahedronGeometry.js';
import { Matrix3 } from 'three/src/math/Matrix3.js';
import { Matrix4 } from 'three/src/math/Matrix4.js';
import { PlaneGeometry } from 'three/src/geometries/PlaneGeometry.js';
import { Quaternion } from 'three/src/math/Quaternion.js';
import { ShapeUtils } from 'three/src/extras/ShapeUtils.js';
import { SphereGeometry } from 'three/src/geometries/SphereGeometry.js';
import { TorusGeometry } from 'three/src/geometries/TorusGeometry.js';
import { Vector2 } from 'three/src/math/Vector2.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import type { PrimitiveKind, Vec3 } from './model';
import { AUTHORING_LIMITS, boundedInteger, cloneMesh, customMesh, edgeKey, finite, finiteVec, meshNormals, positive, validateAuthoringMesh, type AuthoringMesh } from './authoring-mesh';

type NodeBase = { id: string };
type InputNode = NodeBase & { input: string; bakeProtectedAttributes?: boolean };
export type GeometryGraphNode =
  | (NodeBase & { type: 'primitive'; kind: PrimitiveKind; params?: Record<string, number> })
  | (NodeBase & { type: 'source'; mesh: AuthoringMesh })
  | (InputNode & { type: 'mirror'; axis: 'x' | 'y' | 'z'; offset?: number; includeOriginal?: boolean })
  | (InputNode & { type: 'array'; count: number; offset: Vec3 })
  | (InputNode & { type: 'transform'; translation?: Vec3; rotation?: Vec3; scale?: Vec3 })
  | (InputNode & { type: 'subdivide'; iterations?: number })
  | (NodeBase & { type: 'profile'; profile: Array<[number, number]>; depth: number })
  | (NodeBase & { type: 'sweep'; profile: Array<[number, number]>; path: Vec3[]; caps?: boolean });
export interface GeometryGraph { nodes: GeometryGraphNode[]; output: string }

/** Validate the entire DAG, including unreachable nodes, before allocating. */
export function validateGeometryGraph(graph: GeometryGraph): string[] {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('A geometry graph needs nodes and an output');
  boundedInteger(graph.nodes.length, 1, AUTHORING_LIMITS.graphNodes, 'graph node count');
  const nodes = new Map<string, GeometryGraphNode>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || node.id.length > 160 || nodes.has(node.id)) throw new Error('Geometry node ids must be unique nonempty strings');
    if (!['primitive', 'source', 'mirror', 'array', 'transform', 'subdivide', 'profile', 'sweep'].includes(node.type)) throw new Error(`Unsupported geometry node type: ${node.type}`);
    nodes.set(node.id, node);
  }
  if (!nodes.has(graph.output)) throw new Error('Geometry graph output does not exist');
  const active = new Set<string>(), finished = new Set<string>(), order: string[] = [];
  const visit = (id: string): void => {
    if (active.has(id)) throw new Error(`Geometry graph contains a cycle at ${id}`);
    if (finished.has(id)) return;
    const node = nodes.get(id); if (!node) throw new Error(`Missing geometry graph input: ${id}`);
    active.add(id);
    if ('input' in node) visit(node.input);
    active.delete(id); finished.add(id); order.push(id);
  };
  for (const id of nodes.keys()) visit(id);
  return order;
}

function fromGeometry(geometry: BufferGeometry, name: string): AuthoringMesh {
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
  const mesh: AuthoringMesh = { name, primitive: null, primitiveParams: {}, positions: Array.from(position.array), indices: geometry.index ? Array.from(geometry.index.array) : Array.from({ length: position.count }, (_, i) => i), materials: [] };
  if (uv) mesh.uvs = Array.from(uv.array);
  mesh.normals = meshNormals(mesh.positions!, mesh.indices!); geometry.dispose();
  return mesh;
}

function primitive(node: Extract<GeometryGraphNode, { type: 'primitive' }>): AuthoringMesh {
  const params = node.params ?? {};
  for (const [key, value] of Object.entries(params)) finite(value, `primitive parameter ${key}`);
  const value = (key: string, fallback: number): number => positive(params[key] ?? fallback, `primitive ${key}`);
  const segments = (key: string, fallback: number, min = 3, max = 128): number => boundedInteger(params[key] ?? fallback, min, max, `primitive ${key}`);
  let geometry: BufferGeometry;
  switch (node.kind) {
    case 'cube': { const size = value('size', 2); geometry = new BoxGeometry(value('width', size), value('height', size), value('depth', size)); break; }
    case 'uv_sphere': geometry = new SphereGeometry(value('radius', 1), segments('segments', 32), segments('rings', 16, 2)); break;
    case 'ico_sphere': geometry = new IcosahedronGeometry(value('radius', 1), segments('subdivisions', 2, 0, 4)); break;
    case 'cylinder': geometry = new CylinderGeometry(value('radius', 1), value('radius', 1), value('depth', 2), segments('segments', 32)); break;
    case 'cone': geometry = new CylinderGeometry(params.radiusTop === undefined ? 0 : Math.max(0, finite(params.radiusTop, 'top radius')), value('radius', 1), value('depth', 2), segments('segments', 32)); break;
    case 'torus': geometry = new TorusGeometry(value('majorRadius', 1), value('minorRadius', 0.25), segments('minorSegments', 12), segments('majorSegments', 48)); break;
    case 'plane': geometry = new PlaneGeometry(value('size', 2), value('size', 2)); break;
    case 'grid': geometry = new PlaneGeometry(value('size', 2), value('size', 2), segments('subdivisions', 4, 1), segments('subdivisions', 4, 1)); break;
    case 'circle': {
      const count = segments('segments', 32), radius = value('radius', 1);
      const profile = Array.from({ length: count }, (_, i) => [Math.cos(i * Math.PI * 2 / count) * radius, Math.sin(i * Math.PI * 2 / count) * radius] as [number, number]);
      const positions = profile.flatMap(([x, y]) => [x, y, 0]), indices = ShapeUtils.triangulateShape(profile.map(p => new Vector2(...p)), []).flat();
      return { name: node.id, primitive: null, primitiveParams: {}, positions, indices, normals: meshNormals(positions, indices), materials: [], uvs: profile.flatMap(([x, y]) => [x / (2 * radius) + 0.5, y / (2 * radius) + 0.5]) };
    }
    default: throw new Error(`Primitive ${node.kind} has no native authored shape`);
  }
  return fromGeometry(geometry, node.id);
}

function prepare(mesh: AuthoringMesh, bake?: boolean): AuthoringMesh {
  const output = customMesh(cloneMesh(mesh));
  if (output.skinIndices || output.skinWeights || output.morphTargets !== undefined) {
    if (bake !== true) throw new Error('A bound or morph-target mesh requires explicit bakeProtectedAttributes before geometry graph edits');
    delete output.skinIndices; delete output.skinWeights; delete output.morphTargets;
  }
  return output;
}

function transformMesh(mesh: AuthoringMesh, matrix: Matrix4): AuthoringMesh {
  if (!Number.isFinite(matrix.determinant()) || Math.abs(matrix.determinant()) < 1e-12) throw new Error('Geometry transform cannot have a singular or unbounded scale');
  const output = cloneMesh(mesh), p = new Vector3(), normalMatrix = new Matrix3().getNormalMatrix(matrix);
  for (let i = 0; i < output.positions!.length; i += 3) p.fromArray(output.positions!, i).applyMatrix4(matrix).toArray(output.positions!, i);
  if (output.normals) for (let i = 0; i < output.normals.length; i += 3) p.fromArray(output.normals, i).applyMatrix3(normalMatrix).normalize().toArray(output.normals, i);
  if (output.tangents) for (let i = 0; i < output.tangents.length; i += 4) { p.fromArray(output.tangents, i).transformDirection(matrix).toArray(output.tangents, i); if (matrix.determinant() < 0) output.tangents[i + 3] = -output.tangents[i + 3]!; }
  if (matrix.determinant() < 0) for (let i = 0; i < output.indices!.length; i += 3) [output.indices![i + 1], output.indices![i + 2]] = [output.indices![i + 2]!, output.indices![i + 1]!];
  return output;
}

function mergeMeshes(meshes: AuthoringMesh[], name: string): AuthoringMesh {
  const vertices = meshes.reduce((count, mesh) => count + mesh.positions!.length / 3, 0), triangles = meshes.reduce((count, mesh) => count + mesh.indices!.length / 3, 0);
  if (vertices > AUTHORING_LIMITS.vertices || triangles > AUTHORING_LIMITS.triangles) throw new Error('Geometry graph output exceeds the geometry budget');
  const first = meshes[0]!, output: AuthoringMesh = { name, primitive: null, primitiveParams: {}, positions: [], indices: [], materials: first.materials.slice() };
  const attributes = ['normals', 'uvs', 'uvs1', 'tangents', 'colors'] as const;
  for (const attribute of attributes) if (meshes.every(mesh => mesh[attribute] !== undefined)) output[attribute] = [];
  let vertexOffset = 0, indexOffset = 0;
  const groups: NonNullable<AuthoringMesh['groups']> = [];
  for (const mesh of meshes) {
    for (const value of mesh.positions!) output.positions!.push(value);
    // Avoid spreading large accessor arrays into a function call.
    for (const index of mesh.indices!) output.indices!.push(index + vertexOffset);
    for (const attribute of attributes) if (output[attribute]) for (const value of mesh[attribute]!) output[attribute]!.push(value);
    for (const group of mesh.groups ?? []) groups.push({ ...group, start: group.start + indexOffset });
    vertexOffset += mesh.positions!.length / 3; indexOffset += mesh.indices!.length;
  }
  if (groups.length) output.groups = groups;
  return output;
}

function subdivideMesh(mesh: AuthoringMesh, iterations: number): AuthoringMesh {
  boundedInteger(iterations, 0, 4, 'subdivision iterations');
  let output = cloneMesh(mesh);
  for (let iteration = 0; iteration < iterations; iteration++) {
    if (output.indices!.length / 3 * 4 > AUTHORING_LIMITS.triangles) throw new Error('Subdivision exceeds the triangle budget');
    const positions = output.positions!.slice(), oldVertexCount = positions.length / 3, indices: number[] = [], edges = new Map<string, number>();
    const channels = Object.entries({ uvs: 2, uvs1: 2, colors: output.colors ? output.colors.length / oldVertexCount : 3 });
    const attributes: Record<string, number[]> = {};
    for (const [key] of channels) { const values = output[key as keyof AuthoringMesh]; if (Array.isArray(values)) attributes[key] = (values as number[]).slice(); }
    const midpoint = (a: number, b: number): number => {
      const key = edgeKey(a, b), existing = edges.get(key); if (existing !== undefined) return existing;
      const index = positions.length / 3; if (index >= AUTHORING_LIMITS.vertices) throw new Error('Subdivision exceeds the vertex budget');
      for (let c = 0; c < 3; c++) positions.push((positions[a * 3 + c]! + positions[b * 3 + c]!) / 2);
      for (const [channel, width] of channels) if (attributes[channel]) for (let c = 0; c < width; c++) attributes[channel]!.push((attributes[channel]![a * width + c]! + attributes[channel]![b * width + c]!) / 2);
      edges.set(key, index); return index;
    };
    for (let i = 0; i < output.indices!.length; i += 3) {
      const a = output.indices![i]!, b = output.indices![i + 1]!, c = output.indices![i + 2]!, ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      indices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    output.positions = positions; output.indices = indices;
    for (const [key, values] of Object.entries(attributes)) (output as unknown as Record<string, unknown>)[key] = values;
    if (output.groups) output.groups = output.groups.map(group => ({ ...group, start: group.start * 4, count: group.count * 4 }));
    delete output.tangents;
    output.normals = meshNormals(positions, indices);
  }
  return output;
}

function validProfile(input: Array<[number, number]>): Vector2[] {
  if (!Array.isArray(input)) throw new Error('A profile requires a finite polygon');
  boundedInteger(input.length, 3, 128, 'profile vertices');
  const points = input.map(p => { if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) throw new Error('Profile coordinates must be finite pairs'); return new Vector2(...p); });
  let area = 0;
  const orient = (a: Vector2, b: Vector2, c: Vector2): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    if (a.distanceToSquared(b) < 1e-20) throw new Error('Profile edges cannot have zero length');
    area += a.x * b.y - b.x * a.y;
    for (let j = i + 1; j < points.length; j++) {
      if (j === (i + 1) % points.length || i === (j + 1) % points.length) continue;
      const c = points[j]!, d = points[(j + 1) % points.length]!;
      if (orient(a, b, c) * orient(a, b, d) <= 0 && orient(c, d, a) * orient(c, d, b) <= 0 && Math.max(a.x, b.x) >= Math.min(c.x, d.x) && Math.max(c.x, d.x) >= Math.min(a.x, b.x) && Math.max(a.y, b.y) >= Math.min(c.y, d.y) && Math.max(c.y, d.y) >= Math.min(a.y, b.y)) throw new Error('Profile polygon cannot self-intersect');
    }
  }
  if (Math.abs(area) < 1e-12) throw new Error('Profile polygon must have nonzero area');
  if (area < 0) points.reverse();
  return points;
}

/** Parallel-transport frames keep a polygonal sweep stable across bends. */
export function sweepProfile(profile: Array<[number, number]>, path: Vec3[], name = 'Sweep', caps = true): AuthoringMesh {
  const shape = validProfile(profile);
  if (!Array.isArray(path)) throw new Error('Sweep needs a path');
  boundedInteger(path.length, 2, 1024, 'sweep path points');
  const points = path.map((p, i) => { finiteVec(p, `path point ${i}`); return new Vector3(p.x, p.y, p.z); });
  for (let i = 1; i < points.length; i++) if (points[i]!.distanceToSquared(points[i - 1]!) < 1e-20) throw new Error('Sweep path cannot contain repeated adjacent points');
  const ringWidth = shape.length + 1;
  if (ringWidth * points.length + shape.length * 2 > AUTHORING_LIMITS.vertices) throw new Error('Sweep exceeds the vertex budget');
  const tangents = points.map((p, i) => new Vector3().subVectors(points[Math.min(points.length - 1, i + 1)]!, points[Math.max(0, i - 1)]!).normalize());
  if (tangents.some(t => t.lengthSq() < 0.5)) throw new Error('Sweep path cannot reverse directly back through itself');
  const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
  let tangent = tangents[0]!, u = new Vector3().crossVectors(Math.abs(tangent.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0), tangent).normalize();
  let v = new Vector3().crossVectors(tangent, u).normalize();
  const lengths = [0]; for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + points[i]!.distanceTo(points[i - 1]!));
  const perimeter = [0]; for (let i = 1; i <= shape.length; i++) perimeter.push(perimeter[i - 1]! + shape[i % shape.length]!.distanceTo(shape[i - 1]!));
  for (let ring = 0; ring < points.length; ring++) {
    if (ring) { const q = new Quaternion().setFromUnitVectors(tangent, tangents[ring]!); u.applyQuaternion(q).normalize(); tangent = tangents[ring]!; v.crossVectors(tangent, u).normalize(); }
    for (let corner = 0; corner <= shape.length; corner++) {
      const p = shape[corner % shape.length]!;
      positions.push(...points[ring]!.clone().addScaledVector(u, p.x).addScaledVector(v, p.y).toArray());
      uvs.push(perimeter[corner]! / perimeter[shape.length]!, lengths[ring]! / lengths[points.length - 1]!);
    }
  }
  for (let ring = 0; ring < points.length - 1; ring++) for (let i = 0; i < shape.length; i++) {
    const a = ring * ringWidth + i, b = a + 1, c = b + ringWidth, d = a + ringWidth; indices.push(a, b, c, a, c, d);
  }
  if (caps) {
    const faces = ShapeUtils.triangulateShape(shape, []), min = new Vector2(Infinity, Infinity), max = new Vector2(-Infinity, -Infinity);
    for (const p of shape) { min.min(p); max.max(p); }
    for (const ring of [0, points.length - 1]) {
      const start = positions.length / 3;
      for (let i = 0; i < shape.length; i++) { positions.push(...positions.slice((ring * ringWidth + i) * 3, (ring * ringWidth + i) * 3 + 3)); uvs.push((shape[i]!.x - min.x) / Math.max(max.x - min.x, 1e-12), (shape[i]!.y - min.y) / Math.max(max.y - min.y, 1e-12)); }
      for (const [a, b, c] of faces) indices.push(start + a!, start + (ring === 0 ? c! : b!), start + (ring === 0 ? b! : c!));
    }
  }
  const output: AuthoringMesh = { name, primitive: null, primitiveParams: {}, positions, indices, uvs, normals: meshNormals(positions, indices), materials: [] };
  validateAuthoringMesh(output); return output;
}

export function evaluateGeometryGraph(graph: GeometryGraph, name = 'Geometry'): AuthoringMesh {
  const order = validateGeometryGraph(graph), nodes = new Map(graph.nodes.map(node => [node.id, node])), cache = new Map<string, AuthoringMesh>();
  // Evaluate only output dependencies after validating every edge and cycle.
  const needed = new Set<string>();
  const need = (id: string): void => { if (needed.has(id)) return; needed.add(id); const node = nodes.get(id)!; if ('input' in node) need(node.input); };
  need(graph.output);
  let evaluatedVertices = 0;
  for (const id of order) {
    if (!needed.has(id)) continue;
    const node = nodes.get(id)!;
    let mesh: AuthoringMesh;
    switch (node.type) {
      case 'primitive': mesh = primitive(node); break;
      case 'source': validateAuthoringMesh(node.mesh); mesh = cloneMesh(node.mesh); break;
      case 'profile': { const depth = positive(node.depth, 'profile depth'); mesh = sweepProfile(node.profile, [{ x: 0, y: 0, z: -depth / 2 }, { x: 0, y: 0, z: depth / 2 }], id); break; }
      case 'sweep': mesh = sweepProfile(node.profile, node.path, id, node.caps ?? true); break;
      case 'transform': {
        const input = prepare(cache.get(node.input)!, node.bakeProtectedAttributes), translation = finiteVec(node.translation ?? { x: 0, y: 0, z: 0 }, 'translation'), rotation = finiteVec(node.rotation ?? { x: 0, y: 0, z: 0 }, 'rotation'), scale = finiteVec(node.scale ?? { x: 1, y: 1, z: 1 }, 'scale');
        mesh = transformMesh(input, new Matrix4().compose(new Vector3(translation.x, translation.y, translation.z), new Quaternion().setFromEuler(new Euler(rotation.x, rotation.y, rotation.z, 'XYZ')), new Vector3(scale.x, scale.y, scale.z))); break;
      }
      case 'mirror': {
        if (!['x', 'y', 'z'].includes(node.axis)) throw new Error('Mirror axis must be x, y, or z');
        const offset = finite(node.offset ?? 0, 'mirror offset'), input = prepare(cache.get(node.input)!, node.bakeProtectedAttributes);
        const scale = new Vector3(1, 1, 1).setComponent(node.axis === 'x' ? 0 : node.axis === 'y' ? 1 : 2, -1), translation = new Vector3().setComponent(node.axis === 'x' ? 0 : node.axis === 'y' ? 1 : 2, 2 * offset);
        const reflected = transformMesh(input, new Matrix4().compose(translation, new Quaternion(), scale)); mesh = node.includeOriginal === false ? reflected : mergeMeshes([input, reflected], id); break;
      }
      case 'array': {
        boundedInteger(node.count, 1, 256, 'array count'); finiteVec(node.offset, 'array offset');
        const input = prepare(cache.get(node.input)!, node.bakeProtectedAttributes);
        if (input.positions!.length / 3 * node.count > AUTHORING_LIMITS.vertices || input.indices!.length / 3 * node.count > AUTHORING_LIMITS.triangles) throw new Error('Array exceeds the geometry budget');
        mesh = mergeMeshes(Array.from({ length: node.count }, (_, i) => transformMesh(input, new Matrix4().makeTranslation(node.offset.x * i, node.offset.y * i, node.offset.z * i))), id); break;
      }
      case 'subdivide': mesh = subdivideMesh(prepare(cache.get(node.input)!, node.bakeProtectedAttributes), node.iterations ?? 1); break;
    }
    mesh.name = id; validateAuthoringMesh(mesh);
    evaluatedVertices += mesh.positions!.length / 3;
    if (evaluatedVertices > AUTHORING_LIMITS.vertices * 4) throw new Error('Geometry graph intermediate allocations exceed the budget');
    cache.set(id, mesh);
  }
  const output = cloneMesh(cache.get(graph.output)!); output.name = name; return output;
}
