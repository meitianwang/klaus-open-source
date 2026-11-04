import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeSettingsHistory, nativeSettingsUrl } from '../main/browser/native-settings';

test('native manager routes retain section boundaries and reject lookalike URLs', () => {
  for (const url of ['chrome://settings/content', 'chrome://settings/content/camera', 'chrome://settings/content/siteDetails?site=https%3A%2F%2Fexample.test', 'chrome://settings/cookies']) {
    assert.equal(nativeSettingsUrl('siteSettings', url), true, url);
  }
  for (const url of ['https://settings/content', 'chrome://settings.evil/content', 'chrome://settings/content-other', 'chrome://settings@other/content', 'chrome://extensions/', 'chrome://settings/autofill']) {
    assert.equal(nativeSettingsUrl('siteSettings', url), false, url);
  }
  assert.equal(nativeSettingsUrl('passwords', 'chrome://password-manager/settings'), true);
  assert.equal(nativeSettingsUrl('autofill', 'chrome://settings/autofill'), true);
  assert.equal(nativeSettingsUrl('autofill', 'chrome://settings/'), false);
});

test('site settings keep subpage history when the native router replaces entries', () => {
  const history = new NativeSettingsHistory('root');
  history.visit('camera');
  history.visit('site');
  assert.equal(history.canGoBack, true);
  assert.equal(history.step(-1), 'camera');
  assert.equal(history.step(-1), 'root', 'rapid traversal uses the requested index');
  history.visit('root');
  assert.equal(history.canGoBack, false);
  assert.equal(history.canGoForward, true);
  assert.equal(history.step(1), 'camera');
  history.visit('camera');
  history.visit('microphone');
  assert.equal(history.canGoForward, false, 'a new route replaces the forward branch');
  assert.equal(history.step(-1), 'camera');
});
