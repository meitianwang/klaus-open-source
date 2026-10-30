import { describe, expect, test } from 'bun:test'
import {
  applyBackgroundProcessOutput,
  backgroundProcessShellIdFromToolResult,
  createBackgroundProcessWorkspaceController,
  emptyBackgroundProcessOutput,
  isActiveBackgroundProcess,
  mergeBackgroundProcessEvent,
  normalizeBackgroundProcessSnapshot,
  orderBackgroundProcesses,
} from './background-process-state'

describe('background process snapshots and ordering', () => {
  test('accepts both app-server snapshot envelopes', () => {
    const row = { shellId: 'shell-1', command: 'sleep 10', cwd: '/tmp', status: 'running' }
    expect(normalizeBackgroundProcessSnapshot({ processes: [row] })).toHaveLength(1)
    expect(normalizeBackgroundProcessSnapshot({ backgroundProcesses: { processes: [row] } })).toHaveLength(1)
  })

  test('keeps nonterminal processes first, then oldest start, then stable id', () => {
    const rows = normalizeBackgroundProcessSnapshot({ processes: [
      { shellId: 'done', command: 'done', cwd: '/', status: 'completed', startedAtMs: 1 },
      { shellId: 'z', command: 'z', cwd: '/', status: 'running' },
      { shellId: 'b', command: 'b', cwd: '/', status: 'paused', startedAtMs: 2 },
      { shellId: 'a', command: 'a', cwd: '/', status: 'pending', startedAtMs: 2 },
    ] })
    expect(orderBackgroundProcesses(rows).map(row => row.shellId)).toEqual(['a', 'b', 'z', 'done'])
  })

  test('only pending, running and paused affect sidebar activity', () => {
    const rows = normalizeBackgroundProcessSnapshot({ processes: [
      { shellId: 'pending', command: 'x', cwd: '/', status: 'pending' },
      { shellId: 'running', command: 'x', cwd: '/', status: 'running' },
      { shellId: 'paused', command: 'x', cwd: '/', status: 'paused' },
      { shellId: 'completed', command: 'x', cwd: '/', status: 'completed' },
      { shellId: 'failed', command: 'x', cwd: '/', status: 'failed' },
      { shellId: 'stopped', command: 'x', cwd: '/', status: 'stopped' },
    ] })
    expect(rows.map(isActiveBackgroundProcess)).toEqual([true, true, true, false, false, false])
  })

  test('merges off-screen item events and replaces authoritative snapshots', () => {
    const started = mergeBackgroundProcessEvent([], {
      subtype: 'task_started',
      process: { shellId: 's1', command: 'job', cwd: '/', status: 'running' },
    })
    expect(started[0]?.status).toBe('running')
    const replaced = mergeBackgroundProcessEvent(started, {
      subtype: 'background_tasks_changed',
      processes: [{ shellId: 's1', command: 'job', cwd: '/', status: 'completed' }],
    })
    expect(replaced).toHaveLength(1)
    expect(replaced[0]?.status).toBe('completed')
  })
})

describe('background process output cursor', () => {
  test('appends only forward offsets and ignores duplicate chunks', () => {
    const first = applyBackgroundProcessOutput(emptyBackgroundProcessOutput(), {
      found: true, output: 'hello', afterOffset: 0, nextOffset: 5, droppedBytes: 0, eof: false,
    })
    const duplicate = applyBackgroundProcessOutput(first, {
      found: true, output: 'hello', afterOffset: 0, nextOffset: 5, droppedBytes: 0, eof: false,
    })
    const second = applyBackgroundProcessOutput(duplicate, {
      found: true, output: ' world', afterOffset: 5, nextOffset: 11, droppedBytes: 0, eof: true,
    })
    expect(second).toEqual({ text: 'hello world', cursor: 11, droppedBytes: 0, eof: true })
  })

  test('extracts background ids from Bash and exec_command results without creating process state', () => {
    expect(backgroundProcessShellIdFromToolResult('bash', '{"shellId":"shell-7","status":"running"}')).toBe('shell-7')
    expect(backgroundProcessShellIdFromToolResult('exec_command', '{"sessionId":"process-3","exited":false}')).toBe('process-3')
    expect(backgroundProcessShellIdFromToolResult('exec_command', '[session process-4 still running]')).toBe('process-4')
    expect(backgroundProcessShellIdFromToolResult('read', '{"shellId":"shell-7"}')).toBeNull()
  })
})

describe('background process stop controller', () => {
  test('disables duplicate stops and restores control on failure', async () => {
    const snapshots: any[] = []
    let stopCalls = 0
    const controller = createBackgroundProcessWorkspaceController({
      readOutput: async () => ({ found: true, output: '', afterOffset: 0, nextOffset: 0, eof: false }),
      stop: async () => { stopCalls += 1; throw new Error('permission denied') },
      changed: snapshot => snapshots.push(snapshot),
    })
    controller.open('session-1', 'shell-1')
    const first = controller.requestStop()
    const duplicate = controller.requestStop()
    expect(await duplicate).toBe(false)
    expect(await first).toBe(false)
    expect(stopCalls).toBe(1)
    expect(controller.snapshot().stopping).toBe(false)
    expect(controller.snapshot().error).toBe('permission denied')
    expect(snapshots.some(snapshot => snapshot.stopping === true)).toBe(true)
  })

  test('keeps stopping state after an accepted request until terminal authority arrives', async () => {
    const controller = createBackgroundProcessWorkspaceController({
      readOutput: async () => ({ found: true, output: '', afterOffset: 0, nextOffset: 0, eof: false }),
      stop: async () => ({ found: true, accepted: true }),
      changed: () => {},
    })
    controller.open('session-1', 'shell-1')
    expect(await controller.requestStop()).toBe(true)
    expect(controller.snapshot().stopping).toBe(true)
    controller.terminal()
    expect(controller.snapshot().stopping).toBe(false)
  })
})
