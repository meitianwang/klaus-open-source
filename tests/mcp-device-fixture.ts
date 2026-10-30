import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerMcpDeviceHandlers } from '../main/ipc/handlers/mcp-device';
import { McpDeviceService, type McpDeviceDeps } from '../main/services/mcp/device';
import { object, type JsonObject } from '../main/services/service-types';

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export interface DeviceRequest { path: string; data: JsonObject; at: number; request: IncomingMessage; response: ServerResponse }
export type DeviceRoute = (request: DeviceRequest, index: number) => void | Promise<void>;
export const reply = (request: DeviceRequest, value: Json, status = 200): void => {
  request.response.writeHead(status, { 'content-type': 'application/json' }); request.response.end(JSON.stringify(value));
};

/** Real loopback HTTP and a fresh legacy SQLite path; installer is an injected boundary. */
export async function deviceFixture(extra: Partial<McpDeviceDeps> = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'klaus-device-fixture-')), root = join(temp, 'config with space ü');
  const requests: DeviceRequest[] = [], installs: Array<{ payload: JsonObject; signal: AbortSignal }> = [];
  let catalog: JsonObject[] = [{ id: 'github', deviceAuth: { provider: 'github', scope: 'repo read:org read:user', tokenEnvKey: 'GITHUB_PAT', defaultClientId: 'fixture-public-client' } }];
  let grantNumber = 0, tokenNumber = 0;
  let codeRoute: DeviceRoute = request => reply(request, grant(++grantNumber));
  let tokenRoute: DeviceRoute = request => reply(request, { access_token: 'fixture-access-' + request.data.device_code });
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''; for await (const part of request) body += part;
      const record = { path: request.url ?? '', data: object(JSON.parse(body)), at: performance.now(), request, response }; requests.push(record);
      if (record.path === '/login/device/code') await codeRoute(record, requests.filter(row => row.path === record.path).length);
      else if (record.path === '/login/oauth/access_token') await tokenRoute(record, ++tokenNumber);
      else { response.writeHead(404); response.end(); }
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  function grant(number = 1, fields: JsonObject = {}): JsonObject {
    return { device_code: 'fixture-device-' + number, user_code: 'CODE-' + String(number).padStart(4, '0'), verification_uri: origin + '/login/device', expires_in: 30, interval: 1, ...fields };
  }
  const service = new McpDeviceService({ configRoot: root, env: {}, baseURL: origin, requestTimeoutMs: 2000, catalog: async () => structuredClone(catalog), ...extra,
    install: async (payload, signal) => { installs.push({ payload: structuredClone(payload), signal }); return extra.install ? extra.install(payload, signal) : { ok: true }; },
  });
  const registry = new ChannelRegistry(); registerMcpDeviceHandlers(registry, service);
  return { temp, root, origin, service, registry, requests, installs, grant,
    catalog: (rows: JsonObject[]) => { catalog = rows; }, code: (route: DeviceRoute) => { codeRoute = route; }, token: (route: DeviceRoute) => { tokenRoute = route; },
    invoke: (channel: string, payload: Json = { id: 'github' }, senderId = 1) => registry.lookup(channel)!({ role: 'main', senderId, channel, args: [payload] }),
    close: async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(temp, { recursive: true, force: true }); },
  };
}
