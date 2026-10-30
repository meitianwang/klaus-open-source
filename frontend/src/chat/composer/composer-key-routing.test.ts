import { expect, test } from 'bun:test'
import { composerKeyWasHandled, deferComposerApplicationKey } from './composer-key-routing'

function key(name: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: name, defaultPrevented: false, isComposing: false, keyCode: 0, ...options } as KeyboardEvent
}

test('native default suppression leaves declined Enter and Escape available to their application route', () => {
  for (const name of ['Enter', 'Escape']) {
    const event = key(name)
    deferComposerApplicationKey(event)
    Object.assign(event, { defaultPrevented: true })
    expect(composerKeyWasHandled(event)).toBe(false)
    expect(composerKeyWasHandled(key(name, { defaultPrevented: true }))).toBe(true)
  }
})

test('owned keys and input-method keys cannot be handed to an application route', () => {
  for (const options of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }]) {
    const event = key('Enter', options)
    deferComposerApplicationKey(event)
    Object.assign(event, { defaultPrevented: true })
    expect(composerKeyWasHandled(event)).toBe(true)
  }
})

test('ordinary prevented keys retain their editing owner and unprevented keys remain available', () => {
  const event = key('ArrowUp')
  deferComposerApplicationKey(event)
  expect(composerKeyWasHandled(event)).toBe(false)
  Object.assign(event, { defaultPrevented: true })
  expect(composerKeyWasHandled(event)).toBe(true)
})
