import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { object, type JsonObject } from '../service-types';
import type { FeishuConfig } from './feishu-config';
import { decryptFeishuEnvelope, feishuWebhookAuthorized } from './feishu-event';
import type { FeishuAdmission } from './feishu-websocket';

export interface FeishuWebhookOptions { requestTimeoutMs?: number; now?: () => number }
export interface FeishuWebhook { done: Promise<void>; port: number }

/** The HTTP listener owns no inference work and is closed with its account transport. */
export async function startFeishuWebhook(config: FeishuConfig, signal: AbortSignal, event: (payload: JsonObject) => FeishuAdmission, options: FeishuWebhookOptions = {}): Promise<FeishuWebhook> {
  if (signal.aborted) throw new Error('Feishu webhook start was cancelled');
  const timeout = options.requestTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) throw new Error('Invalid Feishu webhook timeout');
  const now = options.now ?? Date.now, sockets = new Set<Socket>(), requests = new Set<Promise<void>>(), rates = new Map<string, { at: number; count: number }>();
  let closing = false, inflight = 0; const listenController = new AbortController();
  const respond = (response: ServerResponse, status: number, body: JsonObject): void => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' }); response.end(JSON.stringify(body));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closing || signal.aborted) { respond(response, 503, { error: 'Webhook is stopping' }); return; }
    if (request.method !== 'POST' || request.url !== config.webhookPath) { respond(response, 404, { error: 'Not found' }); return; }
    const at = now(); for (const [key, rate] of rates) if (at - rate.at >= 10_000) rates.delete(key);
    const address = request.socket.remoteAddress ?? 'unknown'; let rate = rates.get(address);
    if ((!rate && rates.size >= 10_000) || (rate?.count ?? 0) >= 100) { respond(response, 429, { error: 'Webhook request rate exceeded' }); return; }
    if (!rate) { rate = { at, count: 0 }; rates.set(address, rate); } rate.count++;
    const length = request.headers['content-length'];
    if (length && (!/^\d+$/u.test(length) || Number(length) > 1024 * 1024)) { respond(response, 413, { error: 'Webhook body exceeds the size limit' }); return; }
    const timer = setTimeout(() => { respond(response, 408, { error: 'Webhook body timed out' }); request.destroy(); }, timeout);
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 1024 * 1024) { respond(response, 413, { error: 'Webhook body exceeds the size limit' }); return; } chunks.push(Buffer.from(chunk)); }
      if (closing || signal.aborted) { respond(response, 503, { error: 'Webhook is stopping' }); return; }
      const raw = Buffer.concat(chunks, size), parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { respond(response, 400, { error: 'Invalid event envelope' }); return; }
      const body = object(parsed);
      if (!feishuWebhookAuthorized(raw, body, request.headers, config, now())) { respond(response, 401, { error: 'Webhook authentication failed' }); return; }
      const decoded = decryptFeishuEnvelope(body, config.encryptKey);
      if (decoded.type === 'url_verification') {
        if (typeof decoded.challenge !== 'string' || Buffer.byteLength(decoded.challenge) > 16_384) { respond(response, 400, { error: 'Invalid challenge' }); return; }
        respond(response, 200, { challenge: decoded.challenge }); return;
      }
      const result = event(body); respond(response, result.accepted ? 200 : 503, result.accepted ? result.result ?? { code: 0 } : { error: 'Event was not accepted' });
    } catch { respond(response, 400, { error: 'Invalid event envelope' }); }
    finally { clearTimeout(timer); }
  };
  const server = createServer({ requestTimeout: timeout, headersTimeout: timeout, maxHeaderSize: 16 * 1024 }, (request, response) => {
    if (inflight >= 64) { respond(response, 503, { error: 'Webhook request capacity exceeded' }); return; }
    inflight++;
    const work = handle(request, response).finally(() => { requests.delete(work); inflight--; }); requests.add(work); void work.catch(() => undefined);
  });
  server.maxConnections = 64; server.keepAliveTimeout = 1;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let finish!: () => void; const closed = new Promise<void>(resolve => { finish = resolve; });
  server.once('close', finish);
  const stop = (): void => {
    if (closing) return; closing = true;
    listenController.abort(); server.close(); for (const socket of sockets) socket.destroy();
    if (!server.listening && sockets.size === 0) finish();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => { signal.removeEventListener('abort', cancel); reject(new Error('Feishu webhook could not listen')); };
      const cancel = (): void => { server.removeListener('error', fail); reject(new Error('Feishu webhook start was cancelled')); };
      server.once('error', fail); signal.addEventListener('abort', cancel, { once: true });
      server.listen({ port: config.webhookPort, host: config.webhookHost, signal: listenController.signal }, () => { server.removeListener('error', fail); signal.removeEventListener('abort', cancel); if (signal.aborted) { stop(); cancel(); } else resolve(); });
      if (signal.aborted) { stop(); cancel(); }
    });
  } catch (error) { stop(); signal.removeEventListener('abort', stop); await Promise.allSettled([...requests]); throw error; }
  server.on('error', stop);
  const address = server.address(); if (!address || typeof address === 'string') { stop(); throw new Error('Feishu webhook has no bound address'); }
  const done = closed.then(async () => { signal.removeEventListener('abort', stop); await Promise.allSettled([...requests]); rates.clear(); sockets.clear(); });
  return { done, port: address.port };
}
