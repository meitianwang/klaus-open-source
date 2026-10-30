/** Disposable real stdio server used by the application integration fixture. */
export const STDIO_MCP_FIXTURE = String.raw`
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
appendFileSync(process.argv[2], String(process.pid) + '\n');
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'gui-mcp-fixture', version: '1' } };
  else if (message.method === 'ping') result = {};
  else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo the fixture text', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { text: {type:'string'} }, required: ['text'] } }] };
  else if (message.method === 'tools/call') {
    appendFileSync(process.argv[3], JSON.stringify(message.params) + '\n');
    result = { content: [{ type: 'text', text: 'MCP_ECHO_ACTUAL: ' + message.params.arguments.text }] };
  } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
input.on('close', () => process.exit(0));
`;
