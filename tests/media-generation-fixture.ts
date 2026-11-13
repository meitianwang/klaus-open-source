import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import type { GenerationContext } from '../main/services/media-generation/contract';
import { MediaGenerationService, type MediaGenerationDeps } from '../main/services/media-generation/service';
import { ModelFeatureSettings } from '../main/services/model-features';
import { object, type JsonObject } from '../main/services/service-types';
import { WorkspaceStore } from '../main/services/workspaces';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
export const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
export const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
// An MPEG audio frame (sync word 0xffe0) and a RIFF/WAVE header, both tiny but with
// real container magic so audioFile's validation is exercised rather than bypassed.
export const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(24)]);
export const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]);
export interface Request { path: string; method: string; headers: IncomingHttpHeaders; bytes: Buffer; body: JsonObject }
export interface MediaFixture {
  root: string; origin: string; requests: Request[]; features: ModelFeatureSettings; service: MediaGenerationService; workspaces: WorkspaceStore;
  deps: MediaGenerationDeps; generated: Array<{ sessionId: string; paths: string[] }>;
  config(source: string, kind: 'image' | 'video' | 'audio', config: JsonObject): void;
  select(selection: string): Json;
  selectVideo(selection: string): Json;
  selectAudio(selection: string): Json;
  selectMusic(selection: string): Json;
  context(source?: string, sessionId?: string, signal?: AbortSignal): GenerationContext;
  close(): Promise<void>;
}
export async function mediaFixture(options: { respond?: (request: Request, response: ServerResponse) => void; deps?: Partial<MediaGenerationDeps> } = {}): Promise<MediaFixture> {
  const root = await mkdtemp(join(tmpdir(), 'klaus-media-generation-')), requests: Request[] = [], generated: MediaFixture['generated'] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks); let body: JsonObject = {}; try { body = object(JSON.parse(bytes.toString())); } catch { /* Multipart is asserted as wire text. */ }
    const row = { path: request.url ?? '', method: request.method ?? '', headers: request.headers, bytes, body }; requests.push(row);
    if (options.respond) options.respond(row, response);
    else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const features = new ModelFeatureSettings(root), workspaces = new WorkspaceStore({ configRoot: root, onSessionWorkdirChanged: () => {}, push: () => {}, pickDirectory: async () => null });
  const deps: MediaGenerationDeps = {
    features, workspaces,
    subscriptions: { codexAccessToken: async () => undefined },
    qoder: { status: async () => ({ loggedIn: false }), generate: async () => { throw new Error('Fixture has no Qoder account.'); } },
    qwenwork: { status: async () => ({ loggedIn: false }), capabilities: async () => ({}), image: async () => { throw new Error('Fixture has no QwenWork account.'); }, video: async () => { throw new Error('Fixture has no QwenWork account.'); }, audio: async () => { throw new Error('Fixture has no QwenWork account.'); } },
    fetch: async (input, init) => { if (!String(input).startsWith(origin + '/')) throw new Error('Fixture refused a non-loopback request.'); return fetch(input, init); },
    onPublished: (sessionId, paths) => generated.push({ sessionId, paths }), providerOptions: { pollMs: 1, videoPolls: 8 },
    ...options.deps,
  };
  const service = new MediaGenerationService(deps);
  return { root, origin, requests, features, service, workspaces, deps, generated,
    config: (source, kind, config) => { features.setMedia(kind, { source, baseUrl: origin + '/v1', apiKey: 'fixture-secret', ...config }); },
    select: (selection: string) => features.setImageSelection({ selection }),
    selectVideo: (selection: string) => features.setVideoSelection({ selection }),
    selectAudio: (selection: string) => features.setAudioSelection({ selection }),
    selectMusic: (selection: string) => features.setMusicSelection({ selection }),
    context: (source = 'custom', sessionId = 'session', signal = new AbortController().signal) => ({ source, sessionId, signal, assertCurrent: () => signal.throwIfAborted() }),
    close: async () => { await service.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); },
  };
}
export async function generationVector(): Promise<JsonObject> { return JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/media-generation.json'), 'utf8')) as JsonObject; }
export function resultText(value: Json): string { return (object(value).contentItems as JsonObject[] ?? []).filter(row => row.type === 'inputText').map(row => row.text).join('\n'); }
