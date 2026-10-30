import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

;(globalThis as any).window = {}
const source = readFileSync(new URL('./contracts.ts', import.meta.url), 'utf8')
  .replace(/\s+as any/g, '')
  .replace(/: any/g, '')
  .replace(/ = \(\) => \{\}/g, ' = () => {}')
new Function(source)()

const contracts = (globalThis as any).window.KlausRendererProductContracts
const snapshot = (taskListId: string, generation: string, revision: number, loaded: number, fingerprint = `fp-${revision}`) => ({
  taskListId,
  generation,
  revision,
  loaded,
  fingerprint,
})

describe('task snapshot arbitration', () => {
  test('rejects a less complete page at the same authoritative revision', () => {
    expect(contracts.taskSnapshotDecision(
      snapshot('session-1', 'gen-1', 7, 101, 'same'),
      snapshot('session-1', 'gen-1', 7, 100, 'same'),
    )).toEqual({ accept: false, reason: 'less-complete' })
  })

  test('allows a legitimate source switch and a later switch back', () => {
    const personal = snapshot('session-1', 'personal-gen', 3, 2)
    const team = snapshot('team-a', 'team-gen', 1, 4)
    expect(contracts.taskSnapshotDecision(personal, team)).toEqual({ accept: true })
    expect(contracts.taskSnapshotDecision(team, personal)).toEqual({ accept: true })
  })

  test('still accepts a newer revision even when it contains fewer tasks', () => {
    expect(contracts.taskSnapshotDecision(
      snapshot('session-1', 'gen-1', 7, 101),
      snapshot('session-1', 'gen-1', 8, 1),
    )).toEqual({ accept: true })
  })

  test('a delayed query cannot restore the preceding plan after a live replacement', () => {
    const current = { ...snapshot('session-1', 'gen-1', 9, 2), planId: 'new-plan' }
    const delayed = { ...snapshot('session-1', 'gen-1', 8, 14), planId: 'old-plan' }
    expect(contracts.taskSnapshotDecision(current, delayed)).toEqual({
      accept: false, reason: 'stale-revision',
    })
    // A plan boundary is not a storage incarnation: it must not bypass the
    // revision fence used to arbitrate the initial pull and live pushes.
    expect(contracts.taskSnapshotSource(current)).toBe(contracts.taskSnapshotSource(delayed))
  })

  test('recovery accepts a new plan with a smaller complete membership', () => {
    const cached = { ...snapshot('session-1', 'gen-1', 8, 14), planId: 'old-plan' }
    const recovered = { ...snapshot('session-1', 'gen-1', 9, 2), planId: 'new-plan' }
    expect(contracts.taskSnapshotDecision(cached, recovered)).toEqual({ accept: true })
  })
})
