import { describe, expect, test } from 'bun:test'
import { prepareComposerSubmission, type SubmissionDraft } from './session-preparation'
import { createComposerDraft } from './slash-draft'
import vectors from '../../../../contracts/vectors/composer-submission-vectors.json'
import { composerDocumentSchema as schema, composerTokenNode, serializeComposerDocument, snapshotComposerDocument } from './document-model'
import type { Node as DocumentNode } from 'prosemirror-model'

function structuredDraft(document: DocumentNode) {
  return createComposerDraft(serializeComposerDocument(document).text, null, null, [], snapshotComposerDocument(document))
}

async function consumeStructuredDraft(before: DocumentNode, after: DocumentNode) {
  let current = { draft: structuredDraft(after), files: [] }
  await prepareComposerSubmission({ snapshot: { draft: structuredDraft(before), files: [] },
    ensureSession: async () => 'session', buildPayload: () => ({}), readDraft: () => current,
    consumeDraft: (_id, remaining) => { current = remaining as typeof current },
    onUnavailable: error => { throw error }, releaseBusy() {} })
  return current.draft
}

test('successful preparation consumes only the unchanged structured prefix and retains appended formatting', async () => {
  const sent = schema.text('sent', [schema.marks.strong.create()])
  const before = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, sent))
  const after = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [sent,
    schema.text(' '), schema.text('new draft', [schema.marks.em.create()])]))
  const remaining = await consumeStructuredDraft(before, after)
  expect(remaining.text).toBe('*new draft*')
  expect(remaining.document?.content.content[0].content[0].marks).toEqual([{ type: 'em' }])
})

test('formatting and quote identity edits during preparation preserve the new complete document', async () => {
  const before = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('same text')))
  const formatted = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('same text', [schema.marks.strong.create()])))
  expect((await consumeStructuredDraft(before, formatted)).document).toEqual(snapshotComposerDocument(formatted))
  const quoteDoc = (id: string) => schema.nodes.doc.create(null, schema.nodes.paragraph.create(null,
    composerTokenNode({ value: '\uFFFC', label: 'Quote', data: { kind: 'selected-text', quoteId: id, text: id } })))
  expect((await consumeStructuredDraft(quoteDoc('first'), quoteDoc('replacement'))).document).toEqual(snapshotComposerDocument(quoteDoc('replacement')))
})

test('a consumed quote is recognized after document transactions reconstruct attachment metadata', async () => {
  const quote = { kind: 'selected-text', quoteId: 'stable-quote', text: 'Selected passage' }
  const inline = composerTokenNode({ value: '\uFFFC', label: 'Quote', data: quote })
  const before = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [inline, schema.text('sent')]))
  const after = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [inline, schema.text('sent new draft')]))
  let current = { draft: structuredDraft(after), files: [{ ...quote }] }
  await prepareComposerSubmission({ snapshot: { draft: structuredDraft(before), files: [quote] },
    ensureSession: async () => 'session', buildPayload: () => ({}), readDraft: () => current,
    consumeDraft: (_id, remaining) => { current = remaining as typeof current },
    onUnavailable: error => { throw error }, releaseBusy() {} })
  expect(current.draft.text).toBe('new draft')
  expect(current.files).toEqual([])
})

function preparationHarness() {
  type Attachment = { name: string; uploadPath: string }
  const image = { name: 'diagram.png', uploadPath: '/uploads/diagram.png' }
  const draft = createComposerDraft('/review this change', { name: 'review' }, { start: 0, end: 7 })
  const snapshot: SubmissionDraft<Attachment> = { draft, files: [image] }
  const drafts = new Map<string | null, SubmissionDraft<Attachment>>([
    [null, { draft, files: [image] }],
    ['another-session', { draft: createComposerDraft('Keep this other draft'), files: [] }],
  ])
  let currentSessionId: string | null = null
  let busy = true
  const running = new Set<string>()
  const errors: unknown[] = []
  const consumed: Array<string | null> = []
  let finish!: (id: string | null) => void
  let reject!: (error: Error) => void
  const session = new Promise<string | null>((resolve, fail) => { finish = resolve; reject = fail })
  const prepare = () => prepareComposerSubmission({
    snapshot,
    ensureSession: () => session,
    buildPayload: (id: string) => ({ id, text: snapshot.draft.text, files: [...snapshot.files] }),
    readDraft: () => drafts.get(null)!,
    consumeDraft: (_id, remaining) => {
      consumed.push(null)
      drafts.set(null, remaining)
    },
    onUnavailable: error => { errors.push(error) },
    releaseBusy: () => { busy = !!currentSessionId && running.has(currentSessionId) },
  })
  return {
    drafts, snapshot, image, errors, consumed, running, finish, reject, prepare,
    getBusy: () => busy,
    switchTo: (id: string | null) => { currentSessionId = id },
  }
}

describe('composer session preparation', () => {
  test('a rejected session creation preserves the text, command selection and attachments', async () => {
    const harness = preparationHarness()
    const preparing = harness.prepare()
    expect(harness.drafts.get(null)).toEqual(harness.snapshot)
    harness.reject(new Error('The selected provider is unavailable'))
    expect(await preparing).toBeNull()
    expect(harness.drafts.get(null)).toEqual(harness.snapshot)
    expect(harness.drafts.get(null)?.files[0]).toBe(harness.image)
    expect(harness.consumed).toEqual([])
    expect(harness.errors).toHaveLength(1)
    expect(harness.getBusy()).toBe(false)
  })

  test('a rejection does not restore an old draft over newly typed text or attachments', async () => {
    const harness = preparationHarness()
    const preparing = harness.prepare()
    const changed = {
      draft: createComposerDraft('My newer draft'),
      files: [{ name: 'new.txt', uploadPath: '/uploads/new.txt' }],
    }
    harness.drafts.set(null, changed)
    harness.reject(new Error('Authentication expired'))
    expect(await preparing).toBeNull()
    expect(harness.drafts.get(null)).toBe(changed)
    expect(harness.consumed).toEqual([])
    expect(harness.getBusy()).toBe(false)
  })

  test('switching conversations keeps both drafts and the new conversation running state', async () => {
    const harness = preparationHarness()
    const otherDraft = harness.drafts.get('another-session')
    const preparing = harness.prepare()
    harness.switchTo('another-session')
    harness.running.add('another-session')
    harness.reject(new Error('No configured provider'))
    expect(await preparing).toBeNull()
    expect(harness.drafts.get(null)).toEqual(harness.snapshot)
    expect(harness.drafts.get('another-session')).toBe(otherDraft)
    expect(harness.getBusy()).toBe(true)
    expect(harness.errors).toHaveLength(1)
  })

  test('a missing session id is a failure that releases busy and preserves the draft', async () => {
    const harness = preparationHarness()
    const preparing = harness.prepare()
    harness.finish(null)
    expect(await preparing).toBeNull()
    expect(harness.drafts.get(null)).toEqual(harness.snapshot)
    expect(harness.getBusy()).toBe(false)
    expect(harness.errors).toHaveLength(1)
  })

  test('only a successful creation consumes an unchanged draft', async () => {
    const harness = preparationHarness()
    const preparing = harness.prepare()
    expect(harness.consumed).toEqual([])
    harness.finish('created-session')
    expect(await preparing).toEqual({
      sessionId: 'created-session',
      payload: { id: 'created-session', text: '/review this change', files: [harness.image] },
    })
    expect(harness.drafts.get(null)).toEqual({ draft: createComposerDraft(''), files: [] })
    expect(harness.errors).toEqual([])
    expect(harness.getBusy()).toBe(true)
  })

  test('success sends the captured content without consuming text typed during creation', async () => {
    const harness = preparationHarness()
    const preparing = harness.prepare()
    const changed = { draft: createComposerDraft('New text'), files: [...harness.snapshot.files] }
    harness.drafts.set(null, changed)
    harness.finish('created-session')
    expect((await preparing)?.payload.text).toBe('/review this change')
    expect(harness.drafts.get(null)).toEqual({ draft: changed.draft, files: [] })
    expect(harness.consumed).toEqual([null])
  })

  test('success preserves attachments added during creation', async () => {
    const harness = preparationHarness()
    const preparing = harness.prepare()
    const changed = {
      draft: harness.snapshot.draft,
      files: [...harness.snapshot.files, { name: 'later.png', uploadPath: '/uploads/later.png' }],
    }
    harness.drafts.set(null, changed)
    harness.finish('created-session')
    expect((await preparing)?.payload.files).toEqual([harness.image])
    expect(harness.drafts.get(null)).toEqual({ draft: createComposerDraft(''), files: [changed.files[1]] })
    expect(harness.consumed).toEqual([null])
  })

  for (const vector of vectors.textChanges) {
    test(`successful preparation consumes only submitted content: ${vector.name}`, async () => {
      const harness = preparationHarness()
      harness.snapshot.draft = createComposerDraft(vector.submitted)
      harness.drafts.set(null, { draft: harness.snapshot.draft, files: [harness.image] })
      const preparing = harness.prepare()
      harness.drafts.set(null, { draft: createComposerDraft(vector.current), files: [harness.image] })
      harness.finish('created-session')
      expect((await preparing)?.payload.text).toBe(vector.submitted)
      expect(harness.drafts.get(null)).toEqual({ draft: createComposerDraft(vector.remaining), files: [] })
    })
  }

  test('a newly added agent reference keeps its range after the submitted prefix is removed', async () => {
    const harness = preparationHarness()
    const preparing = harness.prepare()
    harness.drafts.set(null, {
      draft: createComposerDraft('/review this change @agent-Explore inspect next', { name: 'review' }, { start: 0, end: 7 }),
      files: [harness.image],
    })
    harness.finish('created-session')
    await preparing
    expect(harness.drafts.get(null)).toEqual({ draft: createComposerDraft('@agent-Explore inspect next'), files: [] })
  })

  test('success after navigation consumes only the original stored draft', async () => {
    const harness = preparationHarness()
    const otherDraft = harness.drafts.get('another-session')
    const preparing = harness.prepare()
    harness.switchTo('another-session')
    harness.finish('created-session')
    expect((await preparing)?.sessionId).toBe('created-session')
    expect(harness.drafts.get(null)).toEqual({ draft: createComposerDraft(''), files: [] })
    expect(harness.drafts.get('another-session')).toBe(otherDraft)
  })

  test('busy is released even if error presentation fails', async () => {
    let busy = true
    const failure = await prepareComposerSubmission({
      snapshot: { draft: createComposerDraft('Keep this'), files: [] },
      ensureSession: async () => { throw new Error('Provider unavailable') },
      buildPayload: () => ({}),
      readDraft: () => ({ draft: createComposerDraft('Keep this'), files: [] }),
      consumeDraft: () => { throw new Error('Must not consume a rejected draft') },
      onUnavailable: () => { throw new Error('Presentation failed') },
      releaseBusy: () => { busy = false },
    }).then(() => null, (error: Error) => error)
    expect(failure?.message).toBe('Presentation failed')
    expect(busy).toBe(false)
  })
})
