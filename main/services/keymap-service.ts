// The host-side keymap store: on-disk bindings, resolution, and the IPC the
// renderer's settings page and dispatcher talk to.
//
// The main-process keymap engine.
// All parsing, resolution and conflict rules live in
// contracts/keybindings.ts so host and renderer cannot drift; this module owns
// only what needs Node — reading/writing `~/.klaus/keybindings.json` and the
// update algebra.
//
// The file format is fixed: a JSON array of `{command, key|null}`,
// 2-space indent, trailing newline, sorted by command id. `key: null` means
// "explicitly unassigned", distinct from the command being absent (which falls
// back to the registry default).
//
// os-global commands (the two system hotkeys) are STORED here like everything
// else, but their Electron `globalShortcut` registration stays with the existing
// `DesktopShortcuts` (main/app/shortcuts.ts), which now reads its accelerators
// from this store via `globalSlotAccelerator`. One writer, one registrant.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  effectiveKeybindings,
  emptyKeymapState,
  isConfigurable,
  isOsGlobal,
  assertUpdateAllowedForScope,
  nextKeysForSet,
  parseKeymapFile,
  serializeKeymapFile,
  stripAcceleratorFromCommand,
  validateGlobalAccelerator,
  withoutCommand,
  withCommandKeys,
  dedupeKeys,
  KEYBINDINGS_FILE_NAME,
  type KeybindingCommand,
  type KeybindingRegistry,
  type KeymapState,
  type StoredKeybinding,
  type KeybindingUpdate,
} from '../../contracts/keybindings';

/** `<configRoot>/keybindings.json`, the single store for every command binding. */
export function keymapFilePath(configRoot: string): string {
  return join(configRoot, KEYBINDINGS_FILE_NAME);
}

export interface KeymapServiceDeps {
  registry: KeybindingRegistry;
  /** Absolute path to `keybindings.json` (config root + file name). */
  keymapPath: string;
  log(message: string): void;
  /** Called after every successful write so the host can re-apply os-global
   *  hotkeys, refresh the native menu, and push `keymap:changed` to the
   *  renderer. The same trio runs after every binding write. */
  onKeymapChanged(): void | Promise<void>;
}

/**
 * Owns the on-disk keymap. The renderer never writes the file directly: it
 * calls `update`/`resetAll` over IPC, which re-reads, mutates and re-writes
 * here, then reports the new state back. That single writer is what keeps the
 * stored bindings and the live registrations from disagreeing.
 */
export class KeymapService {
  private state: KeymapState;
  private closing = false;

  constructor(private readonly deps: KeymapServiceDeps) {
    this.state = emptyKeymapState(deps.keymapPath);
  }

  /** Synchronous cold-start read. A missing or malformed file
   *  yields empty bindings rather than throwing — a hand-edited file must not
   *  stop the app from booting. */
  loadSync(): KeymapState {
    try {
      const raw = readFileSync(this.deps.keymapPath, 'utf8');
      this.state = parseKeymapFile(raw, this.deps.keymapPath, this.deps.registry);
    } catch {
      this.state = emptyKeymapState(this.deps.keymapPath);
    }
    return this.snapshot();
  }

  async load(): Promise<KeymapState> {
    try {
      const raw = await readFile(this.deps.keymapPath, 'utf8');
      this.state = parseKeymapFile(raw, this.deps.keymapPath, this.deps.registry);
    } catch {
      this.state = emptyKeymapState(this.deps.keymapPath);
    }
    return this.snapshot();
  }

  snapshot(): KeymapState {
    return {
      supported: this.state.supported,
      keymapPath: this.state.keymapPath,
      bindings: this.state.bindings.map(binding => ({ ...binding })),
    };
  }

  registry(): KeybindingRegistry {
    return this.deps.registry;
  }

  /**
   * One-time migration of the two legacy KV rows (`global_shortcut`,
   * `quick_input_shortcut`) into keybindings.json, so the system hotkeys join
   * the single store. Runs only when the file has no row for the command yet,
   * so a user's existing choice is carried over instead of reset to default.
   * `readKV` returns the stored row value or undefined; `'off'`/empty maps to an
   * explicit `key: null` (disabled).
   */
  async migrateLegacyGlobalShortcuts(readKV: (key: string) => string | null | undefined): Promise<boolean> {
    const legacy: Array<{ commandId: string; kv: string }> = [
      { commandId: 'summonMainWindow', kv: 'global_shortcut' },
      { commandId: 'openQuickInput', kv: 'quick_input_shortcut' },
    ];
    let changed = false;
    let bindings = this.state.bindings;
    for (const { commandId, kv } of legacy) {
      if (bindings.some(row => row.command === commandId)) continue;
      const stored = readKV(kv);
      if (stored == null) continue; // never customized; leave it to the registry default
      const trimmed = stored.trim();
      bindings = [...bindings, { command: commandId, key: !trimmed || trimmed === 'off' ? null : trimmed }];
      changed = true;
    }
    if (!changed) return false;
    this.state = { supported: true, keymapPath: this.deps.keymapPath, bindings };
    await this.persist();
    return true;
  }

  private command(commandId: string): KeybindingCommand {
    const command = this.deps.registry.get(commandId);
    if (command == null) throw new Error('Unknown Klaus command');
    if (!isConfigurable(command)) throw new Error(`Klaus command is not configurable: ${commandId}`);
    return command;
  }

  /**
   * Apply one update. `set`/`replace`/`append` strip the same
   * accelerator from every OTHER command first, so a key is never stored against
   * two commands. (The UI additionally refuses a conflicting capture before it
   * ever calls this; the asymmetry is deliberate — a direct IPC
   * call reassigns silently, the UI refuses.)
   */
  async update(commandId: string, update: KeybindingUpdate): Promise<KeymapState> {
    if (this.closing) throw new Error('keymap-closed');
    const command = this.command(commandId);
    assertUpdateAllowedForScope(command, update);

    if ((update.type === 'set' || update.type === 'replace' || update.type === 'append') && isOsGlobal(command)) {
      const invalid = validateGlobalAccelerator(update.accelerator, this.deps.registry.platform);
      if (invalid != null) throw new Error(invalid);
    }

    const current = effectiveKeybindings(commandId, this.state, this.deps.registry);
    let bindings = this.state.bindings;

    switch (update.type) {
      case 'set':
        bindings = withCommandKeys(bindings, commandId, nextKeysForSet(current, update.accelerator));
        break;
      case 'replace':
        bindings = withCommandKeys(bindings, commandId, current.map(key => (key === update.previousAccelerator ? update.accelerator : key)));
        break;
      case 'append':
        bindings = withCommandKeys(bindings, commandId, [...current, update.accelerator]);
        break;
      case 'remove':
        bindings = withCommandKeys(bindings, commandId, current.filter(key => key !== update.accelerator));
        break;
      case 'clear':
        bindings = withCommandKeys(bindings, commandId, []);
        break;
      case 'reset':
        bindings = withoutCommand(bindings, commandId);
        break;
    }

    const incoming = update.type === 'set' || update.type === 'replace' || update.type === 'append' ? update.accelerator : null;
    if (incoming != null) {
      for (const other of this.deps.registry.list()) {
        if (other.id === commandId || !isConfigurable(other)) continue;
        const held = effectiveKeybindings(other.id, { ...this.state, bindings }, this.deps.registry);
        if (held.includes(incoming)) bindings = stripAcceleratorFromCommand(bindings, other.id, incoming, this.deps.registry);
      }
    }
    if (update.type === 'replace' && update.previousAccelerator !== incoming) {
      bindings = dropDanglingPrevious(bindings, commandId, update.previousAccelerator);
    }

    this.state = { supported: true, keymapPath: this.deps.keymapPath, bindings };
    await this.persist();
    await this.deps.onKeymapChanged();
    return this.snapshot();
  }

  /** Reset everything to defaults: write an empty array. */
  async resetAll(): Promise<KeymapState> {
    if (this.closing) throw new Error('keymap-closed');
    this.state = { supported: true, keymapPath: this.deps.keymapPath, bindings: [] };
    await this.persist();
    await this.deps.onKeymapChanged();
    return this.snapshot();
  }

  /**
   * The value `DesktopShortcuts` should register for one os-global slot, in the
   * exact `string | undefined` shape its `read` dep already returns: the
   * effective accelerator (registry default resolved, custom override applied),
   * or `'off'` when the command is explicitly disabled or has no binding at all.
   * Returning the resolved accelerator rather than null means keybindings.json —
   * not the `SHORTCUTS` constant — is the single source for the system hotkeys.
   */
  globalSlotValue(commandId: string): string {
    const command = this.deps.registry.get(commandId);
    if (command == null) return 'off';
    const keys = effectiveKeybindings(commandId, this.state, this.deps.registry);
    const first = keys[0];
    return first != null && first.length > 0 ? first : 'off';
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.deps.keymapPath), { recursive: true });
    await writeFile(this.deps.keymapPath, serializeKeymapFile(this.state.bindings), 'utf8');
  }

  close(): void {
    this.closing = true;
  }
}

/** A `replace` frees the previous accelerator; drop a now-dangling stored row so
 *  the old key does not survive as a phantom binding. */
function dropDanglingPrevious(bindings: StoredKeybinding[], commandId: string, previous: string): StoredKeybinding[] {
  const rows = bindings.filter(row => row.command === commandId);
  if (rows.length === 0) return bindings;
  const kept = rows.filter(row => row.key !== previous).map(row => row.key).filter((key): key is string => key != null);
  if (kept.length === rows.filter(row => row.key !== previous).length && !rows.some(row => row.key === previous)) return bindings;
  return withCommandKeys(withoutCommand(bindings, commandId), commandId, kept);
}

export { dedupeKeys };
