// Boot the keybinding system. Must run AFTER chat.ts has populated
// `window.klausKeybindingActions` and after the command-menu host has mounted,
// because the fallback handlers call into those. Order in app-entry.ts pins this.

import { installCommandHandlers } from './commands';
import { mountKeyboardShortcutsDialog } from './dialog-host';
import { mountKeybindingRuntime } from './runtime';
import { loadKeymapState } from './state';

let booted = false;

export function bootKeybindings(): void {
  if (booted) return;
  booted = true;
  // Load the stored keymap first so the fallback handlers and the dialog render
  // against real bindings; install handlers, mount the overview dialog, then
  // start the runtime (which attaches listeners for every dispatchable command).
  void loadKeymapState().then(() => {
    installCommandHandlers();
    mountKeyboardShortcutsDialog();
    mountKeybindingRuntime();
  });
}
