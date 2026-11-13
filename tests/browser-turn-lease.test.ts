import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { ChromeBrowserService } from '../main/browser/chrome-browser';
import { ChromeFrameDecoder, chromeFrame } from '../main/browser/chrome-wire';
import type { BrowserObject } from '../main/browser/types';
import { assert, assertEqual, Harness, waitFor } from './harness';

const h = new Harness();

interface RelayLog { method: string; params: BrowserObject }

/** A unix-socket stand-in for the native host plus extension relay peer. */
async function fakeRelay(log: RelayLog[], metadata: BrowserObject = {}): Promise<{ directory: string; close: () => void }> {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-turn-lease-'));
  const endpoint = join(directory, 'klaus-lease.sock');
  const server = createServer(socket => {
    const decoder = new ChromeFrameDecoder();
    socket.on('data', chunk => {
      for (const message of decoder.push(chunk)) {
        if (typeof message.id !== 'number' || typeof message.method !== 'string') continue;
        const params = (message.params ?? {}) as BrowserObject;
        log.push({ method: message.method, params });
        socket.write(chromeFrame({ jsonrpc: '2.0', id: message.id, result: reply(message.method, params, metadata) }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  chmodSync(endpoint, 0o700);
  return { directory, close: () => { server.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function reply(method: string, params: BrowserObject, metadata: BrowserObject = {}): BrowserObject {
  const tab = { id: 7, url: 'https://example.com/', title: 'Example', active: true, width: 800, height: 600, zoomFactor: 1 };
  switch (method) {
    case 'getInfo': return { metadata: { extensionInstanceId: 'lease-inst', capabilities: ['task_downloads', 'flat_cdp_sessions'], ...metadata }, name: 'Chrome', version: '120' };
    case 'host/browser': return { executable: 'Google Chrome', pid: 1 };
    case 'getTabs': case 'getUserTabs': return [tab] as unknown as BrowserObject;
    case 'getUserHistory': return [] as unknown as BrowserObject;
    case 'createTab': return { id: 7 };
    case 'executeCdp': {
      const cdp = String(params.method ?? '');
      if (cdp === 'Target.getTargetInfo') return { targetInfo: { targetId: 'T1' } };
      if (cdp === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1' } } };
      if (cdp === 'Runtime.evaluate') return { result: { value: { url: 'https://example.com/', title: 'Example' } } };
      return {};
    }
    default: return {};
  }
}

const cdpCalls = (log: RelayLog[]): RelayLog[] => log.filter(row => row.method === 'executeCdp');
const attachCount = (log: RelayLog[]): number => log.filter(row => row.method === 'attach').length;
const turnEndedRows = (log: RelayLog[]): RelayLog[] => log.filter(row => row.method === 'turnEnded');

void h.test('one debugger attach per turn lease, released at turn end', async () => {
  const log: RelayLog[] = [];
  const relay = await fakeRelay(log);
  const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory: relay.directory });
  try {
    service.turnStarted('S1', 'turn-1');
    await service.execute('S1', 'chrome:lease-inst', 'console', {}, {});
    assertEqual(attachCount(log), 1, 'first operation attaches once');
    const firstTurnIds = new Set(cdpCalls(log).map(row => String(row.params.turn_id)));
    assertEqual(firstTurnIds.size, 1, 'one relay turn id within the turn');
    assertEqual([...firstTurnIds][0], 'turn-1', 'relay turn id is the engine turn id');
    await service.execute('S1', 'chrome:lease-inst', 'console', {}, {});
    assertEqual(attachCount(log), 1, 'second operation in the same turn reuses the attachment');
    assertEqual(turnEndedRows(log).length, 0, 'no turnEnded between operations');
    service.turnEnded('S1');
    await waitFor(() => turnEndedRows(log).length === 1, 3000, 'turn end releases the lease');
    assertEqual(String(turnEndedRows(log)[0]!.params.turn_id), 'turn-1', 'turnEnded carries the lease turn id');

    await service.execute('S1', 'chrome:lease-inst', 'console', {}, {});
    assertEqual(attachCount(log), 2, 'the next turn attaches again');
    const provisional = String(cdpCalls(log)[cdpCalls(log).length - 1]!.params.turn_id);
    assert(provisional !== 'turn-1', 'a turn without a started event gets its own lease');
    service.turnStarted('S1', 'turn-2');
    await waitFor(() => turnEndedRows(log).length === 2, 3000, 'a started turn supersedes an open lease');
    assertEqual(String(turnEndedRows(log)[1]!.params.turn_id), provisional, 'superseded lease releases its own turn id');
    service.sessionEnded('S1');
    await waitFor(() => turnEndedRows(log).length === 3, 3000, 'session close releases the lease');
    assertEqual(String(turnEndedRows(log)[2]!.params.turn_id), 'turn-2', 'session close releases the current lease');
  } finally {
    await service.shutdown();
    relay.close();
  }
});

void h.test('a stale unpacked extension is nudged to reload while idle', async () => {
  const log: RelayLog[] = [];
  const relay = await fakeRelay(log, { buildMarker: 'old-build', controlActive: false });
  const cfg = mkdtempSync(join(tmpdir(), 'klaus-nudge-cfg-'));
  const ext = mkdtempSync(join(tmpdir(), 'klaus-nudge-ext-'));
  const deploy = mkdtempSync(join(tmpdir(), 'klaus-nudge-deploy-'));
  writeFileSync(join(ext, 'extension-id.json'), JSON.stringify({ extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', extensionHostName: 'com.klaus.test' }));
  writeFileSync(join(deploy, 'klaus-build.json'), JSON.stringify({ build: 'new-build' }));
  const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory: relay.directory, setup: { configRoot: cfg, extensionRoot: ext, deployRoot: deploy, buildStamp: 'new-build' } });
  try {
    await service.execute('S1', 'chrome:lease-inst', 'console', {}, {});
    assert(log.some(row => row.method === 'reloadExtension'), 'host asks the idle stale extension to reload');
  } finally {
    await service.shutdown();
    relay.close();
    rmSync(cfg, { recursive: true, force: true }); rmSync(ext, { recursive: true, force: true }); rmSync(deploy, { recursive: true, force: true });
  }
});

void h.test('a current or busy extension is not nudged', async () => {
  for (const metadata of [{ buildMarker: 'new-build', controlActive: false }, { buildMarker: 'old-build', controlActive: true }] as BrowserObject[]) {
    const log: RelayLog[] = [];
    const relay = await fakeRelay(log, metadata);
    const deploy = mkdtempSync(join(tmpdir(), 'klaus-nudge-deploy-'));
    writeFileSync(join(deploy, 'klaus-build.json'), JSON.stringify({ build: 'new-build' }));
    const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory: relay.directory, setup: { configRoot: deploy, extensionRoot: deploy, deployRoot: deploy, buildStamp: 'new-build' } });
    try {
      await service.execute('S1', 'chrome:lease-inst', 'console', {}, {});
      assert(!log.some(row => row.method === 'reloadExtension'), `no reload nudge for ${JSON.stringify(metadata)}`);
    } finally {
      await service.shutdown();
      relay.close();
      rmSync(deploy, { recursive: true, force: true });
    }
  }
});

void h.test('a stale deploy copy refreshes from the bundled resources', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'klaus-sync-cfg-'));
  const ext = mkdtempSync(join(tmpdir(), 'klaus-sync-ext-'));
  const deploy = mkdtempSync(join(tmpdir(), 'klaus-sync-deploy-'));
  writeFileSync(join(ext, 'extension-id.json'), JSON.stringify({ extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', extensionHostName: 'com.klaus.test' }));
  writeFileSync(join(ext, 'sentinel.txt'), 'sentinel');
  writeFileSync(join(deploy, 'klaus-build.json'), JSON.stringify({ build: 'old-build' }));
  const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory: cfg, setup: { configRoot: cfg, extensionRoot: ext, deployRoot: deploy, buildStamp: 'new-build' } });
  try {
    assertEqual(await service.syncDeployedExtension(), true, 'stale deploy copy re-deploys');
    const marker = JSON.parse(readFileSync(join(deploy, 'klaus-build.json'), 'utf8')) as { build?: string };
    assertEqual(marker.build ?? '', 'new-build', 'marker carries the current build stamp');
    assertEqual(readFileSync(join(deploy, 'sentinel.txt'), 'utf8'), 'sentinel', 'bundled files landed in the deploy copy');
    assertEqual(await service.syncDeployedExtension(), false, 'a fresh deploy copy is left alone');
  } finally {
    await service.shutdown();
    rmSync(cfg, { recursive: true, force: true }); rmSync(ext, { recursive: true, force: true }); rmSync(deploy, { recursive: true, force: true });
  }
});

void h.finish(join(__dirname, 'browser-turn-lease-result.json'), 'browser-turn-lease').then(code => process.exit(code));
