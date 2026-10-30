import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/composer-paste-vectors.json'
import { decideComposerPaste, type ComposerPasteInput } from './clipboard-paste'

describe('composer clipboard paste contract', () => {
  for (const vector of vectors.cases) {
    test(vector.name, () => {
      expect(decideComposerPaste(vector.input as ComposerPasteInput)).toEqual(vector.expected)
    })
  }
})
