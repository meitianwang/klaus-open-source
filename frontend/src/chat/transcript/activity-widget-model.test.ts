import { describe, expect, test } from 'bun:test'
import { parseWidgetSnapshot, validateWidgetMessage, type WidgetSnapshot } from './activity-widget-model'

const snapshot: WidgetSnapshot = {
  kind: 'klaus-widget', sessionId: 'session-12345678', toolCallId: 'call-1', widgetId: 'a'.repeat(64),
  title: 'Counter', revision: 2, path: '/private/widgets/session-12345678/a-r2-hash.html', nonce: 'a'.repeat(32),
}
const frame = {} as Window
const event = (data: unknown, source: MessageEventSource | null = frame, origin = 'null') => ({ data, source, origin })
const message = (data: unknown, options: unknown = {}) => ({ type: 'klaus-widget:send', context: {
  sessionId: snapshot.sessionId, widgetId: snapshot.widgetId, revision: snapshot.revision, nonce: snapshot.nonce,
}, data, options })

describe('Widget snapshot parsing and message validation', () => {
  test('accepts only the completed tool’s own snapshot', () => {
    expect(parseWidgetSnapshot(JSON.stringify(snapshot), snapshot.sessionId, snapshot.toolCallId)).toEqual(snapshot)
    expect(parseWidgetSnapshot(JSON.stringify({ contentItems: [{ type: 'text', text: JSON.stringify(snapshot) }] }), snapshot.sessionId, snapshot.toolCallId)).toEqual(snapshot)
    const response = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(snapshot) }] }
    expect(parseWidgetSnapshot(JSON.stringify(response), snapshot.sessionId, snapshot.toolCallId)).toEqual(snapshot)
    expect(parseWidgetSnapshot(JSON.stringify({ __result: { text: JSON.stringify(response) } }), snapshot.sessionId, snapshot.toolCallId)).toEqual(snapshot)
    expect(parseWidgetSnapshot(JSON.stringify({ ...response, success: false }), snapshot.sessionId, snapshot.toolCallId)).toBeNull()
    expect(parseWidgetSnapshot(JSON.stringify(snapshot), 'another-session', snapshot.toolCallId)).toBeNull()
    expect(parseWidgetSnapshot(JSON.stringify(snapshot), snapshot.sessionId, 'another-call')).toBeNull()
    expect(parseWidgetSnapshot(JSON.stringify({ ...snapshot, widgetId: '../escape' }), snapshot.sessionId, snapshot.toolCallId)).toBeNull()
    expect(parseWidgetSnapshot(JSON.stringify({ ...snapshot, revision: 0 }), snapshot.sessionId, snapshot.toolCallId)).toBeNull()
    expect(parseWidgetSnapshot('not JSON', snapshot.sessionId, snapshot.toolCallId)).toBeNull()
  })

  test('accepts bounded pure JSON only from the exact opaque iframe and current revision', () => {
    expect(validateWidgetMessage(event(message({ value: 3 }, { submit: false })), frame, snapshot))
      .toEqual({ text: '[Widget: Counter]\n{"value":3}', submit: false })
    expect(validateWidgetMessage(event(message('send it', { submit: true })), frame, snapshot))
      .toEqual({ text: '[Widget: Counter]\n"send it"', submit: true })
    expect(validateWidgetMessage(event(message({ value: 3 }), {} as Window), frame, snapshot)).toBeNull()
    expect(validateWidgetMessage(event(message({ value: 3 }), frame, 'klaus-app://app'), frame, snapshot)).toBeNull()
    expect(validateWidgetMessage(event({ ...message(1), context: { ...message(1).context, nonce: 'bad' } }), frame, snapshot)).toBeNull()
    expect(validateWidgetMessage(event({ ...message(1), context: { ...message(1).context, revision: 1 } }), frame, snapshot)).toBeNull()
    expect(validateWidgetMessage(event(message('x'.repeat(17 * 1024))), frame, snapshot)).toBeNull()
    expect(validateWidgetMessage(event(message(new Date())), frame, snapshot)).toBeNull()
    expect(validateWidgetMessage(event(message(JSON.parse('{"__proto__":{"polluted":true}}'))), frame, snapshot)).toBeNull()
    expect(validateWidgetMessage(event(message(1, { submit: 'yes' })), frame, snapshot)).toBeNull()
    expect(validateWidgetMessage(event(message(1, { submit: true, extra: 'ignore' })), frame, snapshot)).toBeNull()
  })
})
