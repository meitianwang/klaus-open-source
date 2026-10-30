// The large-paste contract: threshold, preview shape, and the model-facing
// reference section are pinned by committed vectors; this suite exercises the
// composer-side implementation against them.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  composePastedTextRequest, isLargePastedText, parsePastedReferenceSection, pastedTextPreview,
  PASTED_FILES_CARRY_REQUEST, PASTED_FILES_HEADER, PASTE_CHAR_THRESHOLD, PASTE_RESTORE_CHAR_LIMIT,
} from './pasted-text'

const VECTOR = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../../../contracts/vectors/pasted-text-vectors.json',
  import.meta.url,
)), 'utf8'))

describe('pasted text threshold', () => {
  test('the pinned paste length is 5000 UTF-16 units', () => {
    expect(PASTE_CHAR_THRESHOLD).toBe(VECTOR.threshold.characters)
    expect(PASTE_RESTORE_CHAR_LIMIT).toBe(VECTOR.restoreLimit.characters)
  })
  for (const row of VECTOR.cases.filter((entry: any) => entry.length)) {
    test(row.name, () => {
      const unit = row.unit
      const text = unit.repeat(row.length)
      expect(text).toHaveLength(row.length * unit.length)
      expect(isLargePastedText(text)).toBe(row.expected.large)
    })
  }
})

describe('pasted text preview', () => {
  test('collapses whitespace, cuts at the pinned limit with an ellipsis', () => {
    const row = VECTOR.cases.find((entry: any) => entry.expected?.previewLength)
    const preview = pastedTextPreview(row.text)
    expect(Array.from(preview)).toHaveLength(row.expected.previewLength)
    expect(preview.endsWith(row.expected.endsWith)).toBe(true)
    expect(preview).not.toMatch(/\s\n|\n/)
    expect(row.expected.singleLine).toBe(true)
  })
  test('short text previews verbatim', () => {
    expect(pastedTextPreview('  two   words ')).toBe('two words')
  })
})

describe('model-facing reference section', () => {
  for (const row of VECTOR.cases.filter((entry: any) => entry.cards)) {
    test(row.name, () => {
      if (row.expected.text) {
        const composed = composePastedTextRequest(row.body, row.cards)
        expect(composed.text).toBe(row.expected.text)
        return
      }
      const parsed = parsePastedReferenceSection(row.text)
      expect(parsed).not.toBeNull()
      expect(parsed!.displayText).toBe(row.expected.displayText)
      expect(parsed!.cards.map(card => ({ path: card.path, preview: card.preview }))).toEqual(row.expected.cards)
    })
  }
  test('the section header and notice are the pinned strings', () => {
    expect(PASTED_FILES_HEADER).toBe(VECTOR.requestSection.header)
    expect(PASTED_FILES_CARRY_REQUEST).toBe(VECTOR.requestSection.emptyBodyNotice)
  })
  test('a body without the section parses as no cards', () => {
    expect(parsePastedReferenceSection('plain prose\n\nmore prose')).toBeNull()
  })
})
