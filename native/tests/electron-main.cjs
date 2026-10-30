const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createNativeRuntime } = require('../../dist/main/app/native-runtime');
const { app, BrowserWindow, ipcMain } = require('electron');
const { loadNativeAddon } = require('../../dist/main/native/binding');
const { NativeCapabilities } = require('../../dist/main/native/service');
const { ChannelRegistry } = require('../../dist/main/ipc/registry');
const { registerNativeHandlers } = require('../../dist/main/ipc/handlers/native');

const profile = process.env.KLAUS_NATIVE_TEST_ROOT;
if (!profile || !path.isAbsolute(profile) || !path.basename(profile).startsWith('klaus-native-electron-gate-')) throw new Error('An isolated native test profile is required');
app.setPath('userData', path.join(profile, 'electron'));

const results = [];
const roots = [];
const live = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, ms = 8000) {
  const until = Date.now() + ms;
  while (!await predicate()) {
    if (Date.now() >= until) throw new Error(`Timed out: ${label}`);
    await sleep(5);
  }
}
function root() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klaus-native-electron-'));
  roots.push(directory);
  return directory;
}
function host() {
  const binding = new addon.NativeHost();
  live.add(binding);
  return binding;
}
function ptyOptions(cwd, script) {
  return { cwd, command: '/bin/sh', args: ['-c', script], env: [], cols: 80, rows: 24, deadlineMs: 5000 };
}
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); }
}

let addon;
async function run() {
  await app.whenReady();
  app.dock?.hide();
  await test('loads the .node library inside a normal Electron main process', async () => {
    assert.ok(process.versions.electron);
    assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
    addon = loadNativeAddon(path.resolve(__dirname, '../artifacts', `klaus-native-${process.platform}-${process.arch}.node`));
    assert.equal(addon.abiVersion(), 1);
    assert.equal(addon.processId(), process.pid);
    assert.equal(typeof addon.NativeCredentials, 'function');
    assert.equal(addon.createCredentialFixture, undefined);
    assert.equal(addon.createWhatsAppFixture, undefined);
    for (const method of ['readMcpOAuthRecord', 'writeMcpOAuthRecord', 'removeMcpOAuthRecord']) {
      assert.equal(typeof addon.NativeCredentials.prototype[method], 'function');
    }
    console.log(`  runtime Electron=${process.versions.electron} Node=${process.versions.node} N-API=${process.versions.napi} pid=${process.pid}`);
  });
  if (!addon) throw new Error('Addon did not load');
  await test('Automation permission is queried asynchronously by the Electron main addon without requesting consent', async () => {
    assert.equal(typeof addon.automationPermissionStatus, 'function');
    const pending = addon.automationPermissionStatus();
    assert.ok(pending instanceof Promise);
    const status = await pending;
    assert.ok(['granted', 'denied', 'unknown'].includes(status));
    if (process.platform !== 'darwin') assert.equal(status, 'unknown');
  });
  await test('Photos, location and notification permissions are passive reads with the same three-state contract', async () => {
    for (const method of ['photosPermissionStatus', 'locationPermissionStatus', 'notificationPermissionStatus']) {
      assert.equal(typeof addon[method], 'function');
      const status = await addon[method]();
      assert.ok(['granted', 'denied', 'unknown'].includes(status), `${method} returned ${status}`);
      if (process.platform !== 'darwin') assert.equal(status, 'unknown');
    }
    assert.equal(typeof addon.requestPermission, 'function');
    if (process.platform !== 'darwin') assert.equal(await addon.requestPermission('notification'), 'unknown');
  });
  await require('./directory-quiescence.cjs')(test, host, root, cwd => ptyOptions(cwd, 'cat'));

  await test('search cancellation is immediate, scopes close, and the index is fresh', async () => {
    const binding = host();
    const capabilities = new NativeCapabilities(binding, () => assert.fail('unexpected PTY error'));
    capabilities.registerOwner('search-owner');
    const cwd = root();
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'ÉTÉ.md'), '');
    const first = await capabilities.search('search-owner', { root: cwd, query: 'été', limit: 40, deadlineMs: 5000 }).result;
    assert.deepEqual(first.hits, [{ rel: 'src/ÉTÉ.md', name: 'ÉTÉ.md', isDir: false }]);
    for (let index = 0; index < 500; index++) fs.writeFileSync(path.join(cwd, 'src', `search-${index}.txt`), '');
    const operation = capabilities.search('search-owner', { root: cwd, query: '', limit: 40, deadlineMs: 5000 });
    operation.cancel();
    await assert.rejects(operation.result, /CANCELLED/);
    fs.unlinkSync(path.join(cwd, 'src', 'ÉTÉ.md'));
    const fresh = await capabilities.search('search-owner', { root: cwd, query: 'été', limit: 40, deadlineMs: 5000 }).result;
    assert.deepEqual(fresh.hits, []);
    assert.equal((await capabilities.closeOwner('search-owner')).complete, true);
    assert.throws(() => capabilities.search('search-owner', { root: cwd, query: '', limit: 40, deadlineMs: 5000 }), /CLOSED/);
    assert.equal((await capabilities.shutdown()).complete, true);
    assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
  });

  // Driven by contracts/vectors/native-search-vectors.json. The one-shot channel
  // is the agent control surface (engine.fileSearch) and the packaging
  // performance baseline, and the persistent-session work changes native search
  // semantics beside it, so the contract is asserted from the recorded vectors
  // rather than from literals scattered across tests.
  //
  // Core-level admission (the 8-search cap) and the truncation bounds are
  // asserted in native/core/tests/capabilities.rs, which can hold operations
  // open; this suite covers what is observable across the IPC boundary.
  await test('one-shot workspace search honours the recorded contract vectors', async () => {
    const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../../contracts/vectors/native-search-vectors.json'), 'utf8'));
    const binding = host();
    const capabilities = new NativeCapabilities(binding, () => assert.fail('unexpected PTY error'));
    const registry = new ChannelRegistry();
    const primary = root();
    const extra = root();
    fs.mkdirSync(path.join(primary, 'src'));
    fs.writeFileSync(path.join(primary, 'src', 'app.ts'), '');
    fs.writeFileSync(path.join(extra, 'notes.md'), '');
    const handlers = registerNativeHandlers(registry, {
      capabilities,
      resolveSearchRoots: async (_context, payload) => payload.query === 'missing'
        ? { root: path.join(primary, 'no-such-directory'), extraRoots: [] }
        : { root: primary, extraRoots: [extra] },
      resolveTerminalOptions: async () => { throw new Error('unexpected terminal'); },
      deliver: () => assert.fail('unexpected delivery'),
    });
    handlers.attachOwner(93);
    const invoke = (channel, value) => registry.lookup(channel)({ role: 'main', senderId: 93, channel, args: [value] });

    // Result shape: a bare array of {rel,name,isDir}. Wrapping this once made
    // the mention menu render permanently empty.
    const hits = await invoke('engine:workspaceFileSearch', { query: 'app', limit: 40 });
    assert.equal(vectors.resultShape.bareArray, true);
    assert.ok(Array.isArray(hits), 'the handler returns a bare array, not an object wrapper');
    assert.deepEqual(hits, [{ rel: 'src/app.ts', name: 'app.ts', isDir: false }]);
    for (const hit of hits) {
      assert.deepEqual([...Object.keys(hit)].sort(), [...vectors.resultShape.fields].sort(), 'no field beyond the recorded shape reaches the renderer');
    }

    // Multi-root: the primary root's rel is verbatim, an extra root's rel is
    // prefixed with that root so the renderer can address it.
    const across = await invoke('engine:workspaceFileSearch', { query: 'notes', limit: 40 });
    assert.equal(vectors.multiRoot.extraRootsSearched, true);
    assert.equal(vectors.multiRoot.extraRootRelIsPrefixed, true);
    assert.deepEqual(across, [{ rel: path.join(extra, 'notes.md'), name: 'notes.md', isDir: false }]);
    const both = await invoke('engine:workspaceFileSearch', { query: '', limit: 40 });
    const rels = both.map((hit) => hit.rel).sort();
    assert.ok(rels.includes('src/app.ts'), 'the primary root keeps a verbatim relative path');
    assert.ok(rels.includes(path.join(extra, 'notes.md')), 'the extra root keeps its prefixed path');

    // A missing root is an empty result, not an error.
    assert.equal(vectors.missingRoot.returnsEmptyArray, true);
    assert.deepEqual(await invoke('engine:workspaceFileSearch', { query: 'missing', limit: 40 }), []);

    // Freshness: no watcher cache, so a deleted file is absent from the next
    // search of the same owner.
    assert.equal(vectors.freshness.noWatcherCache, true);
    assert.equal(vectors.freshness.rebuildsEveryCall, true);
    fs.unlinkSync(path.join(primary, 'src', 'app.ts'));
    assert.deepEqual(await invoke('engine:workspaceFileSearch', { query: 'app', limit: 40 }), []);

    assert.equal((await handlers.detachOwner(93)).complete, true);
    assert.equal((await capabilities.shutdown()).complete, true);
    assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
  });

  // The persistent-session channels end to end across the IPC boundary: start
  // walks once, query re-ranks the held snapshot without re-walking, stop closes
  // it, and teardown reclaims a session its renderer never stopped.
  await test('file-search session channels open, re-rank, isolate by owner, and drain on teardown', async () => {
    const binding = host();
    const capabilities = new NativeCapabilities(binding, () => assert.fail('unexpected PTY error'));
    const registry = new ChannelRegistry();
    const cwd = root();
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'app.ts'), '');
    fs.writeFileSync(path.join(cwd, 'readme.md'), '');
    let resolves = 0;
    const handlers = registerNativeHandlers(registry, {
      capabilities,
      resolveSearchRoots: async () => { resolves++; return { root: cwd, extraRoots: [] }; },
      resolveTerminalOptions: async () => { throw new Error('unexpected terminal'); },
      deliver: () => assert.fail('unexpected delivery'),
    });
    handlers.attachOwner(94);
    handlers.attachOwner(95);
    const invoke = (senderId, channel, value) => registry.lookup(channel)({ role: 'main', senderId, channel, args: [value] });

    const started = await invoke(94, 'engine:workspaceFileSearchSessionStart', { sessionId: 'chat-a' });
    assert.equal(typeof started.sessionId, 'string');
    assert.equal(started.roots, 1);
    assert.ok(started.scanned >= 2, 'the walk saw the tree once at creation');

    // Querying re-ranks the held snapshot: the tree is not walked again, so
    // resolveSearchRoots is not called per keystroke.
    const resolvesAfterStart = resolves;
    const first = await invoke(94, 'engine:workspaceFileSearchSessionQuery', { sessionId: started.sessionId, query: 'app', limit: 40 });
    assert.deepEqual(first, [{ rel: 'src/app.ts', name: 'app.ts', isDir: false }]);
    const second = await invoke(94, 'engine:workspaceFileSearchSessionQuery', { sessionId: started.sessionId, query: 'readme', limit: 40 });
    assert.deepEqual(second, [{ rel: 'readme.md', name: 'readme.md', isDir: false }]);
    assert.equal(resolves, resolvesAfterStart, 'a query re-ranks without re-resolving roots or re-walking');

    // The snapshot is frozen: a file created after the session opened is not
    // offered until a new session is opened.
    fs.writeFileSync(path.join(cwd, 'late.txt'), '');
    const frozen = await invoke(94, 'engine:workspaceFileSearchSessionQuery', { sessionId: started.sessionId, query: 'late', limit: 40 });
    assert.deepEqual(frozen, [], 'a mid-session file is invisible to the frozen snapshot');

    // A query needs a sessionId; a missing one is an explicit error, not a hang.
    // IpcHandlerError carries the code as a property, not in its message, so
    // assert on the code rather than matching the human-readable text.
    await assert.rejects(
      () => invoke(94, 'engine:workspaceFileSearchSessionQuery', { query: 'app' }),
      (error) => error.code === 'INVALID_SESSION',
    );
    // Owner isolation: another renderer cannot query or stop this session.
    await assert.rejects(
      () => invoke(95, 'engine:workspaceFileSearchSessionQuery', { sessionId: started.sessionId, query: 'app', limit: 40 }),
      /RESOURCE_NOT_OWNED/,
    );
    assert.deepEqual(await invoke(95, 'engine:workspaceFileSearchSessionStop', { sessionId: started.sessionId }), { ok: true }, 'stopping a foreign session is a no-op');
    assert.equal(binding.counts().searchSessions, 1, 'a foreign stop did not reclaim the session');

    // Stop closes it and the count drops; a second stop is an idempotent no-op.
    assert.deepEqual(await invoke(94, 'engine:workspaceFileSearchSessionStop', { sessionId: started.sessionId }), { ok: true });
    assert.equal(binding.counts().searchSessions, 0);
    assert.deepEqual(await invoke(94, 'engine:workspaceFileSearchSessionStop', { sessionId: started.sessionId }), { ok: true });

    // Teardown reclaims a session its renderer never stopped.
    const leaked = await invoke(94, 'engine:workspaceFileSearchSessionStart', { sessionId: 'chat-a' });
    assert.equal(binding.counts().searchSessions, 1);
    assert.equal((await handlers.detachOwner(94)).complete, true, 'detach reclaims an unstopped session');
    assert.equal(binding.counts().searchSessions, 0, 'no session outlives its owner');

    assert.equal((await handlers.detachOwner(95)).complete, true);
    assert.equal((await capabilities.shutdown()).complete, true);
    assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
  });

  await test('draft workspace search pins the explicit root and refuses invalid or foreign requests', async () => {
    const vectors = require('../../contracts/vectors/native-search-vectors.json').explicitDraftRoot;
    const registry = new ChannelRegistry();
    const window = new EventEmitter();
    window.webContents = new EventEmitter();
    window.webContents.id = 624;
    window.isDestroyed = () => false;
    const primary = root(), second = root();
    fs.writeFileSync(path.join(primary, 'primary.txt'), '');
    fs.writeFileSync(path.join(second, 'second.txt'), '');
    const bound = [];
    const runtime = createNativeRuntime(window, registry, {
      configRoot: root(), packaged: false,
      fixtureAddonPath: path.resolve(__dirname, '../artifacts', `klaus-native-${process.platform}-${process.arch}.node`),
      deliver: async () => assert.fail('unexpected delivery'), log: () => {},
      searchRoots: async id => { bound.push(id); return { root: second, extraRoots: [] }; },
    });
    const invoke = (channel, value, senderId = 624, role = 'main') => registry.lookup(channel)({ role, senderId, channel, args: [value] });
    const start = vectors.startChannel;
    try {
      for (const invalid of [null, '', '  ', 42, 'relative', primary + '/missing', path.join(primary, 'primary.txt'), primary + '\0']) {
        await assert.rejects(() => invoke(start, { root: invalid }), error => error.code === vectors.rejectInvalidCode);
        assert.equal(runtime.counts().searchSessions, 0);
      }
      await assert.rejects(() => invoke(start, { root: 'ssh://server/workspace' }), error => error.code === vectors.rejectRemoteCode);
      await assert.rejects(() => invoke(start, { root: primary, sessionId: 'bound-chat' }), error => error.code === vectors.rejectInvalidCode);
      await assert.rejects(() => invoke('engine:workspaceFileSearch', { root: primary, query: '' }), error => error.code === vectors.rejectInvalidCode);
      await assert.rejects(() => invoke(start, { root: primary }, 625), error => error.code === vectors.rejectForeignOwnerCode);
      await assert.rejects(() => invoke(start, { root: primary }, 624, 'browser'), error => error.code === vectors.rejectForeignOwnerCode);
      assert.equal(runtime.counts().searchSessions, 0);
      const a = await invoke(start, { root: primary });
      const b = await invoke(start, { root: second });
      assert.deepEqual(await invoke('engine:workspaceFileSearchSessionQuery', { sessionId: a.sessionId, query: '' }), [{ rel: 'primary.txt', name: 'primary.txt', isDir: false }]);
      assert.deepEqual(await invoke('engine:workspaceFileSearchSessionQuery', { sessionId: b.sessionId, query: '' }), [{ rel: 'second.txt', name: 'second.txt', isDir: false }]);
      assert.deepEqual(bound, [], 'explicit draft searches never resolve a bound chat');
      await invoke('engine:workspaceFileSearchSessionStop', { sessionId: a.sessionId });
      await invoke('engine:workspaceFileSearchSessionStop', { sessionId: b.sessionId });
      const existing = await invoke(start, { sessionId: 'bound-chat' });
      assert.deepEqual(bound, ['bound-chat']);
      await invoke('engine:workspaceFileSearchSessionStop', { sessionId: existing.sessionId });
    } finally {
      assert.equal((await runtime.shutdown()).complete, true);
      assert.deepEqual(runtime.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
    }
  });

  await test('a delayed file snapshot cannot cross a renderer owner lifetime', async () => {
    const binding = host();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const wrapped = new Proxy(binding, { get(target, key) {
      if (key === 'createSearchSession') return async options => { const info = await target.createSearchSession(options); await gate; return info; };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const capabilities = new NativeCapabilities(wrapped, () => assert.fail('unexpected PTY error'));
    capabilities.registerOwner('picker');
    const pending = capabilities.openSearchSession('picker', [root()], 5000);
    const rejected = assert.rejects(pending, /CLOSED/);
    try {
      await waitFor(() => binding.counts().searchSessions === 1, 'snapshot opened before navigation');
      assert.equal((await capabilities.closeOwner('picker')).complete, true);
      capabilities.registerOwner('picker');
      release();
      await rejected;
      assert.equal(binding.counts().searchSessions, 0);
    } finally { release(); await capabilities.shutdown(); }
  });

  await test('PTY writes, resize, ordered UTF-8 output and close barriers cross N-API', async () => {
    const binding = host();
    const errors = [];
    const capabilities = new NativeCapabilities(binding, (_owner, _id, error) => errors.push(error));
    capabilities.registerOwner('terminal-owner');
    const chunks = [];
    let exit;
    let sequence = 0;
    const resource = capabilities.openPty('terminal-owner', ptyOptions(root(), 'stty -echo; printf READY; read value; printf "<%s>你好" "$value"; stty size; exit 4'), (event) => {
      assert.equal(event.sequence, ++sequence);
      if (event.kind === 'data') chunks.push(event.data);
      else exit = event;
    });
    await resource.ready;
    await waitFor(() => Buffer.concat(chunks).includes(Buffer.from('READY')), 'terminal readiness');
    assert.equal((await resource.resize(99, 35)).bytesWritten, 0);
    assert.equal((await resource.write(Buffer.from('hello\n'))).bytesWritten, 6);
    await resource.finished;
    assert.ok(Buffer.concat(chunks).toString().includes('<hello>你好35 99'));
    assert.equal(exit.exitCode, 4);
    const firstClose = resource.close();
    assert.equal(resource.close(), firstClose);
    const report = await firstClose;
    assert.equal(report.complete, true, JSON.stringify(report));
    assert.equal(report.deliveryComplete, true);
    assert.equal(report.bytesRead, report.bytesEmitted);
    const after = sequence;
    await sleep(40);
    assert.equal(sequence, after);
    await assert.rejects(resource.write(Buffer.from('late')), /CLOSED/);
    assert.deepEqual(errors, []);
    await capabilities.shutdown();
    assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
  });

  await test('a slow consumer bounds the queue and preserves three MiB of output', async () => {
    const binding = host();
    const capabilities = new NativeCapabilities(binding, (_owner, _id, error) => { throw error; });
    capabilities.registerOwner('flood-owner');
    let bytes = 0;
    let ticks = 0;
    const clock = setInterval(() => ticks++, 5);
    const resource = capabilities.openPty('flood-owner', ptyOptions(root(), 'head -c 3145728 /dev/zero'), async (event) => {
      bytes += event.data.length;
      if (event.kind === 'data') await sleep(6);
    });
    try {
      await resource.ready;
      await resource.finished;
      const report = await resource.close();
      assert.equal(bytes, 3145728);
      assert.equal(report.complete, true, JSON.stringify(report));
      assert.equal(report.discardedBytes, 0);
      assert.ok(report.peakQueueChunks <= 65 && report.peakQueueChunks >= 32, JSON.stringify(report));
      assert.ok(ticks > 20, 'Electron main loop was blocked');
    } finally { clearInterval(clock); await capabilities.shutdown(); }
  });

  await test('deadline close fences a stalled asynchronous sink and reports incomplete delivery', async () => {
    const binding = host();
    let errors = 0;
    const capabilities = new NativeCapabilities(binding, () => { errors++; });
    capabilities.registerOwner('stalled-owner');
    let release;
    const gate = new Promise((_resolve, reject) => { release = () => reject(new Error('sink failed after close resolved')); });
    let callbacks = 0;
    const resource = capabilities.openPty('stalled-owner', ptyOptions(root(), 'trap "" HUP; while :; do head -c 1048576 /dev/zero; done'), async () => { callbacks++; await gate; });
    await resource.ready;
    await waitFor(() => callbacks === 1, 'stalled callback');
    const started = Date.now();
    const report = await resource.close(100);
    assert.ok(Date.now() - started < 400);
    assert.equal(report.complete, false);
    assert.equal(report.deliveryComplete, false);
    const count = callbacks;
    release();
    await resource.finished;
    await sleep(40);
    assert.equal(callbacks, count, 'a callback ran after close resolved');
    assert.equal(errors, 0, 'an error callback ran after close resolved');
    await capabilities.shutdown();
  });

  await test('closing during host resolution prevents a late PTY and older searches cannot supersede newer queries', async () => {
    const binding = host();
    const capabilities = new NativeCapabilities(binding, () => {});
    const registry = new ChannelRegistry();
    const cwd = root();
    fs.writeFileSync(path.join(cwd, 'alpha.txt'), '');
    fs.writeFileSync(path.join(cwd, 'beta.txt'), '');
    let releaseStart;
    let releaseSearch;
    const terminalGate = new Promise((resolve) => { releaseStart = resolve; });
    const searchGate = new Promise((resolve) => { releaseSearch = resolve; });
    let deliveries = 0;
    const handlers = registerNativeHandlers(registry, {
      capabilities,
      resolveSearchRoots: async (_context, payload) => { if (payload.query === 'alpha') await searchGate; return { root: cwd, extraRoots: [] }; },
      resolveTerminalOptions: async () => { await terminalGate; return { cwd, command: '/bin/sh', args: ['-c', 'exit 0'], env: [] }; },
      deliver: () => { deliveries++; },
    });
    handlers.attachOwner(91);
    handlers.attachOwner(92);
    const invoke = (senderId, channel, value) => registry.lookup(channel)({ role: 'main', senderId, channel, args: [value] });
    const pending = invoke(91, 'terminal:start', { id: 'pending-terminal' });
    await handlers.detachOwner(91);
    releaseStart();
    assert.equal((await pending).ok, false);
    assert.equal(deliveries, 0);
    assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
    const old = invoke(92, 'engine:workspaceFileSearch', { query: 'alpha' });
    const latest = await invoke(92, 'engine:workspaceFileSearch', { query: 'beta' });
    assert.deepEqual(latest, [{ rel: 'beta.txt', name: 'beta.txt', isDir: false }]);
    releaseSearch();
    assert.deepEqual(await old, []);
    await handlers.detachOwner(92);
    assert.equal((await capabilities.shutdown()).complete, true);
  });

  await test('owner teardown cannot close another owner and refuses late work', async () => {
    const binding = host();
    const capabilities = new NativeCapabilities(binding, () => {});
    for (const owner of ['owner-a', 'owner-b']) capabilities.registerOwner(owner);
    const a = capabilities.openPty('owner-a', ptyOptions(root(), 'cat'), () => {});
    const b = capabilities.openPty('owner-b', ptyOptions(root(), 'cat'), () => {});
    await Promise.all([a.ready, b.ready]);
    assert.throws(() => capabilities.ownedPty('owner-b', a.resourceId), /RESOURCE_NOT_OWNED/);
    assert.equal((await capabilities.closeOwner('owner-a')).complete, true);
    assert.throws(() => capabilities.openPty('owner-a', ptyOptions(root(), 'cat'), () => {}), /CLOSED/);
    assert.equal((await b.write(Buffer.from('still alive\n'))).bytesWritten, 12);
    const one = capabilities.shutdown();
    assert.equal(capabilities.shutdown(), one);
    assert.equal((await one).complete, true);
    assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
  });

  await test('sandboxed renderer invokes handlers and acknowledges targeted terminal events', async () => {
    const binding = host();
    const capabilities = new NativeCapabilities(binding, () => {});
    const registry = new ChannelRegistry();
    const cwd = root();
    fs.writeFileSync(path.join(cwd, 'native-file.txt'), '');
    const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'electron-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    const acknowledgements = new Map();
    let peak = 0;
    const ack = (event, id) => {
      if (event.sender.id !== window.webContents.id) return;
      const pending = acknowledgements.get(id);
      if (pending) { clearTimeout(pending.timer); acknowledgements.delete(id); pending.resolve(); }
    };
    ipcMain.on('native-test:ack', ack);
    const handlers = registerNativeHandlers(registry, {
      capabilities,
      resolveSearchRoots: async () => ({ root: cwd, extraRoots: [] }),
      resolveTerminalOptions: async () => ({ cwd, command: '/bin/sh', args: ['-c', 'stty -echo; printf READY; read value; printf "<%s>" "$value"; exit 6'], env: [] }),
      deliver: (senderId, channel, payload) => new Promise((resolve, reject) => {
        assert.equal(senderId, window.webContents.id);
        if (acknowledgements.size >= 8) return reject(new Error('transport backpressure bound exceeded'));
        const deliveryId = randomUUID();
        const timer = setTimeout(() => { acknowledgements.delete(deliveryId); reject(new Error('renderer ACK deadline')); }, 1000);
        acknowledgements.set(deliveryId, { resolve, timer });
        peak = Math.max(peak, acknowledgements.size);
        window.webContents.send('native-test:event', { deliveryId, channel, payload });
      }),
    });
    handlers.attachOwner(window.webContents.id);
    ipcMain.handle('native-test:invoke', (event, channel, value) => {
      assert.equal(event.sender.id, window.webContents.id);
      const handler = registry.lookup(channel);
      assert.ok(handler);
      return handler({ role: 'main', senderId: event.sender.id, channel, args: [value] });
    });
    try {
      await window.loadFile(path.join(__dirname, 'renderer.html'));
      const invoke = (channel, payload) => window.webContents.executeJavaScript(`window.nativeTest.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`);
      const entries = await invoke('engine:workspaceFileSearch', { query: 'native', limit: 40 });
      assert.deepEqual(entries, [{ rel: 'native-file.txt', name: 'native-file.txt', isDir: false }]);
      const first = await invoke('terminal:start', { id: 'renderer-terminal' });
      assert.equal(first.ok, true);
      assert.deepEqual(await invoke('terminal:start', { id: 'renderer-terminal' }), first);
      const received = () => window.webContents.executeJavaScript('window.nativeTest.received()');
      await waitFor(async () => (await received()).some((event) => event.payload.data?.includes('READY')), 'renderer receives native readiness');
      assert.deepEqual(await invoke('terminal:write', { id: 'renderer-terminal', data: 'renderer input\n' }), { ok: true });
      await waitFor(async () => (await received()).some((event) => event.channel === 'terminal:exit'), 'renderer receives exit');
      const events = await received();
      assert.ok(events.some((event) => event.payload.data?.includes('<renderer input>')));
      assert.equal(events.at(-1).payload.exitCode, 6);
      assert.ok(events.every((event) => event.payload.id === 'renderer-terminal' && typeof event.payload.resourceId === 'string' && Number.isInteger(event.payload.sequence)));
      assert.equal(peak, 1);
      assert.equal(acknowledgements.size, 0);
      assert.deepEqual(await invoke('terminal:kill', { id: 'renderer-terminal' }), { ok: true });
      assert.equal((await handlers.detachOwner(window.webContents.id)).complete, true);
      await capabilities.shutdown();
    } finally {
      ipcMain.removeHandler('native-test:invoke');
      ipcMain.removeListener('native-test:ack', ack);
      for (const pending of acknowledgements.values()) clearTimeout(pending.timer);
      window.destroy();
    }
  });
}

app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Native Electron test watchdog expired'); app.exit(1); }, 90_000);
run().catch((error) => { results.push({ name: 'test runner', ok: false, error: error.stack }); console.error(error); }).finally(async () => {
  for (const binding of live) { try { await binding.shutdown(1000); } catch {} }
  for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  const directory = path.join(__dirname, '../test-results');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'electron.json'), `${JSON.stringify({ electron: process.versions.electron, passed: results.length - failed, failed, results }, null, 2)}\n`);
  console.log(`native-electron: ${results.length - failed} passed, ${failed} failed`);
  clearTimeout(watchdog);
  app.exit(failed ? 1 : 0);
});
