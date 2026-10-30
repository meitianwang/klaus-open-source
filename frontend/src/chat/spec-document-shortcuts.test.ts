import { expect, test } from 'bun:test'
import { specFindNavigationDirection } from './spec-document-shortcuts'

const focusedFind = { findOpen: true, focusInside: true }

test('Enter and Shift+Enter navigate an open, focused Spec find panel', () => {
  expect(specFindNavigationDirection({ key: 'Enter' }, focusedFind)).toBe(1)
  expect(specFindNavigationDirection({ key: 'Enter', shiftKey: true }, focusedFind)).toBe(-1)
})

for (const modifier of ['metaKey', 'ctrlKey'] as const) {
  test(`${modifier}+Enter remains available to approval cards even while Spec find is open`, () => {
    for (const focusInside of [false, true]) {
      expect(specFindNavigationDirection({ key: 'Enter', [modifier]: true }, { findOpen: true, focusInside })).toBeNull()
    }
  })
}

test('an open find panel does not consume Enter typed in the chat composer', () => {
  expect(specFindNavigationDirection({ key: 'Enter' }, { findOpen: true, focusInside: false })).toBeNull()
  expect(specFindNavigationDirection({ key: 'Enter', shiftKey: true }, { findOpen: true, focusInside: false })).toBeNull()
})

test('a closed find panel leaves its focused document keys alone', () => {
  expect(specFindNavigationDirection({ key: 'Enter' }, { findOpen: false, focusInside: true })).toBeNull()
})

for (const event of [
  { key: 'Enter', altKey: true },
  { key: 'Enter', isComposing: true },
  { key: 'Enter', keyCode: 229 },
  { key: 'Enter', defaultPrevented: true },
  { key: 'Escape' },
]) {
  test(`find navigation preserves ${JSON.stringify(event)}`, () => {
    expect(specFindNavigationDirection(event, focusedFind)).toBeNull()
  })
}
