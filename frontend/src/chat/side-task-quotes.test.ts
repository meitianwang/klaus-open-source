import { mediaInputMime } from '../../../shared/media-input'
import { composerDraftFromControl } from './composer/document-draft'
import { createComposerDraft, normalizeComposerDraft, selectedSlashCommandFromDraft } from './composer/slash-draft'
import { migrateSkillDraft } from './composer/resource-reference'
import { workspaceReferencesIn } from './composer/workspace-reference'
import { referencesFromEditor as documentReferencesFromEditor } from './composer/resource-reference'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isBinaryExpression, isExpressionStatement, isFunctionDeclaration, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import * as inlineQuotes from './composer/inline-quote'
import { configuredAgentReferences, normalizeComposerReferences } from './composer/reference-token'
import { encodeSelectedTextEnvelope, parseSelectedTextEnvelope } from './selected-text-envelope'
import { createGoalSubmissionGate } from './goal-creation'
import { resourceReferenceContext } from './composer/resource-reference'
import { approvalReviewShortcutRange } from './composer/approval-review-shortcut'
import { composerTokenDataWithinDepth } from './composer/document-model'

;(globalThis as any).window = { addEventListener: () => {} }
const { buildUserBubbleHtml } = await import('./transcript/TranscriptView')
const vector = JSON.parse(readFileSync(new URL('../../../contracts/vectors/user-message-display-vectors.json', import.meta.url), 'utf8')).sideTaskQuotes

// Execute the production side-composer entry points without booting the full app.
// Only DOM, upload and host effects are stubbed; payload and transcript code stay real.
const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const functionNames = new Set([
  'inlineQuoteEntries', 'sideInlineQuoteEntries', 'sideComposedInputText', 'sideComposedInputDraft', 'sideSetComposerDraft', 'sideAddSelection',
  'removeSideInlineQuote', 'sideSubmit', 'sideSubmitNow', 'sideDraftUnchanged', 'sideSubmitRunningFollowUp', 'buildOutgoingPayload',
])
const declarations: string[] = []
function collect(node: any) {
  if (isFunctionDeclaration(node) && functionNames.has(node.name?.text || '')) declarations.push(node.getText(ast))
  if (isExpressionStatement(node) && isBinaryExpression(node.expression)
    && node.expression.left.getText(ast) === 'window.klausSideComposerAddSelection') declarations.push(node.getText(ast))
  forEachChild(node, collect)
}
collect(ast)
const entryPoints = transpileModule(`${declarations.join('\n')}\n({ sideSubmit, removeSideInlineQuote });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

type QuoteEntry = inlineQuotes.InlineQuoteToken & { kind: string; quoteId: string }
type Payload = { finalText: string; displayText: string; selectedTextAttachments: QuoteEntry[] }

function fixture(options: { running?: boolean; parentRunning?: boolean; mode?: 'queue' | 'steer'; upload?: boolean } = {}) {
  const submissions: Array<{ route: string; payload: Payload }> = []
  const toasts: string[] = []
  const historySnapshots: string[] = []
  let quoteId = 0
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end },
  }
  const context = {
    composerTokenDataWithinDepth, mediaInputMime,
    referencesFromEditor: documentReferencesFromEditor, composerDraftFromControl, createComposerDraft, normalizeComposerDraft, selectedSlashCommandFromDraft, migrateSkillDraft, workspaceReferencesIn,
    sideSelectedSlashCommand: null, sideSelectedSlashCommandRange: null, sideReferenceTokens: [], sideDiscovery: null, sideBindingRevision: 0, sideHistoryBrowsingIndex: -1, addSessionHistory() {},
    ...inlineQuotes, configuredAgentReferences, normalizeComposerReferences, encodeSelectedTextEnvelope, resourceReferenceContext, approvalReviewShortcutRange,
    sideInput: input, sidePendingFiles: [] as QuoteEntry[], sideLastComposerInputValue: '',
    sideSurfaceSessionId: 'side-quote-fixture', sidePendingSendAfterUpload: null,
    sideSend: { title: '', setAttribute() {}, classList: { add() {}, remove() {} } },
    preparingSubmissions: createGoalSubmissionGate(), updateSideSendButton() {},
    sideComposerControl: {
      revision: 0,
      resetHistory() { historySnapshots.push(input.value) },
      snapshotDocument() { return undefined }, restoreDocument() { return false },
      restoreText(value: string) { input.value = value; this.revision++ },
      replaceRange(start: number, end: number, text: string) {
        if (!text) {
          const entries = context.sidePendingFiles.filter(entry => entry.range)
          const retained = inlineQuotes.replaceInlineTokenRange(start, end, text.length, entries)
          context.sidePendingFiles = context.sidePendingFiles.filter(entry => !retained.removed.includes(entry))
        }
        input.value = input.value.slice(0, start) + text + input.value.slice(end)
        this.revision++
      },
      serializeSubmission() {
        const entries = context.sidePendingFiles.filter(entry => entry.range)
        const composed = inlineQuotes.composeInlineQuotes(input.value, entries, false)
        return { text: composed.text, tokens: composed.quotes.map(quote => ({
          start: quote.requestOffset, end: quote.requestOffset, value: '\uFFFC',
          data: { ...quote, kind: 'selected-text' },
        })) }
      },
    },
    sideRenderPreviews() {}, sideAutoResize() {}, focusComposerInput() {},
    inlineQuotePlaceholder: () => '\uFFFC',
    buildSelectedTextEntry: (text: string) => ({ kind: 'selected-text', text, previewText: text, quoteId: `quote-${++quoteId}` }),
    pastedTextPreview: (text: string) => text,
    window: {
      currentSessionId: 'parent-quote-fixture',
      isSessionRunning: (sid: string) => sid === 'parent-quote-fixture' ? options.parentRunning === true : options.running === true,
      klausSideComposerAddSelection: (_text: string) => {},
    },
    klausApi: { session: { touchSideTask: async () => {} } },
    ensureComposerModelConfigured: async () => true,
    hasUploadInFlight: () => options.upload === true,
    sessionContinueMode: () => false, requestTurnContinue() {}, requestTurnStop() { throw new Error('Unexpected stop') },
    followUpQueueMode: options.mode || 'queue',
    followUpModeHelper: { resolveSubmitAction: (mode: string) => mode },
    takeEditedQueueReinsert: () => null,
    submitTurnPayload: async (_sid: string, payload: Payload) => { submissions.push({ route: 'start', payload }) },
    queueFollowUp: async (_sid: string, payload: Payload) => { submissions.push({ route: 'queue', payload }); return { status: 'queued' } },
    steerFollowUp: async (_sid: string, payload: Payload) => { submissions.push({ route: 'steer', payload }); return true },
    showToast: (text: string) => { toasts.push(text) }, tt: (key: string) => key,
  }
  const api = runInNewContext(entryPoints, context) as {
    sideSubmit: (options?: { replay?: boolean; followUp?: boolean }) => Promise<void>
    removeSideInlineQuote: (entry: QuoteEntry) => void
  }
  return {
    context, input, submissions, toasts, historySnapshots, api, options,
    setText(value: string) { input.value = value; input.setSelectionRange(value.length, value.length); context.sideLastComposerInputValue = value },
    addQuote(text: string, start = input.selectionStart, end = start) {
      input.setSelectionRange(start, end)
      context.window.klausSideComposerAddSelection(text)
    },
  }
}

function assertInlineReplay(payload: Payload) {
  const live = buildUserBubbleHtml({ text: payload.finalText, localRender: payload }, true)?.html || ''
  const replay = buildUserBubbleHtml({ text: payload.finalText }, true)?.html || ''
  expect(live).toContain('<div class="msg user"><button type="button" class="kls-attach-chip is-quote is-inline"')
  expect(live).not.toContain('kls-attach-row')
  expect(replay).toBe(live)
  return live
}

describe('side task quote submission', () => {
  test('sends an unsealed parent sentence as explicit model input while the parent is running', async () => {
    const f = fixture({ parentRunning: true })
    const active = vector.whileParentRunning
    f.setText(active.displayText)
    f.addQuote(active.quoteText, 0)
    expect(f.context.window.isSessionRunning(f.context.window.currentSessionId)).toBe(true)
    await f.api.sideSubmit()
    expect(f.submissions).toHaveLength(1)
    expect(f.submissions[0].route).toBe('start')
    const payload = f.submissions[0].payload
    expect(parseSelectedTextEnvelope(payload.finalText)).toEqual({
      selectedTextAttachments: [{ text: active.quoteText, requestOffset: 0 }],
      message: active.displayText,
    })
    expect(f.context.window.isSessionRunning(f.context.window.currentSessionId)).toBe(true)
    assertInlineReplay(payload)
  })

  for (const route of ['start', 'queue', 'steer'] as const) {
    test(`${route} keeps a leading quote inside the user bubble and preserves history`, async () => {
      const f = fixture({ running: route !== 'start', mode: route === 'steer' ? 'steer' : 'queue' })
      f.setText(vector.displayText)
      f.addQuote(vector.quoteText, vector.requestOffset)
      await f.api.sideSubmit({ followUp: route !== 'start' })
      expect(f.submissions).toHaveLength(1)
      const sent = f.submissions[0]
      expect(sent.route).toBe(route)
      expect(sent.payload.displayText).toBe(vector.displayText)
      expect(sent.payload.selectedTextAttachments[0].requestOffset).toBe(vector.requestOffset)
      expect(sent.payload.selectedTextAttachments[0].displayOrder).toBe(0)
      assertInlineReplay(sent.payload)
      expect(f.input.value).toBe('')
    })
  }

  test('upload replay positions quotes before dispatching the deferred send', async () => {
    const f = fixture({ upload: true })
    f.setText('这是啥')
    f.addQuote('引用', 0)
    await f.api.sideSubmit()
    expect(f.submissions).toHaveLength(0)
    expect(f.input.value).not.toBe('')
    f.options.upload = false
    await f.api.sideSubmit({ replay: true })
    assertInlineReplay(f.submissions[0].payload)
  })

  test('inserting an adjacent quote before an existing one preserves both ranges and display order', async () => {
    const f = fixture()
    f.setText('ab')
    f.addQuote('later', 1)
    f.addQuote('first', 1)
    await f.api.sideSubmit()
    const payload = f.submissions[0].payload
    expect(payload.displayText).toBe('ab')
    const ordered = payload.selectedTextAttachments.slice().sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder))
    expect(ordered.map(quote => quote.text)).toEqual(vector.sameOffset.orderedTexts)
    expect(ordered.map(quote => quote.requestOffset)).toEqual([1, 1])
    const live = buildUserBubbleHtml({ text: payload.finalText, localRender: payload }, true)?.html || ''
    expect(live.indexOf('first')).toBeLessThan(live.indexOf('later'))
    expect(buildUserBubbleHtml({ text: payload.finalText }, true)?.html).toBe(live)
  })

  test('removing an earlier quote keeps the remaining quote attached to its prose', async () => {
    const f = fixture()
    f.setText('ab')
    f.addQuote('first', 0)
    f.addQuote('later', f.input.value.length)
    f.api.removeSideInlineQuote(f.context.sidePendingFiles[0])
    expect(f.historySnapshots).toEqual([])
    await f.api.sideSubmit()
    const payload = f.submissions[0].payload
    expect(payload.displayText).toBe('ab')
    expect(payload.selectedTextAttachments.map(quote => [quote.text, quote.requestOffset])).toEqual([['later', 2]])
  })

  test('replacing a selected quote sends only its replacement', async () => {
    const f = fixture()
    f.setText('ab')
    f.addQuote('old', 1)
    f.addQuote('replacement', 1, 2)
    expect(f.historySnapshots).toEqual([])
    await f.api.sideSubmit()
    const payload = f.submissions[0].payload
    expect(payload.displayText).toBe('ab')
    expect(payload.selectedTextAttachments.map(quote => [quote.text, quote.requestOffset])).toEqual([['replacement', 1]])
    expect(payload.finalText).not.toContain('old')
  })
})
