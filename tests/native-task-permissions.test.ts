import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeTaskPermissions, type NativePermissionPage, type NativePermissionSetting } from '../main/browser/native-permissions';

function page(owner: string) {
  let destroyed = false;
  const settings = new Map<string, NativePermissionSetting>();
  const native: NativePermissionPage = {
    isDestroyed: () => destroyed,
    setPermission: (origin, name, setting) => {
      const key = `${origin}|${name}`;
      if (setting === 'prompt') settings.delete(key);
      else settings.set(key, setting);
    },
    resetPermissions: () => settings.clear(),
  };
  return { owner, native, settings, destroy: () => { destroyed = true; } };
}

test('task permissions affect owned pages and replay into later tabs only', () => {
  const a = page('a'), b = page('b'), pages = [a, b];
  const permissions = new NativeTaskPermissions(() => pages);
  permissions.set('a', 'https://one.test', ['videoCapture', 'camera'], 'granted');
  assert.equal(a.settings.get('https://one.test|camera'), 'granted');
  assert.equal(b.settings.size, 0);
  const later = page('a');
  permissions.attach(later.owner, later.native);
  pages.push(later);
  assert.deepEqual(later.settings, a.settings);
  permissions.set('a', 'https://two.test', ['notifications'], 'denied');
  permissions.set('a', 'https://one.test', ['camera'], 'prompt');
  assert.deepEqual([...later.settings], [['https://two.test|notifications', 'denied']]);
  permissions.reset('b');
  assert.equal(later.settings.size, 1);
  permissions.reset('a');
  assert.equal(a.settings.size, 0);
  assert.equal(later.settings.size, 0);
  const resetTab = page('a');
  permissions.attach('a', resetTab.native);
  assert.equal(resetTab.settings.size, 0);
});

test('unsupported permission groups do not partially grant supported names', () => {
  const a = page('a');
  const permissions = new NativeTaskPermissions(() => [a]);
  assert.throws(() => permissions.set('a', 'https://one.test', ['notifications', 'unsupported'], 'granted'), /does not support/);
  assert.equal(a.settings.size, 0);
  const later = page('a');
  permissions.attach('a', later.native);
  assert.equal(later.settings.size, 0);
});

test('a failed group restores native scopes and leaves the task record unchanged', () => {
  const a = page('a'), b = page('a');
  const permissions = new NativeTaskPermissions(() => [a, b]);
  permissions.set('a', 'https://one.test', ['notifications'], 'denied');
  const original = b.native.setPermission;
  b.native.setPermission = (origin, name, setting) => {
    if (name === 'camera') throw new Error('native setting failed');
    original(origin, name, setting);
  };
  assert.throws(() => permissions.set('a', 'https://one.test', ['camera'], 'granted'), /native setting failed/);
  assert.deepEqual([...a.settings], [['https://one.test|notifications', 'denied']]);
  const later = page('a');
  permissions.attach('a', later.native);
  assert.deepEqual(later.settings, a.settings);
});
