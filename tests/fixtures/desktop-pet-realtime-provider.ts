import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

export interface RealtimeFixturePeer {
  answer(offerSdp: string): Promise<string>;
  event(value: Record<string, unknown>): Promise<void>;
}
export type RealtimeFixtureProtocol = 'public' | 'v1' | 'frameless';
interface FixtureCall { session: Record<string, unknown>; sockets: Set<WebSocket>; ended: boolean }
/** A protocol endpoint with a real browser peer; application and engine code remain unchanged. */
export async function startDesktopPetRealtimeProvider(peer: RealtimeFixturePeer, protocol: RealtimeFixtureProtocol = 'public') {
  const messages: Record<string, any>[] = [], calls = new Map<string, FixtureCall>();
  const requests: Array<{ method: string; path: string; authorization?: string; accountId?: string; sessionId?: string; alpha?: string }> = [];
  const sockets = new WebSocketServer({ noServer: true });
  const backend = protocol !== 'public', prefix = backend ? '/backend-api/codex' : '/v1';
  const capture = (request: IncomingMessage) => requests.push({ method: request.method || '', path: request.url || '', authorization: request.headers.authorization, accountId: String(request.headers['chatgpt-account-id'] || '') || undefined, sessionId: String(request.headers['x-session-id'] || '') || undefined, alpha: String(request.headers['openai-alpha'] || '') || undefined });
  const authorized = (request: IncomingMessage) => request.headers.authorization === 'Bearer local-realtime-fixture-key' && request.headers['chatgpt-account-id'] === undefined && (!backend || Boolean(request.headers['x-session-id']) && request.headers['openai-alpha'] === (protocol === 'v1' ? 'quicksilver=v1' : 'quicksilver=v2'));
  async function send(call: FixtureCall, value: Record<string, unknown>) {
    for (const socket of call.sockets) if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
  }
  async function emit(value: Record<string, unknown>, deliverToPeer = true) {
    for (const call of calls.values()) if (!call.ended) await send(call, value);
    if (deliverToPeer) await peer.event(value);
  }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; let bytes = 0;
    request.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
    request.on('error', () => response.destroy());
    request.on('end', () => { void (async () => {
      capture(request);
      if (!authorized(request)) { response.writeHead(401); response.end(); return; }
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === prefix + '/realtime/calls') {
        let offer: string, session: Record<string, unknown>;
        if (backend) {
          if (!String(request.headers['content-type']).startsWith('application/json') || url.searchParams.get('intent') !== 'quicksilver' || url.searchParams.get('architecture') !== 'avas') throw new Error('Backend call creation requires its JSON session and transport query');
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          if (typeof body.sdp !== 'string' || !body.session || typeof body.session !== 'object' || Array.isArray(body.session)) throw new Error('Backend call creation requires SDP and a session object');
          offer = body.sdp; session = body.session as Record<string, unknown>;
          if (protocol === 'v1' && session.type !== 'quicksilver') throw new Error('Realtime v1 requires a quicksilver session');
          if (protocol === 'frameless' && (session.delegation as Record<string, unknown>)?.type !== 'client') throw new Error('Frameless calls require client delegation');
        } else {
          const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/u.exec(String(request.headers['content-type']));
          if (!boundary) throw new Error('Realtime fixture expected multipart SDP');
          const parts = Buffer.concat(chunks).toString('utf8').split('--' + (boundary[1] || boundary[2]));
          const field = (name: string): string => { const part = parts.find(value => value.includes(`name="${name}"`)); if (!part) throw new Error('Missing realtime multipart field ' + name); return part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/u, ''); };
          offer = field('sdp'); session = JSON.parse(field('session')) as Record<string, unknown>;
        }
        const answer = await peer.answer(offer), callId = 'rtc_' + randomUUID().replaceAll('-', '');
        calls.set(callId, { session, sockets: new Set(), ended: false });
        messages.push({ type: 'fixture.sdp', callId, session, protocol });
        response.writeHead(201, { 'content-type': 'application/sdp', location: prefix + '/realtime/calls/' + callId }); response.end(answer); return;
      }
      const ended = new RegExp('^' + prefix + '/realtime/calls/([^/]+)/hangup$').exec(url.pathname);
      if (!backend && request.method === 'POST' && ended && calls.has(ended[1]!)) {
        const call = calls.get(ended[1]!)!;
        await send(call, { type: 'response.output_audio_transcript.done', item_id: 'spoken-tail', transcript: 'The final spoken tail was preserved.' });
        call.ended = true;
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}');
        setTimeout(() => { for (const socket of call.sockets) socket.close(); }, 80); return;
      }
      response.writeHead(404); response.end();
    })().catch(error => { messages.push({ type: 'fixture.error', message: String(error) }); if (!response.headersSent) response.writeHead(500); response.end(); }); });
  });
  server.on('upgrade', (request, socket, head) => {
    capture(request);
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const pathId = protocol === 'frameless' && url.pathname.startsWith(prefix + '/live/') ? url.pathname.slice((prefix + '/live/').length) : '';
    const callId = pathId || url.searchParams.get('call_id') || '', call = calls.get(callId);
    const validPath = protocol === 'frameless' ? url.pathname === prefix + '/live/' + callId && !url.searchParams.has('call_id') : url.pathname === prefix + '/realtime' && (!backend || url.searchParams.get('intent') === 'quicksilver');
    if (!call || !validPath || !authorized(request) || backend && !request.headers['x-session-id']) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, connection => {
      call.sockets.add(connection); messages.push({ type: 'fixture.attached', callId, protocol });
      connection.on('close', () => { call.sockets.delete(connection); if (backend && !call.sockets.size) call.ended = true; });
      connection.on('message', data => {
        let value: Record<string, any>;
        try { value = JSON.parse(String(data)) as Record<string, any>; } catch { connection.close(1007, 'Invalid JSON'); return; }
        messages.push(value);
        if (value.type === 'session.update') {
          if (backend) { messages.push({ type: 'fixture.error', message: 'An existing media call must not be reconfigured by its sideband' }); connection.close(1008, 'Existing call already configured'); return; }
          call.session = { ...call.session, ...value.session };
          connection.send(JSON.stringify({ type: 'session.updated', session: { id: 'session_fixture', ...call.session } }));
        } else if (value.type === 'response.cancel') {
          if (backend) { messages.push({ type: 'fixture.error', message: 'Hosted task interruption cannot invent a response cancellation frame' }); connection.close(1008, 'Unsupported hosted control'); return; }
          connection.send(JSON.stringify({ type: 'response.done', response: { status: 'cancelled', output: [] } }));
        }
        else if (value.type === 'session.close' && protocol === 'frameless') {
          void send(call, { type: 'turn.done', turn: { id: 'spoken-tail-frameless', role: 'assistant', transcript: 'The final hosted tail was preserved.' } });
          setTimeout(() => connection.close(), 80);
        }
      });
      if (!backend) connection.send(JSON.stringify({ type: 'session.created', session: { id: 'session_fixture', ...call.session } }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, basePath: prefix, protocol, messages, requests, emit, ended: () => calls.size > 0 && [...calls.values()].every(value => value.ended),
    close: async () => { for (const client of sockets.clients) client.terminate(); server.closeAllConnections(); await Promise.all([new Promise<void>(resolve => sockets.close(() => resolve())), new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]); } };
}
