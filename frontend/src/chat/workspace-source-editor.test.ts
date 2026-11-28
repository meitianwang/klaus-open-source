import { expect, test } from 'bun:test'
import { sourceQuoteRange } from './workspace-source-editor'

test('quotes reverse selections without assigning an untouched final line', () => {
  expect(sourceQuoteRange('one\r\ntwo\r\nthree', { line: 2, character: 0 }, { line: 0, character: 1 }))
    .toEqual({ text: 'ne\r\ntwo\r\n', startLine: 1, endLine: 2 })
})
