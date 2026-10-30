import { join } from 'node:path';
import { HostMcpServer, type HostMcpCallContext, type HostMcpServerDeps } from '../main/services/mcp/host-server';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

type Row = Record<string, unknown>;
const h = new Harness();
const schema = { type: 'object', properties: {} };
const question = { message: 'Allow the isolated fixture?', requestedSchema: schema };
const servers: HostMcpServer[] = [];
const make = (deps: Partial<HostMcpServerDeps> = {}) => {
  const server = new HostMcpServer({ name: 'host-fixture', tools: () => [{ name: 'probe', inputSchema: schema }], currentTurn: () => 'turn',
    call: async (_name, _args, context) => ({ content: [{ type: 'text', text: context.sessionId }] }), ...deps });
  servers.push(server); return server;
};
async function* events(response: Response): AsyncGenerator<Row> {
  assert(response.body, 'SSE response body'); const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const end = buffer.indexOf('\n\n'); if (end < 0) break;
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield JSON.parse(data) as Row;
      }
    }
  } finally { reader.releaseLock(); }
}
async function connect(server: HostMcpServer, owner = 'task', capabilities: Row = { elicitation: { form: {} } }, version = '2025-11-25') {
  const capability = await server.hostCapabilities(owner), definition = (capability.mcpServers as Array<Record<string, string>>)[0]!;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = (body: unknown, overrides: Record<string, string> = {}) => fetch(definition.url!, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities, clientInfo: { name: 'fixture', version: '1' } } });
  assertEqual(initialized.status, 200, 'initialize HTTP'); await initialized.json();
  const id = initialized.headers.get('mcp-session-id'); assert(id, 'server-issued connection identity'); headers['mcp-session-id'] = id;
  const ready = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }); assertEqual(ready.status, 202, 'initialized notification acknowledged');
  return { url: definition.url!, id, headers, post,
    call: async (id = 10, args: Row = {}) => {
      const response = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'probe', arguments: args } });
      assertEqual(response.status, 200, 'tool HTTP'); assert(response.headers.get('content-type')?.startsWith('text/event-stream'), 'request-scoped SSE'); return events(response);
    } };
}
async function final(stream: AsyncGenerator<Row>, id = 10): Promise<Row> {
  for await (const row of stream) if (row.id === id && row.result !== undefined) return row.result as Row;
  throw new Error('The response stream ended without its tool result');
}

h.test('loopback capabilities bind tool identity to the host conversation and reject hostile origins', async () => {
  let context: HostMcpCallContext | undefined;
  const server = make({ call: async (_name, _args, value) => { context = value; return { content: [{ type: 'text', text: 'actual result' }] }; } });
  const client = await connect(server);
  assertEqual((await client.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { origin: 'https://hostile.invalid' })).status, 403, 'web origins denied');
  assertEqual((await client.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': 'forged' })).status, 404, 'forged MCP identity denied');
  const result = await final(await client.call(10, { sessionId: 'another-task', turnId: 'forged' }));
  assertEqual(context?.sessionId, 'task', 'arguments cannot replace owner'); assertEqual(context?.turnId, 'turn', 'turn comes from the host'); assertEqual(result.isError, undefined, 'actual tool result');
  await server.shutdown(); assertDeepEqual(server.counts(), { owners: 0, connections: 0, operations: 0, questions: 0 }, 'all resources released');
});
h.test('long operations echo requested progress tokens without inventing completion percentages', async () => {
  let complete!: () => void;
  const server = make({ operationTimeoutMs: 400, call: async () => { await new Promise<void>(resolve => { complete = resolve; }); return {}; } });
  const client = await connect(server);
  const response = await client.post({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'probe', arguments: {}, _meta: { progressToken: 'held-input' } } });
  const stream = events(response), progress = (await stream.next()).value!;
  assertEqual(progress.method, 'notifications/progress', 'requested progress is streamed');
  const params = progress.params as Row;
  assertEqual(params.progressToken, 'held-input', 'request token is preserved'); assertEqual(params.progress, 1, 'report count advances');
  assertEqual(params.total, undefined, 'no fabricated completion estimate'); complete();
  assertEqual((await final(stream)).isError, undefined, 'operation completes once'); await server.shutdown();
});
h.test('elicitation crosses the original SSE request and a separate authenticated response POST', async () => {
  let actions = 0;
  const server = make({ call: async (_name, _args, context) => {
    const reply = await context.elicit(question, context.signal) as Row;
    if (reply.action !== 'accept') throw new Error('not approved'); context.assertCurrent(); actions++; return { content: [{ type: 'text', text: 'approved' }] };
  } });
  const client = await connect(server), other = await connect(server, 'another'), stream = await client.call();
  const approval = (await stream.next()).value!; assertEqual(approval.method, 'elicitation/create', 'server request arrives before tool result');
  assertEqual((await other.post({ jsonrpc: '2.0', id: approval.id, result: { action: 'accept' } })).status, 400, 'another owner cannot answer'); assertEqual(actions, 0, 'no work before authorized response');
  assertEqual((await client.post({ jsonrpc: '2.0', id: approval.id, result: { action: 'accept', content: {} } })).status, 202, 'answer accepted independently');
  assertEqual((await final(stream)).isError, undefined, 'original tool completes'); assertEqual(actions, 1, 'one approved action');
  assertEqual((await client.post({ jsonrpc: '2.0', id: approval.id, result: { action: 'accept' } })).status, 400, 'late duplicate cannot be reused'); await server.shutdown();
});
h.test('declined and unsupported elicitation never become approval', async () => {
  let actions = 0;
  const server = make({ call: async (_name, _args, context) => { const value = await context.elicit(question, context.signal) as Row; if (value.action !== 'accept') throw new Error('declined'); actions++; return {}; } });
  const client = await connect(server), stream = await client.call(), approval = (await stream.next()).value!;
  await client.post({ jsonrpc: '2.0', id: approval.id, result: { action: 'decline' } });
  assertEqual((await final(stream)).isError, true, 'decline surfaced');
  const unsupported = await connect(server, 'unsupported', {}); assertEqual((await final(await unsupported.call())).isError, true, 'missing capability fails explicitly');
  const legacy = await connect(server, 'legacy', { elicitation: { form: {} } }, '2025-03-26');
  assertEqual((await final(await legacy.call())).isError, true, 'a protocol predating elicitation cannot advertise permission support');
  assertEqual(actions, 0, 'no permission bypass'); await server.shutdown();
});
h.test('explicit MCP cancellation rejects the pending approval and drains the accepted operation', async () => {
  const server = make({ call: async (_name, _args, context) => { await context.elicit(question, context.signal); return {}; } });
  const client = await connect(server), stream = await client.call(); await stream.next();
  assertEqual((await client.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10 } })).status, 202, 'cancellation acknowledged');
  assertEqual((await final(stream)).isError, true, 'original request receives its cancellation error');
  assertEqual(server.counts().questions, 0, 'approval waiter removed'); assertEqual(server.counts().operations, 0, 'operation settled'); await server.shutdown();
});
h.test('the operation budget bounds active work but pauses while an elicitation waits', async () => {
  let answer!: () => void;
  const server = make({ operationTimeoutMs: 60, call: async (_name, _args, context) => {
    await context.elicit(question, context.signal);
    await new Promise<void>(resolve => { answer = resolve; });
    return {};
  } });
  const client = await connect(server), stream = await client.call();
  const approval = (await stream.next()).value!;
  assertEqual(approval.method, 'elicitation/create', 'approval requested');
  await waitFor(() => server.counts().questions === 1, 1000, 'question parked');
  // The 60 ms budget would expire during the wait if it kept running.
  await new Promise(resolve => setTimeout(resolve, 150));
  assertEqual(server.counts().questions, 1, 'the wait is not bounded by the paused budget');
  assertEqual((await client.post({ jsonrpc: '2.0', id: approval.id, result: { action: 'accept', content: {} } })).status, 202, 'answer accepted');
  await waitFor(() => !!answer, 1000, 'the operation resumes past the elicitation');
  answer();
  assertEqual((await final(stream)).isError, undefined, 'the operation resumes and finishes'); await server.shutdown();
});
h.test('a question that dies without a user answer reports cancellation to the host', async () => {
  const cancelled: string[] = [];
  const server = make({ onElicitationCancelled: (sessionId, requestId) => cancelled.push(`${sessionId}:${requestId}`),
    call: async (_name, _args, context) => { await context.elicit(question, context.signal); return {}; } });
  const client = await connect(server), stream = await client.call();
  const approval = (await stream.next()).value!; assertEqual(approval.method, 'elicitation/create', 'approval requested');
  await server.cancelTurn('task', 'turn');
  assertEqual((await final(stream)).isError, true, 'the operation fails once its question dies');
  assertEqual(cancelled.length, 1, 'the host learns its card must close');
  assertEqual(cancelled[0]!.endsWith(String(approval.id)), true, 'the cancelled identity is the presented question');
  await server.shutdown();
});
h.test('active work is timed out after an answered elicitation resumes its budget', async () => {
  let aborted = false;
  const server = make({ operationTimeoutMs: 100, call: async (_name, _args, context) => {
    await context.elicit(question, context.signal);
    await new Promise<void>((_resolve, reject) => {
      const stop = () => { aborted = true; reject(context.signal.reason); };
      context.signal.addEventListener('abort', stop, { once: true }); if (context.signal.aborted) stop();
    });
    return {};
  } });
  const client = await connect(server), stream = await client.call(), approval = (await stream.next()).value!;
  await new Promise(resolve => setTimeout(resolve, 180));
  assertEqual(server.counts().questions, 1, 'approval wait does not consume active time');
  await client.post({ jsonrpc: '2.0', id: approval.id, result: { action: 'accept' } });
  await waitFor(() => aborted, 1500, 'resumed active budget expires');
  const result = await final(stream); assertEqual(result.isError, true, 'timeout is returned as a tool error');
  assertEqual(server.counts().operations, 0, 'timed out operation drains'); await server.shutdown();
});
h.test('overlapping approval waits pause one operation until its last answer', async () => {
  const server = make({ operationTimeoutMs: 100, call: async (_name, _args, context) => {
    await Promise.all([context.elicit(question, context.signal), context.elicit(question, context.signal)]); return {};
  } });
  const client = await connect(server), stream = await client.call();
  const first = (await stream.next()).value!, second = (await stream.next()).value!;
  await client.post({ jsonrpc: '2.0', id: first.id, result: { action: 'accept' } });
  await new Promise(resolve => setTimeout(resolve, 180));
  assertEqual(server.counts().questions, 1, 'remaining approval keeps the active clock paused');
  await client.post({ jsonrpc: '2.0', id: second.id, result: { action: 'accept' } });
  assertEqual((await final(stream)).isError, undefined, 'both answers resume one operation'); await server.shutdown();
});
h.test('session release revokes old URLs and awaits pending elicitation cleanup before replacement', async () => {
  const server = make({ call: async (_name, _args, context) => { await context.elicit(question, context.signal); return {}; } });
  const client = await connect(server), stream = await client.call(); await stream.next();
  await server.releaseSession('task'); assertEqual((await final(stream)).isError, true, 'released owner aborts approval');
  assertEqual((await client.post({ jsonrpc: '2.0', id: 11, method: 'tools/list' })).status, 404, 'old capability revoked');
  const next = await connect(server); assert(next.url !== client.url, 'new generation gets a fresh capability'); await server.shutdown();
});
h.test('a drain deadline retains the real resource and blocks a replacement until it settles', async () => {
  let release!: () => void;
  const server = make({ call: async () => { await new Promise<void>(resolve => { release = resolve; }); return {}; } });
  const client = await connect(server), stream = await client.call(); await waitFor(() => !!release, 1000, 'operation is accepted');
  await assertRejects(() => server.releaseSession('task', 10), 'uncooperative action missed deadline');
  assertEqual(server.counts().operations, 1, 'resource still owned'); await assertRejects(() => server.hostCapabilities('task'), 'cannot resurrect owner');
  release(); assertEqual((await final(stream)).isError, true, 'late completion is cancelled'); await server.releaseSession('task');
  await connect(server); await server.shutdown();
});
h.test('closing while the loopback listener starts cannot resurrect a released capability', async () => {
  const server = make(), starting = server.hostCapabilities('task'); void starting.catch(() => {});
  await server.releaseSession('task'); await assertRejects(() => starting, 'late startup is stale'); assertEqual(server.counts().owners, 0, 'no orphan owner'); await server.shutdown();
});
h.test('turn replacement invalidates a pending tool before it can perform a later action', async () => {
  let turn = 'turn', release!: () => void, actions = 0;
  const server = make({ currentTurn: () => turn, call: async (_name, _args, context) => {
    await new Promise<void>(resolve => { release = resolve; }); context.assertCurrent(); actions++; return {};
  } });
  const client = await connect(server), stream = await client.call(); await waitFor(() => !!release, 1000, 'tool is held');
  turn = 'replacement'; server.cancelTurn('task', 'turn'); release(); assertEqual((await final(stream)).isError, true, 'stale tool fails'); assertEqual(actions, 0, 'new turn is not affected'); await server.shutdown();
});
h.test('duplicate active RPC IDs cannot execute a second operation', async () => {
  let release!: () => void, executions = 0;
  const server = make({ call: async () => { executions++; await new Promise<void>(resolve => { release = resolve; }); return {}; } });
  const client = await connect(server), stream = await client.call(); await waitFor(() => !!release, 1000, 'first call');
  const duplicate = await client.post({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'probe' } });
  assertEqual(duplicate.status, 429, 'duplicate active request refused'); assertEqual(executions, 1, 'one action'); release(); await final(stream); await server.shutdown();
});

h.test('losing an HTTP response does not cancel the accepted MCP operation', async () => {
  let release!: () => void, actions = 0, signal: AbortSignal | undefined;
  const server = make({ call: async (_name, _args, context) => {
    signal = context.signal; await new Promise<void>(resolve => { release = resolve; }); context.assertCurrent(); actions++; return {};
  } });
  const client = await connect(server);
  try {
    const response = await client.post({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'probe' } });
    await waitFor(() => !!release, 1000, 'operation accepted before disconnection');
    await response.body!.cancel();
    const ping = await client.post({ jsonrpc: '2.0', id: 11, method: 'ping' });
    assertEqual(ping.status, 200, 'the authenticated MCP session survives response disconnection'); await ping.json();
    assertEqual(signal?.aborted, false, 'only explicit cancellation ends the operation');
    release(); await waitFor(() => server.counts().operations === 0, 1000, 'disconnected response drains after actual completion');
    assertEqual(actions, 1, 'the accepted action completes');
  } finally { release?.(); await server.shutdown(); }
});

h.test('server shutdown preserves accepted resources after its caller deadline', async () => {
  let release!: () => void;
  const server = make({ call: async () => { await new Promise<void>(resolve => { release = resolve; }); return {}; } });
  const client = await connect(server), stream = await client.call();
  try {
    await waitFor(() => !!release, 1000, 'operation accepted');
    await assertRejects(() => server.shutdown(10), 'the caller sees the shutdown deadline');
    assertEqual(server.counts().operations, 1, 'the underlying action remains owned');
    assertEqual((await client.post({ jsonrpc: '2.0', id: 11, method: 'ping' })).status, 403, 'shutdown revokes network access immediately');
    assertDeepEqual(await server.hostCapabilities('replacement'), { mcpServers: [], runtimeCapabilityRoots: [] }, 'shutdown cannot create another listener');
    release(); assertEqual((await final(stream)).isError, true, 'late completion cannot escape shutdown');
    await server.shutdown(); assertDeepEqual(server.counts(), { owners: 0, connections: 0, operations: 0, questions: 0 }, 'a later wait observes actual drain');
  } finally { release?.(); await server.shutdown(); }
});

void h.finish(join(__dirname, 'host-mcp-result.json'), 'host-mcp').then(async code => { for (const server of servers) await server.shutdown(); process.exitCode = code; });
