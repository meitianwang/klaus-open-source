import WebSocket from 'ws';
import { object, type JsonObject } from '../service-types';
import { feishuTiming, type FeishuEndpoint } from './feishu-api';
import { decodeFeishuFrame, encodeFeishuFrame, feishuHeader, FeishuShards, type FeishuFrame } from './feishu-codec';

export interface FeishuAdmission { accepted: boolean; result?: JsonObject }
export interface FeishuSocketCallbacks {
  now: () => number; handshakeTimeoutMs: number;
  connected: () => void; error: (message: string) => void;
  event: (payload: JsonObject) => FeishuAdmission;
}
export interface FeishuSocketOutcome { reason: string; connected: boolean; endpoint: FeishuEndpoint }

/** The reader only admits bounded work. Model turns never block ACKs or heartbeat control. */
export function serveFeishuSocket(initial: FeishuEndpoint, signal: AbortSignal, callbacks: FeishuSocketCallbacks): Promise<FeishuSocketOutcome> {
  if (signal.aborted) return Promise.resolve({ reason: 'Feishu transport stopped', connected: false, endpoint: initial });
  return new Promise(resolve => {
    const options: WebSocket.ClientOptions & { maxFragments: number; maxBufferedChunks: number } = {
      perMessageDeflate: false, followRedirects: false, maxPayload: 1024 * 1024, maxFragments: 1024, maxBufferedChunks: 4096, handshakeTimeout: callbacks.handshakeTimeoutMs,
    };
    const socket = new WebSocket(initial.url, options), shards = new FeishuShards(callbacks.now);
    let endpoint = { ...initial }, reason: string | undefined, connected = false, awaitingPong = false, invalid = 0, heartbeat: NodeJS.Timeout | undefined;
    const end = (value: string): void => { reason ??= value; if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); };
    const cancel = (): void => end('Feishu transport stopped');
    const write = (frame: FeishuFrame): void => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) { end('Feishu gateway writer is unavailable'); return; }
      socket.send(encodeFeishuFrame(frame), { binary: true }, error => { if (error) end('Feishu gateway write failed'); });
    };
    const schedule = (): void => {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(() => { if (awaitingPong) { end('Feishu heartbeat timed out'); return; } ping(); }, endpoint.pingIntervalMs);
    };
    const ping = (): void => {
      if (reason || signal.aborted) return;
      awaitingPong = true; write({ seqId: 0n, logId: 0n, service: endpoint.service, method: 0, headers: [['type', 'ping']] }); schedule();
    };
    signal.addEventListener('abort', cancel, { once: true });
    socket.on('error', () => { reason ??= 'Feishu gateway connection failed'; });
    socket.on('close', code => {
      clearTimeout(heartbeat); shards.clear(); signal.removeEventListener('abort', cancel);
      resolve({ reason: reason ?? 'Feishu gateway closed (code ' + code + ')', connected, endpoint });
    });
    socket.on('open', () => { if (signal.aborted) { cancel(); return; } connected = true; callbacks.connected(); ping(); });
    socket.on('message', (data, binary) => {
      if (reason || signal.aborted) return;
      try {
        if (!binary) throw new Error('Feishu gateway sent a non-binary frame');
        const frame = decodeFeishuFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        if (frame.method === 0) {
          if (feishuHeader(frame, 'type') === 'pong') {
            awaitingPong = false;
            if (frame.payload?.length) endpoint = { ...endpoint, ...feishuTiming(JSON.parse(frame.payload.toString('utf8')), endpoint) };
            schedule();
          }
          return;
        }
        if (frame.method !== 1 || feishuHeader(frame, 'type') !== 'event') return;
        const sum = feishuHeader(frame, 'sum') ?? '1', seq = feishuHeader(frame, 'seq') ?? '0';
        if (!/^\d+$/u.test(sum) || !/^\d+$/u.test(seq)) throw new Error('Invalid Feishu shard header');
        const payload = shards.merge(feishuHeader(frame, 'message_id') ?? '', Number(sum), Number(seq), frame.payload ?? Buffer.alloc(0));
        if (!payload) return;
        const receivedAt = callbacks.now(); let admission: FeishuAdmission;
        try {
          const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Feishu event envelope');
          admission = callbacks.event(object(parsed));
        } catch { callbacks.error('Invalid Feishu event envelope'); admission = { accepted: false }; }
        const ack: JsonObject = { code: admission.accepted ? 200 : 500 };
        if (admission.result) ack.data = Buffer.from(JSON.stringify(admission.result)).toString('base64');
        write({ ...frame, headers: [...frame.headers.filter(([key]) => key !== 'biz_rt'), ['biz_rt', String(Math.max(0, callbacks.now() - receivedAt))]], payload: Buffer.from(JSON.stringify(ack)) });
      } catch { callbacks.error('Invalid Feishu gateway frame'); if (++invalid >= 8) end('Feishu gateway repeatedly sent invalid frames'); }
    });
    if (signal.aborted) cancel();
  });
}
