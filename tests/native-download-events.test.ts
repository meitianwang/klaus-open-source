import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadItem } from 'electron';
import {
  NativeDownloads,
  type BrowserDownloadNetwork,
  type NativeDownloadOptions,
  type NativeDownloadSnapshot,
  type NativeDownloadTarget,
  type NativeProfileDownloadController,
} from '../main/browser/native-downloads';
import type { BrowserDataStore } from '../main/browser/history-store';
import type { BrowserDownloadChangedEvent } from '../contracts/browser-history';
import { BrowserError } from '../main/browser/types';

class FakeHistory {
  readonly rows = new Map<string, Record<string, unknown>>();
  creates = 0;
  updates = 0;
  recovers = 0;

  download(id: string): Record<string, unknown> | undefined {
    return this.rows.get(id);
  }

  createDownload(input: Record<string, unknown>): Record<string, unknown> {
    this.creates += 1;
    const row: Record<string, unknown> = {
      ...input,
      state: input.status ?? 'in_progress',
      receivedBytes: input.bytes ?? 0,
      totalBytes: input.totalBytes ?? 0,
      canPause: false,
      canResume: false,
      canCancel: false,
    };
    this.rows.set(String(input.id), row);
    return row;
  }

  updateDownload(id: string, patch: Record<string, unknown>): Record<string, unknown> | undefined {
    this.updates += 1;
    const row = this.rows.get(id);
    if (!row) return undefined;
    Object.assign(row, patch, {
      ...(patch.status !== undefined ? { state: patch.status } : {}),
      ...(patch.bytes !== undefined ? { receivedBytes: patch.bytes } : {}),
    });
    return row;
  }

  removeDownload(id: string): { removed: boolean } {
    return { removed: this.rows.delete(id) };
  }

  clearTerminalDownloads(): { removed: number } {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (['completed', 'failed', 'canceled'].includes(String(row.state))) {
        this.rows.delete(id);
        removed += 1;
      }
    }
    return { removed };
  }

  downloadHistory(): { items: Array<Record<string, unknown>>; nextCursor: null } {
    return { items: [...this.rows.values()], nextCursor: null };
  }

  recoverInterruptedDownloads(): { recovered: number } {
    this.recovers += 1;
    return { recovered: 0 };
  }

  asStore(): BrowserDataStore {
    return this as unknown as BrowserDataStore;
  }
}

class FakeController implements NativeProfileDownloadController {
  readonly actions: Array<{ id: string; action: string }> = [];
  readonly decisions: Array<{ requestId: string; decision: { allow: boolean; path?: string } }> = [];

  downloadAction(id: string, action: 'pause' | 'resume' | 'cancel' | 'remove'): void {
    this.actions.push({ id, action });
  }

  resolveDownloadTarget(requestId: string, decision: { allow: boolean; path?: string }): void {
    this.decisions.push({ requestId, decision });
  }
}

class FakeItem {
  readonly url = 'https://dl.example/file';
  readonly filename = 'file.bin';
  readonly chain = ['https://dl.example/file'];
  paused = false;
  resumed = false;
  cancelled = false;
  savePath = '';
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  pause(): void { this.paused = true; }
  getURL(): string { return this.url; }
  getFilename(): string { return this.filename; }
  getURLChain(): string[] { return this.chain; }
  setSavePath(path: string): void { this.savePath = path; }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }
  once(event: string, listener: (...args: unknown[]) => void): void { this.on(event, listener); }
  resume(): void { this.resumed = true; }
  cancel(): void { this.cancelled = true; }
  getState(): string { return 'progressing'; }
  getReceivedBytes(): number { return 5; }
  getTotalBytes(): number { return 10; }
  done(state: string): void {
    for (const listener of [...(this.listeners.get('done') ?? [])]) listener({}, state);
  }
}

function setup(options: Partial<NativeDownloadOptions> = {}): {
  downloads: NativeDownloads;
  history: FakeHistory;
  controller: FakeController;
  events: BrowserDownloadChangedEvent[];
  authorizations: Array<{ sessionId: string; url: string }>;
  asserted: string[];
  directory: string;
  cleanup(): void;
} {
  const directory = mkdtempSync(join(__dirname, 'native-download-events-'));
  const history = new FakeHistory();
  const controller = new FakeController();
  const events: BrowserDownloadChangedEvent[] = [];
  const authorizations: Array<{ sessionId: string; url: string }> = [];
  const asserted: string[] = [];
  const downloads = new NativeDownloads({ fetch: async () => { throw new Error('native event tests never use host fetch'); } } as BrowserDownloadNetwork, {
    directory: () => directory,
    assertUrl: url => { asserted.push(String(url)); return String(url); },
    history: history.asStore(),
    promptForUserDownloads: () => false,
    nativeController: controller,
    authorize: async (sessionId, url) => { authorizations.push({ sessionId, url }); },
    changed: event => events.push(event),
    ...options,
  });
  return { downloads, history, controller, events, authorizations, asserted, directory, cleanup: () => { downloads.dispose(); rmSync(directory, { recursive: true, force: true }); } };
}

function snapshot(overrides: Partial<NativeDownloadSnapshot> = {}): NativeDownloadSnapshot {
  return {
    id: 'guid-1',
    url: 'https://example.test/file.bin',
    urlChain: ['https://example.test/start', 'https://example.test/file.bin'],
    filename: 'file.bin',
    state: 'in_progress',
    receivedBytes: 10,
    totalBytes: 100,
    startedAt: 1000,
    canPause: true,
    canResume: false,
    canCancel: true,
    sessionId: 'session-1',
    pageId: 'page-1',
    isActorVisit: true,
    ...overrides,
  };
}

function target(directory: string, overrides: Partial<NativeDownloadTarget> = {}): NativeDownloadTarget {
  return {
    requestId: 'req-1',
    id: 'guid-target',
    url: 'https://example.test/file.bin',
    urlChain: ['https://example.test/start', 'https://example.test/file.bin'],
    filename: 'file.bin',
    suggestedPath: join(directory, 'file.bin'),
    pageId: 'page-target',
    sessionId: 'session-1',
    ...overrides,
  };
}

function historyItems(downloads: NativeDownloads): Array<Record<string, unknown>> {
  return downloads.history().items as Array<Record<string, unknown>>;
}

test('native snapshots use stable ids, shared waiters and terminal coalescing', async () => {
  const f = setup();
  try {
    f.downloads.nativeCreated(snapshot());
    assert.equal(f.history.creates, 1);
    assert.equal(f.downloads.store.has('guid-1'), true);
    assert.equal(f.downloads.store.ownerOf('guid-1'), 'page-1');
    assert.equal(f.downloads.store.list('page-1').length, 1);
    assert.equal(historyItems(f.downloads)[0]?.id, 'guid-1');
    assert.equal(historyItems(f.downloads)[0]?.canPause, true);

    f.downloads.nativeCreated(snapshot());
    assert.equal(f.history.creates, 1, 'duplicate created does not write another history row');

    f.downloads.nativeUpdated(snapshot({ state: 'completed', receivedBytes: 100, canPause: false, canCancel: false }));
    const completed = await f.downloads.store.wait('page-1', { downloadId: 'guid-1' }, 100);
    assert.equal(completed.status, 'completed');
    assert.equal(historyItems(f.downloads)[0]?.state, 'completed');
    assert.equal(f.events.at(-1)?.state, 'completed');
  } finally { f.cleanup(); }
});

test('native progress is coalesced and terminal events bypass it', async () => {
  const f = setup();
  try {
    f.downloads.nativeCreated(snapshot());
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(f.events.filter(event => event.state === 'in_progress').length, 1);
    f.downloads.nativeUpdated(snapshot({ state: 'paused', canPause: false, canResume: true }));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(f.events.at(-1)?.state, 'paused');
    f.downloads.nativeUpdated(snapshot({ state: 'canceled', canPause: false, canResume: false, canCancel: false }));
    assert.equal(f.events.at(-1)?.state, 'canceled', 'terminal event is emitted immediately');
  } finally { f.cleanup(); }
});

test('native created preserves an existing history source and session', () => {
  const f = setup();
  try {
    f.history.rows.set('guid-existing', {
      id: 'guid-existing', url: 'https://old.test/file', filename: 'old.bin',
      state: 'in_progress', receivedBytes: 1, totalBytes: 10, startedAt: 1,
      source: 'agent', sessionId: 'old-session', canPause: false, canResume: false, canCancel: false,
    });
    f.downloads.nativeCreated(snapshot({ id: 'guid-existing', sessionId: 'new-session', isActorVisit: false, requiresAuthorization: true }));
    assert.equal(f.history.creates, 0, 'existing history row is updated, not created twice');
    assert(f.history.updates > 0);
    assert.equal(f.history.rows.get('guid-existing')?.source, 'agent');
    assert.equal(f.history.rows.get('guid-existing')?.sessionId, 'old-session');
  } finally { f.cleanup(); }
});

test('unknown native owner is recorded as other without fake recovery fields', () => {
  const f = setup();
  try {
    f.downloads.nativeCreated(snapshot({ id: 'guid-unknown', pageId: undefined, sessionId: undefined, isActorVisit: undefined, requiresAuthorization: undefined }));
    assert.equal(f.downloads.store.ownerOf('guid-unknown'), 'native:guid-unknown');
    assert.equal(f.history.rows.get('guid-unknown')?.source, 'other');
    assert.equal(f.history.rows.get('guid-unknown')?.sessionId, 'native:guid-unknown');
    assert.equal(f.history.recovers, 0, 'interrupted rows are not forcibly failed by default');
  } finally { f.cleanup(); }
});

test('manual native target uses assertUrl and path choice without the agent gate', async () => {
  let authorizeCalls = 0;
  let downloadsDirectory = '';
  const prompts: Array<{ defaultPath: string; filename: string; url: string }> = [];
  const f = setup({
    promptForUserDownloads: () => true,
    chooseDownloadPath: async request => { prompts.push(request); return join(downloadsDirectory, 'chosen.bin'); },
    authorize: async () => { authorizeCalls += 1; throw new BrowserError('unavailable', 'Browser Use is disabled'); },
  });
  downloadsDirectory = f.directory;
  try {
    await f.downloads.resolveNativeTarget(target(f.directory, { id: 'guid-manual', requestId: 'req-manual', pageId: 'page-manual', isActorVisit: false, requiresAuthorization: false }));
    assert.equal(authorizeCalls, 0, 'manual downloads do not call the agent/plugin gate');
    assert.equal(prompts.length, 1);
    assert(f.asserted.includes('https://example.test/start'));
    assert.deepEqual(f.controller.decisions, [{ requestId: 'req-manual', decision: { allow: true, path: join(f.directory, 'chosen.bin') } }]);
  } finally { f.cleanup(); }
});

test('requiresAuthorization authorizes chain resources even when isActorVisit is false', async () => {
  const authorized: string[] = [];
  let prompts = 0;
  const f = setup({
    authorize: async (_sessionId, url) => { authorized.push(url); },
    promptForUserDownloads: () => true,
    chooseDownloadPath: async () => { prompts += 1; return join(f.directory, 'unused.bin'); },
  });
  try {
    const targetEvent = target(f.directory, {
      id: 'guid-agent', requestId: 'req-agent', pageId: 'page-agent', isActorVisit: false, requiresAuthorization: true,
      urlChain: ['https://initiator.test/', 'https://redirect.test/'], url: 'https://final.test/file.bin',
      suggestedPath: join(f.directory, 'agent.bin'),
    });
    await f.downloads.resolveNativeTarget(targetEvent);
    assert.deepEqual(authorized, ['https://initiator.test/', 'https://redirect.test/', 'https://final.test/file.bin']);
    assert.equal(prompts, 0, 'agent-caused resource authorization does not prompt for a manual path');
    assert.deepEqual(f.controller.decisions, [{ requestId: 'req-agent', decision: { allow: true, path: join(f.directory, 'agent.bin') } }]);
    f.downloads.nativeCreated(snapshot({ id: 'guid-agent', url: targetEvent.url, urlChain: targetEvent.urlChain, pageId: 'page-agent', isActorVisit: false, requiresAuthorization: true }));
    assert.equal(f.history.rows.get('guid-agent')?.source, 'other', 'history attribution stays other for a non-actor visit');
  } finally { f.cleanup(); }
});

test('actor target authorization failure resolves allow false', async () => {
  const f = setup({ authorize: async () => { throw new BrowserError('unavailable', 'Browser Use is disabled'); } });
  try {
    await f.downloads.resolveNativeTarget(target(f.directory, { id: 'guid-disabled', requestId: 'req-disabled', isActorVisit: true, requiresAuthorization: true }));
    assert.deepEqual(f.controller.decisions, [{ requestId: 'req-disabled', decision: { allow: false } }]);
  } finally { f.cleanup(); }
});

test('canceling a pending target resolves allow false without hanging', async () => {
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const f = setup({
    authorize: async (_sessionId, _url, _resource, signal) => {
      started();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  try {
    const pending = f.downloads.resolveNativeTarget(target(f.directory, { id: 'guid-cancel', requestId: 'req-cancel', pageId: 'page-cancel', isActorVisit: true, requiresAuthorization: true }));
    await startedPromise;
    f.downloads.release('page-cancel');
    await pending;
    assert.deepEqual(f.controller.decisions, [{ requestId: 'req-cancel', decision: { allow: false } }]);
  } finally { f.cleanup(); }
});

test('legacy accept keeps manual downloads off the agent gate and authorizes actor downloads', async () => {
  let authorizeCalls = 0;
  const manual = setup({ authorize: async () => { authorizeCalls += 1; throw new BrowserError('unavailable', 'Browser Use is disabled'); } });
  try {
    const item = new FakeItem();
    await manual.downloads.accept('page-manual', 'session-manual', item as unknown as DownloadItem, 'other', 'https://page.example/');
    assert.equal(authorizeCalls, 0, 'manual accepted download bypasses the agent gate');
    item.done('cancelled');
  } finally { manual.cleanup(); }

  const actor = setup();
  try {
    const item = new FakeItem();
    await actor.downloads.accept('page-agent', 'session-agent', item as unknown as DownloadItem, 'agent', 'https://page.example/');
    assert.deepEqual(actor.authorizations.map(row => row.url), ['https://page.example/', 'https://dl.example/file']);
    item.done('cancelled');
  } finally { actor.cleanup(); }
});

test('native actions route to the profile controller and remove terminal history', () => {
  const f = setup();
  try {
    f.downloads.nativeCreated(snapshot({ id: 'guid-actions', canResume: true }));
    f.downloads.pause('guid-actions');
    f.downloads.nativeUpdated(snapshot({ id: 'guid-actions', state: 'paused', canPause: false, canResume: true }));
    f.downloads.resume('guid-actions');
    f.downloads.nativeUpdated(snapshot({ id: 'guid-actions', state: 'canceled', canPause: false, canResume: false, canCancel: false }));
    f.downloads.remove('guid-actions');
    assert.deepEqual(f.controller.actions, [
      { id: 'guid-actions', action: 'pause' },
      { id: 'guid-actions', action: 'resume' },
      { id: 'guid-actions', action: 'remove' },
    ]);
    assert.equal(f.history.rows.has('guid-actions'), false);
  } finally { f.cleanup(); }
});

test('release keeps native downloads alive for the profile and accepts later events', () => {
  const f = setup();
  try {
    f.downloads.nativeCreated(snapshot({ id: 'guid-release', pageId: 'page-release' }));
    f.downloads.release('page-release');
    assert.equal(f.downloads.store.has('guid-release'), true, 'native download survives tab release');
    assert.equal(f.downloads.store.list('page-release').length, 1);
    f.downloads.nativeUpdated(snapshot({ id: 'guid-release', pageId: 'page-release', state: 'completed', receivedBytes: 100, canPause: false, canCancel: false }));
    assert.equal(historyItems(f.downloads)[0]?.state, 'completed');
    f.downloads.nativeCreated(snapshot({ id: 'guid-later', pageId: 'page-release' }));
    assert.equal(f.downloads.store.has('guid-later'), true, 'a later native event can still use the released owner');
  } finally { f.cleanup(); }
});
