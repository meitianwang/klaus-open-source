import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/** A loopback-only model endpoint and tool barrier for the running queue fixture. */
export async function startQueueSteerProvider(directive: string) {
  const requests: Array<Record<string, unknown>> = [];
  const waiting = new Set<ServerResponse>();
  let entered = 0;
  let released = false;
  let url = '';
  const release = () => {
    released = true;
    for (const response of waiting) response.end('QUEUE_TOOL_BARRIER_RELEASED\n');
    waiting.clear();
  };
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/queue-tool-barrier') {
      entered++;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.flushHeaders();
      if (released) response.end('QUEUE_TOOL_BARRIER_RELEASED\n');
      else { waiting.add(response); response.once('close', () => waiting.delete(response)); }
      return;
    }
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) request.destroy(new Error('Fixture request exceeded its limit'));
      else chunks.push(chunk);
    });
    request.on('error', () => response.destroy());
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (request.url?.endsWith('/count_tokens')) {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":10}'); return;
        }
        requests.push(body);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const sawDirective = JSON.stringify(messages).includes(directive);
        const hasToolResult = messages.some(value => value && typeof value === 'object'
          && Array.isArray((value as { content?: unknown }).content)
          && (value as { content: Array<{ type?: string }> }).content.some(block => block.type === 'tool_result'));
        const tool = !sawDirective && !hasToolResult;
        const message = { id: `msg_queue_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model || 'queue-fixture-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
        if (body.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'Queue fixture auxiliary response.' }], stop_reason: 'end_turn' })); return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send('message_start', { message });
        if (tool) {
          const tools = Array.isArray(body.tools) ? body.tools as Array<{ name?: string }> : [];
          if (!tools.some(row => row.name === 'Bash')) throw Error('The production engine did not offer its shell tool');
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_queue_${randomUUID()}`, name: 'Bash', input: {} } });
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `curl --fail --silent --show-error --max-time 90 ${url}/queue-tool-barrier`, timeout: 100000, description: 'Wait for the local queue validation barrier' }) } });
        } else {
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: sawDirective ? 'QUEUE_STEER_APPLIED_FIXTURE' : 'QUEUE_PARENT_FINISHED_WITHOUT_STEER' } });
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
        send('message_stop', {}); response.end();
      } catch (error) { response.destroy(error as Error); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, release, entered: () => entered, waiting: () => waiting.size,
    close: () => new Promise<void>((resolve, reject) => { release(); server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
