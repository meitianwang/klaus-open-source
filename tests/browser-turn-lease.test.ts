import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
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
async function fakeRelay(log: RelayLog[]): Promise<{ directory: string; close: () => void }> {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-turn-lease-'));
  const endpoint = join(directory, 'klaus-lease.sock');
  const server = createServer(socket => {
    const decoder = new ChromeFrameDecoder();
    socket.on('data', chunk => {
      for (const message of decoder.push(chunk)) {
        if (typeof message.id !== 'number' || typeof message.method !== 'string') continue;
        const params = (message.params ?? {}) as BrowserObject;
        log.push({ method: message.method, params });
        socket.write(chromeFrame({ jsonrpc: '2.0', id: message.id, result: reply(message.method, params) }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  chmodSync(endpoint, 0o700);
  return { directory, close: () => { server.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function reply(method: string, params: BrowserObject): BrowserObject {
  const tab = { id: 7, url: 'https://example.com/', title: 'Example', active: true, width: 800, height: 600, zoomFactor: 1 };
  switch (method) {
    case 'getInfo': return { metadata: { extensionInstanceId: 'lease-inst', capabilities: ['task_downloads', 'flat_cdp_sessions'] }, name: 'Chrome', version: '120' };
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

void h.finish(join(__dirname, 'browser-turn-lease-result.json'), 'browser-turn-lease').then(code => process.exit(code));
