import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Json } from '../main/ipc/contract';
import { captureMcpOAuthCode, safeAuthorizationUrl, safeLoopbackRedirect } from '../main/services/mcp/loopback';
import { McpOAuthService } from '../main/services/mcp/oauth';
import { authorizationUrl, discoveryUrls, mcpOAuthServerKey, normalizeTokens, selectResourceUrl, type McpOAuthCredentials, type McpOAuthPart } from '../main/services/mcp/oauth-schema';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function listen(server: Server): Promise<number> { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); return (server.address() as AddressInfo).port; }
async function close(server: Server): Promise<void> { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
async function callbackUri(): Promise<string> { const server = createServer(), port = await listen(server); await close(server); return 'http://127.0.0.1:' + port + '/callback'; }
async function available(uri: string): Promise<void> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(new URL(uri).port), '127.0.0.1', resolve); }); await close(server);
}
function credentials() {
  const values = new Map<string, Json>(), operations: string[] = [];
  const id = (key: string, part: McpOAuthPart) => key + ':' + part;
  const store: McpOAuthCredentials = {
    readMcpOAuthRecord: async (key, part) => ({ value: structuredClone(values.get(id(key, part)) ?? null) }),
    writeMcpOAuthRecord: async (key, part, value) => { values.set(id(key, part), structuredClone(value)); operations.push('write:' + part); return { success: true }; },
    removeMcpOAuthRecord: async (key, part) => { values.delete(id(key, part)); operations.push('remove:' + part); return true; },
  };
  return { store, values, operations, record: (key: string, part: McpOAuthPart) => object(values.get(id(key, part))) };
}
interface Options { redirectUri?: string; stateMismatch?: boolean; dcrFailure?: boolean; tokenFailure?: boolean; metadataFailure?: boolean; wrongResource?: boolean; noExplicitMetadata?: boolean; noMetadata?: boolean; sse?: boolean; public?: boolean; invalidInitialize?: boolean; confidential?: boolean; hungProbe?: boolean }
async function fixture(options: Options = {}) {
  let base = '', stateMismatch = options.stateMismatch ?? false, invalidRefresh = false, registrations = 0, opens = 0;
  const redirect = options.redirectUri ?? await callbackUri(), requests: Array<{ path: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }> = [], authorizations: URL[] = [];
  const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', base); let body = ''; for await (const chunk of request) body += String(chunk);
      requests.push({ path: url.pathname, method: request.method!, headers: request.headers, body });
      if (url.pathname === '/scope/mcp') {
        if (options.hungProbe) return;
        if (request.method === 'GET') { response.writeHead(503, { 'content-type': 'text/html' }); response.end(' fixture\n endpoint unavailable '); return; }
        if (options.public || request.headers.authorization === 'Bearer fixture-access' || request.headers.authorization === 'Bearer refreshed-access') {
          if (options.invalidInitialize) { response.end('<html>Login page</html>'); return; }
          const message = object(JSON.parse(body));
          if (message.id === undefined) { response.writeHead(202); response.end(); return; }
          const result = { jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } : {} };
          if (options.sse) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('event: message\ndata: ' + JSON.stringify(result) + '\n\n'); return; }
          json(response, result); return;
        }
        response.writeHead(401, { 'www-authenticate': 'Bearer ' + (options.noExplicitMetadata ? '' : 'resource_metadata="' + base + '/resource-metadata", ') + 'scope="challenge.read offline_access"' }); response.end(); return;
      }
      if (url.pathname === '/resource-metadata' || (!options.noMetadata && url.pathname === '/.well-known/oauth-protected-resource')) {
        json(response, { resource: options.wrongResource ? 'https://different.invalid/resource' : base + '/scope', authorization_servers: [base + '/issuer'], scopes_supported: ['metadata.read'] }); return;
      }
      if (url.pathname.startsWith('/.well-known/')) {
        if (options.metadataFailure && url.pathname.includes('authorization-server')) { json(response, { error: 'fixture metadata down' }, 503); return; }
        if (!options.noMetadata && url.pathname === '/.well-known/oauth-authorization-server/issuer') {
          json(response, { issuer: base + '/issuer', authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', ...(options.dcrFailure ? {} : { registration_endpoint: base + '/register' }), response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: options.confidential ? ['client_secret_basic'] : ['none'] }); return;
        }
        json(response, {}, 404); return;
      }
      if (url.pathname === '/register') { registrations++; json(response, { client_id: 'fixture-client-' + registrations, ...(options.confidential ? { client_secret: 'fixture-secret' } : {}) }); return; }
      if (url.pathname === '/authorize') {
        authorizations.push(url); const target = new URL(url.searchParams.get('redirect_uri')!); target.searchParams.set('code', 'fixture-code'); target.searchParams.set('state', stateMismatch ? 'forged-state' : url.searchParams.get('state')!);
        response.writeHead(302, { location: target.href }); response.end(); return;
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'refresh_token' && invalidRefresh) { json(response, { error: 'invalid_client', error_description: 'client revoked' }, 400); return; }
        if (options.tokenFailure) { json(response, { error: 'invalid_grant', error_description: 'fixture grant rejected' }, 400); return; }
        if (params.get('grant_type') === 'authorization_code') {
          const auth = authorizations.at(-1)!;
          assertEqual(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), auth.searchParams.get('code_challenge'), 'actual PKCE proof reaches token endpoint');
          assertEqual(params.get('redirect_uri'), redirect, 'actual registered redirect');
          json(response, { access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fixture-refresh', scope: 'challenge.read', dropMe: 'unmodelled' });
        } else json(response, { access_token: 'refreshed-access', token_type: 'Bearer', expires_in: 3600 });
        return;
      }
      json(response, {}, 404);
    } catch (error) { json(response, { error: 'fixture_error', error_description: String(error) }, 500); }
  });
  base = 'http://127.0.0.1:' + await listen(server);
  const config: JsonObject = { name: 'fixture', transport: options.sse ? 'sse' : 'http', url: base + '/scope/mcp', oauth: { scopes: ['configured.read'] } };
  const openExternal = async (url: string) => { opens++; await fetch(url); };
  return { config, base, redirect, requests, authorizations, openExternal, opens: () => opens, registrations: () => registrations, stateMismatch: (value: boolean) => { stateMismatch = value; }, invalidRefresh: (value: boolean) => { invalidRefresh = value; }, close: () => close(server) };
}
export { fixture as createMcpOAuthFixture };

export function registerMcpOAuthTests(h: Harness): void {
  h.test('MCP OAuth fixed storage and PKCE vectors preserve hash material token fields and discovery order', async () => {
    for (const [name, hash] of [['ok', '1a1afb9cb7ba0e75'], ['nodiscovery', '07aff396e7a44a34'], ['faildcr', 'ea74c395a90c5695'], ['badstate', '04af6477310c763b'], ['failtoken', 'a60a0ba5f1c5da04']]) assertEqual(mcpOAuthServerKey({ name: name!, transport: 'http', url: 'http://127.0.0.1:8791/' + name + '/mcp' }), name + '|' + hash, 'fixed key vector');
    const url = new URL(authorizationUrl('https://auth.example', undefined, { client_id: 'client' }, 'http://127.0.0.1:33418/callback', 'state', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'read offline_access', 'https://mcp.example'));
    assertEqual(url.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'RFC 7636 vector');
    assertDeepEqual([...url.searchParams.keys()], ['response_type', 'client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'state', 'scope', 'prompt', 'resource'], 'query contract order');
    assertDeepEqual(Object.keys(normalizeTokens({ refresh_token: 'r', scope: 's', expires_in: 3600, access_token: 'a', token_type: 'Bearer', ignored: true })), ['access_token', 'token_type', 'expires_in', 'scope', 'refresh_token'], 'stored schema order');
    assertDeepEqual(discoveryUrls('https://auth.example/tenant/').map(row => row.url), ['https://auth.example/.well-known/oauth-authorization-server/tenant', 'https://auth.example/.well-known/openid-configuration/tenant', 'https://auth.example/tenant/.well-known/openid-configuration'], 'issuer path candidates');
    assertEqual(selectResourceUrl('https://mcp.example/api/tools#fragment', { resource: 'https://mcp.example/api' }), 'https://mcp.example/api', 'segment parent resource');
    for (const value of ['https://mcp.example/api123', 'https://other.example/api']) await assertRejects(async () => selectResourceUrl(value, { resource: 'https://mcp.example/api' }), 'resource scope mismatch');
    for (const value of ['file:///tmp/callback', 'http://public.example/callback', 'http://user:password@localhost:10/callback']) await assertRejects(async () => safeAuthorizationUrl(value), 'unsafe authorization URL');
    for (const value of ['http://127.0.0.1/callback', 'http://[::1]:33418/callback', 'http://127.0.0.1:33418/callback?state=x']) await assertRejects(async () => safeLoopbackRedirect(value), 'unsafe callback binding');
  });
  h.test('standalone MCP authorization performs real discovery DCR PKCE and token exchange before reporting ready', async () => {
    const f = await fixture({ confidential: true }), c = credentials(), service = new McpOAuthService({ credentials: c.store, openExternal: f.openExternal, redirectUri: f.redirect });
    try {
      const first = service.authenticate(f.config), second = service.authenticate(f.config); assertEqual(first, second, 'same server attempts coalesce');
      assertDeepEqual(await first, { status: 'authenticated' }, 'complete real HTTP grant');
      assertEqual(f.opens(), 1, 'one browser action'); assertEqual(f.registrations(), 1, 'one registration');
      const registration = JSON.parse(f.requests.find(row => row.path === '/register')!.body);
      assertEqual(registration.scope, 'challenge.read offline_access', 'challenge scope wins metadata and configuration'); assertDeepEqual(registration.redirect_uris, [f.redirect], 'stable callback registered');
      assertEqual(f.authorizations[0]?.searchParams.get('resource'), f.base + '/scope', 'metadata resource reaches authorization');
      const token = f.requests.find(row => row.path === '/token')!; assertEqual(token.headers.authorization, 'Basic ' + Buffer.from('fixture-client-1:fixture-secret').toString('base64'), 'confidential client uses advertised auth method');
      assertEqual(new URLSearchParams(token.body).get('client_secret'), null, 'basic secret is not duplicated in form');
      const key = mcpOAuthServerKey(f.config), bundle = c.record(key, 'tokens'); assertEqual(object(bundle.tokens).access_token, 'fixture-access', 'secure token slot'); assertEqual(object(bundle.tokens).dropMe, undefined, 'unmodelled grant data stripped');
      assert(typeof bundle.expiresAt === 'number' && bundle.expiresAt > Date.now(), 'absolute expiration'); assertDeepEqual(c.operations, ['write:discovery', 'write:client', 'write:tokens'], 'only three secure slots');
      await available(f.redirect);
    } finally { await service.close(); await f.close(); }
  });
  h.test('cached MCP grants refresh without a browser and invalid clients re-register before interactive retry', async () => {
    const f = await fixture(), c = credentials(), service = new McpOAuthService({ credentials: c.store, openExternal: f.openExternal, redirectUri: f.redirect });
    try {
      assertEqual(object(await service.authenticate(f.config)).status, 'authenticated', 'first grant'); const key = mcpOAuthServerKey(f.config);
      c.values.set(key + ':tokens', { ...c.record(key, 'tokens'), expiresAt: Date.now() + 1000 });
      assertEqual(object(await service.authenticate(f.config)).status, 'authenticated', 'proactive refresh'); assertEqual(f.opens(), 1, 'refresh opens no browser');
      assertEqual(object(c.record(key, 'tokens').tokens).refresh_token, 'fixture-refresh', 'omitted refresh token retained');
      c.values.set(key + ':tokens', { tokens: { access_token: 'expired-access', refresh_token: 'fixture-refresh' }, expiresAt: 0 }); f.invalidRefresh(true);
      assertEqual(object(await service.authenticate(f.config)).status, 'authenticated', 'invalid client recovers interactively'); assertEqual(f.registrations(), 2, 'stale client replaced'); assertEqual(f.opens(), 2, 'one fresh browser action');
      assert(c.operations.includes('remove:tokens') && c.operations.includes('remove:client'), 'stale records explicitly revoked');
    } finally { await service.close(); await f.close(); }
  });
  h.test('MCP discovery failures are visible while state and token failures decline without phantom credentials', async () => {
    for (const options of [{ dcrFailure: true }, { metadataFailure: true }, { tokenFailure: true }, { stateMismatch: true }]) {
      const f = await fixture(options), c = credentials(), service = new McpOAuthService({ credentials: c.store, openExternal: f.openExternal, redirectUri: f.redirect });
      try {
        const result = object(await service.authenticate(f.config));
        if (options.dcrFailure || options.metadataFailure) { assertEqual(result.status, 'failed', 'discovery/registration failure'); assert(string(result.error).includes('Endpoint diagnostic: HTTP 503'), 'endpoint diagnostic appended to failed state'); assertEqual(f.opens(), 0, 'no unusable authorization page'); }
        else { assertEqual(result.status, 'declined', 'interactive completion refused'); assertEqual(result.error, undefined, 'decline is not a discovery failure'); assert(string(result.authorizationUrl), 'original authorization URL available'); }
        assertEqual(c.values.has(mcpOAuthServerKey(f.config) + ':tokens'), false, 'no token after failed grant'); await available(f.redirect);
        if (options.stateMismatch) { f.stateMismatch(false); assertEqual(object(await service.authenticate(f.config)).status, 'authenticated', 'same callback port is reusable'); }
      } finally { await service.close(); await f.close(); }
    }
  });
  h.test('MCP OAuth path-aware fallback and legacy registration work without accepting mismatched resources', async () => {
    for (const options of [{ noExplicitMetadata: true }, { noMetadata: true, noExplicitMetadata: true }, { wrongResource: true }]) {
      const f = await fixture(options), c = credentials(), service = new McpOAuthService({ credentials: c.store, openExternal: f.openExternal, redirectUri: f.redirect });
      try {
        const result = object(await service.authenticate(f.config));
        if (options.wrongResource) { assertEqual(result.status, 'failed', 'foreign resource rejected'); assertEqual(f.registrations(), 0, 'no client registered for a different resource'); }
        else { assertEqual(result.status, 'authenticated', 'standard metadata fallback'); assert(f.requests.some(row => row.path === '/.well-known/oauth-protected-resource/scope/mcp'), 'path-aware discovery first'); assert(f.requests.some(row => row.path === '/.well-known/oauth-protected-resource'), 'root fallback attempted'); }
      } finally { await service.close(); await f.close(); }
    }
  });
  h.test('closing MCP OAuth aborts an unanswered loopback and reaps the actual listener', async () => {
    const f = await fixture(), c = credentials(); let opened = false;
    const service = new McpOAuthService({ credentials: c.store, openExternal: async () => { opened = true; }, redirectUri: f.redirect });
    try {
      const pending = service.authenticate(f.config); await waitFor(() => opened, 3000, 'browser handoff reached'); await service.close();
      assertEqual(object(await pending).status, 'declined', 'shutdown declines grant'); await available(f.redirect);
      assertEqual(c.values.has(mcpOAuthServerKey(f.config) + ':tokens'), false, 'cancelled grant not stored'); assertEqual(object(await service.authenticate(f.config)).status, 'failed', 'closed service refuses new work');
    } finally { await service.close(); await f.close(); }
  });
  h.test('MCP close waits for a secure token write and removes the late committed token before settling', async () => {
    const f = await fixture(), c = credentials(), ready = deferred(); let writing = false, closed = false;
    const write = c.store.writeMcpOAuthRecord; c.store.writeMcpOAuthRecord = async (key, part, value) => { if (part === 'tokens') { writing = true; await ready.promise; } return write(key, part, value); };
    const service = new McpOAuthService({ credentials: c.store, openExternal: f.openExternal, redirectUri: f.redirect });
    try {
      const pending = service.authenticate(f.config); await waitFor(() => writing, 3000, 'native token write in progress'); const closing = service.close().then(() => { closed = true; });
      assertEqual(closed, false, 'shutdown waits native completion'); ready.resolve(); await closing;
      assertEqual(object(await pending).status, 'declined', 'late completion cannot authorize'); assertEqual(c.values.has(mcpOAuthServerKey(f.config) + ':tokens'), false, 'late token removed'); assert(c.operations.includes('remove:tokens'), 'removal is actual secure mutation');
    } finally { ready.resolve(); await service.close(); await f.close(); }
  });
  h.test('MCP OAuth readiness requires a real initialize response and SSE completion stays bounded', async () => {
    for (const options of [{ public: true, invalidInitialize: true }, { public: true, sse: true }, { hungProbe: true }]) {
      const f = await fixture(options), c = credentials(), service = new McpOAuthService({ credentials: c.store, openExternal: f.openExternal, redirectUri: f.redirect, requestTimeoutMs: 150 });
      try {
        const started = Date.now(), result = object(await service.authenticate({ ...f.config, oauth: false }));
        assertEqual(result.status, options.sse ? 'not-needed' : 'failed', 'HTML or stalled POST cannot claim a usable server'); assert(Date.now() - started < 2000, 'network and SSE body bounded');
      } finally { await service.close(); await f.close(); }
    }
  });
  h.test('secure MCP storage errors remain visible and cannot fall back to a fresh grant', async () => {
    const f = await fixture(), c = credentials(); c.store.readMcpOAuthRecord = async () => ({ value: null, error: 'credential_keychain_locked' });
    const service = new McpOAuthService({ credentials: c.store, openExternal: f.openExternal, redirectUri: f.redirect });
    try { assertDeepEqual(await service.authenticate(f.config), { status: 'failed', error: 'credential_keychain_locked' }, 'secure read failure'); assertEqual(f.requests.length, 0, 'no network before failed credential read'); }
    finally { await service.close(); await f.close(); }
  });
  h.test('MCP loopback refuses unsafe URLs missing state duplicate callback state and browser failure', async () => {
    const redirect = await callbackUri(), signal = new AbortController().signal; let opens = 0;
    assertDeepEqual(await captureMcpOAuthCode('file:///tmp/anything', redirect, signal, async () => { opens++; }), { kind: 'decline', reason: 'rust_mcp_oauth_redirect_invalid' }, 'unsafe URL never opens');
    assertDeepEqual(await captureMcpOAuthCode('https://auth.example/authorize', redirect, signal, async () => { opens++; }), { kind: 'decline', reason: 'rust_mcp_oauth_state_missing' }, 'state missing'); assertEqual(opens, 0, 'no browser for invalid request');
    assertDeepEqual(await captureMcpOAuthCode('https://auth.example/authorize?state=one', redirect, signal, async () => { throw new Error('browser refused'); }), { kind: 'decline', reason: 'rust_mcp_oauth_browser_open_failed' }, 'browser refusal surfaced');
    const duplicate = captureMcpOAuthCode('https://auth.example/authorize?state=one', redirect, signal, async () => { await fetch(redirect + '?code=ok&state=one&state=two'); });
    assertDeepEqual(await duplicate, { kind: 'decline', reason: 'rust_mcp_oauth_state_mismatch' }, 'ambiguous callback state rejected'); await available(redirect);
  });
}
