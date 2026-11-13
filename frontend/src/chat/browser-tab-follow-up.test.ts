import { restoreComposerDocument, snapshotComposerDocument } from './composer/document-model'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isFunctionDeclaration, isPropertyAssignment, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { browserTabMentionUri, type BrowserTabMention } from '../../../shared/browser-tab-mention'
import { browserTabReference } from './composer/browser-tab-reference'
import { clientMessageId as userMessageClientId } from '../../../contracts/message-identity'
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
  const deliveries: any[] = []
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
    // A steer targets the turn that was running when it was issued; the fixture
    // models one running turn per conversation.
    getSessionStream: (id: string) => ({ activeTurnId: `${id}-turn-a1`, liveTurnId: null, turnStartedAtMs: { [`${id}-turn-a1`]: 111 }, turnStartedAt: undefined, liveUnits: [], history: [] }),
    crypto: { randomUUID },
    userMessageClientId,
    retractLocalUserMessage: (_sessionId: string, identity: string) => {
      const index = rendered.findIndex(entry => entry.options?.uuid === identity)
      if (index >= 0) rendered.splice(index, 1)
    },
    ingestChatEvent: (event: { type?: string }) => {
      if (!event?.type || event.type === 'api_error') throw new Error('Unexpected delivery error')
      deliveries.push(event)
    },
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
    // The optimistic bubble is drawn before the RPC with the locally issued identity;
    // the same identity rides the wire metadata and fences the captured turn.
    const issued = f.calls[0].payload.displayMetadata.clientMessageId
    expect(f.rendered[0].options).toEqual({ uuid: issued, steered: true, targetTurnId: 'conversation-a-turn-a1', targetTurnStartedAt: 111 })
    expect(f.calls[0].payload.displayMetadata.steerMessageId).toBe(issued)
    expect(f.calls[0].payload.displayMetadata.expectedTurnId).toBe('conversation-a-turn-a1')
  })

  test('a queued row restored from disk keeps the same snapshot when sent into a running turn', async () => {
    const f = fixture(), outgoing = payload()
    expect((await f.api.queueFollowUp('conversation-a', outgoing)).status).toBe('queued')
    const restored = JSON.parse(JSON.stringify(f.queued[0]))
    expect(restored.displayMetadata.composerReferences).toEqual(outgoing.composerReferences)
    expect(await f.api.steerFollowUp('conversation-a', restored)).toBe(true)
    // The persisted snapshot survives the disk round trip unchanged; the send adds
    // only the issued identity and its captured-turn fence on top of it.
    const { clientMessageId, steerMessageId, expectedTurnId, ...display } = f.calls[0].payload.displayMetadata
    expect(display).toEqual(restored.displayMetadata)
    expect(clientMessageId).toBe(steerMessageId)
    expect(expectedTurnId).toBe('conversation-a-turn-a1')
    expect(f.calls[0].payload.displayMetadata.composerReferences[0].browserTab.mention).toBe(outgoing.composerReferences[0].browserTab?.mention)
  })

  test('ordinary text follow-ups carry their issued identity and no display extras', async () => {
    const f = fixture()
    const outgoing = { ...payload(), text: 'Continue', displayText: 'Continue', finalText: 'Continue', composerReferences: [] }
    expect(await f.api.steerFollowUp('conversation-a', outgoing)).toBe(true)
    // A plain steer still owns a stable submitted identity end to end; it must not
    // grow display extras the author never attached.
    const metadata = f.calls[0].payload.displayMetadata
    expect(metadata.clientMessageId).toBe(metadata.steerMessageId)
    expect(metadata.expectedTurnId).toBe('conversation-a-turn-a1')
    expect(metadata.composerReferences).toEqual([])
    expect(metadata.pastedCards).toEqual([])
    expect(metadata.selectedTextAttachments).toEqual([])
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
