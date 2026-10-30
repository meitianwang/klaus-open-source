const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { app } = require('electron');
const { NativeWhatsAppTransport } = require('../../dist/main/native/whatsapp');

const electronProfile = process.env.KLAUS_WHATSAPP_TEST_ROOT;
if (!electronProfile || !path.isAbsolute(electronProfile) || !path.basename(electronProfile).startsWith('klaus-whatsapp-electron-gate-')) throw new Error('An isolated WhatsApp Electron test profile is required');
app.setPath('userData', path.join(electronProfile, 'electron'));

const results = [], profiles = [], live = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixture, addon;
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(20); }
  throw new Error(`${label}: deadline exceeded`);
}
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.error(`  FAIL ${name}\n${error.stack}`); }
}
async function server() {
  const executable = process.env.KLAUS_TEST_WHATSAPP_FIXTURE_BINARY || path.resolve(__dirname, '../target/debug/klaus-whatsapp-fixture') + (process.platform === 'win32' ? '.exe' : '');
  assert.ok(path.isAbsolute(executable), 'The protocol fixture executable must be an explicit absolute path');
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let next = 0, base, exited = false;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const value = JSON.parse(line);
    if (value.ready) base = value.base;
    else if (value.id) { const waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); value.ok ? waiter.resolve(value.result) : waiter.reject(new Error('Fixture command failed')); } }
  });
  child.stderr.on('data', () => { /* The protocol fixture does not expose credential payloads. */ });
  child.on('exit', () => { exited = true; for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Fixture exited')); } pending.clear(); });
  child.on('error', () => { exited = true; });
  await until(() => base || (exited && Promise.reject(new Error('Fixture could not start'))), 'fixture listener', 5000);
  return {
    base,
    request(action, values = {}) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture command deadline')); }, 5000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, action, ...values }) + '\n');
      });
    },
    async close() { child.stdin.end(JSON.stringify({ id: ++next, action: 'stop' }) + '\n'); await until(() => exited, 'fixture process exit', 5000).catch(() => child.kill('SIGKILL')); lines.close(); },
  };
}
function resource(authDir) {
  if (!authDir) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klaus-whatsapp-electron-')); profiles.push(root); authDir = path.join(root, 'whatsapp'); }
  const resourceId = randomUUID(), events = [];
  const binding = addon.createWhatsAppFixture(resourceId, JSON.stringify({ authDir }), fixture.base);
  const port = new NativeWhatsAppTransport({ authDir }, event => { events.push(event); }, { resourceId, binding });
  const result = { authDir, resourceId, binding, port, events }; live.add(result); return result;
}
async function close(value) {
  const report = await value.port.close(10000);
  assert.equal(report.complete, true, `native close incomplete: ${JSON.stringify(report)}`);
  assert.deepEqual(report.pendingOperations, []);
  live.delete(value); return report;
}
async function run() {
  await app.whenReady(); app.dock?.hide();
  await test('normal Electron loads the isolated native fixture with a verified binary identity', async () => {
    assert.ok(process.versions.electron); assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
    const file = path.resolve(__dirname, '../artifacts/whatsapp-fixtures', `klaus-native-${process.platform}-${process.arch}.node`);
    const manifest = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
    assert.equal(manifest.whatsappFixtures, true);
    assert.equal(manifest.sha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    addon = require(file); assert.equal(typeof addon.createWhatsAppFixture, 'function');
    assert.equal(addon.processId(), process.pid);
    fixture = await server();
    console.log(`  runtime Electron=${process.versions.electron} Node=${process.versions.node} N-API=${process.versions.napi}`);
  });
  if (!addon || !fixture) throw new Error('Native protocol fixture unavailable');
  await test('HTTP version discovery and authenticated Noise produce a QR, pair, reconnect and persist the profile', async () => {
    const f = resource();
    await f.port.open();
    const qr = await until(() => f.events.find(event => event.kind === 'qr'), 'actual Noise QR');
    assert.equal(f.port.report().connected, false);
    assert.ok(qr.code.startsWith('klaus-loopback-qr-ref,'));
    await fixture.request('pair', { qr: qr.code });
    await until(() => f.events.some(event => event.kind === 'connected'), 'paired connected event', 25000);
    const stats = await fixture.request('stats'); assert.equal(stats.pairReplies, 1); assert.ok(stats.reopened >= 1);
    assert.ok(fs.statSync(path.join(f.authDir, 'store.db')).size > 0);
    const messageId = await f.port.sendText('15555550202@s.whatsapp.net', 'first encrypted send', 10000);
    assert.ok(messageId);
    await until(() => f.events.some(event => event.kind === 'message'), 'actual Signal decrypted reply', 10000);
    assert.equal(f.events.find(event => event.kind === 'message').message.conversation, 'fixture encrypted reply');
    assert.ok((await fixture.request('stats')).received.includes('first encrypted send'));
    await close(f);
    const reopened = resource(f.authDir); await reopened.port.open();
    await until(() => reopened.events.some(event => event.kind === 'connected'), 'persisted profile reconnect', 20000);
    assert.equal(reopened.events.some(event => event.kind === 'qr'), false);
    await reopened.port.sendText('15555550202@s.whatsapp.net', 'persisted Signal send', 10000);
    await until(async () => (await fixture.request('stats')).received.includes('persisted Signal send'), 'persisted Signal session');
    await close(reopened);
    await until(async () => (await fixture.request('stats')).active === 0, 'all sockets released');
  });
  await test('pairing refuses an invalid QR HMAC even when the account signature is valid', async () => {
    const f = resource(); await f.port.open();
    const qr = await until(() => f.events.find(event => event.kind === 'qr'), 'invalid-HMAC QR');
    await fixture.request('pair', { qr: qr.code, wrongHmac: true });
    const result = await until(() => f.events.find(event => event.kind === 'pairError' || event.kind === 'connected'), 'HMAC terminal outcome', 20000);
    assert.equal(result.kind, 'pairError');
    assert.equal(f.port.report().connected, false);
    await close(f);
  });
  await test('a failed Signal database commit cannot be acknowledged as a successful send', async () => {
    const f = resource(); await f.port.open();
    const qr = await until(() => f.events.find(event => event.kind === 'qr'), 'storage-failure QR');
    await fixture.request('pair', { qr: qr.code });
    await until(() => f.events.some(event => event.kind === 'connected'), 'storage-failure connected', 20000);
    await f.port.sendText('15555550202@s.whatsapp.net', 'warm persisted Signal session', 10000);
    await until(() => f.events.some(event => event.kind === 'message'), 'storage warmup reply');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(f.authDir, 'store.db'));
    db.exec("CREATE TRIGGER fixture_fail_session_insert BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'synthetic storage failure'); END;");
    try {
      await assert.rejects(() => f.port.sendText('15555550202@s.whatsapp.net', 'must not transmit on failed persistence', 10000));
      assert.equal((await fixture.request('stats')).received.includes('must not transmit on failed persistence'), false);
    } finally { db.exec('DROP TRIGGER fixture_fail_session_insert'); db.close(); await close(f); }
  });

  await test('forged Noise certificates never produce a QR and shutdown releases the real socket', async () => {
    await fixture.request('mode', { mode: 'forged' });
    const before = await fixture.request('stats'), f = resource(); await f.port.open();
    try {
      await until(async () => (await fixture.request('stats')).connections > before.connections, 'forged server handshake');
      await sleep(250);
      assert.equal(f.events.some(event => event.kind === 'qr' || event.kind === 'connected'), false);
    } finally { await close(f); await fixture.request('mode', { mode: '' }); }
    await until(async () => (await fixture.request('stats')).networkActive === 0, 'forged socket closed');
  });
  await test('close cancels held HTTP discovery and held Noise handshakes with no remaining socket or profile lock', async () => {
    for (const mode of ['httpHold', 'hold']) {
      await fixture.request('mode', { mode });
      const before = await fixture.request('stats'), f = resource(); await f.port.open();
      await until(async () => { const stats = await fixture.request('stats'); return mode === 'httpHold' ? stats.swRequests > before.swRequests : stats.connections > before.connections; }, 'held network request');
      const started = Date.now(); await close(f); assert.ok(Date.now() - started < 5000, 'bounded actual shutdown');
      await until(async () => (await fixture.request('stats')).networkActive === 0, 'held sockets closed');
      await fixture.request('mode', { mode: '' });
      const reopen = resource(f.authDir); await reopen.port.open(); await close(reopen);
    }
  });
  await test('native send cancellation drains the actual held key request and does not retry or transmit', async () => {
    const f = resource(); await f.port.open();
    const qr = await until(() => f.events.find(event => event.kind === 'qr'), 'cancel-send QR');
    await fixture.request('pair', { qr: qr.code });
    await until(() => f.events.some(event => event.kind === 'connected'), 'cancel-send connected');
    await fixture.request('mode', { mode: 'keyHold' });
    const controller = new AbortController();
    const pending = f.port.sendText('15555550202@s.whatsapp.net', 'cancelled synthetic send', 10000, controller.signal);
    const rejected = assert.rejects(pending, /WHATSAPP_SEND_OUTCOME_UNKNOWN/);
    await sleep(100); controller.abort(); await rejected;
    await close(f); await fixture.request('mode', { mode: '' });
    assert.equal((await fixture.request('stats')).received.includes('cancelled synthetic send'), false);
    await until(async () => (await fixture.request('stats')).networkActive === 0, 'cancel-send socket release');
  });
  await test('the real native resource excludes another profile writer and releases the lease after close', async () => {
    const f = resource(); await f.port.open();
    const duplicate = resource(f.authDir);
    await assert.rejects(() => duplicate.port.open(), /WHATSAPP_PROFILE_BUSY/); await close(duplicate); await close(f);
    const reopened = resource(f.authDir); await reopened.port.open(); await close(reopened);
  });

  await test('real pairing service uses one native owner, produces PNG and routes decrypted messages and replies', async () => {
    const { WhatsAppPairingService } = require('../../dist/main/services/channels/whatsapp-pairing');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klaus-whatsapp-owner-')); profiles.push(root);
    let rawQr, owned; let creates = 0; const inbound = [], controller = new AbortController();
    const service = new WhatsAppPairingService({
      nativeFactory: (options, deliver) => {
        creates++; const resourceId = randomUUID(), binding = addon.createWhatsAppFixture(resourceId, JSON.stringify({ authDir: options.authDir }), fixture.base);
        return new NativeWhatsAppTransport(options, event => { if (event.kind === 'qr') rawQr = event.code; deliver(event); }, { resourceId, binding });
      },
      enable: async () => { if (!owned) owned = await service.factory({}, { configRoot: root, signal: controller.signal,
        inbound: async message => { inbound.push(message); return { reply: 'host reply over real Signal' }; } }); },
    });
    try {
      const [first, second] = await Promise.all([service.start(), service.start()]);
      assert.equal(first.status, 'qr'); assert.equal(second.qrcodeDataUrl, first.qrcodeDataUrl);
      assert.ok(first.qrcodeDataUrl.startsWith('data:image/png;base64,iVBOR')); assert.equal(creates, 1);
      await fixture.request('pair', { qr: rawQr });
      await until(async () => (await service.poll()).status === 'connected', 'host paired projection');
      assert.equal((await owned.send({ targetId: '15555550202', text: 'host kickoff' })).ok, true);
      await until(async () => (await fixture.request('stats')).received.includes('host reply over real Signal'), 'host actual reply');
      assert.equal(inbound.length, 1); assert.equal(inbound[0].text, 'fixture encrypted reply');
      assert.equal(inbound[0].sessionKey, 'whatsapp:15555550202');
      service.cancel(); await owned.close(); await owned.done; await service.close();
      assert.equal((await service.poll()).ok, false);
    } finally { controller.abort(); service.cancel(); await owned?.close(); await service.close(); }
  });
  await test('HTTP rejection is visible and a closed native resource refuses further operations', async () => {
    await fixture.request('mode', { mode: 'httpFail' });
    const f = resource(); await f.port.open();
    try { await until(() => f.events.some(event => event.kind === 'networkError'), 'HTTP rejection event'); }
    finally { await close(f); await fixture.request('mode', { mode: '' }); }
    assert.throws(() => f.binding.open(randomUUID(), 1000), /CLOSED/);
    await assert.rejects(() => f.port.sendText('15555550202@s.whatsapp.net', 'late'), /CLOSED/);
  });

}
(async () => {
  try { await run(); } catch (error) { results.push({ ok: false }); console.error(error.stack); }
  finally {
    if (results.some(item => !item.ok) && fixture) console.error('protocol-stats', JSON.stringify(await fixture.request('stats').catch(() => ({}))));
    for (const value of live) { try { await close(value); } catch (error) { results.push({ ok: false }); console.error(error.message); } }
    await fixture?.close();
    if (!live.size) for (const root of profiles) fs.rmSync(root, { recursive: true, force: true });
    const passed = results.filter(item => item.ok).length, failed = results.length - passed;
    console.log(`whatsapp-electron: ${passed} passed, ${failed} failed`);
    app.exit(failed ? 1 : 0);
  }
})();
