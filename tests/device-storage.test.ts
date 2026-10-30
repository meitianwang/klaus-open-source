// Disk accounting and reviewed chat cleanup preserve activity and filesystem versions.

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';
import { DeviceStorageService, type DeviceStorageDeps, type SessionStorageMeta, type StorageCleanupOptions } from '../main/services/device-storage';

const h = new Harness();

const CONTENT_TIME = 1_600_000_000_000;
const CUTOFF = CONTENT_TIME + 86_400_000;
const meta = (id: string, extra: Partial<SessionStorageMeta> = {}): SessionStorageMeta => ({
  id, archived: false, running: false, pinned: false, updatedAt: CONTENT_TIME, row: { id }, ...extra,
});

async function fixture(run: (value: {
  root: string; cache: string; rows: SessionStorageMeta[]; deleted: string[];
  file(path: string, text: string, time?: number): Promise<string>;
  create(extra?: Partial<DeviceStorageDeps>): DeviceStorageService;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'klaus-storage-'));
  const cache = join(root, 'cache', 'usage.json');
  const rows: SessionStorageMeta[] = [];
  const deleted: string[] = [];
  const services: DeviceStorageService[] = [];
  const file = async (path: string, text: string, time = CONTENT_TIME): Promise<string> => {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, text);
    await utimes(full, time / 1000, time / 1000);
    return full;
  };
  const create = (extra: Partial<DeviceStorageDeps> = {}): DeviceStorageService => {
    const service = new DeviceStorageService({
      configRoot: root, cachePath: cache,
      sessionMeta: async () => rows.map(row => ({ ...row })),
      sessionRow: async id => { const row = rows.find(entry => entry.id === id); return row ? { ...row } : null; },
      deleteSession: async id => { deleted.push(id); },
      ...extra,
    });
    services.push(service);
    return service;
  };
  try { await run({ root, cache, rows, deleted, file, create }); }
  finally {
    // Drain service work before removing its isolated profile.
    for (const service of services) await settled(service);
    const physicalFs: typeof import('node:fs/promises') = process.versions.electron
      ? (require('original-fs') as typeof import('node:fs')).promises
      : await import('node:fs/promises');
    await physicalFs.rm(root, { recursive: true, force: true });
  }
}

async function settled(service: DeviceStorageService): Promise<void> {
  await waitFor(async () => (await service.read()).status !== 'scanning', 5_000, 'storage scan settles');
}

async function review(service: DeviceStorageService) {
  await service.refresh();
  await settled(service);
  return service.reviewInventory();
}

const options = (reviewId: string, archivedOnly = false): StorageCleanupOptions => ({ reviewId, cutoffMs: CUTOFF, archivedOnly });

h.test('accounts for native rollout layout, sidecars, nested agents and top-level files exactly once', async () => {
  await fixture(async ({ file, rows, create }) => {
    rows.push(meta('active'), meta('archive', { archived: true }));
    await file('sessions/100-active.jsonl', 'aaaaa');
    await file('sessions/100-active/state.bin', 'aaa');
    await file('sessions/100-active/subagents/agent-a.jsonl', 'aaaa');
    await file('sessions/100-active/subagents/agent-a.meta.json', 'aa');
    await file('sessions/100-active/subagents/nested/agent-b.jsonl', 'aaaaaa');
    await file('sessions/100-active/subagents/nested/agent-b.meta.json', 'a');
    await file('sessions/archived/200-archive.jsonl', 'aaaaaaa');
    await file('sessions/archived/200-archive/subagents/agent-c.jsonl', 'aaaaaaaa');
    await file('sessions/archived/200-archive/subagents/agent-c.meta.json', 'aa');
    await file('sessions/background-processes/active/log', 'aa');
    await file('sessions/background-processes/archive/log', 'aaaa');
    await file('sessions/background-processes/orphan/log', 'a');
    await file('settings.db', 'aaaaaaaaa');
    await file('logs/log', 'aaa');
    await file('worktrees/tree/file', 'aaaaaaaaaaa');
    const service = create();
    await service.refresh();
    await settled(service);
    const usage = (await service.read()).usage!;
    assertDeepEqual(usage.categories, [
      { category: 'threads', bytes: 10 }, { category: 'subagents', bytes: 13 },
      { category: 'archived', bytes: 21 }, { category: 'worktrees', bytes: 11 },
      { category: 'other', bytes: 13 },
    ], 'category sizes partition all profile files');
    assertEqual(usage.totalBytes, 68, 'total includes root files and archived background output');
    assertEqual(usage.sessionBytes.active, 23, 'active review size includes descendants');
    assertEqual(usage.sessionBytes.archive, 21, 'archived review size includes background output');
    assertEqual(usage.subagentCounts.active, 2, 'only agent rollouts count, including nested descendants');
    assertEqual(usage.subagentCounts.archive, 1, 'metadata sidecars never count as an agent');
  });
});

h.test('accounts for compressed rollouts and groups both representations under one chat', async () => {
  await fixture(async ({ file, rows, create }) => {
    rows.push(meta('cold'), meta('archived', { archived: true }));
    await file('sessions/100-cold.jsonl.zst', 'packed');
    await file('sessions/100-cold.jsonl', 'raw');
    await file('sessions/100-cold/state.bin', 'x');
    await file('sessions/100-cold/subagents/agent-a.jsonl.zst', 'abc');
    await file('sessions/100-cold/subagents/agent-b.jsonl', 'zz');
    await file('sessions/100-cold/subagents/agent-b.jsonl.zst', 'z');
    await file('sessions/archived/200-archived.jsonl.zst', 'aa');
    await file('sessions/archived/200-archived/subagents/agent-c.jsonl.zst', 'z');
    const service = create();
    await service.refresh();
    await settled(service);
    const usage = (await service.read()).usage!;
    assertDeepEqual(usage.categories, [
      { category: 'threads', bytes: 10 }, { category: 'subagents', bytes: 6 },
      { category: 'archived', bytes: 3 }, { category: 'worktrees', bytes: 0 },
      { category: 'other', bytes: 0 },
    ], 'accounting uses physical compressed lengths and includes both on-disk representations');
    assertEqual(usage.sessionBytes.cold, 16, 'compressed main history shares its existing sidechain');
    assertEqual(usage.subagentCounts.cold, 2, 'two representations of an agent count once');
    assertEqual(usage.subagentCounts.archived, 1, 'compressed archived agents remain counted');
    const inventory = await service.reviewInventory();
    assertDeepEqual(inventory.inventory.map(item => item.id).sort(), ['archived', 'cold'], 'compressed histories remain reviewable chats');
  });
});

h.test('counts application archives as physical files across storage categories and cleanup reviews', async () => {
  await fixture(async ({ root, file, rows, create }) => {
    const { createPackage } = await import('@electron/asar');
    const physicalFs: typeof import('node:fs/promises') = process.versions.electron
      ? (require('original-fs') as typeof import('node:fs')).promises
      : await import('node:fs/promises');
    const source = join(root, 'archive-source');
    await file('archive-source/nested/content.txt', 'archive content');
    const archive = join(root, 'sessions', '100-chat', 'state.asar');
    await mkdir(join(archive, '..'), { recursive: true });
    await createPackage(source, archive);
    await rm(source, { recursive: true });
    const archiveBytes = (await physicalFs.lstat(archive)).size;
    for (const path of ['sessions/scratch/app.asar', 'worktrees/tree/app.asar', 'packages/app.asar']) {
      const target = join(root, path);
      await mkdir(join(target, '..'), { recursive: true });
      await physicalFs.copyFile(archive, target);
    }
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'history');
    const service = create();
    await service.refresh();
    await settled(service);
    const snapshot = await service.read();
    assertEqual(snapshot.status, 'ready', `archive measurement completes: ${snapshot.error ?? ''}`);
    assertDeepEqual(snapshot.usage!.categories, [
      { category: 'threads', bytes: archiveBytes + 7 }, { category: 'subagents', bytes: 0 },
      { category: 'archived', bytes: 0 }, { category: 'worktrees', bytes: archiveBytes },
      { category: 'other', bytes: archiveBytes * 2 },
    ], 'archive headers and payloads are counted once without virtual traversal');
    assertEqual(snapshot.usage!.totalBytes, archiveBytes * 4 + 7, 'total uses physical archive lengths');
    const inventory = await service.reviewInventory();
    assertEqual(inventory.inventory.length, 1, 'an archive does not break chat fingerprints');
    assert(Number.isFinite(inventory.inventory[0]!.updatedAt), 'review activity remains a finite timestamp');
  });
});

h.test('refresh returns scanning immediately and concurrent refreshes share a completed measurement', async () => {
  await fixture(async ({ file, create }) => {
    await file('sessions/100-chat.jsonl', 'history');
    const service = create();
    const snapshots = await Promise.all([service.refresh(), service.refresh(), service.read(), service.refresh()]);
    assert(snapshots.every(snapshot => snapshot.status === 'scanning'), 'all callers see the same in-progress scan');
    await settled(service);
    const first = (await service.read()).measuredAt!;
    assert(first > 0, 'successful scan records its completion clock');
    await new Promise(resolve => setTimeout(resolve, 2));
    assertEqual((await service.refresh()).status, 'scanning', 'refresh does not wait for a walk');
    await settled(service);
    assert((await service.read()).measuredAt! > first, 'next successful scan advances the clock');
  });
});

h.test('valid cached numbers stay non-authoritative during concurrent initialization', async () => {
  await fixture(async ({ file, create, cache }) => {
    await file('sessions/100-chat.jsonl', 'history');
    const first = create();
    await first.refresh();
    await settled(first);
    const cached = JSON.parse(await readFile(cache, 'utf8'));
    const second = create();
    const snapshots = await Promise.all([second.read(), second.refresh(), second.read()]);
    assert(snapshots.every(snapshot => snapshot.status === 'scanning'), 'cache loading cannot publish ready over a live scan');
    assert(snapshots.every(snapshot => snapshot.completedCategories.length === 0), 'cached categories are never measured categories');
    assertEqual(snapshots[0]!.usage!.totalBytes, cached.usage.totalBytes, 'cached numbers can render immediately');
  });
});

h.test('refreshes older accounting caches without warning or reusing stale categories', async () => {
  await fixture(async ({ root, file, create }) => {
    await file('sessions/100-cold.jsonl.zst', 'packed');
    await file('cache/usage.json', JSON.stringify({ version: 2, measuredAt: CONTENT_TIME, usage: {
      home: root, totalBytes: 6,
      categories: ['threads', 'subagents', 'archived', 'worktrees', 'other'].map(category => ({ category, bytes: category === 'other' ? 6 : 0 })),
      sessionBytes: {}, sessionSubagentBytes: {}, subagentCounts: {},
    } }));
    const service = create();
    const first = await service.read();
    assertEqual(first.usage, null, 'old format does not display compressed history in the wrong category');
    assert(!first.warning, 'an expected cache upgrade is not a storage warning');
    await settled(service);
    assertEqual((await service.read()).usage!.sessionBytes.cold, 6, 'a fresh scan attributes compressed history to its chat');
  });
});

h.test('rejects malformed cache values and exposes a warning before replacing them', async () => {
  await fixture(async ({ file, root, create }) => {
    await file('cache/usage.json', JSON.stringify({
      version: 3, measuredAt: CONTENT_TIME, usage: {
        home: root, totalBytes: -1,
        categories: ['threads', 'subagents', 'archived', 'worktrees', 'other'].map(category => ({ category, bytes: 0 })),
        sessionBytes: {}, sessionSubagentBytes: {}, subagentCounts: {},
      },
    }));
    const service = create();
    const snapshot = await service.read();
    assertEqual(snapshot.usage, null, 'invalid bytes never become displayed accounting');
    assert(snapshot.warning?.includes('Invalid storage cache'), 'cache failure is observable');
    await settled(service);
    assertEqual((await service.read()).status, 'ready', 'a fresh scan repairs invalid cached numbers');
  });
});

h.test('cache read and write errors remain observable', async () => {
  await fixture(async ({ root, create }) => {
    const service = create({ cachePath: root });
    const snapshot = await service.read();
    assert(Boolean(snapshot.warning), 'reading a directory as cache is not swallowed');
    await settled(service);
    assert(Boolean((await service.read()).warning), 'failed cache replacement remains visible');
  });
});

h.test('cache identity, categories and per-chat maps must all be valid', async () => {
  const corruptions: Array<(usage: Record<string, any>) => void> = [
    usage => { usage.home = '/another-profile'; },
    usage => { usage.categories[1].category = 'threads'; },
    usage => { usage.totalBytes = 1; },
    usage => { delete usage.sessionBytes; },
    usage => { usage.sessionSubagentBytes = { chat: 1 }; },
    usage => { usage.subagentCounts = { chat: -1 }; },
  ];
  for (const corrupt of corruptions) await fixture(async ({ root, file, create }) => {
    const usage = {
      home: root, totalBytes: 0,
      categories: ['threads', 'subagents', 'archived', 'worktrees', 'other'].map(category => ({ category, bytes: 0 })),
      sessionBytes: {}, sessionSubagentBytes: {}, subagentCounts: {},
    };
    corrupt(usage);
    await file('cache/usage.json', JSON.stringify({ version: 3, measuredAt: CONTENT_TIME, usage }));
    const snapshot = await create().read();
    assertEqual(snapshot.usage, null, 'corrupt or cross-profile accounting is not displayed');
    assert(Boolean(snapshot.warning), 'cache rejection has an observable reason');
  });
});

if (process.platform !== 'win32' && process.getuid?.() !== 0) h.test('permission failures prevent a category from becoming complete', async () => {
  await fixture(async ({ root, file, create }) => {
    await file('blocked/file', 'history');
    const blocked = join(root, 'blocked');
    await chmod(blocked, 0);
    try {
      const service = create();
      await service.refresh();
      await settled(service);
      const snapshot = await service.read();
      assertEqual(snapshot.status, 'error', 'unreadable storage fails the scan');
      assert(!snapshot.completedCategories.includes('other'), 'permission errors do not mark a zero-sized category complete');
      assert(Boolean(snapshot.error), 'original scan error remains available');
    } finally { await chmod(blocked, 0o700); }
  });
});

h.test('symlinked profile content is not counted or traversed', async () => {
  await fixture(async ({ root, file, create }) => {
    await file('real/file', '12345');
    await symlink(join(root, 'real'), join(root, 'alias'));
    const service = create();
    await service.refresh();
    await settled(service);
    assertEqual((await service.read()).usage!.totalBytes, 5, 'a directory alias cannot duplicate bytes');
  });
});

h.test('a symlink replacing the sessions root cannot grant cleanup authority', async () => {
  await fixture(async ({ root, file, rows, create }) => {
    rows.push(meta('chat'));
    await file('real/100-chat.jsonl', '12345');
    await symlink(join(root, 'real'), join(root, 'sessions'));
    const service = create();
    const inventory = await review(service);
    assertEqual((await service.read()).usage!.totalBytes, 5, 'the replacement root is not traversed twice');
    assertEqual(inventory.inventory.length, 0, 'a symlink cannot supply a measured persistent rollout');
  });
});

h.test('cleanup requires an issued review before reading metadata', async () => {
  await fixture(async ({ create }) => {
    let reads = 0;
    const service = create({ sessionMeta: async () => { reads++; return []; } });
    await assertRejects(() => service.cleanup([{ id: 'chat' }], options('missing')), 'unreviewed deletion');
    assertEqual(reads, 0, 'invalid tokens are rejected before catalog reads');
  });
});

h.test('review rejects unmeasured storage and excludes ephemeral, parented and missing rollouts', async () => {
  await fixture(async ({ file, rows, create }) => {
    rows.push(meta('valid'), meta('__ephemeral'), meta('parented', { row: { parentThreadId: 'parent' } }), meta('missing'));
    await file('sessions/100-valid.jsonl', 'v');
    await file('sessions/100-__ephemeral.jsonl', 'e');
    await file('sessions/100-parented.jsonl', 'p');
    await file('sessions/100-missing/subagents/agent-orphan.jsonl', 'o');
    const service = create();
    await assertRejects(() => service.reviewInventory(), 'inventory must be measured first');
    await settled(service);
    const inventory = await service.reviewInventory();
    assertDeepEqual(inventory.inventory.map(row => row.id), ['valid'], 'only measured persistent roots receive review authority');
    const result = await service.cleanup([{ id: 'missing' }], options(inventory.reviewId));
    assertEqual(result.skipped, 1, 'unreviewed orphan data cannot be deleted');
  });
});

h.test('disk activity overrides an old decorated conversation clock', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'recent failed turn', CUTOFF + 1_000);
    const service = create();
    const inventory = await review(service);
    assert(inventory.inventory[0]!.updatedAt > CUTOFF, 'review recency comes from actual rollout activity');
    const result = await service.cleanup([{ id: 'chat', updatedAt: CONTENT_TIME }], options(inventory.reviewId));
    assertEqual(result.skipped, 1, 'an old presentation timestamp cannot authorize deleting recent content');
    assertEqual(deleted.length, 0, 'recent activity remains');
  });
});

h.test('cleanup detects parent rollout changes even if updatedAt stays unchanged', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'old');
    const service = create();
    const inventory = await review(service);
    await file('sessions/100-chat.jsonl', 'changed', CONTENT_TIME + 1);
    const result = await service.cleanup([{ id: 'chat', updatedAt: CONTENT_TIME }], options(inventory.reviewId));
    assertEqual(result.skipped, 1, 'the content stamp must still match the review');
    assertEqual(deleted.length, 0, 'changed history is retained');
  });
});

h.test('cleanup detects descendant changes with stable parent time, count and byte size', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'old');
    const child = 'sessions/100-chat/subagents/child/subagents/agent-leaf.jsonl';
    await file(child, 'aaa');
    const service = create();
    const inventory = await review(service);
    await file(child, 'bbb', CONTENT_TIME + 1_000);
    const result = await service.cleanup([{ id: 'chat' }], options(inventory.reviewId));
    assertEqual(result.skipped, 1, 'each descendant stamp is checked rather than aggregate count and size');
    assertEqual(deleted.length, 0, 'independently updated subagents are retained');
  });
});

h.test('cleanup detects descendant path changes with stable size and timestamps', async () => {
  await fixture(async ({ root, file, rows, create }) => {
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'old');
    const child = await file('sessions/100-chat/subagents/agent-a.jsonl', 'same');
    const service = create();
    const inventory = await review(service);
    await rename(child, join(root, 'sessions/100-chat/subagents/agent-b.jsonl'));
    const result = await service.cleanup([{ id: 'chat' }], options(inventory.reviewId));
    assertEqual(result.skipped, 1, 'renamed descendants change the reviewed footprint');
  });
});

h.test('cleanup reads the catalog once per batch and rechecks each chat with a targeted row read', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('first'), meta('second'));
    await file('sessions/100-first.jsonl', 'a');
    await file('sessions/100-second.jsonl', 'b');
    let catalogReads = 0;
    let rowReads = 0;
    const service = create({
      sessionMeta: async () => { catalogReads += 1; return rows.map(row => ({ ...row })); },
      sessionRow: async id => {
        rowReads += 1;
        const row = rows.find(entry => entry.id === id);
        return row ? { ...row, running: id === 'second' } : null;
      },
    });
    const inventory = await review(service);
    catalogReads = 0;
    const result = await service.cleanup([{ id: 'first' }, { id: 'second' }], options(inventory.reviewId));
    assertEqual(catalogReads, 1, 'the catalog is read once per cleanup batch');
    assertEqual(rowReads, 2, 'every selected chat gets its own targeted recheck');
    assertDeepEqual(result, { deleted: 1, skipped: 1, failed: 0 }, 'a chat reported running by its row read is preserved');
    assertDeepEqual(deleted, ['first'], 'only the rechecked idle chat is deleted');
  });
});

h.test('cleanup skips a chat pinned between the review and the batch', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'a');
    const service = create();
    const inventory = await review(service);
    rows[0]!.pinned = true;
    const result = await service.cleanup([{ id: 'chat' }], options(inventory.reviewId));
    assertDeepEqual(result, { deleted: 0, skipped: 1, failed: 0 }, 'a pinned chat leaves the cleanup selection');
    assertEqual(deleted.length, 0, 'pinned chats are never deleted by cleanup');
  });
});

h.test('cleanup deletes independent chats with bounded concurrency', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('one'), meta('two'), meta('three'), meta('four'));
    for (const row of rows) await file(`sessions/100-${row.id}.jsonl`, row.id);
    let active = 0, peak = 0;
    const service = create({ deleteSession: async id => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1; deleted.push(id);
    } });
    const inventory = await review(service);
    const result = await service.cleanup(rows.map(row => ({ id: row.id })), options(inventory.reviewId));
    assertEqual(result.deleted, 4, 'every reviewed chat is deleted');
    assert(peak >= 2, 'independent deletions overlap instead of queueing one by one');
    assert(peak <= 4, 'deletion concurrency stays bounded');
    assertEqual(new Set(deleted).size, 4, 'each chat is deleted exactly once');
  });
});

h.test('cleanup rechecks after acquiring the admission fence and always releases it', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'a');
    let held = false;
    const service = create({ beforeDelete: async () => {
      held = true;
      rows[0]!.running = true;
      return () => { held = false; };
    } });
    const inventory = await review(service);
    const result = await service.cleanup([{ id: 'chat' }], options(inventory.reviewId));
    assertEqual(result.skipped, 1, 'activity during admission is checked after the fence is acquired');
    assertEqual(held, false, 'skipped deletion releases the fence');
    assertEqual(deleted.length, 0, 'a changed admission state is not deleted');
  });
});

h.test('cleanup serializes concurrent batches and deduplicates selections', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'a');
    const service = create({ deleteSession: async id => { await new Promise(resolve => setTimeout(resolve, 10)); deleted.push(id); } });
    const inventory = await review(service);
    const results = await Promise.all([
      service.cleanup([{ id: 'chat' }, { id: 'chat' }], options(inventory.reviewId)),
      service.cleanup([{ id: 'chat' }], options(inventory.reviewId)),
    ]);
    assertEqual(results.reduce((sum, result) => sum + result.deleted, 0), 1, 'one reviewed chat is deleted at most once');
    assertEqual(results.reduce((sum, result) => sum + result.skipped, 0), 2, 'duplicates are reported as skipped');
    assertDeepEqual(deleted, ['chat'], 'concurrent requests never call the destructive dependency twice');
  });
});

h.test('archive-only is enforced and all-chat mode includes archived chats', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('active'), meta('archive', { archived: true }));
    await file('sessions/100-active.jsonl', 'a');
    await file('sessions/archived/200-archive.jsonl', 'b');
    const service = create();
    const inventory = await review(service);
    const result = await service.cleanup([{ id: 'active' }], options(inventory.reviewId, true));
    assertEqual(result.skipped, 1, 'archive-only cannot delete a live catalog entry');
    const all = await service.cleanup([{ id: 'active' }, { id: 'archive' }], options(inventory.reviewId));
    assertEqual(all.deleted, 2, 'all-chat mode covers both archive states');
    assertDeepEqual([...deleted].sort(), ['active', 'archive'], 'both reviewed persistent roots are deleted');
  });
});

h.test('archive moves and vanished rollouts invalidate the reviewed identity', async () => {
  await fixture(async ({ root, file, rows, create }) => {
    rows.push(meta('archive', { archived: true }), meta('missing'));
    const archived = await file('sessions/archived/100-archive.jsonl', 'a');
    const vanished = await file('sessions/200-missing.jsonl', 'b');
    const service = create();
    const inventory = await review(service);
    await rename(archived, join(root, 'sessions/100-archive.jsonl'));
    rows[0]!.archived = false;
    await rm(vanished);
    const result = await service.cleanup([{ id: 'archive' }, { id: 'missing' }], options(inventory.reviewId));
    assertDeepEqual(result, { deleted: 0, skipped: 2, failed: 0 }, 'physical identity and archive state are revalidated');
  });
});

h.test('metadata failures fail deletion instead of trusting a review snapshot', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'a');
    let unavailable = false;
    const service = create({ sessionMeta: async () => {
      if (unavailable) throw new Error('catalog unavailable');
      return rows;
    } });
    const inventory = await review(service);
    unavailable = true;
    const result = await service.cleanup([{ id: 'chat' }], options(inventory.reviewId));
    assertEqual(result.failed, 1, 'authoritative catalog errors cannot turn into deletes');
    assertEqual(deleted.length, 0, 'stale review metadata is never used as fallback');
  });
});

h.test('cleanup notifies once after a partial batch with confirmed deletions only', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('first'), meta('busy', { running: true }), meta('failed'), meta('last'));
    for (const row of rows) await file(`sessions/100-${row.id}.jsonl`, row.id);
    const attempted: string[] = [];
    const notifications: string[][] = [];
    const service = create({
      deleteSession: async id => {
        attempted.push(id);
        if (id === 'failed') throw new Error('deletion rejected');
        deleted.push(id);
      },
      onDeleted: ids => {
        assertDeepEqual([...attempted].sort(), ['failed', 'first', 'last'], 'notification follows the completed batch');
        notifications.push([...ids].sort());
      },
    });
    const inventory = await review(service);
    const result = await service.cleanup(rows.map(row => ({ id: row.id })), options(inventory.reviewId));
    assertDeepEqual(result, { deleted: 2, skipped: 1, failed: 1 }, 'partial success preserves cleanup counts');
    assertDeepEqual([...deleted].sort(), ['first', 'last'], 'only acknowledged deletions are completed');
    assertDeepEqual(notifications, [['first', 'last']], 'successful ids are delivered together exactly once');
    const noSuccess = await service.cleanup([{ id: 'busy' }, { id: 'failed' }], options(inventory.reviewId));
    assertDeepEqual(noSuccess, { deleted: 0, skipped: 1, failed: 1 }, 'a batch may contain no confirmed deletions');
    assertEqual(notifications.length, 1, 'skipped and failed deletions never produce notifications');
  });
});

h.test('a deletion observer failure preserves confirmed results and emits a diagnostic', async () => {
  await fixture(async ({ file, rows, create, deleted }) => {
    rows.push(meta('chat'));
    await file('sessions/100-chat.jsonl', 'history');
    const notifications: string[][] = [];
    const diagnostics: Array<{ kind: string; detail: unknown }> = [];
    const service = create({
      onDeleted: ids => {
        notifications.push([...ids]);
        throw new Error('observer failure');
      },
      diagnostic: (kind, detail) => { diagnostics.push({ kind, detail: JSON.parse(detail) }); },
    });
    const inventory = await review(service);
    const result = await service.cleanup([{ id: 'chat' }], options(inventory.reviewId));
    assertDeepEqual(result, { deleted: 1, skipped: 0, failed: 0 }, 'observer errors cannot relabel completed deletion as failed');
    assertDeepEqual(deleted, ['chat'], 'the destructive operation completed once');
    assertDeepEqual(notifications, [['chat']], 'the observer is called once with confirmed ids');
    assertDeepEqual(diagnostics, [{
      kind: 'storage-chats-deleted-notification-failed',
      detail: { sessionIds: ['chat'], error: 'observer failure' },
    }], 'the failed notification remains attributable to the affected chats');
  });
});

h.test('an unchanged open review is not invalidated by elapsed wall-clock time', async () => {
  await fixture(async ({ rows, file, create }) => {
    rows.push(meta('chat'));
    await file('sessions/1-chat.jsonl', 'unchanged');
    const service = create(); await service.refresh(); await settled(service);
    const review = await service.reviewInventory(), clock = Date.now;
    try {
      Date.now = () => clock() + 16 * 60_000;
      const result = await service.cleanup([{ id: 'chat' }], { reviewId: review.reviewId, cutoffMs: CUTOFF, archivedOnly: false });
      assertEqual(result.deleted, 1, 'unchanged reviewed content can still be deleted after leaving the dialog open');
    } finally { Date.now = clock; }
  });
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'device-storage-result.json'), 'device-storage');
  process.exit(failed);
})();
