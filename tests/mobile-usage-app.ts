import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import WebSocket from 'ws';
import type { DesktopRuntime } from '../main/app/runtime';
import type { Json } from '../main/ipc/contract';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertEqual, waitFor } from './harness';

export async function testMobileUsageApp(h: Harness, desktop: DesktopRuntime, invoke: (channel: string, payload?: Json) => Promise<unknown>): Promise<void> {
  let settings: JsonObject = {}, id = '', exported = '', socket: WebSocket | undefined;
  const events: JsonObject[] = [];
  const request = async (method: string, path: string, payload?: Json, token = string(settings.token)) => {
    const response = await fetch('http://127.0.0.1:' + settings.port + '/api/mobile/' + path, {
      method, headers: { authorization: 'Bearer ' + token }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: object(await response.json()) };
  };
  try {
    await h.test('mobile pairing and bootstrap use the actual registered host handlers', async () => {
      assertEqual(object(object(await invoke('settings:mobile-bridge:get')).settings).enabled, false, 'the fixture bridge starts disabled');
      settings = object(object(await invoke('settings:mobile-bridge:set', { enabled: true, port: 0 })).settings);
      assertEqual(settings.running, true, 'the loopback listener actually bound');
      assertEqual((await request('GET', 'bootstrap', undefined, 'invalid-fixture-token')).status, 401, 'pairing is enforced before product access');
      const bootstrap = await request('GET', 'bootstrap'); assertEqual(bootstrap.status, 200, 'all bootstrap projections use real handlers: ' + JSON.stringify(bootstrap.body));
      const sources = object(bootstrap.body.runtimeConfig).authModeOptions;
      assert(JSON.stringify(sources).includes('qoder') && JSON.stringify(sources).includes('qwenwork') && JSON.stringify(sources).includes('workbuddy') && JSON.stringify(sources).includes('kimi') && JSON.stringify(sources).includes('bailian') && JSON.stringify(sources).includes('minimax') && JSON.stringify(sources).includes('zhipu') && JSON.stringify(sources).includes('ark') && !JSON.stringify(sources).includes('local') && !JSON.stringify(sources).includes('klaus') && !JSON.stringify(sources).includes('qoderwork'), 'current product sources reach the phone and retired ones do not');
      socket = new WebSocket('ws://127.0.0.1:' + settings.port + '/api/mobile/ws?token=' + encodeURIComponent(string(settings.token)));
      socket.on('message', data => events.push(object(JSON.parse(data.toString())))); socket.on('error', () => {});
      await once(socket, 'open'); await waitFor(() => events.some(row => row.type === 'hello'), 10_000, 'actual WebSocket bootstrap');
      const created = await request('POST', 'sessions', {
        clientDraftId: 'mobile-gui-draft-1',
        initialMessage: { text: 'MOBILE GUI BOOTSTRAP FIXTURE', clientMessageId: 'mobile-gui-initial' },
      });
      assertEqual(created.status, 201, 'the phone promoted its first message into a real engine conversation: ' + JSON.stringify(created.body));
      id = string(created.body.id); assert(id.length > 0, 'a persistent conversation identity was returned');
      await waitFor(() => events.some(row => row.type === 'engine_event' && object(row.event).sessionId === id && object(row.event).type === 'done'), 25_000, 'the initial phone turn completed');
      socket.send(JSON.stringify({ type: 'subscribe', sessionId: id })); await waitFor(() => events.some(row => row.type === 'history'), 10_000, 'actual mobile history subscription');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'phone and desktop share the one engine');
    });
    await h.test('a phone turn streams from the shared engine and exports the complete real transcript', async () => {
      assert(id && socket, 'mobile fixture was initialized');
      const completed = events.filter(row => row.type === 'engine_event' && object(row.event).sessionId === id && object(row.event).type === 'done').length;
      const sent = await request('POST', 'sessions/' + id + '/messages', { text: 'MOBILE GUI REAL ENGINE FIXTURE', clientMessageId: 'mobile-gui-1' });
      assertEqual(sent.status, 202, 'the message was admitted by the mobile owner');
      await waitFor(() => events.filter(row => row.type === 'engine_event' && object(row.event).sessionId === id && object(row.event).type === 'done').length > completed, 25_000, 'the real engine finished the phone turn');
      const history = await request('GET', 'sessions/' + id + '/history');
      assert(Array.isArray(history.body.messages), 'the phone receives a messages array rather than a nested host envelope');
      assert(JSON.stringify(history.body.messages).includes('MOBILE GUI REAL ENGINE FIXTURE'), 'history contains the actual submitted message');
      const result = await request('POST', 'sessions/' + id + '/export', {}); assertEqual(result.status, 202, 'phone export completes without a desktop save dialog');
      exported = string(result.body.filePath); assert((await readFile(exported, 'utf8')).includes('MOBILE GUI REAL ENGINE FIXTURE'), 'filePath identifies a complete text artifact');
      assertEqual((await request('POST', 'sessions/' + id + '/workdir', { workdir: null })).status, 409, 'a nonempty conversation cannot silently change its directory');
      const previous = await invoke('session:get-main-model', { sessionId: id });
      await invoke('session:history', { sessionId: id });
      const denied = await request('POST', 'runtime-config', { mainModel: 'klaus:fixture' });
      assert(denied.status >= 400, 'a retired source is refused by the phone runtime config');
      assertEqual(object(await invoke('session:get-main-model', { sessionId: id })).mode, object(previous).mode, 'a refused phone model change does not mutate the preference');
    });
    await h.test('rotating the actual pairing token closes old sockets and disabling drains its listener', async () => {
      const previous = string(settings.token), oldSocket = socket;
      settings = object(object(await invoke('settings:mobile-bridge:rotate-token')).settings);
      assert(string(settings.token) !== previous, 'pairing token was replaced');
      if (oldSocket) await waitFor(() => oldSocket.readyState === WebSocket.CLOSED, 5000, 'old phone socket closed');
      assertEqual((await request('GET', 'bootstrap', undefined, previous)).status, 401, 'old credentials no longer work');
      assertEqual((await request('GET', 'bootstrap')).status, 200, 'the new token reaches the existing desktop engine');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'restart did not create an additional engine');
      const base = 'http://127.0.0.1:' + settings.port;
      assertEqual(object(object(await invoke('settings:mobile-bridge:set', { enabled: false })).settings).running, false, 'the disabled listener finished closing');
      let refused = false; try { await fetch(base + '/healthz', { signal: AbortSignal.timeout(2000) }); } catch { refused = true; }
      assert(refused, 'the previous TCP listener is actually gone');
    });
    await h.test('usage reads real configured model credentials without returning their secret bytes', async () => {
      const result = object(await invoke('usage:subscriptions')), snapshot = object(result.snapshot), provider = object(snapshot.provider);
      assertEqual(result.ok, true, 'usage channel is registered in the real runtime'); assertEqual(snapshot.mode, 'custom', 'the isolated fixture uses BYO');
      assertEqual(provider.state, 'ok', 'actual engine credential metadata identifies a configured provider');
      assert(JSON.stringify(provider.models).includes('fixture-model'), 'the stored model appears in the result');
      assert(!JSON.stringify(result).includes('fixture-key') && !JSON.stringify(result).includes('apiKey'), 'no model credential is returned');
    });
  } finally {
    socket?.terminate(); await invoke('settings:mobile-bridge:set', { enabled: false });
    if (id) await invoke('session:delete', { sessionId: id });
    if (exported) await rm(dirname(exported), { recursive: true, force: true });
  }
}
