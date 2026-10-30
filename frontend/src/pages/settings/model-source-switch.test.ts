import { describe, expect, test } from 'bun:test'
import type { MainModelSelection } from '../../../bridge/types'
import { mainModelMenuValue } from '../../chat/composer/model-select'
import { activateModelSource, effectiveModelSource, loadSourceTierMappings } from './model-shared'

function createSessionHost() {
  const resolvedDefaults: Record<string, string> = {
    custom: 'custom:preferred',
    codex: 'codex:preferred',
    qoder: 'qoder:qmodel_38max',
  }
  const catalogs: Record<string, Array<{ value: string }>> = {
    custom: [{ value: 'custom:first' }, { value: 'custom:preferred' }],
    codex: [{ value: 'codex:first' }, { value: 'codex:preferred' }],
    qoder: [{ value: 'qoder:qmodel_38max' }, { value: 'qoder:ultimate' }],
  }
  let defaults: MainModelSelection = {
    mode: 'auto', source: 'custom', resolvedMode: resolvedDefaults.custom,
  }
  const sessions = new Map<string, MainModelSelection>([
    ['session-1', { mode: 'qoder:qmodel_38max', source: 'qoder', resolvedMode: 'qoder:qmodel_38max' }],
    ['session-2', { ...defaults }],
  ])
  const notifications: MainModelSelection[][] = []
  let globalReads = 0
  const getMainModel = async (id?: string): Promise<MainModelSelection> => {
    const selected = id ? sessions.get(id) : defaults
    if (!selected) throw new Error(`Unknown session ${id}`)
    return { ...selected }
  }
  const createSession = (id: string) => sessions.set(id, { ...defaults })
  const mockWindow = {
    currentSessionId: 'session-2' as string | null,
    klaus: {
      session: {
        getMainModel,
        setMainModel: async (mode: string, id?: string, source?: string) => {
          if (!source) throw new Error('A source switch requires a persisted source')
          const selected = { mode, source, resolvedMode: resolvedDefaults[source] || null }
          if (id) sessions.set(id, selected)
          defaults = { ...selected }
        },
      },
      settings: { kv: {
        get: async () => { globalReads++; return defaults.source },
        set: async () => { throw new Error('Source changes must use the session API') },
      } },
    },
    dispatchEvent: () => {
      notifications.push([...sessions.values()].map(selected => ({ ...selected })))
      return true
    },
  }
  const visibleSelection = async (id?: string) => {
    const saved = await getMainModel(id)
    return {
      source: await effectiveModelSource(id || null),
      model: mainModelMenuValue(catalogs[saved.source], saved.resolvedMode),
    }
  }
  return {
    mockWindow, sessions, createSession, getMainModel, visibleSelection, notifications,
    getGlobalReads: () => globalReads,
  }
}

describe('model source switching', () => {
  test('three conversations keep their own source while later conversations inherit the last change', async () => {
    const global = globalThis as any
    const previousWindow = global.window
    const host = createSessionHost()
    global.window = host.mockWindow
    try {
      expect(await host.visibleSelection('session-1')).toEqual({ source: 'qoder', model: 'qoder:qmodel_38max' })
      expect(await host.visibleSelection('session-2')).toEqual({ source: 'custom', model: 'custom:preferred' })

      host.createSession('session-3')
      expect(await host.visibleSelection('session-3')).toEqual({ source: 'custom', model: 'custom:preferred' })
      host.mockWindow.currentSessionId = 'session-3'
      await activateModelSource('codex')
      expect(await host.visibleSelection('session-3')).toEqual({ source: 'codex', model: 'codex:preferred' })
      expect(await host.visibleSelection('session-2')).toEqual({ source: 'custom', model: 'custom:preferred' })
      expect(await host.visibleSelection('session-1')).toEqual({ source: 'qoder', model: 'qoder:qmodel_38max' })

      host.mockWindow.currentSessionId = 'session-2'
      await activateModelSource('custom')
      expect(await host.visibleSelection('session-2')).toEqual({ source: 'custom', model: 'custom:preferred' })
      expect(await host.visibleSelection('session-3')).toEqual({ source: 'codex', model: 'codex:preferred' })
      expect(await host.visibleSelection('session-1')).toEqual({ source: 'qoder', model: 'qoder:qmodel_38max' })

      host.createSession('session-4')
      expect(await host.visibleSelection('session-4')).toEqual({ source: 'custom', model: 'custom:preferred' })
      expect(host.notifications.map(snapshot => snapshot.map(selected => selected.source))).toEqual([
        ['qoder', 'custom', 'codex'],
        ['qoder', 'custom', 'codex'],
      ])
      expect(host.getGlobalReads()).toBe(0)
    } finally {
      global.window = previousWindow
    }
  })

  test('an explicit side conversation target is independent of the main conversation', async () => {
    const global = globalThis as any
    const previousWindow = global.window
    const host = createSessionHost()
    host.createSession('side-session')
    global.window = host.mockWindow
    try {
      await activateModelSource('codex', '  side-session  ')
      expect(await host.visibleSelection('side-session')).toEqual({ source: 'codex', model: 'codex:preferred' })
      expect(await host.visibleSelection('session-2')).toEqual({ source: 'custom', model: 'custom:preferred' })
    } finally {
      global.window = previousWindow
    }
  })

  test('a new-chat source change updates only the host default until a conversation is created', async () => {
    const global = globalThis as any
    const previousWindow = global.window
    const host = createSessionHost()
    host.mockWindow.currentSessionId = null
    global.window = host.mockWindow
    try {
      await activateModelSource('codex')
      expect(await host.visibleSelection()).toEqual({ source: 'codex', model: 'codex:preferred' })
      expect(await host.visibleSelection('session-2')).toEqual({ source: 'custom', model: 'custom:preferred' })
      expect(host.sessions.size).toBe(2)
      host.createSession('session-3')
      expect(await host.visibleSelection('session-3')).toEqual({ source: 'codex', model: 'codex:preferred' })
    } finally {
      global.window = previousWindow
    }
  })

  test('an unresolved model retains its source without consulting the global default', async () => {
    const global = globalThis as any
    const previousWindow = global.window
    const host = createSessionHost()
    host.sessions.set('session-2', { mode: 'auto', source: 'custom', resolvedMode: null })
    global.window = host.mockWindow
    try {
      await activateModelSource('codex', null)
      expect(await host.visibleSelection('session-2')).toEqual({ source: 'custom', model: '' })
      expect(host.getGlobalReads()).toBe(0)
    } finally {
      global.window = previousWindow
    }
  })

  test('a rejected source change preserves every conversation and emits no success notification', async () => {
    const global = globalThis as any
    const previousWindow = global.window
    const host = createSessionHost()
    host.mockWindow.klaus.session.setMainModel = async () => { throw new Error('source unavailable') }
    global.window = host.mockWindow
    try {
      const failure = await activateModelSource('codex').then(() => null, (error: Error) => error)
      expect(failure?.message).toBe('source unavailable')
      expect(await host.visibleSelection('session-2')).toEqual({ source: 'custom', model: 'custom:preferred' })
      expect(await host.visibleSelection('session-1')).toEqual({ source: 'qoder', model: 'qoder:qmodel_38max' })
      expect(host.notifications).toEqual([])
    } finally {
      global.window = previousWindow
    }
  })
})

describe('host owned tier mappings', () => {
  const cases = [
    {
      name: 'shows the host migrated local tier map',
      persisted: '{"high":"local-high","medium":"local-medium","low":"local-low"}',
      expected: { high: 'local-high', medium: 'local-medium', low: 'local-low' },
    },
    { name: 'preserves an explicitly cleared map even when legacy keys exist', persisted: '{}', expected: {} },
    { name: 'does not interpret legacy keys when the host has no tier map', persisted: null, expected: {} },
  ]
  for (const row of cases) {
    test(row.name, async () => {
      const global = globalThis as any
      const previousWindow = global.window
      const reads: string[] = []
      global.window = {
        settingsApi: { kv: {
          get: async (key: string) => {
            reads.push(key)
            return key === 'model_tiers:local' ? row.persisted : 'legacy-model'
          },
          set: async () => { throw new Error('The renderer must not migrate model settings') },
        } },
      }
      try {
        expect(await loadSourceTierMappings('local')).toEqual(row.expected)
        expect(reads).toEqual(['model_tiers:local'])
      } finally {
        global.window = previousWindow
      }
    })
  }
})
