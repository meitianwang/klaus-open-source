import { deepEqual, equal, match } from 'node:assert/strict';
import type { Json } from '../main/ipc/contract';
import type { ClientEvent } from '../main/engine/protocol';
import { DynamicTools } from '../main/sessions/dynamic-tools';
import { GENERATION_TOOL_SPECS } from '../main/services/media-generation/contract';
import { createWorkbuddyMediaFacade } from '../main/services/media-generation/native-facade';
import { registerMediaGenerationTools, type NativeMediaConnection } from '../main/services/media-generation/service';
import { object, type JsonObject } from '../main/services/service-types';
import { type Harness, waitFor } from './harness';
import { generationVector, mediaFixture, mp3, mp4, png, resultText } from './media-generation-fixture';

const hiddenModel = 'private-generation-model';
function assertPrivate(value: Json, identities: string[]): void {
  const text = JSON.stringify(value).toLowerCase();
  for (const identity of identities) equal(text.includes(identity.toLowerCase()), false, identity);
}
function connection(calls: JsonObject[]): NativeMediaConnection {
  const mode = { available: true, models: [hiddenModel], defaultModel: hiddenModel };
  return {
    status: async () => ({ loggedIn: true }),
    capabilities: async () => ({ image: mode, video: mode, music: mode, audio: { available: true } }),
    image: async params => { calls.push(params); return { imageBase64: png.toString('base64'), mimeType: 'image/png' }; },
    video: async params => { calls.push(params); return { videoBase64: mp4.toString('base64'), mimeType: 'video/mp4' }; },
    audio: async params => { calls.push(params); return { audioBase64: mp3.toString('base64'), mimeType: 'audio/mpeg' }; },
  };
}

export function registerMediaConversationBoundaryTests(h: Harness): void {
  h.test('generation context failures stay private before the service starts', async () => {
    const replies: JsonObject[] = [];
    const dynamic = new DynamicTools({ request: async (_method, params) => { replies.push(params); }, knownSession: () => true, log: () => {} });
    const f = await mediaFixture();
    try {
      registerMediaGenerationTools(dynamic, f.service, async () => { throw new Error(`WorkBuddy ${hiddenModel} private-connection`); });
      dynamic.receive({ type: 'rawSessionEvent', params: { sessionId: 'owned-writer', event: { dynamicToolCall: { callId: 'private-context', tool: 'generate_video', arguments: { prompt: 'Sunlight' } } } } } as ClientEvent);
      await waitFor(() => replies.length === 1, 5000, 'private context resolution');
      const response = object(replies[0]!.response);
      equal(response.success, false);
      assertPrivate(response, ['WorkBuddy', hiddenModel, 'private-connection']);
      equal(f.generated.length, 0); equal(f.requests.length, 0);
    } finally { await dynamic.close(); await f.close(); }
  });
  h.test('generation declarations describe user intent without exposing routing identities', async () => {
    const vector = object((await generationVector()).conversationBoundary);
    assertPrivate(GENERATION_TOOL_SPECS, vector.hiddenIdentities as string[]);
  });
  h.test('the same generic video request crosses source changes without exposing its routing', async () => {
    const vector = object((await generationVector()).conversationBoundary);
    const calls: JsonObject[] = [];
    const f = await mediaFixture({ deps: { qwenwork: connection(calls), workbuddy: connection(calls) } });
    try {
      for (const source of ['workbuddy', 'qwenwork']) {
        f.selectVideo(source);
        const result = await f.service.execute('generate_video', { prompt: 'Sunlight over the sea', seconds: 5, size: '1280x720' }, f.context());
        equal(object(result).success, true, resultText(result));
        assertPrivate(result, [...vector.hiddenIdentities as string[], hiddenModel]);
      }
      equal(calls.length, 2); equal(f.generated.length, 2); equal(f.requests.length, 0);
      for (const params of calls) {
        equal(params.seconds, 5); equal(params.size, '1280x720'); equal(params.model, hiddenModel);
      }
    } finally { await f.close(); }
  });
  h.test('speech and music results expose artifact facts without configuration details', async () => {
    const vector = object((await generationVector()).conversationBoundary), calls: JsonObject[] = [];
    const f = await mediaFixture({ deps: { qwenwork: connection(calls), workbuddy: connection(calls), cursor: connection(calls) } });
    try {
      f.selectMusic('qwenwork'); f.selectAudio('workbuddy');
      for (const [tool, input] of [['generate_music', { prompt: 'A gentle melody' }], ['generate_audio', { text: 'Good morning' }]] as const) {
        const result = await f.service.execute(tool, input, f.context());
        equal(object(result).success, true, resultText(result));
        assertPrivate(result, [...vector.hiddenIdentities as string[], hiddenModel]);
      }
      f.selectAudio('cursor');
      const result = await f.service.execute('generate_audio', { text: 'A calm morning' }, f.context());
      equal(object(result).success, true, resultText(result));
      assertPrivate(result, [...vector.hiddenIdentities as string[], hiddenModel]);
    } finally { await f.close(); }
  });
  h.test('unknown native dependency failures never enter conversation output', async () => {
    const vector = object((await generationVector()).conversationBoundary);
    for (const stage of ['status', 'capabilities', 'video'] as const) {
      const native = connection([]);
      native[stage] = async () => { throw new Error(`WorkBuddy ${hiddenModel} https://private.invalid diagnostic`); };
      const f = await mediaFixture({ deps: { workbuddy: native } });
      try {
        f.selectVideo('workbuddy');
        const result = await f.service.execute('generate_video', { prompt: 'Sunlight', seconds: 5 }, f.context());
        equal(object(result).success, false);
        assertPrivate(result, [...vector.hiddenIdentities as string[], hiddenModel, 'private.invalid', 'diagnostic']);
        equal(f.generated.length, 0);
      } finally { await f.close(); }
    }
  });
  h.test('native error classifications retain actionable notices without naming the service', async () => {
    const vector = object((await generationVector()).conversationBoundary);
    for (const suffix of ['auth_expired', 'video_size_unsupported', 'rate_limit', 'response_too_large', 'timed_out', 'unexpected']) {
      const client = { isClosed: () => false, requestWithTimeout: async () => { throw new Error(`workbuddy_${suffix} ${hiddenModel}`); } };
      const native = connection([]);
      native.video = createWorkbuddyMediaFacade(() => ({ generation: 1, client })).video;
      const f = await mediaFixture({ deps: { workbuddy: native } });
      try {
        f.selectVideo('workbuddy');
        const result = await f.service.execute('generate_video', { prompt: 'Sunlight', seconds: 5 }, f.context());
        equal(object(result).success, false);
        assertPrivate(result, [...vector.hiddenIdentities as string[], hiddenModel, suffix]);
        equal(f.generated.length, 0);
      } finally { await f.close(); }
    }
  });
  h.test('automatic video size uses configured defaults without forwarding an invented enum', async () => {
    const calls: JsonObject[] = [], f = await mediaFixture({ deps: { workbuddy: connection(calls) } });
    try {
      f.selectVideo('workbuddy');
      const result = await f.service.execute('generate_video', { prompt: 'Sunlight', seconds: 5, size: 'auto' }, f.context());
      equal(object(result).success, true, resultText(result));
      equal(calls.length, 1); equal(calls[0]!.size, undefined); equal(calls[0]!.seconds, 5);
    } finally { await f.close(); }
  });
  h.test('task video routing preserves supported five second requests and rejects silent duration changes', async () => {
    let origin = '';
    const f = await mediaFixture({ respond: (request, response) => {
      if (request.path === '/v2/video_generation') response.end(JSON.stringify({ task_id: 'video-task' }));
      else if (request.path === '/v2/query/video_generation/video-task') response.end(JSON.stringify({ task: { status: 'succeeded', content: { url: origin + '/video.mp4' } } }));
      else if (request.path === '/video.mp4') response.end(mp4);
      else { response.statusCode = 404; response.end('{}'); }
    }, deps: { minimax: { credential: async () => ({ apiKey: 'fixture-key', baseUrl: origin, region: 'cn' }) } } });
    try {
      origin = f.origin;
      f.selectVideo('minimax');
      const result = await f.service.execute('generate_video', { prompt: 'Sunlight', seconds: 5, size: '1280x720' }, f.context());
      equal(object(result).success, true, resultText(result));
      equal(f.requests[0]!.body.duration, 5);
      deepEqual(f.requests.map(row => row.path), ['/v2/video_generation', '/v2/query/video_generation/video-task', '/video.mp4']);
      const before = f.requests.length;
      const refused = await f.service.execute('generate_video', { prompt: 'Sunlight', seconds: 1 }, f.context());
      equal(object(refused).success, false); match(resultText(refused), /between 4 and 15 seconds/);
      equal(f.requests.length, before);
    } finally { await f.close(); }
  });
}
