import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkflowRequest } from './workflow-provider';

export type GoalControlsStep = {
  name: string;
  inspect?(request: WorkflowRequest): void;
} & ({ kind: 'tool'; tool: string; input: Record<string, unknown> } | { kind: 'text'; text: string });

interface Receipt { name: string; request: WorkflowRequest; completed: boolean }
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPTS = 16;
const MAX_STEPS = 8;

/** A bounded real HTTP provider; every streaming request needs an admitted response. */
export async function startGoalControlsProvider() {
  const steps: GoalControlsStep[] = [];
  const receipts: Receipt[] = [];
  const httpRequests: Array<{ method: string; path: string; userAgent: string; atMs: number }> = [];
  const failures: string[] = [];
  let httpCount = 0, postCount = 0, streamCount = 0;
  const failure = (error: unknown) => {
    failures.push(error instanceof Error ? error.message : String(error));
    if (failures.length > MAX_RECEIPTS) failures.shift();
  };
  const server = createServer((request, response) => {
    httpCount++;
    httpRequests.push({ method: request.method ?? '', path: (request.url ?? '').slice(0, 512), userAgent: (request.headers['user-agent'] ?? '').slice(0, 256), atMs: Date.now() });
    if (httpRequests.length > MAX_RECEIPTS) httpRequests.shift();
    if (request.method === 'GET' || request.method === 'HEAD') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    postCount++;
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('error', error => { failure(error); response.destroy(); });
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkflowRequest;
        const step = steps[0];
        if (body.stream !== true || !step) throw new Error('Unexpected provider request without an admitted streaming step');
        streamCount++;
        const receipt: Receipt = { name: step.name, request: body, completed: false };
        receipts.push(receipt);
        if (receipts.length > MAX_RECEIPTS) receipts.shift();
        step.inspect?.(body);
        if (step.kind === 'tool' && !(body.tools ?? []).some(tool => tool.name === step.tool)) throw new Error(`The actual engine did not offer ${step.tool}`);
        steps.shift();
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        emit(response, 'message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model ?? 'goal-controls-model',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 1 } } });
        if (step.kind === 'tool') {
          emit(response, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: `goal_controls_${randomUUID()}`, name: step.tool, input: {} } });
          const input = JSON.stringify(step.input);
          for (let offset = 0; offset < input.length; offset += 11) emit(response, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: input.slice(offset, offset + 11) } });
        } else {
          emit(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          emit(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } });
        }
        emit(response, 'content_block_stop', { index: 0 });
        emit(response, 'message_delta', { delta: { stop_reason: step.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 16 } });
        emit(response, 'message_stop', {});
        response.end();
        receipt.completed = true;
      } catch (error) {
        failure(error);
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Goal controls fixture rejected an unexpected request' }));
      }
    });
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) request.destroy(new Error('Provider request exceeds the fixture body limit'));
      else chunks.push(chunk);
    });
  });
  server.maxConnections = 16;
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => { server.off('error', reject); resolve(); });
    server.listen(0, '127.0.0.1');
  });
  server.on('error', failure);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    receipts, failures, httpRequests,
    get httpCount() { return httpCount; }, get postCount() { return postCount; }, get streamCount() { return streamCount; },
    get pendingCount() { return steps.length; },
    enqueue(...next: GoalControlsStep[]) {
      if (steps.length + next.length > MAX_STEPS) throw new Error('Goal controls response script exceeds its bound');
      steps.push(...next);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function emit(response: ServerResponse, type: string, value: Record<string, unknown>) {
  if (!response.destroyed) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
}
