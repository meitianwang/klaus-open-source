// Explicit native integration gate. Only a fixture addon may satisfy this entry point.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { McpOAuthService } from '../main/services/mcp/oauth';
import { mcpOAuthServerKey, type McpOAuthCredentials } from '../main/services/mcp/oauth-schema';
import { object, type JsonObject } from '../main/services/service-types';
import { createMcpOAuthFixture } from './mcp-oauth';
import { Harness, assert, assertDeepEqual, assertEqual, waitFor } from './harness';

interface Credentials extends McpOAuthCredentials { close(deadlineMs?: number): Promise<{ complete: boolean; pendingOperations: string[] }> }
interface AdapterModule { NativeSubscriptionCredentials: new (options: { configRoot: string; userHome: string }, injected: { resourceId: string; binding: unknown }) => Credentials }
interface FixtureAddon { createCredentialFixture: (resourceId: string, options: string, seed: string, latencyMs: number) => unknown }
const addonPath = process.env.KLAUS_CREDENTIAL_FIXTURE_ADDON, adapterPath = process.env.KLAUS_CREDENTIAL_FIXTURE_ADAPTER;
if (!addonPath || !adapterPath || !isAbsolute(addonPath) || !isAbsolute(adapterPath)) throw new Error('Absolute KLAUS_CREDENTIAL_FIXTURE_ADDON and KLAUS_CREDENTIAL_FIXTURE_ADAPTER are required');
const addon = require(addonPath) as FixtureAddon, adapter = require(adapterPath) as AdapterModule;
if (typeof addon.createCredentialFixture !== 'function') throw new Error('This gate refuses an addon without the isolated credential fixture backend');
const h = new Harness();
async function setup(latencyMs = 0) {
  const root = mkdtempSync(join(tmpdir(), 'klaus-mcp-oauth-native-')), options = { configRoot: root, userHome: root }, resourceId = randomUUID();
  const binding = addon.createCredentialFixture(resourceId, JSON.stringify({ ...options, platform: 'darwin', account: 'fixture-user' }), '[]', latencyMs);
  const credentials = new adapter.NativeSubscriptionCredentials(options, { resourceId, binding }), provider = await createMcpOAuthFixture();
  const service = new McpOAuthService({ credentials, openExternal: provider.openExternal, redirectUri: provider.redirect });
  return { root, credentials, provider, service, key: mcpOAuthServerKey(provider.config), close: async () => {
    await service.close(); const result = await credentials.close(10_000); assertEqual(result.complete, true, 'native worker drains after the HTTP service'); assertDeepEqual(result.pendingOperations, [], 'native operations drained');
    await provider.close(); rmSync(root, { recursive: true, force: true });
  } };
}
h.test('actual HTTP OAuth persists discovery client and token records through the native serial worker', async () => {
  const f = await setup();
  try {
    assertDeepEqual(await f.service.authenticate(f.provider.config), { status: 'authenticated' }, 'HTTP and native grant completes');
    const records: JsonObject = {};
    for (const part of ['discovery', 'client', 'tokens'] as const) { const result = await f.credentials.readMcpOAuthRecord(f.key, part); assertEqual(result.error, undefined, 'native ' + part + ' read'); records[part] = result.value; }
    assertEqual(object(records.discovery).authorizationServerUrl, f.provider.base + '/issuer', 'native discovery schema');
    assertEqual(object(records.client).client_id, 'fixture-client-1', 'native client schema');
    assertEqual(object(object(records.tokens).tokens).access_token, 'fixture-access', 'native token bundle schema');
    assertEqual(existsSync(join(f.root, '.mcp-credentials.json')), false, 'no new plaintext fallback');
  } finally { await f.close(); }
});
h.test('actual native cached grants refresh without a browser and explicit removal cannot resurrect them', async () => {
  const f = await setup();
  try {
    assertEqual(object(await f.service.authenticate(f.provider.config)).status, 'authenticated', 'initial native grant');
    const previous = object((await f.credentials.readMcpOAuthRecord(f.key, 'tokens')).value);
    assertEqual((await f.credentials.writeMcpOAuthRecord(f.key, 'tokens', { ...previous, expiresAt: 0 })).success, true, 'actual expired native bundle');
    assertEqual(object(await f.service.authenticate(f.provider.config)).status, 'authenticated', 'HTTP refresh plus native save');
    assertEqual(f.provider.opens(), 1, 'refresh never opens a second browser');
    assertEqual(object(object((await f.credentials.readMcpOAuthRecord(f.key, 'tokens')).value).tokens).access_token, 'refreshed-access', 'refreshed native token');
    assertEqual(await f.credentials.removeMcpOAuthRecord(f.key, 'tokens'), true, 'actual native removal');
    assertDeepEqual(await f.credentials.readMcpOAuthRecord(f.key, 'tokens'), { value: null }, 'removed token stays absent');
  } finally { await f.close(); }
});
h.test('closing HTTP authorization during a native token write rolls the late token back before worker shutdown', async () => {
  const f = await setup(50), write = f.credentials.writeMcpOAuthRecord.bind(f.credentials); let writing = false;
  f.credentials.writeMcpOAuthRecord = (key, part, value) => { const pending = write(key, part, value); if (part === 'tokens') writing = true; return pending; };
  try {
    const pending = f.service.authenticate(f.provider.config); await waitFor(() => writing, 10_000, 'native token write accepted'); await f.service.close();
    assertEqual(object(await pending).status, 'declined', 'late write does not authorize');
    const record = await f.credentials.readMcpOAuthRecord(f.key, 'tokens'); assertEqual(record.error, undefined, 'native read after HTTP close'); assertEqual(record.value, null, 'late native token was removed');
    assert(f.provider.requests.some(row => row.path === '/token'), 'real token response preceded the native cancellation');
  } finally { await f.close(); }
});
void h.finish(join(__dirname, 'mcp-oauth-native-result.json'), 'mcp-oauth-native').then(code => { process.exitCode = code; });
