import { describe, expect, test } from 'bun:test'
import vectors from '../../../contracts/vectors/subagent-model-vectors.json'
import { paintSubagentModel } from './subagent-model'

describe('subagent header model', () => {
  test('renders the resolved model name and hides missing stamps from the committed vectors', () => {
    const element = { textContent: '', hidden: true } as HTMLElement
    for (const row of vectors.cases) {
      paintSubagentModel(element, row.task)
      expect(element.textContent).toBe(row.expected)
      expect(element.hidden).toBe(!row.expected)
    }
  })

  test('updates the same header when the selected task changes', () => {
    const element = { textContent: '', hidden: true } as HTMLElement
    paintSubagentModel(element, { model: 'actual-model', modelSource: 'kimi' })
    expect(element.textContent).toBe('actual-model')
    paintSubagentModel(element, { model: 'another-model' })
    expect(element.textContent).toBe('another-model')
    paintSubagentModel(element, null)
    expect(element.textContent).toBe('')
    expect(element.hidden).toBe(true)
  })
})
