import { expect, test } from 'bun:test'
import type { VoiceChatSnapshot } from '../voice-chat-controller'
import { voiceChatPresentation } from './presentation'

function fixture() {
  let draft = false, eligible = true, sessionId = 'selected', task = 'Thinking', reads = 0
  const occupied = new Set<string>()
  const snapshot: VoiceChatSnapshot = { open: false, phase: 'inactive', state: null, error: null, notifyError: false,
    microphoneLevel: 0, outputLevel: 0, outputBands: [0, 0, 0, 0] }
  const deps = { currentSession: () => sessionId, inChat: () => true, hasDraft: () => draft, canStart: () => eligible,
    sendButton: { classList: { contains: (name: string) => occupied.has(name) } } as HTMLButtonElement,
    taskStatus: () => { reads++; return task } }
  return { snapshot, deps, occupied, reads: () => reads, draft: (value: boolean) => { draft = value },
    eligible: (value: boolean) => { eligible = value }, select: (value: string) => { sessionId = value }, task: (value: string) => { task = value } }
}

test('idle voice controls keep a stable presentation through unrelated updates and never inspect task content', () => {
  const f = fixture(), before = voiceChatPresentation(f.snapshot, f.deps, true)
  for (let index = 0; index < 1000; index++) expect(voiceChatPresentation({ ...f.snapshot }, f.deps, true).key).toBe(before.key)
  expect(f.reads()).toBe(0)
  expect(before.launch).toBe(true)
  f.draft(true)
  expect(voiceChatPresentation(f.snapshot, f.deps, true).launch).toBe(false)
})

test('availability, conversation and active task changes invalidate the presentation', () => {
  const f = fixture(), before = voiceChatPresentation(f.snapshot, f.deps, true).key
  f.eligible(false)
  expect(voiceChatPresentation(f.snapshot, f.deps, true).key).not.toBe(before)
  f.eligible(true); f.occupied.add('busy')
  expect(voiceChatPresentation(f.snapshot, f.deps, true).launch).toBe(false)
  f.occupied.clear(); f.select('other')
  expect(voiceChatPresentation(f.snapshot, f.deps, true).key).not.toBe(before)
  f.snapshot.open = true; f.snapshot.phase = 'active'; f.snapshot.targetSessionId = 'other'
  const active = voiceChatPresentation(f.snapshot, f.deps, true)
  expect(active.taskStatus).toBe('Thinking')
  f.task('Running a command')
  expect(voiceChatPresentation(f.snapshot, f.deps, true).key).not.toBe(active.key)
})
