import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as tcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerFeedbackHandlers } from '../main/ipc/handlers/feedback';
import { FeedbackService, type FeedbackDeps } from '../main/feedback/service';
import { WorkspaceStore } from '../main/services/workspaces';

export async function put(path: string, data: string | Buffer): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); }
export async function feedbackFixture(extra: Partial<FeedbackDeps> = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'klaus-feedback-fixture-')), root = join(temp, 'config');
  const requests: Array<{ authorization?: string; url?: string; body: string }> = [];
  let route = (_req: IncomingMessage, response: ServerResponse): void => { response.end(JSON.stringify({ ok: true, email: { sent: true, to: 'fixture@example.invalid', messageId: 'cloud-fixture' }, submissionId: 'fixture' })); };
  const http = createServer(async (request, response) => { let body = ''; for await (const chunk of request) body += chunk; requests.push({ authorization: request.headers.authorization, url: request.url, body }); route(request, response); });
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + (http.address() as AddressInfo).port;
  const workspaces = new WorkspaceStore({ configRoot: root, onSessionWorkdirChanged: () => {}, push: () => {}, pickDirectory: async () => null });
  let picked: string[] | undefined;
  const service = new FeedbackService({ workspaces, appVersion: 'fixture', serverUrl: origin, token: () => 'fixture-token', environment: {}, requestTimeoutMs: 2000,
    pickAttachments: async () => picked, captureScreenshot: async () => { throw new Error('No OS capture is part of the Node fixture'); }, ...extra });
  const registry = new ChannelRegistry(); registerFeedbackHandlers(registry, service);
  return { temp, root, service, registry, workspaces, requests, origin,
    pick: (paths?: string[]) => { picked = paths; }, route: (handler: typeof route) => { route = handler; },
    invoke: (channel: string, payload?: Json, senderId = 1) => registry.lookup(channel)!({ role: 'main', channel, senderId, args: payload === undefined ? [] : [payload] }),
    close: async () => { await service.close(); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); await rm(temp, { recursive: true, force: true }); },
  };
}
export async function smtpFixture(mode: 'accept' | 'reject' | 'hang' = 'accept') {
  const messages: string[] = [], sockets = new Set<Socket>();
  const server = tcpServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    if (mode === 'hang') return;
    socket.write('220 localhost fixture\r\n'); let buffer = '', data = false, message: string[] = [];
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8'); let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) { if (line === '.') { data = false; messages.push(message.join('\r\n')); socket.write('250 message stored\r\n'); } else message.push(line.replace(/^\.\./, '.')); }
        else if (/^(EHLO|HELO)/.test(line)) socket.write('250-localhost\r\n250 SIZE 30000000\r\n');
        else if (line.startsWith('MAIL FROM:')) socket.write('250 sender ok\r\n');
        else if (line.startsWith('RCPT TO:')) socket.write(mode === 'reject' ? '550 recipient rejected\r\n' : '250 recipient ok\r\n');
        else if (line === 'DATA') { data = true; message = []; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { messages, sockets, environment: { KLAUS_FEEDBACK_SMTP_HOST: '127.0.0.1', KLAUS_FEEDBACK_SMTP_PORT: String((server.address() as AddressInfo).port), KLAUS_FEEDBACK_SMTP_SECURE: 'false', KLAUS_FEEDBACK_EMAIL_TO: 'fixture@example.invalid' },
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); } };
}
