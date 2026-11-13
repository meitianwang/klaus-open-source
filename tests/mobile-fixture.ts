import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerMobileBridgeHandlers } from '../main/ipc/handlers/mobile-bridge';
import { MobileBridgeService, type MobileBridgeDeps } from '../main/services/mobile/service';
import type { MobileAccount, MobileCallContext, MobileEngineOwner } from '../main/services/mobile/protocol';
import { object, string, type JsonObject } from '../main/services/service-types';
import { stopSocket } from '../main/services/mobile/transport';
import { waitFor } from './harness';
import { AttachmentService } from '../main/services/attachments';
import { WorkspaceStore } from '../main/services/workspaces';
import { MediaFiles } from '../main/services/media-files';
import { mobileMediaPreview } from '../main/services/mobile/previews';
import { pathInside } from '../main/services/workspaces';

export async function mobileFixture(options: Pick<MobileBridgeDeps, 'sessionInterestChanged' | 'connectionChanged' | 'friendMessage' | 'friendRevoked' | 'friendConnected' | 'friendDisconnected' | 'threadRequest' | 'inlineVisualizationPreview' | 'mediaPreview' | 'diagramPreview' | 'socketHeartbeatMs' | 'socketPongTimeoutMs' | 'log' | 'diagnosticsEnabled' | 'catalogPage' | 'catalogRow' | 'catalogVisible' | 'ensureEngineOwner' | 'composerRetryDelaysMs'> & { acknowledgeFriendHello?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'klaus-mobile-fixture-')));
  const attachments = new AttachmentService(new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null }));
  const media = new MediaFiles(async (path, sessionId) => ['s1', 's2'].includes(sessionId) && pathInside(path, root));
  const cloudRequests: { path: string; payload: JsonObject; request: IncomingMessage }[] = [];
  let registerStatus = 200, heartbeatStatus = 200;
  let cloudDevices: JsonObject[] = [];
  let authorizationExpired = 0;
  const cloud = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    cloudRequests.push({ path: request.url ?? '', payload: object(JSON.parse(Buffer.concat(chunks).toString() || '{}')), request });
    if (request.method === 'GET' && request.url === '/api/mobile/devices') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ devices: cloudDevices })); return;
    }
    if (request.method === 'DELETE' && request.url?.startsWith('/api/mobile/devices/')) {
      response.writeHead(registerStatus, { 'content-type': 'application/json' }); response.end(registerStatus === 200 ? '{"ok":true}' : '{"error":"remove_failed"}'); return;
    }
    response.writeHead(request.url?.endsWith('/heartbeat') ? heartbeatStatus : registerStatus, { 'content-type': 'application/json' }); response.end('{}');
  })().catch(() => response.destroy()); });
  const relay = new WebSocketServer({ server: cloud, maxPayload: 36 * 1024 * 1024 });
  const relays: { socket: WebSocket; frames: JsonObject[]; request: IncomingMessage }[] = [];
  relay.on('connection', (socket, request) => { const entry = { socket, frames: [] as JsonObject[], request }; relays.push(entry); socket.on('message', data => {
    const frame = object(JSON.parse(data.toString())); entry.frames.push(frame);
    if (frame.type === 'desktop_hello' && frame.friendsMessaging === 2 && options.acknowledgeFriendHello !== false) socket.send(JSON.stringify({ type: 'desktop_hello_ack', friendsMessaging: 2, remoteAccessEnabled: frame.remoteAccessEnabled }));
  }); socket.on('error', () => {}); });
  cloud.listen(0, '127.0.0.1'); await once(cloud, 'listening'); const cloudAddress = cloud.address(); if (!cloudAddress || typeof cloudAddress === 'string') throw new Error('No fixture address');
  const relayURL = 'http://127.0.0.1:' + cloudAddress.port;
  let ownerAvailable = true;
  let owner: MobileEngineOwner = { engine: {}, generation: 1 }, account: MobileAccount | undefined;
  const calls: { channel: string; payload: JsonObject; context: MobileCallContext }[] = [];
  const sent: { payload: JsonObject; files: string[] }[] = [];
  const sessions: JsonObject[] = [{ id: 's1', title: 'One', workdir: root, updatedAt: 20 }, { id: 's2', title: 'Two', workdir: 'C:\\Projects\\Windows', updatedAt: 10 }];
  const spaceRoots = [join(root, 'space-a'), join(root, 'space-b')];
  const histories = new Map<string, Json[]>([['s1', []], ['s2', [{ type: 'user', text: 'existing' }]]]);
  const followStreams = new Map<string, { streamId: string; revision: number }>();
  let model = 'auto', level = 'medium', authMode = 'custom', style = 'default', followUpMode = 'queue';
  const commands: JsonObject[] = [{ name: 'run-skill', source: 'skill', description: 'Fixture\n skill' }, { name: 'plugin:cmd', source: 'plugin' }, { name: 'mcp-check', source: 'mcp' }, { name: 'plain' }, { name: 'plain' }, { name: '../invalid' }, { name: 'compact', type: 'local', description: 'CLI-only compaction entry point' }];
  let intercept: ((channel: string, payload: JsonObject, context: MobileCallContext) => Promise<Json | undefined>) | undefined;
  const bridge = new MobileBridgeService({ configRoot: root, relayURL, env: {}, account: () => account, engineOwner: () => ownerAvailable ? owner : undefined,
    friendMessage: options.friendMessage,
    friendRevoked: options.friendRevoked, friendConnected: options.friendConnected, friendDisconnected: options.friendDisconnected,
    connectionChanged: options.connectionChanged,
    sessionInterestChanged: options.sessionInterestChanged,
    ensureEngineOwner: options.ensureEngineOwner ? async signal => { await options.ensureEngineOwner!(signal); ownerAvailable = true; } : undefined, machineIdentifier: async () => 'fixture-machine', hostname: 'Fixture desktop', heartbeatMs: 60, retryDelaysMs: [20, 40], requestTimeoutMs: 1500,
    composerRetryDelaysMs: options.composerRetryDelaysMs, socketHeartbeatMs: options.socketHeartbeatMs, socketPongTimeoutMs: options.socketPongTimeoutMs, log: options.log,
    diagnosticsEnabled: options.diagnosticsEnabled,
    threadRequest: options.threadRequest,
    catalogPage: options.catalogPage, catalogRow: options.catalogRow, catalogVisible: options.catalogVisible,
    mediaPreview: options.mediaPreview ?? ((sessionId, path, signal) => mobileMediaPreview(media, sessionId, path, signal)),
    inlineVisualizationPreview: options.inlineVisualizationPreview,
    diagramPreview: options.diagramPreview,
    authorizationExpired: () => { authorizationExpired++; },
    followSession: async (sessionId, context) => {
      if (context.onHistory) {
        const read = await intercept?.('session:read', { sessionId }, context);
        context.signal.throwIfAborted();
        context.onHistory(read ?? { messages: histories.get(sessionId) ?? [] });
      }
      const payload = { sessionId }; calls.push({ channel: 'session:follow', payload, context }); context.signal.throwIfAborted();
      const overridden = await intercept?.('session:follow', payload, context); if (overridden !== undefined) return overridden;
      let stream = followStreams.get(sessionId);
      if (!stream) { stream = { streamId: 'engine-' + sessionId, revision: 0 }; followStreams.set(sessionId, stream); }
      // The real host's `session:follow` projects the engine history WITHOUT a `sessionId`
      // (`sessions/history.ts`); the bridge owes the phone that key on the snapshot envelope.
      return { mode: 'snapshot', streamId: stream.streamId, revision: stream.revision, messages: histories.get(sessionId) ?? [] };
    },
    dispatch: async (channel, args, context): Promise<Json> => {
      const payload = object(args[0]); calls.push({ channel, payload, context }); context.signal.throwIfAborted();
      const overridden = await intercept?.(channel, payload, context); if (overridden !== undefined) return overridden;
      context.signal.throwIfAborted();
      switch (channel) {
        case 'session:list': return sessions.map(row => ({ ...row }));
        case 'projects:list': return { activeRoot: root, roots: [{ path: root, label: 'Fixture root', updatedAt: 3, conversationCount: 4 }, { path: 'C:\\Projects\\Empty', label: 'Empty Windows root', updatedAt: 1 }] };
        case 'workspaces:list': return { workspaces: [{ id: 'ws-fixture', name: 'Fixture space', roots: spaceRoots }] };
        case 'session:history': return { messages: histories.get(string(payload.sessionId)) ?? [] };
        case 'agents:history': return { messages: histories.get(string(payload.agentId)) ?? [] };
        case 'agents:snapshot': return { tasks: {} };
        case 'permission:pending': case 'elicit:pending': case 'question:pending': return [];
        case 'settings:kv:get': return payload.key === 'follow_up_queue_mode' ? followUpMode : authMode;
        case 'settings:kv:set': if (payload.key === 'follow_up_queue_mode') followUpMode = string(payload.value); else authMode = string(payload.value); return true;
        case 'engine:slashCommands': return commands;
        case 'session:get-main-model': return { mode: model, source: authMode, resolvedMode: model === 'auto' ? authMode + ':fixture' : model };
        case 'session:get-ultra-mode': return { enabled: false };
        case 'session:set-ultra-mode': return { ok: true };
        case 'session:get-thinking-level': return { level };
        case 'session:get-fast-mode': return { enabled: false, supported: false };
        case 'session:set-fast-mode': return { ok: true };
        case 'session:get-main-model-options': if (payload.source) return { options: [{ value: string(payload.source) + ':fixture', label: 'Fixture model', supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultThinkingLevel: 'medium' }] }; return { options: [{ value: 'auto', label: 'duplicate' }, { value: 'subscription:fixture', label: 'Fixture\n model' }] };
        case 'session:get-custom-main-model-options': return { options: [{ value: 'custom:fixture', label: 'Custom' }] };
        case 'settings:output-styles:list': return { current: style, defaultStyle: 'default', styles: [{ id: 'plugin-style', source: 'plugin' }, { id: 'Learning', name: 'Learning', source: 'builtin' }, { id: 'default', name: 'Default', isDefault: true }] };
        case 'session:set-main-model': model = string(payload.mode); if (payload.source) authMode = string(payload.source); if (payload.thinkingLevel) level = string(payload.thinkingLevel); return { ok: true };
        case 'auth:status': case 'codex-auth:status': case 'qoder-auth:status': case 'qwenwork-auth:status': case 'workbuddy-auth:status': case 'kimi-auth:status': case 'bailian-auth:status': case 'minimax-auth:status': case 'zhipu-auth:status': case 'ark-auth:status': return { loggedIn: true };
        case 'settings:models:list': return [{ id: 'fixture', name: 'Custom fixture' }];
        case 'session:set-thinking-level': level = string(payload.level); return { ok: true };
        case 'settings:output-styles:set': style = string(payload.style); return { ok: true };
        case 'session:new': { const id = 's' + (sessions.length + 1), row = { id, workdir: payload.workspaceId ? spaceRoots[0]! : payload.workdir ?? null, ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}), updatedAt: 30, title: 'New Chat' }; sessions.unshift(row); histories.set(id, []); return row; }
        case 'projects:set-active': return { ok: true };
        case 'session:set-workdir': case 'session:clear-workdir': { const row = sessions.find(item => item.id === payload.sessionId)!; row.workdir = payload.dir ?? null; return { ok: true }; }
        case 'session:rename': { sessions.find(row => row.id === payload.sessionId)!.title = payload.title!; return { ok: true }; }
        case 'session:delete': { sessions.splice(sessions.findIndex(row => row.id === payload.sessionId), 1); return { ok: true }; }
        case 'session:export': { const path = join(root, 'Fixture export.md'); await writeFile(path, '# Fixture export\n'); return { ok: true, filePath: path }; }
        case 'feedback:submit': return { ok: true, feedbackId: 'fixture-report', filePath: join(root, 'report.zip'), email: { sent: false } };
        case 'chat:upload': return attachments.upload(payload);
        case 'chat:send': {
          const files: string[] = []; for (const row of Array.isArray(payload.media) ? payload.media : []) files.push(await readFile(string(object(row).path), 'utf8'));
          sent.push({ payload, files }); return { ok: true };
        }
        case 'chat:interrupt': return { accepted: true };
        case 'permission:respond': case 'elicit:respond': return { ok: true };
        default: throw new Error('Unexpected mobile fixture dispatch: ' + channel);
      }
    },
  });
  const registry = new ChannelRegistry(); registerMobileBridgeHandlers(registry, bridge);
  let status = object(object(await bridge.startFromSettings()).settings);
  const enable = async () => { status = object(object(await bridge.set({ enabled: true, port: 0 })).settings); return status; };
  const request = async (method: string, path: string, body?: Json, headers?: Record<string, string>) => {
    const response = await fetch('http://127.0.0.1:' + status.port + path, { method, headers: headers ?? { authorization: 'Bearer ' + status.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); return { status: response.status, body: text ? object(JSON.parse(text)) : {}, headers: response.headers };
  };
  const clients = new Set<WebSocket>();
  const connect = async (catalogSync = false) => {
    const socket = new WebSocket('ws://127.0.0.1:' + status.port + '/api/mobile/ws?token=' + encodeURIComponent(string(status.token)), { headers: catalogSync ? { 'x-klaus-mobile-catalog': '1' } : {} });
    clients.add(socket); socket.once('close', () => clients.delete(socket));
    const messages: JsonObject[] = []; socket.on('message', bytes => messages.push(object(JSON.parse(bytes.toString())))); socket.on('error', () => {});
    await once(socket, 'open'); return { socket, messages, next: async (type: string) => { await waitFor(() => messages.some(row => row.type === type), 3000, 'Mobile message ' + type); return messages.splice(messages.findIndex(row => row.type === type), 1)[0]!; } };
  };
  return { root, bridge, registry, calls, sent, sessions, histories, commands, cloudRequests, relays, relayURL, request, connect, enable,
    status: () => status, updateStatus: (value: Json) => { status = object(object(value).settings); }, owner: () => owner,
    dropOwner: () => { ownerAvailable = false; },
    replaceOwner: () => { ownerAvailable = true; owner = { engine: {}, generation: owner.generation + 1 }; return owner; }, account: (value: MobileAccount | undefined) => { account = value; },
    intercept: (value: typeof intercept) => { intercept = value; }, cloudStatus: (register: number, heartbeat = 200) => { registerStatus = register; heartbeatStatus = heartbeat; },
    cloudDevices: (value: JsonObject[]) => { cloudDevices = value; }, authorizationExpired: () => authorizationExpired,
    close: async () => { await Promise.all([...clients].map(stopSocket)); await bridge.close(); await attachments.close(); media.close(); await Promise.all([...relay.clients].map(stopSocket)); await new Promise<void>(resolve => relay.close(() => resolve())); cloud.closeAllConnections(); await new Promise<void>(resolve => cloud.close(() => resolve())); await rm(root, { recursive: true, force: true }); },
  };
}
