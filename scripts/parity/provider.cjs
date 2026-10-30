const { binaryPath, outputRoot } = require('./paths.cjs');
const { createServer } = require('node:http');
const { appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { startProvider } = require('../../dist/tests/fixtures/anthropic.js');

// Isolated UI fixture: the real engine talks only to this local provider.
void (async () => {
  const provider = await startProvider("printf 'PARITY_TOOL_OUTPUT\\n'");
  let count = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/fixture/status') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ requests: count, childrenStarted: provider.agents.started, childrenActive: provider.agents.active }));
      return;
    }
    if (request.url === '/fixture/release' && request.method === 'POST') {
      provider.agents.release(); response.end('released'); return;
    }
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw new Error('Fixture input limit');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const parsed = body.length ? JSON.parse(body) : {};
      const id = ++count;
      appendFileSync(join(outputRoot(), 'provider.log'), JSON.stringify({ event: 'request', id, stream: parsed.stream === true, model: parsed.model, at: new Date().toISOString() }) + '\n');
      const upstream = await fetch(provider.url + request.url, {
        method: request.method, headers: { 'content-type': 'application/json' },
        body: request.method === 'GET' ? undefined : body, signal: abort.signal,
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache' });
      if (parsed.stream !== true) { response.end(await upstream.text()); return; }
      const reader = upstream.body.getReader();
      let pending = '';
      for (;;) {
        const part = await reader.read();
        pending += part.done ? '' : Buffer.from(part.value).toString('utf8');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          abort.signal.throwIfAborted();
          response.write(pending.slice(0, boundary + 2)); pending = pending.slice(boundary + 2);
          await new Promise(resolve => setTimeout(resolve, 400));
        }
        if (part.done) break;
      }
      if (pending) response.write(pending);
      response.end();
      appendFileSync(join(outputRoot(), 'provider.log'), JSON.stringify({ event: 'completed', id, at: new Date().toISOString() }) + '\n');
    } catch (error) {
      appendFileSync(join(outputRoot(), 'provider.log'), JSON.stringify({ event: abort.signal.aborted ? 'cancelled' : 'error', message: abort.signal.aborted ? undefined : String(error), at: new Date().toISOString() }) + '\n');
      response.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(outputRoot(), 'provider-url.txt'), url + '\n');
  process.stdout.write(JSON.stringify({ provider: url, externalRequests: false }) + '\n');
  process.once('SIGINT', () => { server.closeAllConnections(); server.close(); void provider.close().finally(() => process.exit(0)); });
})();
