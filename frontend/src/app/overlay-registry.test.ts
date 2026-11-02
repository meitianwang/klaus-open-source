import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  claimOverlay,
  closeAllOverlays,
  overlayIdForElement,
  registeredOverlayIds,
  registerOverlay,
  unregisterOverlay,
} from './overlay-registry'

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('claiming an overlay closes every other registered surface', () => {
  const closed: string[] = []
  const offA = registerOverlay('a', () => closed.push('a'))
  const offB = registerOverlay('b', () => closed.push('b'))
  const offC = registerOverlay('c', () => closed.push('c'))

  claimOverlay('b')

  expect(closed).toEqual(['a', 'c'])
  offA(); offB(); offC()
})

test('a surface closing never cascades into closing the claimer', () => {
  const closed: string[] = []
  // "a" closes "b" while closing (mirrors a popover whose close handler hides
  // its own submenu); claiming "c" must still terminate with only a+b closed.
  const offB = registerOverlay('b', () => closed.push('b'))
  const offA = registerOverlay('a', () => { closed.push('a'); unregisterOverlay('b'); offB() })
  const offC = registerOverlay('c', () => closed.push('c'))

  claimOverlay('c')

  expect(closed.sort()).toEqual(['a', 'b'])
  offA(); offC()
})

test('unregister stops a surface from receiving later claims', () => {
  const closed: string[] = []
  const off = registerOverlay('gone', () => closed.push('gone'))
  off()

  claimOverlay('other')

  expect(closed).toEqual([])
  expect(registeredOverlayIds()).not.toContain('gone')
})

test('closeAllOverlays closes every registered surface', () => {
  const closed: string[] = []
  const offs = ['x', 'y'].map(id => registerOverlay(id, () => closed.push(id)))

  closeAllOverlays()

  expect(closed.sort()).toEqual(['x', 'y'])
  offs.forEach(off => off())
})

test('element overlay ids are stable per element and unique across elements', () => {
  const first = {} as Element
  const second = {} as Element

  expect(overlayIdForElement(first, 'ui-select')).toBe(overlayIdForElement(first, 'ui-select'))
  expect(overlayIdForElement(second, 'ui-select')).not.toBe(overlayIdForElement(first, 'ui-select'))
})

test('composer pickers claim the registry instead of pairwise hides', () => {
  const model = src('../chat/composer/model-select.tsx')
  const permission = src('../chat/composer/permission-select.tsx')
  const chat = src('../chat/chat.ts')
  const source = src('../chat/auth-pill.tsx')

  expect(model).toContain("claimOverlay(overlayIdForElement(rootEl, 'model-select'))")
  expect(model).toContain("registerOverlay(overlayIdForElement(root, 'model-select')")
  expect(permission).toContain("claimOverlay(overlayIdForElement(rootEl, 'permission-select'))")
  expect(permission).toContain("registerOverlay(overlayIdForElement(root, 'permission-select')")
  expect(chat).toContain("claimOverlay('slash-menu')")
  expect(chat).toContain("registerOverlay('slash-menu', hideSlashMenu)")
  expect(chat).toContain('syntheticContextQuery(inputEl.value')
  expect(source).toContain("claimOverlay(overlayIdForElement(pillRef.current, 'auth-mode-select'))")
  expect(source).toContain("registerOverlay(overlayId, onClose)")
  // The dead pairwise hooks (never assigned on window) are gone.
  expect(model).not.toContain('hideSlashMenu')
  expect(permission).not.toContain('hideSlashMenu')
})

test('sidebar popovers and page dropdowns register with the registry', () => {
  const chat = src('../chat/chat.ts')
  const uiSelect = src('./ui-select.ts')

  expect(chat).toContain("registerOverlay('user-menu', closeUserMenu)")
  expect(chat).toContain("registerOverlay('slash-menu', hideSlashMenu)")
  expect(chat).toContain("registerOverlay('usage-popover', close)")
  expect(chat).toContain("unregisterOverlay('usage-popover')")
  expect(chat).toContain("claimOverlay('usage-popover')")
  expect(chat).toContain("claimOverlay('user-menu')")
  expect(chat).toContain('function openComposerPlusMenu()')
  expect(uiSelect).toContain("claimOverlay(overlayIdForElement(root, 'ui-select'))")
  expect(uiSelect).toContain("registerOverlay(overlayIdForElement(root, 'ui-select'), close)")
  expect(uiSelect).toContain("unregisterOverlay(overlayIdForElement(root, 'ui-select'))")
})
