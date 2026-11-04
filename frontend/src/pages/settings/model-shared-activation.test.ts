import { expect, test } from 'bun:test'
import { activateModelSource } from './model-shared'
import { I18N } from '../../i18n/messages'

async function withWindow(
  setMainModel: (...args: unknown[]) => Promise<unknown>,
  run: (events: string[]) => Promise<void>,
) {
  const target = globalThis as any
  const previous = target.window
  const events: string[] = []
  target.window = {
    currentLang: 'en',
    currentSessionId: 'chat-one',
    dispatchEvent: (event: Event) => { events.push(event.type) },
    klaus: { session: { setMainModel } },
  }
  try { await run(events) } finally { target.window = previous }
}

test('a refreshing catalog keeps the previous selection and reports it in words', async () => {
  await withWindow(async () => { throw { data: { error: { code: 'MODEL_CATALOG_NOT_READY' } } } }, async events => {
    let failure: unknown
    try { await activateModelSource('antigravity') } catch (error) { failure = error }
    expect(String((failure as Error | undefined)?.message)).toBe(I18N.en.model_catalog_refresh_pending)
    // Nothing was accepted, so no source-changed event may announce a switch.
    expect(events).toEqual([])
  })
})

test('every other refusal keeps its original error', async () => {
  const failure = new Error('engine refused')
  await withWindow(async () => { throw failure }, async events => {
    let caught: unknown
    try { await activateModelSource('antigravity') } catch (error) { caught = error }
    expect(caught).toBe(failure)
    expect(events).toEqual([])
  })
})
