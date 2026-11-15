import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { t } from '../../i18n'

;(globalThis as any).window ??= { addEventListener: () => {} }
const { AskUserQuestionCard, ElicitCard, extractMcpSchemaValues } = await import('./approval-cards')

test('question cards expose recommendations, batch submission, custom answers and keyboard access', () => {
  const html = renderToStaticMarkup(<AskUserQuestionCard req={{ requestId: 'ask-1', responseChannel: 'elicit', attachmentsSupported: true, toolInput: { questions: [
    { question: 'Input?', options: [{ label: 'File' }, { label: 'Stream' }] },
  ] } }} resolved={null} sessionId="session-1" />)
  expect(html).toContain(t('spec_question_recommend'))
  expect(html).toContain(t('question_submit'))
  expect(html).toContain(t('question_other'))
  expect(html).toContain(t('question_attach'))
  expect(html).toContain('type="file" multiple="" hidden=""')
  expect(html).not.toContain(t('question_attachments_unavailable'))
  expect(html).toContain('role="radio" aria-checked="false"')
  expect(html).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"')
})

test('the engine reasoning-over-limit card follows the UI language while answers stay payload-stable', () => {
  const previous = (globalThis as any).window.currentLang
  ;(globalThis as any).window.currentLang = 'zh'
  try {
    const question = 'The model keeps spending its whole output budget on reasoning and returns no answer. Keep retrying, or stop?'
    const req = { requestId: 'rol-1', responseChannel: 'elicit', toolInput: { metadata: { kind: 'reasoning_over_limit' }, questions: [
      { question, options: [
        { label: 'Keep retrying', description: 'Ask again for a shorter reasoning pass and a visible answer.' },
        { label: 'Stop', description: 'End this turn as failed. Nothing visible was produced.' },
      ] },
    ] } }
    const html = renderToStaticMarkup(<AskUserQuestionCard req={req} resolved={null} sessionId="session-1" />)
    expect(html).toContain(t('question_reasoning_over_limit_title'))
    expect(html).toContain(t('question_reasoning_over_limit_retry'))
    expect(html).toContain(t('question_reasoning_over_limit_stop_desc'))
    expect(html).not.toContain('Keep retrying')
    const resolvedHtml = renderToStaticMarkup(<AskUserQuestionCard req={req} resolved={{ mode: 'submitted', answers: { [question]: 'Keep retrying' } }} sessionId="session-1" />)
    expect(resolvedHtml).toContain(t('question_reasoning_over_limit_title'))
    expect(resolvedHtml).toContain(t('question_reasoning_over_limit_retry'))
    expect(resolvedHtml).not.toContain('Keep retrying')
  } finally {
    ;(globalThis as any).window.currentLang = previous
  }
})

test('the engine empty-closing card follows the UI language while answers stay payload-stable', () => {
  const previous = (globalThis as any).window.currentLang
  ;(globalThis as any).window.currentLang = 'zh'
  try {
    const question = 'The model did visible work but never wrote a closing answer, and stayed empty after a retry. Keep retrying, or stop?'
    const req = { requestId: 'ec-1', responseChannel: 'elicit', toolInput: { metadata: { kind: 'empty_closing' }, questions: [
      { question, options: [
        { label: 'Keep retrying', description: 'Ask the model again to write the closing answer or continue with tool calls.' },
        { label: 'Stop', description: 'End this turn as failed. The work done so far stays visible.' },
      ] },
    ] } }
    const html = renderToStaticMarkup(<AskUserQuestionCard req={req} resolved={null} sessionId="session-1" />)
    expect(html).toContain(t('question_empty_closing_title'))
    expect(html).toContain(t('question_empty_closing_retry'))
    expect(html).toContain(t('question_empty_closing_stop_desc'))
    expect(html).not.toContain('Keep retrying')
    const resolvedHtml = renderToStaticMarkup(<AskUserQuestionCard req={req} resolved={{ mode: 'submitted', answers: { [question]: 'Keep retrying' } }} sessionId="session-1" />)
    expect(resolvedHtml).toContain(t('question_empty_closing_title'))
    expect(resolvedHtml).toContain(t('question_empty_closing_retry'))
    expect(resolvedHtml).not.toContain('Keep retrying')
  } finally {
    ;(globalThis as any).window.currentLang = previous
  }
})

test('old engines expose an explicit attachment limitation rather than silently dropping files', () => {
  const html = renderToStaticMarkup(<AskUserQuestionCard req={{ requestId: 'old-engine', responseChannel: 'elicit', toolInput: { questions: [
    { question: 'Input?', options: [{ label: 'File' }, { label: 'Stream' }] },
  ] } }} resolved={null} sessionId="session-1" />)
  expect(html).toContain(t('question_attachments_unavailable'))
})

test('a channel without attachment support shows the notice and no attach button', () => {
  // The permission channel never advertises attachment support, so the icon-only
  // entry beside the answer field is absent rather than rendered disabled, and the
  // explicit notice explains why. Both modes read the same way now.
  const html = renderToStaticMarkup(<AskUserQuestionCard req={{ requestId: 'perm-1', responseChannel: 'permission', toolInput: { questions: [
    { question: 'Input?', options: [{ label: 'File' }, { label: 'Stream' }] },
  ] } }} resolved={null} sessionId="session-1" />)
  expect(html).toContain(t('question_attachments_unavailable'))
  expect(html).not.toContain(`aria-label="${t('question_attach')}"`)
})

test('a resolved multi-question card retains the entire custom answer', () => {
  const html = renderToStaticMarkup(<AskUserQuestionCard req={{ requestId: 'ask-2', toolInput: { questions: [
    { question: 'Outputs?', options: [{ label: 'CSV' }], multiSelect: true },
  ] } }} resolved={{ mode: 'submitted', answers: { 'Outputs?': 'CSV, A table, with precision, and totals' } }} sessionId="session-1" />)
  expect(html).toContain('A table, with precision, and totals')
  expect(html).not.toContain(t('spec_question_recommend'))
  expect(html).not.toContain('data-q-action="primary"')
})

test('native elicitation offers a custom answer even when the model omitted Other', () => {
  const html = renderToStaticMarkup(<ElicitCard req={{ requestId: 'elicit-1', prompt: 'Input?', options: ['File', 'Stream'] }} resolved={null} sessionId="session-1" />)
  expect(html).toContain(t('question_other'))
  expect(html).toContain(t('spec_question_recommend'))
  expect(html).toContain(t('spec_question_continue'))
  expect(html).not.toContain('checked=""')
})

test('MCP schema elicitation retains its existing typed controls and submit actions', () => {
  const html = renderToStaticMarkup(<ElicitCard req={{ requestId: 'mcp-1', type: 'mcp-elicit', requestedSchema: { properties: { count: { type: 'integer' } } } }} resolved={null} sessionId="session-1" />)
  expect(html).toContain('type="number" data-schema-field="count"')
  expect(html).toContain(t('elicit_submit'))
  expect(html).not.toContain(t('spec_question_recommend'))
})

test('MCP url elicitation shows server attribution, highlighted host, browser handoff, and user verdict', () => {
  const html = renderToStaticMarkup(<ElicitCard req={{ requestId: 'mcp-url-1', type: 'mcp-url', serverName: 'calendar', url: 'https://example.com/approve?state=1', prompt: 'Complete authorization' }} resolved={null} sessionId="session-1" />)
  expect(html).toContain('calendar')
  expect(html).toContain('Complete authorization')
  expect(html).toContain('data-elicit-url')
  expect(html).toContain('<strong>example.com</strong>/approve?state=1')
  expect(html).toContain(t('elicit_url_hint'))
  expect(html).toContain(t('elicit_url_open'))
  expect(html).toContain(t('elicit_url_done'))
  expect(html).toContain(t('elicit_skip'))
  expect(html).not.toContain('data-schema-field')
})

test('MCP form and arbitrary JSON-schema elicitations render and extract oneOf, multi-select, nested JSON, and root objects', () => {
  const complexSchema = {
    type: 'object',
    required: ['env', 'scopes', 'filter'],
    properties: {
      env: { type: 'string', title: 'Environment', oneOf: [{ const: 'dev', title: 'Development' }, { const: 'prod', title: 'Production' }] },
      scopes: { type: 'array', title: 'Scopes', items: { anyOf: [{ const: 'read', title: 'Read access' }, { const: 'write', title: 'Write access' }] }, default: ['read'] },
      filter: { type: 'object', title: 'Filter JSON', properties: { tag: { type: 'string' } } },
    },
  }
  const html = renderToStaticMarkup(<ElicitCard req={{ requestId: 'mcp-complex', type: 'mcp-elicit', serverName: 'other', requestedSchema: complexSchema }} resolved={null} sessionId="session-1" />)
  expect(html).toContain('other')
  expect(html).toContain('<option value="dev" selected="">Development</option>')
  expect(html).toContain('data-schema-multiselect="scopes" checked="" value="read"')
  expect(html).toContain('data-schema-json-field="filter"')

  expect(extractMcpSchemaValues(complexSchema, {
    scalars: { env: { value: 'prod' } },
    multiSelects: { scopes: ['read', 'write'] },
    jsonFields: { filter: '{"tag":"urgent"}' },
  })).toEqual({
    ok: true,
    values: { env: 'prod', scopes: ['read', 'write'], filter: { tag: 'urgent' } },
  })
  expect(extractMcpSchemaValues(complexSchema, {
    scalars: { env: { value: 'prod' } },
    multiSelects: { scopes: ['read'] },
    jsonFields: { filter: 'not-json' },
  })).toEqual({ ok: false, kind: 'json', field: 'Filter JSON' })
  expect(extractMcpSchemaValues(complexSchema, {
    scalars: { env: { value: 'prod' } },
    multiSelects: { scopes: [] },
    jsonFields: { filter: '{}' },
  })).toEqual({ ok: false, kind: 'required', field: 'Scopes' })

  const openRoot = renderToStaticMarkup(<ElicitCard req={{ requestId: 'mcp-root', type: 'mcp-elicit', requestedSchema: { type: 'object' } }} resolved={null} sessionId="session-1" />)
  expect(openRoot).toContain('data-schema-json-root="1"')
  expect(extractMcpSchemaValues({ type: 'object' }, { rootJson: '{"custom":42}' })).toEqual({ ok: true, values: { custom: 42 } })
  expect(extractMcpSchemaValues({ type: 'object' }, { rootJson: '[1,2]' })).toEqual({ ok: false, kind: 'json', field: 'JSON' })
})

test('a blocking card gates every submit path on batch readiness, in one place', () => {
  // Enter, the field-row CTA and single-select auto-advance all funnel through
  // advance(); the readiness check lives there so no caller can bypass it. The
  // gated second-row Submit button is a separate, already-gated entry point.
  const source = readFileSync(new URL('./ask-user-question.tsx', import.meta.url), 'utf8')
  expect(source).toContain('questionBatchReady(questions, next) ? -1 : firstUnansweredQuestion(questions, next)')
  // The old unguarded shape submitted the batch straight from the last question.
  expect(source).not.toContain('if (last) { update(next); void respond(next) }')
})
