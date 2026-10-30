import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/web-search-settings.json'
import { WEB_SEARCH_SOURCES, resolveWebSearchSettings } from '../../../../contracts/web-search-settings'
import { PREFERENCES } from '../../../../main/services/klaus-control/preferences'

describe('web search settings contract', () => {
  for (const vector of vectors.sources) test(vector.name, () => {
    expect(resolveWebSearchSettings(vector.input)).toEqual(vector.expected)
  })

  test('the control catalog advertises the same default as the settings page', () => {
    const preference = PREFERENCES.find(preference => preference.name === 'webSearchSource')
    expect(preference?.unset).toBe(vectors.default.source)
    expect(preference?.place).toBe('engineWeb')
    expect(WEB_SEARCH_SOURCES).not.toContain('brave')
  })
})
