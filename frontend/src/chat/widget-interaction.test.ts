import { describe, expect, test } from 'bun:test'
import { dispatchWidgetInteraction, type WidgetInteractionRequest } from './widget-interaction'

const request: WidgetInteractionRequest = {
  sessionId: 'session-12345678', toolCallId: 'call-1', widgetId: 'a'.repeat(64), revision: 1,
  path: '/widget/snapshot.html', title: 'Counter', text: '[Widget: Counter]\n{"value":1}', submit: true,
}

function fixture() {
  const events: string[] = []
  let current = true
  let busy = false
  let manual = false
  let confirmed = true
  const deps = {
    isCurrent: async () => { events.push('current'); return current },
    confirm: async () => { events.push('confirm'); return confirmed },
    appendDraft: () => { events.push('draft') },
    isBusy: () => busy,
    needsManualSend: () => manual,
    modelReady: async () => { events.push('model'); return true },
    queue: async () => { events.push('queue'); return true },
    send: async () => { events.push('send'); return true },
    stale: () => { events.push('stale') },
    manual: () => { events.push('manual') },
  }
  return { events, deps, setCurrent: (value: boolean) => { current = value }, setBusy: (value: boolean) => { busy = value }, setManual: (value: boolean) => { manual = value }, setConfirmed: (value: boolean) => { confirmed = value } }
}

describe('Widget interaction dispatch', () => {
  test('submit:false writes only a draft without confirmation or send', async () => {
    const f = fixture()
    expect(await dispatchWidgetInteraction({ ...request, submit: false }, f.deps)).toBe(true)
    expect(f.events).toEqual(['current', 'draft'])
  })
  test('submit:true cannot send without explicit confirmation', async () => {
    const f = fixture()
    f.setConfirmed(false)
    expect(await dispatchWidgetInteraction(request, f.deps)).toBe(false)
    expect(f.events).toEqual(['current', 'confirm'])
  })
  test('a stale revision or session switch during confirmation cannot queue or send', async () => {
    const f = fixture()
    f.deps.confirm = async () => { f.events.push('confirm'); f.setCurrent(false); return true }
    expect(await dispatchWidgetInteraction(request, f.deps)).toBe(false)
    expect(f.events).toEqual(['current', 'confirm', 'current', 'stale'])
  })
  test('confirmed interaction queues into a busy task without touching its draft', async () => {
    const f = fixture()
    f.setBusy(true)
    expect(await dispatchWidgetInteraction(request, f.deps)).toBe(true)
    expect(f.events).toEqual(['current', 'confirm', 'current', 'queue'])
  })
  test('confirmed idle interaction sends only after model readiness and a second scope check', async () => {
    const f = fixture()
    expect(await dispatchWidgetInteraction(request, f.deps)).toBe(true)
    expect(f.events).toEqual(['current', 'confirm', 'current', 'model', 'current', 'send'])
  })
  test('a turn starting during model readiness converts the interaction to a queued message', async () => {
    const f = fixture()
    f.deps.modelReady = async () => { f.events.push('model'); f.setBusy(true); return true }
    expect(await dispatchWidgetInteraction(request, f.deps)).toBe(true)
    expect(f.events.at(-1)).toBe('queue')
    expect(f.events).not.toContain('send')
  })
  test('Goal setup and a paused queue leave interaction in the draft', async () => {
    const f = fixture()
    f.setManual(true)
    expect(await dispatchWidgetInteraction(request, f.deps)).toBe(false)
    expect(f.events).toEqual(['current', 'confirm', 'current', 'draft', 'manual'])
  })
  test('oversized or empty data cannot send', async () => {
    const f = fixture()
    expect(await dispatchWidgetInteraction({ ...request, text: 'x'.repeat(21 * 1024) }, f.deps)).toBe(false)
    expect(await dispatchWidgetInteraction({ ...request, text: '' }, f.deps)).toBe(false)
    expect(f.events).toEqual(['stale', 'stale'])
  })
})
