import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { MessagePortMain } from 'electron';
import { PptStore } from '../main/ppt/store';
import { PptRuntime } from '../main/ppt/runtime';
import { ok as assert, equal as assertEqual } from 'node:assert/strict';
import { Harness } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');

const h = new Harness();
const logs = resolve(__dirname, '../dist/ppt-editor-logs'); mkdirSync(logs, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'ppt-native-runtime-'));
const store = new PptStore(root), owner = 'runtime-fixture', doc = store.open(owner, 'Native presentation');
const pptPlugin = officialPluginRoot('ppt');
const runtime = new PptRuntime(store, () => pptPlugin);
const call = (method: string, path: string, body?: unknown, headers: string[][] = []) => runtime.call(owner, doc.id, method, path, headers, typeof body === 'object' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body);
const page = (path: string, shell = false) => runtime.page(owner, doc.id, new Request(`klaus-app://${shell ? 'app' : doc.id + '.ppt-content'}${path}`));
class Port extends EventEmitter {
  sent: any[] = [];
  start(): void {}
  postMessage(value: unknown): void { this.sent.push(value); }
  close(): void { this.emit('close'); }
}
void (async () => {
  try {
    let boot: any;
    await h.test('the native boot advertises only local editor capabilities', async () => {
      boot = await (await call('GET', `/api/frame/${doc.id}`)).json();
      assertEqual(boot.ver, 'v1');
      assertEqual(boot.singleUser, true);
      assertEqual(boot.viewer.can_edit, true);
      assert(!boot.capabilities.mcp && !boot.capabilities.comments && !boot.syncToken);
      assert(boot.assetToken.split('.')[0].length === 24);
    });
    await h.test('the shell and content use complete packaged editor assets', async () => {
      const shell = await (await page(`/code/artifact/${doc.id}`, true)).text();
      assert(shell.includes(`data-frame-uuid="${doc.id}"`) && shell.includes('frame-shell'));
      const content = await (await page('/_f/v1/index.html')).text();
      assert(content.includes('__FRAME_PREAMBLE') && content.includes('artifact-type/app.js'));
      const kernel = await page('/_runtime/kernel.DmOuV5QR.js'); assertEqual(kernel.status, 200);
      const redirect = await page('/_t?v=v1'); assertEqual(redirect.status, 302);
      assert(redirect.headers.get('location')?.startsWith('/_f/v1/index.html'));
    });
    await h.test('browser saves and agent file reads share one native revision', async () => {
      const response = await call('POST', `/api/frame/self/${doc.id}`, { token: boot.capabilities.self.token, baseVersion: 'v1', mode: 'patch', manifest: { 'project/deck.json': { content: '{"v":4,"order":[]}', contentType: 'application/json' } } });
      assertEqual(response.status, 200);
      assertEqual(store.get(owner, doc.id).version, 'v2');
      const manifest = await (await page('/_f/v2/_files.json')).json() as any;
      assertEqual(manifest.files['project/deck.json'].contentType, 'application/json');
      assertEqual(await (await page('/_f/v2/project/deck.json')).text(), '{"v":4,"order":[]}');
      const conflict = await call('POST', `/api/frame/self/${doc.id}`, { token: boot.capabilities.self.token, baseVersion: 'v1', mode: 'patch', manifest: { 'project/deck.json': null } });
      assertEqual(conflict.status, 409);
      assertEqual((await conflict.json() as any).live, 'v2');
      const denied = await call('POST', `/api/frame/self/${doc.id}`, { token: 'foreign', baseVersion: 'v2', mode: 'patch', manifest: { 'project/deck.json': null } });
      assertEqual(denied.status, 403);
      assertEqual(store.get(owner, doc.id).version, 'v2');
    });
    await h.test('binary assets round-trip and soft deletion preserves document references', async () => {
      const data = new Uint8Array([1, 2, 3, 4]), headers = [['Content-Type', 'image/png'], ['X-Frame-Blobs-Token', boot.capabilities.assets.token]];
      const uploaded = await (await call('POST', `/api/frame/blob/${doc.id}/upload`, data, headers)).json() as any;
      assertEqual(uploaded.size_bytes, 4);
      const loaded = new Uint8Array(await (await page('/_blob/' + uploaded.opaque_id)).arrayBuffer());
      assertEqual(Buffer.from(loaded).toString('hex'), '01020304');
      const list = await (await call('POST', `/api/frame/blob/${doc.id}/list`, {}, headers)).json() as any;
      assertEqual(list.assets.length, 1);
      assertEqual(typeof list.assets[0].created_at, 'string');
      const deleted = await call('POST', `/api/frame/blob/${doc.id}/${uploaded.opaque_id}/delete`, {}, headers); assertEqual(deleted.status, 200);
      assertEqual((await (await call('POST', `/api/frame/blob/${doc.id}/list`, {}, headers)).json() as any).assets.length, 0);
      assertEqual((await page('/_blob/' + uploaded.opaque_id)).status, 200);
    });
    await h.test('local version notifications follow the actual document and release their ports', async () => {
      const port = new Port(); runtime.connect(owner, doc.id, port as unknown as MessagePortMain);
      port.emit('message', { data: { kind: 'socket.make', sid: 'live', url: `/edge-api/frame-live/${doc.id}/ws`, protocols: ['frame-live.v1', boot.wsToken] } });
      assert(port.sent.some(event => event.kind === 'socket.onopen'));
      store.publish(owner, doc.id, { baseVersion: 'v2', writes: [{ path: 'project/extra.txt', bytes: new TextEncoder().encode('native') }] });
      runtime.changed(owner, doc.id);
      assert(port.sent.some(event => event.kind === 'socket.onmessage' && JSON.parse(event.data).ver === 'v3'));
      runtime.release(owner, doc.id);
      assertEqual((runtime as any).connections.size, 0);
    });
    await h.test('document resources reject another origin and traversal', async () => {
      assertEqual((await runtime.page(owner, doc.id, new Request('klaus-app://foreign/_f/v1/index.html'))).status, 403);
      assertEqual((await page('/_f/v2/%2e%2e%2fdocument.json')).status, 404);
    });
    await h.test('the shell and editor follow the application language', async () => {
      const plugin = pptPlugin;
      const zh = new PptRuntime(store, () => plugin, () => {}, () => 'zh-Hans');
      const zhPage = (path: string, shell = false) => zh.page(owner, doc.id, new Request(`klaus-app://${shell ? 'app' : doc.id + '.ppt-content'}${path}`));
      const shellHtml = await (await zhPage(`/code/artifact/${doc.id}`, true)).text();
      assert(shellHtml.includes('name="frame-shell-i18n"'));
      assert(shellHtml.includes('data-catalogs="zh-Hans:'));
      assert(shellHtml.includes('localStorage.setItem("spa:locale","zh-Hans")'));
      const catalog = await zhPage('/i18n/frame-shell/zh-Hans.json', true);
      assertEqual(catalog.status, 200);
      assert(Object.keys(await catalog.json() as Record<string, string>).length > 1000);
      assertEqual((await zhPage('/i18n/frame-shell/nope.json', true)).status, 404);
      assertEqual((await zhPage('/i18n/frame-shell/../runtime-manifest.json', true)).status, 404);
      const entries = JSON.parse(readFileSync(join(plugin, 'i18n/editor/zh-Hans.json'), 'utf8')) as { match: string; zh: string }[];
      assert(entries.length > 100);
      const sample = entries[0]!;
      const editor = await (await zhPage('/_f/v1/artifact-type/app.js')).text();
      assert(editor.includes(sample.zh) && !editor.includes(sample.match));
      const english = await (await page('/_f/v1/artifact-type/app.js')).text();
      assertEqual(english, readFileSync(join(plugin, 'runtime/dist/artifact-type/app.js'), 'utf8'));
      assert(english.includes(sample.match) && !english.includes(sample.zh));
      const index = await (await zhPage('/_f/v1/index.html')).text();
      assert(index.includes('<html lang="zh-Hans"'));
    });
  } finally { runtime.release(); rmSync(root, { recursive: true, force: true }); }
  process.exitCode = await h.finish(join(logs, 'native-runtime-result.json'), 'ppt-runtime');
})();
