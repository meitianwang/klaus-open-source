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
    if (mode === 'discovery-errors') {
      fs.rmSync(source, { recursive: true, force: true });
      const index = path.join(source, 'Local State');
      const discovery = async () => profile.listImportableProfiles(randomUUID());
      const expectCode = async code => {
        const value = await discovery();
        assert.equal(value.profiles.length, 1, 'directory profiles do not require optional index access');
        assert.equal(value.profiles[0].displayName, 'Default');
        assert.equal(value.errors.length, 0, JSON.stringify(value));
        assert(value.indexErrors.some(error => error.code === code), JSON.stringify(value));
        result.discoveryErrors ??= [];
        result.discoveryErrors.push({ code, errors: value.indexErrors });
      };
      const valid = () => {
        fixtures.writeLocalState(source, { Default: { name: 'Owned discovery profile' } });
        const directory = fixtures.profileDirectory(source, 'Default');
        if (!fs.existsSync(path.join(directory, 'History'))) fixtures.createHistory(directory, [{ url: 'https://owned.test/native-index', title: 'Owned index-independent history', visitedAt: Date.now() }]);
      };
      valid();
      assert.equal((await discovery()).profiles.length, 1);
      fs.chmodSync(index, 0o000);
      try {
        await expectCode('source_permission_denied');
        const imported = await backend.importProfile('without-readable-index', { sourceId: 'chrome', profileId: 'Default', categories: { history: true, cookies: false, passwords: false, extensions: false } }, new AbortController().signal);
        assert.equal(imported.ok, true, JSON.stringify(imported.errors));
        assert.equal(imported.counts.history, 1, 'selected directory import does not reopen the denied optional index');
        result.importWithoutIndex = imported.counts;
      }
      finally { fs.chmodSync(index, 0o600); }
      assert.equal((await discovery()).profiles.length, 1, 'restoring the owned index preserves directory discovery');
      const deniedHistory = path.join(source, 'Default', 'History');
      fs.chmodSync(deniedHistory, 0o000);
      try {
        const failedSnapshot = await backend.importProfile('denied-owned-snapshot', { sourceId: 'chrome', profileId: 'Default', categories: { history: true, cookies: false, passwords: false, extensions: false } }, new AbortController().signal);
        assert.equal(failedSnapshot.ok, false);
        assert.equal(failedSnapshot.counts.history, 0);
        const copyError = failedSnapshot.errors.find(error => error.code === vectors.snapshotFailureCode);
        assert(copyError, JSON.stringify(failedSnapshot));
        assert.match(copyError.message, /operation=copy; part=database; file_error=-\d+; errno=\d+/);
        assert(!failedSnapshot.errors.some(error => error.code === 'source_permission_denied'), 'copy failures do not claim to establish which side denied access');
        result.snapshotErrors = failedSnapshot.errors;
      } finally { fs.chmodSync(deniedHistory, 0o600); }
      fs.unlinkSync(index);
      await expectCode('local_state_missing');
      fs.mkdirSync(index);
      await expectCode('local_state_unreadable');
      fs.rmdirSync(index);
      const outside = path.join(root, 'owned-outside-index');
      fs.writeFileSync(outside, '{ synthetic outside index }');
      fs.symlinkSync(outside, index);
      await expectCode('local_state_symlink_rejected');
      fs.unlinkSync(index);
      fs.writeFileSync(index, '{ malformed synthetic JSON');
      await expectCode(vectors.malformedIndexCode);
      fs.writeFileSync(index, '');
      fs.truncateSync(index, 16 * 1024 * 1024 + 1);
      await expectCode('local_state_too_large');
      valid();
      assert.equal((await discovery()).profiles.length, 1);
      fs.chmodSync(source, 0o000);
      try {
        const deniedRoot = await discovery();
        assert.equal(deniedRoot.profiles.length, 0);
        assert(deniedRoot.errors.some(error => error.code === 'source_permission_denied'), JSON.stringify(deniedRoot));
      } finally { fs.chmodSync(source, 0o700); }
      for (const excluded of vectors.nonProfileDirectories) {
        const directory = fixtures.profileDirectory(source, excluded);
        fs.writeFileSync(path.join(directory, 'History'), '');
      }
      assert.equal((await discovery()).profiles.length, 1, 'browser state directories are not import profiles');
      const unindexed = fixtures.profileDirectory(source, 'Unindexed profile');
      fs.writeFileSync(path.join(unindexed, 'History'), '');
      const unindexedResult = await discovery();
      assert.equal(unindexedResult.profiles.length, 2);
      assert(unindexedResult.profiles.some(value => value.profileId === 'Unindexed profile'));
      save('native-directory-discovery-optional-index-diagnostics-and-denied-source-boundary');
    } else if (mode === 'password-source-selection') {
      fs.rmSync(source, { recursive: true, force: true });
      fixtures.writeLocalState(source, {});
      const passwordRequest = profileId => ({ sourceId: 'chrome', profileId, categories: { history: false, cookies: false, passwords: true, extensions: false } });
      const createPassword = (profileId, username) => {
        const directory = fixtures.profileDirectory(source, profileId);
        fixtures.createLogins(directory, [{ origin: 'https://password-selection.test/' + profileId, username, encrypted: encrypted('owned-selection-secret') }]);
        return directory;
      };
      const accountOnly = createPassword('AccountOnly', 'owned-account-only');
      fs.renameSync(path.join(accountOnly, 'Login Data'), path.join(accountOnly, 'Login Data For Account'));
      const both = createPassword('Both', 'owned-account-not-selected');
      fs.renameSync(path.join(both, 'Login Data'), path.join(both, 'Login Data For Account'));
      fixtures.createLogins(both, [{ origin: 'https://password-selection.test/Both', username: 'owned-primary-selected', encrypted: encrypted('owned-primary-secret') }]);
      const denied = createPassword('Denied', 'owned-denied-account');
      fs.renameSync(path.join(denied, 'Login Data'), path.join(denied, 'Login Data For Account'));
      fixtures.createLogins(denied, [{ origin: 'https://password-selection.test/Denied', username: 'owned-denied-primary', encrypted: encrypted('owned-denied-secret') }]);
      const unsupported = fixtures.profileDirectory(source, 'Unsupported');
      fixtures.createLogins(unsupported, [
        { origin: 'android://owned-synthetic@owned.fixture/', username: 'owned-unsupported', encrypted: Buffer.from('unsupported-fixture-value') },
        { origin: 'https://password-selection.test/Unsupported', username: 'owned-web-selected', encrypted: encrypted('owned-web-secret') },
      ]);
      const linked = fixtures.profileDirectory(source, 'Linked');
      fs.symlinkSync(path.join(accountOnly, 'Login Data For Account'), path.join(linked, 'Login Data For Account'));
      const discovery = await backend.discover(new AbortController().signal);
      assert(discovery.profiles.some(row => row.profileId === 'AccountOnly' && row.passwords), 'an account-only source is discoverable');
      assert(!discovery.profiles.some(row => row.profileId === 'Linked'), 'a symlinked account database is not an import source');
      result.passwordSelection = [];
      for (const profileId of ['AccountOnly', 'Both', 'Unsupported']) {
        const receipt = await backend.importProfile('password-selection-' + profileId, passwordRequest(profileId), new AbortController().signal);
        assert.equal(receipt.ok, true, JSON.stringify(receipt.errors));
        assert.equal(receipt.counts.passwords, 1);
        result.passwordSelection.push({ profileId, counts: receipt.counts, errors: receipt.errors });
      }
      fs.chmodSync(path.join(denied, 'Login Data'), 0o000);
      try {
        const receipt = await backend.importProfile('password-selection-denied', passwordRequest('Denied'), new AbortController().signal);
        assert.equal(receipt.ok, false);
        assert.equal(receipt.counts.passwords, 0, 'a denied primary database never selects another source');
        assert(receipt.errors.some(error => error.code === vectors.snapshotFailureCode), JSON.stringify(receipt));
        result.deniedPasswordErrors = receipt.errors;
      } finally { fs.chmodSync(path.join(denied, 'Login Data'), 0o600); }
      await manager.openManager('passwords', { viewId: 'owned-password-selection', bounds: { x: 0, y: 0, width: 1000, height: 700 } }, host);
      const entry = manager.managementViews.get(host.webContents.id);
      const nativeUsernames = await entry.cdp.evaluate(`(async () => (await chrome.passwordsPrivate.getSavedPasswordList()).filter(row => row.username.startsWith('owned-')).map(row => row.username).sort())()`);
      assert.deepEqual(nativeUsernames, ['owned-account-only', 'owned-primary-selected', 'owned-web-selected']);
      await manager.openManager('passwords', { viewId: 'owned-password-selection', action: 'close' }, host);
      result.nativePasswordCount = nativeUsernames.length;
      save('native-password-primary-or-account-selection-and-web-origin-eligibility');
    } else if (mode === 'history-policy') {
      fs.rmSync(source, { recursive: true, force: true });
      const now = Date.now();
      const expiredAt = now - 400 * 86400000;
      const historyRequest = { sourceId: 'chrome', profileId: 'Default', categories: { history: true, cookies: false, passwords: false, extensions: false } };
      fixtures.writeLocalState(source, { Default: { name: 'Owned history policy' }, Expired: { name: 'Expired history only' } });
      fixtures.createHistory(fixtures.profileDirectory(source), [
        ...Array.from({ length: 3 }, (_, index) => ({ url: 'https://history-policy.test/expired-' + index, title: 'Expired owned visit', visitedAt: expiredAt + index })),
        ...Array.from({ length: 507 }, (_, index) => ({ url: 'https://history-policy.test/repeated-' + index % 7, title: 'Owned repeated visit', visitedAt: now - 600000 + index })),
        { url: 'chrome://version', title: 'Excluded internal page', visitedAt: now - 300000 },
        { url: 'file:///owned-fixture-only.html', title: 'Excluded local file URL', visitedAt: now - 200000 },
      ]);
      const imported = await backend.importProfile('history-policy-mixed', historyRequest, new AbortController().signal);
      assert.equal(imported.ok, true, JSON.stringify(imported.errors));
      assert.equal(imported.counts.history, 507, 'expired visits do not stop later eligible batches');
      const projectionCount = () => {
        const database = new DatabaseSync(manager.data.databasePath, { readOnly: true });
        try { return database.prepare("SELECT count(*) AS n FROM browser_visits WHERE url LIKE 'https://history-policy.test/%'").get().n; }
        finally { database.close(); }
      };
      assert.equal(projectionCount(), 507, 'host projection contains only confirmed nonexpired rows');
      const repeated = await backend.importProfile('history-policy-repeat', historyRequest, new AbortController().signal);
      assert.equal(repeated.ok, true, JSON.stringify(repeated.errors));
      assert.equal(repeated.counts.history, 507);
      assert.equal(projectionCount(), 507, 'repeating history import does not duplicate the host projection');
      const cancellation = new AbortController();
      const onHistory = (_event, id) => { if (id === 'history-policy-cancel') cancellation.abort(); };
      profile.on('imported-history', onHistory);
      const cancelled = await backend.importProfile('history-policy-cancel', historyRequest, cancellation.signal);
      profile.removeListener('imported-history', onHistory);
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.counts.history, 247, 'cancellation counts confirmed rows after three expired rows');
      assert(!cancelled.errors.some(error => error.code === 'apply_history_partial'));
      fixtures.createHistory(fixtures.profileDirectory(source, 'Expired'), [{ url: 'https://history-policy.test/expired-only', visitedAt: expiredAt }]);
      const expired = await backend.importProfile('history-policy-expired', { ...historyRequest, profileId: 'Expired' }, new AbortController().signal);
      assert.equal(expired.ok, true, JSON.stringify(expired.errors));
      assert.equal(expired.counts.history, 0);
      const directRows = [
        { url: 'https://history-policy.test/direct-expired-a', title: 'Expired direct A', visitedAt: expiredAt, source: 'other' },
        { url: 'https://history-policy.test/direct-current', title: 'Direct current', visitedAt: now - 20000, source: 'other' },
        { url: 'https://history-policy.test/direct-expired-b', title: 'Expired direct B', visitedAt: expiredAt + 1, source: 'other' },
        { url: 'https://history-policy.test/direct-current', title: 'Direct current', visitedAt: now - 10000, source: 'other' },
      ];
      const direct = await profile.importHistory('history-policy-direct', directRows);
      assert.equal(direct.applied, 2);
      assert.equal(direct.processed, 4);
      assert.equal(direct.skippedExpired, 2);
      assert.deepEqual(direct.confirmedIndices, [1, 3]);
      const directAgain = await profile.importHistory('history-policy-direct-repeat', directRows);
      assert.deepEqual(directAgain.confirmedIndices, [1, 3]);
      const nativeCounts = () => {
        const database = new DatabaseSync(path.join(nativeRoot, 'Default', 'History'), { readOnly: true });
        try { return database.prepare("SELECT count(*) AS total, sum(CASE WHEN u.url LIKE '%/expired-%' OR u.url LIKE '%/direct-expired-%' THEN 1 ELSE 0 END) AS expired FROM visits v JOIN urls u ON u.id=v.url WHERE u.url LIKE 'https://history-policy.test/%'").get(); }
        finally { database.close(); }
      };
      await until(() => nativeCounts().total === 509, 'native history commit and idempotent visit count');
      assert.equal(nativeCounts().expired, 0);
      assert.equal(projectionCount(), 507);
      result.counts = imported.counts;
      result.cancelledConfirmed = cancelled.counts.history;
      result.direct = direct;
      result.nativeCounts = nativeCounts();
      const boundedDirectory = fixtures.profileDirectory(source, 'Bounded');
      fixtures.createHistory(boundedDirectory, []);
      const boundedDatabase = new DatabaseSync(path.join(boundedDirectory, 'History'));
      boundedDatabase.exec("BEGIN; INSERT INTO urls(id,url,title) VALUES (1,'https://history-budget.test/expired','Expired'),(2,'https://history-budget.test/recent-a','Recent A'),(3,'https://history-budget.test/recent-b','Recent B')");
      const insertBounded = boundedDatabase.prepare('INSERT INTO visits(url,visit_time) VALUES(?,?)');
      const chromeTime = milliseconds => BigInt(milliseconds) * 1000n + 11644473600000000n;
      for (let index = 0; index < 50000; index++) insertBounded.run(1, chromeTime(expiredAt + index));
      insertBounded.run(2, chromeTime(now - 1000));
      insertBounded.run(3, chromeTime(now - 500));
      boundedDatabase.exec('COMMIT'); boundedDatabase.close();
      const bounded = await backend.importProfile('history-policy-bounded', { ...historyRequest, profileId: 'Bounded' }, new AbortController().signal);
      assert.equal(bounded.counts.history, 2, 'the source row budget retains the newest visits');
      assert(bounded.errors.some(error => error.code === 'history_row_limit'));
      assert(!bounded.errors.some(error => error.code === 'apply_history_partial'));
      result.bounded = { counts: bounded.counts, errors: bounded.errors };
      save('native-history-retention-confirmed-indices-idempotence-and-cancellation');
    } else if (mode === 'no-source') {
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
        fs.writeFileSync(path.join(fixtures.profileDirectory(source, 'Profile 1'), 'History'), '');
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
        const malformed = await profile.listImportableProfiles(randomUUID());
        assert(malformed.profiles.length > 0, 'malformed optional metadata does not hide directory profiles');
        assert.equal(malformed.errors.length, 0);
        assert(malformed.indexErrors.some(error => error.code === vectors.malformedIndexCode));
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
