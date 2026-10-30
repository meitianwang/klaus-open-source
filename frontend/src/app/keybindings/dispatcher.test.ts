// The dispatcher: priority tiers, chord state machine, editable-surface gating
// and the onlyWithin/yieldToSelectedText scope rules.
//
// Ported behaviour, pinned against Codex `y6r` (dispatch order) and `wka` (the
// listener with its three-ref chord state). Listeners are attached to a fake
// EventTarget rather than `window`, which the module accepts via its `target`
// option — that is what makes the state machine testable without a DOM.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  dispatchCommand,
  hasFallbackCommandHandler,
  registerCommandHandler,
  registerFallbackCommandHandler,
  registerKeybindingListener,
  registeredHandlerCount,
  runCommand,
  shouldDispatchWithinScope,
  unregisterFallbackCommandHandler,
  type KeybindingListenerHandle,
} from './dispatcher'

interface FakeKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  defaultPrevented: boolean
  isComposing?: boolean
  target?: unknown
  preventDefault(): void
}

/**
 * The dispatcher reads only the fields above, so a plain object is a faithful
 * stand-in for a real KeyboardEvent. The cast happens once here instead of at
 * every call site, because `bun test frontend/src` has no DOM globals and a real
 * KeyboardEvent cannot be constructed in this suite.
 */
function fakeKey(init: Partial<FakeKeyEvent> & { key: string }): KeyboardEvent {
  const event: FakeKeyEvent = {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    repeat: init.repeat ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
    target: init.target,
    preventDefault() { this.defaultPrevented = true },
  }
  return event as unknown as KeyboardEvent
}

/** An EventTarget that records listeners and replays them with a fake event. */
function fakeTarget() {
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const target: EventTarget = {
    addEventListener: (type: string, listener: unknown) => {
      const list = listeners.get(type) ?? []
      list.push(listener as (event: unknown) => void)
      listeners.set(type, list)
    },
    removeEventListener: (type: string, listener: unknown) => {
      const list = listeners.get(type)
      if (!list) return
      const index = list.indexOf(listener as (event: unknown) => void)
      if (index !== -1) list.splice(index, 1)
    },
    dispatchEvent: () => true,
  } as unknown as EventTarget
  const fire = (type: string, event: unknown) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
  }
  return { target, fire, count: (type: string) => (listeners.get(type) ?? []).length }
}

const handles: KeybindingListenerHandle[] = []
const unregisters: Array<() => void> = []
const fallbacks: string[] = []

function track(handle: KeybindingListenerHandle): KeybindingListenerHandle {
  handles.push(handle)
  return handle
}
function trackUnregister(fn: () => void): () => void {
  unregisters.push(fn)
  return fn
}
function trackFallback(commandId: string, handler: (source: never) => boolean | void): void {
  fallbacks.push(commandId)
  registerFallbackCommandHandler(commandId, handler as never)
}

afterEach(() => {
  while (handles.length > 0) handles.pop()?.dispose()
  while (unregisters.length > 0) unregisters.pop()?.()
  while (fallbacks.length > 0) unregisterFallbackCommandHandler(fallbacks.pop()!)
})

describe('dispatch priority (Codex y6r)', () => {
  test('the normal tier wins over fallback, and the last normal registration wins', () => {
    const order: string[] = []
    trackUnregister(registerCommandHandler('probePriority', () => { order.push('normal-first'); return true }))
    trackUnregister(registerCommandHandler('probePriority', () => { order.push('normal-second'); return true }, { priority: 'normal' }))
    trackUnregister(registerCommandHandler('probePriority', () => { order.push('fallback'); return true }, { priority: 'fallback' }))
    expect(dispatchCommand('probePriority', 'command_menu')).toBe(true)
    // Later registrations are tried first within a tier, and a consumed dispatch
    // never reaches the lower tier.
    expect(order).toEqual(['normal-second'])
  })

  test('a handler returning false is not consumed, so dispatch continues downward', () => {
    const order: string[] = []
    trackUnregister(registerCommandHandler('probeFallthrough', () => { order.push('declines'); return false }))
    trackUnregister(registerCommandHandler('probeFallthrough', () => { order.push('accepts'); return true }, { priority: 'fallback' }))
    expect(dispatchCommand('probeFallthrough', 'command_menu')).toBe(true)
    expect(order).toEqual(['declines', 'accepts'])
  })

  test('every registration declining falls through to the fallback map', () => {
    trackUnregister(registerCommandHandler('probeBase', () => false))
    let ran = false
    trackFallback('probeBase', () => { ran = true; return true })
    expect(dispatchCommand('probeBase', 'native_menu')).toBe(true)
    expect(ran).toBe(true)
  })

  test('an inactive registration is skipped entirely', () => {
    const order: string[] = []
    trackUnregister(registerCommandHandler('probeActive', () => { order.push('guarded-off'); return true }, { isActive: () => false }))
    trackUnregister(registerCommandHandler('probeActive', () => { order.push('always'); return true }))
    dispatchCommand('probeActive', 'keyboard_shortcut')
    expect(order).toEqual(['always'])
  })

  test('the dispatch source reaches both isActive and the handler', () => {
    const seen: string[] = []
    trackUnregister(registerCommandHandler('probeSource', source => { seen.push(`handler:${source}`); return true }, {
      isActive: source => { seen.push(`guard:${source}`); return true },
    }))
    dispatchCommand('probeSource', 'sidebar_help_menu')
    expect(seen).toEqual(['guard:sidebar_help_menu', 'handler:sidebar_help_menu'])
  })

  test('an unregistered command reports not-consumed rather than throwing', () => {
    expect(dispatchCommand('nobodyHandlesThis', 'command_menu')).toBe(false)
    expect(runCommand('nobodyHandlesThis')).toBe(false)
  })

  test('unregistering the last handler removes the command from the table', () => {
    const unregister = registerCommandHandler('probeCount', () => true)
    expect(registeredHandlerCount('probeCount')).toBe(1)
    unregister()
    expect(registeredHandlerCount('probeCount')).toBe(0)
    expect(hasFallbackCommandHandler('probeCount')).toBe(false)
    // A second unregister is a no-op, so a double cleanup cannot corrupt the table.
    unregister()
    expect(registeredHandlerCount('probeCount')).toBe(0)
  })

  test('only the exact registration is removed when two share a command', () => {
    const first = registerCommandHandler('probePair', () => true)
    registerCommandHandler('probePair', () => true)
    expect(registeredHandlerCount('probePair')).toBe(2)
    first()
    expect(registeredHandlerCount('probePair')).toBe(1)
  })
})

describe('single-segment listener (Codex wka)', () => {
  test('fires on an exact match and consumes the event', () => {
    const { target, fire, count } = fakeTarget()
    let fired = 0
    track(registerKeybindingListener({
      accelerator: 'CmdOrCtrl+K', platform: 'macOS', target,
      onKeyDown: () => { fired += 1 },
    }))
    expect(count('keydown')).toBe(1)
    const event = fakeKey({ key: 'k', metaKey: true })
    fire('keydown', event)
    expect(fired).toBe(1)
  })

  test('an extra or missing modifier does not match', () => {
    const { target, fire } = fakeTarget()
    let fired = 0
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+K', platform: 'macOS', target, onKeyDown: () => { fired += 1 } }))
    fire('keydown', fakeKey({ key: 'k', metaKey: true, shiftKey: true }))
    fire('keydown', fakeKey({ key: 'k', metaKey: true, altKey: true }))
    fire('keydown', fakeKey({ key: 'k' }))
    expect(fired).toBe(0)
  })

  test('CmdOrCtrl resolves to meta on macOS and ctrl elsewhere', () => {
    const mac = fakeTarget()
    const win = fakeTarget()
    let macFired = 0
    let winFired = 0
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+K', platform: 'macOS', target: mac.target, onKeyDown: () => { macFired += 1 } }))
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+K', platform: 'windows', target: win.target, onKeyDown: () => { winFired += 1 } }))
    mac.fire('keydown', fakeKey({ key: 'k', metaKey: true }))
    win.fire('keydown', fakeKey({ key: 'k', ctrlKey: true }))
    expect(macFired).toBe(1)
    expect(winFired).toBe(1)
    // And the wrong modifier for the platform does not fire.
    mac.fire('keydown', fakeKey({ key: 'k', ctrlKey: true }))
    win.fire('keydown', fakeKey({ key: 'k', metaKey: true }))
    expect(macFired).toBe(1)
    expect(winFired).toBe(1)
  })

  test('repeat is ignored unless allowRepeat is set', () => {
    const { target, fire } = fakeTarget()
    let strict = 0
    let permissive = 0
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+J', platform: 'macOS', target, onKeyDown: () => { strict += 1 } }))
    const other = fakeTarget()
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+J', platform: 'macOS', target: other.target, allowRepeat: true, onKeyDown: () => { permissive += 1 } }))
    fire('keydown', fakeKey({ key: 'j', metaKey: true, repeat: true }))
    other.fire('keydown', fakeKey({ key: 'j', metaKey: true, repeat: true }))
    expect(strict).toBe(0)
    expect(permissive).toBe(1)
  })

  test('dispose removes the listener so a stale binding cannot fire', () => {
    const { target, fire, count } = fakeTarget()
    let fired = 0
    const handle = registerKeybindingListener({ accelerator: 'CmdOrCtrl+K', platform: 'macOS', target, onKeyDown: () => { fired += 1 } })
    handle.dispose()
    expect(count('keydown')).toBe(0)
    fire('keydown', fakeKey({ key: 'k', metaKey: true }))
    expect(fired).toBe(0)
  })

  test('a keydown inside the capture widget never fires a command', () => {
    const { target, fire } = fakeTarget()
    let fired = 0
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+K', platform: 'macOS', target, onKeyDown: () => { fired += 1 } }))
    fire('keydown', fakeKey({ key: 'k', metaKey: true, target: { closest: (sel: string) => (sel === '[data-klaus-shortcut-capture]' ? {} : null) } }))
    expect(fired).toBe(0)
  })

  test('a bare key inside an editable surface does not fire, but a modified chord does', () => {
    const editable = { closest: (sel: string) => (sel.includes('input') ? {} : null) }
    const bare = fakeTarget()
    let bareFired = 0
    track(registerKeybindingListener({ accelerator: 'Escape', platform: 'macOS', target: bare.target, onKeyDown: () => { bareFired += 1 } }))
    bare.fire('keydown', fakeKey({ key: 'Escape', target: editable }))
    expect(bareFired).toBe(0)

    const modified = fakeTarget()
    let modifiedFired = 0
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+K', platform: 'macOS', target: modified.target, onKeyDown: () => { modifiedFired += 1 } }))
    modified.fire('keydown', fakeKey({ key: 'k', metaKey: true, target: editable }))
    expect(modifiedFired).toBe(1)
  })

  test('allowWithinEditable lets a binding fire inside a field', () => {
    const editable = { closest: (sel: string) => (sel.includes('input') ? {} : null) }
    const { target, fire } = fakeTarget()
    let fired = 0
    track(registerKeybindingListener({
      accelerator: 'Shift+Escape', platform: 'macOS', target, allowWithinEditable: true,
      onKeyDown: () => { fired += 1 },
    }))
    fire('keydown', fakeKey({ key: 'Escape', shiftKey: true, target: editable }))
    expect(fired).toBe(1)
  })
})

describe('chord state machine (Codex wka)', () => {
  test('both segments are required, and the first one prevents default', async () => {
    const { target, fire } = fakeTarget()
    let fired = 0
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+K W', platform: 'macOS', target, onKeyDown: () => { fired += 1 } }))
    const first = fakeKey({ key: 'k', metaKey: true })
    fire('keydown', first)
    expect(fired).toBe(0)
    // The prefix is swallowed so the browser never acts on ⌘K alone.
    expect(first.defaultPrevented).toBe(true)
    fire('keydown', fakeKey({ key: 'w' }))
    expect(fired).toBe(1)
  })

  test('a caller that honours defaultPrevented still receives the final segment', () => {
    // This is the regression guard for the chord bug: the runtime's onKeyDown
    // starts with `if (event.defaultPrevented) return`, because the CALLER owns
    // the decision to consume the key. The dispatcher must therefore dispatch the
    // final segment BEFORE preventing default. A test whose fake handler ignores
    // defaultPrevented cannot see the difference — this one mirrors the real
    // contract, so preventDefault-before-dispatch fails here.
    const { target, fire } = fakeTarget()
    let fired = 0
    track(registerKeybindingListener({
      accelerator: 'CmdOrCtrl+K W', platform: 'macOS', target,
      onKeyDown: event => { if (event.defaultPrevented) return; fired += 1 },
    }))
    fire('keydown', fakeKey({ key: 'k', metaKey: true }))
    expect(fired).toBe(0)
    const second = fakeKey({ key: 'w' })
    fire('keydown', second)
    expect(fired).toBe(1)
    // And the caller — not the listener — is what marks the key consumed.
    expect(second.defaultPrevented).toBe(false)
  })

  test('a wrong second segment resets progress instead of firing', () => {
    const { target, fire } = fakeTarget()
    let fired = 0
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+K W', platform: 'macOS', target, onKeyDown: () => { fired += 1 } }))
    fire('keydown', fakeKey({ key: 'k', metaKey: true }))
    fire('keydown', fakeKey({ key: 'u' }))
    expect(fired).toBe(0)
    // Progress was reset, so a bare W no longer completes anything.
    fire('keydown', fakeKey({ key: 'w' }))
    expect(fired).toBe(0)
  })

  test('the chord restarts when the first segment is pressed twice', () => {
    const { target, fire } = fakeTarget()
    let fired = 0
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+K W', platform: 'macOS', target, onKeyDown: () => { fired += 1 } }))
    fire('keydown', fakeKey({ key: 'k', metaKey: true }))
    fire('keydown', fakeKey({ key: 'x' }))
    // A key that happens to be the first segment starts a fresh chord rather
    // than being ignored, so ⌘K after a mistake still works.
    fire('keydown', fakeKey({ key: 'k', metaKey: true }))
    fire('keydown', fakeKey({ key: 'w' }))
    expect(fired).toBe(1)
  })

  test('the between-segment timeout expires an incomplete chord', async () => {
    const { target, fire } = fakeTarget()
    let fired = 0
    track(registerKeybindingListener({ accelerator: 'CmdOrCtrl+K W', platform: 'macOS', target, onKeyDown: () => { fired += 1 } }))
    fire('keydown', fakeKey({ key: 'k', metaKey: true }))
    await new Promise(resolve => setTimeout(resolve, 1150))
    fire('keydown', fakeKey({ key: 'w' }))
    expect(fired).toBe(0)
  })

  test('disposing mid-chord clears the pending timeout', async () => {
    const { target, fire } = fakeTarget()
    let fired = 0
    const handle = registerKeybindingListener({ accelerator: 'CmdOrCtrl+K W', platform: 'macOS', target, onKeyDown: () => { fired += 1 } })
    fire('keydown', fakeKey({ key: 'k', metaKey: true }))
    handle.dispose()
    await new Promise(resolve => setTimeout(resolve, 1150))
    expect(fired).toBe(0)
  })
})

describe('scope rules (Codex X6c onlyWithin / yieldToSelectedText)', () => {
  test('an already-prevented event never dispatches', () => {
    expect(shouldDispatchWithinScope(fakeKey({ key: 'k', defaultPrevented: true }), undefined, false)).toBe(false)
  })

  test('without onlyWithin every target dispatches', () => {
    expect(shouldDispatchWithinScope(fakeKey({ key: 'k' }), undefined, false)).toBe(true)
    expect(shouldDispatchWithinScope(fakeKey({ key: 'k', target: { closest: () => null } }), undefined, false)).toBe(true)
  })

  test('onlyWithin restricts dispatch to that subtree', () => {
    const inside = { closest: (sel: string) => (sel === '[data-klaus-composer]' ? {} : null) }
    const outside = { closest: () => null }
    expect(shouldDispatchWithinScope(fakeKey({ key: 'k', target: inside }), '[data-klaus-composer]', false)).toBe(true)
    expect(shouldDispatchWithinScope(fakeKey({ key: 'k', target: outside }), '[data-klaus-composer]', false)).toBe(false)
    // No target at all cannot be inside anything.
    expect(shouldDispatchWithinScope(fakeKey({ key: 'k' }), '[data-klaus-composer]', false)).toBe(false)
  })

  test('a real text selection inside the scope wins so a binding cannot swallow a copy', () => {
    const scope = { contains: (node: unknown) => node === 'anchor' || node === 'focus' }
    const target = { closest: () => scope, ownerDocument: { getSelection: () => ({ anchorNode: 'anchor', focusNode: 'focus', toString: () => 'selected text' }) } }
    expect(shouldDispatchWithinScope(fakeKey({ key: 'b', metaKey: true, target }), '[data-klaus-composer]', true)).toBe(false)
    // An empty selection is not a copy gesture, so the binding still fires.
    const emptyTarget = { closest: () => scope, ownerDocument: { getSelection: () => ({ anchorNode: 'anchor', focusNode: 'focus', toString: () => '' }) } }
    expect(shouldDispatchWithinScope(fakeKey({ key: 'b', metaKey: true, target: emptyTarget }), '[data-klaus-composer]', true)).toBe(true)
    // A selection OUTSIDE the scope is irrelevant to it.
    const outsideTarget = { closest: () => scope, ownerDocument: { getSelection: () => ({ anchorNode: 'elsewhere', focusNode: 'elsewhere', toString: () => 'x' }) } }
    expect(shouldDispatchWithinScope(fakeKey({ key: 'b', metaKey: true, target: outsideTarget }), '[data-klaus-composer]', true)).toBe(true)
  })

  test('yieldToSelectedText without a scope still dispatches', () => {
    expect(shouldDispatchWithinScope(fakeKey({ key: 'b', metaKey: true }), undefined, true)).toBe(true)
  })

  test('onlyWithin and yieldToSelectedText together gate the same event', () => {
    const scope = { contains: () => true }
    const target = { closest: () => scope, ownerDocument: { getSelection: () => ({ anchorNode: 'a', focusNode: 'f', toString: () => 'text' }) } }
    // Inside the scope with a selection: yields. Same target without the yield
    // flag: dispatches. That difference is the whole point of the flag.
    expect(shouldDispatchWithinScope(fakeKey({ key: 'b', metaKey: true, target }), '[data-klaus-composer]', true)).toBe(false)
    expect(shouldDispatchWithinScope(fakeKey({ key: 'b', metaKey: true, target }), '[data-klaus-composer]', false)).toBe(true)
  })
})
