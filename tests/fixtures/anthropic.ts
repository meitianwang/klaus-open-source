import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Json } from '../../main/ipc/contract';
import { object } from '../../main/ipc/arguments';

interface AgentFixtureTurns { started: number; active: number; waiting: Set<() => void> }

/** Local provider fixture; it performs no model or external network requests. */
export async function startProvider(command: string): Promise<{ url: string; requests: Record<string, Json>[]; sideQuestions: {started:number;closed:number;active:number}; agents: AgentFixtureTurns & {release():void}; close(): Promise<void> }> {
  const requests: Record<string, Json>[] = [];
  const sideQuestions = {started:0,closed:0,active:0};
  const agentTurns: AgentFixtureTurns = { started: 0, active: 0, waiting: new Set() };
  const agents = Object.assign(agentTurns, { release: () => { for (const release of agentTurns.waiting) release(); } });
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/browser-fixture') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><title>Shared browser fixture</title><body><label>Shared value<input id="field" value="MANUAL_VALUE"></label></body></html>');
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) request.destroy(new Error('Fixture request too large'));
      else chunks.push(chunk);
    });
    request.on('error', () => response.destroy());
    request.on('end', () => {
      try {
        const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) ?? {};
        requests.push(body);
        if (requests.length > 64) requests.shift();
        void reply(response, body, command, sideQuestions, agents).catch(() => response.destroy());
      } catch { response.writeHead(400); response.end(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    sideQuestions,
    agents,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function reply(response: ServerResponse, body: Record<string, Json>, command: string, sideQuestions: {started:number;closed:number;active:number}, agents: AgentFixtureTurns): Promise<void> {
  const messages = Array.isArray(body.messages) ? body.messages.map(row => object(row) ?? {}) : [];
  const last = [...messages].reverse().find(row => row.role === 'user');
  const content = last?.content;
  const userText = (value: Json | undefined): string => typeof value === 'string' ? value : Array.isArray(value)
    ? value.map(block => object(block)).filter(block => block?.type === 'text').map(block => String(block!.text ?? '')).join(' ') : '';
  const hasResult = Array.isArray(content) && content.some(block => object(block)?.type === 'tool_result');
  const text = hasResult ? userText([...messages].reverse().find(row => row.role === 'user' && userText(row.content))?.content as Json) : userText(content as Json);
  const mcp = text.trim() === 'MCP ECHO FIXTURE';
  const finder = text.startsWith('FINDER CONNECTOR FIXTURE ');
  const canvas = text.startsWith('CANVAS FIXTURE ');
  const diagram = text.trim() === 'DIAGRAM FIXTURE';
  const diagramEdit = text.startsWith('DIAGRAM EDIT FIXTURE ');
  const diagramExport = text.startsWith('DIAGRAM EXPORT FIXTURE ');
  const computerUse = text.startsWith('COMPUTER USE FIXTURE '), recording = text.trim() === 'RECORDING START FIXTURE';
  const browserNavigatePrefix = 'BROWSER NAVIGATE FIXTURE ';
  const browserNavigate = text.startsWith(browserNavigatePrefix);
  const agent = text.trim() === 'AGENT PARENT FIXTURE', child = text.trim() === 'AGENT CHILD FIXTURE';
  const hostTool = text.startsWith('HOST TOOL FIXTURE ') ? object(JSON.parse(text.slice('HOST TOOL FIXTURE '.length))) : undefined;
  if (hostTool && !['klaus_query', 'klaus_action', 'read_thread', 'list_threads', 'list_archived_threads', 'send_message_to_thread', 'create_thread', 'fork_thread', 'wait_threads', 'set_thread_pinned', 'set_thread_archived', 'set_thread_title'].includes(String(hostTool.tool))) throw new Error('Unknown host fixture tool');
  const diagramTool = diagram ? 'mcp__klaus-digram__digram_open' : diagramEdit ? 'mcp__klaus-digram__digram_edit' : diagramExport ? 'mcp__klaus-digram__digram_export' : '';
  const offered = Array.isArray(body.tools) ? body.tools.some(row => object(row)?.name === diagramTool) : false;
  const searchName = Array.isArray(body.tools) ? body.tools.map(row => String(object(row)?.name ?? '')).find(name => name === 'tool_search_tool' || name === 'tool_search') : undefined;
  const previousTool = [...messages].reverse().flatMap(row => Array.isArray(row.content) ? row.content : [])
    .map(block => object(block)).find(block => block?.type === 'tool_use')?.name;
  const diagramSearch = Boolean(diagramTool && !offered && !hasResult);
  const afterSearch = Boolean(searchName && previousTool === searchName);
  const diagramInvoke = Boolean(diagramTool && (offered || afterSearch) && (!hasResult || afterSearch));
  if (diagramSearch && !searchName) throw new Error('The real provider request contains no tool-search tool for the deferred diagram');
  const tool = diagramSearch || diagramInvoke || (!hasResult && (hostTool || agent || mcp || finder || canvas || computerUse || recording || browserNavigate || ['APPROVAL FIXTURE', 'BROWSER FIXTURE', 'CRON TOOL FIXTURE'].includes(text.trim())));
  const browser = text.trim() === 'BROWSER FIXTURE';
  const cron = text.trim() === 'CRON TOOL FIXTURE';
  const id = `msg_${randomUUID()}`;
  const message = { id, type: 'message', role: 'assistant', model: body.model ?? 'fixture-model',
    content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
  if (text.includes('SIDE QUESTION HOLD FIXTURE')) {
    sideQuestions.started++;sideQuestions.active++;
    response.writeHead(200, { 'content-type': body.stream === true ? 'text/event-stream' : 'application/json' });
    if(body.stream === true) response.write(`event: message_start\ndata: ${JSON.stringify({type:'message_start',message})}\n\n`);
    else response.flushHeaders();
    await new Promise<void>(resolve=>response.once('close',()=>resolve()));
    sideQuestions.active--;sideQuestions.closed++;return;
  }
  if (body.stream !== true) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'Fixture response complete.' }], stop_reason: 'end_turn' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type: string, fields: Record<string, Json>): void => {
    if (!response.destroyed) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  };
  send('message_start', { message });
  if (tool) {
    const agentTool = Array.isArray(body.tools) ? body.tools.map(value => object(value)).find(value => ['task', 'Task', 'Agent'].includes(String(value?.name)))?.name : undefined;
    if (agent && typeof agentTool !== 'string') throw new Error('The real provider request contains no agent task tool');
    const name = hostTool ? String(hostTool.tool) : agent ? agentTool! : mcp ? 'mcp__gui-mcp__echo' : finder ? 'mcp__klaus-macos-finder__list_folder' : canvas ? 'canvas_check'
      : diagramSearch ? searchName! : diagramTool ? diagramTool
      : computerUse ? 'mcp__computer-use__get_app_state' : recording ? 'mcp__computer-use__event_stream_start'
      : cron ? 'CronCreate' : browserNavigate ? 'browser_navigate' : browser ? 'browser_type' : 'Bash';
    send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_fixture_${randomUUID()}`, name, input: {} } });
    const args = JSON.stringify(hostTool ? hostTool.input ?? {} : agent ? { description: 'Task cache GUI fixture', prompt: 'AGENT CHILD FIXTURE', run_in_background: true, fork_context: false }
      : mcp ? { text: 'actual engine roundtrip' } : finder ? { path: text.slice('FINDER CONNECTOR FIXTURE '.length) } : canvas ? { file_path: text.slice('CANVAS FIXTURE '.length) }
      : diagramSearch ? { query: `select:${diagramTool}` }
      : diagram ? { title: 'Diagram application fixture' }
      : diagramEdit ? { id: text.slice('DIAGRAM EDIT FIXTURE '.length), ops: [{ op: 'addNode', node: { id: 'fixture-box', x: 10, y: 10, w: 160, h: 70, label: 'Shared document' } }] }
      : diagramExport ? { id: text.slice('DIAGRAM EXPORT FIXTURE '.length), format: 'svg' }
      : computerUse ? { app: text.slice('COMPUTER USE FIXTURE '.length) } : recording ? {}
      : cron ? { cron: '0 0 1 1 *', prompt: 'PLAIN FIXTURE scheduled', name: 'Tool fixture reminder', recurring: false }
      : browserNavigate ? { url: text.slice(browserNavigatePrefix.length), waitUntil: 'dom_content_loaded' }
      : browser ? { selector: '#field', text: 'AGENT_VALUE', clear: true } : { command });
    for (const partial_json of [args.slice(0, 12), args.slice(12)]) {
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json } });
    }
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const text of child ? ['Child ', 'stream ', 'visible.'] : ['Fixture ', 'response ', 'complete.']) {
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (child) {
      agents.started++; agents.active++;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      agents.waiting.add(release); response.once('close', release);
      try { await pending; } finally { agents.active--; agents.waiting.delete(release); response.removeListener('close', release); }
    }
  }
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
  send('message_stop', {});
  response.end();
}
