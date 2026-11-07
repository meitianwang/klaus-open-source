import { deepEqual, equal, match } from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Harness } from './harness';
import { generationVector, mediaFixture, png, resultText } from './media-generation-fixture';
import { object, type JsonObject } from '../main/services/service-types';

export function registerCodexImageGenerationTests(h: Harness): void {
  h.test('Codex image references use ordered JSON data URLs and adapt the requested size', async () => {
    const vector = object((await generationVector()).codexImageEditing);
    for (const count of [1, 2]) {
      let submitted: JsonObject = {}, headers = new Headers(), path = '';
      const f = await mediaFixture({ deps: {
        subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
        fetch: async (url, init) => {
          path = new URL(String(url)).pathname; headers = new Headers(init?.headers);
          equal(typeof init?.body, 'string'); submitted = object(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } });
        },
      } });
      try {
        const paths = [];
        for (let i = 0; i < count; i++) { const path = join(f.root, `source-${i}.png`); await writeFile(path, png); paths.push(path); }
        f.select('codex');
        const result = await f.service.execute('generate_image', { prompt: 'Preserve the reference subject', size: String(vector.requestedSize), source_images: paths }, f.context());
        equal(object(result).success, true, resultText(result));
        equal(path, String(vector.editPath)); equal(headers.get('Content-Type'), 'application/json');
        equal(headers.get('Authorization'), 'Bearer fixture-token'); equal(headers.get('ChatGPT-Account-Id'), 'fixture-account');
        equal(submitted.prompt, 'Preserve the reference subject'); equal(submitted.size, vector.wireSize);
        deepEqual(submitted.images, paths.map(() => ({ image_url: `data:image/png;base64,${png.toString('base64')}` })));
        equal(f.generated.length, 1); equal(resultText(result).includes('fixture-token'), false);
      } finally { await f.close(); }
    }
  });
  h.test('Codex text-only generation retains JSON generation semantics and aligned sizes', async () => {
    let submitted: JsonObject = {}, path = '';
    const f = await mediaFixture({ deps: {
      subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
      fetch: async (url, init) => { path = new URL(String(url)).pathname; submitted = object(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); },
    } });
    try {
      f.select('codex'); equal(object(await f.service.execute('generate_image', { prompt: 'Blue', size: '1536x864' }, f.context())).success, true);
      match(path, /\/images\/generations$/u); deepEqual(submitted, { model: 'gpt-image-2', prompt: 'Blue', n: 1, size: '1536x864' });
    } finally { await f.close(); }
  });
}
