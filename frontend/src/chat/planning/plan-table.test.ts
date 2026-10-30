import { expect, test } from 'bun:test'
import { createPlanSourceState, planSourceContent, planSourceInsertion } from './plan-source'
import { planTableCells, planTableInput } from './plan-table'

test('table cell replacement preserves padding, alignment and all unrelated authored source', () => {
  const source = '| Plant  | Cost |\n| :--- | ---: |\n| **Sun**  | 50 |'
  const cells = planTableCells(source)
  expect(cells.map(row => row.map(cell => cell.content))).toEqual([['Plant', 'Cost'], ['**Sun**', '50']])
  let state = createPlanSourceState(source.replaceAll('\n', '\r\n'))
  const cost = cells[1][1]
  state = planSourceInsertion(state, cost.from, cost.to, '75', 'input.table').state
  expect(planSourceContent(state)).toBe(source.replaceAll('\n', '\r\n').replace('50', '75'))
})

test('cell ranges retain nested quote and escaped delimiter content', () => {
  const source = '> | Left | Right |\n> | --- | --- |\n> | A\\|B | **C** |'
  const cells = planTableCells(source, 40)
  expect(cells[1].map(cell => cell.content)).toEqual(['A\\|B', '**C**'])
  expect(source.slice(cells[1][0].from - 40, cells[1][0].to - 40)).toBe('A\\|B')
})

test('a quoted or nested table uses the complete document positions rather than a detached span', () => {
  for (const source of ['> | A | B |\n> | - | - |\n> | C | D |', '- Item\n\n  | A | B |\n  | - | - |\n  | C | D |']) {
    const from = source.indexOf('|')
    const cells = planTableCells(source, 0, from)
    expect(cells.map(row => row.map(cell => cell.content))).toEqual([['A', 'B'], ['C', 'D']])
    const cell = cells[1][0]
    expect(source.slice(cell.from, cell.to)).toBe('C')
  }
})

test('empty cells insert within their authored delimiters', () => {
  for (const source of ['| A | B |\n| - | - |\n|   |   |', '| A | B |\n| --- | --- |\n| | |']) {
    const cells = planTableCells(source)
    expect(cells[1].map(cell => cell.content)).toEqual(['', ''])
    const cell = cells[1][0]
    expect(source.slice(0, cell.from) + 'Added' + source.slice(cell.to)).toContain('Added')
    expect(planTableCells(source.slice(0, cell.from) + 'Added' + source.slice(cell.to))[1].map(cell => cell.content)).toEqual(['Added', ''])
  }
})

test('cell typing cannot create unintended table rows or columns', () => {
  expect(planTableInput('A|B')).toBe('A\\|B')
  expect(planTableInput('A\\|B')).toBe('A\\|B')
  expect(planTableInput('A\\\\|B')).toBe('A\\\\\\|B')
  expect(planTableInput('First\r\nSecond\tThird')).toBe('First Second Third')
})
