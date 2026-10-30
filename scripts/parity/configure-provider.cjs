const { binaryPath, outputRoot } = require('./paths.cjs');
const { readFileSync, mkdirSync, existsSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { EngineManager } = require('../../dist/main/engine/manager.js');
const { setSessionModel } = require('../../dist/main/services/session-store.js');
const { kvSet } = require('../../dist/main/services/settings.js');

void (async () => {
  const url = readFileSync(join(outputRoot(), 'provider-url.txt'), 'utf8').trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('The fixture must stay on loopback');
  const status = await fetch(url + '/fixture/status').then(response => response.json());
  console.log(JSON.stringify({ providerReady: true, ...status }));
  for (const name of ['electron', 'tauri']) {
    const configRoot = join(outputRoot(), 'profiles', name);
    const marker = join(configRoot, '.parity-fixture');
    if (existsSync(configRoot) && !existsSync(marker)) throw new Error('Refusing to modify a profile not created by this fixture');
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(marker, 'Local parity fixture only\n');
    const manager = new EngineManager('parity-fixture');
    try {
      const engine = await manager.attach({
        command: binaryPath(), args: [],
        env: [['KLAUS_CONFIG_DIR', configRoot], ['KLAUS_SESSION_DIR', join(configRoot, 'sessions')], ['KLAUS_PLUGIN_HOME', join(configRoot, 'plugins')]],
      });
      await engine.client.requestWithTimeout('config/batchWrite', { edits: [{
        keyPath: 'modelProviders.parity', mergeStrategy: 'replace', value: {
          name: 'Parity fixture', provider: 'anthropic', model: 'fixture-model', baseUrl: url,
          maxContextTokens: 200000, default: true, thinking: 'off',
          capabilities: { contextWindow: 200000, vision: true, nativePdf: true },
        },
      }] }, 15000);
      await engine.client.requestWithTimeout('model/credential/write', { id: 'parity', apiKey: 'fixture-key' }, 15000);
      setSessionModel('', 'custom:parity', 'custom', configRoot);
      kvSet('model_tiers:custom', JSON.stringify({ low: 'parity', medium: 'parity', high: 'parity' }), configRoot);
      console.log(JSON.stringify({ profile: name, source: 'custom', model: 'custom:parity', configured: true }));
    } finally { await manager.shutdownAll(); }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
