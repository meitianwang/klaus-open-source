import { describe, expect, test } from 'bun:test'
import { activateGoalShortcut, isGoalShortcut, withGoalShortcut } from './goal-shortcut'

function host(initialDraft = '/goal Keep this objective') {
  const state = { sessionId: 'a' as string | null, draft: initialDraft, enabled: false, enableCalls: 0, replacements: 0, caret: -1 }
  const api = {
    sessionId: () => state.sessionId,
    enabled: () => state.enabled,
    enable: async () => { state.enableCalls++; state.enabled = true; return true },
    readDraft: () => state.draft,
    replaceDraft: (value: string, caret: number) => { state.draft = value; state.caret = caret; state.replacements++ },
  }
  return { state, api }
}

describe('Goal shortcut contract', () => {
  test('a single explicit submission preserves the full objective after arming', async () => {
    const { state, api } = host('/goal Finish the report')
    const range = { start: 0, end: 5 }
    expect(await activateGoalShortcut(api, range)).toBe(true)
    const accepted: string[] = []
    if (state.draft.trim()) accepted.push(state.draft.trim())
    expect(accepted).toEqual(['Finish the report'])
    expect(state.enableCalls).toBe(1)
  })

  test('keeps one local entry while preserving unrelated discovered commands', () => {
    const commands = withGoalShortcut([{ name: 'GOAL', source: 'engine' }, { name: 'review', source: 'project' }], 'Goal mode')
    expect(commands.map(command => command.name)).toEqual(['goal', 'review'])
    expect(commands[0].description).toBe('Goal mode')
    expect(isGoalShortcut(commands[0])).toBe(true)
    expect(isGoalShortcut({ name: 'goal', source: 'engine' })).toBe(false)
    expect(withGoalShortcut([], 'Goal mode')).toHaveLength(1)
  })

  test('repeated activation keeps the mode armed and leaves plus-menu drafts intact', async () => {
    const { state, api } = host('Existing objective')
    state.enabled = true
    expect(await activateGoalShortcut(api, null)).toBe(true)
    expect(await activateGoalShortcut(api, null)).toBe(true)
    expect(state.enableCalls).toBe(2)
    expect(state.replacements).toBe(0)
    expect(state.draft).toBe('Existing objective')
  })

  test('mode failure preserves the command and objective for retry', async () => {
    const { state, api } = host()
    api.enable = async () => false
    expect(await activateGoalShortcut(api, { start: 0, end: 5 })).toBe(false)
    expect(state.draft).toBe('/goal Keep this objective')
    expect(state.replacements).toBe(0)
  })

  test('does not consume edits made while Spec mode is being disabled', async () => {
    const { state, api } = host()
    let finish!: () => void
    api.enable = () => new Promise(resolve => { finish = () => { state.enabled = true; resolve(true) } })
    const pending = activateGoalShortcut(api, { start: 0, end: 5 })
    state.draft = 'A newer objective'
    finish()
    expect(await pending).toBe(true)
    expect(state.draft).toBe('A newer objective')
    expect(state.replacements).toBe(0)
  })

  test('does not consume another session after an asynchronous mode change', async () => {
    const { state, api } = host()
    let finish!: () => void
    api.enable = () => new Promise(resolve => { finish = () => { state.enabled = true; resolve(true) } })
    const pending = activateGoalShortcut(api, { start: 0, end: 5 })
    state.sessionId = 'b'
    state.draft = 'Session B draft'
    finish()
    expect(await pending).toBe(false)
    expect(state.draft).toBe('Session B draft')
    expect(state.replacements).toBe(0)
  })
})

 test('leaving and returning during mode activation preserves the abandoned command', async () => {
  const { state, api } = host()
  let revision = 0, finish!: () => void
  const tokenHost = { ...api, interactionToken: () => String(revision) }
  tokenHost.enable = () => new Promise(resolve => { finish = () => { state.enabled = true; resolve(true) } })
  const pending = activateGoalShortcut(tokenHost, { start: 0, end: 5 })
  revision += 2
  finish()
  expect(await pending).toBe(false)
  expect(state.draft).toBe('/goal Keep this objective')
  expect(state.replacements).toBe(0)
})
