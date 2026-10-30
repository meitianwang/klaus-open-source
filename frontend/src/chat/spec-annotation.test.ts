import { expect, test } from 'bun:test'
import { serializeSpecAnnotation } from './spec-annotation'

test('keeps a repeated selection identifiable without inventing source lines', () => {
  const common = { path: '/project/.klaus/specs/plan.md', content: 'Repeat', comment: 'Revise this occurrence' }
  const first = serializeSpecAnnotation({ ...common, startOffset: 0, endOffset: 6 })
  const second = serializeSpecAnnotation({ ...common, startOffset: 90, endOffset: 96, anchorText: 'Second Repeat' })
  expect(first).not.toBe(second)
  expect(second).toContain('Rendered text range: 90-96')
  expect(second).toContain('Anchor: Second Repeat')
  expect(second).toContain('File: /project/.klaus/specs/plan.md')
  expect(second).not.toContain('L1')
})
