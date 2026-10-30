import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPlanningQuestionsController, type PlanningQuestionAcknowledgement, type PlanningQuestionResolution } from './questions-controller'
;(globalThis as any).window ??= { addEventListener() {} }
const { PlanningQuestionsCard } = await import('./questions')
import { planningQuestionsReady, validPlanningQuestions, type PlanningQuestionIdentity, type PlanningQuestionRequest } from './questions-state'

function request(extra: Partial<PlanningQuestionRequest> = {}): PlanningQuestionRequest {
  return {
    sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'tool-1', requestId: 'request-1', status: 'pending', optional: true,
    questions: [
      { id: 'format', header: 'Format', question: 'Which format should be used?', options: [
        { label: 'Document (Recommended)', description: 'A single document is easy to review.' },
        { label: 'Slides', description: 'A visual presentation works well for a meeting.' },
      ] },
      { id: 'audience', header: 'Audience', question: 'Who will read the result?', options: [
        { label: 'Team (Recommended)', description: 'Include implementation details for the team.' },
        { label: 'Customers', description: 'Explain the outcome in plain language.' },
      ] },
    ],
    ...extra,
  }
}

function setup(value = request(), respond?: (identity: PlanningQuestionIdentity, resolution: PlanningQuestionResolution) => Promise<PlanningQuestionAcknowledgement>) {
  const calls: Array<{ identity: PlanningQuestionIdentity; resolution: PlanningQuestionResolution }> = []
  const controller = createPlanningQuestionsController({ request: value, respond: async (identity, resolution) => {
    calls.push({ identity, resolution })
    return respond ? respond(identity, resolution) : { accepted: true }
  } })
  return { controller, calls }
}

function answerAll(controller: ReturnType<typeof createPlanningQuestionsController>) {
  controller.getSnapshot().request.questions.forEach((_question, index) => {
    controller.navigate(index)
    controller.select(0)
  })
}

function render(controller: ReturnType<typeof createPlanningQuestionsController>, active = true, language: 'en' | 'zh' = 'en'): string {
  const previous = (globalThis as any).window
  ;(globalThis as any).window = { ...previous, currentLang: language }
  try { return renderToStaticMarkup(<PlanningQuestionsCard controller={controller} active={active} language={language} />) }
  finally { (globalThis as any).window = previous }
}

describe('structured planning question contract', () => {
  test('accepts one to three questions and two to three mutually exclusive options', () => {
    const value = request()
    expect(validPlanningQuestions(value)).toBe(true)
    expect(validPlanningQuestions(request({ questions: value.questions.slice(0, 1) }))).toBe(true)
    expect(validPlanningQuestions(request({ questions: [...value.questions, { ...value.questions[0], id: 'third' }] }))).toBe(true)
    expect(validPlanningQuestions(request({ questions: [] }))).toBe(false)
    expect(validPlanningQuestions(request({ questions: Array.from({ length: 4 }, (_, index) => ({ ...value.questions[0], id: String(index) })) }))).toBe(false)
    for (const count of [0, 1, 4]) {
      const options = Array.from({ length: count }, (_, index) => ({ label: String(index), description: 'Description' }))
      expect(validPlanningQuestions(request({ questions: [{ ...value.questions[0], options }] }))).toBe(false)
    }
  })

  test('rejects malformed IDs, headers and legacy multi-select or attachment requests without clamping them', () => {
    const value = request()
    expect(validPlanningQuestions(request({ questions: [value.questions[0], value.questions[0]] }))).toBe(false)
    expect(validPlanningQuestions(request({ questions: [{ ...value.questions[0], id: '' }] }))).toBe(false)
    expect(validPlanningQuestions(request({ questions: [{ ...value.questions[0], header: 'Too many characters' }] }))).toBe(false)
    for (const extra of [{ multiSelect: true }, { attachments: [] }]) {
      expect(validPlanningQuestions(request({ questions: [{ ...value.questions[0], ...extra }] }))).toBe(false)
    }
    const { controller } = setup(request({ questions: [{ ...value.questions[0], options: [...value.questions[0].options, ...value.questions[0].options] }] }))
    expect(render(controller)).toContain('role="alert"')
    expect(render(controller)).not.toContain('role="radio"')
  })

  test('uses stable IDs when questions share text, and keeps the answer arrays in the response', async () => {
    const value = request()
    value.questions[1].question = value.questions[0].question
    const { controller, calls } = setup(value)
    controller.select(1)
    controller.navigate(1)
    controller.setOtherText('  A mixed audience  ')
    expect(await controller.submit()).toBe(true)
    expect(calls).toEqual([{ identity: { sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'tool-1', requestId: 'request-1' },
      resolution: { status: 'answered', response: { answers: { format: { answers: ['Slides'] }, audience: { answers: ['A mixed audience'] } } } } }])
  })

  test('malformed recovered question payloads show an error and remain replaceable', () => {
    for (const questions of [undefined, null, [null]]) {
      const invalid = { ...request(), questions } as unknown as PlanningQuestionRequest
      const { controller } = setup(invalid)
      expect(render(controller)).toContain('role="alert"')
      controller.reconcile(request())
      expect(render(controller)).toContain('role="radiogroup"')
      controller.reconcile(invalid)
      expect(render(controller)).toContain('role="alert"')
    }
  })

  test('Other is client supplied and is absent when explicitly disabled', () => {
    const value = request({ questions: request().questions.slice(0, 1) })
    const enabled = setup(value).controller
    expect(render(enabled).match(/role="radio"/g)).toHaveLength(2)
    expect(value.questions[0].options).toHaveLength(2)
    expect(render(enabled)).toContain('<textarea')
    const disabled = setup({ ...value, questions: [{ ...value.questions[0], allowOther: false }] }).controller
    disabled.setOtherText('not allowed')
    expect(render(disabled).match(/role="radio"/g)).toHaveLength(2)
    expect(render(disabled)).not.toContain('<textarea')
    expect(disabled.getSnapshot().draft.answers.format.other).toBe(false)
    const metadata = setup({ ...value, questions: [{ ...value.questions[0], isOther: false }] }).controller
    expect(render(metadata).match(/role="radio"/g)).toHaveLength(2)
  })
})

describe('structured planning question interaction', () => {
  test('controller edits require explicit submission and do not preselect an answer', async () => {
    const { controller, calls } = setup()
    expect(controller.getSnapshot().draft.focusedOption).toBe(0)
    expect(planningQuestionsReady(controller.getSnapshot().request, controller.getSnapshot().draft)).toBe(false)
    expect(await controller.submit()).toBe(false)
    expect(render(controller)).not.toContain('aria-checked="true"')
    controller.select(0)
    expect(controller.getSnapshot().draft.index).toBe(0)
    expect(calls).toHaveLength(0)
    controller.navigate(1)
    controller.select(1)
    expect(calls).toHaveLength(0)
    expect(await controller.submit()).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('navigation retains each selection and Other text without selecting both', () => {
    const { controller } = setup()
    controller.select(0)
    controller.setOtherText('Custom format')
    expect(controller.getSnapshot().draft.answers.format).toEqual({ selected: null, other: true, text: 'Custom format' })
    controller.navigate(1)
    controller.select(1)
    controller.navigate(0)
    expect(render(controller)).toContain('>Custom format</textarea>')
    controller.select(1)
    expect(controller.getSnapshot().draft.answers.format).toEqual({ selected: 'Slides', other: false, text: 'Custom format' })
    expect(render(controller)).toContain('>Custom format</textarea>')
    controller.navigate(-1)
    expect(controller.getSnapshot().draft.index).toBe(0)
  })

  test('blank Other input blocks submission and hidden old text is not submitted', async () => {
    const { controller, calls } = setup(request({ questions: request().questions.slice(0, 1) }))
    controller.setOtherText('   ')
    expect(await controller.submit()).toBe(false)
    controller.setOtherText('Custom format')
    controller.select(1)
    await controller.submit()
    expect(calls[0].resolution.response.answers.format.answers).toEqual(['Slides'])
  })

  test('transport failure retains drafts and a retry can resolve them', async () => {
    let attempts = 0
    const { controller } = setup(request(), async () => {
      if (++attempts === 1) throw new Error('Connection lost')
      return { accepted: true }
    })
    answerAll(controller)
    expect(await controller.submit()).toBe(false)
    expect(controller.getSnapshot().failed).toBe(true)
    expect(controller.getSnapshot().request.status).toBe('pending')
    expect(controller.getSnapshot().draft.answers.format.selected).toBe('Document (Recommended)')
    expect(render(controller)).toContain('Could not send your answers. Your draft is saved.')
    expect(await controller.submit()).toBe(true)
    expect(controller.getSnapshot().request.status).toBe('answered')
  })

  test('a rejected response is not shown as an accepted answer', async () => {
    const { controller } = setup(request(), async () => ({ accepted: false }))
    answerAll(controller)
    expect(await controller.submit()).toBe(false)
    expect(controller.getSnapshot().request.status).toBe('pending')
    expect(render(controller)).toContain('role="alert"')
  })

  test('duplicate clicks share one pending operation and freeze draft mutations', async () => {
    let release!: (value: PlanningQuestionAcknowledgement) => void
    const { controller, calls } = setup(request(), () => new Promise(resolve => { release = resolve }))
    answerAll(controller)
    const pending = controller.submit()
    expect(await controller.submit()).toBe(false)
    controller.select(1)
    controller.setOtherText('Changed while sending')
    controller.navigate(0)
    expect(controller.getSnapshot().draft.index).toBe(1)
    expect(controller.getSnapshot().draft.answers.audience.selected).toBe('Team (Recommended)')
    expect(render(controller)).toContain('aria-busy="true"')
    expect(render(controller)).toContain('Sending…')
    expect(calls).toHaveLength(1)
    release({ accepted: true })
    expect(await pending).toBe(true)
  })
})

describe('structured planning question recovery', () => {
  test('reconnect preserves drafts by question ID when wording and order change', () => {
    const { controller } = setup()
    controller.setOtherText('Custom format')
    controller.navigate(1)
    controller.select(1)
    const recovered = request()
    recovered.questions = recovered.questions.toReversed().map(question => ({ ...question, question: 'Updated wording' }))
    controller.reconcile(recovered)
    expect(controller.getSnapshot().draft.answers.format.text).toBe('Custom format')
    expect(controller.getSnapshot().draft.answers.audience.selected).toBe('Customers')
    expect(controller.getSnapshot().draft.index).toBe(0)
    controller.navigate(1)
    expect(render(controller)).toContain('>Custom format</textarea>')
  })

  test('late acceptance cannot resolve a replacement session, turn, tool call or request', async () => {
    for (const field of ['sessionId', 'turnId', 'toolCallId', 'requestId'] as const) {
      let release!: (value: PlanningQuestionAcknowledgement) => void
      const { controller } = setup(request(), () => new Promise(resolve => { release = resolve }))
      answerAll(controller)
      const pending = controller.submit()
      controller.reconcile(request({ [field]: 'replacement' }))
      expect(controller.getSnapshot().draft.answers.format.selected).toBeNull()
      release({ accepted: true })
      expect(await pending).toBe(false)
      expect(controller.getSnapshot().request.status).toBe('pending')
      expect(controller.getSnapshot().submitting).toBe(false)
    }
  })

  test('an authoritative expiry wins over an in-flight response and cannot be reopened by stale recovery', async () => {
    let release!: (value: PlanningQuestionAcknowledgement) => void
    const { controller } = setup(request({ revision: 2 }), () => new Promise(resolve => { release = resolve }))
    answerAll(controller)
    const pending = controller.submit()
    controller.reconcile(request({ status: 'expired', revision: 3 }))
    release({ accepted: true })
    expect(await pending).toBe(false)
    controller.reconcile(request({ revision: 2 }))
    controller.reconcile(request({ revision: 4 }))
    expect(controller.getSnapshot().request.status).toBe('expired')
    expect(render(controller)).toContain('Expired')
    expect(render(controller)).not.toContain('role="radio"')
  })

  test('an echoed acknowledgement for a different identity cannot resolve this request', async () => {
    const { controller } = setup(request(), async () => ({ accepted: true, identity: request({ turnId: 'other-turn' }) }))
    answerAll(controller)
    expect(await controller.submit()).toBe(false)
    expect(controller.getSnapshot().request.status).toBe('pending')
  })

  test('wording and order changes preserve an in-flight response, while changed answer choices invalidate it', async () => {
    for (const changeChoices of [false, true]) {
      let release!: (value: PlanningQuestionAcknowledgement) => void
      const { controller } = setup(request(), () => new Promise(resolve => { release = resolve }))
      answerAll(controller)
      const pending = controller.submit()
      const recovered = request()
      recovered.questions = recovered.questions.toReversed().map(question => ({ ...question, question: 'Updated wording' }))
      if (changeChoices) recovered.questions[0].options[0].label = 'Different choice'
      controller.reconcile(recovered)
      expect(controller.getSnapshot().submitting).toBe(!changeChoices)
      release({ accepted: true })
      expect(await pending).toBe(!changeChoices)
      expect(controller.getSnapshot().request.status).toBe(changeChoices ? 'pending' : 'answered')
    }
  })

  test('reordered old snapshots are ignored and a same-request reconnect does not unlock submission', async () => {
    let release!: (value: PlanningQuestionAcknowledgement) => void
    const { controller, calls } = setup(request({ revision: 3 }), () => new Promise(resolve => { release = resolve }))
    answerAll(controller)
    const pending = controller.submit()
    controller.reconcile(request({ revision: 2, questions: request().questions.slice(0, 1) }))
    expect(controller.getSnapshot().request.questions).toHaveLength(2)
    controller.reconcile(request({ revision: 4 }))
    expect(controller.getSnapshot().submitting).toBe(true)
    expect(await controller.submit()).toBe(false)
    expect(calls).toHaveLength(1)
    release({ accepted: true })
    expect(await pending).toBe(true)
  })

  test('dispose invalidates pending completions without publishing new state', async () => {
    let release!: (value: PlanningQuestionAcknowledgement) => void
    const { controller } = setup(request(), () => new Promise(resolve => { release = resolve }))
    answerAll(controller)
    const pending = controller.submit()
    let notifications = 0
    controller.subscribe(() => { notifications++ })
    controller.dispose()
    release({ accepted: true })
    expect(await pending).toBe(false)
    expect(notifications).toBe(0)
  })
})

describe('structured planning question presentation', () => {
  test('renders labeled options, descriptions, question navigation and explicit submission', () => {
    const { controller } = setup()
    const html = render(controller)
    expect(html).toContain('aria-label="Previous question"')
    expect(html).toContain('aria-label="Next"')
    expect(html).toContain('1 of 2')
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('Document<span')
    expect(html).toContain('A single document is easy to review.')
    expect(html).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"')
    expect(html).toContain('data-planning-request-id="request-1"')
    expect(html).toContain('data-question-id="format"')
    expect(html).toContain('data-planning-submit=""')
    expect(html).not.toMatch(/\stitle="/)
    expect(html).not.toContain('Attach')
    expect(html).not.toContain('Voice')
    expect(render(controller, false)).not.toContain('aria-keyshortcuts')
    expect(render(controller, false)).toContain('Submit')
  })

  test('distinguishes answered, skipped, cancelled and expired history without live controls', async () => {
    for (const status of ['answered', 'skipped', 'cancelled', 'expired'] as const) {
    const { controller } = setup(request({ status, answers: { format: { answers: ['Slides'] }, audience: { answers: [] } } }))
      const html = render(controller)
      expect(html).toContain(`data-planning-question-status="${status}"`)
      expect(html).toContain(status[0].toUpperCase() + status.slice(1))
      expect(html).toContain('Slides')
      expect(html).not.toContain('<button')
      expect(await controller.submit()).toBe(false)
    }
  })

  test('skip and cancel produce distinct terminal statuses with ID-keyed empty answer arrays', async () => {
    for (const status of ['skipped', 'cancelled'] as const) {
      const { controller, calls } = setup()
      expect(await (status === 'skipped' ? controller.skip() : controller.cancel())).toBe(true)
      expect(controller.getSnapshot().request.status).toBe(status)
      expect(calls[0].resolution).toEqual({ status, response: { answers: { format: { answers: [] }, audience: { answers: [] } } } })
    }
  })

  test('secret Other answers use a password field and are redacted in resolved history', async () => {
    const value = request({ questions: [{ ...request().questions[0], isSecret: true }] })
    const { controller, calls } = setup(value)
    controller.setOtherText('private value')
    expect(render(controller)).toContain('type="password"')
    expect(render(controller)).toContain('aria-label="Private answer"')
    await controller.submit()
    expect(calls[0].resolution.response.answers.format.answers).toEqual(['private value'])
    expect(render(controller)).toContain('Private answer')
    expect(render(controller)).not.toContain('private value')
  })

  test('all controls and resolved states have Chinese equivalents', () => {
    const { controller } = setup()
    expect(render(controller, true, 'zh')).toContain('第 1 / 2 题')
    expect(render(controller, true, 'zh')).toContain('其他')
    expect(render(controller, true, 'zh')).toContain('提交')
    expect(render(controller, true, 'zh')).toContain('关闭提问')
    controller.reconcile(request({ status: 'cancelled' }))
    expect(render(controller, true, 'zh')).toContain('已取消')
  })
})
