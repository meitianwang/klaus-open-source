import { restoreComposerDocument, snapshotComposerDocument } from './composer/document-model'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isFunctionDeclaration, isPropertyAssignment, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { browserTabMentionUri, type BrowserTabMention } from '../../../shared/browser-tab-mention'
import { browserTabReference } from './composer/browser-tab-reference'
import { normalizeComposerReferences } from './composer/reference-token'
import { normalizeComposerDraft } from './composer/slash-draft'

// Execute the real composer routes and bridge adapter without booting the app.
// Only host delivery and visual side effects are replaced; metadata stays real.
const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const names = new Set(['sentUserDisplayMetadata', 'steerFollowUp', 'queueFollowUp', 'submitRunningFollowUp', 'noteLocallySentSteer',
  'clientQueueMutationKey', 'persistPendingQueueAdditions', 'forgetPendingQueueAddition'])
const declarations: string[] = []
let queueEditRestore = ''
function collectFunctions(node: any) {
  if (isFunctionDeclaration(node) && names.has(node.name?.text || '')) declarations.push(node.getText(ast))
  if (isPropertyAssignment(node) && node.name.getText(ast) === 'restoreForEdit' && node.initializer.getText(ast).includes('hasDisplayCards')) queueEditRestore = node.initializer.getText(ast)
  forEachChild(node, collectFunctions)
}
collectFunctions(ast)
const transcriptAst = createSourceFile('TranscriptView.tsx', readFileSync(new URL('./transcript/TranscriptView.tsx', import.meta.url), 'utf8'), ScriptTarget.ESNext, true, ScriptKind.TSX)
const restoreMetadataNode = transcriptAst.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'composerDraftFromDisplayMetadata')!
declarations.push(restoreMetadataNode.getText(transcriptAst).replace(/^export /, ''))
const bridgeSource = readFileSync(new URL('../../bridge/klaus-api.ts', import.meta.url), 'utf8')
const bridgeAst = createSourceFile('klaus-api.ts', bridgeSource, ScriptTarget.ESNext, true, ScriptKind.TS)
let followUpBridge = ''
function collectBridge(node: any) {
  if (isPropertyAssignment(node) && node.name.getText(bridgeAst) === 'followUp') followUpBridge = node.initializer.getText(bridgeAst)
  forEachChild(node, collectBridge)
}
collectBridge(bridgeAst)
const script = transpileModule(`const followUpBridge = ${followUpBridge};\n${declarations.join('\n')}\n({ steerFollowUp, queueFollowUp, submitRunningFollowUp, restoreForEdit: ${queueEditRestore} });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

function fixture() {
  const calls: Array<{ channel: string; payload: any }> = []
  const queued: any[] = []
  const rendered: any[] = []
  const restoredDrafts: any[] = []
  const draft = { text: '', references: [] as any[] }
  const context: Record<string, any> = {
    call: async (channel: string, payload: unknown) => { calls.push({ channel, payload }); return { ok: true, messageId: 'steer-a' } },
    followUpModeHelper: { createId: () => 'queued-a', resolveSubmitAction: () => 'steer' },
    composedInputDraft: () => draft,
    normalizeComposerReferences, restoreComposerDocument, snapshotComposerDocument,
    selectedSlashCommand: null, pendingFiles: [], pendingSendAfterUpload: null, hasUploadInFlight: () => false,
    updateInlineQuoteOffsets() {}, addSessionHistory() {}, resetHistoryBrowsing() {}, clearComposerAfterSubmit() {}, updateSendBtn() {},
    takeEditedQueueReinsert: () => ({ afterId: null, beforeId: null }), followUpQueueMode: 'steer',
    // steerFollowUp records the bubble it drew here; the queue bar reads it back.
    locallySentSteerIdsBySession: new Map<string, Set<string>>(),
    setComposerText: (value: unknown) => { restoredDrafts.push(normalizeComposerDraft(value)) },
    restoreDisplayCardsToComposer() {},
    queuedPendingFiles: () => [], renderPreviews() {},
    buildOutgoingPayload: (text: string, _files: unknown[], _command: unknown, _sessionId: string, references: unknown) => ({
      finalText: text, displayText: text, media: [], liveAttachments: [], composerReferences: normalizeComposerReferences(text, references),
    }),
    runClientQueueMutation: async (_session: string, _id: string, mutate: () => Promise<unknown>) => mutate(),
    pendingQueueAdditions: new Map(), persistLocalValue() { return true },
    renderLocalUserPayload: (_session: string, payload: unknown, options: unknown) => rendered.push({ payload, options }),
    ingestChatEvent: () => { throw new Error('Unexpected delivery error') },
    isSideChatSession: () => false,
    window: { currentSessionId: 'conversation-a' }, scrollToBottom() {},
    inputEl: { focus() {} },
    klausApi: { chat: { clientQueueAdd: async (_session: string, _id: string, item: unknown) => { queued.push(item); return { ok: true } } } },
  }
  const adapter = transpileModule(`(${followUpBridge})`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
  context.klausApi.chat.followUp = runInNewContext(adapter, context)
  const api = runInNewContext(script, context) as {
    steerFollowUp(sessionId: string, payload: any): Promise<boolean>
    queueFollowUp(sessionId: string, payload: any): Promise<{ status: string }>
    submitRunningFollowUp(): Promise<void>
    restoreForEdit(item: any): void
  }
  return { api, calls, queued, rendered, draft, restoredDrafts }
}

function payload() {
  const row = { source: 'extension', browserId: 'chrome:profile-a', tabId: '42', title: 'Project notes',
    url: 'https://example.com/notes', browserName: 'Chrome', lastOpened: 123, faviconUrl: 'data:image/png;base64,AAAA' } as BrowserTabMention
  row.mention = browserTabMentionUri(row)
  const reference = browserTabReference(row)
  const text = `Inspect ${reference.value}`
  return { text, displayText: text, finalText: text, media: [], liveAttachments: [], pastedCards: [], selectedTextAttachments: [],
    composerReferences: normalizeComposerReferences(text, [{ ...reference, range: { start: 8, end: 8 + reference.value.length } }]) }
}

describe('browser tab follow-up delivery metadata', () => {
  test('a direct midturn steer delivers the full browser snapshot through the real bridge', async () => {
    const f = fixture(), outgoing = payload()
    expect(await f.api.steerFollowUp('conversation-a', outgoing)).toBe(true)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].channel).toBe('chat:follow-up')
    expect(f.calls[0].payload.sessionId).toBe('conversation-a')
    expect(f.calls[0].payload.text).toBe(outgoing.finalText)
    expect(f.calls[0].payload.displayMetadata.composerReferences).toEqual(outgoing.composerReferences)
    expect(f.calls[0].payload.displayMetadata.composerReferences[0].browserTab.faviconUrl).toBe('data:image/png;base64,AAAA')
    expect(f.rendered[0].payload.composerReferences).toEqual(outgoing.composerReferences)
    expect(f.rendered[0].options).toEqual({ uuid: 'steer-a', steered: true })
  })

  test('a queued row restored from disk keeps the same snapshot when sent into a running turn', async () => {
    const f = fixture(), outgoing = payload()
    expect((await f.api.queueFollowUp('conversation-a', outgoing)).status).toBe('queued')
    const restored = JSON.parse(JSON.stringify(f.queued[0]))
    expect(restored.displayMetadata.composerReferences).toEqual(outgoing.composerReferences)
    expect(await f.api.steerFollowUp('conversation-a', restored)).toBe(true)
    expect(f.calls[0].payload.displayMetadata).toEqual(restored.displayMetadata)
    expect(f.calls[0].payload.displayMetadata.composerReferences[0].browserTab.mention).toBe(outgoing.composerReferences[0].browserTab?.mention)
  })

  test('ordinary text follow-ups preserve the optional metadata contract', async () => {
    const f = fixture()
    const outgoing = { ...payload(), text: 'Continue', displayText: 'Continue', finalText: 'Continue', composerReferences: [] }
    expect(await f.api.steerFollowUp('conversation-a', outgoing)).toBe(true)
    expect(f.calls[0].payload.displayMetadata).toBeUndefined()
  })

  test('submitting a padded draft preserves authored whitespace and browser reference ranges', async () => {
    const f = fixture(), outgoing = payload()
    f.draft.text = ` \n ${outgoing.displayText}  `
    f.draft.references = outgoing.composerReferences.map(reference => ({ ...reference,
      range: { start: reference.range.start + 3, end: reference.range.end + 3 },
    }))
    await f.api.submitRunningFollowUp()
    expect(f.calls[0].payload.text).toBe(f.draft.text)
    expect(f.calls[0].payload.displayMetadata.composerReferences).toEqual(f.draft.references)
  })

  test('editing a queued browser reference restores the chip and never exposes model-only appended context', async () => {
    const f = fixture(), outgoing = payload()
    await f.api.queueFollowUp('conversation-a', outgoing)
    const item = JSON.parse(JSON.stringify(f.queued[0]))
    item.finalText += '\n\nAttached: /tmp/model-only.txt'
    f.api.restoreForEdit(item)
    expect(f.restoredDrafts).toHaveLength(1)
    expect(f.restoredDrafts[0].text).toBe(outgoing.displayText)
    expect(f.restoredDrafts[0].references).toEqual(outgoing.composerReferences)
    expect(f.restoredDrafts[0].references[0].browserTab).toEqual(outgoing.composerReferences[0].browserTab)
  })
})
