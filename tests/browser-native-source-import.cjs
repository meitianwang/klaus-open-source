const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, createCipheriv, pbkdf2Sync, randomUUID } = require('node:crypto');
const { BrowserManager } = require('../dist/main/browser/manager.js');
const fixtures = require('../dist/tests/browser-profile-import-helpers.js');
const vectors = require('../contracts/vectors/browser-profile-import-vectors.json');
const { DatabaseSync } = require('node:sqlite');
const root = process.env.NATIVE_IMPORT_PROFILE;
const output = process.env.NATIVE_IMPORT_OUTPUT;
if (!root || !output) throw Error('Owned fixture paths are required.');
const mode = process.env.NATIVE_IMPORT_PHASE || 'initial';
const nativeRoot = path.join(root, 'electron', 'native-browser');
const source = path.join(nativeRoot, 'import-source-fixture');
app.commandLine.appendSwitch('native-browser-enabled');
app.commandLine.appendSwitch('native-browser-data-dir', nativeRoot);
if (mode !== 'no-source') app.commandLine.appendSwitch('native-browser-import-test-root', source);
app.on('window-all-closed', () => {});
const result = { ok: false, mode, stages: [] };
const save = stage => { result.stages.push(stage); fs.writeFileSync(output, JSON.stringify(result, null, 2)); console.log('STAGE', stage); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { const end = Date.now() + 15000; while (Date.now() < end) { if (await check()) return; await wait(25); } throw Error(label + ' timed out.'); }
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function hashes() { const data = {}; for (const file of ['Local State', 'Default/Network/Cookies', 'Default/Network/Cookies-wal', 'Default/Network/Cookies-shm', 'Default/Login Data', 'Default/History']) { const target = path.join(source, file); if (fs.existsSync(target)) data[file] = hash(target); } return data; }
const key = pbkdf2Sync('native-browser-import-fixture', 'saltysalt', 1003, 16, 'sha1');
function encrypted(value, host) { const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32)); return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.concat([host ? createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(value)])), cipher.final()]); }
let manager, host, server, sourceDb;
app.whenReady().then(async () => {
  try {
    host = new BrowserWindow({ width: 1200, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await host.loadURL('data:text/html,<title>Owned native source import verification</title>');
    manager = new BrowserManager({ window: host, configRoot: root, enabled: () => true, available: () => true, emit: () => {} });
    manager.setConversation('owned-import');
    const backend = await manager.profileImporter(new AbortController().signal);
    const profile = await manager.profile();
    if (mode === 'no-source') {
      const discovery = await backend.discover(new AbortController().signal);
      assert.equal(discovery.profiles.length, 0);
      assert(discovery.errors.some(error => error.code === vectors.mockSourceMissingCode));
      save('mock-mode-without-owned-source-rejects-before-default-discovery');
    } else {
      const previous = mode === 'restart' ? JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'))) : undefined;
      server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><form action="/done" method="post"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>'); });
      await new Promise(resolve => server.listen(previous?.port ?? 0, '127.0.0.1', resolve));
      const port = server.address().port, origin = `http://127.0.0.1:${port}`;
      if (mode === 'initial') {
        const directory = path.join(source, 'Default');
        fixtures.writeLocalState(source, { Default: { name: 'Synthetic profile' }, 'Profile 1': { name: 'Second profile' } });
        fixtures.profileDirectory(source, 'Profile 1');
        const network = path.join(directory, 'Network');
        sourceDb = fixtures.createCookies(network, [
          { host: '127.0.0.1', name: 'imported', encrypted: encrypted('synthetic-cookie', '127.0.0.1'), expiresAt: Date.now() + 86400000, httpOnly: true, sameSite: 1 },
          { host: '.partition.test', name: 'partitioned', encrypted: encrypted('synthetic-partition', '.partition.test'), path: '/owned', expiresAt: Date.now() + 86400000, httpOnly: true, secure: true, sameSite: 0, topFrameSiteKey: 'https://top.test', hasCrossSiteAncestor: true },
        ], { keepOpen: true, schemaVersion: 24, partitionedSchema: true });
        fixtures.createLogins(directory, [{ origin: origin + '/login', username: 'fixture-user', encrypted: encrypted('fixture-secret') }]);
        fixtures.createHistory(directory, Array.from({ length: 601 }, (_, i) => ({ url: origin + '/visit-' + i, title: 'Imported visit ' + i, visitedAt: Date.now() - 600000 + i })));
        const extension = fixtures.syntheticExtensionKey();
        const extensionRoot = path.join(directory, 'Extensions', extension.id);
        for (const version of ['2.0', '10.0']) {
          const folder = path.join(extensionRoot, version + '_0');
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, key: extension.key, name: 'Owned source fixture', version }));
        }
        fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({ port, extensionId: extension.id }));
        const original = hashes();
        const discovery = await backend.discover(new AbortController().signal);
        assert.equal(discovery.profiles.length, 2);
        assert.equal(discovery.profiles[0].profileId, 'Default');
        assert.deepEqual(['cookies', 'passwords', 'history', 'extensions'].map(category => discovery.profiles[0][category]), [true, true, true, true]);
        assert.equal(discovery.profiles[0].displayName, 'Synthetic profile');
        save('native-metadata-discovery-without-decryption');
        const started = Date.now();
        let ticks = 0; const timer = setInterval(() => ticks++, 5);
        const imported = await backend.importProfile('synthetic-import', { sourceId: 'chrome', profileId: 'Default', categories: { cookies: true, passwords: true, history: true, extensions: true }, allowUnverifiedExtensions: true }, new AbortController().signal);
        clearInterval(timer);
        assert.equal(imported.ok, true, JSON.stringify(imported.errors));
        assert.deepEqual(imported.counts, vectors.syntheticCounts);
        assert.deepEqual(hashes(), original, 'source database, WAL and metadata remain unchanged');
        assert.equal(manager.history({ limit: 1 }).items[0].isActorVisit, false);
        result.importDurationMs = Date.now() - started; result.hostTicks = ticks;
        result.counts = imported.counts;
        assert(ticks > 0, 'native worker and writes allow host event processing');
        assert(!JSON.stringify(imported).includes('synthetic-cookie') && !JSON.stringify(imported).includes('fixture-secret'), 'receipt excludes secrets');
        save('native-decryption-wal-snapshot-store-writes-and-history-projection');
        assert.equal(fs.existsSync(path.join(nativeRoot, 'Default', 'ImportStaging')), true);
        assert.equal(fs.readdirSync(path.join(nativeRoot, 'Default', 'ImportStaging')).length, 0, 'snapshots cleaned after receipt');
        const again = await backend.importProfile('repeat-history', { sourceId: 'chrome', profileId: 'Default', categories: { cookies: false, passwords: false, history: true, extensions: false } }, new AbortController().signal);
        assert.equal(again.ok, true, JSON.stringify(again.errors));
        const historyDb = new DatabaseSync(manager.data.databasePath);
        assert.equal(historyDb.prepare("SELECT count(*) AS n FROM browser_visits WHERE session_id='browser-import'").get().n, 601);
        historyDb.close();
        const invalid = await profile.importProfile('invalid-categories', { sourceId: 'chrome', profileId: 'Default', categories: [] });
        assert.equal(invalid.ok, false);
        assert.equal(invalid.errors[0].code, 'invalid_request');
        const vanished = await profile.importProfile('vanished-profile', { sourceId: 'chrome', profileId: 'Missing' });
        assert.equal(vanished.ok, false);
        const cancellation = new AbortController();
        const pending = backend.importProfile('cancel-read', { sourceId: 'chrome', profileId: 'Default' }, cancellation.signal); cancellation.abort();
        const cancelled = await pending;
        assert.equal(cancelled.cancelled, true);
        assert.deepEqual(cancelled.counts, { cookies: 0, passwords: 0, history: 0, extensions: 0 });
        const duringWrite = new AbortController();
        const onHistory = (_event, id) => { if (id === 'cancel-prefix') duringWrite.abort(); };
        profile.on('imported-history', onHistory);
        const prefix = await backend.importProfile('cancel-prefix', { sourceId: 'chrome', profileId: 'Default', categories: { cookies: false, passwords: false, history: true, extensions: false } }, duringWrite.signal);
        profile.removeListener('imported-history', onHistory);
        assert.equal(prefix.cancelled, true);
        assert.equal(prefix.counts.history, vectors.cancelledHistoryPrefix, 'cancellation retains the confirmed native batch');
        assert(!prefix.errors.some(error => error.code === 'apply_history_partial'), 'cancellation is distinct from a store failure');
        save('idempotent-history-validation-cancel-and-staging-cleanup');
        sourceDb.close(); sourceDb = undefined;
        const sidecar = path.join(network, 'Cookies-wal');
        const outside = path.join(root, 'owned-outside-sidecar'); fs.writeFileSync(outside, 'owned synthetic bytes');
        fs.symlinkSync(outside, sidecar);
        const rejectedSidecar = await backend.importProfile('symlink-sidecar', { sourceId: 'chrome', profileId: 'Default', categories: { cookies: true, passwords: false, history: false, extensions: false } }, new AbortController().signal);
        assert.equal(rejectedSidecar.counts.cookies, 0);
        assert(rejectedSidecar.errors.some(error => error.code === vectors.symlinkSidecarCode));
        fs.unlinkSync(sidecar);
        const broken = fixtures.profileDirectory(source, 'Broken');
        const brokenDb = new DatabaseSync(path.join(broken, 'History')); brokenDb.exec('CREATE TABLE unsupported (value TEXT)'); brokenDb.close();
        fixtures.writeLocalState(source, { Default: { name: 'Synthetic profile' }, Broken: { name: 'Broken schema' } });
        const schema = await backend.importProfile('invalid-schema', { sourceId: 'chrome', profileId: 'Broken', categories: { cookies: false, passwords: false, history: true, extensions: false } }, new AbortController().signal);
        assert.equal(schema.counts.history, 0);
        assert(schema.errors.some(error => error.code === vectors.unsupportedHistorySchemaCode));
        fs.writeFileSync(path.join(source, 'Local State'), '{ malformed synthetic JSON');
        const malformed = await backend.discover(new AbortController().signal);
        assert.equal(malformed.profiles.length, 0);
        assert(malformed.errors.some(error => error.code === vectors.malformedIndexCode));
        fixtures.writeLocalState(source, { Default: { name: 'Synthetic profile' }, 'Profile 1': { name: 'Second profile' } });
        save('cancelled-confirmed-prefix-symlink-sidecar-and-malformed-source-rejected');
      }
      const page = await manager.createTab('owned-import', origin + '/login');
      const cookies = (await page.cdp.command('Storage.getCookies')).cookies;
      assert(cookies.some(cookie => cookie.name === 'imported' && cookie.value === 'synthetic-cookie' && cookie.httpOnly));
      const chips = cookies.find(cookie => cookie.name === 'partitioned');
      assert(chips && chips.httpOnly && chips.secure && chips.path === '/owned');
      assert.equal(chips.partitionKey.topLevelSite, 'https://top.test');
      assert.equal(chips.partitionKey.hasCrossSiteAncestor, true);
      await manager.openManager('passwords', { viewId: 'source-passwords', bounds: { x: 100, y: 70, width: 900, height: 650 } }, host);
      const entry = manager.managementViews.get(host.webContents.id);
      const passwords = await entry.cdp.evaluate('(async()=> (await chrome.passwordsPrivate.getSavedPasswordList()).map(row=>({username:row.username})))()');
      assert.equal(passwords.filter(row => row.username === 'fixture-user').length, 1);
      await manager.openManager('passwords', { viewId: 'source-passwords', action: 'close' }, host);
      await manager.show({ sessionId: 'owned-import', bounds: { x: 100, y: 70, width: 900, height: 650 } });
      await manager.navigate(page, origin + '/login');
      await until(async () => await page.cdp.evaluate('document.querySelector("input[name=username]").value === "fixture-user" && document.querySelector("input[name=password]").value === "fixture-secret"'), 'imported login autofill');
      save('native-cookie-chips-password-manager-and-autofill');
      await manager.openManager('extensions', { viewId: 'source-extensions', bounds: { x: 100, y: 70, width: 900, height: 650 } }, host);
      const extensionsEntry = manager.managementViews.get(host.webContents.id);
      const extensionId = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'))).extensionId;
      assert.equal(await extensionsEntry.cdp.evaluate(`(async()=> (await chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true})).some(row=>row.id===${JSON.stringify(extensionId)} && row.version==='10.0'))()`), true);
      save('native-extension-version-selection-and-persistence');
    }
    manager.dispose(); host.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    result.ok = true; save('clean-exit'); app.quit();
  } catch (error) {
    result.error = error.stack; save('failed');
    try { sourceDb?.close(); manager?.dispose(); } catch {}
    if (host && !host.isDestroyed()) host.destroy(); server?.closeAllConnections(); server?.close(); app.exit(1);
  }
});
