// Explicit integration gate: one actual engine, a local OAuth/MCP server, and no model turn.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestAcknowledged } from '../main/engine/acknowledged';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import type { ClientEvent } from '../main/engine/protocol';
import { McpConfigurationService } from '../main/services/mcp/configuration';
import { McpOAuthService } from '../main/services/mcp/oauth';
import { McpRuntimeService } from '../main/services/mcp/runtime';
import { WorkspaceStore } from '../main/services/workspaces';
import { SerialMutations, object, string, type EngineRequest, type JsonObject } from '../main/services/service-types';
import { createMcpOAuthFixture } from './mcp-oauth';
import { Harness, assert, assertDeepEqual, assertEqual, waitFor } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the live MCP auth gate');
const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-mcp-auth-live-')), manager = new EngineManager('0.0.0-mcp-auth-live');
function credentialFingerprint(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const defaultCredentialPaths = ['credentials.enc', 'cred.key'].map(name => join(homedir(), '.klaus', name));
const defaultCredentialFingerprints = defaultCredentialPaths.map(credentialFingerprint);
const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, pickDirectory: async () => null, onSessionWorkdirChanged: () => {} });
let fixture: Awaited<ReturnType<typeof createMcpOAuthFixture>>, engine: ManagedEngine, sessionId = '', request: EngineRequest, parked = 0;
let runtimeReadsPending = 0, runtimeReadCount = 0;
const eventErrors: unknown[] = [];
const hostReloadGate = new SerialMutations(); let reloadHeld = false, controlDuringReload = false;
let holdBrowser = false, browserHeld = false;
const tracePath = join(__dirname, 'mcp-auth-live-trace.jsonl'); writeFileSync(tracePath, '');
const trace = (value: unknown): void => { appendFileSync(tracePath, JSON.stringify(value) + '\n'); };
const configuration = new McpConfigurationService({ workspaces, request: (method, params) => request(method, params), onChanged: () => {} });
const runtime = new McpRuntimeService({ configuration,
  oauth: new McpOAuthService({ credentials: { readMcpOAuthRecord: async () => { throw new Error('An engine authorization must not fall back to host credentials'); }, writeMcpOAuthRecord: async () => { throw new Error('No host credential writes in this fixture'); }, removeMcpOAuthRecord: async () => { throw new Error('No host credential deletes in this fixture'); } }, openExternal: url => fixture.openExternal(url) }),
  context: async () => ({ cwd: root, rendererId: 'mcp-auth-live-thread', engineId: sessionId || undefined, generation: engine.generation }),
  isCurrent: context => context.engineId === sessionId && context.generation === engine.generation,
  connectReadyServers: async context => (await configuration.resolvedServerSet(context.cwd)).servers,
  request: (method, params) => request(method, params), requestAcknowledged: async (method, params, field) => {
    trace({ operation: method, params, field });
    const send = () => requestAcknowledged({ requestWithTimeout: async (name, args, timeout) => { const reply = await engine.client.requestWithTimeout(name, args, timeout); trace({ method: name, reply }); return reply; }, on: (event, listener) => engine.client.on(event, listener), off: (event, listener) => engine.client.off(event, listener) }, method, params, field, 20_000);
    if (method === 'session/reloadMcpServers') return hostReloadGate.run(async () => { reloadHeld = true; try { return await send(); } finally { reloadHeld = false; } });
    if (method === 'session/resolveMcpAuthorization' && reloadHeld) controlDuringReload = true;
    return send();
  },
  openExternal: async url => { if (holdBrowser) { browserHeld = true; return; } await fixture.openExternal(url); }, onStatusChanged: () => {}, authorizationTimeoutMs: 15_000,
});
function receive(event: ClientEvent): void {
  if (event.type !== 'reverseRequest') trace(event);
  if (event.type !== 'engineEvent' && event.type !== 'rawSessionEvent') return;
  const params = object(event.params), envelope = object(params.event ?? params), auth = object(envelope.mcpAuthorization);
  if (!string(auth.requestId)) return;
  if (typeof params.sessionId === 'string') assertEqual(params.sessionId, sessionId, 'authorization event uses original engine session');
  void runtime.receiveAuthorization(auth, { cwd: root, rendererId: 'mcp-auth-live-thread', engineId: sessionId, generation: engine.generation }).then(() => { parked++; }, error => { eventErrors.push(error); });
}
async function waitForRequest(previous: number): Promise<void> { await waitFor(() => parked > previous || eventErrors.length > 0, 15_000, 'actual engine authorization parked'); assertDeepEqual(eventErrors, [], 'event bridge failures'); }

h.test('actual engine MCP authorization events complete through the browser callback and named resolver', async () => {
  fixture = await createMcpOAuthFixture();
  engine = await manager.attach({ command: binary!, args: [], cwd: root, env: [['KLAUS_CONFIG_DIR', root], ['KLAUS_SESSION_DIR', join(root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(root, 'plugins')]] });
  request = async (method, params) => {
    if (method === 'session/mcpRuntime') { runtimeReadsPending++; runtimeReadCount++; }
    try { const reply = await engine.client.requestWithTimeout(method, params, 20_000); trace({ method, reply }); return reply; }
    finally { if (method === 'session/mcpRuntime') runtimeReadsPending--; }
  }; engine.client.on('event', receive);
  const saved = object(await configuration.create({ name: 'fixture', type: 'http', url: fixture.config.url!, oauth: {} })); assertEqual(saved.ok, true, 'real user config');
  const servers = (await configuration.resolvedServerSet(root)).servers;
  const started = object(await request('session/start', { init: { cwd: root, threadId: 'mcp-auth-live-thread', mcpOauthRedirectUri: fixture.redirect, hostCapabilities: { mcpServers: servers, runtimeCapabilityRoots: [] } }, resume: null, fork: null }));
  sessionId = string(started.sessionId); assert(sessionId, 'actual session created'); await request('session/subscribe', { sessionId });
  let visible: unknown;
  const reading = runtime.status(); void reading.then(value => { visible = value; }, () => undefined); await waitForRequest(0);
  await waitFor(() => visible !== undefined, 2000, 'settings exposes unanswered authorization before the engine read finishes');
  assertEqual((visible as JsonObject[]).find(row => row.name === 'fixture')?.status, 'needs-auth', 'unanswered authorization is visible');
  assertEqual(runtimeReadsPending, 1, 'original engine snapshot is still waiting for the user'); assertEqual(fixture.opens(), 0, 'status does not answer or open authorization');
  assertEqual((await runtime.status() as JsonObject[]).find(row => row.name === 'fixture')?.status, 'needs-auth', 'repeated settings read stays usable');
  assertEqual(runtimeReadCount, 1, 'one actual runtime read remains in flight');
  assertEqual((await runtime.needsAuth() as JsonObject[])[0]?.name, 'fixture', 'actual request visible to the UI');
  const authenticating = runtime.authenticate({ name: 'fixture' });
  await request('engine/permissionRules', {});
  const auth = object(await authenticating); assertEqual(auth.status, 'authenticated', 'actual token exchange and runtime ready: ' + JSON.stringify(auth));
  await reading;
  const status = await runtime.status() as JsonObject[]; assertEqual(status.find(row => row.name === 'fixture')?.status, 'connected', 'actual MCP runtime connected');
  assertEqual(fixture.opens(), 1, 'one real local browser redirect'); assert(fixture.requests.some(row => row.path === '/token'), 'actual token request reached provider fixture');
});
h.test('real engine revoke waits for deletion and reconnect requests a new usable authorization', async () => {
  const revoked = object(await runtime.revokeAuth({ name: 'fixture' })); assertEqual(revoked.ok, true, 'actual revoke terminal: ' + JSON.stringify(revoked));
  const result = object(await runtime.authenticate({ name: 'fixture' })); assertEqual(result.status, 'authenticated', 'new named reconnect token grant: ' + JSON.stringify(result));
  assertEqual(fixture.opens(), 2, 'revoked token cannot bypass a fresh interactive grant');
});
h.test('changed configuration reload accepts the code while its host session mutation gate remains held', async () => {
  const saved = object(await configuration.update({ name: 'fixture', config: { type: 'http', url: fixture.config.url!, headers: { 'X-Fixture-Revision': '2' }, oauth: {} } }));
  assertEqual(saved.ok, true, 'changed declaration saved');
  const count = parked, reconnecting = runtime.reconnect(); void reconnecting.catch(() => undefined); await waitForRequest(count);
  assert(reloadHeld, 'the reload terminal still owns the host mutation gate');
  const result = object(await runtime.authenticate({ name: 'fixture' })); assertEqual(result.status, 'authenticated', 'grant completes through the held reload: ' + JSON.stringify(result));
  await reconnecting; assert(controlDuringReload, 'authorization code bypassed the held host reload gate');
  assertEqual(fixture.opens(), 3, 'changed identity receives its own grant');
});
h.test('a forged state declines the actual engine request and never reports authenticated', async () => {
  await runtime.revokeAuth({ name: 'fixture' }); fixture.stateMismatch(true);
  assertEqual(object(await runtime.authenticate({ name: 'fixture' })).status, 'declined', 'real state mismatch refusal');
  const status = await runtime.status() as JsonObject[]; assertEqual(status.some(row => row.name === 'fixture' && row.status === 'connected'), false, 'declined grant leaves the server disconnected');
});
h.test('MCP auth shutdown drains pending receipts and exits its only engine process', async () => {
  fixture.stateMismatch(false); holdBrowser = true; const count = parked, opens = fixture.opens(), authenticating = runtime.authenticate({ name: 'fixture' });
  await waitForRequest(count); await waitFor(() => browserHeld, 15_000, 'browser handoff is pending'); await runtime.close();
  assertEqual(object(await authenticating).status, 'declined', 'shutdown declines the engine request waiting for browser input');
  assertEqual(fixture.opens(), opens, 'shutdown does not grant a token');
  await configuration.close(); if (sessionId) await request('session/close', { sessionId }); await manager.shutdownAll();
  assertEqual(manager.liveProcessCount(), 0, 'no leaked engine process'); assertDeepEqual(eventErrors, [], 'no ignored auth event failures');
});
h.test('actual engine MCP credentials stay inside the selected profile through authorization and shutdown', () => {
  assert(readFileSync(join(root, 'credentials.enc')).length >= 28, 'the selected profile owns the encrypted credential file');
  assertEqual(readFileSync(join(root, 'cred.key')).length, 32, 'the selected profile owns its credential encryption key');
  assertDeepEqual(defaultCredentialPaths.map(credentialFingerprint), defaultCredentialFingerprints, 'the default profile credential bytes must not change');
});
void h.finish(join(__dirname, 'mcp-auth-live-result.json'), 'mcp-auth-live').then(async code => {
  await runtime.close(); await configuration.close(); await manager.shutdownAll(); await fixture?.close(); rmSync(root, { recursive: true, force: true }); process.exitCode = code;
}, async error => { await runtime.close(); await configuration.close(); await manager.shutdownAll(); await fixture?.close(); rmSync(root, { recursive: true, force: true }); throw error; });
