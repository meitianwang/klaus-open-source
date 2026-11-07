import { equal, match, rejects } from 'node:assert/strict';
import { MediaHttp } from '../main/services/media-generation/http';
import type { Harness } from './harness';
const signal = (): AbortSignal => new AbortController().signal;

export function registerMediaHttpTests(h: Harness): void {
  h.test('media HTTP errors explain recognized JSON detail and structured validation fields', async () => {
    for (const [status, body] of [[400, { detail: 'Unsupported content type' }], [200, { error: { message: 'Unsupported content type', code: 'invalid_request_error', param: 'images' } }]] as const) {
      const http = new MediaHttp(async () => new Response(JSON.stringify(body), { status }));
      await rejects(http.json('https://fixture.invalid', {}, signal()), error => {
        match(String(error), new RegExp(`HTTP ${status}`)); match(String(error), /Unsupported content type/u);
        if (status === 200) { match(String(error), /invalid_request_error/u); match(String(error), /parameter: images/u); }
        return true;
      });
    }
  });
  h.test('media HTTP diagnostics never echo arbitrary text, secrets, media or unknown fields', async () => {
    const echoes = ['fixture-secret', 'The first words of a private prompt', 'data:image/png;base64,cHJpdmF0ZQ==', 'https://private.invalid/?key=secret', 'constructor', 'toString'];
    for (const text of echoes) {
      const http = new MediaHttp(async () => new Response(JSON.stringify({ error: { message: text, code: text, param: text }, detail: text }), { status: 400 }));
      await rejects(http.json('https://fixture.invalid', { headers: { Authorization: 'Bearer fixture-secret' }, body: JSON.stringify({ prompt: text }) }, signal()), error => {
        equal(String(error), 'Error: Media provider HTTP 400.'); equal(String(error).includes(text), false); return true;
      });
    }
    for (const detail of [{ message: 'Unsupported content type' }, ['Unsupported content type'], 'Unsupported content type: fixture-secret', 'x'.repeat(20000)]) {
      const http = new MediaHttp(async () => new Response(JSON.stringify({ detail }), { status: 400 }));
      await rejects(http.json('https://fixture.invalid', {}, signal()), /^Error: Media provider HTTP 400\.$/u);
    }
  });
  h.test('media HTTP errors bound streamed bodies and cancel the reader', async () => {
    let cancelled = false;
    const http = new MediaHttp(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20000)); }, cancel() { cancelled = true; } }), { status: 400 }));
    await rejects(http.json('https://fixture.invalid', {}, signal()), /HTTP 400/u); equal(cancelled, true);
  });
  h.test('media HTTP keeps polling payloads internal and binary download failures generic', async () => {
    const body = { error: { message: 'Unsupported content type' } };
    const http = new MediaHttp(async () => new Response(JSON.stringify(body), { status: 400 }));
    equal((await http.json('https://fixture.invalid', {}, signal(), undefined, true)).status, 400);
    await rejects(http.download('https://fixture.invalid', {}, signal(), 1024), /^Error: Media provider HTTP 400\.$/u);
    for (const text of ['<html>fixture-secret</html>', 'not JSON']) {
      const other = new MediaHttp(async () => new Response(text, { status: 400 }));
      await rejects(other.json('https://fixture.invalid', {}, signal()), /^Error: Media provider HTTP 400\.$/u);
    }
  });
}
