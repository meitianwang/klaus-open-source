import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerUpdaterHandlers, UPDATER_CHANNELS } from '../main/ipc/handlers/updater';
import { UpdateService, type PendingUpdate, type UpdateStatus } from '../main/updater/service';
import { parseReleaseEnvelope } from '../main/updater/policy';
import { serveVerifiedMacUpdate } from '../main/updater/platform';
import { Harness } from './harness';
import { updateFixture } from './updater-fixture';
import { DynamicTools } from '../main/sessions/dynamic-tools';

const h = new Harness();
async function setup(options: { slow?: boolean; badBytes?: boolean; redirect?: boolean; installError?: string; timeout?: number; autoDownload?: () => boolean; prepare?: () => Promise<void> } = {}) {
  const f = updateFixture(), directory = await mkdtemp(join(tmpdir(), 'klaus-updater-service-'));
  const transitions: UpdateStatus[] = [], installs: PendingUpdate[] = [];
  let current = f.release(), withdrawn = false, checks = 0, downloaded = 0, response: ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url === '/feed') { checks++; if (withdrawn) { res.writeHead(204).end(); return; } res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(f.envelope(current))); return; }
    if (req.url === '/update.zip') {
      downloaded++;
      if (options.redirect) { res.writeHead(302, { Location: 'https://example.invalid/untrusted.zip' }).end(); return; }
      if (options.slow) { response = res; res.writeHead(200); res.flushHeaders(); return; }
      res.end(options.badBytes ? Buffer.alloc(f.artifact.length) : f.artifact); return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  current.artifact.url = `${origin}/update.zip`;
  const policy = { ...f.policy, feedUrl: `${origin}/feed`, fixtureOrigin: origin };
  const service = new UpdateService({ currentVersion: policy.currentVersion, cacheRoot: join(directory, 'cache'), policy, downloadTimeoutMs: options.timeout ?? 5_000, autoDownload: options.autoDownload, emit: value => transitions.push(value), installer: { install: async update => { installs.push(update); await options.prepare?.(); if (options.installError) throw new Error(options.installError); }, dispose: async () => {} } });
  const wait = async (state: UpdateStatus['state']) => {
    const deadline = Date.now() + 5_000;
    while (service.snapshot().state !== state) { if (Date.now() > deadline) throw new Error(`Expected ${state}, got ${JSON.stringify(service.snapshot())}`); await new Promise(resolveWait => setTimeout(resolveWait, 5)); }
  };
  return { f, service, transitions, installs, directory, wait, policy, get current() { return current; }, set current(value) { current = value; }, get checks() { return checks; }, get downloaded() { return downloaded; }, withdraw: () => { withdrawn = true; }, close: async () => { await service.dispose(); response?.destroy(); await new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); } };
}

void (async () => {
  await h.test('three existing IPC channels carry the full status and verified download pushes', async () => {
    const f = await setup();
    try {
      const registry = new ChannelRegistry(); registerUpdaterHandlers(registry, f.service);
      deepEqual(registry.channels(), [...UPDATER_CHANNELS].sort());
      const call = (channel: string, args: unknown[] = []) => registry.lookup(channel)!({ channel, role: 'main', senderId: 1, args: args as never });
      deepEqual(await call('updater:status'), {
        supported: true, state: 'idle', currentVersion: '1.0.0', availableVersion: null,
        error: null, errorKind: null, explicit: false, progress: null,
      });
      equal((await call('updater:check', [{ explicit: true }]) as { state: string }).state, 'downloading');
      await f.wait('downloaded');
      // The download announces its total before the first byte and its finished
      // transfer once; the terminal push clears the counters again.
      deepEqual(f.transitions.map(value => value.state), ['checking', 'downloading', 'downloading', 'downloaded']);
      equal(f.transitions[1]!.explicit, true);
      deepEqual(f.transitions[1]!.progress, { percent: 0, bytesPerSecond: 0, transferred: 0, total: f.f.artifact.length, installing: false });
      equal(f.transitions.at(-1)!.progress, null);
      equal(f.installs.length, 0);
      deepEqual(await call('updater:install'), { ok: true, started: true });
      equal(f.checks, 2); equal(f.installs.length, 1);
      equal((await f.service.install()).ok, false);
    } finally { await f.close(); }
  });
  await h.test('transfer progress is throttled, smoothed and spans the download share of the bar', async () => {
    const f = updateFixture(), directory = await mkdtemp(join(tmpdir(), 'klaus-updater-progress-'));
    const pushes: UpdateStatus[] = [];
    // Many small chunks with a clock that advances per reading: the cadence, not
    // the chunk count, must decide how many events reach the renderer. The bytes
    // are really signed so the transfer completes through verification.
    const chunk = 1024, chunks = 64, total = chunk * chunks;
    const bytes = Buffer.alloc(total, 7);
    const base = f.release();
    const release = { ...base, artifact: { ...base.artifact, size: total, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64'), signature: f.signed(bytes) } };
    let clock = 1_000;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < chunks; index++) controller.enqueue(new Uint8Array(bytes.subarray(index * chunk, (index + 1) * chunk)));
        controller.close();
      },
    });
    const service = new UpdateService({
      currentVersion: '1.0.0', cacheRoot: join(directory, 'cache'), policy: f.policy,
      now: () => (clock += 40), progressIntervalMs: 200, emit: value => pushes.push(value),
      fetch: async (input) => {
        const url = String(input);
        if (url === f.policy.feedUrl) return new Response(JSON.stringify(f.envelope(release)), { status: 200 });
        return new Response(body, { status: 200, headers: { 'content-length': String(total) } });
      },
      installer: { install: async () => {}, dispose: async () => {} },
    });
    try {
      await service.check();
      const deadline = Date.now() + 5_000;
      while (service.snapshot().state !== 'downloaded') {
        if (Date.now() > deadline) throw new Error(`stalled: ${JSON.stringify(service.snapshot())}`);
        await new Promise(resolveWait => setTimeout(resolveWait, 1));
      }
      const progress = pushes.filter(value => value.state === 'downloading' && value.progress);
      ok(progress.length >= 3, `expected several throttled progress pushes, got ${progress.length}`);
      ok(progress.length < chunks, `a chunk-per-event flood must not reach the renderer, got ${progress.length} for ${chunks} chunks`);
      const last = progress.at(-1)!.progress!;
      equal(last.transferred, total); equal(last.total, total);
      equal(last.percent, 60, 'a finished download owns 0-60 of the bar, leaving the rest to installation');
      ok(progress.every(value => value.progress!.percent <= 60), 'no download push may claim the installation range');
      ok(progress.every((value, index) => index === 0 || value.progress!.transferred >= progress[index - 1]!.progress!.transferred), 'transferred never goes backwards');
      ok(last.bytesPerSecond > 0, 'a moving transfer reports a smoothed speed');
      // 1 KiB per 40 ms is 25 KiB/s; smoothing must stay in that neighbourhood
      // rather than reporting either zero or an unbounded instantaneous spike.
      ok(last.bytesPerSecond > 20_000 && last.bytesPerSecond < 32_000, `smoothed speed out of range: ${last.bytesPerSecond}`);
      equal(pushes.at(-1)!.progress, null, 'the terminal push clears the transfer counters');
    } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
  await h.test('installation reports its own phases inside the upper share of the bar', async () => {
    const f = await setup({ prepare: async () => { await new Promise(resolveWait => setTimeout(resolveWait, 5)); } });
    try {
      const registry = new ChannelRegistry(); registerUpdaterHandlers(registry, f.service);
      await f.service.check(); await f.wait('downloaded');
      const before = f.transitions.length;
      const result = await f.service.install();
      equal(result.ok, true);
      const installing = f.transitions.slice(before).filter(value => value.state === 'installing');
      ok(installing.length >= 1, 'installation publishes at least its preparing phase');
      ok(installing.every(value => value.progress!.installing === true), 'installation pushes are marked as installing');
      ok(installing.every(value => value.progress!.percent > 60 && value.progress!.percent < 100), 'installation stays inside its own range and never claims completion');
      ok(installing.every(value => value.explicit === true), 'installation is always a person-initiated attempt');
    } finally { await f.close(); }
  });
  await h.test('failures keep the phase that produced them instead of reading as unsupported', async () => {
    const rejected = await setup({ badBytes: true });
    try {
      await rejected.service.check(); await rejected.wait('error');
      equal(rejected.service.snapshot().errorKind, 'download-failed');
      ok(/checksum/.test(rejected.service.snapshot().error ?? ''), 'the real diagnostic is preserved for logs');
    } finally { await rejected.close(); }
    const unreachable = await setup();
    try {
      unreachable.current = { ...unreachable.current, version: '0.0.1' };
      await unreachable.service.check(); await unreachable.wait('error');
      equal(unreachable.service.snapshot().errorKind, 'check-rejected', 'a feed that answered but failed its checks is a rejected offer');
    } finally { await unreachable.close(); }
    const failedInstall = await setup({ installError: 'fixture native installation failure' });
    try {
      await failedInstall.service.check(); await failedInstall.wait('downloaded');
      await failedInstall.service.install();
      equal(failedInstall.service.snapshot().errorKind, 'install-failed');
    } finally { await failedInstall.close(); }
    const unsupported = new UpdateService({ currentVersion: '1.0.0', cacheRoot: 'unused', unavailableReason: 'development build', emit: () => {}, installer: { install: async () => {}, dispose: async () => {} } });
    equal(unsupported.snapshot().errorKind, 'unsupported');
    await unsupported.dispose();
  });
  await h.test('only a person-initiated check is marked explicit', async () => {
    const f = await setup();
    try {
      await f.service.check(); await f.wait('downloaded');
      equal(f.transitions.every(value => value.explicit === false), true, 'the background cadence stays silent');
      f.withdraw();
      await f.service.check({ explicit: true });
      equal(f.service.snapshot().explicit, true);
      equal(f.service.snapshot().state, 'idle');
    } finally { await f.close(); }
  });
  await h.test('a control update receipt completes before installation drains its own dynamic caller', async () => {
    let dynamic!: DynamicTools, installed = false;
    const f = await setup({ prepare: async () => { await dynamic.close(); installed = true; } });
    const responses: unknown[] = [];
    dynamic = new DynamicTools({ request: async (_method, params) => { responses.push(params.response); }, knownSession: () => true, log: () => {} });
    dynamic.register({ name: 'control_install' }, (_args, _sessionId, signal) => f.service.requestInstall(signal));
    try {
      await f.service.check(); await f.wait('downloaded');
      dynamic.receive({ type: 'rawSessionEvent', params: { sessionId: 'owned-task', event: { dynamicToolCall: { callId: 'install', tool: 'control_install', arguments: {} } } } });
      const deadline = Date.now() + 5000;
      while (!installed) { if (Date.now() > deadline) throw new Error('Control update waited on its own caller'); await new Promise(resolveWait => setTimeout(resolveWait, 5)); }
      deepEqual(responses, [{ ok: true, accepted: true, phase: 'verification-pending' }]);
      equal(f.checks, 2); equal(f.installs.length, 1);
    } finally { await dynamic.close(); await f.close(); }
  });
  await h.test('a queued control update can be cancelled before verification or native installation starts', async () => {
    const f = await setup();
    try {
      await f.service.check(); await f.wait('downloaded');
      equal(f.service.requestInstall().accepted, true);
      deepEqual(f.service.requestInstall(), { ok: false, error: 'update_operation_in_progress' });
      await f.service.cancel(); await new Promise(resolveWait => setImmediate(resolveWait));
      equal(f.checks, 1); equal(f.installs.length, 0);
    } finally { await f.close(); }
  });
  await h.test('cancelling a model request before handoff prevents its queued update from starting', async () => {
    const f = await setup(), controller = new AbortController();
    try {
      await f.service.check(); await f.wait('downloaded');
      equal(f.service.requestInstall(controller.signal).accepted, true);
      controller.abort(); await new Promise(resolveWait => setImmediate(resolveWait));
      equal(f.checks, 1); equal(f.installs.length, 0);
      deepEqual(f.service.requestInstall(controller.signal), { ok: false, error: 'update_request_cancelled' });
      equal(f.service.snapshot().state, 'downloaded');
    } finally { await f.close(); }
  });
  await h.test('a failed accepted update publishes its actual later error and clears the owned cache', async () => {
    const f = await setup({ installError: 'fixture native installation failure' });
    try {
      await f.service.check(); await f.wait('downloaded'); equal(f.service.requestInstall().accepted, true);
      await f.wait('error'); equal(f.service.snapshot().error, 'fixture native installation failure');
      deepEqual(await readdir(join(f.directory, 'cache')), []);
    } finally { await f.close(); }
  });
  await h.test('concurrent timer and renderer checks share one whole download operation', async () => {
    const f = await setup({ slow: true });
    try {
      await Promise.all(Array.from({ length: 8 }, () => f.service.check()));
      while (!f.downloaded) await new Promise(resolveWait => setTimeout(resolveWait, 5));
      equal(f.checks, 1); equal(f.downloaded, 1);
      deepEqual(await f.service.install(), { ok: false, error: 'update_operation_in_progress' });
      await f.service.cancel(); equal(f.service.snapshot().state, 'error'); equal(f.installs.length, 0);
      deepEqual(await readdir(join(f.directory, 'cache')), []);
    } finally { await f.close(); }
  });
  await h.test('a later unchanged feed check verifies the cache without downloading the installer twice', async () => {
    const f = await setup();
    try {
      await f.service.check(); await f.wait('downloaded');
      equal((await f.service.check()).state, 'downloaded');
      equal(f.checks, 2); equal(f.downloaded, 1); equal(f.installs.length, 0);
    } finally { await f.close(); }
  });
  await h.test('a bad artifact never reaches downloaded or the platform installer', async () => {
    const f = await setup({ badBytes: true });
    try { await f.service.check(); await f.wait('error'); equal(f.service.snapshot().availableVersion, '1.1.0'); ok(/checksum/.test(f.service.snapshot().error ?? '')); ok(!f.transitions.some(value => value.state === 'downloaded')); equal((await f.service.install()).ok, false); equal(f.installs.length, 0); }
    finally { await f.close(); }
  });
  await h.test('redirect and stalled download fail closed and remove partial artifacts', async () => {
    for (const options of [{ redirect: true }, { slow: true, timeout: 35 }]) {
      const f = await setup(options);
      try { await f.service.check(); await f.wait('error'); equal(f.installs.length, 0); deepEqual(await readdir(join(f.directory, 'cache')), []); }
      finally { await f.close(); }
    }
  });
  await h.test('a withdrawn or changed release cannot install an already downloaded cache', async () => {
    for (const mutate of ['withdraw', 'change']) {
      const f = await setup();
      try {
        await f.service.check(); await f.wait('downloaded');
        if (mutate === 'withdraw') f.withdraw(); else f.current = { ...f.current, version: '1.2.0' };
        equal((await f.service.install()).ok, false); equal(f.installs.length, 0); equal(f.service.snapshot().state, 'error');
      } finally { await f.close(); }
    }
  });
  await h.test('tampering with a completed cache is detected again immediately before install', async () => {
    const f = await setup();
    try {
      await f.service.check(); await f.wait('downloaded');
      const folders = await readdir(join(f.directory, 'cache'));
      const file = join(f.directory, 'cache', folders[0]!, 'update.zip');
      await chmod(file, 0o600); await writeFile(file, Buffer.alloc(f.f.artifact.length));
      equal((await f.service.install()).ok, false); equal(f.installs.length, 0); ok(/checksum/.test(f.service.snapshot().error ?? ''));
    } finally { await f.close(); }
  });
  await h.test('platform rejection remains an error with the available version and no installation claim', async () => {
    const f = await setup({ installError: 'Invalid Authenticode signature' });
    try { await f.service.check(); await f.wait('downloaded'); deepEqual(await f.service.install(), { ok: false, error: 'Invalid Authenticode signature' }); equal(f.service.snapshot().state, 'error'); equal(f.service.snapshot().availableVersion, '1.1.0'); }
    finally { await f.close(); }
  });
  await h.test('fresh check retires a withdrawn banner and ordinary shutdown does not install', async () => {
    const f = await setup();
    try {
      await f.service.check(); await f.wait('downloaded'); f.withdraw(); await f.service.check();
      equal(f.service.snapshot().state, 'idle'); equal(f.service.snapshot().availableVersion, null);
      await f.service.dispose(); equal(f.installs.length, 0); deepEqual(await readdir(join(f.directory, 'cache')), []);
    } finally { await f.close(); }
  });
  await h.test('dispose aborts active work without allowing late downloaded notifications', async () => {
    const f = await setup({ slow: true });
    try { await f.service.check(); await f.service.dispose(); ok(!f.transitions.some(value => value.state === 'downloaded')); equal(f.installs.length, 0); }
    finally { await f.close(); }
  });
  await h.test('disabling automatic downloads announces available updates without transferring until requested', async () => {
    let autoDownload = false;
    const f = await setup({ autoDownload: () => autoDownload });
    try {
      const registry = new ChannelRegistry(); registerUpdaterHandlers(registry, f.service);
      const call = (channel: string, args: unknown[] = []) => registry.lookup(channel)!({ channel, role: 'main', senderId: 1, args: args as never });
      const checked = await call('updater:check', [{ explicit: true }]) as unknown as UpdateStatus;
      equal(checked.state, 'available');
      equal(checked.availableVersion, '1.1.0');
      equal(f.downloaded, 0, 'the artifact is not downloaded when automatic downloads are off');
      deepEqual(f.transitions.map(value => value.state), ['checking', 'available']);

      // Background rechecks keep the same available offer quiet without blinking checking.
      const beforeRecheck = f.transitions.length;
      const rechecked = await f.service.check();
      equal(rechecked.state, 'available');
      equal(f.downloaded, 0);
      equal(f.transitions.length, beforeRecheck);

      // Explicitly requesting download transfers and verifies the release.
      equal((await call('updater:check', [{ explicit: true, download: true }]) as unknown as UpdateStatus).state, 'downloading');
      await f.wait('downloaded');
      equal(f.downloaded, 1);

      // Keeping autoDownload off after the cache is ready preserves the verified cache.
      equal((await f.service.check()).state, 'downloaded');
      equal(f.downloaded, 1);

      // A withdrawn offer while autoDownload is off still retires to idle.
      f.withdraw();
      equal((await f.service.check()).state, 'idle');
      equal(f.service.snapshot().availableVersion, null);
    } finally { await f.close(); }
  });
  await h.test('unsigned development instances expose status without networking or installation', async () => {
    let network = 0;
    const service = new UpdateService({ currentVersion: '1.0.0', cacheRoot: 'unused', emit: () => {}, fetch: async () => { network++; throw new Error('unexpected fetch'); }, installer: { install: async () => { throw new Error('unexpected install'); }, dispose: async () => {} } });
    service.start(); equal((await service.check()).supported, false); equal((await service.install()).ok, false); equal(network, 0); await service.dispose();
  });
  await h.test('Squirrel handoff serves only the authorized feed and exact verified ZIP, then closes', async () => {
    const f = updateFixture(), directory = await mkdtemp(join(tmpdir(), 'klaus-update-handoff-'));
    const file = join(directory, 'verified.zip'); await writeFile(file, f.artifact);
    const proof = parseReleaseEnvelope(f.envelope(f.release()), f.policy);
    const bridge = await serveVerifiedMacUpdate({ proof, file });
    try {
      const response = await fetch(bridge.url), data = await response.json() as { url: string };
      equal(response.status, 200); deepEqual(Buffer.from(await (await fetch(data.url)).arrayBuffer()), f.artifact);
      equal((await fetch(new URL('/feed', bridge.url))).status, 404);
      equal((await fetch(bridge.url, { headers: { Origin: 'klaus://app' } })).status, 403);
      equal((await fetch(bridge.url, { method: 'POST' })).status, 403);
      equal((await fetch(`${data.url}?other`)).status, 404);
    } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
    await rejects(fetch(bridge.url));
  });
  process.exitCode = await h.finish(join(__dirname, 'updater.result.json'), 'updater');
})();
