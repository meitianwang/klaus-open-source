import { describe, expect, test } from 'bun:test'
import { classifyWorktreeAvailability, paintWorktreeAvailability } from './worktree-availability'

const labels = { missing: 'Worktree missing', unavailable: 'Status unavailable', continueInOrigin: 'Use main checkout', retry: 'Retry' }

function elements() {
  const row = { hidden: true } as HTMLElement
  const message = { textContent: '' } as HTMLElement
  const action = { hidden: true, textContent: '' } as HTMLButtonElement
  return { row, message, action }
}

describe('worktree availability', () => {
  test('a removed checkout keeps its origin as an explicit recovery option', () => {
    const status = classifyWorktreeAvailability('chat', { ok: true, state: 'gone', repoRoot: '/repo' })
    expect(status).toEqual({ sessionId: 'chat', state: 'gone', repoRoot: '/repo' })
    const { row, message, action } = elements()
    paintWorktreeAvailability(row, message, action, status, 'chat', labels)
    expect(row.hidden).toBe(false)
    expect(message.textContent).toBe(labels.missing)
    expect(action.hidden).toBe(false)
    expect(action.textContent).toBe(labels.continueInOrigin)
  })
  test('an unknown state is visible but cannot silently switch to a project', () => {
    const status = classifyWorktreeAvailability('chat', { ok: false })
    const { row, message, action } = elements()
    paintWorktreeAvailability(row, message, action, status, 'chat', labels)
    expect(status.state).toBe('unavailable')
    expect(row.hidden).toBe(false)
    expect(message.textContent).toBe(labels.unavailable)
    expect(action.textContent).toBe(labels.retry)
  })
  test('a missing origin offers no misleading recovery button, and other chats see no banner', () => {
    const status = classifyWorktreeAvailability('chat', { ok: true, state: 'gone' })
    const { row, message, action } = elements()
    paintWorktreeAvailability(row, message, action, status, 'chat', labels)
    expect(action.hidden).toBe(true)
    paintWorktreeAvailability(row, message, action, status, 'other', labels)
    expect(row.hidden).toBe(true)
    paintWorktreeAvailability(row, message, action, null, null, labels)
    expect(row.hidden).toBe(true)
  })
  test('an available checkout clears the warning', () => {
    const { row, message, action } = elements()
    paintWorktreeAvailability(row, message, action, classifyWorktreeAvailability('chat', { ok: true, state: 'available' }), 'chat', labels)
    expect(row.hidden).toBe(true)
  })
})
