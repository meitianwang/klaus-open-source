import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { retainSessionView } from './session-view-interest'

let previousWindow: PropertyDescriptor | undefined
beforeEach(() => { previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window') })
afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
const install = (session: unknown) => Object.defineProperty(globalThis, 'window', { configurable: true, value: { klaus: { session } } })

describe('mounted session view interest', () => {
  test('missing bridges and provisional ids are harmless in non-host surfaces', () => {
    install(undefined)
    expect(() => retainSessionView('chat')()).not.toThrow()
    let calls = 0
    install({ retainView: () => { calls++; return Promise.resolve() }, releaseView: () => Promise.resolve() })
    for (const id of ['pending:chat', '__private', '', 'bad/path']) retainSessionView(id)()
    expect(calls).toBe(0)
  })
  test('teardown waits for a late acknowledgement and releases only its exact token once', async () => {
    const retained: Array<[string, string]> = [], released: Array<[string, string]> = []
    let acknowledge!: () => void
    install({ retainView: (id: string, token: string) => { retained.push([id, token]); return new Promise<void>(resolve => { acknowledge = resolve }) },
      releaseView: (id: string, token: string) => { released.push([id, token]); return Promise.resolve() } })
    const cleanup = retainSessionView('chat'); cleanup(); cleanup()
    await settle(); expect(released).toEqual([])
    acknowledge(); await settle(); expect(released).toEqual(retained)
  })
  test('independent surfaces get different tokens and an unknown outcome still releases ownership', async () => {
    const retained: string[] = [], released: string[] = []
    install({ retainView: (_id: string, token: string) => { retained.push(token); return Promise.reject(new Error('acknowledgement lost')) },
      releaseView: (_id: string, token: string) => { released.push(token); return Promise.resolve() } })
    const first = retainSessionView('chat'), second = retainSessionView('chat')
    expect(new Set(retained).size).toBe(2)
    first(); await settle(); expect(released).toEqual([retained[0]])
    second(); await settle(); expect(released).toEqual(retained)
  })
})
