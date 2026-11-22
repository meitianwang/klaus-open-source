import { expect, test } from 'bun:test'
import { effectiveViewportRight, uncoveredViewportRight } from './native-overlay-inset'

function fakeWindow(innerWidth: number, insetValue = '') {
  const root = {} as Element
  return {
    innerWidth,
    document: { documentElement: root },
    getComputedStyle: () => ({
      getPropertyValue: (name: string) => (name === '--klaus-native-panel-inset-right' ? insetValue : ''),
    }),
  }
}

test('uncoveredViewportRight returns full viewport width when no native panel is open', () => {
  expect(uncoveredViewportRight(fakeWindow(1440, ''))).toBe(1440)
  expect(uncoveredViewportRight(fakeWindow(1440, '0px'))).toBe(1440)
})

test('uncoveredViewportRight subtracts the right-hand native panel inset', () => {
  expect(uncoveredViewportRight(fakeWindow(1440, '743px'))).toBe(697)
  expect(uncoveredViewportRight(fakeWindow(1440, '1192px'))).toBe(248)
})

test('uncoveredViewportRight falls back to full width when the entire window is covered', () => {
  expect(uncoveredViewportRight(fakeWindow(1440, '1440px'))).toBe(1440)
  expect(uncoveredViewportRight(fakeWindow(1440, '1410px'))).toBe(1440)
})

test('effectiveViewportRight clamps sidebar and chat triggers to uncovered width while keeping panel-header triggers full-width', () => {
  const win = fakeWindow(1440, '743px')
  expect(effectiveViewportRight(undefined, win)).toBe(697)
  expect(effectiveViewportRight(16, win)).toBe(697)
  expect(effectiveViewportRight(640, win)).toBe(697)
  expect(effectiveViewportRight(697, win)).toBe(1440)
  expect(effectiveViewportRight(1180, win)).toBe(1440)
})
