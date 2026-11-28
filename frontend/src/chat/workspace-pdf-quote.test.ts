import { expect, test } from 'bun:test'
import { findPdfQuotePage } from './workspace-pdf-quote'
import type { OfficePdfPreview } from '../../../contracts/office-preview'

const pdf: OfficePdfPreview = { kind: 'pdf', pageCount: 10, pages: [
  { index: 4, blocks: [{ kind: 'paragraph', runs: [{ text: 'Shared header' }] }] },
  { index: 7, blocks: [{ kind: 'paragraph', runs: [{ text: 'Shared header' }, { text: 'unique words', br: true }] }] },
] }

test('matches normalized selection to the extracted page index, not array position', () => {
  expect(findPdfQuotePage(pdf, 'header \n unique words')).toBe(7)
  expect(findPdfQuotePage(pdf, 'Shared header')).toBeUndefined()
  expect(findPdfQuotePage(pdf, 'unmatched')).toBeUndefined()
})
