import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A loopback Anthropic-style endpoint for one long turn that compacts itself.
 *
 * Requests that carry tools play a scripted turn: the first `toolRounds` replies
 * call Bash once each and report `reportedInputTokens` of usage, so the engine
 * crosses its automatic compaction limit in the middle of the turn. Requests
 * without tools are the compaction summary and get a short text. After the tool
 * rounds the next tool-bearing request is held open until `release()`, which
 * keeps the turn running for as long as the test needs.
 */
export async function startCompactingTurnProvider(options: { toolRounds: number; reportedInputTokens: number }) {
  const requests: Array<{ tools: boolean; at: number }> = [];
  const pending = new Set<() => void>();
  let armed = false, toolCalls = 0, summaries = 0, held = 0;
  const release = () => { for (const finish of [...pending]) finish(); };
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (request.url?.endsWith('/count_tokens')) {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":10}'); return;
        }
        const tools = Array.isArray(body.tools) ? body.tools as Array<{ name?: string; input_schema?: { required?: string[] } }> : [];
        requests.push({ tools: tools.length > 0, at: Date.now() }); if (requests.length > 200) requests.shift();
        const usage = { input_tokens: armed && tools.some(row => row.name === 'Bash') ? options.reportedInputTokens : 10, output_tokens: 1 };
        const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model || 'compact-fixture-model', content: [], stop_reason: null, usage };
        if (body.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'Fixture auxiliary response.' }], stop_reason: 'end_turn' })); return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send('message_start', { message });
        const choice = body.tool_choice as { type?: string; name?: string } | undefined;
        if (choice?.type === 'tool' && choice.name === 'emit_result') {
          const required = tools.find(row => row.name === choice.name)?.input_schema?.required;
          const result = required?.includes('title') ? { title: 'Compaction fixture task' } : required?.includes('suggestion') ? { suggestion: null } : {};
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${randomUUID()}`, name: choice.name, input: {} } });
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(result) } });
          send('content_block_stop', { index: 0 });
          send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } });
          send('message_stop', {}); response.end(); return;
        }
        const endText = (text: string) => {
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
          send('content_block_stop', { index: 0 });
          send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
          send('message_stop', {}); response.end();
        };
        if (!tools.length) { summaries++; endText('FIXTURE_COMPACTION_SUMMARY: the turn is syncing the repository.'); return; }
        if (armed && tools.some(row => row.name === 'Bash') && toolCalls < options.toolRounds) {
          toolCalls++;
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `Step ${toolCalls}: running a command.` } });
          send('content_block_stop', { index: 0 });
          send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: `toolu_${randomUUID()}`, name: 'Bash', input: {} } });
          send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `echo FIXTURE_STEP_${toolCalls}`, description: `Fixture step ${toolCalls}` }) } });
          send('content_block_stop', { index: 1 });
          send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
          send('message_stop', {}); response.end(); return;
        }
        if (armed && tools.some(row => row.name === 'Bash')) {
          held++;
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Waiting on the last step.' } });
          const finish = () => {
            pending.delete(finish);
            if (response.destroyed || response.writableEnded) return;
            send('content_block_stop', { index: 0 });
            send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
            send('message_stop', {}); response.end();
          };
          response.once('close', () => pending.delete(finish));
          pending.add(finish);
          return;
        }
        endText('ORDINARY_FIXTURE_REPLY');
      } catch (error) { response.destroy(error as Error); }
    });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, release,
    arm: () => { armed = true; },
    stats: () => ({ toolCalls, summaries, held }),
    close: () => new Promise<void>((done, reject) => { release(); server.closeAllConnections(); server.close(error => error ? reject(error) : done()); }),
  };
}
