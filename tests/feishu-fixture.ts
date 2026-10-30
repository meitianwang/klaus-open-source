import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { decodeFeishuFrame, encodeFeishuFrame, feishuHeader, type FeishuFrame } from '../main/services/channels/feishu-codec';
import { object, type JsonObject } from '../main/services/service-types';

export interface FeishuFixtureCall { path: string; method: string; body: JsonObject; token?: string }
export interface FeishuFixtureOptions {
  http?: (call: FeishuFixtureCall, response: ServerResponse) => boolean | void | Promise<boolean | void>;
  pong?: (connection: number, count: number) => JsonObject | false;
  clientConfig?: JsonObject; stallHandshake?: boolean;
}
export const FEISHU_FIXTURE_ACCOUNT = { app_id: 'cli_fixture', app_secret: 'fixture-feishu-secret', typing_indicator: 'false', resolve_sender_names: 'false', dm_policy: 'open' };
export function feishuFixtureEvent(id: string, message: JsonObject = {}, sender: JsonObject = {}): JsonObject {
  return { schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'event-' + id }, event: {
    sender: { sender_id: { open_id: 'ou_sender', ...sender } },
    message: { message_id: id, chat_id: 'oc_room', chat_type: 'p2p', content: '{"text":"fixture question"}', message_type: 'text', create_time: '1700000000000', ...message },
  } };
}
export async function createFeishuFixture(options: FeishuFixtureOptions = {}) {
  const calls: FeishuFixtureCall[] = [], frames: Array<{ frame: FeishuFrame; connection: number }> = [], sockets: WebSocket[] = [], tcp = new Set<Socket>(), upgradeUrls: string[] = [];
  let tokens = 0, endpoints = 0, pings = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const call = { path: request.url ?? '', method: request.method ?? '', body: chunks.length ? object(JSON.parse(Buffer.concat(chunks).toString())) : {}, token: request.headers.authorization }; calls.push(call);
      if (await options.http?.(call, response)) return;
      let value: JsonObject;
      const path = new URL(call.path, 'http://fixture.local').pathname;
      if (path === '/open-apis/auth/v3/tenant_access_token/internal') value = { code: 0, tenant_access_token: 'fixture-token-' + ++tokens, expire: 7200 };
      else if (path === '/open-apis/bot/v3/info') value = { code: 0, bot: { open_id: 'ou_bot', app_name: 'Fixture Klaus' } };
      else if (path === '/callback/ws/endpoint') value = { code: 0, data: { URL: 'ws://127.0.0.1:' + (server.address() as AddressInfo).port + '/feishu/gateway?device_id=fixture%2B' + ++endpoints + '&service_id=7', ClientConfig: { PingInterval: 0.1, ReconnectCount: 3, ReconnectInterval: 0.02, ReconnectNonce: 0, ...options.clientConfig } } };
      else if (path.startsWith('/open-apis/contact/v3/users/')) value = { code: 0, data: { user: { name: 'Fixture Sender' } } };
      else if (path.includes('/images/') || path.includes('/resources/')) { response.writeHead(200, { 'content-type': path.includes('/images/') ? 'image/png' : 'application/octet-stream', 'content-disposition': 'attachment; filename="../../fixture.bin"' }); response.end(Buffer.from('fixture-media-bytes')); return; }
      else if (path.endsWith('/reactions')) value = { code: 0, data: { reaction_id: 'reaction-' + calls.length } };
      else if (path.includes('/reactions/')) value = { code: 0, data: {} };
      else if (path.startsWith('/open-apis/im/v1/messages/') && call.method === 'GET') value = { code: 0, data: { items: [{ msg_type: 'text', upper_message_id: 'om_forward_parent', body: { content: '{"text":"forwarded fixture"}' }, sender: { id: 'ou_forward' } }] } };
      else if (path === '/open-apis/im/v1/messages' || path.endsWith('/reply')) value = { code: 0, data: { message_id: 'om_receipt_' + calls.length } };
      else { response.writeHead(404); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('{}'); });
  });
  server.on('connection', socket => { tcp.add(socket); socket.once('close', () => tcp.delete(socket)); });
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => { upgradeUrls.push(request.url ?? ''); if (!options.stallHandshake) ws.handleUpgrade(request, socket, head, connection => ws.emit('connection', connection, request)); });
  ws.on('connection', socket => {
    const connection = sockets.length; sockets.push(socket); socket.on('error', () => undefined);
    socket.on('message', data => {
      const frame = decodeFeishuFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)); frames.push({ frame, connection });
      if (frame.method === 0 && feishuHeader(frame, 'type') === 'ping') {
        pings++; const result = options.pong?.(connection, pings); if (result === false) return;
        socket.send(encodeFeishuFrame({ ...frame, headers: [['type', 'pong']], payload: Buffer.from(JSON.stringify(result ?? {})) }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiBase = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const sendFrame = (frame: FeishuFrame, connection = sockets.length - 1): void => { sockets[connection]!.send(encodeFeishuFrame(frame)); };
  return { apiBase, calls, frames, sockets, upgradeUrls, pings: () => pings, endpoints: () => endpoints,
    replies: () => calls.filter(call => call.path.split('?')[0]!.endsWith('/reply') || call.path.startsWith('/open-apis/im/v1/messages?')),
    acks: () => frames.filter(({ frame }) => frame.method === 1),
    sendFrame,
    send: (payload: JsonObject, id = 'wire-' + Date.now(), connection = sockets.length - 1) => sendFrame({ seqId: 9007199254740993n, logId: 18446744073709551615n, service: 7, method: 1, headers: [['type', 'event'], ['message_id', id], ['sum', '1'], ['seq', '0']], payload: Buffer.from(JSON.stringify(payload)) }, connection),
    close: async () => { for (const socket of sockets) socket.terminate(); for (const socket of tcp) socket.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
