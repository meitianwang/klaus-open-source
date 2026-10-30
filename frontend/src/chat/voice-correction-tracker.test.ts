import { expect, test } from 'bun:test'
import { VoiceCorrectionTracker, isVoiceCorrection } from './voice-correction-tracker'

function clock() {
  let now = 0
  const jobs: Array<{ at: number; run(): void; cancelled: boolean }> = []
  return {
    schedule: (run: () => void, delay: number) => { const job = { at: now + delay, run, cancelled: false }; jobs.push(job); return () => { job.cancelled = true } },
    advance: (milliseconds: number) => {
      const end = now + milliseconds
      for (;;) {
        const next = jobs.filter(job => !job.cancelled && job.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = next.at; next.cancelled = true; next.run()
      }
      now = end
    },
  }
}

test('correction tracking starts after insertion and resets its idle deadline after edits', () => {
  const time = clock(), reports: string[] = []
  let value = 'original'
  const tracker = new VoiceCorrectionTracker({ ...time, read: () => value, valid: () => true, finish: value => reports.push(value) })
  tracker.start(); time.advance(200); time.advance(14000)
  value = 'corrected'; tracker.edited(); time.advance(14999)
  expect(reports).toEqual([])
  time.advance(1); expect(reports).toEqual(['corrected'])
  time.advance(30000); expect(reports).toHaveLength(1)
})

test('leaving the original composer completes once while stale contexts never report', () => {
  const time = clock(), reports: string[] = []
  let valid = true
  const tracker = new VoiceCorrectionTracker({ ...time, read: () => 'corrected', valid: () => valid, finish: value => reports.push(value) })
  tracker.start(); time.advance(200); tracker.finish(); tracker.finish(); time.advance(20000)
  expect(reports).toEqual(['corrected'])
  tracker.start(); time.advance(200); valid = false; time.advance(15000)
  expect(reports).toHaveLength(1)
})

test('correction learning filters unchanged voice, unrelated additions and discarded or replaced drafts', () => {
  const spoken = 'Please send the notes to Klaws tomorrow.'
  expect(isVoiceCorrection(spoken, spoken.replace('Klaws', 'Klaus'), [spoken])).toBe(true)
  expect(isVoiceCorrection(spoken, spoken, [spoken])).toBe(false)
  expect(isVoiceCorrection(spoken, spoken + ' A new unrelated task.', [spoken])).toBe(false)
  expect(isVoiceCorrection(spoken, '', [spoken])).toBe(false)
  expect(isVoiceCorrection(spoken, 'An entirely different request with no shared content.', [spoken])).toBe(false)
  expect(isVoiceCorrection('Context. ' + spoken, 'Other context. ' + spoken, [spoken])).toBe(false)
})

test('stopping tracking cancels both delayed activation and an active idle timer', () => {
  const time = clock()
  const tracker = new VoiceCorrectionTracker({ ...time, read: () => 'text', valid: () => true, finish: () => { throw Error('stopped tracker reported') } })
  tracker.start(); tracker.stop(); time.advance(20000)
  tracker.start(); time.advance(200); tracker.stop(); time.advance(20000)
})
