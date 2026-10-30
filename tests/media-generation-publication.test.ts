import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { object } from '../main/services/service-types';
import { Harness, waitFor } from './harness';
import { mediaFixture, resultText, wav } from './media-generation-fixture';

const h = new Harness();
function success(result: Json): void { equal(object(result).success, true, resultText(result)); }
const speechReply = JSON.stringify({ data: { audio: wav.toString('hex') }, base_resp: { status_code: 0 } });
async function speechFixture(options: Parameters<typeof mediaFixture>[0] = {}) {
  let baseUrl = '';
  const fixture = await mediaFixture({
    respond: (_request, response) => response.end(speechReply), ...options,
    deps: { ...options.deps, minimax: { credential: async () => ({ apiKey: 'fixture-plan-key', baseUrl, region: 'cn' }) } },
  });
  baseUrl = fixture.origin;
  fixture.selectAudio('minimax');
  return fixture;
}

h.test('each audio operation receives only its own complete published file before the global notification', async () => {
  const events: Array<{ source: string; paths: string[] }> = [];
  const f = await speechFixture({ deps: {
    onPublished: (_sessionId, paths) => events.push({ source: 'global', paths: [...paths] }),
  } });
  try {
    const run = (source: string) => f.service.execute('generate_audio', { text: source }, { ...f.context('custom', 'shared-session'), onPublished: paths => events.push({ source, paths: [...paths] }) });
    const results = await Promise.all([run('first'), run('second')]); results.forEach(success);
    equal(events.length, 4); deepEqual([events[0]!.source, events[2]!.source].sort(), ['first', 'second']); equal(events[1]!.source, 'global'); equal(events[3]!.source, 'global');
    for (const index of [0, 2]) {
      equal(events[index]!.paths.length, 1); deepEqual(events[index]!.paths, events[index + 1]!.paths);
      const path = events[index]!.paths[0]!; ok(path.startsWith(join(f.root, 'sessions', 'shared-session'))); match(path, /\.wav$/); deepEqual(await readFile(path), wav);
      ok(resultText(results[events[index]!.source === 'first' ? 0 : 1]!).includes(path));
    }
    ok(events[0]!.paths[0] !== events[2]!.paths[0], 'successive operations never reuse another published audio path');
  } finally { await f.close(); }
});

h.test('a failed audio provider never invokes either publication callback', async () => {
  let local = 0;
  const f = await speechFixture({ respond: (_request, response) => { response.writeHead(503); response.end('Fixture unavailable'); } });
  try {
    const result = await f.service.execute('generate_audio', { text: 'A failed reply' }, { ...f.context(), onPublished: () => { local++; } });
    equal(object(result).success, false); equal(local, 0); equal(f.generated.length, 0); deepEqual(await readdir(join(f.root, 'sessions')).catch(() => []), []);
  } finally { await f.close(); }
});

h.test('a cancelled audio operation ignores its eventual provider bytes without publishing a path', async () => {
  let local = 0, respond: (() => void) | undefined;
  const controller = new AbortController();
  const f = await speechFixture({ respond: (_request, response) => { respond = () => response.end(speechReply); } });
  try {
    const pending = f.service.execute('generate_audio', { text: 'An obsolete reply' }, { ...f.context('custom', 'cancelled', controller.signal), onPublished: () => { local++; } });
    await waitFor(() => Boolean(respond), 5000, 'audio request accepted'); controller.abort(); respond!();
    const result = await pending; equal(object(result).success, false); match(resultText(result), /cancelled or timed out/);
    equal(local, 0); equal(f.generated.length, 0); deepEqual(await readdir(join(f.root, 'sessions')).catch(() => []), []);
  } finally { await f.close(); }
});

h.test('a throwing operation callback preserves complete user audio and still notifies the global observer', async () => {
  let saved: string | undefined;
  const f = await speechFixture();
  try {
    const result = await f.service.execute('generate_audio', { text: 'A saved reply' }, { ...f.context(), onPublished: paths => { saved = paths[0]; throw Error('Fixture observer failed'); } });
    success(result); ok(saved); deepEqual(await readFile(saved), wav); deepEqual(f.generated, [{ sessionId: 'session', paths: [saved] }]); ok(resultText(result).includes(saved));
  } finally { await f.close(); }
});

void h.finish(join(__dirname, 'media-generation-publication-result.json'), 'media-generation-publication').then(code => { process.exitCode = code; });
