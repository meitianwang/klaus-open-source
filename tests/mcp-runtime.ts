import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChannelRegistry } from '../main/ipc/registry';
import { MCP_RUNTIME_CHANNELS, registerMcpRuntimeHandlers } from '../main/ipc/handlers/mcp-runtime';
import { McpOAuthService } from '../main/services/mcp/oauth';
import { mcpToolRequiresApproval, type McpRuntimeContext, type McpRuntimeDeps } from '../main/services/mcp/runtime';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function callbackUri(): Promise<string> { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return 'http://127.0.0.1:' + port + '/callback'; }
function fixture(extra: Partial<McpRuntimeDeps> = {}) {
  let context: McpRuntimeContext = { cwd: '/fixture/project', rendererId: 'renderer', engineId: 'engine', generation: 1 }, current = true;
  const requests: Array<{ method: string; params: JsonObject; field?: string }> = [], changes: Array<string | undefined> = [];
  const servers: JsonObject[] = [{ name: 'fixture', state: 'ready', authStatus: 'oAuth', tools: [{ name: 'mcp__fixture__read', description: 'Read', exposure: 'deferred' }], prompts: [{ name: 'summary', description: 'Summarize' }] }];
  const registry = new ChannelRegistry();
  const service = registerMcpRuntimeHandlers(registry, {
    configuration: { resolvedServerSet: async () => ({ servers: [{ name: 'fixture', transport: 'stdio', command: 'unused', disabledTools: ['write'] }], skipped: [{ name: 'off', scope: 'user', reason: 'disabled' }] }), oauthServerConfig: async () => undefined },
    oauth: { authenticate: async () => { throw new Error('Host OAuth is not expected in this fixture'); }, cancel: async () => {}, close: async () => {} },
    context: async () => ({ ...context }), isCurrent: value => current && value.engineId === context.engineId && value.rendererId === context.rendererId && value.generation === context.generation,
    connectReadyServers: async (value): Promise<JsonObject[]> => { assertEqual(value.rendererId, 'renderer', 'host-managed servers use the renderer identity'); return [{ name: 'fixture', command: 'unused', transport: 'stdio' }, { name: 'host-browser', transport: 'http', url: 'http://127.0.0.1:1/mcp?session=renderer' }]; },
    request: async (method, params) => { requests.push({ method, params: object(params) }); if (method === 'engine/permissionRules') return { ask: ['mcp__fixture__wr*'] }; if (method === 'session/mcpRuntime') return { mcpRuntime: { runtime: { servers } } }; if (method === 'session/mcpAuthorizationStatus') return { mcpAuthorizationStatus: { authStatus: 'oAuth' } }; throw new Error('Unexpected request ' + method); },
    requestAcknowledged: async (method, params, field) => {
      requests.push({ method, params, field });
      if (method === 'session/reloadMcpServers') return { runtime: { servers } };
      if (method === 'session/revokeMcpAuthorization') return { serverName: params.serverName, authStatus: 'notLoggedIn', revoked: true };
      if (method === 'session/resolveMcpAuthorization') return { requestId: params.requestId, accepted: object(params.response).kind === 'code' };
      throw new Error('Unexpected mutation ' + method);
    },
    openExternal: async () => {}, onStatusChanged: cwd => { changes.push(cwd); }, ...extra,
  });
  return { service, registry, requests, servers, changes, context: () => ({ ...context }), setContext: (value: McpRuntimeContext) => { context = value; }, current: (value: boolean) => { current = value; } };
}

export function registerMcpRuntimeTests(h: Harness): void {
  h.test('MCP runtime registers five real channels and cold settings reads never create a session', async () => {
    const f = fixture(); f.setContext({ cwd: '/fixture/project' });
    try {
      assertDeepEqual(f.registry.channels(), [...MCP_RUNTIME_CHANNELS].sort(), 'actual registrar ownership');
      assertDeepEqual(await f.service.status(), [{ name: 'off', status: 'disconnected', toolCount: 0, tools: [] }], 'cold state contains declared skipped rows only');
      assertDeepEqual(await f.service.needsAuth(), [], 'no invented pending auth'); assertEqual(f.requests.length, 0, 'no query activates an engine session');
      assertEqual(await f.service.reconnect(), null, 'cold reconnect is a harmless no-op');
      assertEqual(f.requests.length, 0, 'cold reconnect never activates an engine session');
      assertDeepEqual(f.changes, ['/fixture/project'], 'cold reconnect still refreshes the visible status surface');
      assertDeepEqual(await f.service.revokeAuth({ name: '' }), { ok: false, error: 'rust_mcp_authorization_requires_session' }, 'compatible missing binding error');
    } finally { await f.service.close(); }
  });
  h.test('MCP runtime unwraps named snapshots and projects denied tools approval rules and scoped prompt cache', async () => {
    const f = fixture();
    try {
      const rows = await f.service.status() as JsonObject[], tools = rows[0]!.tools as JsonObject[];
      assertDeepEqual(tools.map(tool => [tool.name, tool.enabled, tool.approval]), [['mcp__fixture__read', true, 'auto'], ['mcp__fixture__write', false, 'ask']], 'disabled tool remains visible');
      assertEqual(rows[0]?.authStatus, 'oAuth', 'wire OAuth status retained');
      assertDeepEqual(f.service.promptRows('renderer'), [{ name: 'mcp:fixture:summary', displayName: 'fixture/summary', description: 'Summarize', scope: 'global', type: 'prompt', source: 'mcp' }], 'actual prompt cache shape');
      assertDeepEqual(f.service.promptRows('other-renderer'), [], 'prompts never leak across renderer bindings');
      f.current(false); assertDeepEqual(f.service.promptRows('renderer'), [], 'stale generation cache hidden'); await assertRejects(() => f.service.status(), 'stale snapshot rejected');
      assert(mcpToolRequiresApproval(['mcp__Fixture'], 'mcp__fixture__read'), 'server rule'); assert(mcpToolRequiresApproval(['mcp__fixture__wr*(ignored)'], 'mcp__fixture__write'), 'argument text stripped');
      assertEqual(mcpToolRequiresApproval(['mcp__*', 'mcp__fixt*'], 'mcp__fixture__read'), false, 'invalid broad prefixes never claim an ask rule');
    } finally { await f.service.close(); }
  });
  h.test('malformed MCP or permission snapshots reject instead of clearing cache or claiming automatic approval', async () => {
    for (const bad of ['runtime', 'permissions']) {
      let fail = false;
      const f = fixture({ request: async method => method === 'session/mcpRuntime' ? { mcpRuntime: { runtime: { servers: fail && bad === 'runtime' ? [null] : [{ name: 'fixture', state: 'ready', tools: [], prompts: [{ name: 'saved' }] }] } } } : { ask: fail && bad === 'permissions' ? [1] : [] } });
      try { await f.service.status(); fail = true; await assertRejects(() => f.service.status(), 'malformed facade response refused'); assertEqual(f.service.promptRows('renderer')[0]?.name, 'mcp:fixture:saved', 'previous prompt cache retained'); }
      finally { await f.service.close(); }
    }
  });
  h.test('MCP reload waits for its terminal runtime and carries every correctly bound host-managed server', async () => {
    const gate = deferred(); let entered = false, completed = false;
    const f = fixture({ requestAcknowledged: async (method, params, field) => { assertEqual(method, 'session/reloadMcpServers', 'named reload'); assertEqual(field, 'mcpRuntime', 'terminal field'); assertDeepEqual((params.servers as JsonObject[]).map(row => row.name), ['fixture', 'host-browser'], 'full composed server set'); entered = true; await gate.promise; return { runtime: { servers: [] } }; } });
    try {
      const pending = f.service.reconnect().then(value => { completed = true; return value; }); await waitFor(() => entered, 1000, 'reload accepted'); assertEqual(completed, false, 'ACK is not completion'); assertEqual(f.changes.length, 0, 'no early status notification');
      gate.resolve(); assertEqual(await pending, null, 'void renderer result after terminal'); assertEqual(f.changes.length, 1, 'only actual completion updates status');
    } finally { gate.resolve(); await f.service.close(); }
  });
  h.test('MCP status exposes received authorization without blocking its button and tracks one original read through close', async () => {
    const snapshot = deferred(), cancel = deferred(); let reads = 0, cancelling = false, closed = false;
    const f = fixture({ request: async method => {
      if (method === 'engine/permissionRules') return { ask: [] };
      assertEqual(method, 'session/mcpRuntime', 'only the named snapshot'); reads++; await snapshot.promise;
      return { mcpRuntime: { runtime: { servers: [{ name: 'fixture', state: 'needs-auth', tools: [], prompts: [{ name: 'late' }] }] } } };
    }, requestAcknowledged: async (method, params) => {
      assertEqual(method, 'session/resolveMcpAuthorization', 'close resolves the original receipt'); cancelling = true; await cancel.promise; snapshot.resolve(); return { requestId: params.requestId, accepted: false };
    } });
    try {
      const reading = f.service.status(); await waitFor(() => reads === 1, 1000, 'engine read started');
      await f.service.receiveAuthorization({ requestId: 'status-auth', serverName: 'fixture', authorizationUrl: 'https://auth.example?state=nonce', redirectUri: 'http://127.0.0.1:33418/callback' }, f.context());
      const rows = await reading as JsonObject[]; assertEqual(rows[0]?.status, 'needs-auth', 'button can render before a browser reply'); assertEqual(rows[0]?.klausNeedsAuth, true, 'UI auth state');
      assertEqual((await f.service.status() as JsonObject[])[0]?.status, 'needs-auth', 'next poll joins the same read'); assertEqual(reads, 1, 'no duplicate actual snapshot');
      assertDeepEqual(f.service.promptRows('renderer'), [], 'synthetic auth row is never cached as runtime');
      const closing = f.service.close().then(() => { closed = true; }); await waitFor(() => cancelling, 1000, 'close begins authorization cancellation');
      assertEqual(closed, false, 'close still tracks the original engine read'); cancel.resolve(); await closing;
      assertDeepEqual(f.service.promptRows('renderer'), [], 'late snapshot cannot repopulate a closed cache');
    } finally { cancel.resolve(); snapshot.resolve(); await f.service.close(); }
  });
  h.test('MCP revoke preserves a negative terminal outcome and malformed ACKs cannot succeed', async () => {
    for (const reply of [{ revoked: false }, { submissionId: 'ack-only' }]) {
      const f = fixture({ requestAcknowledged: async () => reply });
      try { const result = object(await f.service.revokeAuth({ name: 'fixture' })); assertEqual(result.ok, false, 'no default successful revoke'); if ('submissionId' in reply) assert(string(result.error).includes('Invalid MCP revoke'), 'missing terminal field explained'); }
      finally { await f.service.close(); }
    }
  });
  h.test('pending MCP authorization returns success only after the original engine server actually becomes ready', async () => {
    const redirect = await callbackUri(); let ready = false, resolved = false, completed = false;
    const f = fixture({ openExternal: async url => { const state = new URL(url).searchParams.get('state'); await fetch(redirect + '?code=fixture&state=' + state); },
      request: async method => { assertEqual(method, 'session/mcpRuntime', 'completion is queried by name'); return { mcpRuntime: { runtime: { servers: [{ name: 'fixture', state: ready ? 'ready' : 'connecting', tools: [] }] } } }; },
      requestAcknowledged: async (method, params, field) => { assertEqual(method, 'session/resolveMcpAuthorization', 'original request answered'); assertEqual(params.sessionId, 'engine', 'engine binding retained'); assertEqual(params.requestId, 'engine-request', 'raw engine request identity'); assertEqual(field, 'mcpAuthorizationResolved', 'resolution terminal'); resolved = true; return { requestId: params.requestId, accepted: true }; } });
    try {
      await f.service.receiveAuthorization({ requestId: 'engine-request', serverName: 'fixture', authorizationUrl: 'https://auth.example/authorize?state=nonce', redirectUri: redirect }, f.context());
      assertDeepEqual(await f.service.needsAuth(), [{ name: 'fixture', authorizationUrl: 'https://auth.example/authorize?state=nonce', state: 'needs-auth' }], 'pending UI row');
      const pending = f.service.authenticate({ name: 'fixture' }).then(value => { completed = true; return value; });
      await waitFor(() => resolved, 1000, 'authorization code accepted'); assertEqual(completed, false, 'accepted code does not imply a usable token'); ready = true;
      assertDeepEqual(await pending, { status: 'authenticated' }, 'ready runtime completes login'); assertDeepEqual(await f.service.needsAuth(), [], 'settled request removed');
    } finally { await f.service.close(); }
  });
  h.test('MCP pending state mismatch declines exactly once and closing aborts an unanswered browser', async () => {
    for (const mismatch of [true, false]) {
      const redirect = await callbackUri(); let opened = false;
      const f = fixture({ openExternal: async () => { opened = true; if (mismatch) await fetch(redirect + '?code=fixture&state=forged'); } });
      try {
        await f.service.receiveAuthorization({ requestId: 'pending', serverName: 'fixture', authorizationUrl: 'https://auth.example/authorize?state=nonce', redirectUri: redirect }, f.context());
        const pending = f.service.authenticate({ name: 'fixture' }); await waitFor(() => opened, 1000, 'browser handoff'); if (!mismatch) await f.service.close();
        const result = object(await pending); assertEqual(result.status, 'declined', 'non-code outcome declined');
        const resolutions = f.requests.filter(row => row.method === 'session/resolveMcpAuthorization'); assertEqual(resolutions.length, 1, 'one engine resolution'); assertEqual(object(resolutions[0]!.params.response).kind, 'decline', 'no forged code accepted');
      } finally { await f.service.close(); }
    }
  });
  h.test('MCP reauthentication reconnects the live server and coalesces clicks until its actual terminal', async () => {
    const redirect = await callbackUri(), code = deferred(), terminal = deferred(); let entered = false, answered = false, completed = false, reconnects = 0, opens = 0;
    const f = fixture({
      request: async method => method === 'session/mcpAuthorizationStatus' ? { mcpAuthorizationStatus: { authStatus: 'notLoggedIn' } } : { mcpRuntime: { runtime: { servers: [{ name: 'fixture', state: answered ? 'ready' : 'connecting', tools: [] }] } } },
      openExternal: async url => { opens++; await fetch(redirect + '?code=fixture&state=' + new URL(url).searchParams.get('state')); },
      requestAcknowledged: async (method, params, field) => {
        if (method === 'session/reconnectMcpServer') {
          assertEqual(field, 'mcpRuntime', 'reconnect terminal'); assertEqual(params.sessionId, 'engine', 'original engine binding'); reconnects++; entered = true;
          await f.service.receiveAuthorization({ requestId: 'reconnect-auth', serverName: 'fixture', authorizationUrl: 'https://auth.example?state=nonce', redirectUri: redirect }, f.context());
          await code.promise; await terminal.promise; return { runtime: { servers: [{ name: 'fixture', state: 'ready', tools: [] }] } };
        }
        assertEqual(method, 'session/resolveMcpAuthorization', 'authorization control crosses the waiting reconnect'); assertEqual(params.requestId, 'reconnect-auth', 'original request retained');
        assertEqual(object(params.response).kind, 'code', 'actual loopback code'); answered = true; code.resolve(); return { requestId: params.requestId, accepted: true };
      },
    });
    try {
      const first = f.service.authenticate({ name: 'fixture' }).then(result => { completed = true; return result; }); await waitFor(() => entered, 1000, 'reconnect started');
      const second = f.service.authenticate({ name: 'fixture' }); await waitFor(() => answered, 1000, 'code accepted');
      assertEqual(completed, false, 'resolved authorization still waits reconnect terminal'); terminal.resolve();
      assertEqual(object(await first).status, 'authenticated', 'live server connected'); assertEqual(object(await second).status, 'authenticated', 'coalesced caller result');
      assertEqual(reconnects, 1, 'one named reconnect'); assertEqual(opens, 1, 'one browser flow');
    } finally { code.resolve(); terminal.resolve(); await f.service.close(); }
  });
  h.test('closing a live reconnect before its late authorization receipt declines and drains the original operation', async () => {
    const incoming = deferred(), resolved = deferred(); let entered = false, closed = false, declines = 0, opens = 0;
    const f = fixture({ request: async () => ({ mcpAuthorizationStatus: { authStatus: 'notLoggedIn' } }), openExternal: async () => { opens++; },
      requestAcknowledged: async (method, params) => {
        if (method === 'session/reconnectMcpServer') {
          entered = true; await incoming.promise;
          await f.service.receiveAuthorization({ requestId: 'late-auth', serverName: 'fixture', authorizationUrl: 'https://auth.example?state=nonce', redirectUri: 'http://127.0.0.1:33418/callback' }, f.context());
          await resolved.promise; return { runtime: { servers: [{ name: 'fixture', state: 'needs-auth', tools: [] }] } };
        }
        assertEqual(method, 'session/resolveMcpAuthorization', 'late control uses the original named resolver'); assertEqual(object(params.response).kind, 'decline', 'late receipt never authorizes');
        declines++; resolved.resolve(); return { requestId: params.requestId, accepted: false };
      },
    });
    try {
      const pending = f.service.authenticate({ name: 'fixture' }); await waitFor(() => entered, 1000, 'reconnect accepted'); const closing = f.service.close().then(() => { closed = true; });
      assertEqual(closed, false, 'close waits accepted reconnect'); incoming.resolve(); await closing;
      assertEqual(object(await pending).status, 'declined', 'cancelled reconnect result'); assertEqual(declines, 1, 'one late decline'); assertEqual(opens, 0, 'cancelled flow never opens a browser');
    } finally { incoming.resolve(); resolved.resolve(); await f.service.close(); }
  });
  h.test('MCP receipts retain generation identity and incomplete events are answered instead of parked forever', async () => {
    const f = fixture({ authorizationTimeoutMs: 40 });
    try {
      const old = f.context(); await f.service.receiveAuthorization({ requestId: 'reused', serverName: 'fixture', authorizationUrl: 'https://auth.example?state=s', redirectUri: 'http://127.0.0.1:33418/callback' }, old);
      f.setContext({ ...old, generation: 2 }); await f.service.retire(old); assertEqual(f.requests.length, 0, 'old generation is not resolved through replacement endpoint');
      await f.service.receiveAuthorization({ requestId: 'reused', serverName: 'fixture' }, f.context());
      const resolution = f.requests.find(row => row.method === 'session/resolveMcpAuthorization'); assertEqual(resolution?.params.requestId, 'reused', 'current request answered'); assertEqual(object(resolution?.params.response).reason, 'mcp_authorization_request_incomplete', 'incomplete request declined');
      await f.service.receiveAuthorization({ requestId: 'timeout', serverName: 'fixture', authorizationUrl: 'https://auth.example?state=s', redirectUri: 'http://127.0.0.1:33418/callback' }, f.context());
      await waitFor(() => f.requests.filter(row => row.method === 'session/resolveMcpAuthorization').length === 2, 1000, 'unopened request expires');
      assertDeepEqual(await f.service.needsAuth(), [], 'expired request removed');
    } finally { await f.service.close(); }
  });
  h.test('MCP authenticate reports rejected stored credentials instead of a silent not-needed', async () => {
    const f = fixture({ request: async method => method === 'session/mcpAuthorizationStatus'
      ? { mcpAuthorizationStatus: { authStatus: 'bearerToken' } }
      : { mcpRuntime: { runtime: { servers: [{ name: 'fixture', state: 'needs-auth', tools: [] }] } } } });
    try {
      assertDeepEqual(await f.service.authenticate({ name: 'fixture' }), { status: 'failed', error: 'rust_mcp_credentials_rejected' }, 'credential store versus runtime mismatch is a visible failure');
    } finally { await f.service.close(); }
  });
  h.test('MCP authentication recognizes the actual oAuth status and cold fallback runs the real host HTTP stack', async () => {
    const known = fixture(); try { assertDeepEqual(await known.service.authenticate({ name: 'fixture' }), { status: 'not-needed' }, 'actual enum spelling'); } finally { await known.service.close(); }
    const server = createServer((request, response) => { request.resume(); request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } })); }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/mcp';
    const oauth = new McpOAuthService({ credentials: { readMcpOAuthRecord: async () => ({ value: null }), writeMcpOAuthRecord: async () => { throw new Error('No grant expected'); }, removeMcpOAuthRecord: async () => { throw new Error('No grant expected'); } }, openExternal: async () => { throw new Error('Public server opens no browser'); } });
    const f = fixture({ oauth, configuration: { resolvedServerSet: async () => ({ servers: [], skipped: [] }), oauthServerConfig: async name => ({ name, transport: 'http', url, enabled: false }) } }); f.setContext({ cwd: '/fixture/project' });
    try { assertDeepEqual(await f.service.authenticate({ name: 'public' }), { status: 'not-needed' }, 'cold auth uses actual HTTP initialize'); assertEqual(f.requests.length, 0, 'no invented temporary engine session'); }
    finally { await f.service.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
}
