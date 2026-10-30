// KeyboardEvent <-> accelerator, the capture half of the keymap contract.
//
// This is where the string that lands in keybindings.json is produced, so it
// must stay the exact inverse of `formatAccelerator` in
// contracts/keybindings.ts: the modifier ORDER here is `Ctrl, Command, Alt,
// Shift` while the display order is `⌃⌥⇧⌘` — the formatter re-sorts, the
// capture does not.
//
// DOM-facing, so it lives outside contracts/ (that module compiles under the
// host tsconfig, which has no DOM lib).

/** `KeyboardEvent.location` constants (DOM_KEY_LOCATION_LEFT / _RIGHT). */
const KEY_LOCATION_LEFT = 1;
const KEY_LOCATION_RIGHT = 2;

/** Keys that are modifiers only: pressing one of these is not a shortcut. */
const MODIFIER_ONLY_KEYS = new Set(['Meta', 'Control', 'Alt', 'AltGraph', 'Shift']);

/** DOM key name -> accelerator token. Note arrows lose the
 *  `Arrow` prefix: a binding is written `Up`, not `ArrowUp`. */
const DOM_KEY_TO_ACCELERATOR = new Map<string, string>([
  ['Escape', 'Escape'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
]);

/** Recover the physical key from `event.code` when `event.key` is
 *  something unprintable (a dead key, an IME composition, a layout surprise). */
function acceleratorFromCode(code: string | undefined): string | null {
  if (code == null) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code === 'Space' ? 'Space' : null;
}

/** The main-key token for an event, or null when the event is a
 *  bare modifier press and therefore not a shortcut at all. */
export function acceleratorMainKey(event: KeyboardEvent): string | null {
  const key = event.key;
  if (MODIFIER_ONLY_KEYS.has(key)) return null;
  if (key === ' ') return 'Space';
  if (key === '+') return 'Plus';
  const mapped = DOM_KEY_TO_ACCELERATOR.get(key);
  if (mapped != null) return mapped;
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
  if (key.toLowerCase() === 'fn') return 'Fn';
  if (key.length === 1) return key.toUpperCase();
  return acceleratorFromCode(event.code) ?? key;
}

/** Build the accelerator string that gets stored. Returns null when
 *  the event carries no usable main key. */
export function acceleratorFromKeyboardEvent(event: KeyboardEvent): string | null {
  const main = acceleratorMainKey(event);
  if (main == null) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Command');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(main);
  return parts.join('+');
}

/** Bare-modifier capture. A hotkey made only of modifiers is recognized on
 *  release and on a clean press; the clean-press form requires that no other
 *  modifier is held, otherwise ⌘⇧ would also read as a left-⌘ hotkey. */
export function bareModifierFromKeyboardEvent(event: KeyboardEvent, phase: 'pressed' | 'released'): string | null {
  if (event.key.toLowerCase() === 'fn') return 'Fn';
  const side = event.location === KEY_LOCATION_LEFT ? 'Left' : event.location === KEY_LOCATION_RIGHT ? 'Right' : null;
  if (side == null) return null;
  switch (event.key) {
    case 'Alt':
      return phase === 'released' || (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) ? `${side}Option` : null;
    case 'Meta':
      return phase === 'released' || (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) ? `${side}Command` : null;
    case 'Control':
      return side === 'Left' && (phase === 'released' || (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey)) ? 'LeftControl' : null;
    default:
      return null;
  }
}

export const pressedBareModifier = (event: KeyboardEvent): string | null => bareModifierFromKeyboardEvent(event, 'pressed');
export const releasedBareModifier = (event: KeyboardEvent): string | null => bareModifierFromKeyboardEvent(event, 'released');

// ---------------------------------------------------------------------------
// dispatcher exclusion selectors
// ---------------------------------------------------------------------------

/** The capture widgets themselves. A keydown inside one is never a command. */
export const SHORTCUT_CAPTURE_SELECTOR = '[data-klaus-shortcut-capture]';

/** Editable surfaces: typing here must not trigger app commands. */
export const EDITABLE_SURFACE_SELECTOR = "input,textarea,select,[contenteditable='true'],[data-klaus-composer],[data-klaus-terminal]";

/** The terminal surface, where F-keys belong to the program inside it. */
export const TERMINAL_SURFACE_SELECTOR = '[data-klaus-terminal]';

/**
 * Does `target` sit inside `selector`?
 *
 * Duck-typed on `closest` rather than `instanceof Element`: in the DOM the two
 * are equivalent (only Elements have `closest`), but the duck-typed form also
 * runs under `bun test`, which has no DOM globals, so this rule stays testable
 * instead of only verifiable in a browser. A non-Element target (text node,
 * document, null) has no `closest` and therefore is never "inside" anything.
 */
export function targetWithinSelector(target: unknown, selector: string): boolean {
  if (target == null || typeof target !== 'object') return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== 'function') return false;
  return (closest as (sel: string) => unknown).call(target, selector) != null;
}

function withinSelector(event: KeyboardEvent, selector: string): boolean {
  return targetWithinSelector(event.target, selector);
}

export const isWithinShortcutCapture = (event: KeyboardEvent): boolean => withinSelector(event, SHORTCUT_CAPTURE_SELECTOR);
export const isWithinEditableSurface = (event: KeyboardEvent): boolean => withinSelector(event, EDITABLE_SURFACE_SELECTOR);

/** The two exemptions from editable-surface protection — a chord
 *  carrying Ctrl/Meta/Alt cannot be text input, and F1–F24 are app-level except
 *  inside a terminal, where they belong to the running program. */
export function isEditableSurfaceExempt(segment: { key: string; requireCtrl: boolean; requireMeta: boolean; requireAlt: boolean }, event: KeyboardEvent): boolean {
  return segment.requireCtrl || segment.requireMeta || segment.requireAlt
    || (/^f([1-9]|1\d|2[0-4])$/.test(segment.key) && !targetWithinSelector(event.target, TERMINAL_SURFACE_SELECTOR));
}
