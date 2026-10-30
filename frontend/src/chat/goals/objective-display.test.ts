import { afterAll, beforeAll, expect, test } from 'bun:test'
import { parse } from 'node-html-parser'
import { prepareGoalSubmission } from './preparation'
import { GoalSubmissionReceipts } from './submission'

let previousWindow: any
let transcript: typeof import('../transcript/TranscriptView')
let factories: typeof import('../transcript/factories')
beforeAll(async () => {
  previousWindow = (globalThis as any).window
  ;(globalThis as any).window = { ...previousWindow, addEventListener() {}, currentLang: 'en',
    klaus: { media: { url: (path: string, sessionId: string) => `klaus-media://test/${sessionId}/${encodeURIComponent(path)}` } } }
  transcript = await import('../transcript/TranscriptView')
  factories = await import('../transcript/factories')
})
afterAll(() => { (globalThis as any).window = previousWindow })

test('a materialized goal keeps its canonical reference in the user bubble and Copy action', async () => {
  const authored = 'Private full objective content\n'.repeat(300)
  const reference = 'Read the complete goal objective from this Klaus-owned file: /owned/goal/objective.md'
  const prepared = await prepareGoalSubmission({ receipts: new GoalSubmissionReceipts(() => {}), sessionId: 'chat', serializedIntent: authored,
    target: { expectedGoalId: null, expectedGoalRevision: 0 }, input: { text: authored }, valid: () => true, onReceipt() {},
    prepare: async () => ({ objective: reference, displayText: reference, preparationId: 'owned-preparation' }),
  })
  expect(prepared?.displayText).toBe(reference)
  const message = { role: 'user', uuid: 'goal-objective', text: prepared!.displayText, localRender: { displayText: prepared!.displayText } }
  const bubble = transcript.buildUserBubbleHtml(message, true)!.html
  expect(bubble).toContain('Read the complete goal objective')
  expect(bubble).not.toContain('Private full objective content')
  expect(factories.userCopyText(message, true)).toBe(reference)
  const actions = factories.renderMsgActionsHtml({ ts: 0, copyText: factories.userCopyText(message, true), uuid: message.uuid,
    kind: 'user', archived: false, running: false, readOnly: false })
  expect(actions).toContain(`data-copy-text="${reference}"`)
  expect(actions).not.toContain('Private full objective content')
})

const GOAL_IMAGE_LINE = '![Goal image 1](/Users/fixture/.klaus/goal-objectives/aa/bb/image-1.png)'

test('goal image references render as thumbnails and stay out of prose and clipboard', () => {
  const objective = `Ship the storage page\n\n${GOAL_IMAGE_LINE}`
  for (const local of [true, false]) {
    const message: any = { role: 'user', uuid: `goal-image-${String(local)}`, text: objective, ...(local ? { localRender: { displayText: objective } } : {}) }
    const html = transcript.buildUserBubbleHtml(message, true, 'goal-owner')!.html
    expect(html.match(/<img /g) || []).toHaveLength(1)
    expect(html).toContain('klaus-media://test/goal-owner/')
    expect(html).toContain('data-media-session="goal-owner"')
    const bubble = parse(html).querySelector('.msg.user')
    expect(bubble?.textContent).toContain('Ship the storage page')
    expect(bubble?.textContent).not.toContain('![Goal image')
    expect(bubble?.textContent).not.toContain('/goal-objectives/')
    expect(factories.userCopyText(message, true)).toBe('Ship the storage page')
  }
})

test('remote goal image references keep their URL as the thumbnail source', () => {
  const html = transcript.buildUserBubbleHtml({ role: 'user', uuid: 'goal-remote', text: '![Goal image 1](https://example.com/shot.png)' }, true, 'goal-owner')!.html
  expect(html).toContain('<img src="https://example.com/shot.png"')
  expect(parse(html).querySelector('.msg.user')).toBeNull()
})

test('image-like lines outside the owned goal root stay visible text', () => {
  const text = '![Goal image 1](/tmp/elsewhere/image-1.png)'
  const html = transcript.buildUserBubbleHtml({ role: 'user', uuid: 'goal-foreign', text }, true, 'goal-owner')!.html
  expect(parse(html).querySelector('.msg.user')?.textContent).toContain(text)
  expect(html.match(/<img /g) || []).toHaveLength(0)
})
