import type { ComputerUseApp, ComputerUseApprovalContext } from './policy';

export type Row = Record<string, unknown>;
export interface Bounds { x: number; y: number; width: number; height: number }
export interface AppIdentity extends ComputerUseApp { name: string; path: string; pid?: number; windowCount?: number }
export interface Element {
  index: string; path: string; depth: number; role?: string; subrole?: string; roleDescription?: string;
  name?: string; title?: string; label?: string; identifier?: string; value?: string; description?: string; help?: string;
  settable: boolean; enabled?: boolean; focused?: boolean; actions: Array<{ raw: string; description: string }>; bounds?: Bounds;
}
export interface AppSnapshot {
  app: AppIdentity; windowId: number; bounds: Bounds; elements: Element[];
  treeTruncated?: boolean; loading?: boolean; observationChanged?: boolean;
  screenshot: { data: string; mimeType: 'image/jpeg'; width: number; height: number; bounds?: Bounds };
}
export interface DesktopSnapshot {
  /** The foreground application at capture time; null when no identity is resolvable. */
  app: AppIdentity | null;
  screenshot: { data: string; mimeType: 'image/jpeg'; width: number; height: number };
  /** Physical pixel rectangle spanned by all visible displays. */
  virtualBounds: Bounds;
  displays: Array<{ bounds: Bounds; width: number; height: number }>;
  sourceWidth: number; sourceHeight: number;
}
export interface NativeRequest {
  resourceId: string; operationId: string; generation: number; sequence: number;
  method: 'listApps' | 'resolve' | 'activate' | 'state' | 'action' | 'appshot' | 'desktopState' | 'desktopAction'; args: Row;
}
export interface ComputerUseBackend {
  availability(): { available: boolean; error?: string };
  request(request: NativeRequest, signal: AbortSignal): Promise<unknown>;
  close(deadlineMs?: number): Promise<{ complete: boolean }>;
}
export interface ComputerUseContext extends ComputerUseApprovalContext {
  /** A non-empty engine turn identity, resolved by the authenticated host. */
  turnId: string;
}
export interface ComputerUseResult { content: Array<Row>; structuredContent?: Row; _meta?: Row }

export function object(value: unknown, label = 'arguments'): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Computer Use ${label} must be an object`);
  return value as Row;
}
export function string(value: unknown, label: string, max = 4096, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) throw new Error(`Invalid Computer Use ${label}`);
  return value;
}
export function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid Computer Use ${label}`);
  return value;
}
export function appIdentity(value: unknown): AppIdentity {
  const row = object(value, 'application identity');
  return { input: string(row.input, 'app'), name: string(row.name, 'app name'), path: string(row.path, 'app path'),
    ...(row.bundleId == null || row.bundleId === '' ? {} : { bundleId: string(row.bundleId, 'bundle identifier') }),
    ...(row.pid == null ? {} : { pid: number(row.pid, 'pid', 1, 0x7fffffff, true) }),
    ...(row.windowCount == null ? {} : { windowCount: number(row.windowCount, 'window count', 0, 4096, true) }) };
}
export function sameApp(a: AppIdentity, b: AppIdentity): boolean {
  return a.path === b.path && a.bundleId === b.bundleId && (a.pid === undefined || a.pid === b.pid);
}
export async function deadline(task: Promise<unknown>, milliseconds = 5000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([task.then(() => true, () => true), new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), Math.max(0, Math.min(30_000, Number.isFinite(milliseconds) ? milliseconds : 5000)));
  })]); } finally { if (timer) clearTimeout(timer); }
}
