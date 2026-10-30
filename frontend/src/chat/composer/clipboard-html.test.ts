import { expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/composer-clipboard-vectors.json'
import { clipboardSelectionUrl } from './clipboard-html'

for (const vector of vectors.urls) test(`selection link classification preserves the authored URL: ${JSON.stringify(vector.text)}`, () => {
  expect(clipboardSelectionUrl(vector.text)).toBe(vector.url)
})
