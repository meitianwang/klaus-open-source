const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { NativeCapabilities } = require('../../dist/main/native/service');
const { ChannelRegistry } = require('../../dist/main/ipc/registry');
const { registerNativeHandlers } = require('../../dist/main/ipc/handlers/native');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

module.exports = async function directoryQuiescenceTests(test, host, root, terminalOptions) {
  function fixture(binding, resolver = async (_context, value) => terminalOptions(value.cwd)) {
    const capabilities = new NativeCapabilities(binding, () => {});
    const registry = new ChannelRegistry();
    const handlers = registerNativeHandlers(registry, {
      capabilities, resolveSearchRoots: async () => { throw new Error('Unexpected search'); },
      resolveTerminalOptions: resolver, deliver: () => {},
    });
    handlers.attachOwner(101);
    return {
      capabilities, handlers,
      invoke: (channel, value) => registry.lookup(channel)({ role: 'main', senderId: 101, channel, args: [value] }),
    };
  }

  await test('directory quiescence reaps a real PTY before removal and preserves sibling terminals', async () => {
    const binding = host(), base = root(), managed = path.join(base, 'managed'), child = path.join(managed, 'child');
    const sibling = path.join(base, 'managed-sibling');
    fs.mkdirSync(child, { recursive: true }); fs.mkdirSync(sibling);
    const { handlers, capabilities, invoke } = fixture(binding);
    try {
      assert.equal((await invoke('terminal:start', { id: 'managed', cwd: child })).ok, true);
      assert.equal((await invoke('terminal:start', { id: 'sibling', cwd: sibling })).ok, true);
      const release = await handlers.quiesceDirectory(managed);
      try {
        assert.deepEqual(binding.counts(), { searches: 0, ptys: 1, searchSessions: 0 });
        assert.match((await invoke('terminal:start', { id: 'blocked', cwd: child })).error, /DIRECTORY_QUIESCED/);
        assert.deepEqual(await invoke('terminal:write', { id: 'sibling', data: 'still alive\n' }), { ok: true });
        fs.rmSync(managed, { recursive: true });
        assert.equal(fs.existsSync(managed), false);
      } finally { release(); release(); }
      fs.mkdirSync(managed);
      assert.equal((await invoke('terminal:start', { id: 'after-release', cwd: managed })).ok, true);
      assert.equal((await handlers.detachOwner(101)).complete, true);
      assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
    } finally { await capabilities.shutdown(); }
  });

  await test('a never-created scratch directory can be leased and remains excluded if created during removal', async () => {
    const binding = host(), base = root(), missing = path.join(base, 'missing', 'scratch');
    const { handlers, capabilities, invoke } = fixture(binding);
    try {
      const release = await handlers.quiesceDirectory(missing);
      try {
        assert.equal(fs.existsSync(missing), false);
        fs.mkdirSync(missing, { recursive: true });
        assert.match((await invoke('terminal:start', { id: 'blocked-missing', cwd: missing })).error, /DIRECTORY_QUIESCED/);
        assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
      } finally { release(); }
      assert.equal((await invoke('terminal:start', { id: 'released-missing', cwd: missing })).ok, true);
      assert.equal((await handlers.detachOwner(101)).complete, true);
    } finally { await capabilities.shutdown(); }
  });

  await test('a lease includes terminal creation still awaiting its authorized cwd', async () => {
    const binding = host(), cwd = root(), gate = deferred();
    const { handlers, capabilities, invoke } = fixture(binding, async () => { await gate.promise; return terminalOptions(cwd); });
    try {
      const pending = invoke('terminal:start', { id: 'pending' });
      const lease = handlers.quiesceDirectory(cwd);
      gate.resolve();
      const release = await lease;
      try { assert.equal((await pending).ok, false); assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 }); }
      finally { release(); }
    } finally { gate.resolve(); await capabilities.shutdown(); }
  });

  await test('a terminal requested during a lease cannot start after that lease is released', async () => {
    const binding = host(), cwd = root(), gate = deferred();
    const { handlers, capabilities, invoke } = fixture(binding, async () => { await gate.promise; return terminalOptions(cwd); });
    try {
      const release = await handlers.quiesceDirectory(cwd);
      const pending = invoke('terminal:start', { id: 'late-resolution' });
      release(); gate.resolve();
      assert.match((await pending).error, /DIRECTORY_QUIESCED/);
      assert.deepEqual(binding.counts(), { searches: 0, ptys: 0, searchSessions: 0 });
    } finally { gate.resolve(); await capabilities.shutdown(); }
  });

  await test('overlapping directory leases release independently and cover canonical aliases', async () => {
    const binding = host(), base = root(), managed = path.join(base, 'managed'), child = path.join(managed, 'child'), alias = path.join(base, 'alias');
    fs.mkdirSync(child, { recursive: true });
    fs.symlinkSync(managed, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const { handlers, capabilities, invoke } = fixture(binding);
    let releaseParent, releaseChild;
    try {
      releaseParent = await handlers.quiesceDirectory(alias);
      releaseChild = await handlers.quiesceDirectory(child);
      assert.match((await invoke('terminal:start', { id: 'alias-block', cwd: managed })).error, /DIRECTORY_QUIESCED/);
      releaseParent(); releaseParent();
      assert.match((await invoke('terminal:start', { id: 'child-block', cwd: child })).error, /DIRECTORY_QUIESCED/);
      assert.equal((await invoke('terminal:start', { id: 'parent-open', cwd: managed })).ok, true);
      releaseChild();
      assert.equal((await invoke('terminal:start', { id: 'child-open', cwd: child })).ok, true);
    } finally { releaseParent?.(); releaseChild?.(); await capabilities.shutdown(); }
  });

  await test('a failed directory lease releases admission without losing unresolved creation', async () => {
    const binding = host(), cwd = root(), gate = deferred();
    const { handlers, capabilities, invoke } = fixture(binding, async () => { await gate.promise; return terminalOptions(cwd); });
    try {
      const pending = invoke('terminal:start', { id: 'unresolved' });
      await assert.rejects(handlers.quiesceDirectory(cwd, 30), /DIRECTORY_QUIESCE_(FAILED|TIMEOUT)/);
      gate.resolve();
      assert.equal((await pending).ok, true);
      assert.equal((await invoke('terminal:start', { id: 'admission-restored' })).ok, true);
    } finally { gate.resolve(); await capabilities.shutdown(); }
  });

  await test('a failed event pump and owner detach retain a worker that is still closing', async () => {
    const cwd = root(); let state = 'closing', resourceId, retained = false;
    const report = () => ({ resourceId, state, complete: state === 'closed', lastSequence: 0, bytesRead: 0, bytesEmitted: 0, discardedBytes: 0, peakQueueChunks: 0 });
    const binding = {
      startPty: async options => { resourceId = options.resourceId; retained = true; return { resourceId, cwd: options.cwd, command: options.command, pid: 0 }; },
      readPty: async () => { throw new Error('controlled read failure'); },
      closePty: async () => report(), ptyReport: report,
      releasePty: () => { if (state !== 'closed') return false; retained = false; return true; },
      shutdown: async () => ({ complete: state === 'closed', pendingOperations: [], resources: [report()] }),
    };
    const { handlers, capabilities, invoke } = fixture(binding);
    try {
      assert.equal((await invoke('terminal:start', { id: 'closing-worker', cwd })).ok, true);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await handlers.detachOwner(101)).complete, false);
      await assert.rejects(handlers.quiesceDirectory(cwd), /DIRECTORY_QUIESCE_FAILED/);
      assert.equal(retained, true);
      state = 'closed';
      const release = await handlers.quiesceDirectory(cwd);
      release();
      assert.equal(retained, false);
      assert.equal((await capabilities.shutdown()).complete, true);
    } finally { state = 'closed'; await capabilities.shutdown(); }
  });
};
