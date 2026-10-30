import { quote } from './application';
import { string, type MacOsCallContext, type Row } from './types';

export interface UiNode extends Row { path: string; role: string | null; name: string | null; description: string | null; identifier: string | null }
export interface Frame { left: number; top: number; width: number; height: number; scale?: number }
export interface ScreenBounds extends Frame { right: number; bottom: number; screens: Frame[] }
export interface Mapping { path: string; screenshotPixelWidth: number; screenshotPixelHeight: number; screenshotScreenX: number; screenshotScreenY: number; screenshotScreenWidth: number; screenshotScreenHeight: number }
export interface AppUiState {
  snapshot?: { turnId: string; appName: string; pid: number; nodes: Map<string, UiNode> };
  capture?: { turnId: string; mapping: Mapping; screenSignature: string };
}
export const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown, name: string, optional = false): string => {
  const result = string(value, name, optional); if (result.length > 50_000) throw new Error(name + ' must contain at most 50000 UTF-16 units'); return result;
};
export const named = (args: Row): string => text(args.appName, 'appName', true).trim();
export function bool(value: unknown, name: string, fallback = false): boolean { if (value === undefined) return fallback; if (typeof value !== 'boolean') throw new Error(name + ' must be a boolean'); return value; }
export function number(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(name + ' must be a finite number'); return value;
}
export const bounded = (value: unknown, name: string, fallback: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, Math.floor(number(value, name, fallback))));
export function json(raw: string): Row { const row: unknown = JSON.parse(raw); if (!object(row)) throw new Error('App UI returned an invalid object'); return row; }
export function nodes(value: unknown): UiNode[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('App UI returned an invalid bounded tree');
  const paths = new Set<string>();
  return value.map(row => {
    if (!object(row) || typeof row.path !== 'string' || !/^(?:p|[1-9]\d*)(?:\.[1-9]\d*){0,8}$/.test(row.path) || paths.has(row.path)) throw new Error('App UI returned an invalid element path');
    paths.add(row.path);
    for (const key of ['role', 'subrole', 'name', 'value', 'description', 'identifier']) if (row[key] !== null && (typeof row[key] !== 'string' || (row[key] as string).length > 181)) throw new Error('App UI returned invalid element text');
    for (const key of ['enabled', 'focused']) if (row[key] !== null && typeof row[key] !== 'boolean') throw new Error('App UI returned invalid element flags');
    return row as UiNode;
  });
}
export const guidance = ['A missing element or window does not prove Accessibility permission is missing.', 'Use app_ui_check_permission for capability evidence; inspect the current target before retrying an action.'];
export function keyAction(keyValue: unknown, modifiersValue: unknown): string {
  const key = text(keyValue, 'key').toLowerCase(), keys: Record<string, number> = { return: 36, enter: 36, tab: 48, escape: 53, esc: 53, delete: 51, backspace: 51, left: 123, right: 124, up: 126, down: 125, home: 115, end: 119, pageup: 116, pagedown: 121, space: 49 };
  const aliases: Record<string, string> = { command: 'command', cmd: 'command', shift: 'shift', option: 'option', alt: 'option', control: 'control', ctrl: 'control' };
  if (modifiersValue !== undefined && (!Array.isArray(modifiersValue) || modifiersValue.length > 4)) throw new Error('modifiers must contain at most four modifiers');
  const modifiers = [...new Set(((modifiersValue ?? []) as unknown[]).map(value => { const name = aliases[text(value, 'modifier').toLowerCase()]; if (!name) throw new Error('Unsupported key modifier'); return name; }))];
  let action: string;
  if (Object.hasOwn(keys, key)) action = 'key code ' + keys[key];
  else if (/^[\x20-\x7E]$/.test(key)) action = 'keystroke ' + quote(text(keyValue, 'key'));
  else throw new Error('Unsupported key name');
  return action + (modifiers.length ? ' using {' + modifiers.map(value => value + ' down').join(', ') + '}' : '');
}
export function resolvePoint(args: Row, remembered?: Mapping): { x: number; y: number; input: Row; mapping?: Mapping } {
  let x = number(args.x, 'x'), y = number(args.y, 'y');
  const space = args.coordinateSpace ?? args.coordinatesSpace ?? 'screenPoints';
  if (space !== 'screenPoints' && space !== 'screenshotPixels') throw new Error('coordinateSpace must be screenPoints or screenshotPixels');
  const input = { x, y, coordinateSpace: space };
  if (space === 'screenPoints') return { x, y, input };
  const fields = ['screenshotPixelWidth', 'screenshotPixelHeight', 'screenshotScreenX', 'screenshotScreenY', 'screenshotScreenWidth', 'screenshotScreenHeight'] as const;
  const explicit = fields.some(key => args[key] !== undefined);
  if (explicit && fields.some(key => args[key] === undefined)) throw new Error('Provide all six screenshot mapping fields together');
  if (!explicit && !remembered) throw new Error('missing_screenshot_mapping: capture the screen in this session and turn first');
  const mapping = explicit ? Object.fromEntries(fields.map(key => [key, number(args[key], key)])) as unknown as Mapping : remembered!;
  if (mapping.screenshotPixelWidth <= 0 || mapping.screenshotPixelHeight <= 0 || mapping.screenshotScreenWidth <= 0 || mapping.screenshotScreenHeight <= 0 || x < 0 || y < 0 || x >= mapping.screenshotPixelWidth || y >= mapping.screenshotPixelHeight) throw new Error('The screenshot coordinates or mapping are outside their bounds');
  x = mapping.screenshotScreenX + x * mapping.screenshotScreenWidth / mapping.screenshotPixelWidth;
  y = mapping.screenshotScreenY + y * mapping.screenshotScreenHeight / mapping.screenshotPixelHeight;
  return { x, y, input, mapping };
}
export function selectTarget(args: Row, state: AppUiState, context: MacOsCallContext): { appName: string; script: string; path: string; query: string } {
  const path = text(args.elementPath, 'elementPath', true), query = text(args.query, 'query', true), role = text(args.role, 'role', true);
  if (!path && !query) throw new Error('Provide elementPath or query');
  let appName = named(args), script: string;
  if (path) {
    if (!/^(?:p|[1-9]\d*)(?:\.[1-9]\d*){0,8}$/.test(path)) throw new Error('Invalid elementPath');
    const snapshot = state.snapshot, expected = snapshot?.nodes.get(path);
    if (!snapshot || snapshot.turnId !== context.turnId || !expected || (appName && appName !== snapshot.appName)) throw new Error('The element path requires a current snapshot for this app in this session and turn');
    appName = snapshot.appName;
    script = `if unix id of p is not ${snapshot.pid} then error "The snapshot application process changed"
      set target_ to my uiPath(p, ${quote(path)})
      ${(['role', 'name', 'description', 'identifier'] as const).map((key, index) => `if (my uiText(target_, "${['AXRole', 'AXTitle', 'AXDescription', 'AXIdentifier'][index]}")) is not ${quote(expected[key] ?? '')} then error "The snapshot element changed; read the tree again"`).join('\n')}`;
  } else script = `set visited_ to 0
    set root_ to p
    if exists window 1 of p then set root_ to window 1 of p
    set target_ to my uiFind(root_, ${quote(query)}, ${quote(role)}, 0, 500)
    if target_ is missing value then error "element_not_found"`;
  return { appName, script, path, query };
}
