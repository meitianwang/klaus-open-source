import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const MEASURE_TOOL_COMMAND = 'echo KLAUS_PERF_TOOL';
export function measurementTextChunk(index, background = false) {
  // 保留每块 20 个四字符词及原始字节量，不用重复单词触发引擎循环检测。
  const words = Array.from({ length: 20 }, (_, word) => (index * 20 + word).toString(36).padStart(4, '0') + ' ').join('');
  return `Measured ${background ? 'background' : 'stream'} ${String(index).padStart(4, '0')}: ${words}\n`;
}
const browserDocument = '<!doctype html><html><head><title>Measurement page</title><style>body{margin:0;font:16px sans-serif}header{position:sticky;top:0;background:white;padding:16px}p{height:28px;margin:0;padding:4px 20px;background:linear-gradient(90deg,#d8e7ff,#fff)}</style></head><body><header><label>Fixture input <input id="perf-input"></label></header>'
  + Array.from({ length: 2000 }, (_, index) => `<p>Deterministic browser row ${index}</p>`).join('') + '</body></html>';
function plainText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(value => value?.type === 'text').map(value => value.text ?? '').join('\n') : '';
}
export async function startMeasurementProvider(workload, record) {
  const pending = new Set(), controller = new AbortController(), counters = { requests: 0, toolCalls: 0, streams: 0, chunks: 0, completed: 0, failed: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/measure/browser') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(browserDocument); return; }
    if (request.method !== 'POST' || url.pathname !== '/v1/messages') { response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"No external service in this fixture"}'); return; }
    let requestId;
    const work = (async () => {
      const chunks = []; let length = 0;
      for await (const part of request) { const bytes = Buffer.from(part); length += bytes.length; if (length > 8 * 1024 * 1024) throw new Error('Measurement provider request exceeds 8 MiB'); chunks.push(bytes); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.headers['x-api-key'] !== 'measurement-fixture-key') throw new Error('Unexpected measurement provider credential');
      requestId = ++counters.requests;
      const messages = Array.isArray(body.messages) ? body.messages : [], latest = [...messages].reverse().find(value => value.role === 'user');
      const latestText = plainText(latest?.content), allText = messages.map(value => plainText(value.content)).join('\n');
      const hasResult = Array.isArray(latest?.content) && latest.content.some(value => value.type === 'tool_result');
      const tool = !hasResult && latestText.includes('KLAUS_PERF_STREAM'), background = allText.includes('KLAUS_PERF_BACKGROUND');
      record('provider-request', { request: requestId, mode: tool ? 'tool' : background ? 'background' : 'text', stream: body.stream === true, bytes: length,
        thinking: body.thinking?.type ?? null, maxTokens: body.max_tokens ?? null });
      const message = { id: `measure-${randomUUID()}`, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } };
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'Measured conversation' }], stop_reason: 'end_turn' }));
        counters.completed += 1; record('provider-complete', { request: requestId, stopReason: 'end_turn' }); return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (type, fields) => {
        if (controller.signal.aborted || response.destroyed) throw new Error('Measurement provider stream cancelled');
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      };
      send('message_start', { message });
      if (tool) {
        if (!Array.isArray(body.tools) || !body.tools.some(value => value.name === 'Bash')) throw new Error('The actual model request has no Bash tool');
        counters.toolCalls += 1;
        send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `measure-tool-${randomUUID()}`, name: 'Bash', input: {} } });
        const args = JSON.stringify({ command: MEASURE_TOOL_COMMAND });
        for (const partial_json of [args.slice(0, 10), args.slice(10)]) { send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json } }); await delay(50, undefined, { signal: controller.signal }); }
      } else {
        counters.streams += 1;
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        for (let index = 0; index < workload.streamChunks; index += 1) {
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: measurementTextChunk(index, background) } });
          counters.chunks += 1; await delay(workload.streamChunkIntervalMs, undefined, { signal: controller.signal });
        }
      }
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: tool ? 8 : workload.streamChunks * 30 } });
      send('message_stop', {}); response.end(); counters.completed += 1;
      record('provider-complete', { request: requestId, stopReason: tool ? 'tool_use' : 'end_turn' });
    })().catch(error => {
      counters.failed += 1; record('provider-error', { request: requestId ?? null, message: String(error) });
      if (!response.headersSent) { response.writeHead(500); response.end('Measurement fixture failed'); } else response.destroy();
    }).finally(() => pending.delete(work));
    pending.add(work);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, counters,
    async close() { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.all([...pending]); } };
}
