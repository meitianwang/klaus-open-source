import { describe, expect, test } from 'bun:test'
import { createAgentTaskSaveGuard } from './agent-task-save-guard'
import { endResourcesForSession, publishEndResources } from './end-resources'

let historyResponse: (sessionId: string) => Promise<any> = async sessionId => [{ role: 'user', uuid: sessionId, turnId: sessionId, text: 'Saved message' }]
;(globalThis as any).window = { addEventListener: () => {}, klaus: { session: { history: (sessionId: string) => historyResponse(sessionId) } } }
const stream = await import('./stream-store')

describe('loaded conversation retention', () => {
  test('archiving releases cached content while allowing the same session to reopen immediately', async () => {
    const id = 'retention-archived'
    historyResponse = async () => [{ role: 'assistant', text: 'Archived content' }]
    await stream.loadSessionHistory(id)
    publishEndResources(id, [{ turnId: 'turn-a', resources: [{ type: 'website', target: 'http://localhost:3000/' }] }])
    stream.retireSessionStream(id, { deleted: false })
    expect(stream.chatStreamStore.getState().sessions[id]).toBeUndefined()
    expect(endResourcesForSession(id)).toEqual([])
    await stream.loadSessionHistory(id)
    expect(stream.getSessionStream(id).history?.[0].text).toBe('Archived content')
    stream.retireSessionStream(id)
  })
  test('deletion retires child histories and an in-flight history reply cannot recreate its parent', async () => {
    const parent = 'retention-deleted-parent'
    const child = stream.prepareSubagentStream(parent, 'task', { agentId: 'child', status: 'completed', messages: [{ role: 'assistant', text: 'Child answer' }] })
    let finish!: (value: any) => void
    historyResponse = () => new Promise(resolve => { finish = resolve })
    const loading = stream.loadSessionHistory(parent)
    stream.retireSessionStream(parent)
    finish([{ role: 'assistant', text: 'Late reply' }])
    await loading
    stream.ingestChatEvent({ sessionId: parent, type: 'text_delta', text: 'Late delta' })
    stream.ingestChatEvent({ sessionId: parent, type: 'agent_progress', agentId: 'new-child', event: { type: 'text_delta', text: 'Late child' } })
    expect(stream.chatStreamStore.getState().sessions[parent]).toBeUndefined()
    expect(stream.chatStreamStore.getState().sessions[child]).toBeUndefined()
  })

  test('retiring reconstructable resources preserves independently recorded commands and memory references', async () => {
    const { noteCommandReference, noteMemoryWriteReference, renderReferencesPanel } = await import('./overview/context-refs')
    const { overviewDeps, setOverviewDeps } = await import('./overview/shared')
    const id = 'retention-independent-references'
    const previousDeps = overviewDeps()
    const previousDocument = (globalThis as any).document
    const element = (): any => ({
      children: [], listeners: {}, textContent: '', classList: { toggle() {} },
      setAttribute() {}, addEventListener(name: string, action: () => void) { this.listeners[name] = action },
      replaceChildren(...children: any[]) { this.children = children },
      appendChild(child: any) { this.children.push(child) },
    })
    const tabs = element(), body = element()
    let current: string | null = null
    setOverviewDeps({
      currentSessionId: () => current, commandGroupKey: () => 'skills',
      slashCommandDisplayName: () => 'Retained command', specDocuments: () => [],
      subscribeSpecDocuments: () => () => {}, openSpecDocument() {},
    })
    ;(globalThis as any).document = {
      getElementById: (key: string) => key === 'monitor-references-tabs' ? tabs : key === 'monitor-references-body' ? body : null,
      createElement: element,
    }
    try {
      historyResponse = async () => [{ role: 'assistant', text: 'Saved content' }]
      await stream.loadSessionHistory(id)
      noteCommandReference(id, { name: 'retained-command' }, 'sent-command')
      noteMemoryWriteReference(id, 'memory-run', 'memory', ['retained-memory.md'])
      publishEndResources(id, [{ turnId: 'turn-a', resources: [{ type: 'website', target: 'http://localhost:3000/' }] }])
      current = id
      renderReferencesPanel()
      const before = tabs.children.map((child: any) => child.textContent)
      expect(before).toHaveLength(2)
      expect(body.children[0].children[1].textContent).toBe('Retained command')
      current = null
      stream.retireSessionStream(id, { deleted: false })
      expect(endResourcesForSession(id)).toEqual([])
      current = id
      renderReferencesPanel()
      expect(tabs.children.map((child: any) => child.textContent)).toEqual(before)
      expect(body.children[0].children[1].textContent).toBe('Retained command')
      tabs.children[1].listeners.click()
      expect(body.children[0].children[1].textContent).toBe('retained-memory.md')
      tabs.children[0].listeners.click()
    } finally {
      current = null
      stream.retireSessionStream(id)
      setOverviewDeps(previousDeps)
      ;(globalThis as any).document = previousDocument
    }
  })

  test('an acknowledged task family retires together only after every mounted child releases it', async () => {
    const parent = 'retention-task-parent'
    const taskPayload = { messages: [{ role: 'assistant', text: 'Retained child payload' }] }
    const tasks = new Map([[parent, taskPayload]])
    const guard = createAgentTaskSaveGuard<object>()
    const ticket = guard.begin(parent)
    const retired = new Set<string>()
    const unregister = stream.registerSessionRetentionParticipant({
      protected: id => tasks.has(id) && guard.protected(id, tasks.get(id)!),
      retire(id) { retired.add(id); tasks.delete(id); guard.forget(id) },
    })
    historyResponse = async () => [{ role: 'assistant', text: 'Saved parent history' }]
    await stream.loadSessionHistory(parent)
    const child = stream.prepareSubagentStream(parent, 'task', { agentId: 'retained-child', status: 'completed', ...taskPayload })
    const release = stream.retainSessionStream(child)
    const idle = Array.from({ length: 36 }, (_, index) => `retention-task-idle-${index}`)
    for (const id of idle) await stream.loadSessionHistory(id)
    expect(stream.chatStreamStore.getState().sessions[parent]).toBeDefined()
    expect(tasks.get(parent)).toBe(taskPayload)
    expect(guard.complete(ticket, taskPayload)).toBe(true)
    stream.trimSessionStreamCache()
    expect(stream.chatStreamStore.getState().sessions[parent]).toBeDefined()
    release()
    expect(stream.chatStreamStore.getState().sessions[parent]).toBeUndefined()
    expect(stream.chatStreamStore.getState().sessions[child]).toBeUndefined()
    expect(retired.has(parent)).toBe(true)
    expect(retired.has(child)).toBe(true)
    expect(tasks.size).toBe(0)
    unregister()
    for (const id of idle) stream.retireSessionStream(id)
  })

  test('idle histories obey a byte budget while mounted, running and interrupted content stays available', async () => {
    const mounted = 'retention-mounted'
    const running = 'retention-running'
    const interrupted = 'retention-interrupted'
    const release = stream.retainSessionStream(mounted)
    historyResponse = async sessionId => [{ role: 'user', uuid: sessionId, turnId: sessionId, text: 'x'.repeat(900_000) }]
    await stream.loadSessionHistory(mounted)
    stream.ingestChatEvent({ sessionId: running, type: 'session_runtime_status', status: 'active', turnId: 'running-turn' })
    stream.ingestChatEvent({ sessionId: interrupted, type: 'text_delta', text: 'Unsaved answer', turnId: 'stopped-turn' })
    stream.ingestChatEvent({ sessionId: interrupted, type: 'interrupted', turnId: 'stopped-turn' })
    const idle = Array.from({ length: 50 }, (_, index) => `retention-idle-${index}`)
    for (const id of idle) await stream.loadSessionHistory(id)
    const stats = stream.sessionStreamCacheStats()
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes)
    expect(stream.getSessionStream(mounted).history).not.toBeNull()
    expect(stream.getSessionStream(running).running).toBe(true)
    expect(stream.getSessionStream(interrupted).liveUnits.some(unit => unit.type === 'live-text' && unit.text === 'Unsaved answer')).toBe(true)
    expect(stream.chatStreamStore.getState().sessions[idle[0]]).toBeUndefined()
    release()
    for (const id of [...idle, mounted, running, interrupted]) stream.retireSessionStream(id)
  })
})
