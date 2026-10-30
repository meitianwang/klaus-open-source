import { chmod, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { PLUGIN_CHANNELS, RUNTIME_VIEW_CHANNELS, registerPluginHandlers, registerRuntimeViewHandlers } from '../main/ipc/handlers/plugins';
import { GitProcess } from '../main/services/git-process';
import { BrowserPreferences } from '../main/services/browser-preferences';
import { PluginService, type PluginChange, type PluginDeps } from '../main/services/extensions/plugins';
import { PluginSources } from '../main/services/extensions/plugin-sources';
import { buildRuntimeView, RuntimeViewService, type DesiredPlugin, type RuntimeResults } from '../main/services/extensions/runtime-view';
import { object, string, type JsonObject } from '../main/services/service-types';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function document(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
function deps(root: string, overrides: Partial<PluginDeps> = {}): PluginDeps {
  return { configRoot: root, request: async method => {
    if (method === 'session/installedPlugins') return { installedPlugins: { version: 1, plugins: {} } };
    assertEqual(method, 'config/read', 'no unexpected activation'); return { values: {} };
  },
    requestAcknowledged: async () => { throw new Error('No plugin request was expected'); }, binding: () => undefined,
    resolveSession: async () => { throw new Error('No replacement thread may be created'); }, onChanged: () => {}, ...overrides };
}
async function invoke(registry: ChannelRegistry, channel: string, payload: Json = {}): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'actual handler for ' + channel);
  return handler({ channel, args: [payload], senderId: 1, role: 'main' });
}
async function localCatalog(root: string, source: Json = './plugins/fixture') {
  const market = join(root, 'market'), packageDir = join(market, 'plugins/fixture');
  await document(join(market, '.codex-plugin/marketplace.json'), { name: 'local', plugins: [{ name: 'fixture', description: 'An actual package', source }] });
  await document(join(packageDir, '.codex-plugin/plugin.json'), { name: 'fixture', version: '2.3.4', description: 'Fixture', skills: ['./skills'] });
  await mkdir(join(packageDir, 'skills/demo'), { recursive: true }); await writeFile(join(packageDir, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Fixture skill\n---\nUse only in tests.\n');
  const values: JsonObject = { marketplaces: { local: { installLocation: market } } };
  return { market, packageDir, values };
}

export function registerPluginServiceTests(h: Harness, freshRoot: () => string): void {
  h.test('plugin and runtime registrars expose their named handlers without activating a cold session', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), options = deps(root), plugins = registerPluginHandlers(registry, options);
    registerRuntimeViewHandlers(registry, { ...options, runtime: plugins.runtime });
    try {
      assertDeepEqual(registry.channels(), [...PLUGIN_CHANNELS, ...RUNTIME_VIEW_CHANNELS].sort(), 'actual channel ownership');
      assertDeepEqual(await invoke(registry, 'plugins:list'), [], 'fresh isolated ledger is empty');
      assertEqual(object(await invoke(registry, 'plugins:runtime', { sessionId: 'cold' })).status, 'no_session', 'passive runtime never activates');
      assertEqual(await invoke(registry, 'runtime:extensions'), null, 'missing explicit runtime id is null');
      assertEqual(object(await invoke(registry, 'plugins:install', { id: 'missing@local' })).ok, false, 'unknown package is not success');
    } finally { await plugins.close(); }
  });
  h.test('plugin catalog repairs missing user content from the seed and preserves ids metadata and installed orphans', async () => {
    const root = freshRoot(), seed = join(root, 'plugins-seed'), market = join(seed, 'marketplaces/local');
    await document(join(seed, 'known_marketplaces.json'), { local: { installLocation: '/__klaus__/plugins-seed/marketplaces/local' } });
    await document(join(market, '.claude-plugin/marketplace.json'), { plugins: [{ name: 'claude-helper', description: 'Claude Code helpers from Anthropic', source: './plugins/p', category: 'development', commands: [],
      lspServers: { ts: { command: 'typescript-language-server', extensionToLanguage: { '.ts': 'typescript' } } } }] });
    const values: JsonObject = { marketplaces: { local: { installLocation: join(root, 'removed') } }, plugins: { 'claude-helper@local': { enabled: false }, 'orphan@custom': { name: 'orphan', enabled: true }, 'browser@builtin': { name: 'browser', enabled: false } } };
    const service = new PluginService(deps(root, { seedDir: seed, request: async method => method === 'session/installedPlugins'
      ? { installedPlugins: { version: 1, plugins: values.plugins } } : { values } }));
    try {
      const catalog = object(await service.market()), rows = catalog.plugins as Json[];
      const plugin = rows.map(object).find(row => row.id === 'claude-helper@local')!;
      assertEqual(plugin.name, 'klaus-helper', 'display brand only'); assertEqual(plugin.description, 'Klaus helpers from Klaus', 'brand text');
      assertEqual(plugin.enabled, false, 'ledger desired state'); assertEqual(plugin.category, 'lsp', 'LSP wins category');
      assertDeepEqual(plugin.badges, ['Commands', 'LSP'], 'declared contribution badge');
      assertEqual(object((catalog.marketplaces as Json[])[0]).seeded, true, 'seed repaired unreadable cache');
      assertEqual(rows.filter(row => object(row).id === 'orphan@custom').length, 1, 'installed row remains manageable without its old marketplace');
      assertEqual((await service.list({}) as JsonObject[]).filter(row => row.id === 'browser@builtin').length, 1, 'builtin row is never appended twice');
      await document(join(root, 'user/.claude-plugin/marketplace.json'), { plugins: [{ name: 'user', source: './p' }] });
      values.marketplaces = { local: { installLocation: join(root, 'user') } };
      assertEqual((await service.catalog.snapshot()).rows.find(row => row.id === 'user@local')?.name, 'user', 'readable user registration remains installable');
      assertEqual((object(await service.market()).plugins as Json[]).some(row => object(row).id === 'user@local'), false, 'unpublished row stays hidden');
    } finally { await service.close(); }
  });
  h.test('plugin contribution catalog waits for the named reply and keeps a readable listing when it fails', async () => {
    const root = freshRoot(), f = await localCatalog(root), calls: unknown[] = [], diagnostic: string[] = []; let fail = false;
    f.values.plugins = { 'fixture@local': { name: 'fixture', enabled: true } };
    const service = new PluginService(deps(root, { request: async method => method === 'session/installedPlugins'
      ? { installedPlugins: { version: 1, plugins: f.values.plugins } } : { values: f.values }, diagnostic: message => diagnostic.push(message), requestAcknowledged: async (method, params, field) => {
      calls.push({ method, params, field }); if (fail) throw new Error('catalog read refused'); return { entries: [{ id: 'fixture@local', contributions: { skills: ['demo'] } }] };
    } }));
    try {
      assertDeepEqual(object((object(await service.market()).plugins as Json[])[0]).contributions, { skills: ['demo'] }, 'engine owns manifest contributions');
      assertDeepEqual(calls[0], { method: 'session/pluginCatalog', params: { roots: [{ marketplace: 'local', dir: join(f.market, 'plugins') }] }, field: 'pluginCatalog' }, 'named catalog contract');
      fail = true; const next = object(await service.market()); assertEqual((next.plugins as Json[]).length, 1, 'display metadata remains useful');
      assertEqual(object((next.plugins as Json[])[0]).contributions, undefined, 'no fabricated empty contributions'); assert(diagnostic[0]?.includes('catalog read refused'), 'failure is diagnosed');
    } finally { await service.close(); }
    const broken = new PluginService(deps(root, { request: async () => ({ error: 'config corrupt' }) }));
    try { await assertRejects(() => broken.list({}), 'corrupt ledger cannot become successful empty list'); } finally { await broken.close(); }
  });
  h.test('runtime projection matches fixed no-session and partial stale-plugin contract vectors', async () => {
    const vectors = JSON.parse(await readFile(join(__dirname, '../../tests/vectors/runtime-view.json'), 'utf8')) as Array<{ name: string; sessionId: string; desired: DesiredPlugin[]; results?: RuntimeResults; available: boolean; stale?: boolean; expected: Json }>;
    for (const vector of vectors) assertDeepEqual(buildRuntimeView(vector.sessionId, vector.desired, vector.results, vector.available, vector.stale), vector.expected, vector.name);
  });
  h.test('runtime queries use one existing binding in parallel and preserve unavailable errors after failed activation', async () => {
    const allEntered = deferred(), calls: string[] = [];
    const runtime = new RuntimeViewService({ binding: id => id === 'live' ? { engineId: 'engine-existing', stale: false } : undefined,
      resolveSession: async id => { throw new Error('Missing thread: ' + id); }, request: async (method, params) => {
        assertEqual(object(params).sessionId, 'engine-existing', 'live engine id'); calls.push(method); if (calls.length === 4) allEntered.resolve(); await allEntered.promise;
        if (method === 'session/installedPlugins') return { error: 'ledger unavailable' };
        if (method === 'session/extensionRuntime') return { extensionRuntime: { skills: [{ name: 'actual' }] } };
        return { [method.slice('session/'.length)]: {} };
      } });
    assertEqual(object(await runtime.activeView({ sessionId: 'missing' })).status, 'unavailable', 'failed activation is not no-session');
    assertEqual(calls.length, 0, 'missing activation issues no replacement query');
    const result = await runtime.view('live'); assertEqual(result.status, 'ready', 'partial success is usable');
    assertDeepEqual(object(result.extensions).skills, [{ name: 'actual' }], 'query envelopes unwrapped');
    assertDeepEqual(result.diagnostics, [{ source: 'installed_plugins', level: 'error', message: 'ledger unavailable' }], 'field-specific failure preserved');
    assertDeepEqual(calls.sort(), ['session/runtimeCapabilities', 'session/extensionRuntime', 'session/pluginRuntime', 'session/installedPlugins'].sort(), 'exactly four named queries');
  });
  h.test('plugin mutation replies wait for persistence and invalidation and never interpret ACKs as success', async () => {
    const root = freshRoot(), terminal = deferred(), invalidated = deferred(), calls: unknown[] = []; let entered = false, dirty = false, mode = 'valid';
    let notice: PluginChange | undefined;
    const service = new PluginService(deps(root, { requestAcknowledged: async (method, params, field) => {
      calls.push({ method, params, field }); entered = true; await terminal.promise; return mode === 'valid' ? { persisted: true, restartRequired: false, activationScope: 'next_turn', appliedToCurrentSession: false } : { submissionId: 'ack-only' };
    }, onChanged: async change => { notice = change; dirty = true; await invalidated.promise; } }));
    try {
      let finished = false; const changing = service.toggle({ id: 'context7@claude-plugins-official', enabled: true }).then(result => { finished = true; return result; });
      await waitFor(() => entered, 1000, 'mutation entered'); assertEqual(dirty, false, 'no invalidation before terminal persistence');
      terminal.resolve(); await waitFor(() => dirty, 1000, 'dirty callback entered'); assertEqual(finished, false, 'UI waits for invalidation');
      invalidated.resolve(); assertDeepEqual(await changing, { ok: true, name: 'context7@claude-plugins-official', restartRequired: false, activationScope: 'next_turn', appliedToCurrentSession: false }, 'final UI shape');
      const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/plugin-rpc-vectors.json'), 'utf8'));
      assertDeepEqual(notice, { method: vector.requests.toggle.method, id: 'context7@claude-plugins-official', mutation: vector.requests.toggle.result }, 'owner receives the live activation boundary');
      assertDeepEqual(calls[0], { method: vector.requests.toggle.method, params: vector.requests.toggle.params, field: vector.requests.toggle.replyField }, 'committed engine contract');
      mode = 'ack'; await assertRejects(() => service.uninstall({ id: 'p@local' }), 'missing persisted outcome refused');
      assertDeepEqual(calls[1], { method: 'session/uninstallPlugin', params: { name: 'p@local', removeFiles: true }, field: 'pluginMutation' }, 'uninstall removes engine-owned copy');
      const count = calls.length; await assertRejects(() => service.toggle({ id: 'p@local', enabled: 'true' }), 'boolean validation'); assertEqual(calls.length, count, 'invalid args do not invoke engine');
    } finally { terminal.resolve(); invalidated.resolve(); await service.close(); }
  });
  h.test('browser capability enablement uses the plugin facade and preserves its restart result', async () => {
    const root = freshRoot(), toggles: boolean[] = [], reads: string[] = []; let enabled = false, legacyChanges = 0;
    const preferences = new BrowserPreferences({
      configRoot: root, resourceDirs: [], changed: () => { legacyChanges++; },
      request: async method => {
        reads.push(method);
        if (method === 'session/installedPlugins') return { installedPlugins: { version: 1, plugins: { 'browser@builtin': { enabled } } } };
        assertEqual(method, 'config/read', 'browser package path remains in engine settings');
        return { values: { plugins: { 'browser@builtin': { installPath: '/fixture/browser', enabled: false } } } };
      },
      setPluginEnabled: async next => { toggles.push(next); enabled = next; return { ok: true, restartRequired: true }; },
    });
    const result = object(await preferences.setEnabled(true));
    assertDeepEqual(toggles, [true], 'browser delegates to the named plugin mutation path');
    const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/plugin-rpc-vectors.json'), 'utf8'));
    assert(reads.includes(vector.requests.browserEnablementRead.method), 'browser status reads the engine-owned plugin ledger');
    assertEqual(result.restartRequired, true, 'endpoint restart requirement reaches the renderer');
    assertEqual(object(result.settings).enabled, true, 'browser state is refreshed from the persisted engine row');
    assertEqual(legacyChanges, 0, 'plugin facade owns invalidation and preferences events');
  });
  h.test('endpoint plugin dirtiness stays visible for cold and newly created sessions until the owner restarts', async () => {
    const root = freshRoot(); let dirty = true;
    const values: JsonObject = { plugins: { 'fixture@local': { name: 'fixture', enabled: true } } };
    const service = new PluginService(deps(root, { endpointRestartRequired: () => dirty, binding: id => id === 'new' ? { engineId: 'new-engine-session', stale: false } : undefined,
      request: async method => method === 'config/read' ? { values } : method === 'session/extensionRuntime' ? { extensionRuntime: { skills: [] } } : {} }));
    try {
      assertEqual(object(await service.market()).restartRequired, true, 'settings market has an endpoint-wide pending indicator');
      for (const sessionId of ['cold', 'new']) {
        const view = object(await service.runtimeView({ sessionId })), row = object((view.plugins as Json[])[0]);
        assertEqual(row.effectiveStatus, 'pending_restart', sessionId + ' cannot look applied just because its binding is fresh');
        assertEqual(row.restartRequired, true, sessionId + ' retains restart requirement');
      }
      dirty = false;
      assertEqual(object(await service.market()).restartRequired, false, 'owner acknowledges its replacement endpoint');
      assertEqual(object((object(await service.runtimeView({ sessionId: 'cold' })).plugins as Json[])[0]).effectiveStatus, 'unknown', 'passive cold read still does not invent runtime activation');
    } finally { await service.close(); }
  });
  h.test('local plugin install stages real files and removes temporary data after a terminal engine failure', async () => {
    const root = freshRoot(), f = await localCatalog(root), staging: string[] = [], changed: string[] = [];
    await document(join(root, 'plugins/installed_plugins.json'), { sentinel: 'host must never write me' });
    const before = await readFile(join(root, 'plugins/installed_plugins.json'), 'utf8');
    const service = new PluginService(deps(root, { request: async () => ({ values: f.values }), onChanged: () => { changed.push('changed'); }, requestAcknowledged: async (method, params, field) => {
      assertEqual(method, 'session/installPlugin', 'only named installer'); assertEqual(field, 'pluginMutation', 'terminal field');
      const path = string(params.sourceDir); staging.push(path); assertEqual(params.version, '2.3.4', 'codex manifest version read');
      assert((await readFile(join(path, 'skills/demo/SKILL.md'), 'utf8')).includes('Fixture skill'), 'real staged content'); throw new Error('engine refused package');
    } }));
    try {
      const reply = object(await service.install({ id: 'fixture@local' })); assertEqual(reply.error, 'engine refused package', 'inline install error');
      assertEqual(changed.length, 0, 'failed install leaves sessions unchanged'); assertEqual(await exists(dirname(staging[0]!)), false, 'staging removed after terminal refusal');
      assertEqual(await readFile(join(root, 'plugins/installed_plugins.json'), 'utf8'), before, 'legacy ledger bytes remain engine-owned');
      assert(await exists(join(f.packageDir, 'skills/demo/SKILL.md')), 'original marketplace untouched');
    } finally { await service.close(); }
  });
  h.test('plugin acquisition refuses escaping links special protocols and copies readonly source folders', async () => {
    const root = freshRoot(), f = await localCatalog(root), source = new PluginSources({ configRoot: root });
    try {
      await writeFile(join(root, 'secret'), 'private'); await symlink(join(root, 'secret'), join(f.packageDir, 'escape'));
      await assertRejects(() => source.stage({ source: './plugins/fixture' }, f.market), 'escaping link refused');
      assertDeepEqual(await readdir(join(root, 'plugins/staging')), [], 'failed copy cleaned staging');
      await assertRejects(() => source.stage({ source: { source: 'url', url: 'ext::sh -c dangerous' } }, f.market), 'git helper command refused');
      await unlink(join(f.packageDir, 'escape'));
      await chmod(join(f.packageDir, 'skills'), 0o555);
      const staged = await source.stage({ source: './plugins/fixture' }, f.market);
      try { assert((await readFile(join(staged.sourceDir, 'skills/demo/SKILL.md'), 'utf8')).includes('Fixture skill'), 'readonly source directory copied'); }
      finally { await staged.cleanup(); }
      assertDeepEqual(await readdir(join(root, 'plugins/staging')), [], 'readonly copy staging also cleaned');
      const recursive = await assertRejects(() => source.stage({ source: '.' }, root), 'source cannot recursively contain staging');
      assert(recursive instanceof Error && recursive.message.includes('contains its acquisition directory'), 'canonical paths stop a self-copy before enumeration');
    } finally { await chmod(join(f.packageDir, 'skills'), 0o755); await source.close(); }
  });
  h.test('remote plugin sources clone an actual local repository and select the requested subdirectory commit', async () => {
    const root = freshRoot(), repo = join(root, 'repo'), git = new GitProcess(); await mkdir(repo);
    const run = async (args: string[]) => { const result = await git.run(repo, args); assertEqual(result.code, 0, result.stderr || args.join(' ')); return result.stdout.trim(); };
    const source = new PluginSources({ configRoot: root });
    try {
      await document(join(repo, 'packages/demo/.claude-plugin/plugin.json'), { name: 'demo' });
      await document(join(repo, '.claude-plugin/plugin.json'), { name: 'whole', version: '9.0' });
      await writeFile(join(repo, 'packages/demo/value.txt'), 'selected content');
      await run(['init', '--initial-branch=main']); await run(['add', '--all']);
      await run(['-c', 'user.name=Plugin Fixture', '-c', 'user.email=plugin@example.invalid', 'commit', '-m', 'fixture']);
      const sha = await run(['rev-parse', 'HEAD']);
      const staged = await source.stage({ source: { source: 'git-subdir', url: repo, path: 'packages/demo', sha } }, root);
      try { assertEqual(await readFile(join(staged.sourceDir, 'value.txt'), 'utf8'), 'selected content', 'actual selected Git tree'); assert(staged.version.startsWith(sha.slice(0, 12) + '-'), 'subdir hash disambiguates version'); }
      finally { await staged.cleanup(); }
      const whole = await source.stage({ source: { source: 'url', url: repo, sha } }, root);
      try { assertEqual(whole.version, '9.0', 'whole-repository manifest version'); assertEqual(await exists(join(whole.sourceDir, '.git')), false, 'Git administrative files are not installed'); }
      finally { await whole.cleanup(); }
      await assertRejects(() => source.stage({ source: { source: 'git-subdir', url: repo, path: '../escape' } }, root), 'repository escape refused');
      assertDeepEqual(await readdir(join(root, 'plugins/staging')), [], 'all clones and staging removed');
    } finally { await source.close(); await git.close(); }
  });
  h.test('closing plugins drains the accepted mutation and refuses queued changes before another facade write', async () => {
    const root = freshRoot(), ready = deferred(); let entered = false, writes = 0;
    const service = new PluginService(deps(root, { requestAcknowledged: async () => { entered = true; writes++; await ready.promise; return { persisted: true }; } }));
    const first = service.toggle({ id: 'one', enabled: true }); await waitFor(() => entered, 1000, 'first mutation entered');
    const second = service.toggle({ id: 'two', enabled: true }), rejected = assertRejects(() => second, 'queued mutation refused on close');
    let closed = false; const closing = service.close().then(() => { closed = true; });
    assertEqual(closed, false, 'close waits for accepted terminal operation'); ready.resolve(); await first; await rejected; await closing;
    assertEqual(writes, 1, 'only one engine write'); await assertRejects(() => service.market(), 'reads refused after close');
  });
}
