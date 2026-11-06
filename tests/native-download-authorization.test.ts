import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeDownloads, type BrowserDownloadNetwork } from '../main/browser/native-downloads';
import { downloadPageMedia } from '../main/browser/page-download';
import { BrowserError, type BrowserObject } from '../main/browser/types';
import type { BrowserCdp } from '../main/browser/page-operations';
import type { BrowserDataStore } from '../main/browser/history-store';

function fakeHistory(): BrowserDataStore {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    createDownload(input: Record<string, unknown>) { rows.set(String(input.id), { ...input }); return input; },
    updateDownload(id: string, patch: Record<string, unknown>) { const row = rows.get(id); if (row) Object.assign(row, patch); return row; },
    recoverInterruptedDownloads() {},
    download(id: string) { return rows.get(id); },
    downloadHistory() { return { items: [], nextCursor: null }; },
    removeDownload(id: string) { rows.delete(id); },
    clearTerminalDownloads() { return { removed: 0 }; },
  } as unknown as BrowserDataStore;
}

test('a denied redirect target is never fetched and initiator approval stays separate', async () => {
  const directory = mkdtempSync(join(__dirname, 'native-download-auth-'));
  const fetches: string[] = [];
  const authorizations: Array<{ url: string; resource: string }> = [];
  const network: BrowserDownloadNetwork = {
    fetch: async (input) => {
      fetches.push(input);
      if (input === 'https://download.example/start') {
        return {
          status: 302,
          ok: false,
          headers: new Headers({ location: 'https://blocked.example/file' }),
          body: null,
          url: input,
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${input}`);
    },
  };
  const downloads = new NativeDownloads(network, {
    directory: () => directory,
    assertUrl: url => new URL(String(url)).href,
    history: fakeHistory(),
    authorize: (_sessionId, url, resource) => {
      authorizations.push({ url, resource });
      if (url === 'https://blocked.example/file') throw new BrowserError('refused_by_policy', 'blocked redirect target');
    },
  });
  try {
    await assert.rejects(
      downloads.download('page-1', 'task-1', {} as BrowserCdp, { url: 'https://download.example/start' }, 500, undefined, 'https://page.example/'),
      /blocked redirect target/u,
    );
    assert.deepEqual(fetches, ['https://download.example/start'], 'the denied redirect target must never reach the network');
    assert.deepEqual(authorizations, [
      { url: 'https://page.example/', resource: 'downloads' },
      { url: 'https://download.example/start', resource: 'downloads' },
      { url: 'https://blocked.example/file', resource: 'downloads' },
    ], 'initiator approval and each target URL are checked separately');
  } finally {
    downloads.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('page media authorizes the resolved URL before reading any bytes', async () => {
  const directory = mkdtempSync(join(__dirname, 'media-download-auth-'));
  const checks: string[] = [];
  const order: string[] = [];
  let evaluateCalls = 0;
  let bodyRead = false;
  const cdp = {
    evaluate: async (expression: string): Promise<unknown> => {
      evaluateCalls += 1;
      if (evaluateCalls === 1) return { url: 'https://media.example/start', tag: 'img', filename: null } as BrowserObject;
      if (evaluateCalls === 2) {
        order.push('fetch:started');
        return { mimeType: 'text/plain', url: 'https://media.example/final', contentDisposition: null } as BrowserObject;
      }
      if (String(expression).includes('s.reader.read()')) {
        bodyRead = true;
        return { done: true } as BrowserObject;
      }
      return true;
    },
    command: async () => ({}),
    screenshot: async () => ({}),
    printToPDF: async () => ({}),
    frameTargets: () => [],
    console: [],
    network: [],
    events: [],
    evicted: { console: 0, network: 0, events: 0 },
    onEvent: () => () => {},
  } as unknown as BrowserCdp;
  try {
    await assert.rejects(
      downloadPageMedia(
        cdp,
        { url: 'https://media.example/start' },
        directory,
        'media-1',
        new AbortController().signal,
        url => new URL(String(url)).href,
        async url => {
          checks.push(url);
          order.push(`authorize:${url}`);
          if (url === 'https://media.example/final') throw new BrowserError('refused_by_policy', 'media final target denied');
        },
      ),
      /media final target denied/u,
    );
    assert.deepEqual(checks, ['https://media.example/start', 'https://media.example/final'], 'declared and resolved media URLs are both checked');
    assert(order.indexOf('authorize:https://media.example/start') < order.indexOf('fetch:started'), 'declared URL is authorized before the page fetch starts');
    assert.equal(bodyRead, false, 'a denied resolved URL must abort before any body bytes are read');
    assert.equal(existsSync(directory) ? readdirSync(directory).length : 0, 0, 'denied media leaves no file behind');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('NativeDownloads passes page-media authorization through to the resolved URL', async () => {
  const directory = mkdtempSync(join(__dirname, 'native-media-download-auth-'));
  const checks: string[] = [];
  let evaluateCalls = 0;
  let bodyRead = false;
  const cdp = {
    evaluate: async (expression: string): Promise<unknown> => {
      evaluateCalls += 1;
      if (evaluateCalls === 1) return { url: 'https://media.example/start', tag: 'img', filename: null } as BrowserObject;
      if (evaluateCalls === 2) return { mimeType: 'text/plain', url: 'https://media.example/final', contentDisposition: null } as BrowserObject;
      if (String(expression).includes('s.reader.read()')) {
        bodyRead = true;
        return { done: true } as BrowserObject;
      }
      return true;
    },
    command: async () => ({}),
    screenshot: async () => ({}),
    printToPDF: async () => ({}),
    frameTargets: () => [],
    console: [],
    network: [],
    events: [],
    evicted: { console: 0, network: 0, events: 0 },
    onEvent: () => () => {},
  } as unknown as BrowserCdp;
  const network: BrowserDownloadNetwork = {
    fetch: async input => { throw new Error(`page media must not use the host network: ${input}`); },
  };
  const downloads = new NativeDownloads(network, {
    directory: () => directory,
    assertUrl: url => new URL(String(url)).href,
    history: fakeHistory(),
    authorize: (_sessionId, url) => {
      checks.push(url);
      if (url === 'https://media.example/final') throw new BrowserError('refused_by_policy', 'media final denied');
    },
  });
  try {
    await assert.rejects(
      downloads.download('page-2', 'task-2', cdp, { x: 10, y: 20 }, 500, undefined, 'https://page.example/'),
      /media final denied/u,
    );
    assert.deepEqual(checks, [
      'https://page.example/',
      'https://media.example/start',
      'https://media.example/final',
    ], 'the page-media path must authorize the initiator, declared URL, and resolved URL');
    assert.equal(bodyRead, false, 'denied resolved media URL aborts before body bytes');
  } finally {
    downloads.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
