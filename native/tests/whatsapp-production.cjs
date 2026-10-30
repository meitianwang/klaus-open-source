const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { NativeWhatsAppTransport } = require('../../dist/main/native/whatsapp');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klaus-whatsapp-production-'));
app.setPath('userData', path.join(root, 'electron'));
let port;
(async () => {
  let failed = false;
  try {
    await app.whenReady(); app.dock?.hide();
    const addonPath = path.resolve(__dirname, '../artifacts', `klaus-native-${process.platform}-${process.arch}.node`);
    const manifest = JSON.parse(fs.readFileSync(`${addonPath}.json`, 'utf8'));
    assert.equal(manifest.sourceTreeDirty, false); assert.equal(manifest.whatsappFixtures, false); assert.equal(manifest.credentialFixtures, false);
    assert.equal(manifest.sha256, createHash('sha256').update(fs.readFileSync(addonPath)).digest('hex'));
    const addon = require(addonPath);
    assert.equal(addon.processId(), process.pid); assert.equal(addon.abiVersion(), 1);
    assert.equal(typeof addon.NativeWhatsApp, 'function');
    assert.equal(addon.createWhatsAppFixture, undefined); assert.equal(addon.createCredentialFixture, undefined);
    port = new NativeWhatsAppTransport({ authDir: path.join(root, randomUUID()), addonPath }, () => { throw new Error('An unopened resource must not emit network events'); });
    assert.equal((await port.close(5000)).complete, true);
    assert.equal(port.report().opened, false);
    console.log('whatsapp-production-electron: 1 passed, 0 failed');
  } catch (error) { failed = true; console.error(error.stack); console.log('whatsapp-production-electron: 0 passed, 1 failed'); }
  finally { await port?.close(5000); fs.rmSync(root, { recursive: true, force: true }); app.exit(failed ? 1 : 0); }
})();
