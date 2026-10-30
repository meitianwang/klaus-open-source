// IPC for the keymap: read the live state, apply one binding update, reset all,
// and bracket a capture session so a global hotkey can be re-recorded.
//
// Five channels: `keymap:state` returns the live keymap, `keymap:set` applies
// one binding update, `keymap:reset` restores the defaults, and
// `keymap:capture-begin` / `keymap:capture-end` bracket a re-recording session
// so a global hotkey can be captured without firing. After a successful write
// the service's `onKeymapChanged` re-applies the os-global hotkeys, refreshes
// the native menu and pushes `keymap:changed`, which is the renderer's signal
// to re-read state.

import type { ChannelRegistry } from '../registry';
import { IpcHandlerError } from '../registry';
import type { Json } from '../contract';
import type { KeymapService } from '../../services/keymap-service';
import { object, requiredString, string } from '../../services/service-types';
import type { KeybindingUpdate, KeymapState } from '../../../contracts/keybindings';

export const KEYMAP_CHANNELS = [
  'keymap:state', 'keymap:set', 'keymap:reset', 'keymap:capture-begin', 'keymap:capture-end',
] as const;

export interface KeymapHandlerDeps {
  keymap: KeymapService;
  /**
   * Release every registered global hotkey until the returned disposer runs.
   * Required because the OS resolves a registered global
   * accelerator before the window ever sees the keydown: without it,
   * re-recording the key that is currently registered would fire the hotkey
   * (hiding the window, say) instead of reaching the capture field.
   */
  suppressGlobals(): () => void;
}

export interface KeymapCaptureGuard {
  /** Release the suppression held by one sender, or by all of them. */
  endCaptures(senderId?: number): void;
}

function parseUpdate(payload: { [key: string]: unknown }): KeybindingUpdate {
  const type = string(payload.type);
  const accelerator = string(payload.accelerator);
  switch (type) {
    case 'set':
      if (!accelerator) throw new IpcHandlerError('BAD_REQUEST', 'accelerator required');
      return { type: 'set', accelerator };
    case 'replace': {
      const previousAccelerator = requiredString(payload.previousAccelerator, 'previousAccelerator');
      if (!accelerator) throw new IpcHandlerError('BAD_REQUEST', 'accelerator required');
      return { type: 'replace', previousAccelerator, accelerator };
    }
    case 'append':
      if (!accelerator) throw new IpcHandlerError('BAD_REQUEST', 'accelerator required');
      return { type: 'append', accelerator };
    case 'remove':
      if (!accelerator) throw new IpcHandlerError('BAD_REQUEST', 'accelerator required');
      return { type: 'remove', accelerator };
    case 'clear':
      return { type: 'clear' };
    case 'reset':
      return { type: 'reset' };
    default:
      throw new IpcHandlerError('BAD_REQUEST', 'unknown keybinding update type');
  }
}

export function registerKeymapHandlers(registry: ChannelRegistry, deps: KeymapHandlerDeps): KeymapCaptureGuard {
  const { keymap } = deps;
  // The wire shape: a plain object with an index signature so it satisfies Json.
  // The renderer reads `bindings` (each `{command, key|null}`) and ignores the
  // rest.
  const wire = (state: KeymapState): Json => ({
    supported: state.supported,
    keymapPath: state.keymapPath,
    bindings: state.bindings.map(binding => ({ command: binding.command, key: binding.key })),
  });
  registry.register('keymap:state', () => wire(keymap.snapshot()), 'keymap');
  registry.register('keymap:set', async context => {
    const payload = object(context.args[0]);
    const commandId = requiredString(payload.commandId, 'commandId');
    return wire(await keymap.update(commandId, parseUpdate(payload)));
  }, 'keymap');
  registry.register('keymap:reset', async () => wire(await keymap.resetAll()), 'keymap');

  /**
   * One suppression per sender, so a second capture in the same window replaces
   * the first instead of stacking a count that can never reach zero.
   *
   * The HOST owns the lifetime guard, not the renderer: the runtime calls
   * `endCaptures` on window blur, destroy, renderer crash and main-frame
   * navigation — the four events a capture session can die on. A capture
   * that dies with its window therefore cannot leave the system hotkeys
   * permanently unregistered, which is the failure mode a renderer-owned
   * disposer has.
   */
  const captures = new Map<number, () => void>();
  registry.register('keymap:capture-begin', context => {
    captures.get(context.senderId)?.();
    captures.set(context.senderId, deps.suppressGlobals());
    return { ok: true };
  }, 'keymap');
  registry.register('keymap:capture-end', context => {
    const release = captures.get(context.senderId);
    if (release != null) {
      captures.delete(context.senderId);
      release();
    }
    return { ok: true };
  }, 'keymap');

  return {
    endCaptures(senderId?: number): void {
      if (senderId === undefined) {
        for (const release of captures.values()) release();
        captures.clear();
        return;
      }
      const release = captures.get(senderId);
      if (release != null) {
        captures.delete(senderId);
        release();
      }
    },
  };
}
