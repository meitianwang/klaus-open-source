import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PREFERENCES } from '../../../../main/services/klaus-control/preferences'
import { CapabilitySwitch } from './capability-tabs'
import { AUTO_MEMORY_DEFAULT } from './engine-tabs'
import { PrefNumberRow, PrefTextRow, PrefToggleRow } from './kv'
import { REQUESTABLE_SYSTEM_PERMISSIONS } from './misc-tabs'

describe('settings renderer contracts', () => {
  test('automatic memory remains opt-in in both the renderer and control catalog', () => {
    expect(AUTO_MEMORY_DEFAULT).toBe(false)
    expect(PREFERENCES.find(preference => preference.name === 'autoMemory')?.unset).toBe('off')
  })

  test('in-app consent requests cover exactly the domains the host can ask for', () => {
    expect(REQUESTABLE_SYSTEM_PERMISSIONS).toEqual(['notification', 'photosLibrary', 'automation'])
  })

  test('shared settings controls expose their visible labels and descriptions', () => {
    const toggle = renderToStaticMarkup(
      <PrefToggleRow id="fixture-toggle" label="Toggle label" desc="Toggle description" checked onChange={() => {}} />,
    )
    expect(toggle).toContain('id="fixture-toggle-label"')
    expect(toggle).toContain('aria-labelledby="fixture-toggle-label"')
    expect(toggle).toContain('aria-describedby="fixture-toggle-desc"')

    const number = renderToStaticMarkup(
      <PrefNumberRow
        id="fixture-number" label="Number label" desc="Number description" value="4"
        attrs={{ min: 1, step: 1 }} onCommit={() => {}}
      />,
    )
    expect(number).toContain('type="number"')
    expect(number).toContain('min="1"')
    expect(number).toContain('aria-labelledby="fixture-number-label"')

    const text = renderToStaticMarkup(
      <PrefTextRow id="fixture-text" label="Text label" desc="Text description" value="saved" onCommit={() => {}} />,
    )
    expect(text).toContain('aria-describedby="fixture-text-desc"')
  })

  test('capability switches have a programmatic name', () => {
    const markup = renderToStaticMarkup(
      <CapabilitySwitch id="fixture-capability" checked={false} ariaLabel="Mobile bridge" onChange={() => {}} />,
    )
    expect(markup).toContain('aria-label="Mobile bridge"')
  })
})
