// Renderer-side keymap state: the live registry plus the bindings the host
// stores, kept current across writes and host pushes.
//
// There is no react-query in the shell layer, so this module is the store: one
// subscription list, one cached snapshot, and a `keymap:changed` listener that
// re-reads the host after a write that came from elsewhere (the agent's
// `quickInput.setShortcut`, a second window, a hand-edited file).

import {
  KeybindingRegistry,
  formatAccelerator,
  shortcutEntries,
  hasCustomBinding,
  resetChipIndex,
  compareCommands,
  sectionKeyOf,
  isCommandAvailable,
  type KeybindingCommand,
  type KeybindingCapability,
  type KeybindingPlatform,
  type KeymapState,
  type ShortcutEntry,
} from '../../../../contracts/keybindings';
import { KLAUS_COMMANDS, FIND_COMMAND_ID } from '../../../../contracts/keybindings-commands';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');
const IS_LINUX = typeof navigator !== 'undefined' && /Linux/i.test(navigator.platform || '');

/** The platform string the shared contract functions expect. */
export const KEYMAP_PLATFORM: KeybindingPlatform = IS_MAC ? 'macOS' : IS_LINUX ? 'linux' : 'windows';

/** Which optional surfaces this build actually has. A command gated on one of
 *  these is listed here, because the desktop client has all of them. */
const AVAILABLE_CAPABILITIES: ReadonlySet<KeybindingCapability> = new Set<KeybindingCapability>([
  'browser', 'dictation', 'terminal', 'voice', 'worktree',
]);

export const registry = new KeybindingRegistry(KLAUS_COMMANDS, {
  platform: KEYMAP_PLATFORM,
  capabilities: AVAILABLE_CAPABILITIES,
  ...(FIND_COMMAND_ID == null ? {} : { findCommandId: FIND_COMMAND_ID }),
});

let state: KeymapState | null = null;
let loadPromise: Promise<KeymapState | null> | null = null;
const listeners = new Set<() => void>();
let pushSubscription: (() => void) | null = null;

function api(): any {
  return (window as any).klaus?.settings?.keymap;
}

/** Read the host state once, then serve the snapshot. */
export async function loadKeymapState(): Promise<KeymapState | null> {
  if (state != null) return state;
  loadPromise ??= (async () => {
    try {
      const loaded = await api()?.state?.();
      state = normalizeState(loaded);
    } catch {
      state = { supported: true, keymapPath: '', bindings: [] };
    }
    emit();
    return state;
  })();
  return loadPromise;
}

function normalizeState(loaded: unknown): KeymapState {
  if (loaded == null || typeof loaded !== 'object') return { supported: true, keymapPath: '', bindings: [] };
  const bindings = Array.isArray((loaded as any).bindings) ? (loaded as any).bindings : [];
  return {
    supported: (loaded as any).supported !== false,
    keymapPath: typeof (loaded as any).keymapPath === 'string' ? (loaded as any).keymapPath : '',
    bindings: bindings
      .filter((row: any) => row != null && typeof row.command === 'string')
      .map((row: any) => ({ command: row.command, key: typeof row.key === 'string' ? row.key : null })),
  };
}

/** The current snapshot; null until the first read resolves. Callers that render
 *  a loading state check for null. */
export function keymapState(): KeymapState | null {
  return state;
}

export function subscribeKeymap(listener: () => void): () => void {
  listeners.add(listener);
  ensurePushSubscription();
  return () => { listeners.delete(listener); };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Host writes that did not originate here (the agent's setShortcut, another
 *  window) arrive as `keymap:changed`; re-read rather than guess at the delta. */
function ensurePushSubscription(): void {
  if (pushSubscription != null) return;
  const on = (window as any).klaus?.on;
  if (typeof on?.keymapChanged !== 'function') return;
  pushSubscription = on.keymapChanged(() => { void refreshKeymapState(); });
}

export async function refreshKeymapState(): Promise<KeymapState | null> {
  loadPromise = null;
  state = null;
  return loadKeymapState();
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

export interface KeymapMutationError {
  message: string;
}

/** Apply one update through the host, then adopt the state it returns: the
 *  response is the fresh snapshot, so no extra re-read is needed. */
export async function setCommandKeybinding(
  commandId: string,
  update:
    | { type: 'set'; accelerator: string }
    | { type: 'replace'; previousAccelerator: string; accelerator: string }
    | { type: 'append'; accelerator: string }
    | { type: 'remove'; accelerator: string }
    | { type: 'clear' }
    | { type: 'reset' },
): Promise<KeymapState> {
  const result = await api()?.set?.(commandId, update);
  state = normalizeState(result);
  loadPromise = Promise.resolve(state);
  emit();
  return state;
}

export async function resetAllKeybindings(): Promise<KeymapState> {
  const result = await api()?.reset?.();
  state = normalizeState(result);
  loadPromise = Promise.resolve(state);
  emit();
  return state;
}

// ---------------------------------------------------------------------------
// derived views
// ---------------------------------------------------------------------------

/** The rows the settings page lists: configurable, available on this platform
 *  and in this build, minus the window's own Find command. */
export function editableCommands(): KeybindingCommand[] {
  return registry.visible().filter(command => command.id !== FIND_COMMAND_ID);
}

/** The read-only dialog's data: every command with a binding in force, grouped.
 *  A command nobody can run is not advertised, so a live handler is required
 *  too; `registeredHandlerCount` supplies that here. */
export function activeShortcutRows(isRegistered: (commandId: string) => boolean): Array<{ command: KeybindingCommand; entries: ShortcutEntry[] }> {
  return registry.visible()
    .filter(command => command.id === FIND_COMMAND_ID || isRegistered(command.id))
    .map(command => ({ command, entries: entriesFor(command.id) }))
    .filter(row => row.entries.length > 0);
}

/** The binding chips for one command, with platform-correct labels. */
export function entriesFor(commandId: string): ShortcutEntry[] {
  return shortcutEntries(commandId, state, registry);
}

export function isCustomized(commandId: string): boolean {
  return hasCustomBinding(commandId, state);
}

/** Which chip owns the reset button, or null when nothing is customized. */
export function resetIndexFor(commandId: string, entries: ShortcutEntry[]): number | null {
  return resetChipIndex({ commandId, hasCustomBinding: isCustomized(commandId), entries, registry });
}

export function isAvailable(command: KeybindingCommand): boolean {
  return isCommandAvailable(command, AVAILABLE_CAPABILITIES, KEYMAP_PLATFORM);
}

export function formatBinding(accelerator: string): string {
  return formatAccelerator(accelerator, KEYMAP_PLATFORM);
}

/**
 * The display label for a command's FIRST binding, or null when it has none.
 * Context menus and inline hints show this instead of a hardcoded string, so a
 * binding the user changed or cleared is reflected everywhere it is advertised —
 * the post-write fan-out that covers "key hints in the UI".
 */
export function bindingLabelFor(commandId: string): string | null {
  const entries = entriesFor(commandId);
  return entries.length > 0 ? entries[0]!.label : null;
}

/** Section titles for the read-only dialog, in display order. */
export const SECTION_ORDER = ['thread', 'navigation', 'panels', 'workspace', 'skills', 'configure', 'app', 'general'] as const;
export type SectionKey = typeof SECTION_ORDER[number];

export function sectionOf(command: KeybindingCommand): SectionKey {
  return sectionKeyOf(command) as SectionKey;
}

/** Group active rows into ordered sections, dropping empty ones. */
export function groupActiveRows(rows: Array<{ command: KeybindingCommand; entries: ShortcutEntry[] }>): Array<{ key: SectionKey; rows: typeof rows }> {
  const grouped: Array<{ key: SectionKey; rows: typeof rows }> = [];
  for (const key of SECTION_ORDER) {
    const members = rows.filter(row => sectionOf(row.command) === key);
    if (members.length > 0) grouped.push({ key, rows: members });
  }
  return grouped;
}

/** Group order, then the in-group priority list, then id. */
export function sortCommands(commands: KeybindingCommand[], priorityIds: readonly string[] = []): KeybindingCommand[] {
  return [...commands].sort((left, right) => compareCommands(left, right, priorityIds));
}

export { registry as keymapRegistry, KLAUS_COMMANDS, FIND_COMMAND_ID };
