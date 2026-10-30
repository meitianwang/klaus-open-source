import { describe, expect, test } from 'bun:test'
import recoveryVectors from '../../../../contracts/vectors/session-recovery-vectors.json'

;(globalThis as any).window ??= { addEventListener: () => {} }
const { foldTurnGroups, unitsFromMessages } = await import('./TranscriptView')

describe('message-less continuation failures', () => {
  const vector = recoveryVectors.messageLessFailures
  const diagnostic = { message: vector.turnErrors['retry-two'], kind: 'invalid_request', status: 400, requestId: 'retry-request' }
  const fold = (rows: any[], statuses: Record<string, string> = vector.turnStatuses, starts: Record<string, number> = vector.turnStartedAtMs) =>
    foldTurnGroups(unitsFromMessages(rows), null, statuses, {}, vector.turnErrors, {}, {}, new Set(), {}, null, undefined, { 'retry-two': diagnostic }, starts)

  test('restores each saved failure after the interrupted response without inventing content', () => {
    const groups = fold([{ role: 'assistant', uuid: 'partial', turnId: 'original', phase: 'commentary', text: 'Checking the saved configuration' }])
    expect(groups.map(group => group.turnId)).toEqual(['original', ...vector.expectedFailureTurns])
    for (const group of groups.slice(1)) {
      expect(group.nodes.map(node => node.kind === 'unit' ? node.unit.type : node.kind)).toEqual(['fail-hint'])
      const node = group.nodes[0]
      expect(node.kind === 'unit' ? node.unit.msg.text : null).toBe('Unsupported message role')
    }
    const node = groups.at(-1)!.nodes[0]
    expect(node.kind === 'unit' ? node.unit.msg.errorDetails : null).toEqual(diagnostic)
  })

  test('orders empty failures between real turns and never duplicates a row-bearing failure', () => {
    const groups = fold([
      { role: 'user', uuid: 'original', turnId: 'original', text: 'Check the configuration' },
      { role: 'assistant', uuid: 'retry-row', turnId: 'retry-two', text: 'Retrying' },
      { role: 'assistant', uuid: 'later', turnId: 'later', text: 'Finished' },
    ], { ...vector.turnStatuses, later: 'completed' }, { ...vector.turnStartedAtMs, later: 600 })
    expect(groups.map(group => group.turnId)).toEqual(['original', 'retry-one', 'retry-two', 'later'])
    expect(groups.flatMap(group => group.nodes).filter(node => node.kind === 'unit' && node.unit.type === 'fail-hint')).toHaveLength(2)
  })

  test('does not bring failures from earlier transcript pages into the visible tail', () => {
    expect(fold([{ role: 'assistant', uuid: 'later', turnId: 'later', text: 'Finished' }], { ...vector.turnStatuses, later: 'completed' }, { ...vector.turnStartedAtMs, later: 600 }).map(group => group.turnId)).toEqual(['later'])
  })

  test('can show a failure with no transcript rows and requires a recorded start', () => {
    expect(fold([]).map(group => group.turnId)).toEqual(vector.expectedFailureTurns)
    expect(fold([], vector.turnStatuses, {})).toEqual([])
  })
})

describe('main transcript turn layout', () => {
  test('preserves replay chronology and gives artifacts to one segment', () => {
    const units = unitsFromMessages([
      { role: 'user', uuid: 'u1', turnId: 't1', text: 'First request' },
      { role: 'assistant', uuid: 'a1', turnId: 't1', phase: 'final_answer', text: 'First answer' },
      { role: 'user', uuid: 'u2', turnId: 't2', text: 'Second request' },
      { role: 'assistant', uuid: 'a2', turnId: 't2', phase: 'final_answer', text: 'Second answer' },
      { role: 'assistant', uuid: 'resume', turnId: 't1', phase: 'commentary', text: 'Late activity' },
    ])
    const groups = foldTurnGroups(units, null, {}, {})
    expect(groups.map(group => group.key)).toEqual(['t1', 't2', 't1:segment:' + units.at(-1)!.key])
    expect(groups.flatMap(group => group.nodes).filter(node => node.kind === 'turn-changes' && node.turnId === 't1')).toHaveLength(1)
    expect(groups[2].nodes.some(node => node.kind === 'unit' && node.unit.segment?.text === 'Late activity')).toBe(true)
  })

  test('keeps a steered request in its original turn without losing either user anchor', () => {
    const groups = foldTurnGroups(unitsFromMessages([
      { role: 'user', uuid: 'original', turnId: 't', text: 'Original request' },
      { role: 'user', uuid: 'steering', turnId: 't', text: 'Steering request' },
      { role: 'assistant', uuid: 'final', turnId: 't', phase: 'final_answer', text: 'Final answer' },
    ]), null, {}, {})
    expect(groups).toHaveLength(1)
    expect(groups[0].nodes.filter(node => node.kind === 'unit' && node.unit.type === 'user')
      .map(node => node.kind === 'unit' ? node.unit.msg.uuid : null)).toEqual(['original', 'steering'])
  })

  test('keeps imported requests without turn IDs in separate chronological groups', () => {
    const groups = foldTurnGroups(unitsFromMessages([
      { role: 'user', uuid: 'old-1', text: 'First legacy request' },
      { role: 'assistant', uuid: 'old-a1', text: 'First legacy answer' },
      { role: 'user', uuid: 'old-2', text: 'Second legacy request' },
      { role: 'assistant', uuid: 'old-a2', text: 'Second legacy answer' },
    ]), null, {}, {})
    expect(groups).toHaveLength(2)
    expect(new Set(groups.map(group => group.key)).size).toBe(2)
    expect(groups.map(group => group.nodes.filter(node => node.kind === 'unit' && node.unit.type === 'user').length)).toEqual([1, 1])
  })
})
