// KeyboardEvent -> accelerator capture, and the dispatcher's exclusion rules.
//
// These pin the two halves that must stay exact inverses of each other: capture
// (what gets WRITTEN to keybindings.json) and formatAccelerator (what the user
// READS). The modifier order here is Ctrl, Command, Alt, Shift — deliberately
// different from the ⌃⌥⇧⌘ display order, which the formatter re-sorts. Getting
// either half "cleaned up" to match the other would silently change every stored
// binding.
//
// Events are plain objects cast to KeyboardEvent, matching the rest of the
// frontend suite: `bun test frontend/src` has no DOM globals, so a test that
// constructs a real KeyboardEvent would fail on an environment detail rather
// than on behaviour. The exclusion helpers are duck-typed on `closest` for the
// same reason; in a browser the two forms are equivalent because only Elements
// have `closest`.

import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/keybindings-vectors.json'
import { formatAccelerator, parseAcceleratorSegment } from '../../../../contracts/keybindings'
import {
  EDITABLE_SURFACE_SELECTOR,
  SHORTCUT_CAPTURE_SELECTOR,
  TERMINAL_SURFACE_SELECTOR,
  acceleratorFromKeyboardEvent,
  acceleratorMainKey,
  isEditableSurfaceExempt,
  isWithinEditableSurface,
  isWithinShortcutCapture,
  pressedBareModifier,
  releasedBareModifier,
  targetWithinSelector,
} from './capture'

interface FakeKeyEventInit {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  location?: number
  repeat?: boolean
}

function keyEvent(init: FakeKeyEventInit): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    location: init.location ?? 0,
    repeat: init.repeat ?? false,
  } as unknown as KeyboardEvent
}

/**
 * An event whose target sits inside `ancestorSelectors` — the duck-typed stand-in
 * for `document.querySelector(sel)` plus `closest`. `closest` answers true for any
 * selector this fake target is inside, which is exactly the contract the real
 * Element method has for the selectors used here.
 */
function keyEventWithin(init: FakeKeyEventInit, ancestorSelectors: string[]): KeyboardEvent {
  return {
    ...keyEvent(init) as unknown as FakeKeyEventInit,
    target: {
      // A real Element's closest() matches if ANY comma-separated part matches;
      // the fake mirrors that so a test can declare membership in one selector
      // and still match against the editable-surface list.
      closest: (selector: string) =>
        selector.split(',').some(part => ancestorSelectors.includes(part.trim())) ? {} : null,
    },
  } as unknown as KeyboardEvent
}

/** The committed capture vectors, as fake KeyboardEvents. */
const captureVectors = vectors.capture as Array<{
  event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
  accelerator: string | null
}>

describe('capture normalization', () => {
  for (const entry of captureVectors) {
    test(`${JSON.stringify(entry.event.key)} + modifiers -> ${entry.accelerator}`, () => {
      expect(acceleratorFromKeyboardEvent(keyEvent(entry.event))).toBe(entry.accelerator)
    })
  }

  test('modifier order is Ctrl, Command, Alt, Shift — not the display order', () => {
    // The display formatter re-sorts to ⌃⌥⇧⌘; the stored string must not.
    const event = keyEvent({ key: 'c', ctrlKey: true, metaKey: true, altKey: true, shiftKey: true })
    expect(acceleratorFromKeyboardEvent(event)).toBe('Ctrl+Command+Alt+Shift+C')
    expect(formatAccelerator('Ctrl+Command+Alt+Shift+C', 'macOS')).toBe('⌃⌥⇧⌘C')
  })

  test('main keys use accelerator spelling, not DOM spelling', () => {
    expect(acceleratorMainKey(keyEvent({ key: 'ArrowUp' }))).toBe('Up')
    expect(acceleratorMainKey(keyEvent({ key: 'ArrowDown' }))).toBe('Down')
    expect(acceleratorMainKey(keyEvent({ key: 'ArrowLeft' }))).toBe('Left')
    expect(acceleratorMainKey(keyEvent({ key: 'ArrowRight' }))).toBe('Right')
    expect(acceleratorMainKey(keyEvent({ key: ' ' }))).toBe('Space')
    expect(acceleratorMainKey(keyEvent({ key: '+' }))).toBe('Plus')
    expect(acceleratorMainKey(keyEvent({ key: 'Escape' }))).toBe('Escape')
    expect(acceleratorMainKey(keyEvent({ key: 'f7' }))).toBe('F7')
    expect(acceleratorMainKey(keyEvent({ key: 'Fn' }))).toBe('Fn')
    // A single printable character is uppercased so ⌘t and ⌘T store identically.
    expect(acceleratorMainKey(keyEvent({ key: 't' }))).toBe('T')
  })

  test('a bare modifier press is not a shortcut', () => {
    for (const key of ['Meta', 'Control', 'Alt', 'AltGraph', 'Shift']) {
      expect(acceleratorFromKeyboardEvent(keyEvent({ key }))).toBeNull()
    }
  })

  test('an unprintable key falls back to event.code', () => {
    // A dead key or IME surprise reports something unusable in `key`; the physical
    // code still names it.
    expect(acceleratorMainKey(keyEvent({ key: 'Dead', code: 'KeyQ' }))).toBe('Q')
    expect(acceleratorMainKey(keyEvent({ key: 'Unidentified', code: 'Digit3' }))).toBe('3')
    expect(acceleratorMainKey(keyEvent({ key: 'Unidentified', code: 'Space' }))).toBe('Space')
    // A code that names nothing usable falls through to the key itself.
    expect(acceleratorMainKey(keyEvent({ key: 'Unidentified', code: 'Weird' }))).toBe('Unidentified')
  })

  test('Shift alone is storable, so Shift+Escape can be a binding', () => {
    // Shift stays in the stored string; dropping it would make ⇧Esc unrepresentable.
    expect(acceleratorFromKeyboardEvent(keyEvent({ key: 'Escape', shiftKey: true }))).toBe('Shift+Escape')
    expect(formatAccelerator('Shift+Escape', 'macOS')).toBe('⇧Esc')
  })
})

describe('bare-modifier capture', () => {
  test('left/right are distinguished by event.location', () => {
    expect(pressedBareModifier(keyEvent({ key: 'Meta', metaKey: true, location: 1 }))).toBe('LeftCommand')
    expect(pressedBareModifier(keyEvent({ key: 'Meta', metaKey: true, location: 2 }))).toBe('RightCommand')
    expect(releasedBareModifier(keyEvent({ key: 'Meta', metaKey: true, location: 1 }))).toBe('LeftCommand')
  })

  test('a clean press requires no other modifier held', () => {
    // ⌘⇧ must NOT read as a left-⌘ hotkey; the shift disqualifies the press.
    expect(pressedBareModifier(keyEvent({ key: 'Meta', metaKey: true, shiftKey: true, location: 1 }))).toBeNull()
    expect(pressedBareModifier(keyEvent({ key: 'Alt', altKey: true, ctrlKey: true, location: 1 }))).toBeNull()
    // Release is unconditional: the key went up, whatever else is down.
    expect(releasedBareModifier(keyEvent({ key: 'Meta', metaKey: true, shiftKey: true, location: 1 }))).toBe('LeftCommand')
  })

  test('left Control only, and Fn from any location', () => {
    expect(pressedBareModifier(keyEvent({ key: 'Control', ctrlKey: true, location: 1 }))).toBe('LeftControl')
    expect(pressedBareModifier(keyEvent({ key: 'Control', ctrlKey: true, location: 2 }))).toBeNull()
    expect(pressedBareModifier(keyEvent({ key: 'Fn', location: 0 }))).toBe('Fn')
  })
})

describe('capture round-trips through the formatter', () => {
  const roundTrips: Array<[FakeKeyEventInit, 'macOS' | 'windows' | 'linux', string]> = [
    [{ key: 'n', metaKey: true }, 'macOS', '⌘N'],
    [{ key: 'n', metaKey: true, shiftKey: true }, 'macOS', '⇧⌘N'],
    [{ key: '/', metaKey: true }, 'macOS', '⌘/'],
    [{ key: '/', metaKey: true, shiftKey: true }, 'macOS', '⌘?'],
    [{ key: '`', ctrlKey: true }, 'macOS', '⌃`'],
    [{ key: 'Escape', shiftKey: true }, 'macOS', '⇧Esc'],
    [{ key: 'Enter', metaKey: true }, 'macOS', '⌘⏎'],
    [{ key: 'n', ctrlKey: true }, 'windows', 'Ctrl+N'],
    [{ key: 'n', ctrlKey: true, altKey: true }, 'windows', 'Ctrl+Alt+N'],
    [{ key: ' ', ctrlKey: true, shiftKey: true }, 'windows', 'Ctrl+Shift+Space'],
    [{ key: 'k', ctrlKey: true }, 'linux', 'Ctrl+K'],
  ]
  for (const [init, platform, label] of roundTrips) {
    test(`pressing ${init.key} on ${platform} displays ${label}`, () => {
      const captured = acceleratorFromKeyboardEvent(keyEvent(init))
      expect(captured).not.toBeNull()
      expect(formatAccelerator(captured!, platform)).toBe(label)
      // And the captured string parses back into exactly one segment with the
      // modifier bits the event carried, so an edited binding is usable
      // immediately without a reload.
      const segments = captured!.split(' ')
      expect(segments).toHaveLength(1)
      const parsed = parseAcceleratorSegment(segments[0]!, platform === 'macOS')
      expect(parsed.requireMeta).toBe(init.metaKey ?? false)
      expect(parsed.requireCtrl).toBe((init.ctrlKey ?? false) || (platform !== 'macOS' && captured!.includes('CmdOrCtrl')))
      expect(parsed.requireAlt).toBe(init.altKey ?? false)
      expect(parsed.requireShift).toBe(init.shiftKey ?? false)
    })
  }
})

describe('dispatcher exclusion selectors', () => {
  test('the selector constants name the composer and terminal markers', () => {
    expect(SHORTCUT_CAPTURE_SELECTOR).toBe('[data-klaus-shortcut-capture]')
    expect(EDITABLE_SURFACE_SELECTOR).toBe("input,textarea,select,[contenteditable='true'],[data-klaus-composer],[data-klaus-terminal]")
    expect(TERMINAL_SURFACE_SELECTOR).toBe('[data-klaus-terminal]')
  })

  test('the capture widget itself is always excluded', () => {
    const inside = keyEventWithin({ key: 'k', metaKey: true }, [SHORTCUT_CAPTURE_SELECTOR])
    expect(isWithinShortcutCapture(inside)).toBe(true)
    // Without the attribute, the same key inside a plain input is not capture.
    expect(isWithinShortcutCapture(keyEventWithin({ key: 'k', metaKey: true }, ['input']))).toBe(false)
  })

  test('editable surfaces are recognised, including the composer and terminal markers', () => {
    for (const selector of ['input', 'textarea', 'select', "[contenteditable='true']", '[data-klaus-composer]', '[data-klaus-terminal]']) {
      expect(isWithinEditableSurface(keyEventWithin({ key: 'k' }, [selector]))).toBe(true)
    }
    expect(isWithinEditableSurface(keyEventWithin({ key: 'k' }, ['div']))).toBe(false)
  })

  test('a non-Element target is never inside anything', () => {
    expect(targetWithinSelector(null, 'input')).toBe(false)
    expect(targetWithinSelector(undefined, 'input')).toBe(false)
    expect(targetWithinSelector('text', 'input')).toBe(false)
    expect(targetWithinSelector({}, 'input')).toBe(false)
  })

  test('a chord with Ctrl/Meta/Alt is exempt from editable-surface protection', () => {
    // A binding carrying a real modifier cannot be text input, so it
    // fires even inside a field — that is what makes ⌘K work in the composer.
    const event = keyEventWithin({ key: 'k', metaKey: true }, ['input'])
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('CmdOrCtrl+K', true), event)).toBe(true)
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('Ctrl+K', false), event)).toBe(true)
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('Alt+K', true), event)).toBe(true)
    // A bare key or Shift-only is NOT exempt, so typing stays typing.
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('K', true), event)).toBe(false)
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('Shift+K', true), event)).toBe(false)
  })

  test('F1-F24 are exempt except inside a terminal', () => {
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('F5', true), keyEventWithin({ key: 'F5' }, ['input']))).toBe(true)
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('F24', true), keyEventWithin({ key: 'F24' }, ['input']))).toBe(true)
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('F1', true), keyEventWithin({ key: 'F1' }, []))).toBe(true)
    // Inside a terminal the function keys belong to the running program.
    const terminalEvent = keyEventWithin({ key: 'F5' }, [TERMINAL_SURFACE_SELECTOR])
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('F5', true), terminalEvent)).toBe(false)
    // A modifier still wins inside the terminal.
    expect(isEditableSurfaceExempt(parseAcceleratorSegment('CmdOrCtrl+F5', true), terminalEvent)).toBe(true)
  })
})
