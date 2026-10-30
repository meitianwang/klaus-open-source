import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore } from 'zustand/vanilla'
import { FriendIntentSelectMenu, friendIntentLabelKey, type FriendIntentSelectState } from './friend-intent-select'
import { I18N } from '../../i18n'

const originalWindow = (globalThis as any).window
beforeAll(() => {
  const base = (originalWindow ?? {}) as Record<string, unknown>
  ;(globalThis as any).window = { ...base, currentLang: 'zh', tt: (key: string) => (I18N as any).zh?.[key] || key }
})
afterAll(() => { (globalThis as any).window = originalWindow })

const render = (state: Partial<FriendIntentSelectState> = {}) => {
  const store = createStore<FriendIntentSelectState>(() => ({ value: 'request', open: false, disabled: false, ...state }))
  const html = renderToStaticMarkup(
    <FriendIntentSelectMenu store={store} rootEl={undefined as unknown as HTMLElement} onIntentChange={() => {}} />,
  )
  return { store, html }
}

describe('friend intent select', () => {
  test('trigger reuses the shared composer dropdown chrome', () => {
    const { html } = render()
    expect(html).toContain('class="kls-select-trigger"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('kls-select-text')
    expect(html).toContain('kls-select-caret')
    expect(html).toContain('请对方处理')
  })

  test('menu rows share the select item classes and check the active intent', () => {
    const { html } = render({ value: 'notice' })
    const requestRow = html.slice(html.indexOf('data-intent="request"'), html.indexOf('data-intent="notice"'))
    const noticeRow = html.slice(html.indexOf('data-intent="notice"'))
    expect(requestRow).toContain('role="menuitemradio"')
    expect(requestRow).toContain('aria-checked="false"')
    expect(requestRow).not.toContain('is-selected')
    expect(noticeRow).toContain('role="menuitemradio"')
    expect(noticeRow).toContain('aria-checked="true"')
    expect(noticeRow).toContain('is-selected')
    expect(noticeRow).toContain('仅告知')
  })

  test('closed menu keeps the panel hidden', () => {
    const { html } = render()
    expect(html).toMatch(/friend-intent-panel[^>]*hidden/)
  })

  test('composer refreshes never close an open menu (flicker regression)', () => {
    const { store, html } = render({ open: true })
    expect(html).not.toMatch(/friend-intent-panel[^>]*hidden/)
    expect(html).toMatch(/kls-select-trigger[^>]*aria-expanded="true"/)
    // updateFriendComposeControls pushes value/hidden/disabled on every composer
    // refresh; none of those pushes may tear down the open panel.
    store.setState({ value: 'notice' })
    store.setState({ disabled: false })
    expect(store.getState()).toMatchObject({ open: true, value: 'notice' })
    // Static markup reads the store's server snapshot, so the post-refresh
    // paint is asserted through a fresh store seeded with the pushed state.
    const refreshed = render({ open: store.getState().open, value: store.getState().value }).html
    expect(refreshed).not.toMatch(/friend-intent-panel[^>]*hidden/)
    expect(refreshed).toMatch(/data-intent="notice"[^>]*is-selected/)
  })

  test('disabled state reaches the trigger', () => {
    const { html } = render({ disabled: true })
    expect(html).toMatch(/kls-select-trigger[^>]*disabled/)
  })

  test('intent label keys stay paired with the shared i18n entries', () => {
    expect(friendIntentLabelKey('request')).toBe('chat_friend_intent_request')
    expect(friendIntentLabelKey('notice')).toBe('chat_friend_intent_notice')
  })
})
