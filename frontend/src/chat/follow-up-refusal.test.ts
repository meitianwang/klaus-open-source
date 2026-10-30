import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isFunctionDeclaration, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { createComposerDraft, normalizeComposerDraft } from './composer/slash-draft'

const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const names = new Set(['submitRunningFollowUp', 'sideSubmitRunningFollowUp', 'sideDraftUnchanged', 'retainRefusedFollowUp', 'setEditedQueueReinsert', 'persistEditedQueueReinsert'])
const functions: string[] = []
function collect(node: any) {
  if (isFunctionDeclaration(node) && names.has(node.name?.text || '')) functions.push(node.getText(ast))
  forEachChild(node, collect)
}
collect(ast)
const script = transpileModule(`${functions.join('\n')}\n({ submitRunningFollowUp, sideSubmitRunningFollowUp, retainRefusedFollowUp });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

function fixture() {
  let settle!: (value: boolean) => void
  const delivery = new Promise<boolean>(resolve => { settle = resolve })
  const files = [{ kind: 'image', name: 'evidence.png', path: '/uploads/evidence.png' }]
  const original = createComposerDraft('Keep the original request')
  const payload = { text: original.text, finalText: 'MODEL_INPUT', media: files,
    liveAttachments: files, selectedTextAttachments: [{ fullText: 'Selected source' }], pastedCards: [{ fullText: 'Pasted source' }],
    composerDocument: { version: 1, blocks: [{ type: 'text', text: original.text }] } }
  const anchors = { beforeId: 'later', afterId: 'earlier' }
  const restoredCards: unknown[] = [], recovered: unknown[] = [], saved: unknown[] = []
  const pendingQueueAdditions = new Map()
  const context: any = {
    activeDraft: original, pendingFiles: [...files], pendingSendAfterUpload: null, selectedSlashCommand: null,
    window: { currentSessionId: 'main' }, inputEl: { focus() {} },
    composedInputDraft: () => context.activeDraft, updateInlineQuoteOffsets() {}, hasUploadInFlight: () => false,
    ensureSession: async () => 'main', addSessionHistory() {}, resetHistoryBrowsing() {},
    normalizeComposerReferences: () => [], buildOutgoingPayload: () => payload,
    followUpModeHelper: { resolveSubmitAction: () => 'steer', createId: () => 'retained-message' }, followUpQueueMode: 'steer',
    clearComposerAfterSubmit() { context.activeDraft = createComposerDraft(''); context.pendingFiles = [] }, updateSendBtn() {},
    takeEditedQueueReinsert: () => anchors, editedQueueReinsertBySession: new Map(),
    steerFollowUp: () => delivery,
    queuedPendingFiles: () => [...files],
    setComposerText(value: unknown) { context.activeDraft = normalizeComposerDraft(value) },
    restoreDisplayCardsToComposer(...value: unknown[]) { restoredCards.push(value) }, renderPreviews() {}, autoResize() {},
    sentUserDisplayMetadata: () => ({ displayText: original.text, composerDocument: payload.composerDocument }),
    pendingQueueAdditions, clientQueueMutationKey: (sessionId: string, id: string) => `${sessionId}:${id}`,
    persistPendingQueueAdditions() { saved.push([...pendingQueueAdditions.values()]); return true },
    persistLocalValue() { return true },
    recoverRefusedQueueAddition: async (...value: unknown[]) => { recovered.push(value) },
    sideSurfaceSessionId: 'side', sideInput: { value: original.text }, sidePendingFiles: [...files], sidePendingSendAfterUpload: null,
    sideComposerControl: null, sideSend: { classList: { remove() {} } },
    sideComposedInputDraft: () => normalizeComposerDraft(context.sideInput.value),
    sideComposedInputText: () => context.sideInput.value, ensureComposerModelConfigured: async () => true,
    sideSetComposerDraft(value: unknown) { context.sideInput.value = normalizeComposerDraft(value).text },
    sideRenderPreviews() {}, sideAutoResize() {}, updateSideSendButton() {},
    klausApi: { session: { touchSideTask: async () => {} } }, showToast() {}, tt: (key: string) => key,
  }
  const api = runInNewContext(script, context) as {
    submitRunningFollowUp(): Promise<void>
    sideSubmitRunningFollowUp(id: string, invert: boolean): Promise<void>
    retainRefusedFollowUp(id: string, payload: unknown, anchors: unknown): Promise<void>
  }
  return { context, api, settle, files, original, payload, anchors, restoredCards, recovered, saved, pendingQueueAdditions }
}
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }

test('a definitive main refusal restores the original draft, attachments, cards and former queue position', async () => {
  const f = fixture(), pending = f.api.submitRunningFollowUp()
  expect(f.context.activeDraft.text).toBe('')
  f.settle(false); await pending
  expect(f.context.activeDraft).toEqual(f.original)
  expect(f.context.pendingFiles).toEqual(f.files)
  expect(f.restoredCards).toEqual([[f.payload.selectedTextAttachments, f.payload.pastedCards]])
  expect(f.context.editedQueueReinsertBySession.get('main')).toEqual(f.anchors)
  expect(f.recovered).toEqual([])
})

for (const change of ['draft', 'session'] as const) {
  test(`a main refusal after ${change} changes saves paused recovery without replacing newer input`, async () => {
    const f = fixture(), pending = f.api.submitRunningFollowUp()
    f.context.activeDraft = createComposerDraft('New request')
    f.context.pendingFiles = [{ path: '/uploads/new.pdf' }]
    if (change === 'session') f.context.window.currentSessionId = 'another'
    f.settle(false); await pending
    expect(f.context.activeDraft.text).toBe('New request')
    expect(f.context.pendingFiles).toEqual([{ path: '/uploads/new.pdf' }])
    const row = f.pendingQueueAdditions.get('main:retained-message')
    expect(row.refused).toBe(true)
    expect(row.item.finalText).toBe(f.payload.finalText)
    expect(row.item.media).toEqual(f.files)
    expect(row.item.selectedTextAttachments).toEqual(f.payload.selectedTextAttachments)
    expect(row.item.displayMetadata.composerDocument).toEqual(f.payload.composerDocument)
    expect(f.recovered[0]).toEqual(['main', { id: row.id, item: row.item }, f.anchors])
  })
}

test('a definitive side refusal restores the owning side draft and attachments', async () => {
  const f = fixture(), pending = f.api.sideSubmitRunningFollowUp('side', false)
  await tick(); expect(f.context.sideInput.value).toBe('')
  f.settle(false); await pending
  expect(f.context.sideInput.value).toBe(f.original.text)
  expect(f.context.sidePendingFiles).toEqual(f.files)
  expect(f.context.editedQueueReinsertBySession.get('side')).toEqual(f.anchors)
  expect(f.recovered).toEqual([])
})

for (const change of ['draft', 'tab'] as const) {
  test(`a side refusal after ${change} changes preserves newer input and retains the original request`, async () => {
    const f = fixture(), pending = f.api.sideSubmitRunningFollowUp('side', false)
    await tick()
    f.context.sideInput.value = 'New side request'
    f.context.sidePendingFiles = [{ path: '/uploads/new-side.pdf' }]
    if (change === 'tab') f.context.sideSurfaceSessionId = 'other-side'
    f.settle(false); await pending
    expect(f.context.sideInput.value).toBe('New side request')
    expect(f.context.sidePendingFiles).toEqual([{ path: '/uploads/new-side.pdf' }])
    const row = f.pendingQueueAdditions.get('side:retained-message')
    expect(row.item.finalText).toBe(f.payload.finalText)
    expect(row.refused).toBe(true)
    expect(f.recovered).toHaveLength(1)
  })
}

for (const surface of ['main', 'side'] as const) {
  test(`${surface} accepted or unconfirmed input remains consumed without a second recovery copy`, async () => {
    const f = fixture(), pending = surface === 'main' ? f.api.submitRunningFollowUp() : f.api.sideSubmitRunningFollowUp('side', false)
    await tick(); f.settle(true); await pending
    expect(surface === 'main' ? f.context.activeDraft.text : f.context.sideInput.value).toBe('')
    expect(f.pendingQueueAdditions.size).toBe(0)
    expect(f.recovered).toEqual([])
  })
}
