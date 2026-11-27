import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { resolveServerTables } from '../main/services/mcp/entries';

const file = 'google-workspace-mcp.cjs';
const resourcesRoot = join(__dirname, '..', '..', 'resources');
const script = join(resourcesRoot, 'mcp-servers', file);

test('resolves bundled runtime arguments without allowing reserved path traversal', () => {
  const command = '@klaus/runtime-node';
  const entry = { command, args: [`@klaus/mcp-servers/${file}`, '--service', 'gmail'], env: { KEEP_ME: 'yes' } };
  const { servers, skipped } = resolveServerTables({ workspace: entry, invalid: { ...entry, args: ['@klaus/mcp-servers/../evil.cjs'] }, unknown: { ...entry, command: '@klaus/other' } }, {}, {}, {
    resourcesRoot, execPath: process.execPath, isElectron: true, configRoot: resourcesRoot, marketBaseUrl: 'https://example.test',
  });
  assert.deepEqual(servers, [{ name: 'workspace', transport: 'stdio', command: process.execPath, args: [script, '--service', 'gmail'], env: {
    KEEP_ME: 'yes', ELECTRON_RUN_AS_NODE: '1', KLAUS_CONFIG_ROOT: resourcesRoot, KLAUS_MARKET_BASE_URL: 'https://example.test',
  } }]);
  assert.deepEqual(skipped.map(row => row.name), ['invalid', 'unknown']);
});

const calls = {
  gmail: [['gmail_search_messages', { query: 'is:unread' }, 'GET', '/gmail/v1/users/me/messages?q=is%3Aunread']],
  calendar: [['calendar_get_event', { eventId: 'event/1' }, 'GET', '/calendar/v3/calendars/primary/events/event%2F1']],
  drive: [
    ['drive_read_file_content', { fileId: 'notes' }, 'GET', '/drive/v3/files/notes/export?mimeType=text%2Fplain'],
    ['docs_get_document', { documentId: 'doc' }, 'GET', '/v1/documents/doc'],
    ['sheets_append_rows', { spreadsheetId: 'book', range: 'Sheet1!A1', values: [['hello']] }, 'POST', '/v4/spreadsheets/book/values/Sheet1!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'],
  ],
} as const;

for (const [service, examples] of Object.entries(calls)) {
  test(`${service} stdio handshake, token refresh and tools`, { timeout: 10000 }, async t => {
    const observed: Array<{ method?: string; url?: string; authorization?: string; body: string }> = [];
    const local = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      observed.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      if (req.url?.includes('/export?')) { res.end('exported text'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/token' ? { access_token: 'fixture-access', expires_in: 3600 }
        : req.url?.endsWith('?fields=mimeType') ? { mimeType: 'application/vnd.google-apps.document' } : { ok: true }));
    });
    t.after(() => { local.close(); });
    local.listen(0, '127.0.0.1');
    await once(local, 'listening');
    const address = local.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const child = spawn(process.execPath, [script, '--service', service], { env: {
      ELECTRON_RUN_AS_NODE: '1',
      GOOGLE_REFRESH_TOKEN: 'fixture-refresh', KLAUS_GOOGLE_OAUTH_CLIENT_ID: 'fixture-client', KLAUS_GOOGLE_OAUTH_CLIENT_SECRET: 'fixture-secret',
      KLAUS_GOOGLE_TOKEN_URL: `${base}/token`, KLAUS_GOOGLE_API_BASE_URL: base,
    } });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exited = once(child, 'close');
    t.after(async () => { child.kill(); await exited; });
    let id = 0;
    async function rpc(method: string, params?: object) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`);
      const line = await lines.next();
      assert(!line.done, stderr);
      const response = JSON.parse(line.value);
      assert.equal(response.id, id);
      assert.equal(response.error, undefined);
      return response.result;
    }
    assert.equal((await rpc('initialize')).protocolVersion, '2024-11-05');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    assert.deepEqual(await rpc('ping'), {});
    const { tools } = await rpc('tools/list');
    assert.equal(tools.length, service === 'drive' ? 12 : 7);
    assert.equal(observed.length, 0);
    for (const [name, args, method, url] of examples) {
      assert(tools.some((tool: { name: string; inputSchema?: object; annotations?: { readOnlyHint?: boolean } }) => tool.name === name && tool.inputSchema && tool.annotations?.readOnlyHint === (name !== 'sheets_append_rows')));
      const result = await rpc('tools/call', { name, arguments: args });
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, name === 'drive_read_file_content' ? 'exported text' : '{"ok":true}');
      assert(observed.some(request => request.method === method && request.url === url && request.authorization === 'Bearer fixture-access'));
    }
    const refreshes = observed.filter(request => request.url === '/token');
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0]?.method, 'POST');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(refreshes[0]?.body)), {
      grant_type: 'refresh_token', refresh_token: 'fixture-refresh', client_id: 'fixture-client', client_secret: 'fixture-secret',
    });
    if (service === 'drive') assert.deepEqual(JSON.parse(observed.at(-1)!.body), { values: [['hello']] });
    child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
    assert.equal(stderr, '');
  });
}
