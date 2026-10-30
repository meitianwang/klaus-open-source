import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { Harness } from './harness';
import { nativeMenuLabels, nativeMenuUsesChinese } from '../main/app/native-menu-labels';
import { applicationMenuTemplate } from '../main/app/application-menu';
import { INITIAL_NATIVE_MENU_STATE, parseNativeMenuState, type NativeMenuState } from '../contracts/native-menu-state';
import { KLAUS_COMMANDS } from '../contracts/keybindings-commands';

const h = new Harness();
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/native-menu-vectors.json'), 'utf8'));
const ids = new Set(KLAUS_COMMANDS.map(command => command.id));
function template(chinese: boolean, state: NativeMenuState = INITIAL_NATIVE_MENU_STATE, trace = 'idle') {
  const labels = nativeMenuLabels(chinese), invoked: string[] = [];
  const menu = applicationMenuTemplate({
    name: 'Klaus', labels, state, development: false,
    command: id => { assert.ok(ids.has(id), `Unregistered menu command ${id}`); assert.ok(labels.commands[id], `Missing label ${id}`); return { id, label: labels.commands[id], click: () => { invoked.push(id); } }; },
    editMenu: { label: labels.edit, submenu: [] }, update: { label: labels.update.check },
    newWindow: () => { invoked.push('newWindow'); }, mini: { click: () => {} }, zoom: () => {},
    support: { documentation() {}, whatsNew() {}, troubleshooting() {}, status() {}, feedback() {}, taskManager() {}, trace() {} },
    trace: { state: trace, enabled: trace === 'idle' || trace === 'recording' },
  }) as MenuItemConstructorOptions[];
  return { menu, invoked };
}
const rows = (item: MenuItemConstructorOptions) => item.submenu as MenuItemConstructorOptions[];
const labelsOf = (item: MenuItemConstructorOptions) => rows(item).filter(row => row.visible !== false).map(row => row.type === 'separator' ? null : row.label);
function descendants(menu: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return menu.flatMap(item => [item, ...(Array.isArray(item.submenu) ? descendants(item.submenu as MenuItemConstructorOptions[]) : [])]);
}

process.exitCode = 1;
void (async () => {
  for (const chinese of [false, true]) await h.test(`${chinese ? 'Chinese' : 'English'} menus preserve the committed structure and labels`, () => {
    const vector = vectors.locales[chinese ? 'zh' : 'en'], { menu } = template(chinese);
    assert.deepEqual(menu.map(row => row.label), vector.headings);
    for (const [key, index] of [['application', 0], ['file', 1], ['window', 4], ['help', 5]] as const) assert.deepEqual(labelsOf(menu[index]!), vector[key]);
    assert.ok(!descendants(menu).some(row => row.role === 'services'));
    const file = rows(menu[1]!);
    assert.equal(file[2]!.enabled, false);
    assert.equal(file[2]!.accelerator, 'CmdOrCtrl+Shift+N');
    assert.equal(file.at(-1)!.role, 'close');
    for (const role of vectors.editRoles) assert.ok(nativeMenuLabels(chinese).roles[role], `Untranslated native edit role ${role}`);
  });
  await h.test('availability belongs to the active window and preserves every disabled action', () => {
    const unavailable = descendants(template(false).menu);
    const ready = Object.fromEntries(Object.keys(INITIAL_NATIVE_MENU_STATE).map(key => [key, true])) as NativeMenuState;
    const available = descendants(template(false, ready).menu);
    for (const id of vectors.gatedCommands) {
      assert.equal(unavailable.find(row => row.id === id)?.enabled, false, id);
      assert.equal(available.find(row => row.id === id)?.enabled, true, id);
    }
    const { menu, invoked } = template(false, ready);
    const project = descendants(menu).find(row => row.id === 'newProject')!;
    project.click!({} as never, {} as never, {} as never);
    assert.deepEqual(invoked, ['newProject']);
  });
  await h.test('thread management remains available without cluttering the file menu', () => {
    const all = descendants(template(false).menu);
    for (const id of ['renameThread', 'archiveThread', 'toggleThreadPin']) {
      const item = all.find(row => row.id === id)!;
      assert.equal(item.visible, false); assert.equal(item.acceleratorWorksWhenHidden, true);
    }
  });
  await h.test('locale precedence follows explicit preference, edition default, then system locale', () => {
    assert.equal(nativeMenuUsesChinese('en', null, 'zh-CN'), false);
    assert.equal(nativeMenuUsesChinese('zh', 'en', 'en-US'), true);
    assert.equal(nativeMenuUsesChinese(null, 'en', 'zh-CN'), false);
    assert.equal(nativeMenuUsesChinese(null, null, 'zh_TW'), true);
    assert.equal(nativeMenuUsesChinese(undefined, null, 'en-US'), false);
  });
  await h.test('malformed state reports cannot enable arbitrary actions', () => {
    assert.deepEqual(parseNativeMenuState(INITIAL_NATIVE_MENU_STATE), INITIAL_NATIVE_MENU_STATE);
    for (const value of [null, [], {}, { ...INITIAL_NATIVE_MENU_STATE, browser: 'true' }, { ...INITIAL_NATIVE_MENU_STATE, services: true }]) assert.equal(parseNativeMenuState(value), null);
  });
  await h.test('trace menu moves between recording and busy states in both languages', () => {
    for (const chinese of [false, true]) {
      const labels = nativeMenuLabels(chinese);
      const recording = rows(template(chinese, INITIAL_NATIVE_MENU_STATE, 'recording').menu[5]!).at(-1)!;
      const saving = rows(template(chinese, INITIAL_NATIVE_MENU_STATE, 'saving').menu[5]!).at(-1)!;
      assert.equal(recording.label, labels.support.stopTrace); assert.equal(recording.enabled, true);
      assert.equal(saving.label, labels.support.savingTrace); assert.equal(saving.enabled, false);
    }
  });
  process.exitCode = await h.finish(join(__dirname, 'native-menu-labels-result.json'), 'native-menu-labels');
})();
