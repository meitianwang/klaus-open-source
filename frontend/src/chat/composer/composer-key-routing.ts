const applicationKeys = new WeakSet<KeyboardEvent>()

/** Called only after every document keymap has declined the native event. */
export function deferComposerApplicationKey(event: KeyboardEvent): void {
  if (!event.defaultPrevented && !event.isComposing && event.keyCode !== 229
    && (event.key === 'Enter' || event.key === 'Escape')) applicationKeys.add(event)
}

/** Native editing may suppress the browser default without owning application routing. */
export function composerKeyWasHandled(event: KeyboardEvent): boolean {
  return event.defaultPrevented && !applicationKeys.has(event)
}
