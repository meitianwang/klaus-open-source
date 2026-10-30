import { describe, expect, test } from 'bun:test'
import { sessionRunningChanges, sidebarSessionWorking } from './session-running-sync'

describe('session running synchronization', () => {
  test('sidebar spinner follows turns and the host registry, never sub-agent activity', () => {
    expect(sidebarSessionWorking({ turnRunning: false, listedWorking: false })).toBe(false)
    expect(sidebarSessionWorking({ turnRunning: true, listedWorking: false })).toBe(true)
    expect(sidebarSessionWorking({ turnRunning: false, listedWorking: true })).toBe(true)
  })
  test('reports an off-screen session settling without an open-session dependency', () => {
    const previous = {
      visible: { running: true },
      background: { running: true },
    }
    const current = {
      visible: { running: true },
      background: { running: false },
    }

    expect(sessionRunningChanges(previous, current)).toEqual([
      { sessionId: 'background', running: false },
    ])
  })

  test('reports independent running edges for concurrent sessions', () => {
    expect(sessionRunningChanges(
      { first: { running: false }, second: { running: true } },
      { first: { running: true }, second: { running: false } },
    )).toEqual([
      { sessionId: 'first', running: true },
      { sessionId: 'second', running: false },
    ])
  })

  test('ignores streamed content updates that do not change running state', () => {
    expect(sessionRunningChanges(
      { task: { running: true } },
      { task: { running: true } },
    )).toEqual([])
  })
})
