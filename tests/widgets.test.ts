import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, it as test } from 'node:test'
import { build } from 'esbuild'
import { MediaFiles } from '../main/services/media-files'
import { DynamicTools } from '../main/sessions/dynamic-tools'
import { ChannelRegistry } from '../main/ipc/registry'
import { registerFileHandlers } from '../main/ipc/handlers/files'
import { WorkspaceStore } from '../main/services/workspaces'
import { blocksWidgetFrameNavigation } from '../main/app/widget-navigation'
import { SHOW_WIDGET_TOOL_SPEC, WidgetService, type WidgetSnapshot } from '../main/services/widgets'
const { assertElectronGuiAvailable, spawnElectronGui } = require('../../scripts/electron-test-preflight.cjs') as typeof import('../scripts/electron-test-preflight.cjs');

const sessionId = 'session-12345678'
const otherSession = 'session-87654321'
function result(value: unknown): WidgetSnapshot {
  const response = value as { success: boolean; contentItems: Array<{ text: string }> }
  assert.equal(response.success, true)
  return JSON.parse(response.contentItems[0]!.text) as WidgetSnapshot
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), `klaus-widget-${randomUUID()}-`))
  const workdir = join(root, 'project')
  await mkdir(join(workdir, '.klaus', 'widgets'), { recursive: true })
  const service = new WidgetService(root, () => workdir)
  const media = new MediaFiles(async (path, id) => { try { return path.startsWith(await realpath(join(root, 'widgets', id)) + sep) } catch { return false } })
  return { root, workdir, service, media, close: async () => { media.close(); await rm(root, { recursive: true, force: true }) } }
}

describe('show_widget snapshots and restricted media', () => {
  test('widget frames cannot navigate themselves to a network URL', () => {
    assert.equal(blocksWidgetFrameNavigation('klaus-media://widget/token/file.html', 'klaus-media://widget/token/file.html'), true)
    assert.equal(blocksWidgetFrameNavigation(null, 'klaus-media://widget/token/file.html'), true)
    assert.equal(blocksWidgetFrameNavigation('klaus-app://app', 'klaus-media://widget/token/file.html'), false)
    assert.equal(blocksWidgetFrameNavigation('klaus-media://preview/token/file.html', 'klaus-media://preview/token/file.html'), false)
  })

  test('the named dynamic tool binds the engine call ID to its snapshot', async () => {
    const f = await fixture()
    try {
      const resolved: Array<{ method: string; params: any }> = []
      const dynamic = new DynamicTools({
        request: async (method, params) => { resolved.push({ method, params }); return {} },
        knownSession: id => id === sessionId,
        log: () => {},
      })
      dynamic.register(SHOW_WIDGET_TOOL_SPEC, (args, id, _signal, callId) => f.service.run(args, id, callId))
      dynamic.receive({ type: 'sessionEvent', params: { sessionId, event: { dynamicToolCall: {
        tool: 'show_widget', callId: 'engine-call-1', turnId: 'turn-1',
        arguments: { title: 'Dynamic', widget_code: '<p>Live</p>' },
      } } } } as any)
      for (let attempt = 0; attempt < 100 && !resolved.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(resolved.length, 1)
      assert.equal(resolved[0]!.method, 'session/resolveDynamicToolCall')
      assert.equal(resolved[0]!.params.callId, 'engine-call-1')
      assert.equal(result(resolved[0]!.params.response).toolCallId, 'engine-call-1')
      await dynamic.close()
    } finally { await f.close() }
  })

  test('registers a real host tool and makes immutable session/revision snapshots', async () => {
    const f = await fixture()
    try {
      assert.equal((SHOW_WIDGET_TOOL_SPEC as { name: string }).name, 'show_widget')
      const first = result(await f.service.run({ title: 'Counter', mode: 'replace', widget_code: '<button>One</button>', data: { label: '</script><script>steal()</script>' } }, sessionId, 'call-1'))
      assert.equal(first.kind, 'klaus-widget')
      assert.equal(first.revision, 1)
      assert.equal(first.sessionId, sessionId)
      assert.equal(first.toolCallId, 'call-1')
      const initial = await readFile(first.path, 'utf8')
      assert.match(initial, /window\.sendToAgent=/)
      assert.match(initial, /\\u003c\/script\\u003e/)
      assert(!initial.includes('</script><script>steal()'))
      assert.equal(result(await f.service.run({ title: 'Counter', widget_code: '<p>Different</p>' }, sessionId, 'call-1')).path, first.path)
      const second = result(await f.service.run({ title: 'Counter', mode: 'patch', old_html: 'One', new_html: 'Two' }, sessionId, 'call-2'))
      assert.equal(second.revision, 2)
      assert.notEqual(second.path, first.path)
      assert.match(await readFile(second.path, 'utf8'), /<button>Two<\/button>/)
      assert.equal(await readFile(first.path, 'utf8'), initial)
      assert.deepEqual(await f.service.snapshotPath(sessionId, first.widgetId, first.revision, first.path), { path: first.path, root: await realpath(join(f.root, 'widgets', sessionId)), currentRevision: 2 })
      await assert.rejects(f.service.snapshotPath(otherSession, first.widgetId, first.revision, first.path))
      await assert.rejects(f.service.snapshotPath(sessionId, first.widgetId, 2, first.path))
      await assert.rejects(f.service.snapshotPath(sessionId, '0'.repeat(64), first.revision, first.path))
    } finally { await f.close() }
  })

  test('path templates and patches reject escapes, ambiguity, oversized JSON and invalid input', async () => {
    const f = await fixture()
    try {
      const allowed = join(f.workdir, '.klaus', 'widgets', 'template.html')
      const outside = join(f.root, 'outside.html')
      await writeFile(allowed, '<h1>Safe</h1>')
      await writeFile(outside, '<h1>Outside</h1>')
      await symlink(outside, join(f.workdir, '.klaus', 'widgets', 'escape.html'))
      const fromFile = result(await f.service.run({ title: 'Template', widget_path: allowed }, sessionId, 'path-1'))
      assert.match(await readFile(fromFile.path, 'utf8'), /<h1>Safe<\/h1>/)
      const skillTemplate = join(f.root, 'skills', 'guide', 'widget.html')
      await mkdir(join(f.root, 'skills', 'guide'), { recursive: true })
      await writeFile(skillTemplate, '<p>Skill widget</p>')
      const fromSkill = result(await f.service.run({ title: 'Skill', widget_path: skillTemplate }, sessionId, 'path-skill'))
      assert.match(await readFile(fromSkill.path, 'utf8'), /Skill widget/)
      await assert.rejects(f.service.run({ title: 'Outside', widget_path: outside }, sessionId, 'bad-1'))
      await assert.rejects(f.service.run({ title: 'Outside', widget_path: join(f.workdir, '.klaus', 'widgets', 'escape.html') }, sessionId, 'bad-2'))
      await assert.rejects(f.service.run({ title: 'Both', widget_path: allowed, widget_code: '<b>Both</b>' }, sessionId, 'bad-3'))
      await assert.rejects(f.service.run({ title: 'None', mode: 'patch', old_html: 'a', new_html: 'b' }, sessionId, 'bad-4'))
      await assert.rejects(f.service.run({ title: 'Large', widget_code: '<p>x</p>', data: { value: 'x'.repeat(17 * 1024) } }, sessionId, 'bad-5'))
      await assert.rejects(f.service.run({ title: 'Template', mode: 'patch', old_html: 'missing', new_html: 'b' }, sessionId, 'bad-6'))
      result(await f.service.run({ title: 'Repeated', widget_code: '<b>same</b><b>same</b>' }, sessionId, 'repeat-1'))
      await assert.rejects(f.service.run({ title: 'Repeated', mode: 'patch', old_html: 'same', new_html: 'other' }, sessionId, 'repeat-2'))
    } finally { await f.close() }
  })

  test('widget capability is exact-file and uses a separate restrictive CSP', async () => {
    const f = await fixture()
    try {
      const snapshot = result(await f.service.run({ title: 'Form', widget_code: '<form><input><button>Go</button></form>' }, sessionId, 'form-1'))
      const validated = await f.service.snapshotPath(sessionId, snapshot.widgetId, snapshot.revision, snapshot.path)
      const url = await f.media.grantWidgetSnapshot(validated.path, sessionId, validated.root)
      assert(url.startsWith('klaus-media://widget/'))
      const response = await f.media.respond(new Request(url, { headers: { origin: 'klaus-app://app' } }))
      assert.equal(response.status, 200)
      const csp = response.headers.get('content-security-policy') || ''
      assert.match(csp, /sandbox allow-scripts allow-forms/)
      assert.match(csp, /connect-src 'none'/)
      assert.match(csp, /form-action 'none'/)
      assert(!csp.includes('allow-same-origin'))
      assert.match(await response.text(), /window\.sendToAgent/)
      assert.equal((await f.media.respond(new Request(url.replace(/\.html$/, '.source')))).status, 404)
      assert.equal((await f.media.respond(new Request(url, { headers: { origin: 'https://attacker.example' } }))).status, 403)
      assert.equal((await f.media.respond(new Request(url, { method: 'POST' }))).status, 405)
      const other = result(await f.service.run({ title: 'Other', widget_code: '<p>other</p>' }, sessionId, 'form-2'))
      assert.equal((await f.media.respond(new Request(url.replace(/[^/]+\.html$/, other.path.split('/').at(-1)!)))).status, 404)
      await writeFile(snapshot.path, '<script>modified()</script>')
      await assert.rejects(f.service.snapshotPath(sessionId, snapshot.widgetId, snapshot.revision, snapshot.path))
      assert.equal((await f.media.respond(new Request(url))).status, 403)
      f.media.revokeSession(sessionId)
      assert.equal((await f.media.respond(new Request(url))).status, 404)
    } finally { await f.close() }
  })

  test('the renderer receives only a checked session-scoped capability and current revision', async () => {
    const f = await fixture()
    try {
      const first = result(await f.service.run({ title: 'Versioned', widget_code: '<p>one</p>' }, sessionId, 'route-1'))
      result(await f.service.run({ title: 'Versioned', mode: 'patch', old_html: 'one', new_html: 'two' }, sessionId, 'route-2'))
      const workspaces = new WorkspaceStore({ configRoot: f.root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null })
      workspaces.bindSession(sessionId, { workdir: f.workdir })
      workspaces.bindSession(otherSession, { workdir: f.workdir })
      const registry = new ChannelRegistry()
      const files = registerFileHandlers(registry, {
        workspaces, watch: false, push: () => {}, openPath: async () => {}, revealPath: () => {}, trashPath: async () => {},
        requestSession: async () => ({}), openPreviewWindow: async () => {},
        widgetSnapshot: (id, widgetId, revision, path) => f.service.snapshotPath(id, widgetId, revision, path),
        toWidgetUrl: (path, id, scopeRoot) => f.media.grantWidgetSnapshot(path, id, scopeRoot),
      })
      const invoke = (channel: string, payload: Record<string, string | number>) => registry.lookup(channel)!({
        channel, args: [payload], senderId: 1, role: 'main',
      }) as Promise<Record<string, unknown>>
      try {
        const payload = { sessionId, widgetId: first.widgetId, revision: 1, filePath: first.path }
        const url = await invoke('artifacts:widget-url', payload)
        assert.equal(url.ok, true)
        assert.equal(url.currentRevision, 2)
        assert(String(url.url).startsWith('klaus-media://widget/'))
        assert.equal((await invoke('artifacts:widget-url', { ...payload, sessionId: otherSession })).ok, undefined)
        assert.equal((await invoke('artifacts:widget-url', { ...payload, revision: 2 })).ok, undefined)
        assert.equal((await invoke('artifacts:file-url', { sessionId, filePath: first.path })).ok, undefined)
      } finally { files.close() }
    } finally { await f.close() }
  })

  test('the real sandboxed iframe returns through the tool card and confirms before sending', async () => {
    assertElectronGuiAvailable();
    const assets = await mkdtemp(join(tmpdir(), 'klaus-widget-dom-'))
    const profile = await mkdtemp(join(tmpdir(), 'klaus-widget-profile-'))
    try {
      const desktopRoot = resolve(__dirname, '../..')
      await build({
        entryPoints: [join(desktopRoot, 'frontend/src/chat/transcript/widget-dom-entry.ts')],
        outfile: join(assets, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
        loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent',
      })
      const env: NodeJS.ProcessEnv = { ...process.env, KLAUS_WIDGET_DOM_ASSETS: assets, KLAUS_WIDGET_DOM_PROFILE: profile }
      delete env.ELECTRON_RUN_AS_NODE
      const executable = require('electron') as string
      const child = spawnElectronGui(executable, [join(__dirname, 'widget-dom-fixture.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', bytes => { stdout += String(bytes) })
      child.stderr.on('data', bytes => { stderr += String(bytes) })
      const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
        child.once('error', fail)
        child.once('close', (code, signal) => done({ code, signal }))
      })
      clearTimeout(timer)
      assert.equal(signal, null, stderr)
      assert.equal(code, 0, `${stdout}\n${stderr}`)
      const marker = stdout.split('\n').find(line => line.startsWith('WIDGET_DOM_RESULT='))
      assert(marker, `Missing Widget DOM result: ${stdout}\n${stderr}`)
      process.stdout.write(`${marker}\n`)
      const checks = JSON.parse(marker.slice('WIDGET_DOM_RESULT='.length)) as Record<string, boolean>
      assert.equal(Object.keys(checks).length, 7)
      assert(Object.values(checks).every(Boolean), JSON.stringify(checks))
    } finally {
      await rm(assets, { recursive: true, force: true })
      await rm(profile, { recursive: true, force: true })
    }
  })

  test('the complete chat sends an approved Widget and queues one while running', async () => {
    assertElectronGuiAvailable();
    const assets = await mkdtemp(join(tmpdir(), 'klaus-widget-chat-dom-'))
    const profile = await mkdtemp(join(tmpdir(), 'klaus-widget-chat-profile-'))
    try {
      const desktopRoot = resolve(__dirname, '../..')
      const frontend = await stat(join(desktopRoot, 'frontend-dist/index.html'))
      const chatSource = await stat(join(desktopRoot, 'frontend/src/chat/chat.ts'))
      assert(frontend.mtimeMs >= chatSource.mtimeMs, 'Build the frontend before the complete chat Widget test')
      await build({
        entryPoints: [join(desktopRoot, 'frontend/src/chat/transcript/widget-full-chat-dom-entry.ts')],
        outfile: join(assets, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
        loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent',
      })
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KLAUS_WIDGET_DESKTOP_ROOT: desktopRoot,
        KLAUS_WIDGET_FULL_CHAT_ASSETS: assets,
        KLAUS_WIDGET_FULL_CHAT_PROFILE: profile,
      }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawnElectronGui(require('electron') as string, [join(desktopRoot, 'tests/widget-full-chat-fixture.cjs')], {
        env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', bytes => { stdout += String(bytes) })
      child.stderr.on('data', bytes => { stderr += String(bytes) })
      const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
        child.once('error', fail)
        child.once('close', (code, signal) => done({ code, signal }))
      })
      clearTimeout(timer)
      assert.equal(signal, null, stderr)
      assert.equal(code, 0, `${stdout}\n${stderr}`)
      const marker = stdout.split('\n').find(line => line.startsWith('WIDGET_FULL_CHAT_RESULT='))
      assert(marker, `Missing complete chat result: ${stdout}\n${stderr}`)
      process.stdout.write(`${marker}\n`)
      const result = JSON.parse(marker.slice('WIDGET_FULL_CHAT_RESULT='.length)) as {
        checks: Record<string, boolean>; error?: string; send?: { text: string }; queue?: { item: { text: string } };
      }
      assert.equal(result.error, undefined, result.error)
      assert.equal(Object.keys(result.checks).length, 14)
      assert(Object.values(result.checks).every(Boolean), JSON.stringify(result.checks))
      assert.equal(result.send?.text, '[Widget: Counter]\n{"count":1}')
      assert.equal(result.queue?.item.text, '[Widget: Counter]\n{"count":5}')
    } finally {
      await rm(assets, { recursive: true, force: true })
      await rm(profile, { recursive: true, force: true })
    }
  })
})
