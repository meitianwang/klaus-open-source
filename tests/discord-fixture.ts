import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { object, type JsonObject } from '../main/services/service-types';

export interface DiscordFixtureOptions {
  heartbeatMs?: number; hello?: boolean; acknowledge?: boolean;
  respond?: (method: string, path: string, body: JsonObject, raw: string) => { status?: number; body?: unknown; hold?: boolean } | undefined;
}
export async function createDiscordFixture(options: DiscordFixtureOptions = {}) {
  const requests: Array<{ method: string; path: string; raw: string; body: JsonObject; authorization?: string; at: number }> = [];
  const frames: Array<{ connection: number; value: JsonObject }> = [], sockets: WebSocket[] = [], held: ServerResponse[] = [], gatewayPaths: string[] = [];
  let nextMessage = 1000, sequence = 1, closedSockets = 0, closedHttp = 0, origin = '';
  const messages = new Map<string, JsonObject>();
  const channels = new Map<string, JsonObject>([
    ['100', { id: '100', type: 1, recipients: [{ id: '1' }] }], ['101', { id: '101', type: 1, recipients: [{ id: '2' }] }],
    ['200', { id: '200', type: 0, guild_id: '300' }], ['201', { id: '201', type: 11, parent_id: '200', guild_id: '300' }],
    ['202', { id: '202', type: 0, guild_id: '300' }],
  ]);
  const answer = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(status === 204 ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    response.once('close', () => { if (!response.writableEnded) closedHttp++; });
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    let body: JsonObject = {}; try { body = object(JSON.parse(raw)); } catch { /* Multipart requests retain their exact raw bytes. */ }
    const path = request.url!, method = request.method!;
    requests.push({ method, path, raw, body, authorization: request.headers.authorization, at: Date.now() });
    const override = options.respond?.(method, path, body, raw);
    if (override) { if (override.hold) { held.push(response); return; } answer(response, override.status ?? 200, override.body ?? {}); return; }
    if (path === '/asset') { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end('fixture attachment bytes'); return; }
    if (path === '/api/v10/users/@me') { answer(response, 200, { id: '900', username: 'fixture-bot', bot: true }); return; }
    if (path === '/api/v10/gateway/bot') { answer(response, 200, { url: origin.replace('http:', 'ws:') + '/gateway' }); return; }
    const channel = /^\/api\/v10\/channels\/(\d+)$/u.exec(path);
    if (channel) { answer(response, channels.has(channel[1]!) ? 200 : 404, channels.get(channel[1]!) ?? { message: 'Unknown channel' }); return; }
    if (path.endsWith('/typing') || path.includes('/reactions/')) { answer(response, 204, null); return; }
    const message = /^\/api\/v10\/channels\/(\d+)\/messages\/(\d+)$/u.exec(path);
    if (message) {
      answer(response, 200, method === 'PATCH' ? { id: message[2], ...body } : messages.get(message[2]!) ?? { id: message[2], author: { id: '900', username: 'fixture-bot' }, content: 'earlier fixture' }); return;
    }
    if (/^\/api\/v10\/channels\/\d+\/messages(?:\?|$)/u.test(path)) {
      if (method === 'GET') answer(response, 200, [...messages.values()]);
      else answer(response, 200, { id: String(nextMessage++) }); return;
    }
    answer(response, 404, { message: 'Unknown fixture route' });
  });
  const gateway = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4096 });
  server.on('upgrade', (request, socket, head) => { gatewayPaths.push(request.url!); gateway.handleUpgrade(request, socket, head, ws => gateway.emit('connection', ws, request)); });
  gateway.on('connection', socket => {
    const connection = sockets.length; sockets.push(socket); socket.on('error', () => undefined); socket.on('close', () => { closedSockets++; });
    if (options.hello !== false) socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: options.heartbeatMs ?? 500 } }));
    socket.on('message', data => {
      const value = object(JSON.parse(data.toString())); frames.push({ connection, value });
      if (value.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', s: sequence++, d: { session_id: 'fixture-session', resume_gateway_url: origin.replace('http:', 'ws:') + '/resume', user: { id: '900', username: 'fixture-bot' } } }));
      else if (value.op === 6) socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: sequence++, d: {} }));
      else if (value.op === 1 && options.acknowledge !== false) socket.send(JSON.stringify({ op: 11, d: null }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return {
    apiBase: origin + '/api/v10', origin, requests, frames, sockets, channels, messages, held, gatewayPaths,
    closedSockets: () => closedSockets, closedHttp: () => closedHttp,
    message: (data: JsonObject, index = sockets.length - 1) => sockets[index]!.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: sequence++, d: data })),
    event: (event: JsonObject, index = sockets.length - 1) => sockets[index]!.send(JSON.stringify(event)),
    sends: () => requests.filter(row => row.method === 'POST' && /^\/api\/v10\/channels\/\d+\/messages$/u.test(row.path)),
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
