import { describe, expect, test } from 'bun:test'
import type { LiveUnit, ToolCardState } from '../stream-store'
import type { Unit } from './TranscriptView'

;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'en' }

const { activityEntries, liveActivityEntries } = await import('./TranscriptView')
const { isPetPillOnlyTool } = await import('./chat-activity')

const summaryTool = {
  toolName: 'update_running_summary', toolCallId: 'call-summary', args: { summary: 'Verifying the fix' },
  state: 'done', output: { text: 'Running summary updated.' }, agent: false, activityKind: null,
}
const readTool = {
  toolName: 'read', toolCallId: 'call-read', args: { path: 'apps/desktop/package.json' },
  state: 'done', output: { text: '{}' }, agent: false, activityKind: null,
}
const toolsUnit = (tools: unknown[]): Unit => ({
  type: 'tools', key: 'tools-1', turnId: 'turn-1', segment: { kind: 'tools', tools },
} as unknown as Unit)
const card = (toolName: string, toolCallId: string): ToolCardState => ({
  toolName, status: 'ok', toolCallId, args: { summary: 'Verifying the fix' }, argsDelta: '', progress: [], agent: false, bgTask: false,
})

describe('running summary transcript silence', () => {
  test('the predicate names only the host summary tool', () => {
    expect(isPetPillOnlyTool('update_running_summary')).toBe(true)
    expect(isPetPillOnlyTool('read')).toBe(false)
    expect(isPetPillOnlyTool('mcp__pet__update_running_summary')).toBe(false)
  })
  test('the history projection drops the call and keeps its neighbours', () => {
    expect(activityEntries([toolsUnit([summaryTool])], 'turn-1', false, new Set())).toEqual([])
    const mixed = activityEntries([toolsUnit([summaryTool, readTool])], 'turn-1', false, new Set())
    expect(mixed).toHaveLength(1)
    expect(mixed[0].action?.tool.toolName).toBe('read')
  })
  test('the live projection drops the call and keeps its neighbours', () => {
    const units: LiveUnit[] = [{ type: 'live-tools', key: 'calls', order: ['call-summary', 'call-read'], sealed: false, turnId: 'turn-1' }]
    const entries = liveActivityEntries(units, {
      'call-summary': card('update_running_summary', 'call-summary'),
      'call-read': card('read', 'call-read'),
    }, new Set())
    expect(entries).toHaveLength(1)
    expect(entries[0].key).toBe('call-read')
  })
})
