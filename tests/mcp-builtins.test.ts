import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpBuiltinService, type McpBuiltinDependencies } from '../main/services/mcp/builtins';
import { McpDiagnosticsService } from '../main/services/mcp/diagnostics';
import { registerMcpBuiltinHandlers } from '../main/ipc/handlers/mcp-builtins';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';
import { mcpConfigurationFixture } from './mcp-configuration';

const h = new Harness(), cleanups: Array<() => Promise<unknown>> = [];
const http: JsonObject = { id: 'github', nameEn: 'GitHub fixture', config: { type: 'http', url: 'https://fixture.invalid/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
  envKeys: [{ key: 'TOKEN', secret: true }], deviceAuth: { provider: 'github', clientId: 'public-fixture' } };
const uv: JsonObject = { id: 'uv-fixture', config: { command: 'uvx', args: ['fixture'] }, envKeys: [] };
async function fixture(initial: JsonObject = {}, extra: Partial<McpBuiltinDependencies> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-mcp-catalog-')), config = mcpConfigurationFixture(root, initial), logs: string[] = [];
  const builtins = new McpBuiltinService({ configRoot: root, mcp: config.service, endpoint: () => undefined, seed: [http, uv], log: value => { logs.push(value); }, ...extra });
  const diagnostics = new McpDiagnosticsService({ configRoot: root, mcp: config.service, environment: {} });
  registerMcpBuiltinHandlers(config.registry, builtins, diagnostics);
  const close = async () => { await Promise.all([builtins.close(), diagnostics.close()]); await config.service.close(); await rm(root, { recursive: true, force: true }); };
  cleanups.push(close); return { ...config, root, builtins, diagnostics, logs, close };
}
async function remote(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${address.port}`;
}
function servers(f: Awaited<ReturnType<typeof fixture>>): JsonObject { return object(f.values().mcpServers); }

h.test('catalog projects actual installation state and an unreachable server leaves it empty', async () => {
  const f = await fixture({ mcpServers: { github: { ...object(http.config), enabled: false } } }, { platform: 'win32', deviceClientId: () => 'public-fixture' });
  const rows = await f.builtins.list() as JsonObject[];
  assert.equal(rows.length, 2); assert.equal(rows[0]!.installed, true); assert.equal(rows[0]!.enabled, false);
  assert.equal(object(rows[0]!.deviceAuth).ready, true); assert.equal(rows[1]!.needsUv, true); assert.equal(rows[0]!.config, undefined);
  // The connector catalog is server-hosted: no compiled seed ships anymore, so
  // a client that cannot reach the server sees an empty market, not a stale one.
  const packaged = new McpBuiltinService({ configRoot: f.root, mcp: f.service, endpoint: () => undefined, log: () => {} });
  try { assert.equal((await packaged.catalog()).length, 0); } finally { await packaged.close(); }
});
h.test('real catalog HTTP persists bounded metadata while seed identities win and remote markup is removed', async () => {
  const requests: Array<{ url?: string; auth?: string }> = [];
  const url = await remote((request, response) => { requests.push({ url: request.url, auth: request.headers.authorization });
    response.end(JSON.stringify({ items: [{ ...uv, id: 'remote', iconSvg: '<svg onload="steal()" />' }, { ...http, nameEn: 'remote collision' }, { id: 'bad', config: {} }] })); });
  const f = await fixture({}, { endpoint: () => ({ baseUrl: url, token: 'fixture-catalog-token', direct: true }) });
  const rows = await f.builtins.list() as JsonObject[];
  assert.deepEqual(requests, [{ url: '/api/v1/mcp', auth: 'Bearer fixture-catalog-token' }]);
  assert.equal(rows.length, 3); assert.equal(rows[0]!.nameEn, 'GitHub fixture'); assert.equal(rows[2]!.iconSvg, null);
  const cache = await readFile(join(f.root, 'mcp-market-catalog.json'), 'utf8'); assert(!cache.includes('onload')); assert(!cache.includes('fixture-catalog-token'));
});
h.test('failed and invalid refreshes retain the last cache without logging response bodies', async () => {
  let broken = false;
  const url = await remote((_request, response) => response.end(broken ? '{ secret-response-fixture' : JSON.stringify({ items: [{ ...uv, id: 'cached' }] })));
  const f = await fixture({}, { endpoint: () => ({ baseUrl: url, direct: false }) });
  assert.equal((await f.builtins.list() as JsonObject[]).length, 3); broken = true;
  assert.equal((await f.builtins.list() as JsonObject[]).length, 3); assert(f.logs.some(row => row.includes('Invalid JSON')));
  assert(!f.logs.join('\n').includes('secret-response-fixture'));
});
h.test('a legacy unapproved connector cache cannot resurrect market rows while offline', async () => {
  const f = await fixture({}, { seed: [] });
  await writeFile(join(f.root, 'mcp-market-catalog.json'), JSON.stringify({ items: [http] }));
  assert.deepEqual(await f.builtins.list(), []);
});
h.test('catalog requests coalesce and shutdown cancels the actual hanging HTTP owner', async () => {
  let requested = 0, disconnected = false;
  const url = await remote((_request, response) => { requested++; response.on('close', () => { disconnected = true; }); });
  const f = await fixture({}, { endpoint: () => ({ baseUrl: url, direct: true }) });
  const first = f.builtins.list(), second = f.builtins.list();
  const results = Promise.allSettled([first, second]);
  await waitFor(() => requested > 0, 1000, 'real catalog request'); await f.builtins.close();
  assert.equal(requested, 1); assert((await results).every(row => row.status === 'rejected'));
  await waitFor(() => disconnected, 1000, 'remote socket closed'); await assert.rejects(f.builtins.list());
});
h.test('builtin install and ordinary MCP creation share one versioned engine config queue', async () => {
  const f = await fixture({ untouched: true, plugins: { keep: true } });
  const results = await Promise.all([f.builtins.install({ id: 'github', env: { TOKEN: 'first-token' } }), f.service.create({ name: 'ordinary', command: 'fixture' })]);
  assert(results.every(row => object(row).ok === true)); assert.equal(Object.keys(servers(f)).length, 2);
  assert.equal(object(object(servers(f).github).headers).Authorization, 'Bearer first-token');
  assert.deepEqual(f.values().plugins, { keep: true }); assert.equal(f.values().untouched, true); assert.equal(f.changes.length, 2);
  assert.deepEqual(f.calls.filter(row => row.method === 'config/batchWrite').map(row => row.params.expectedVersion), ['0', '1']);
});
h.test('reauthorization replaces declared credentials and retains user fields and disabled-tool policy', async () => {
  const f = await fixture({ mcpServers: { github: { ...object(http.config), headers: { Authorization: 'Bearer old-token', Extra: 'keep' }, disabledTools: ['write'], timeout: 37, enabled: false } } });
  assert.equal(object(await f.builtins.install({ id: 'github', env: { TOKEN: 'new-token' } })).ok, true);
  assert.deepEqual(object(servers(f).github).headers, { Authorization: 'Bearer new-token', Extra: 'keep' });
  assert.equal(object(servers(f).github).enabled, undefined); assert.equal(object(servers(f).github).timeout, 37);
  assert.deepEqual(object(servers(f).github).disabledTools, ['write']);
});
h.test('changed transport targets and invalid environment input cannot receive new credentials', async () => {
  const f = await fixture({ mcpServers: { github: { type: 'http', url: 'https://changed.invalid/mcp', headers: { Authorization: 'old' } } } });
  const before = f.values();
  assert.match(String(object(await f.builtins.install({ id: 'github', env: { TOKEN: 'new-secret' } })).error), /target differs/);
  for (const env of [{ OTHER: 'x' }, { TOKEN: 'bad\nheader' }, { TOKEN: 2 }, { TOKEN: '' }] as JsonObject[]) assert.equal(object(await f.builtins.install({ id: 'github', env })).ok, false);
  assert.deepEqual(f.values(), before); assert.equal(f.changes.length, 0); assert(!JSON.stringify(f.calls).includes('new-secret'));
});
h.test('unknown or incomplete installations do not mutate and legal prototype names remain own data keys', async () => {
  const f = await fixture({}, { seed: [http, { ...uv, id: '__proto__' }] });
  assert.equal(object(await f.builtins.install({ id: 'missing' })).ok, false);
  assert.equal(object(await f.builtins.install({ id: 'github' })).ok, false); assert.equal(f.changes.length, 0);
  assert.equal(object(await f.builtins.install({ id: '__proto__' })).ok, true);
  assert.equal(Object.hasOwn(servers(f), '__proto__'), true); assert.equal(object(servers(f).__proto__).command, 'uvx');
});
h.test('OAuth enablement restores its declaration while preserving the existing server config', async () => {
  const entry: JsonObject = { id: 'oauth-fixture', auth: 'oauth', config: { type: 'http', url: 'https://fixture.invalid/oauth' } };
  const f = await fixture({ mcpServers: { 'oauth-fixture': { ...object(entry.config), enabled: false, timeout: 20 } } }, { seed: [entry] });
  assert.equal(object(await f.builtins.install({ id: 'oauth-fixture' })).ok, true);
  assert.deepEqual(servers(f)['oauth-fixture'], { ...object(entry.config), timeout: 20, oauth: {} });
});
h.test('an explicitly cancelled queued install never reaches a later config write', async () => {
  const f = await fixture(), controller = new AbortController(); let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const config = mcpConfigurationFixture(f.root, {}, { onChanged: async () => { entered = true; await held; } });
  const builtins = new McpBuiltinService({ configRoot: f.root, mcp: config.service, endpoint: () => undefined, seed: [http], log: () => {} });
  try {
    const first = config.service.create({ name: 'first', command: 'fixture' });
    await waitFor(() => entered, 1000, 'ordinary mutation holds shared queue');
    const installing = builtins.install({ id: 'github', env: { TOKEN: 'cancelled' } }, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(); release(); await first;
    assert.equal(object(await installing).ok, false); assert.deepEqual(Object.keys(object(config.values().mcpServers)), ['first']);
    assert.equal(config.calls.filter(row => row.method === 'config/batchWrite').length, 1);
  } finally { release(); await builtins.close(); await config.service.close(); }
});
h.test('saved configuration and failed runtime reload remain distinguishable', async () => {
  const f = await fixture();
  const config = mcpConfigurationFixture(f.root, {}, { onChanged: () => { throw new Error('fixture reload refused'); } });
  try {
    const result = object(await config.service.installBuiltin('github', http, { TOKEN: 'saved-token' }));
    assert.equal(result.ok, false); assert.equal(result.saved, true); assert.equal(result.reloadRequired, true);
    assert.equal(object(object(object(config.values().mcpServers).github).headers).Authorization, 'Bearer saved-token');
  } finally { await config.service.close(); }
});
h.test('uv detection checks actual executable files and Windows PATH conventions', async () => {
  const f = await fixture(), bin = join(f.root, 'bin'); await mkdir(bin); await writeFile(join(bin, 'uvx'), 'fixture');
  const unix = new McpBuiltinService({ configRoot: f.root, mcp: f.service, endpoint: () => undefined, log: () => {}, environment: { PATH: bin }, platform: 'darwin' });
  const windows = new McpBuiltinService({ configRoot: f.root, mcp: f.service, endpoint: () => undefined, log: () => {}, environment: { Path: 'missing;"' + bin + '"' }, platform: 'win32' });
  try {
    if (process.platform !== 'win32') { await chmod(join(bin, 'uvx'), 0o600); assert.deepEqual(await unix.uvCheck(), { available: false }); await chmod(join(bin, 'uvx'), 0o700); }
    assert.deepEqual(await unix.uvCheck(), { available: true }); assert.deepEqual(await windows.uvCheck(), { available: true });
  } finally { await unix.close(); await windows.close(); }
});
h.test('diagnostic files retain transport categories without copying credentials or URL secret paths', async () => {
  const secret = 'never-include-fixture-secret';
  const f = await fixture({ mcpServers: { remote: { type: 'http', url: `https://user:${secret}@fixture.invalid/${secret}?token=${secret}#${secret}`, headers: { Authorization: secret }, oauth: {} },
    local: { command: '/bin/fixture', args: [secret], env: { TOKEN: secret } } } });
  const diagnostics = new McpDiagnosticsService({ configRoot: f.root, mcp: f.service, environment: { HTTPS_PROXY: `https://user:${secret}@proxy.invalid/${secret}`, NO_PROXY: secret } });
  try {
    for (const name of ['remote', 'local', 'absent']) {
      const result = object(await diagnostics.bundle({ name, lastError: '401: ' + secret })); assert.equal(result.ok, true);
      const text = await readFile(String(result.logPath), 'utf8'); assert(!text.includes(secret)); assert(text.includes('lastErrorCategory: authorization'));
      assert(text.includes('env.HTTPS_PROXY: https://proxy.invalid/[path omitted]'));
      if (name === 'local') { assert(text.includes('command: fixture')); assert(text.includes('envKeys: TOKEN')); }
    }
    assert.equal(object(await diagnostics.bundle({ name: '../escape' })).ok, false);
  } finally { await diagnostics.close(); }
});
h.test('catalog and diagnostics reject managed-path escapes without writing outside the profile', async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'klaus-mcp-outside-'));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(f.root, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(object(await f.diagnostics.bundle({ name: 'fixture' })).ok, false);
  await symlink(join(outside, 'cache.json'), join(f.root, 'mcp-market-catalog.json'));
  assert.equal((await f.builtins.catalog()).length, 2); await assert.rejects(readFile(join(outside, 'cache.json')));
});
h.test('all six declared handlers route to owners and retired trust calls remain storage-free', async () => {
  const f = await fixture();
  for (const channel of ['mcp:builtin:list', 'mcp:builtin:install', 'mcp:uv:check', 'mcp:diagnose:bundle', 'mcp:trust:decide', 'mcp:trust:reset']) assert(f.registry.lookup(channel));
  for (const channel of ['mcp:trust:decide', 'mcp:trust:reset']) assert.deepEqual(await f.registry.lookup(channel)!({ channel, args: [{ cwd: '/unregistered', allowed: true }], senderId: 1, role: 'main' }), { ok: true });
  assert.deepEqual(f.calls, []);
});

void h.finish(join(__dirname, 'mcp-builtins-result.json'), 'mcp-builtins').then(async code => {
  for (const cleanup of cleanups.reverse()) await cleanup(); process.exitCode = code;
});
