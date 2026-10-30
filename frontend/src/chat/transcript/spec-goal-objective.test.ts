import { describe, expect, test } from 'bun:test'
import { buildSpecGoalObjective } from './spec-review-controller'

describe('Spec goal objective', () => {
  test('references the durable path instead of a summary', () => {
    expect(buildSpecGoalObjective('/project/.klaus/specs/plan.md', 'Implement {path} completely.'))
      .toBe('Implement /project/.klaus/specs/plan.md completely.')
  })

  test('preserves spaces and unicode in paths', () => {
    expect(buildSpecGoalObjective('  /project/My Spec/设计.md  ', 'Complete {path}.'))
      .toBe('Complete /project/My Spec/设计.md.')
  })

  test('cannot create a Spec goal without a document path', () => {
    expect(buildSpecGoalObjective('', 'Implement {path}')).toBe('')
    expect(buildSpecGoalObjective('  ', 'Implement {path}')).toBe('')
  })

  test('templates without placeholders still include the exact path', () => {
    expect(buildSpecGoalObjective('/a.md', 'Implement this Spec')).toBe('Implement this Spec\n\n/a.md')
    expect(buildSpecGoalObjective('/a.md', '')).toBe('/a.md')
  })
})
