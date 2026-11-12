import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A bounded loopback endpoint with a response barrier independent of tools. */
export async function startComposerLifecycleProvider(options: { responseText?: string } = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const pending = new Set<() => void>();
  let holdNext = false, holdBeforeText = false, entered = 0;
  const release = () => { for (const finish of [...pending]) finish(); };
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('error', () => response.destroy());
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) request.destroy(Error('Fixture request exceeded its limit'));
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (request.url?.endsWith('/count_tokens')) {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":10}'); return;
        }
        requests.push(body); if (requests.length > 50) requests.shift();
        const message = { id: `msg_input_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model || 'queue-fixture-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
        if (body.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'Local fixture auxiliary response.' }], stop_reason: 'end_turn' })); return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        let deferredText: (() => void) | undefined;
        const finish = () => {
          pending.delete(finish);
          if (response.destroyed || response.writableEnded) return;
          deferredText?.();
          send('content_block_stop', { index: 0 });
          send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
          send('message_stop', {}); response.end();
        };
        response.once('close', () => pending.delete(finish));
        send('message_start', { message });
        const tools = Array.isArray(body.tools) ? body.tools as Array<{ name?: string; input_schema?: { required?: string[] } }> : [];
        const choice = body.tool_choice as { type?: string; name?: string } | undefined;
        if (choice?.type === 'tool' && choice.name === 'emit_result') {
          const required = tools.find(row => row.name === choice.name)?.input_schema?.required;
          const result = required?.includes('title') ? { title: 'Composer validation task' }
            : required?.includes('suggestion') ? { suggestion: null } : undefined;
          if (!result) throw Error('Unsupported structured fixture result schema');
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_input_${randomUUID()}`, name: choice.name, input: {} } });
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(result) } });
          send('content_block_stop', { index: 0 });
          send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } });
          send('message_stop', {}); response.end(); return;
        }
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        const emitText = () => send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: options.responseText ?? 'COMPOSER_FIXTURE_RESPONSE' } });
        // Only the normal agent response owns a hold; title requests also stream.
        const held = holdNext && tools.some(row => row.name === 'Bash');
        if (held && holdBeforeText) deferredText = emitText;
        else emitText();
        if (held) { holdNext = false; holdBeforeText = false; entered++; pending.add(finish); }
        else finish();
      } catch (error) { response.destroy(error as Error); }
    });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, release,
    holdNext: (beforeText = false) => { holdNext = true; holdBeforeText = beforeText; }, entered: () => entered,
    close: () => new Promise<void>((done, reject) => { release(); server.closeAllConnections(); server.close(error => error ? reject(error) : done()); }),
  };
}
