import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/** Loopback model protocol endpoint; the application and engine retain their normal implementations. */
export async function startDesktopPetProvider() {
  const requests: Array<Record<string, unknown>> = [];
  const issued = new Set<string>(), released = new Set<string>(), paused = new Set<string>();
  const active = new Map<string, { response: ServerResponse; finish(): void }>();
  const phases = new Map<string, string>();
  const release = (key?: string) => {
    for (const [id, stream] of active) if (!key || id === key) { released.add(id); stream.finish(); }
  };
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    request.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
    request.on('error', () => response.destroy());
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (request.url?.endsWith('/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":100}'); return; }
        requests.push(body);
        const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
        const text = JSON.stringify(messages);
        const keys = [...text.matchAll(/PET_CASE_[A-Z0-9_]+/g)].map(match => match[0]);
        const key = keys.at(-1) || 'PET_CASE_AUXILIARY';
        const tools = Array.isArray(body.tools) ? body.tools as Array<{ name?: string; input_schema?: { required?: string[] } }> : [];
        const message = { id: `msg_pet_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model || 'pet-fixture-model', content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } };
        if (body.stream !== true) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'Companion test task' }], stop_reason: 'end_turn' })); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        const terminal = (reason: string) => { send('content_block_stop', { index: 0 }); send('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1000 } }); send('message_stop', {}); response.end(); };
        send('message_start', { message });
        const emitTool = (name: string, input: Record<string, unknown>, phase: string) => {
          if (!tools.some(tool => tool.name === name)) throw Error(`Required production tool was not offered: ${name}`);
          phases.set(key, phase);
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_pet_${randomUUID()}`, name, input: {} } });
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }); terminal('tool_use');
        };
        const choice = body.tool_choice as { type?: string; name?: string } | undefined;
        if (choice?.type === 'tool' && choice.name === 'emit_result') {
          const required = tools.find(tool => tool.name === choice.name)?.input_schema?.required;
          const result = required?.includes('title') ? { title: 'Companion test task' }
            : required?.includes('suggestion') ? { suggestion: null } : undefined;
          if (!result) throw Error('Unsupported structured fixture result schema');
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_pet_${randomUUID()}`, name: choice.name, input: {} } });
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(result) } });
          terminal('tool_use'); return;
        }
        if (!issued.has(key + ':summary') && key !== 'PET_CASE_AUXILIARY') {
          const name = tools.find(tool => tool.name?.endsWith('update_running_summary'))?.name;
          if (!name) throw Error('The production engine did not expose the current-task summary tool');
          issued.add(key + ':summary');
          emitTool(name, { summary: key.includes('INVALID') ? 'Invalid\nsummary' : 'Checking companion runtime' }, 'summary'); return;
        }
        if (key.includes('APPROVAL') && !issued.has(key + ':approval')) {
          issued.add(key + ':approval');
          emitTool('Bash', { command: 'printf companion-approval > companion-approval.txt', description: 'Write the companion validation marker', sandbox_permissions: 'require_escalated', justification: 'Validate the companion approval response in the isolated test workspace' }, 'approval'); return;
        }
        if (key.includes('QUESTION') && !issued.has(key + ':question')) {
          issued.add(key + ':question');
          emitTool('ask_user', { questions: [{ id: 'target', header: 'Target', question: 'Choose the companion validation target', options: [{ label: 'Local', description: 'Use the isolated profile' }, { label: 'Later', description: 'Defer this task' }], multiSelect: false }] }, 'question'); return;
        }
        phases.set(key, 'streaming');
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        let index = 0, finished = false;
        const finish = () => { if (finished) return; finished = true; clearInterval(timer); active.delete(key); phases.set(key, 'completed'); send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '\nCOMPANION_RESPONSE_COMPLETE' } }); terminal('end_turn'); };
        const timer = setInterval(() => {
          if (response.destroyed) { clearInterval(timer); active.delete(key); phases.set(key, 'cancelled'); return; }
          if (paused.has(key)) return;
          const count = key.includes('RETAIN') ? 4 : 768;
          for (let batch = 0; batch < 4 && index < count; batch++, index++) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `fragment-${index} ` } });
          if (index === count && (!key.includes('HOLD') || released.has(key))) finish();
        }, 8);
        active.set(key, { response, finish });
        response.once('close', () => { clearInterval(timer); if (!finished) { active.delete(key); phases.set(key, 'cancelled'); } });
      } catch (error) { response.destroy(error as Error); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, release,
    pause: (key: string) => paused.add(key), resume: (key: string) => paused.delete(key),
    phase: (key: string) => phases.get(key),
    close: () => new Promise<void>((resolve, reject) => { release(); server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
