import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface WorkflowRequest {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
  system?: unknown;
  tools?: Array<{ name?: string; input_schema?: unknown }>;
  [key: string]: unknown;
}

export type WorkflowStep = {
  name: string;
  inspect?(request: WorkflowRequest): void;
} & (
  | { kind: 'text'; chunks: string[] }
  | { kind: 'tool'; tool: string | ((request: WorkflowRequest) => string); input: Record<string, unknown> }
  | { kind: 'hold'; text: string }
  | { kind: 'usage-limit' }
  | { kind: 'request-error' }
);

export interface WorkflowReceipt {
  name: string;
  tools: string[];
  request: WorkflowRequest;
  toolCallId?: string;
  completed: boolean;
  transportClosed: boolean;
  cancelled: boolean;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_STEPS = 64;
const MAX_RECEIPTS = 32;

/** Real local HTTP transport with an explicit, bounded response script. */
export async function startWorkflowProvider() {
  const steps: WorkflowStep[] = [];
  const receipts: WorkflowReceipt[] = [];
  const nonstreamRequests: WorkflowRequest[] = [];
  const failures: string[] = [];
  const held = new Set<() => void>();
  let streamCount = 0;
  let postCount = 0;
  let rejectedStep: Error | undefined;
  const fail = (error: unknown) => {
    failures.push(error instanceof Error ? error.message : String(error));
    if (failures.length > MAX_RECEIPTS) failures.shift();
  };
  const server = createServer((request, response) => {
    request.on('error', error => { rejectedStep ??= error; fail(error); response.destroy(); });
    if (request.method === 'GET' || request.method === 'HEAD') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      rejectedStep ??= new Error(`Unexpected provider method ${request.method}`);
      fail(rejectedStep);
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'The fixture admits only explicit POST inference requests' }));
      request.resume();
      return;
    }
    postCount++;
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('end', () => {
      void (async () => {
        if (rejectedStep) throw rejectedStep;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkflowRequest;
        if (body.stream !== true) {
          nonstreamRequests.push(body);
          if (nonstreamRequests.length > MAX_RECEIPTS) nonstreamRequests.shift();
          throw new Error('Unexpected nonstream POST inference request without an admitted fixture step');
        }
        const step = steps[0];
        if (!step) throw new Error('Unexpected streaming request without an admitted fixture step');
        const receipt: WorkflowReceipt = {
          name: step.name, tools: (body.tools ?? []).map(tool => String(tool.name ?? '')), request: body,
          completed: false, transportClosed: false, cancelled: false,
        };
        response.once('close', () => {
          receipt.transportClosed = true;
          receipt.cancelled = !response.writableEnded;
        });
        receipts.push(receipt);
        if (receipts.length > MAX_RECEIPTS) receipts.shift();
        streamCount++;
        let tool: string | undefined;
        try {
          step.inspect?.(body);
          if (step.kind === 'tool') {
            tool = typeof step.tool === 'string' ? step.tool : step.tool(body);
            if (!receipt.tools.includes(tool)) throw new Error(`The engine did not offer required tool ${tool}`);
          }
        } catch (error) {
          rejectedStep = new Error(`Fixture step ${step.name} rejected its request: ${error instanceof Error ? error.message : String(error)}`);
          throw rejectedStep;
        }
        steps.shift();
        if (step.kind === 'usage-limit' || step.kind === 'request-error') {
          const quota = step.kind === 'usage-limit';
          response.writeHead(quota ? 429 : 400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'error', error: { code: quota ? 'insufficient_quota' : 'invalid_request_error',
            type: quota ? 'insufficient_quota' : 'invalid_request_error', message: quota ? 'Fixture usage allowance is exhausted' : 'The controlled fixture request is invalid' } }));
          receipt.completed = true;
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        emit(response, 'message_start', { message: message(body, [], null) });
        if (step.kind === 'tool') {
          receipt.toolCallId = `workflow_${randomUUID()}`;
          emit(response, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: receipt.toolCallId, name: tool, input: {} } });
          const input = JSON.stringify(step.input);
          for (let offset = 0; offset < input.length; offset += 11) {
            emit(response, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: input.slice(offset, offset + 11) } });
          }
        } else {
          emit(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          if (step.kind === 'hold') {
            await new Promise<void>(resolve => {
              const release = () => { held.delete(release); resolve(); };
              held.add(release);
              response.once('close', release);
            });
            emit(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } });
          } else {
            for (const text of step.chunks) {
              emit(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
              await new Promise<void>(resolve => setTimeout(resolve, 8));
            }
          }
        }
        emit(response, 'content_block_stop', { index: 0 });
        emit(response, 'message_delta', { delta: { stop_reason: step.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 16 } });
        emit(response, 'message_stop', {});
        response.end();
        receipt.completed = true;
      })().catch(error => {
        rejectedStep ??= error instanceof Error ? error : new Error(String(error));
        fail(error);
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Workflow fixture rejected an unexpected request' }));
      });
    });
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) request.destroy(new Error('Workflow request exceeds the fixture body bound'));
      else chunks.push(chunk);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    receipts,
    nonstreamRequests,
    failures,
    get streamCount() { return streamCount; },
    get postCount() { return postCount; },
    get heldCount() { return held.size; },
    get pendingCount() { return steps.length; },
    enqueue(...next: WorkflowStep[]) {
      if (steps.length + next.length > MAX_STEPS) throw new Error('Workflow script exceeds its admitted step bound');
      steps.push(...next);
    },
    release() { for (const release of [...held]) release(); },
    async close() {
      for (const release of [...held]) release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function message(request: WorkflowRequest, content: unknown[], stopReason: string | null) {
  return { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: request.model ?? 'workflow-model', content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 1 } };
}

function emit(response: ServerResponse, type: string, fields: Record<string, unknown>) {
  if (!response.destroyed) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
}
