import type { Model3DDocument, Object3DRecord } from './model';

export const identityMatrix = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Matrices are column-major; a * b applies b first. */
export function multiplyMatrices(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4; k++) out[col * 4 + row]! += a[k * 4 + row]! * b[col * 4 + k]!;
  }
  return out;
}

export function invertMatrix(matrix: number[]): number[] {
  const rows = Array.from({ length: 4 }, (_, row) => [
    ...Array.from({ length: 4 }, (_, col) => matrix[col * 4 + row]!),
    ...Array.from({ length: 4 }, (_, col) => row === col ? 1 : 0),
  ]);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++) if (Math.abs(rows[row]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = row;
    if (Math.abs(rows[pivot]![col]!) < 1e-14) throw new Error('Cannot invert a singular scene matrix.');
    [rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!];
    const divisor = rows[col]![col]!;
    for (let k = 0; k < 8; k++) rows[col]![k]! /= divisor;
    for (let row = 0; row < 4; row++) if (row !== col) {
      const factor = rows[row]![col]!;
      for (let k = 0; k < 8; k++) rows[row]![k]! -= factor * rows[col]![k]!;
    }
  }
  return Array.from({ length: 16 }, (_, index) => rows[index % 4]![4 + Math.floor(index / 4)]!);
}

export function quaternionFromEuler(x: number, y: number, z: number): number[] {
  const cx = Math.cos(x / 2), cy = Math.cos(y / 2), cz = Math.cos(z / 2);
  const sx = Math.sin(x / 2), sy = Math.sin(y / 2), sz = Math.sin(z / 2);
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
}

export function quaternionMatrix(quaternion: number[]): number[] {
  const length = Math.hypot(...quaternion);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error('A scene rotation has an invalid quaternion.');
  const [x, y, z, w] = quaternion.map(value => value / length) as [number, number, number, number];
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0, 0, 0, 0, 1];
}

export function composeTransform(transform: Object3DRecord['transform']): number[] {
  if (transform.matrix) return [...transform.matrix];
  const q = transform.rotationQuaternion ?? quaternionFromEuler(transform.rotationEuler.x, transform.rotationEuler.y, transform.rotationEuler.z);
  const result = quaternionMatrix(q);
  const scales = [transform.scale.x, transform.scale.y, transform.scale.z];
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) result[col * 4 + row]! *= scales[col]!;
  result[12] = transform.location.x;
  result[13] = transform.location.y;
  result[14] = transform.location.z;
  return result;
}

export function quaternionToEuler(q: number[]): { x: number; y: number; z: number } {
  const m = quaternionMatrix(q);
  const y = Math.asin(Math.max(-1, Math.min(1, m[8]!)));
  return Math.abs(m[8]!) < 0.9999999
    ? { x: Math.atan2(-m[9]!, m[10]!), y, z: Math.atan2(-m[4]!, m[0]!) }
    : { x: Math.atan2(m[6]!, m[5]!), y, z: 0 };
}

function matrixQuaternion(m: number[]): number[] {
  const trace = m[0]! + m[5]! + m[10]!;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    return [(m[6]! - m[9]!) / s, (m[8]! - m[2]!) / s, (m[1]! - m[4]!) / s, s / 4];
  }
  if (m[0]! > m[5]! && m[0]! > m[10]!) {
    const s = 2 * Math.sqrt(Math.max(0, 1 + m[0]! - m[5]! - m[10]!));
    return [s / 4, (m[4]! + m[1]!) / s, (m[8]! + m[2]!) / s, (m[6]! - m[9]!) / s];
  }
  if (m[5]! > m[10]!) {
    const s = 2 * Math.sqrt(Math.max(0, 1 + m[5]! - m[0]! - m[10]!));
    return [(m[4]! + m[1]!) / s, s / 4, (m[9]! + m[6]!) / s, (m[8]! - m[2]!) / s];
  }
  const s = 2 * Math.sqrt(Math.max(0, 1 + m[10]! - m[0]! - m[5]!));
  return [(m[8]! + m[2]!) / s, (m[9]! + m[6]!) / s, s / 4, (m[1]! - m[4]!) / s];
}

/** Keep the exact matrix so shear and a zero-scale axis survive a round trip. */
export function matrixToTransform(matrix: number[]): Object3DRecord['transform'] {
  const scales = [Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!), Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!), Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!)];
  const determinant = matrix[0]! * (matrix[5]! * matrix[10]! - matrix[9]! * matrix[6]!)
    - matrix[4]! * (matrix[1]! * matrix[10]! - matrix[9]! * matrix[2]!)
    + matrix[8]! * (matrix[1]! * matrix[6]! - matrix[5]! * matrix[2]!);
  if (determinant < 0) scales[0]! *= -1;
  const rotation = [...matrix];
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) rotation[col * 4 + row] = scales[col] ? matrix[col * 4 + row]! / scales[col]! : (col === row ? 1 : 0);
  let q = matrixQuaternion(rotation);
  const length = Math.hypot(...q);
  q = length > 1e-12 && Number.isFinite(length) ? q.map(value => value / length) : [0, 0, 0, 1];
  return { location: { x: matrix[12]!, y: matrix[13]!, z: matrix[14]! }, rotationEuler: quaternionToEuler(q),
    rotationQuaternion: q, scale: { x: scales[0]!, y: scales[1]!, z: scales[2]! }, matrix: [...matrix] };
}

export function worldMatrixOf(doc: Pick<Model3DDocument, 'objects'>, name: string): number[] {
  const objects = new Map(doc.objects.map(record => [record.name, record]));
  const visiting = new Set<string>();
  const evaluate = (key: string): number[] => {
    const record = objects.get(key);
    if (!record) throw new Error(`Scene object '${key}' is missing.`);
    if (visiting.has(key)) throw new Error(`Scene parent cycle at '${key}'.`);
    if (visiting.size > 256) throw new Error('Scene hierarchy exceeds the supported depth.');
    visiting.add(key);
    const local = composeTransform(record.transform);
    const matrix = record.parent ? multiplyMatrices(evaluate(record.parent), local) : local;
    visiting.delete(key);
    return matrix;
  };
  return evaluate(name);
}

export function yUpToZUpVector(v: number[]): number[] { return [v[0]!, -v[2]!, v[1]!]; }
export function zUpToYUpVector(v: number[]): number[] { return [v[0]!, v[2]!, -v[1]!]; }
export function convertRotationQuaternion(q: number[], importing: boolean): number[] {
  // Conjugating by a quarter-turn changes xyz exactly, including cubic tangents.
  return importing ? [q[0]!, -q[2]!, q[1]!, q[3]!] : [q[0]!, q[2]!, -q[1]!, q[3]!];
}
export function convertAxisMatrix(matrix: number[], importing: boolean): number[] {
  const c = importing ? [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]
    : [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  return multiplyMatrices(multiplyMatrices(c, matrix), invertMatrix(c));
}
