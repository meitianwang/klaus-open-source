import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { ComposerCatalog, SlashCatalog, StaleSlashCatalogRequest } from './slash-catalog'
import { unpackBuiltinSkillsReply } from '../../pages/skills/builtin-reply'

const source = ts.createSourceFile('chat.ts', readFileSync(new URL('../chat.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ESNext, true)
const names = ['slashCatalogScope', 'invalidateComposerCatalogs', 'fetchSlashCommands', 'loadScopedSlashCommands', 'loadInstalledSlashCommands', 'getComposerSkills']
const declarations = names.map(name => {
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!node) throw new Error(`Missing composer catalog function: ${name}`)
  return node.getText(source)
}).join('\n')

function fixture() {
  const calls = { engine: 0, installed: 0, builtin: 0, requests: [] as Array<{ sessionId: string; options: unknown }> }
  const context = {
    window: { currentSessionId: 'first' }, root: '/project', roots: ['/project'], language: 'en', failEngine: false, failBuiltin: false,
    slashCatalog: new SlashCatalog(), composerSkillCatalog: new ComposerCatalog(), StaleSlashCatalogRequest,
    selectedProjectWorkdir: () => context.root,
    currentEditableWorkspaceId: () => 'workspace', workspaceById: () => ({ roots: context.roots }),
    tt: (key: string) => `${context.language}:${key}`,
    klausApi: {
      engine: { slashCommands: async (sessionId: string, options: unknown) => {
        calls.engine++; calls.requests.push({ sessionId, options })
        if (context.failEngine) throw new Error('Discovery unavailable')
        return [{ name: 'review', source: 'skills', scope: 'project', path: '/project/.klaus/skills/review/SKILL.md' }]
      } },
      skills: {
        list: async () => { calls.installed++; return [{ name: 'global', userEnabled: true }] },
        builtin: async () => { calls.builtin++; return { items: [], error: context.failBuiltin ? 'Builtin unavailable' : null } },
      },
    },
    unpackBuiltinSkillsReply,
    selectComposerSkillRows: (input: unknown) => input,
    withPlanShortcut: (commands: unknown[], label: string) => [...commands, { name: 'plan', displayName: label }],
    withComposerGoalShortcut: (commands: unknown[]) => commands,
    withManualCompactCommand: (commands: unknown[]) => commands,
    isHiddenBuiltinSlashCommand: () => false, isManualCompactCommand: () => false,
    inputEl: { value: '' }, pendingFiles: [], currentSlashTrigger() {}, manualCompactQueryAllowed: () => true,
    ctxPanel: { sessions: { has: () => true } }, cacheSlashCommand() {}, fetchContextStats() {},
  }
  const script = ts.transpileModule(`${declarations}\n({ ${names.join(',')} })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return { context, calls, api: runInNewContext(script, context) as Record<string, (...args: any[]) => any> }
}

test('skills and slash menu consumers share discovery and successful dependency reads', async () => {
  const { api, calls } = fixture()
  await Promise.all([api.fetchSlashCommands({ strict: true }), api.getComposerSkills(), api.getComposerSkills()])
  await api.getComposerSkills()
  expect(calls.engine).toBe(1)
  expect(calls.installed).toBe(1)
  expect(calls.builtin).toBe(1)
})

test('catalog fallback stays outside the cache and empty authoritative results stay empty', async () => {
  const { api, calls, context } = fixture()
  context.failEngine = true
  const error = await api.fetchSlashCommands({ strict: true }).catch((error: Error) => error)
  expect(error.message).toBe('Discovery unavailable')
  expect((await api.fetchSlashCommands()).some((row: any) => row.name === 'global')).toBe(true)
  expect(context.slashCatalog.snapshot(api.slashCatalogScope())).toBeUndefined()
  context.failEngine = false
  context.klausApi.engine.slashCommands = async () => { calls.engine++; return [] }
  await api.fetchSlashCommands({ strict: true })
  await api.fetchSlashCommands({ strict: true })
  expect(calls.engine).toBe(3)
  expect(context.slashCatalog.snapshot(api.slashCatalogScope())).toEqual([])
})

test('partial builtin failures remain retryable and explicit reload reaches discovery', async () => {
  const { api, calls, context } = fixture()
  context.failBuiltin = true
  const error = await api.getComposerSkills().catch((error: Error) => error)
  expect(error.message).toBe('Builtin unavailable')
  expect(context.composerSkillCatalog.snapshot(api.slashCatalogScope())).toBeUndefined()
  context.failBuiltin = false
  await api.getComposerSkills({ forceReload: true })
  expect(calls.installed).toBe(2)
  expect(calls.builtin).toBe(2)
  expect(calls.requests.at(-1)?.options).toMatchObject({ forceReload: true })
})

test('secondary folder changes separate catalogs and cached commands use the current language', async () => {
  const { api, calls, context } = fixture()
  const first = await api.fetchSlashCommands({ strict: true })
  context.language = 'zh'
  const translated = await api.fetchSlashCommands({ strict: true })
  expect(first.at(-1).displayName).toBe('en:composer_plan')
  expect(translated.at(-1).displayName).toBe('zh:composer_plan')
  expect(calls.engine).toBe(1)
  context.roots = ['/project', '/additional']
  await api.fetchSlashCommands({ strict: true })
  expect(calls.engine).toBe(2)
  api.invalidateComposerCatalogs()
  await api.getComposerSkills()
  expect(calls.engine).toBe(3)
})

test('a slash refresh also updates project skill rows without reloading global dependencies', async () => {
  const { api, calls, context } = fixture()
  await api.getComposerSkills()
  context.klausApi.engine.slashCommands = async () => {
    calls.engine++
    return [{ name: 'updated', source: 'skills', scope: 'project', path: '/project/.klaus/skills/updated/SKILL.md' }]
  }
  await api.fetchSlashCommands({ strict: true, forceReload: true })
  const current = await api.getComposerSkills()
  expect(current.projectCommands[0].name).toBe('updated')
  expect(calls.engine).toBe(2)
  expect(calls.installed).toBe(1)
  expect(calls.builtin).toBe(1)
})

test('deferred skill reads retain their original session and reject delivery after navigation', async () => {
  const { api, calls, context } = fixture()
  const pending = api.getComposerSkills()
  context.window.currentSessionId = 'second'
  const error = await pending.catch((error: Error) => error)
  expect(error).toBeInstanceOf(StaleSlashCatalogRequest)
  expect(calls.requests[0]?.sessionId).toBe('first')
})
