// A scheduled run's trigger message is host-authored: its bubble carries a
// display snapshot with `origin: 'automation'`, and the transcript answers with
// one provenance caption above the bubble. Both the live frame and the replayed
// history carry the same snapshot, so the caption is asserted through the real
// read-only transcript rather than against the helper alone.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

;(globalThis as any).window = {
  addEventListener: () => {}, currentLang: 'en',
  klaus: { media: { url: (p: string) => p } },
}

const { automationMessageLabel } = await import('./automation-source')
const { StaticTranscriptView } = await import('./TranscriptView')

function renderUser(localRender: unknown): string {
  return renderToStaticMarkup(<StaticTranscriptView container={{} as HTMLElement} running={false}
    msgs={[{ role: 'user', uuid: 'msg-1', turnId: 'turn-1', text: 'Run the nightly report', localRender }]} />)
}

describe('automationMessageLabel', () => {
  test('names the task behind a scheduled snapshot', () => {
    expect(automationMessageLabel({ origin: 'automation', taskName: 'Daily report' }, 'Scheduled task')).toBe('Scheduled task · Daily report')
  })
  test('falls back to the bare scheduled label', () => {
    expect(automationMessageLabel({ origin: 'automation' }, 'Scheduled task')).toBe('Scheduled task')
  })
  test('ignores rows a human authored', () => {
    expect(automationMessageLabel(undefined, 'Scheduled task')).toBeNull()
    expect(automationMessageLabel({ origin: 'goal' }, 'Scheduled task')).toBeNull()
    expect(automationMessageLabel([], 'Scheduled task')).toBeNull()
  })
})

describe('the transcript provenance caption', () => {
  test('a scheduled trigger row carries the caption', () => {
    const html = renderUser({ origin: 'automation', taskName: 'Daily report', taskId: 'cron-1', runId: 3, triggerType: 'scheduled' })
    expect(html).toContain('Scheduled task · Daily report')
  })
  test('a typed row carries no caption', () => {
    expect(renderUser(undefined)).not.toContain('Scheduled task')
  })
})
