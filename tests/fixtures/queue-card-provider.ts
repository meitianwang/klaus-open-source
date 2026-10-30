import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/** A loopback-only model endpoint and tool barrier for the running queue fixture. */
export async function startQueueCardProvider() {
  const requests: Array<Record<string, unknown>> = [];
  const waiting = new Map<string, Set<ServerResponse>>();
  const issued = new Set<string>();
  const entered = new Map<string, number>();
  const released = new Set<string>();
  let url = '';
  const release = (key?: string) => {
    for (const [name, responses] of waiting) {
      if (key && name !== key) continue;
      released.add(name);
      for (const response of responses) response.end('QUEUE_CARD_BARRIER_RELEASED\n');
      responses.clear();
    }
  };
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/barrier/')) {
      const key = decodeURIComponent(request.url.slice('/barrier/'.length));
      entered.set(key, (entered.get(key) || 0) + 1);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.flushHeaders();
      if (released.has(key)) response.end('QUEUE_CARD_BARRIER_RELEASED\n');
      else {
        const responses = waiting.get(key) || new Set<ServerResponse>();
        waiting.set(key, responses); responses.add(response);
        response.once('close', () => responses.delete(response));
      }
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
        const serialized = JSON.stringify(messages);
        const keys = [...serialized.matchAll(/QUEUE_CARD_HOLD_[A-Z0-9_]+/g)].map(match => match[0]);
        const tools = Array.isArray(body.tools) ? body.tools as Array<{ name?: string; input_schema?: { required?: string[] } }> : [];
        // Auxiliary title and suggestion requests share the prompt but cannot own the shell barrier.
        const key = tools.some(row => row.name === 'Bash') ? keys.find(value => !issued.has(value)) : undefined;
        const tool = body.stream === true && Boolean(key);
        if (tool) issued.add(key!);
        const message = { id: `msg_queue_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model || 'queue-fixture-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
        if (body.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'Queue fixture auxiliary response.' }], stop_reason: 'end_turn' })); return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send('message_start', { message });
        const choice = body.tool_choice as { type?: string; name?: string } | undefined;
        if (choice?.type === 'tool' && choice.name === 'emit_result') {
          const required = tools.find(row => row.name === choice.name)?.input_schema?.required;
          const result = required?.includes('title') ? { title: 'Queue validation task' }
            : required?.includes('suggestion') ? { suggestion: null } : undefined;
          if (!result) throw Error('Unsupported structured fixture result schema');
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_queue_${randomUUID()}`, name: choice.name, input: {} } });
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(result) } });
          send('content_block_stop', { index: 0 });
          send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } });
          send('message_stop', {}); response.end(); return;
        }
        if (tool) {
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_queue_${randomUUID()}`, name: 'Bash', input: {} } });
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `curl --fail --silent --show-error --max-time 240 ${url}/barrier/${key}`, timeout: 250000, description: 'Wait for the local queue validation barrier' }) } });
        } else {
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'QUEUE_CARD_FINISHED' } });
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
        send('message_stop', {}); response.end();
      } catch (error) { response.destroy(error as Error); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, release, entered: (key: string) => entered.get(key) || 0, waiting: (key: string) => waiting.get(key)?.size || 0,
    close: () => new Promise<void>((resolve, reject) => { release(); server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
