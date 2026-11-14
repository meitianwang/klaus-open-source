import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dynamicActivityLabel, isCompactActivityTool } from '../../chat/transcript/chat-activity'
import { I18N } from '../../i18n/messages'

const en = (key: string) => I18N.en[key] ?? key
const zh = (key: string) => I18N.zh[key] ?? key

describe('read_computer_history compact activity label and i18n parity', () => {
  const prevWindow = (globalThis as any).window

  beforeAll(() => {
    if (typeof (globalThis as any).window === 'undefined') {
      ;(globalThis as any).window = { currentLang: 'en' }
    }
  })

  afterAll(() => {
    if (prevWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = prevWindow
  })

  test('registers read_computer_history as a compact activity row in English and Chinese', () => {
    expect(isCompactActivityTool('read_computer_history')).toBe(true)
    ;(globalThis as any).window.currentLang = 'en'
    expect(dynamicActivityLabel(en, { toolName: 'read_computer_history', args: {}, state: 'running' }, false)).toBe('Reading computer history')
    expect(dynamicActivityLabel(en, { toolName: 'read_computer_history', args: {}, state: 'done' }, true, true)).toBe('Read computer history')
    expect(dynamicActivityLabel(en, { toolName: 'read_computer_history', args: {}, state: 'done' }, true, false)).toBe('read computer history')
    ;(globalThis as any).window.currentLang = 'zh'
    expect(dynamicActivityLabel(zh, { toolName: 'read_computer_history', args: {}, state: 'running' }, false)).toBe('正在查看电脑历史')
    expect(dynamicActivityLabel(zh, { toolName: 'read_computer_history', args: {}, state: 'done' }, true, true)).toBe('已查看电脑历史')
  })

  test('every computer_history_ key exists in both en and zh tables', () => {
    const enKeys = Object.keys(I18N.en).filter(key => key.startsWith('computer_history_') || key.startsWith('chat_activity_computer_history_')).sort()
    const zhKeys = Object.keys(I18N.zh).filter(key => key.startsWith('computer_history_') || key.startsWith('chat_activity_computer_history_')).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(enKeys.length).toBeGreaterThan(40)
  })
})
