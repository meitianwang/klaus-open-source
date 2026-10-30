import { app, BrowserWindow, Menu } from 'electron';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applicationMenuTemplate } from '../main/app/application-menu';
import { nativeMenuLabels } from '../main/app/native-menu-labels';
import { createOwnedEditMenu } from '../main/app/owned-edit-menu';
import { INITIAL_NATIVE_MENU_STATE } from '../contracts/native-menu-state';

const profile = process.env.KLAUS_NATIVE_MENU_PROFILE;
if (!profile) throw new Error('An isolated KLAUS_NATIVE_MENU_PROFILE is required');
app.setPath('userData', profile);
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/native-menu-vectors.json'), 'utf8'));
void app.whenReady().then(async () => {
  const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,<input id="text" value="editing"><p>Native menu fixture</p>');
  try {
    for (const chinese of [false, true]) {
      const labels = nativeMenuLabels(chinese), calls: string[] = [];
      const edit = createOwnedEditMenu(template => Menu.buildFromTemplate(template), owner.webContents,
        { execute: async command => { calls.push(command); return true; } }, command => calls.push(`native:${command}`), labels);
      const menu = Menu.buildFromTemplate(applicationMenuTemplate({
        name: 'Klaus', labels, state: { ...INITIAL_NATIVE_MENU_STATE, newProject: true },
        command: id => ({ id, label: labels.commands[id], click: () => { calls.push(id); } }),
        editMenu: edit, update: { label: labels.update.check },
        newWindow: () => { calls.push('newWindow'); }, mini: { click() {} }, zoom: command => calls.push(`zoom:${command}`),
        development: true,
        support: { documentation() {}, whatsNew() {}, troubleshooting() {}, status() {}, feedback() {}, taskManager() {}, trace() {} },
        trace: { state: 'idle', enabled: true },
      }));
      Menu.setApplicationMenu(menu);
      const vector = vectors.locales[chinese ? 'zh' : 'en'];
      assert.deepEqual(menu.items.map(item => item.label), vector.headings);
      for (const [key, index] of [['application', 0], ['file', 1], ['window', 4], ['help', 5]] as const) {
        assert.deepEqual(menu.items[index]!.submenu!.items.filter(item => item.visible).map(item => item.type === 'separator' ? null : item.label), vector[key]);
      }
      const editRows = edit.submenu!.items;
      assert.equal(edit.label, labels.edit);
      for (const item of editRows) if (item.role) assert.equal(item.label, labels.roles[item.role.toLowerCase()]);
      for (const row of editRows) if (row.submenu) for (const item of row.submenu.items) if (item.role) assert.equal(item.label, labels.roles[item.role.toLowerCase()]);
      assert.equal(editRows.find(row => String(row.role).toLowerCase() === 'pasteandmatchstyle' && row.visible)!.accelerator, 'CmdOrCtrl+Shift+V');
      assert.ok(editRows.some(row => String(row.role).toLowerCase() === 'pasteandmatchstyle' && !row.visible));
      const undo = edit.submenu!.getMenuItemById('klaus-edit-undo')!;
      undo.click(undo, owner, owner.webContents);
      menu.getMenuItemById('newProject')!.click(menu.getMenuItemById('newProject')!, owner, owner.webContents);
      menu.items[1]!.submenu!.items[0]!.click(menu.items[1]!.submenu!.items[0]!, owner, owner.webContents);
      assert.deepEqual(calls, ['undo', 'newProject', 'newWindow']);
      assert.equal(menu.items[1]!.submenu!.items[2]!.enabled, false);
      console.log(`${chinese ? 'Chinese' : 'English'} native menus: six headings, native submenus, file order, disabled temporary chat, and command callbacks passed`);
    }
  } finally { Menu.setApplicationMenu(null); owner.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
