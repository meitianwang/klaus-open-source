import { describe, expect, test } from 'bun:test'
import vector from '../../../../contracts/vectors/ask-user-question-vectors.json'
import { chooseQuestionOption, firstUnansweredQuestion, initialQuestionDraft, questionAnswer, questionAnswers, questionAttachments, questionBatchReady, questionResolution, recommendedQuestionDraft, resolvedQuestionPresentation } from './question-state'

const questions = vector.engine.request.questions

describe('structured question answer contract', () => {
  test('recommended choices stage the whole batch for review before submission', () => {
    const draft = recommendedQuestionDraft(questions)
    expect(draft.index).toBe(questions.length - 1)
    expect(draft.answers.map(answer => answer.selected)).toEqual([[0], [0]])
    expect(questionBatchReady(questions, draft)).toBe(true)
    expect(questionAnswers(questions, draft)).toEqual({ 'Which layout?': questions[0].options[0].label, 'Which details?': questions[1].options[0].label })
  })
  test('the first unanswered question drives Enter and batch readiness from one rule', () => {
    const draft = initialQuestionDraft(questions)
    // A single-select question preselects its first option, so only the
    // multi-select one is still waiting on a verdict.
    expect(firstUnansweredQuestion(questions, draft)).toBe(1)
    expect(questionBatchReady(questions, draft)).toBe(false)
    draft.answers[1].text = 'an answer'
    expect(firstUnansweredQuestion(questions, draft)).toBe(-1)
    expect(questionBatchReady(questions, draft)).toBe(true)
    // An explicit skip settles a question the same way an answer does.
    draft.answers[1] = { selected: [], text: '', skipped: true }
    expect(firstUnansweredQuestion(questions, draft)).toBe(-1)
    expect(questionBatchReady(questions, draft)).toBe(true)
    // In-flight uploads gate submission without making a question look unanswered,
    // otherwise Enter would jump away from the question being answered.
    draft.uploading = true
    expect(firstUnansweredQuestion(questions, draft)).toBe(-1)
    expect(questionBatchReady(questions, draft)).toBe(false)
    draft.uploading = false
    draft.readingClipboard = true
    expect(firstUnansweredQuestion(questions, draft)).toBe(-1)
    expect(questionBatchReady(questions, draft)).toBe(false)
    // Selecting a nonexistent option must not read as settled.
    draft.readingClipboard = false
    draft.answers[0] = { selected: [9], text: '' }
    expect(firstUnansweredQuestion(questions, draft)).toBe(0)
  })
  test('batch submission requires an answer or an explicit skip for each question', () => {
    const draft = initialQuestionDraft(questions)
    expect(questionBatchReady(questions, draft)).toBe(false)
    draft.answers[1].text = 'custom answer'
    expect(questionBatchReady(questions, draft)).toBe(true)
    draft.answers[1] = { selected: [], text: '', skipped: true }
    expect(questionBatchReady(questions, draft)).toBe(true)
    expect(questionBatchReady([], { index: 0, answers: [] })).toBe(false)
  })
  test('recommended selection follows visible markers even outside the first option', () => {
    const options = [{ label: 'Plain' }, { label: 'Second (Recommended)' }, { label: 'Third（推荐）' }]
    const draft = recommendedQuestionDraft([
      { question: 'One?', options },
      { question: 'Several?', options, multiSelect: true },
      { question: 'No presets?', options: [] },
    ])
    expect(draft.answers.map(answer => answer.selected)).toEqual([[1], [1, 2], []])
  })
  test('attachment-only answers are ready and retain their question association', () => {
    const draft = initialQuestionDraft(questions)
    draft.answers[1].attachments = vector.attachmentCase.files
    expect(questionBatchReady(questions, draft)).toBe(true)
    draft.uploading = true
    expect(questionBatchReady(questions, draft)).toBe(false)
    draft.uploading = false
    draft.readingClipboard = true
    expect(questionBatchReady(questions, draft)).toBe(false)
    draft.readingClipboard = false
    expect(questionAnswers(questions, draft)[vector.attachmentCase.question]).toBe(vector.attachmentCase.answer)
    expect(questionAttachments(questions, draft)).toEqual({ [vector.attachmentCase.question]: vector.attachmentCase.files })
    const recommended = recommendedQuestionDraft(questions, draft)
    expect(recommended.answers[1].attachments).toEqual(vector.attachmentCase.files)
    draft.answers[1].skipped = true
    expect(questionAttachments(questions, draft)).toEqual({})
    expect(questionAnswers(questions, draft)[vector.attachmentCase.question]).toBeUndefined()
  })
  test('removing the last attachment restores normal answer readiness', () => {
    const draft = initialQuestionDraft(questions)
    draft.answers[1].attachments = vector.attachmentCase.files
    expect(questionBatchReady(questions, draft)).toBe(true)
    draft.answers[1].attachments = []
    expect(questionBatchReady(questions, draft)).toBe(false)
  })
  test('single choice defaults are drafts and multi choice starts empty', () => {
    const draft = initialQuestionDraft(questions)
    expect(draft.answers.map(a => a.selected)).toEqual([[0], []])
    const chosen = chooseQuestionOption(draft, questions, 1)
    expect(questionAnswers(questions, chosen)).toEqual({ 'Which layout?': 'Spacious' })
    expect(draft.answers[0].selected).toEqual([0])
  })
  test('multi choice preserves free text and punctuation without parsing labels', () => {
    const draft = initialQuestionDraft(questions)
    draft.index = 1
    draft.answers[1].text = 'free text, with commas\nand a newline'
    const chosen = chooseQuestionOption(draft, questions, 0)
    expect(questionAnswers(questions, chosen)['Which details?']).toBe(vector.answer.answers['Which details?'])
  })
  test('skipping omits only the current answer', () => {
    const draft = initialQuestionDraft(questions)
    draft.answers[0] = { selected: [], text: '', skipped: true }
    draft.index = 1
    const chosen = chooseQuestionOption(draft, questions, 1)
    expect(questionAnswers(questions, chosen)).toEqual({ 'Which details?': 'C' })
  })
  test('replay retains the full answer rather than splitting commas', () => {
    const block = { input: { questions }, __result: { content: [{ type: 'text', text: JSON.stringify({ questions, answers: vector.answer.answers }) }] } }
    expect(questionResolution(block)).toEqual({ mode: 'submitted', answers: vector.answer.answers })
    expect(questionResolution({ input: { questions } })).toBe(null)
    expect(questionResolution({ ...block, __result: { content: 'User declined to answer.' } })).toEqual({ mode: 'skipped', answers: {} })
  })
  test('resolved presentation keeps interaction identity and one result per question', () => {
    expect(resolvedQuestionPresentation([questions[0]], { mode: 'skipped', answers: {} })).toEqual({
      kind: 'single', rows: [{ index: 1, question: 'Which layout?' }],
    })
    expect(resolvedQuestionPresentation(questions, { mode: 'submitted', answers: vector.answer.answers })).toEqual({
      kind: 'multi',
      rows: [
        { index: 1, question: 'Which layout?', answer: 'Spacious' },
        { index: 2, question: 'Which details?', answer: 'A, B, free text, with commas\nand a newline' },
      ],
    })
  })
})


describe('pending question lifecycle', () => {
  test('drafts stay with their request and cancellation resolves a structured card', async () => {
    if (!(globalThis as any).window) (globalThis as any).window = { addEventListener() {} }
    const { ingestLiveApproval, saveQuestionDraft, ingestChatEvent, chatStreamStore } = await import('../stream-store')
    const sessionId = 'question-lifecycle-test'
    const request = { requestId: 'batch-a', sessionId, responseChannel: 'elicit', toolInput: { questions } }
    ingestLiveApproval('ask', request)
    const draft = initialQuestionDraft(questions)
    draft.index = 1
    draft.answers[1].text = 'keep this draft'
    draft.answers[1].attachments = vector.attachmentCase.files
    saveQuestionDraft(sessionId, request.requestId, draft)
    ingestLiveApproval('ask', { ...request, requestId: 'batch-b' })
    const units = () => chatStreamStore.getState().sessions[sessionId].liveUnits
    expect((units()[0] as any).draft).toEqual(draft)
    expect((units()[1] as any).draft).toBeUndefined()
    ingestChatEvent({ type: 'elicit_cancelled', sessionId, requestId: request.requestId })
    expect((units()[0] as any).resolved).toEqual({ mode: 'skipped', answers: {} })
    expect((units()[1] as any).resolved).toBeNull()
  })
})


test('background questions route to their own store once and survive history loading', async () => {
  if (!(globalThis as any).window) (globalThis as any).window = { addEventListener() {} }
  const { initApprovals, showElicitRequest } = await import('../approvals')
  const { chatStreamStore, loadSessionHistory } = await import('../stream-store')
  initApprovals({
    currentSessionId: () => 'different-session', isCronRunSession: () => false,
    markCronRunUnread() {}, renderSessionList() {},
    pendingPermissionsBySession: new Map(), pendingElicitsBySession: new Map(),
  })
  const request = { requestId: 'background-batch', sessionId: 'background-question-test', responseChannel: 'elicit' as const, toolInput: { questions } }
  showElicitRequest(request)
  showElicitRequest(request)
  await loadSessionHistory(request.sessionId)
  const units = chatStreamStore.getState().sessions[request.sessionId].liveUnits
  expect(units).toHaveLength(1)
  expect(units[0].type).toBe('live-ask')
})

test('history keeps unsupported-client failures visible as tool errors', async () => {
  if (!(globalThis as any).window) (globalThis as any).window = { addEventListener() {} }
  const { segmentsFromBlocks } = await import('./TranscriptView')
  const segments = segmentsFromBlocks([{
    type: 'tool_use', id: 'failed-question', name: 'ask_user', input: { questions },
    __result: { is_error: true, content: [{ type: 'text', text: 'The client did not return structured answers.' }] },
  }], undefined)
  expect(segments[0].kind).toBe('tools')
  expect(segments[0].tools?.[0].state).toBe('error')
})


test('switching to an option retains the custom draft but submits only that option', () => {
  const draft = initialQuestionDraft(questions)
  draft.answers[0] = { selected: [], text: 'My original answer' }
  const selected = chooseQuestionOption(draft, questions, 1)
  expect(selected.answers[0].text).toBe('My original answer')
  expect(questionAnswers(questions, selected)['Which layout?']).toBe('Spacious')
  selected.answers[0].selected = []
  expect(questionAnswers(questions, selected)['Which layout?']).toBe('My original answer')
})

test('skipped question names cannot become inherited object answers during replay', async () => {
  if (!(globalThis as any).window) (globalThis as any).window = { addEventListener() {} }
  const { renderResolvedAskUserCardHtml } = await import('./factories')
  const names = ['toString', 'constructor', '__proto__']
  const batch = names.map(question => ({ ...questions[0], question }))
  const block = { input: { questions: batch }, __result: { content: JSON.stringify({ questions: batch, answers: {} }) } }
  const skipped = questionResolution(block)!
  for (const name of names) expect(questionAnswer(skipped.answers, name)).toBeUndefined()
  const html = renderResolvedAskUserCardHtml(block)!.innerHtml
  expect(html).not.toContain('[native code]')
  expect(html).not.toContain('[object Object]')
  const answered = questionAnswers(batch, initialQuestionDraft(batch))
  for (const name of names) expect(questionAnswer(answered, name)).toBe(batch[0].options[0].label)
})

test('skipped replay uses a question header and renders the skipped status only once', async () => {
  if (!(globalThis as any).window) (globalThis as any).window = { addEventListener() {} }
  const previous = (globalThis as any).window.currentLang
  ;(globalThis as any).window.currentLang = 'en'
  try {
    const { renderResolvedAskUserCardHtml } = await import('./factories')
    const block = { input: { questions: [questions[0]] }, __result: { content: 'User declined to answer.' } }
    const html = renderResolvedAskUserCardHtml(block)!.innerHtml
    expect(html).toContain('Choose')
    expect(html).toContain('Single-select')
    expect(html.match(/Skipped/g)).toHaveLength(1)
    expect(html).not.toContain('Answer sent')
  } finally {
    ;(globalThis as any).window.currentLang = previous
  }
})


test('stable question IDs preserve independent answers and attachments for identical prompts', () => {
  const questions = [
    { id: 'first', question: 'Choose?', options: [{ label: 'One' }] },
    { id: 'second', question: 'Choose?', options: [{ label: 'Two' }] },
  ]
  const draft = initialQuestionDraft(questions)
  expect(questionAnswers(questions, draft)).toEqual({ first: 'One', second: 'Two' })
  const file = { path: '/owned/answer.png', name: 'answer.png', type: 'image/png', size: 8 }
  draft.answers[1].attachments = [file]
  expect(questionAttachments(questions, draft)).toEqual({ second: [file] })
  const summary = resolvedQuestionPresentation(questions, { mode: 'submitted', answers: { first: 'One', second: 'Two' } })
  expect(summary.rows.map(row => row.answer)).toEqual(['One', 'Two'])
  const reworded = [{ ...questions[0], question: 'Updated wording' }, questions[1]]
  expect(resolvedQuestionPresentation(reworded, { mode: 'submitted', answers: { first: 'One', second: 'Two' } }).rows[0].answer).toBe('One')
})
