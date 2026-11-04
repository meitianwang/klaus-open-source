import assert from 'node:assert/strict';
import { app, BaseWindow, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserManager, type BrowserPage } from '../main/browser/manager';
import type { NativeBrowserHandle } from '../main/browser/native-page';
import { BrowserMcpServer } from '../main/browser/mcp';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import type { ClientEvent } from '../main/engine/protocol';
import { object, string, type JsonObject } from '../main/services/service-types';
import type { Json } from '../main/ipc/contract';
import { Harness, waitFor } from './harness';

const profile = process.env.KLAUS_SEARCH_BROWSER_PROFILE;
const binary = process.env.KLAUS_ENGINE_BINARY;
const logDirectory = process.env.KLAUS_SEARCH_BROWSER_LOG_DIR;
if (!profile || !binary || !logDirectory) throw new Error('Use web-search-browser-electron.test.js to supply an isolated profile, log directory and real engine binary.');
mkdirSync(profile, { recursive: true });
mkdirSync(logDirectory, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('native-browser-enabled');
app.commandLine.appendSwitch('native-browser-data-dir', join(profile, 'electron', 'native-browser'));
app.commandLine.appendSwitch('site-per-process');
app.on('window-all-closed', () => {});
const live = process.env.KLAUS_SEARCH_BROWSER_LIVE === '1';
const suite = live ? 'web-search-browser-live' : 'web-search-browser-electron';
const trace = (kind: string, detail: unknown): void => {
  appendFileSync(join(logDirectory, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), kind, detail }) + '\n');
};
type CaseKind = 'organic' | 'empty' | 'challenge' | 'cancel' | 'timeout' | 'live';
interface SearchCase { kind: CaseKind; query: string; callId: string; requested: boolean; providerCalls: number; toolResults: JsonObject[]; releaseNavigation?: () => void }
let activeCase: SearchCase | undefined;

function html(kind: CaseKind): string {
  if (kind === 'challenge') return '<!doctype html><title>Bing verification</title><div id="b_captcha"><h1>Verify you are human</h1></div>';
  if (kind === 'empty') return '<!doctype html><title>Bing search</title><ol id="b_results"><li class="b_no">There are no results for this fixture query.</li></ol>';
  const redirect = 'https://www.bing.com/ck/a?u=a1' + Buffer.from('https://docs.python.org/3/').toString('base64url');
  return `<!doctype html><title>Bing search fixture</title><ol id="b_results">
    <li class="b_ad"><h2><a href="https://ads.example.test/">Sponsored fixture</a></h2></li>
    <li class="b_algo"><h2><a href="${redirect}">Python Documentation</a></h2><div class="b_caption"><p>Official Python reference &amp; tutorials.</p></div></li>
    <li class="b_algo"><h2><a href="https://unrelated.example.test/">Unrelated fixture</a></h2><div class="b_caption"><p>Excluded by the requested domain.</p></div></li>
  </ol>`;
}

const provider = createServer((request, response) => {
  void (async () => {
    if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(request.url ?? '') || request.headers['x-api-key'] !== 'fixture-search-key') throw new Error('Unexpected fixture provider request.');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      const part = Buffer.from(chunk); bytes += part.length;
      if (bytes > 8 * 1024 * 1024) throw new Error('Fixture provider request exceeds its byte bound.');
      chunks.push(part);
    }
    const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))), current = activeCase;
    if (request.url === '/v1/messages/count_tokens') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ input_tokens: 10 })); return; }
    assert(current, 'a scripted search case owns every model request');
    const tools = Array.isArray(body.tools) ? body.tools.map(object) : [];
    assert.equal(tools.filter(tool => tool.name === 'web_search').length, 1, 'exactly one canonical web_search is offered');
    current.providerCalls++;
    assert(current.providerCalls <= 3, 'the fixture must not retry the model indefinitely');
    const messages = Array.isArray(body.messages) ? body.messages.map(object) : [];
    const lastContent = messages.at(-1)?.content;
    const results = Array.isArray(lastContent) ? lastContent.map(object).filter(block => block.type === 'tool_result') : [];
    current.toolResults.push(...results);
    const first = !current.requested;
    if (!first) assert(results.some(result => result.tool_use_id === current.callId), 'the actual search result reaches the model continuation');
    current.requested = true;
    const input: JsonObject = { query: current.query, ...(current.kind === 'organic' ? { allowedDomains: ['docs.python.org'] } : {}) };
    const block: JsonObject = first ? { type: 'tool_use', id: current.callId, name: 'web_search', input }
      : { type: 'text', text: 'The isolated browser search fixture completed.' };
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: first ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 8 } };
    trace('provider', { case: current.kind, request: current.providerCalls, first, results });
    if (body.stream !== true) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return; }
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: first ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: first ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  })().catch(error => {
    trace('provider-error', String(error));
    if (!response.headersSent) response.writeHead(500);
    response.end('Isolated fixture provider failed.');
  });
});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness(), engines = new EngineManager('0.0.0-web-search-browser-fixture');
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const pushes: Array<{ channel: string; payload: Json }> = [], browserReplies: JsonObject[] = [], navigations: string[] = [];
  const browser = new BrowserManager({ window, configRoot: profile!, enabled: () => true, emit: (channel, payload) => { pushes.push({ channel, payload }); } });
  const mcp = new BrowserMcpServer(browser, { chromeEnabled: () => false, chromeDiscoveryDirectory: join(profile!, 'chrome-discovery'),
    observeResult: (_owner, _lease, result) => { browserReplies.push(object(result)); trace('browser-reply', result); }, reportDiagnostic: message => trace('browser-diagnostic', message) });
  const createdPages: NativeBrowserHandle[] = [];
  const installBingFixture = async (page: BrowserPage): Promise<void> => {
    const responseHeaders = [
      { name: 'content-type', value: 'text/html; charset=utf-8' },
      { name: 'content-security-policy', value: "default-src 'none'; style-src 'unsafe-inline'" },
    ];
    const unsubscribe = page.cdp.onEvent((method, params, frame) => {
      if (method !== 'Fetch.requestPaused' || frame !== undefined) return;
      const requestId = typeof params.requestId === 'string' ? params.requestId : '';
      const request = object(params.request), url = typeof request.url === 'string' ? request.url : '';
      const fail = (): void => {
        if (requestId) void page.cdp.command('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      };
      if (!requestId || !url) { fail(); return; }
      let parsed: URL;
      try { parsed = new URL(url); } catch { fail(); return; }
      const current = activeCase;
      if (parsed.hostname !== 'www.bing.com' || parsed.pathname !== '/search' || !current) { fail(); return; }
      try { assert.equal(parsed.searchParams.get('q'), current.query, 'the canonical tool forwards the exact query to Bing'); }
      catch (error) { trace('bing-query-mismatch', String(error)); fail(); return; }
      navigations.push(url); trace('bing-navigation', { mode: current.kind, url });
      const body = Buffer.from(html(current.kind)).toString('base64');
      if (current.kind === 'cancel' || current.kind === 'timeout') {
        current.releaseNavigation = () => {
          if (page.native.isDestroyed()) return;
          void page.cdp.command('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders, body }).catch(() => {});
        };
        return;
      }
      void page.cdp.command('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders, body }).catch(() => {});
    });
    page.native.on('destroyed', () => { unsubscribe(); });
    await page.cdp.command('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
  };
  const originalCreateTab = browser.createTab.bind(browser);
  browser.createTab = async (sessionId: string, input: unknown = 'about:blank', activate = true, signal?: AbortSignal): Promise<BrowserPage> => {
    if (live) {
      const page = await originalCreateTab(sessionId, input, activate, signal);
      createdPages.push(page.native);
      return page;
    }
    const requested = String(input);
    const page = await originalCreateTab(sessionId, 'about:blank', activate, signal);
    await page.ready;
    await page.navigation.stop();
    await installBingFixture(page);
    createdPages.push(page.native);
    if (requested === 'about:blank') return page;
    try { await browser.navigate(page, requested, {}, signal); return page; }
    catch (error) { browser.closeTab(sessionId, page.handle); throw error; }
  };
  const originalCreatePreviewTab = browser.createPreviewTab.bind(browser);
  browser.createPreviewTab = async (sessionId: string): Promise<BrowserPage> => {
    const page = await originalCreatePreviewTab(sessionId);
    createdPages.push(page.native);
    if (!live) {
      await page.ready;
      await page.navigation.stop();
      await installBingFixture(page);
    }
    return page;
  };
  const cases: CaseKind[] = live ? ['live'] : ['organic', 'empty', 'challenge', 'cancel', 'timeout'];
  let engine: ManagedEngine | undefined, stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => stopping ??= (async () => {
    trace('shutdown', { enginePid: engine?.pid });
    await engines.shutdownAll();
    await mcp.shutdown();
    browser.dispose();
    if (!window.isDestroyed()) window.destroy();
    provider.closeAllConnections();
    if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve()));
  })();
  process.once('SIGTERM', () => { void shutdown().finally(() => app.exit(1)); });
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address(); assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    engine = await engines.attach({ command: binary!, args: [], cwd: profile!, env: [
      ['KLAUS_CONFIG_DIR', profile!], ['KLAUS_SESSION_DIR', join(profile!, 'sessions')], ['KLAUS_PLUGIN_HOME', join(profile!, 'plugins')],
    ] });
    trace('engine-attached', { pid: engine.pid, binary, mode: live ? 'live' : 'deterministic' });
    const request = (method: string, params: JsonObject): Promise<unknown> => {
      trace('facade-request', { method, ...(params.sessionId ? { sessionId: params.sessionId } : {}) });
      return engine!.client.requestWithTimeout(method, params, 30_000);
    };
    for (const kind of cases) await h.test(`${kind}: real engine search returns its result and retires temporary native tabs`, async () => {
      const owner = randomUUID(), query = kind === 'live' ? process.env.KLAUS_SEARCH_BROWSER_QUERY || 'Python official documentation' : `Klaus ${kind} fixture 中文`;
      activeCase = { kind, query, callId: 'toolu_search_' + kind, requested: false, providerCalls: 0, toolResults: [] };
      browser.setConversation(owner);
      const selected = await browser.createTab(owner, 'about:blank');
      await selected.cdp.evaluate("document.title='Preserved fixture tab'; document.body.textContent='Existing task page'; true");
      const before = { state: browser.state(owner), pages: createdPages.length, replies: browserReplies.length, pushes: pushes.length, navigations: navigations.length };
      let completed = false, started = false;
      const searchItems = new Map<string, JsonObject>();
      const receive = (event: ClientEvent): void => {
        if (event.type === 'reverseRequest') { trace('unexpected-reverse-request', event.request.method); void event.request.respondError(-32000, 'Fixture does not grant unexpected requests.'); return; }
        if (event.type === 'turnCompleted' && object(event.params).sessionId === owner) { completed = true; trace('turn-completed', event.params); }
        if (event.type === 'productEvent' && ['item/completed', 'item/updated'].includes(event.method) && object(event.params).sessionId === owner) {
          const item = object(object(event.params).item);
          if (item.type === 'tool_call' && item.toolName === 'web_search' && ['completed', 'failed'].includes(string(item.status))) { searchItems.set(string(item.id), item); trace('search-item', item); }
        }
        if (event.type === 'protocolError') trace('protocol-error', event.line);
      };
      engine!.client.on('event', receive);
      try {
        const result = object(await request('session/start', { init: { threadId: owner, cwd: profile!,
          provider: { type: 'anthropic', model: 'fixture-search-model', baseUrl }, auth: { type: 'api_key', key: 'fixture-search-key' },
          permissionMode: 'bypassPermissions', hostCapabilities: await mcp.hostCapabilities(owner),
          config: { autoMemory: false, autoDream: false, memoryRecall: false, memory: { enabled: false }, thinking: false, maxRetries: 0, maxOutputTokens: 1024 },
        } }));
        assert.equal(result.sessionId, owner); started = true;
        await request('session/subscribe', { sessionId: owner });
        await request('turn/start', { sessionId: owner, input: 'Run one web_search for the isolated browser fixture.' });
        if (kind === 'cancel' || kind === 'timeout') {
          await waitFor(() => Boolean(activeCase?.releaseNavigation), 10_000, 'Bing navigation is held before its response');
          const temporary = createdPages.slice(before.pages);
          assert(temporary.length > 0 && temporary.some(page => !page.isDestroyed()), 'a live temporary native page owns the pending request');
          const began = Date.now();
          if (kind === 'cancel') await request('turn/interrupt', { sessionId: owner });
          await waitFor(() => temporary.every(page => page.isDestroyed()), kind === 'cancel' ? 3000 : 29_000, 'cancelled or expired search destroys its temporary native page before the server replies');
          await waitFor(() => completed, 5000, 'cancelled or expired search turn completes');
          assert.equal(activeCase!.providerCalls, kind === 'cancel' ? 1 : 2);
          if (kind === 'timeout') {
            const item = searchItems.get(activeCase!.callId); assert(item);
            assert.equal(item.status, 'failed');
            assert.match(JSON.stringify(item.error), /timed out after 25 seconds/);
          }
          assert.deepEqual(browser.listPages(owner).map(page => page.handle), [selected.handle]);
          assert.equal(browser.state(owner).tabId, before.state.tabId);
          assert.equal(await selected.cdp.evaluate('document.body.textContent'), 'Existing task page');
          assert.equal(browserReplies.length, before.replies, 'cancelled browser operations never publish a late result');
          trace('case-validated', { kind, elapsedMs: Date.now() - began, temporaryPagesDestroyed: temporary.length, replyStillHeld: Boolean(activeCase!.releaseNavigation) });
          return;
        }
        await waitFor(() => completed, 45_000, 'real browser search turn completed');
        assert.equal(activeCase!.providerCalls, 2, 'one model tool call and one continuation');
        const item = searchItems.get(activeCase!.callId); assert(item, 'structured search tool completion reaches the host');
        const output = object(item.result), modelResult = activeCase!.toolResults.find(result => result.tool_use_id === activeCase!.callId);
        assert(modelResult, 'model receives the actual tool result');
        assert.equal(output.query, query);
        if (kind === 'organic') {
          assert.equal(item.status, 'completed'); assert.notEqual(modelResult.is_error, true);
          assert.deepEqual(output.results, [{ id: 1, title: 'Python Documentation', url: 'https://docs.python.org/3/', snippet: 'Official Python reference & tutorials.' }]);
          assert.equal(output.count, 1);
        } else if (kind === 'empty') {
          assert.equal(item.status, 'completed'); assert.equal(output.count, 0); assert.notEqual(modelResult.is_error, true);
          assert.match(JSON.stringify(modelResult.content), /No results for/);
        } else if (kind === 'challenge') {
          assert.equal(item.status, 'failed'); assert.equal(output.count, 0); assert.equal(modelResult.is_error, true);
          assert.match(JSON.stringify(modelResult.content), /requires browser verification/);
          assert.doesNotMatch(JSON.stringify(modelResult.content), /No results for/);
        } else {
          assert.equal(item.status, 'completed'); assert.notEqual(modelResult.is_error, true);
          assert(Number(output.count) > 0, 'live Bing returns organic search results');
          assert(Array.isArray(output.results) && output.results.every(result => /^https?:\/\//.test(string(object(result).url))));
        }
        const cleanup = browserReplies.slice(before.replies).map(reply => object(object(reply.structuredContent).value)).find(value => 'temporaryTabsClosed' in value);
        assert(cleanup, 'real browser MCP returns temporary-page cleanup metadata');
        assert.equal(cleanup.temporaryTabsClosed, true); assert.equal(cleanup.selectedTabUnchanged, true); assert.equal(cleanup.pendingAtClose, 0);
        assert.equal(cleanup.selectedTab, selected.handle);
        assert.deepEqual(browser.listPages(owner).map(page => page.handle), [selected.handle]);
        assert.equal(browser.state(owner).tabId, before.state.tabId);
        assert.equal(browser.state(owner).url, before.state.url);
        assert.equal(await selected.cdp.evaluate('document.body.textContent'), 'Existing task page');
        const temporary = createdPages.slice(before.pages); assert(temporary.length > 0, 'search used actual temporary native pages');
        await waitFor(() => temporary.every(page => page.isDestroyed()), 5000, 'temporary native pages destroyed');
        const changed = pushes.slice(before.pushes);
        assert(!changed.some(push => push.channel === 'browser-use:open-panel'), 'search does not open the visible browser panel');
        assert(!changed.some(push => push.channel === 'browser-use:state' && object(push.payload).tabId !== selected.id), 'selected page stays unchanged throughout the search');
        assert(!BaseWindow.getAllWindows().some(entry => entry.isVisible()), 'background search never exposes the fixture windows');
        if (!live) assert.equal(navigations.length - before.navigations, 1, 'one rendered Bing navigation per search');
        trace('case-validated', { kind, count: output.count, selectedTab: selected.handle, temporaryPagesDestroyed: temporary.length });
      } finally {
        activeCase?.releaseNavigation?.();
        engine!.client.off('event', receive);
        if (started) await request('session/close', { sessionId: owner });
        mcp.releaseSession(owner); activeCase = undefined;
      }
    });
    return await h.finish(join(logDirectory!, 'result.json'), suite);
  } finally { await shutdown(); }
}

void main().then(code => app.exit(code)).catch(error => { trace('fatal', error instanceof Error ? error.stack : String(error)); process.stderr.write(String(error) + '\n'); app.exit(1); });
