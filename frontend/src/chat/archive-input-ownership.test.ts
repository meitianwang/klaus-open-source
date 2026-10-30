import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'

const source = createSourceFile('chat.ts', readFileSync(new URL('./chat.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
const names = ['dropPendingFilesForSession', 'archiveSessionFromMenu']
const declarations = source.statements.filter(node => isFunctionDeclaration(node) && names.includes(node.name?.text || ''))
if (declarations.length !== names.length) throw Error('Missing archive input lifecycle handler')
const script = transpileModule(declarations.map(node => node.getText(source)).join('\n') + '\n({dropPendingFilesForSession,archiveSessionFromMenu})', {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText

function fixture() {
  let finish!: (reply: { ok?: boolean; error?: string }) => void
  const reply = new Promise<{ ok?: boolean; error?: string }>(resolve => { finish = resolve })
  const active = { file: { name: 'active.txt' }, objectUrl: 'blob:active' }, welcome = { file: { name: 'welcome.txt' }, objectUrl: 'blob:welcome' }
  const disposed: unknown[] = [], transitions: unknown[] = [], alerts: unknown[] = []
  const row = { id: 'archiving', title: 'Saved chat', workdir: '/project' }
  const context: any = {
    window: { currentSessionId: 'archiving', klausDialog: { confirm: async () => true, alert: async (message: unknown) => { alerts.push(message) } } },
    pendingFiles: [active], pendingSendAfterUpload: { owner: 'archiving' }, sessionPendingFiles: new Map([[null, [welcome]]]),
    sessions: [row], archivedSessions: [], findKnownSession: () => row, isPlaceholderSessionTitle: () => false,
    klausApi: { session: { archive: () => reply } }, disposeAttachmentObjectUrl: (entry: unknown) => disposed.push(entry),
    normalizeProjectWorkdir: (path: string) => path, tt: (key: string) => key, showToast() {}, renderSessionList() {},
    sessionActionMessageWithProcesses: (message: string) => message, sessionActionErrorText: (error: unknown) => String(error),
    enterNewChatState: (options: unknown) => transitions.push({ owner: context.window.currentSessionId, options }),
  }
  const actions = runInNewContext(script, context)
  context.forgetSessionLocalState = (id: string) => actions.dropPendingFilesForSession(id)
  return { context, actions, active, welcome, disposed, transitions, alerts, finish }
}

test('retiring the current tray disposes live and cached entries once and preserves welcome identity', () => {
  const f = fixture(), cached = { file: { name: 'cached.txt' } }
  f.context.sessionPendingFiles.set('archiving', [f.active, cached])
  f.actions.dropPendingFilesForSession('archiving')
  expect(f.disposed).toEqual([f.active, cached])
  expect(f.context.pendingFiles).toEqual([])
  expect(f.context.pendingSendAfterUpload).toBeNull()
  expect(f.context.sessionPendingFiles.get(null)[0]).toBe(f.welcome)
  expect(f.context.sessionPendingFiles.has('archiving')).toBe(false)
})

test('retiring an inactive tray preserves the current tray and deferred intent', () => {
  const f = fixture(), cached = { file: { name: 'inactive.txt' } }, deferred = f.context.pendingSendAfterUpload
  f.context.sessionPendingFiles.set('inactive', [cached])
  f.actions.dropPendingFilesForSession('inactive')
  expect(f.disposed).toEqual([cached])
  expect(f.context.pendingFiles[0]).toBe(f.active)
  expect(f.context.pendingSendAfterUpload).toBe(deferred)
})

test('successful active archive retains the source identity until the discard-aware transition', async () => {
  const f = fixture(), archive = f.actions.archiveSessionFromMenu('archiving')
  f.finish({ ok: true }); await archive
  expect(f.transitions).toEqual([{ owner: 'archiving', options: { workdir: '/project', discardLeavingDraft: true } }])
  expect(f.context.pendingFiles).toEqual([])
  expect(f.context.sessionPendingFiles.get(null)[0]).toBe(f.welcome)
  expect(f.context.sessions).toEqual([])
  expect(f.context.archivedSessions[0].id).toBe('archiving')
})

test('a late archive result cannot clear or navigate the newer visible owner', async () => {
  const f = fixture(), archive = f.actions.archiveSessionFromMenu('archiving'), newer = { file: { name: 'newer.txt' } }
  await Promise.resolve()
  f.context.sessionPendingFiles.set('archiving', [f.active])
  f.context.window.currentSessionId = 'newer'
  f.context.pendingFiles = [newer]
  const deferred = f.context.pendingSendAfterUpload = { owner: 'newer' }
  f.finish({ ok: true }); await archive
  expect(f.transitions).toEqual([])
  expect(f.context.window.currentSessionId).toBe('newer')
  expect(f.context.pendingFiles[0]).toBe(newer)
  expect(f.context.pendingSendAfterUpload).toBe(deferred)
  expect(f.disposed).toEqual([f.active])
})

test('a refused archive keeps the complete current input and independent welcome tray', async () => {
  const f = fixture(), archive = f.actions.archiveSessionFromMenu('archiving')
  f.finish({ ok: false, error: 'Archive refused' }); await archive
  expect(f.transitions).toEqual([])
  expect(f.context.pendingFiles[0]).toBe(f.active)
  expect(f.context.sessionPendingFiles.get(null)[0]).toBe(f.welcome)
  expect(f.disposed).toEqual([])
  expect(f.alerts).toEqual(['Archive refused'])
})
