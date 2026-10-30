import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { I18N } from '../../i18n/messages'
import type { PendingFileEntry } from '../engine-events'
import { GoalInteractionClock } from './draft-review'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.Latest, true)
const declaration = ast.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'sendMessage')
if (!declaration) throw new Error('Missing composer sendMessage function')
const sendSource = transpileModule(declaration.getText(ast), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

function archivedFixture(text: string, locale: 'en' | 'zh') {
  const draft = { text, references: [{ id: 'saved-reference', label: 'Preserve this reference', start: 0, end: text.length }] }
  const attachments: PendingFileEntry[] = [
    { kind: 'pasted-text', text: 'Complete pasted evidence', uploading: false, file: new File(['Complete pasted evidence'], 'paste.txt', { type: 'text/plain' }) },
    { kind: 'selected-text', text: 'Complete selected evidence', uploading: false, file: new File(['Complete selected evidence'], 'selection.txt', { type: 'text/plain' }) },
    { uploadPath: '/owned/evidence.png', uploading: false, file: new File([new Uint8Array([137, 80, 78, 71])], 'evidence.png', { type: 'image/png' }) },
  ]
  const calls = { model: 0, provider: 0, preparation: 0, goalRead: 0, goalWrite: 0, discard: 0, mode: 0, permission: 0, session: 0, submission: 0, draftMutation: 0 }
  const forbidden = (name: keyof typeof calls) => () => { calls[name]++; throw new Error(`Archived composer attempted ${name}`) }
  const notices: string[] = []
  const clock = new GoalInteractionClock()
  const context = {
    window: { currentSessionId: 'archived-chat' }, goalInteractions: clock,
    findKnownSession: (sessionId: string) => { expect(sessionId).toBe('archived-chat'); return { id: sessionId, archived: true } },
    inputEl: { value: text }, pendingFiles: attachments, composerGoalEnabled: text.startsWith('/goal '),
    composedInputDraft: () => draft,
    showToast: (message: string) => { notices.push(message) }, tt: (key: string) => I18N[locale][key],
    ensureComposerModelConfigured: forbidden('model'), ensureSession: forbidden('session'),
    prepareGoalSubmission: forbidden('preparation'), createGoalFromDraft: forbidden('submission'),
    activateComposerGoalShortcut: forbidden('mode'), activateComposerPlanShortcut: forbidden('mode'),
    clearComposerAfterSubmit: forbidden('draftMutation'), setInputValue: forbidden('draftMutation'),
    klausApi: {
      session: { getCollaborationMode: forbidden('mode'), setCollaborationMode: forbidden('mode'), getPermissionMode: forbidden('permission'), setPermissionMode: forbidden('permission') },
      goal: { get: forbidden('goalRead'), set: forbidden('goalWrite'), prepareObjective: forbidden('preparation'), readObjective: forbidden('goalRead'), discardPreparedObjective: forbidden('discard') },
      chat: { send: forbidden('provider') },
    },
  }
  const send = runInNewContext(`${sendSource}; sendMessage`, context) as () => Promise<void>
  return { context, draft, attachments, calls, notices, clock, send }
}

for (const locale of ['en', 'zh'] as const) for (const text of ['An archived authored message', '/goal', '/goal Finish the saved objective']) {
  test(`the actual archived send entry preserves ${JSON.stringify(text)} and all attachments with its ${locale} notice before any request`, async () => {
    const f = archivedFixture(text, locale)
    const originalDraft = JSON.stringify(f.draft)
    const originalAttachments = [...f.attachments]
    const originalAttachmentContent = f.attachments.map(file => ({ text: file.text, uploadPath: file.uploadPath, file: file.file }))
    const armed = f.context.composerGoalEnabled
    const token = f.clock.token('archived-chat')
    await f.send()
    expect(f.notices).toEqual([I18N[locale].archived_session_read_only])
    expect(f.notices[0]).toBeTruthy()
    expect(f.context.inputEl.value).toBe(text)
    expect(JSON.stringify(f.draft)).toBe(originalDraft)
    expect(f.context.pendingFiles).toBe(f.attachments)
    expect(f.context.pendingFiles).toHaveLength(originalAttachments.length)
    for (const [index, attachment] of originalAttachments.entries()) {
      expect(f.context.pendingFiles[index]).toBe(attachment)
      expect({ text: attachment.text, uploadPath: attachment.uploadPath, file: attachment.file }).toEqual(originalAttachmentContent[index])
    }
    expect(f.context.composerGoalEnabled).toBe(armed)
    expect(f.clock.token('archived-chat')).toBe(token)
    expect(f.calls).toEqual({ model: 0, provider: 0, preparation: 0, goalRead: 0, goalWrite: 0, discard: 0, mode: 0, permission: 0, session: 0, submission: 0, draftMutation: 0 })
  })
}
