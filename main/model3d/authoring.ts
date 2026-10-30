import type { Vec3 } from './model';
import { Vector3 } from 'three/src/math/Vector3.js';
import { AUTHORING_LIMITS, boundedInteger, cloneMesh, customMesh, duplicateMeshVertices, edgeKey, finite, finiteVec, meshNormals, positive, validateAuthoringMesh, type AuthoringMesh } from './authoring-mesh';

export { AUTHORING_LIMITS, validateAuthoringMesh, meshNormals, type AuthoringMesh } from './authoring-mesh';
export { evaluateGeometryGraph, validateGeometryGraph, sweepProfile, type GeometryGraph, type GeometryGraphNode } from './authoring-geometry';
export { createRig, rigFromObjects, bindSkin, setSkinWeights, poseRig, deformSkinnedMesh, upsertRigKeyframes, sampleRigAnimation, type BoneSpec, type RigBuild, type RigSkin, type RigObject, type RigPose, type BindOptions, type RigAnimationTrack, type RigKeyframe } from './authoring-rig';

export interface SculptStroke {
  brush: 'draw' | 'inflate' | 'smooth' | 'flatten' | 'crease' | 'grab';
  point: Vec3;
  radius: number;
  /** Signed deformation in units of radius; smooth uses the interval [0,1]. */
  strength: number;
  normal?: Vec3;
  delta?: Vec3;
}
export interface SculptResult { mesh: AuthoringMesh; affectedVertices: number; strokeAffectedVertices: number[] }

/** Local vertex strokes with compact, C1-continuous radial falloff. */
export function sculptMesh(input: AuthoringMesh, strokes: readonly SculptStroke[]): SculptResult {
  validateAuthoringMesh(input);
  boundedInteger(strokes.length, 1, AUTHORING_LIMITS.strokes, 'stroke count');
  for (const stroke of strokes) {
    if (!['draw', 'inflate', 'smooth', 'flatten', 'crease', 'grab'].includes(stroke.brush)) throw new Error('Unknown sculpt brush');
    finiteVec(stroke.point, 'brush point'); positive(stroke.radius, 'brush radius'); finite(stroke.strength, 'brush strength');
    if (Math.abs(stroke.strength) > 1) throw new Error('Brush strength must be in [-1,1]');
    if (stroke.brush === 'smooth' && stroke.strength < 0) throw new Error('Smooth strength must be in [0,1]');
    if (stroke.normal) { finiteVec(stroke.normal, 'brush normal'); if (Math.hypot(stroke.normal.x, stroke.normal.y, stroke.normal.z) < 1e-12) throw new Error('Brush normal cannot be zero'); }
    if (stroke.delta) finiteVec(stroke.delta, 'grab delta');
    if (stroke.brush === 'grab' && !stroke.delta) throw new Error('Grab requires an explicit delta');
  }
  const mesh = customMesh(cloneMesh(input));
  const adjacency = Array.from({ length: mesh.positions!.length / 3 }, () => new Set<number>());
  for (let i = 0; i < mesh.indices!.length; i += 3) {
    const a = mesh.indices![i]!, b = mesh.indices![i + 1]!, c = mesh.indices![i + 2]!;
    for (const [from, to] of [[a, b], [a, c], [b, a], [b, c], [c, a], [c, b]]) adjacency[from!]!.add(to!);
  }
  const affected = new Set<number>();
  const counts: number[] = [];
  for (const stroke of strokes) {
    const before = mesh.positions!.slice(), normals = meshNormals(before, mesh.indices!);
    const weights = new Map<number, number>();
    for (let v = 0; v < before.length / 3; v++) {
      const x = before[v * 3]! - stroke.point.x, y = before[v * 3 + 1]! - stroke.point.y, z = before[v * 3 + 2]! - stroke.point.z;
      const squared = (x * x + y * y + z * z) / (stroke.radius * stroke.radius);
      if (squared < 1 && stroke.strength !== 0) weights.set(v, (1 - squared) ** 2);
    }
    const brushNormal = stroke.normal ? new Vector3(stroke.normal.x, stroke.normal.y, stroke.normal.z).normalize() : new Vector3();
    if (!stroke.normal) {
      for (const [v, weight] of weights) brushNormal.addScaledVector(new Vector3().fromArray(normals, v * 3), weight);
      if (brushNormal.lengthSq() < 1e-20) brushNormal.set(0, 0, 1);
      brushNormal.normalize();
    }
    let changed = 0;
    for (const [v, falloff] of weights) {
      const point = new Vector3().fromArray(before, v * 3);
      const next = point.clone();
      const amount = stroke.strength * falloff;
      switch (stroke.brush) {
        case 'draw': next.addScaledVector(brushNormal, amount * stroke.radius); break;
        case 'inflate': next.addScaledVector(new Vector3().fromArray(normals, v * 3), amount * stroke.radius); break;
        case 'smooth': {
          const neighbors = adjacency[v]!;
          if (neighbors.size) {
            const mean = new Vector3();
            for (const neighbor of neighbors) mean.add(new Vector3().fromArray(before, neighbor * 3));
            next.lerp(mean.divideScalar(neighbors.size), amount);
          }
          break;
        }
        case 'flatten': {
          const distance = new Vector3().subVectors(point, new Vector3(stroke.point.x, stroke.point.y, stroke.point.z)).dot(brushNormal);
          next.addScaledVector(brushNormal, -distance * amount); break;
        }
        case 'crease': {
          const inward = new Vector3(stroke.point.x, stroke.point.y, stroke.point.z).sub(point);
          inward.addScaledVector(brushNormal, -inward.dot(brushNormal));
          next.addScaledVector(inward, amount * 0.5).addScaledVector(brushNormal, -amount * stroke.radius * 0.25); break;
        }
        case 'grab': next.addScaledVector(new Vector3(stroke.delta!.x, stroke.delta!.y, stroke.delta!.z), amount); break;
      }
      if (!next.toArray().every(Number.isFinite)) throw new Error('Sculpt stroke produced non-finite geometry');
      if (next.distanceToSquared(point) > 1e-24) { next.toArray(mesh.positions!, v * 3); affected.add(v); changed++; }
    }
    counts.push(changed);
  }
  mesh.normals = meshNormals(mesh.positions!, mesh.indices!);
  // Existing tangents no longer describe the deformed surface; the importer
  // can regenerate them from unchanged UVs when a normal-map material needs it.
  delete mesh.tangents;
  validateAuthoringMesh(mesh);
  return { mesh, affectedVertices: affected.size, strokeAffectedVertices: counts };
}

export interface UVOptions {
  method?: 'unwrap' | 'planar' | 'box' | 'cylindrical' | 'spherical';
  axis?: 'x' | 'y' | 'z';
  seams?: Array<[number, number]>;
  angleDegrees?: number;
  /** Empty pixels are obtained by multiplying this UV fraction by image size. */
  padding?: number;
}
export interface UVIsland { id: number; triangles: number[]; vertices: number[]; rect: [number, number, number, number] }
export interface UVResult { mesh: AuthoringMesh; islands: UVIsland[]; seams: Array<[number, number]>; sourceVertexIndices: number[] }

/** Chart projection plus a non-overlapping grid atlas; seams duplicate attrs. */
export function unwrapMesh(input: AuthoringMesh, options: UVOptions = {}): UVResult {
  validateAuthoringMesh(input);
  const method = options.method ?? 'unwrap';
  if (!['unwrap', 'planar', 'box', 'cylindrical', 'spherical'].includes(method)) throw new Error('Unknown UV projection method');
  const axis = options.axis ?? 'z';
  if (!['x', 'y', 'z'].includes(axis)) throw new Error('Projection axis must be x, y, or z');
  const angle = options.angleDegrees ?? 45;
  finite(angle, 'chart angle');
  if (angle < 1 || angle > 85) throw new Error('Chart angle must be from 1 to 85 degrees');
  const padding = options.padding ?? 0.01;
  finite(padding, 'UV padding');
  if (padding < 0 || padding >= 0.25) throw new Error('UV padding must be in [0,0.25)');
  const vertexCount = input.positions!.length / 3, triangles = input.indices!.length / 3;
  const seamSet = new Set<string>();
  for (const [a, b] of options.seams ?? []) { boundedInteger(a, 0, vertexCount - 1, 'seam vertex'); boundedInteger(b, 0, vertexCount - 1, 'seam vertex'); if (a === b) throw new Error('A seam needs two distinct vertices'); seamSet.add(edgeKey(a, b)); }
  const points = Array.from({ length: vertexCount }, (_, v) => new Vector3().fromArray(input.positions!, v * 3));
  const faceNormals: Vector3[] = [];
  const edges = new Map<string, number[]>();
  for (let t = 0; t < triangles; t++) {
    const a = input.indices![t * 3]!, b = input.indices![t * 3 + 1]!, c = input.indices![t * 3 + 2]!;
    faceNormals.push(new Vector3().subVectors(points[b]!, points[a]!).cross(new Vector3().subVectors(points[c]!, points[a]!)).normalize());
    for (const [v1, v2] of [[a, b], [b, c], [c, a]]) { const key = edgeKey(v1!, v2!); const faces = edges.get(key) ?? []; faces.push(t); edges.set(key, faces); }
  }
  const adjacency = Array.from({ length: triangles }, () => new Set<number>());
  for (const [key, faces] of edges) if (!seamSet.has(key) && faces.length === 2) { adjacency[faces[0]!]!.add(faces[1]!); adjacency[faces[1]!]!.add(faces[0]!); }
  const faceIsland = Array<number>(triangles).fill(-1);
  const charts: number[][] = [];
  const side = (normal: Vector3): string => {
    const values = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    const major = values.indexOf(Math.max(...values));
    return `${major}:${normal.getComponent(major) < 0 ? '-' : '+'}`;
  };
  const threshold = Math.cos(angle * Math.PI / 180);
  for (let seed = 0; seed < triangles; seed++) {
    if (faceIsland[seed] !== -1) continue;
    const id = charts.length, faces: number[] = [], queue = [seed]; faceIsland[seed] = id;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const face = queue[cursor]!; faces.push(face);
      for (const neighbor of adjacency[face]!) if (faceIsland[neighbor] === -1) {
        const allowed = method === 'unwrap' ? faceNormals[seed]!.dot(faceNormals[neighbor]!) >= threshold : method === 'box' ? side(faceNormals[seed]!) === side(faceNormals[neighbor]!) : true;
        if (allowed) { faceIsland[neighbor] = id; queue.push(neighbor); }
      }
    }
    charts.push(faces);
  }
  const source: number[] = [], indices = Array<number>(input.indices!.length), uv: number[] = [];
  const cornerParent = Array.from({ length: input.indices!.length }, (_, i) => i);
  const findCorner = (i: number): number => { while (cornerParent[i] !== i) { cornerParent[i] = cornerParent[cornerParent[i]!]!; i = cornerParent[i]!; } return i; };
  for (const [edge, faces] of edges) if (faces.length === 2 && !seamSet.has(edge) && faceIsland[faces[0]!] === faceIsland[faces[1]!]) {
    for (const original of edge.split(':').map(Number)) {
      const a = faces[0]! * 3 + input.indices!.slice(faces[0]! * 3, faces[0]! * 3 + 3).indexOf(original);
      const b = faces[1]! * 3 + input.indices!.slice(faces[1]! * 3, faces[1]! * 3 + 3).indexOf(original);
      cornerParent[findCorner(a)] = findCorner(b);
    }
  }
  const islands: UVIsland[] = [];
  const columns = Math.ceil(Math.sqrt(charts.length)), rows = Math.ceil(charts.length / columns);
  const vertical = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const horizontal = (vertical + 1) % 3, depth = (vertical + 2) % 3;
  for (const [id, faces] of charts.entries()) {
    const normal = new Vector3(); for (const face of faces) normal.add(faceNormals[face]!);
    if (normal.lengthSq() < 1e-20) normal.set(0, 0, 1); normal.normalize();
    const basisU = method === 'planar' ? new Vector3().setComponent(horizontal, 1) : new Vector3().crossVectors(Math.abs(normal.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0), normal).normalize();
    const basisV = method === 'planar' ? new Vector3().setComponent(depth, 1) : new Vector3().crossVectors(normal, basisU).normalize();
    const map = new Map<string, number>(), chartVertices: number[] = [];
    const rawUV = new Map<number, [number, number]>();
    for (const face of faces) {
      const corners = [0, 1, 2].map(c => input.indices![face * 3 + c]!);
      const values: [number, number][] = corners.map(index => {
        const p = points[index]!;
        if (method === 'cylindrical' || method === 'spherical') {
          const u = Math.atan2(p.getComponent(depth), p.getComponent(horizontal)) / (2 * Math.PI) + 0.5;
          const radius = p.length();
          const v = method === 'spherical' ? radius > 1e-20 ? Math.acos(Math.max(-1, Math.min(1, p.getComponent(vertical) / radius))) / Math.PI : 0.5 : p.getComponent(vertical);
          return [u, v];
        }
        return [p.dot(basisU), p.dot(basisV)];
      });
      if (method === 'cylindrical' || method === 'spherical') {
        if (Math.max(...values.map(v => v[0])) - Math.min(...values.map(v => v[0])) > 0.5) for (const value of values) if (value[0] < 0.5) value[0] += 1;
        if (method === 'spherical') for (let c = 0; c < 3; c++) if (Math.hypot(points[corners[c]!]!.getComponent(horizontal), points[corners[c]!]!.getComponent(depth)) < 1e-12) values[c]![0] = (values[(c + 1) % 3]![0] + values[(c + 2) % 3]![0]) / 2;
      }
      for (let c = 0; c < 3; c++) {
        const value = values[c]!, original = corners[c]!;
        const key = `${findCorner(face * 3 + c)}:${value[0].toPrecision(14)}:${value[1].toPrecision(14)}`;
        let target = map.get(key);
        if (target === undefined) { target = source.length; map.set(key, target); source.push(original); chartVertices.push(target); rawUV.set(target, value); }
        indices[face * 3 + c] = target;
      }
    }
    if (source.length > AUTHORING_LIMITS.vertices) throw new Error('UV seams exceed the vertex budget');
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const value of rawUV.values()) { minU = Math.min(minU, value[0]); maxU = Math.max(maxU, value[0]); minV = Math.min(minV, value[1]); maxV = Math.max(maxV, value[1]); }
    const scale = Math.max(maxU - minU, maxV - minV, 1e-12);
    const cellX = id % columns, cellY = Math.floor(id / columns), width = 1 / columns, height = 1 / rows;
    const usable = Math.min(width, height) * (1 - 2 * padding);
    const startU = cellX * width + (width - usable * (maxU - minU) / scale) / 2;
    const startV = cellY * height + (height - usable * (maxV - minV) / scale) / 2;
    for (const [v, value] of rawUV) { uv[v * 2] = startU + (value[0] - minU) / scale * usable; uv[v * 2 + 1] = startV + (value[1] - minV) / scale * usable; }
    islands.push({ id, triangles: faces.slice(), vertices: chartVertices, rect: [cellX * width, cellY * height, width, height] });
  }
  for (const [edge, faces] of edges) if (faces.length !== 2 || faceIsland[faces[0]!] !== faceIsland[faces[1]!]) seamSet.add(edge);
  const mesh = duplicateMeshVertices(input, source, indices); mesh.uvs = uv; delete mesh.tangents;
  validateAuthoringMesh(mesh);
  return { mesh, islands, seams: [...seamSet].map(key => key.split(':').map(Number) as [number, number]), sourceVertexIndices: source };
}
