// Keybinding runtime: turns the stored keymap into live window listeners.
//
// The orchestration splits three ways:
//   - each surface registers the commands IT owns via `registerCommandHandler`
//     (`registerCommandHandler(commandId, handler)`), optionally with an
//     `isActive` guard;
//   - this module reads the keymap and, for every renderer command that has at
//     least one handler, attaches a window keydown listener per binding,
//     dispatching through `dispatchCommand`;
//   - a `keymap:changed` push rebuilds the listeners so an edit on the settings
//     page, from the agent, or in a second window takes effect immediately.
//
// os-global commands are NOT handled here — they live in the host's Electron
// globalShortcut registration (KeymapService + DesktopShortcuts).

import {
  isAppScope,
  isOsGlobal,
  reservedFindCommand,
  type KeybindingCommand,
} from '../../../../contracts/keybindings';
import {
  KEYMAP_PLATFORM,
  entriesFor,
  loadKeymapState,
  registry,
  subscribeKeymap,
} from './state';
import {
  dispatchCommand,
  hasFallbackCommandHandler,
  registerKeybindingListener,
  registeredHandlerCount,
  shouldDispatchWithinScope,
  type KeybindingListenerHandle,
} from './dispatcher';

/** Per-command scope overrides: `onlyWithin` / `yieldToSelectedText`
 *  plus the `canStart` gate the chord-prefix overlap needs. A command listed
 *  here only dispatches inside the selector, and (when `yieldToSelectedText`)
 *  steps aside for a real text selection so the binding cannot swallow a copy.
 *
 *  `openCommandMenu` (⌘K, F) yields while the work panel is the active surface:
 *  there ⌘K starts the close-tabs chord instead (`⌘K W` / `⌘K U`), which is the
 *  binding the panel already had. Everywhere else ⌘K opens the command menu.
 *  The gate is evaluated before a chord arms, so ⌘K never gets consumed by the
 *  wrong command inside the panel.
 *
 *  ⌘F additionally yields to any surface that owns an in-window find bar while
 *  that bar would claim the key — the Spec document panel publishes that state
 *  through `klausSpecPanelOwnsFind`, mirroring the exact gate its own keydown
 *  listener applies. ⌘K is unaffected: the panel never claims it. */
interface ScopeOverride {
  onlyWithin?: string;
  yieldToSelectedText?: boolean;
  canStart?: (event: KeyboardEvent) => boolean;
}

function isWorkspaceSurfaceActive(): boolean {
  return typeof (window as any).isWorkspaceMainViewActive === 'function' && (window as any).isWorkspaceMainViewActive() === true;
}

/** True when an in-surface find bar would swallow ⌘F for this event. */
function findSurfaceOwnsKey(): boolean {
  const owns = (window as any).klausSpecPanelOwnsFind;
  return typeof owns === 'function' && owns() === true;
}

/** The command-menu gate: the work panel owns ⌘K for its close-tabs chord, and
 *  an open in-surface find bar owns ⌘F. */
function commandMenuGate(event: KeyboardEvent): boolean {
  if (isWorkspaceSurfaceActive()) return false;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && typeof event.key === 'string' && event.key.toLowerCase() === 'f') {
    return !findSurfaceOwnsKey();
  }
  return true;
}

// The work panel's commands only apply while that surface is up and no IME
// composition is running — the two guards its hardcoded listener used to carry.
const workspaceGate = (event: KeyboardEvent): boolean => isWorkspaceSurfaceActive() && !event.isComposing;

const SCOPE_OVERRIDES: Record<string, ScopeOverride> = {
  openCommandMenu: { canStart: commandMenuGate },
  workspaceSave: { canStart: workspaceGate },
  workspaceCloseTab: { canStart: workspaceGate },
  workspaceCloseAll: { canStart: workspaceGate },
  workspaceCloseUnsaved: { canStart: workspaceGate },
};

let listeners: KeybindingListenerHandle[] = [];
let mounted = false;

/** Commands that fire in-window. os-global ones are registered by the host. */
function rendererCommands(): KeybindingCommand[] {
  return registry.list().filter(command => command.kind !== 'host-only' && !isOsGlobal(command));
}

/** A command is dispatchable when something can actually run it: a component
 *  registered a handler, or a fallback exists. The gate keeps the read-only
 *  dialog and the dispatcher from ever advertising a binding that does
 *  nothing. */
function isDispatchable(commandId: string): boolean {
  return registeredHandlerCount(commandId) > 0 || hasFallbackCommandHandler(commandId);
}

function disposeListeners(): void {
  for (const handle of listeners) handle.dispose();
  listeners = [];
}

/** Build one listener per binding for every dispatchable renderer command. */
function rebuild(): void {
  disposeListeners();
  for (const command of rendererCommands()) {
    if (!isDispatchable(command.id)) continue;
    const override = SCOPE_OVERRIDES[command.id];
    for (const entry of entriesFor(command.id)) {
      // A binding that collides with the window's reserved Find keys is never
      // registered here; the reservation is enforced at the
      // storage/UI layer, this is the second line of defence.
      if (reservedFindCommand(entry.accelerator, KEYMAP_PLATFORM) != null) continue;
      const commandId = command.id;
      listeners.push(registerKeybindingListener({
        accelerator: entry.accelerator,
        platform: KEYMAP_PLATFORM,
        allowRepeat: command.allowsKeyRepeat === true,
        ...(override?.canStart == null ? {} : { canStart: override.canStart }),
        onKeyDown: event => {
          if (event.defaultPrevented) return;
          if (!shouldDispatchWithinScope(event, override?.onlyWithin, override?.yieldToSelectedText === true)) return;
          if (dispatchCommand(commandId, 'keyboard_shortcut', event)) event.preventDefault();
        },
      }));
    }
  }
}

/**
 * Start the runtime. Idempotent: a second call is a no-op. Loads the keymap,
 * builds the listeners, subscribes to host-side changes so edits anywhere take
 * effect without a reload, and forwards native-menu clicks through the same
 * dispatch path a keybinding uses (the pushed `keymapRunCommand` message).
 */
export function mountKeybindingRuntime(): void {
  if (mounted) return;
  mounted = true;
  // App-lifetime subscription: it lives as long as the window, so the disposer
  // is intentionally not kept. rebuild() runs on every host keymap change.
  subscribeKeymap(() => rebuild());
  installMenuCommandForwarding();
  void loadKeymapState().then(() => rebuild());
}

let menuForwardingInstalled = false;

/** A native menu item carries no keyboard event; it arrives as a pushed command
 *  id and is dispatched with source `native_menu`, so a menu click and a
 *  keypress run the identical handler. */
function installMenuCommandForwarding(): void {
  if (menuForwardingInstalled) return;
  const on = (window as any).klaus?.on;
  if (typeof on?.keymapRunCommand !== 'function') return;
  menuForwardingInstalled = true;
  on.keymapRunCommand(({ commandId }: { commandId: string }) => {
    if (typeof commandId === 'string' && commandId.length > 0) dispatchCommand(commandId, 'native_menu');
  });
}

/** Rebuild listeners after the set of registered command handlers changed (a
 *  surface mounted/unmounted). */
export function refreshKeybindingRuntime(): void {
  if (mounted) rebuild();
}

/** Whether a command currently has a binding in force AND something to run it.
 *  The read-only dialog uses this to decide what to list. */
export function isCommandActive(commandId: string): boolean {
  return isDispatchable(commandId) && entriesFor(commandId).length > 0;
}

export { dispatchCommand, isAppScope };
