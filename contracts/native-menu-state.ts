/** Renderer-owned availability; the host keeps an independent snapshot per window. */
export const NATIVE_MENU_STATE_KEYS = [
  'newProject', 'terminal', 'browser', 'reloadBrowserPage', 'navigateBack', 'navigateForward', 'previousTab', 'nextTab',
] as const;

export type NativeMenuState = Record<typeof NATIVE_MENU_STATE_KEYS[number], boolean>;

export function parseNativeMenuState(value: unknown): NativeMenuState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== NATIVE_MENU_STATE_KEYS.length || NATIVE_MENU_STATE_KEYS.some(key => typeof row[key] !== 'boolean')) return null;
  return Object.fromEntries(NATIVE_MENU_STATE_KEYS.map(key => [key, row[key]])) as NativeMenuState;
}

export const INITIAL_NATIVE_MENU_STATE: NativeMenuState = {
  newProject: false, terminal: false, browser: false, reloadBrowserPage: false,
  navigateBack: false, navigateForward: false, previousTab: false, nextTab: false,
};
