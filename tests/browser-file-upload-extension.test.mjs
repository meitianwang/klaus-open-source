import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../resources/plugins-builtin/browser/chrome-extension/background.js', import.meta.url), 'utf8');
const uploadSource = source.slice(source.indexOf('async function executeCdp('), source.indexOf('async function executeBrowserPermissionCdp('));
function extension(rejection) {
  const context = {
    chrome: { runtime: { id: 'fixture-extension' }, debugger: { sendCommand: async () => { throw rejection; } } },
    cdpTarget: () => ({ tabId: 1 }), resolveSession: () => ({}), requireSessionTab: async () => {},
    attachedTargets: new Set(['1']), targetKey: () => '1', withTimeout: promise => promise, timeoutMs: () => 100,
    objectParam: value => value ?? {},
  };
  return runInNewContext(uploadSource + ';executeCdp', context);
}
for (const message of ['Not allowed', '{"code":-32000,"message":"Not allowed"}']) {
  test('upload permission denial explains the user-controlled extension setting: ' + message, async () => {
    const execute = extension({ message });
    await assert.rejects(execute({ method: 'DOM.setFileInputFiles' }), error => /chrome:\/\/extensions\/\?id=fixture-extension/.test(error.message) && /Allow access to file URLs/.test(error.message));
  });
}
test('unrelated upload failures and non-upload policy rejections retain their original errors', async () => {
  for (const [method, message] of [['DOM.setFileInputFiles', 'File not found'], ['Runtime.evaluate', 'Not allowed'], ['DOM.setFileInputFiles', '{"code":-32001,"message":"Not allowed"}']]) {
    const original = { message }; const execute = extension(original);
    await assert.rejects(execute({ method }), error => error === original);
  }
});
