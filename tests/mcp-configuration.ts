import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { MCP_CONFIGURATION_CHANNELS, registerMcpConfigurationHandlers } from '../main/ipc/handlers/mcp-configuration';
import { McpConfigurationService, type McpConfigurationDeps } from '../main/services/mcp/configuration';
import { resolveServerTables } from '../main/services/mcp/entries';
import { object, string, type JsonObject } from '../main/services/service-types';
import { WorkspaceStore } from '../main/services/workspaces';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function put(path: string, value: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function invoke(registry: ChannelRegistry, channel: string, payload: Json = {}): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'registered ' + channel); return handler({ channel, args: [payload], senderId: 1, role: 'main' });
}
function keySegments(path: string): string[] {
  const out: string[] = []; let current = '', quoted = false;
  for (let index = 0; index < path.length; index++) {
    const char = path[index]!;
    if (quoted && char === '\\') current += path[++index];
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === '.') { out.push(current); current = ''; }
    else current += char;
  }
  return [...out, current];
}
export function mcpConfigurationFixture(root: string, initial: JsonObject = {}, extra: Partial<McpConfigurationDeps> = {}) {
  let values = structuredClone(initial), version = 0, refuse = false, conflict = false;
  const calls: Array<{ method: string; params: JsonObject }> = [], changes: Array<string | undefined> = [];
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, pickDirectory: async () => null, onSessionWorkdirChanged: () => {} });
  const registry = new ChannelRegistry();
  const service = registerMcpConfigurationHandlers(registry, { workspaces, onChanged: cwd => { changes.push(cwd); }, request: async (method, raw) => {
    const params = object(raw); calls.push({ method, params: structuredClone(params) });
    if (method === 'config/read') return { version: String(version), values: structuredClone(values) };
    assertEqual(method, 'config/batchWrite', 'only named config methods');
    if (refuse) throw new Error('fixture disk refused');
    if (conflict) { values.foreignChange = true; version++; conflict = false; }
    if (params.expectedVersion !== String(version)) throw new Error('config version mismatch');
    const next = structuredClone(values);
    for (const rawEdit of params.edits as Json[]) {
      const edit = object(rawEdit), segments = keySegments(string(edit.keyPath)); let target = next;
      for (const key of segments.slice(0, -1)) {
        if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, { value: {}, writable: true, configurable: true, enumerable: true });
        target = object(target[key]);
      }
      const key = segments.at(-1)!;
      if (edit.value === null) delete target[key];
      else Object.defineProperty(target, key, { value: structuredClone(edit.value), writable: true, configurable: true, enumerable: true });
    }
    values = next; version++; return { values: structuredClone(values), version: String(version) };
  }, ...extra });
  return { service, registry, workspaces, calls, changes, values: () => structuredClone(values), refuse: (value: boolean) => { refuse = value; }, conflict: () => { conflict = true; } };
}

const fixture = mcpConfigurationFixture;
export function registerMcpConfigurationTests(h: Harness, freshRoot: () => string): void {
  h.test('MCP configuration registers eighteen real handlers and writes only engine-owned user config', async () => {
    const root = freshRoot(), f = fixture(root, { untouched: 'keep' }); await put(join(root, '.mcp.json'), '{"mcpServers":{"legacy":{"command":"ignored"}}}');
    try {
      assertDeepEqual(f.registry.channels(), [...MCP_CONFIGURATION_CHANNELS].sort(), 'actual routing');
      assertDeepEqual(await invoke(f.registry, 'mcp:list'), [], 'legacy import file does not shadow authoritative config');
      assertDeepEqual(await invoke(f.registry, 'mcp:create', { name: 'alpha', command: 'node', args: ['server.js'] }), { ok: true, name: 'alpha' }, 'create committed');
      assertDeepEqual(await invoke(f.registry, 'mcp:list'), [{ name: 'alpha', config: { command: 'node', args: ['server.js'] }, enabled: true }], 'enabled defaults absent in storage');
      assertEqual(f.values().untouched, 'keep', 'unrelated engine setting survives');
      assertEqual(object(await invoke(f.registry, 'mcp:create', { name: '__proto__', command: 'safe-fixture' })).ok, true, 'legal server name is an own data key');
      assertEqual(Object.hasOwn(object(f.values().mcpServers), '__proto__'), true, 'prototype named row is stored');
      assertEqual(object(await invoke(f.registry, 'mcp:create', { name: 'alpha', command: 'other' })).ok, false, 'duplicate never replaces');
      assertEqual(f.calls.filter(call => call.method === 'config/batchWrite')[0]?.params.expectedVersion, '0', 'write uses read version');
      assertEqual(await readFile(join(root, '.mcp.json'), 'utf8'), '{"mcpServers":{"legacy":{"command":"ignored"}}}', 'host leaves legacy source untouched');
      assertEqual(f.changes.length, 2, 'only two durable changes notified');
    } finally { await f.service.close(); }
  });
  h.test('MCP edits retain disabled state and per-tool ordering while removals preserve other entries', async () => {
    const f = fixture(freshRoot(), { mcpServers: { alpha: { command: 'a' }, beta: { command: 'b' }, gamma: { command: 'g' } } });
    try {
      await f.service.toggle({ name: 'alpha', enabled: false }); await f.service.update({ name: 'alpha', config: { command: 'edited' } });
      assertEqual(object(object(f.values().mcpServers).alpha).enabled, false, 'editing does not re-enable');
      for (const toolName of ['second', 'first', 'second']) await f.service.setToolEnabled({ name: 'alpha', toolName, enabled: false });
      assertDeepEqual(object(object(f.values().mcpServers).alpha).disabledTools, ['second', 'first'], 'deny list order and dedupe');
      for (const toolName of ['second', 'first']) await f.service.setToolEnabled({ name: 'alpha', toolName, enabled: true });
      await f.service.toggle({ name: 'alpha', enabled: true });
      assertDeepEqual(object(object(f.values().mcpServers).alpha), { command: 'edited' }, 'last deny and enabled sentinel disappear');
      assertEqual(await f.service.remove({ name: 'beta' }), true, 'existing server removed');
      assertDeepEqual(Object.keys(object(f.values().mcpServers)), ['alpha', 'gamma'], 'survivor order preserved');
      assertEqual(await f.service.remove({ name: 'missing' }), false, 'missing removal remains false');
      const count = f.calls.length; assertEqual(object(await f.service.toggle({ name: 'alpha', enabled: 'yes' })).ok, false, 'boolean validation'); assertEqual(f.calls.length, count, 'no engine request for invalid boolean');
    } finally { await f.service.close(); }
  });
  h.test('MCP imports keep duplicate definitions and report partial failures without inventing imported rows', async () => {
    const f = fixture(freshRoot(), { mcpServers: { taken: { command: 'keep' } } });
    try {
      assertDeepEqual(await f.service.importJson({ json: '{' }), { ok: false, imported: [], errors: ['Invalid JSON'] }, 'syntax failure');
      assertDeepEqual(await f.service.importJson({ json: '[]' }), { ok: false, imported: [], errors: ['Expected mcpServers object'] }, 'shape failure');
      assertDeepEqual(await f.service.importJson({ json: '{"mcpServers":{"fresh":{"command":"new"},"taken":{"command":"other"},"bad name":{}}}' }),
        { ok: false, imported: ['fresh'], errors: ['taken: already exists', 'bad name: invalid name'] }, 'partial import result');
      assertEqual(object(object(f.values().mcpServers).taken).command, 'keep', 'old declaration survives');
      f.refuse(true); const result = object(await f.service.importJson({ json: '{"never":{"command":"no"}}' }));
      assertDeepEqual(result.imported, [], 'failed durable write cannot claim an imported row'); assertEqual(object(f.values().mcpServers).never, undefined, 'no phantom server');
      assertEqual(f.changes.length, 1, 'refused writes never refresh');
    } finally { await f.service.close(); }
  });
  h.test('project MCP writes retain exact JSON shape disabled flags and corrupt file bytes', async () => {
    const root = freshRoot(), project = join(root, 'project'), f = fixture(root); await mkdir(project); f.workspaces.projectsAdd({ path: project });
    try {
      assertEqual(object(await f.service.scopeMutate('project', 'create', { cwd: project, name: 'alpha', config: { nope: 1, enabled: false } })).ok, true, 'project declarations may intentionally be invalid');
      assertEqual(await readFile(join(project, '.klaus/mcp.json'), 'utf8'), JSON.stringify({ mcpServers: { alpha: { nope: 1, enabled: false } } }, null, 2), 'compatible document without trailing newline');
      await f.service.scopeMutate('project', 'update', { cwd: project, name: 'alpha', config: { command: 'node' } });
      assertDeepEqual(await f.service.scopeList('project', { cwd: project }), [{ name: 'alpha', config: { command: 'node', enabled: false } }], 'scope list has exactly name and config');
      assertEqual(object(await invoke(f.registry, 'mcp:project:toggle', { cwd: project, name: 'alpha', enabled: true })).ok, true, 'project declaration can be enabled from the page');
      assertDeepEqual(await f.service.scopeList('project', { cwd: project }), [{ name: 'alpha', config: { command: 'node' } }], 'enabled project sentinel disappears');
      assertEqual(object(await invoke(f.registry, 'mcp:project:toggle', { cwd: project, name: 'alpha', enabled: 'yes' })).ok, false, 'project toggle validates booleans');
      assertEqual(object(await f.service.scopeMutate('project', 'create', { cwd: project, name: 'incomplete', config: null })).ok, true, 'raw null declaration preserved');
      assertEqual(object(JSON.parse(await readFile(join(project, '.klaus/mcp.json'), 'utf8')).mcpServers).incomplete, null, 'null is not changed to an empty object');
      await put(join(project, '.klaus/mcp.json'), '{ broken external edit');
      assertEqual(object(await f.service.scopeMutate('project', 'remove', { cwd: project, name: 'alpha' })).ok, false, 'corrupt document cannot be rewritten as empty');
      assertEqual(await readFile(join(project, '.klaus/mcp.json'), 'utf8'), '{ broken external edit', 'corrupt user bytes preserved');
      assertEqual(object(await f.service.scopeMutate('project', 'create', { cwd: freshRoot(), name: 'outside' })).ok, false, 'unregistered root refused');
    } finally { await f.service.close(); }
  });
  h.test('bound managed worktrees remain writable MCP scopes while hidden from Projects and leased against removal', async () => {
    const root = freshRoot(), project = join(root, 'worktrees', 'fixture'), f = fixture(root); await mkdir(project, { recursive: true });
    f.workspaces.bindSession('worktree-thread', { workdir: project });
    try {
      assert(f.workspaces.scopeRoots().includes(project), 'bound managed worktree grants scope authority');
      assertEqual(f.workspaces.registeredProjectRoots().includes(project), false, 'worktree never joins the Projects registry');
      assertDeepEqual(object(f.workspaces.projectsList()).roots, [], 'managed worktree remains hidden from Projects');
      assertEqual(object(await f.service.scopeMutate('project', 'create', { cwd: project, name: 'alpha', config: { command: 'node' } })).ok, true, 'bound worktree project write');
      assertEqual(object(await f.service.scopeMutate('local', 'create', { cwd: project, name: 'beta', config: { command: 'node' } })).ok, true, 'bound worktree local write');
      const release = await f.workspaces.quiesceDirectory(project);
      try {
        assertEqual(object(await f.service.scopeMutate('project', 'update', { cwd: project, name: 'alpha', config: {} })).ok, false, 'worktree lease blocks project write');
        assertEqual(object(await f.service.scopeMutate('local', 'remove', { cwd: project, name: 'beta' })).ok, false, 'worktree lease blocks local write');
      } finally { release(); }
      f.workspaces.forgetSession('worktree-thread');
      assertEqual(f.workspaces.scopeRoots().includes(project), false, 'forgetting its only binding revokes authority');
    } finally { await f.service.close(); }
  });
  h.test('local MCP canonicalizes one legacy project key atomically and preserves its unrelated metadata', async () => {
    const root = freshRoot(), project = join(root, 'project.with."quotes"'), legacy = project + '/./'; await mkdir(project);
    const f = fixture(root, { projects: { [legacy]: { note: 'keep', mcpServers: { alpha: { command: 'old', enabled: false } } }, '/other': { marker: true } } }); f.workspaces.projectsAdd({ path: project });
    try {
      assertEqual(object(await f.service.scopeMutate('local', 'update', { cwd: project + '/', name: 'alpha', config: { type: 'http', url: 'https://example.invalid/mcp' } })).ok, true, 'local update committed');
      const projects = object(f.values().projects); assertEqual(projects[legacy], undefined, 'legacy alias removed in the same batch');
      assertEqual(object(projects[project]).note, 'keep', 'metadata preserved'); assertDeepEqual(projects['/other'], { marker: true }, 'other project untouched');
      assertEqual(object(object(object(projects[project]).mcpServers).alpha).enabled, false, 'off switch carried across replacement');
      assertEqual(object(await invoke(f.registry, 'mcp:local:toggle', { cwd: project, name: 'alpha', enabled: true })).ok, true, 'local declaration can be enabled from the page');
      assertEqual(object(object(object(f.values().projects)[project]).mcpServers).alpha != null, true, 'local declaration survives toggle');
      assertEqual(object(object(object(object(f.values().projects)[project]).mcpServers).alpha).enabled, undefined, 'enabled local sentinel disappears');
      assertEqual(await exists(join(root, 'projects.json')), false, 'no second local config store');
      const result = object(await f.service.scopeMutate('local', 'create', { cwd: project, name: 'bad', config: { url: 'https://example.invalid' } }));
      assertEqual(result.error, 'invalid MCP server "bad": need a "command" (stdio) or "url" (http/sse) field', 'declared transport required');
    } finally { await f.service.close(); }
  });
  h.test('engine config CAS failures retain concurrent edits and cannot turn a failed local change into success', async () => {
    const root = freshRoot(), project = join(root, 'project'), f = fixture(root); await mkdir(project); f.workspaces.projectsAdd({ path: project });
    try {
      f.conflict(); const reply = object(await f.service.scopeMutate('local', 'create', { cwd: project, name: 'alpha', config: { command: 'node' } }));
      assertEqual(reply.ok, false, 'version conflict reaches caller'); assertEqual(f.values().foreignChange, true, 'concurrent edit retained');
      assertEqual(f.values().projects, undefined, 'stale server table never overwrites'); assertEqual(f.changes.length, 0, 'no false invalidation');
      assertEqual(object(await f.service.scopeMutate('local', 'create', { cwd: project, name: 'alpha', config: { command: 'node' } })).ok, true, 'later explicit retry uses new version');
    } finally { await f.service.close(); }
  });
  h.test('MCP project writes reject escaped symlinks and hold a lease through final invalidation', async () => {
    const root = freshRoot(), project = join(root, 'project'), outside = freshRoot(), ready = deferred(); let entered = false;
    await mkdir(project); await symlink(outside, join(project, '.klaus'), process.platform === 'win32' ? 'junction' : 'dir');
    const f = fixture(root, {}, { onChanged: async () => { entered = true; await ready.promise; } }); f.workspaces.projectsAdd({ path: project });
    try {
      assertEqual(object(await f.service.scopeMutate('project', 'create', { cwd: project, name: 'escape', config: {} })).ok, false, 'escaped metadata directory refused');
      assertEqual(await exists(join(outside, 'mcp.json')), false, 'outside not written'); await rm(join(project, '.klaus'));
      const saving = f.service.scopeMutate('project', 'create', { cwd: project, name: 'alpha', config: { command: 'node' } });
      await waitFor(() => entered, 1000, 'actual write reached invalidation'); let drained = false;
      const closing = f.workspaces.quiesceDirectory(project).then(release => { drained = true; return release; });
      assertEqual(object(await f.service.scopeMutate('project', 'update', { cwd: project, name: 'alpha', config: {} })).ok, false, 'later write refused');
      assertEqual(drained, false, 'directory waits for completed invalidation'); ready.resolve(); await saving; const release = await closing;
      try {
        await rm(project, { recursive: true });
        assertEqual(object(await f.service.scopeMutate('project', 'create', { cwd: project, name: 'late' })).ok, false, 'stale registered root cannot be recreated');
        assertEqual(await exists(project), false, 'removed project stays absent');
      } finally { release(); }
    } finally { ready.resolve(); await f.service.close(); }
  });
  h.test('MCP declaration vectors pin transport scope order and plugin ownership', async () => {
    const vectors = JSON.parse(await readFile(join(__dirname, '../../tests/vectors/mcp-declarations.json'), 'utf8')) as Array<{ user: JsonObject; project: JsonObject; local: JsonObject; expected: Json }>;
    for (const vector of vectors) assertDeepEqual(resolveServerTables(vector.user, vector.project, vector.local), vector.expected, 'fixed declaration contract');
    const root = freshRoot(), project = join(root, 'project'); await put(join(project, '.klaus/mcp.json'), '{"mcpServers":{"project":{"command":"project"}}}');
    const f = fixture(root, { mcpServers: { user: { command: 'user' } }, projects: { [project]: { mcpServers: { local: { type: 'sse', url: 'https://example.invalid' } } } }, plugins: { p: { mcpServers: { duplicate: { command: 'never-host-init' } } } } }, { resolveCwd: async id => { assertEqual(id, 'existing', 'renderer identity resolved without activation'); return project; } });
    try {
      const result = await f.service.resolvedServerSet(project); assertDeepEqual(result.servers.map(row => row.name), ['user', 'project', 'local'], 'plugins remain engine-owned');
      const status = await f.service.sessionStatus({ sessionId: 'existing' }) as JsonObject[];
      assertDeepEqual(status.map(row => [row.name, row.scope, row.status]), [['user', 'user', 'declared'], ['project', 'project', 'declared'], ['local', 'local', 'declared']], 'session cwd and declaration scope survive');
    } finally { await f.service.close(); }
  });
  h.test('closing MCP waits for accepted changes and refuses all later writes', async () => {
    const ready = deferred(); let entered = false;
    const f = fixture(freshRoot(), {}, { onChanged: async () => { entered = true; await ready.promise; } });
    const writing = f.service.create({ name: 'first', command: 'node' }); await waitFor(() => entered, 1000, 'write callback entered'); let closed = false;
    const closing = f.service.close().then(() => { closed = true; });
    assertEqual(object(await f.service.create({ name: 'late', command: 'node' })).ok, false, 'later write refused');
    assertEqual(closed, false, 'close waits callback'); ready.resolve(); await writing; await closing;
    await assertRejects(() => f.service.list(), 'reads after close refused'); assertEqual(object(f.values().mcpServers).late, undefined, 'no late durable write');
  });
  h.test('MCP resolution rejects unreadable project configuration so failed reads cannot replace a live server set', async () => {
    const root = freshRoot(), project = join(root, 'project'), path = join(project, '.klaus/mcp.json'), diagnostics: string[] = [];
    await put(path, '{"mcpServers":{"project":{"command":"keep-live"}}}');
    const f = fixture(root, { mcpServers: { user: { command: 'user' } } }, { diagnostic: path => { diagnostics.push(path); } });
    try {
      let live = (await f.service.resolvedServerSet(project)).servers, reloads = 0;
      const reload = async () => { const resolved = await f.service.resolvedServerSet(project); live = resolved.servers; reloads++; };
      await put(path, '{ corrupt external edit'); await assertRejects(reload, 'malformed project config refuses authoritative resolution');
      assertDeepEqual(live.map(row => row.name), ['user', 'project'], 'previous live declarations retained'); assertEqual(reloads, 0, 'failure cannot trigger a partial or empty reload');
      await rm(path); await mkdir(path); await assertRejects(reload, 'unreadable directory does not become an empty config');
      assertEqual(diagnostics.length, 2, 'both failures recorded'); assertEqual(reloads, 0, 'unreadable config cannot reload');
      await rm(path, { recursive: true }); await reload(); assertDeepEqual(live.map(row => row.name), ['user'], 'an actually removed file is a valid absent project scope');
    } finally { await f.service.close(); }
  });
  h.test('MCP saved changes report reload failures distinctly and imports retain the rows actually committed', async () => {
    const f = fixture(freshRoot(), {}, { onChanged: async () => { throw new Error('fixture live reload refused'); } });
    try {
      const created = object(await f.service.create({ name: 'saved', command: 'node' }));
      assertEqual(created.saved, true, 'persistence is explicit despite reload failure'); assertEqual(created.reloadRequired, true, 'caller can request a later reload');
      assert(string(created.error).includes('configuration was saved'), 'visible error distinguishes persisted state'); assert(Object.hasOwn(object(f.values().mcpServers), 'saved'), 'actual config remains saved');
      const imported = object(await f.service.importJson({ json: '{"imported":{"command":"node"}}' }));
      assertDeepEqual(imported.imported, ['imported'], 'successful persisted rows remain in import response'); assertEqual(imported.saved, true, 'import is also saved');
      const failure = await assertRejects(() => f.service.remove({ name: 'saved' }), 'boolean removal uses an explicit reload error instead of false');
      assertEqual(object(failure).code, 'MCP_RELOAD_FAILED', 'removal error code'); assertEqual(object(f.values().mcpServers).saved, undefined, 'actual durable removal is not denied');
    } finally { await f.service.close(); }
  });
}
