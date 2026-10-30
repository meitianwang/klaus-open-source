export const SHORTCUTS = {
  main: { setting: 'global_shortcut', default: 'CommandOrControl+Shift+K', does: 'summon or hide the main Klaus window from any app' },
  quickInput: { setting: 'quick_input_shortcut', default: 'CommandOrControl+Shift+Space', does: 'open the Quick Input card and send a new conversation' },
  desktopPet: { setting: 'desktop_pet_shortcut', default: process.platform === 'darwin' ? 'Alt+Space' : 'Super+Alt+P', does: 'show or hide the floating companion from any app' },
  voiceChat: { setting: 'voice_chat_shortcut', default: '', does: 'start or end live voice from any app' },
} as const;
export type ShortcutSlot = keyof typeof SHORTCUTS;
export interface ShortcutState {
  slot: ShortcutSlot; setting: string; default: string; does: string;
  stored: string | null; effective: string | null; active: string | null; error?: string;
}

/** A failed registration is reported separately from the user's configured accelerator. */
export class DesktopShortcuts {
  private readonly states = new Map<ShortcutSlot, ShortcutState>();
  private closing = false;
  /** Reference count for shortcut-capture suppression. While it is
   *  above zero no global hotkey is registered and `apply` only updates
   *  bookkeeping, so re-recording the very key that is currently registered
   *  reaches the capture field instead of being swallowed by the OS. */
  private suppressionDepth = 0;
  constructor(private readonly deps: {
    shortcuts: Pick<Electron.GlobalShortcut, 'register' | 'unregister'>;
    read(setting: string): string | undefined;
    toggleMain(): void | Promise<unknown>;
    toggleQuickInput(): void | Promise<unknown>;
    toggleDesktopPet?(): void | Promise<unknown>;
    toggleVoiceChat?(): void | Promise<unknown>;
    log(message: string): void;
  }) {}
  apply(slot: ShortcutSlot): ShortcutState {
    if (this.closing) throw new Error('shortcuts-closed');
    const definition = SHORTCUTS[slot], stored = this.deps.read(definition.setting) ?? null;
    const value = stored === null ? definition.default : stored.trim();
    const effective = !value || value === 'off' ? null : value;
    const previous = this.states.get(slot);
    if (previous?.active && previous.active !== effective) this.deps.shortcuts.unregister(previous.active);
    const state: ShortcutState = { slot, ...definition, stored, effective, active: previous?.active === effective && this.suppressionDepth === 0 ? effective : null };
    if (effective && !state.active) {
      if (this.suppressionDepth > 0) {
        // Recording the configured key for this slot right now: keep the state so
        // releasing the suppression registers whatever was saved, but do not
        // claim the key from the OS in the meantime.
        this.states.set(slot, state);
        return { ...state };
      }
      try {
        const occupied = [...this.states].some(([other, item]) => other !== slot && item.active?.toLowerCase() === effective.toLowerCase());
        const accepted = !occupied && this.deps.shortcuts.register(effective, () => {
          if (this.closing) return;
          if (slot === 'desktopPet') this.deps.log('desktopPet: triggered');
          try { void Promise.resolve(slot === 'main' ? this.deps.toggleMain() : slot === 'desktopPet' ? this.deps.toggleDesktopPet?.() : slot === 'voiceChat' ? this.deps.toggleVoiceChat?.() : this.deps.toggleQuickInput()).catch(error => this.deps.log(String(error))); }
          catch (error) { this.deps.log(String(error)); }
        });
        if (accepted) state.active = effective;
        else state.error = 'shortcut-unavailable';
      } catch { state.error = 'shortcut-invalid'; }
    }
    this.states.set(slot, state);
    if (state.error) this.deps.log(`${slot}: ${state.error}`);
    return { ...state };
  }
  start(): ShortcutState[] { return [this.apply('main'), this.apply('quickInput'), ...(this.deps.toggleDesktopPet ? [this.apply('desktopPet')] : []), ...(this.deps.toggleVoiceChat ? [this.apply('voiceChat')] : [])]; }
  state(slot: ShortcutSlot): ShortcutState | undefined { const state = this.states.get(slot); return state && { ...state }; }
  /**
   * Temporarily release every registered global hotkey so a capture field can
   * record one of them. Needed because the OS resolves a registered global
   * accelerator before the window ever sees
   * the keydown, so without this, re-recording ⌘⇧K would toggle the main window
   * instead of reaching the input.
   *
   * Reference-counted, returning a disposer that is idempotent — two overlapping
   * captures must not re-register between them, and a double cleanup must not
   * leave the count negative.
   */
  suppress(): () => void {
    if (this.closing) return () => {};
    this.suppressionDepth += 1;
    if (this.suppressionDepth === 1) {
      for (const state of this.states.values()) {
        if (state.active) this.deps.shortcuts.unregister(state.active);
        state.active = null;
      }
    }
    let released = false;
    return () => {
      if (released || this.closing) return;
      released = true;
      this.suppressionDepth = Math.max(0, this.suppressionDepth - 1);
      if (this.suppressionDepth === 0) this.start();
    };
  }
  /** Whether global hotkeys are currently released for a capture. */
  suppressed(): boolean { return this.suppressionDepth > 0; }
  close(): void {
    this.closing = true;
    for (const state of this.states.values()) { if (state.active) this.deps.shortcuts.unregister(state.active); state.active = null; }
  }
}
