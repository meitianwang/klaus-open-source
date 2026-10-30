const { app, nativeImage } = require('electron');
const strict = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { MacOsConnectors } = require('../dist/main/services/macos-connectors/service');
const { MacOsCommandRunner } = require('../dist/main/native/macos-command');
const root = resolve(process.env.KLAUS_APP_UI_FIXTURE_ROOT || ''), bundle = process.env.KLAUS_APP_UI_FIXTURE_APP, name = process.env.KLAUS_APP_UI_FIXTURE_NAME;
if (!root.startsWith(resolve('native/artifacts') + '/app-ui-electron-fixture-') || !bundle?.startsWith(root + '/') || !/^KlausAppUi[A-Za-z0-9]+$/.test(name || '')) throw new Error('An owned App UI fixture directory is required');
app.setPath('userData', join(root, 'profile'));
const results = []; let targetPid, service;
const record = async () => writeFile(join(root, 'progress.json'), JSON.stringify(results, null, 2));
async function waitFor(predicate, label, timeout = 5000) { const start = Date.now(); do { if (await predicate()) return; await delay(40); } while (Date.now() - start < timeout); throw new Error(label + ' timed out'); }
async function target() { return JSON.parse(await readFile(join(root, 'target-state.json'), 'utf8')); }
async function test(label, run) {
  results.push({ label, status: 'running' }); await record();
  try { await run(); results.at(-1).status = 'passed'; console.log('  ok   ' + label); }
  catch (error) { results.at(-1).status = 'failed'; results.at(-1).error = String(error?.stack || error); console.error('  FAIL ' + label + '\n' + String(error?.stack || error)); throw error; }
  finally { await record(); }
}
async function main() {
  await app.whenReady();
  const launched = spawn('/usr/bin/open', ['-n', '-a', bundle], { stdio: 'ignore' });
  await new Promise((yes, no) => { launched.once('error', no); launched.once('close', code => code === 0 ? yes() : no(new Error('Owned native fixture launch failed'))); });
  await waitFor(async () => { try { const state = await target(); targetPid = state.pid; return Number.isSafeInteger(targetPid) && targetPid > 1; } catch { return false; } }, 'owned target readiness');
  const runner = new MacOsCommandRunner(); let nativeCount = 0;
  service = new MacOsConnectors({ configRoot: root, userHome: root, guardInteraction: async () => { process.kill(targetPid, 0); }, commands: {
    available: paths => runner.available(paths), close: deadline => runner.close(deadline), run: (request, signal) => { nativeCount++; return runner.run(request, signal); },
  } });
  service.attachSession('owned');
  const context = { sessionId: 'owned', turnId: 'fixture-turn', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }) };
  async function raw(tool, args = {}) { return JSON.parse((await service.call('macos-app-ui', tool, args, context)).content[0].text); }
  async function call(tool, args = {}) { const value = await raw(tool, args); strict.notEqual(value.ok, false, tool + ': ' + JSON.stringify(value)); return value; }
  let tree, button, field;
  await test('actual System Events sees and activates only the owned native application', async () => {
    await call('app_ui_activate_app', { appName: name });
    const front = await call('app_ui_get_front_app'); strict.equal(front.name, name);
    const permission = await call('app_ui_check_permission'); strict.equal(permission.capabilities.readUiTree, true);
    const windows = await call('app_ui_list_windows', { appName: name }); strict.equal(windows.count, 1); strict.equal(windows.windows[0].title, 'Klaus App UI Owned Target');
    console.log('owned_app_ui_pid=' + targetPid);
  });
  await test('real AX tree resolves bounded snapshot paths and finds the owned field and button', async () => {
    tree = await call('app_ui_get_tree', { appName: name, maxDepth: 6, maxNodes: 200 }); strict.equal(tree.pid, targetPid); strict.ok(tree.count > 2 && tree.count <= 200);
    button = tree.nodes.find(node => node.role === 'AXButton' && (node.name || node.description || '').includes('Owned Button'));
    field = tree.nodes.find(node => node.role === 'AXTextField' && node.identifier === 'klaus-owned-input');
    strict.ok(button, JSON.stringify(tree)); strict.ok(field, JSON.stringify(tree));
    strict.equal((await call('app_ui_find_element', { appName: name, query: 'Owned Button', role: 'AXButton' })).found, true);
    strict.equal((await call('app_ui_wait_for', { appName: name, query: 'Owned Button', timeoutMs: 1000 })).found, true);
  });
  await test('dry resolution has no effect and the real AX button action increments its own counter once', async () => {
    const before = (await target()).clicks;
    const dry = await call('app_ui_click_element', { appName: name, elementPath: button.path, dryRun: true }); strict.equal(dry.dryRun, true); strict.equal((await target()).clicks, before);
    await call('app_ui_click_element', { appName: name, elementPath: button.path }); await waitFor(async () => (await target()).clicks === before + 1, 'owned AX click');
  });
  await test('real field replacement and focused Unicode typing reach the owned text field', async () => {
    await call('app_ui_set_value', { appName: name, elementPath: field.path, value: 'Owned replacement' }); await waitFor(async () => (await target()).text === 'Owned replacement', 'owned AX value');
    await call('app_ui_click_element', { appName: name, elementPath: field.path });
    await call('app_ui_press_key', { appName: name, key: 'a', modifiers: ['cmd'] });
    await waitFor(async () => { const state = await target(); return state.selectionLength === 'Owned replacement'.length; }, 'owned select-all responder');
    const typed = await call('app_ui_type_text', { appName: name, text: 'Owned 中文 😀' }); strict.equal(typed.focusedRole, 'AXTextField');
    try { await waitFor(async () => (await target()).text === 'Owned 中文 😀', 'owned Unicode input'); }
    finally { console.log('owned_app_ui_text_probe=' + JSON.stringify({ typed, target: await target() })); }
    await call('app_ui_set_value', { appName: name, elementPath: field.path, value: '' });
    await call('app_ui_click_element', { appName: name, elementPath: field.path });
    await runner.run({ resourceId: 'owned-unicode-probe', operationId: 'system-events-text', generation: 1, sequence: 1, executable: '/usr/bin/osascript',
      args: ['-e', `tell application "System Events"\nset p to application process "${name}"\nif unix id of p is not ${targetPid} or frontmost of p is not true then error "Owned probe target changed"\nkeystroke "Probe 中文 😀"\nend tell`] }, new AbortController().signal);
    await delay(150);
    console.log('owned_system_events_unicode_probe=' + JSON.stringify({ expected: 'Probe 中文 😀', actual: (await target()).text }));
  });
  await test('the real named menu acts only on the owned fixture menu', async () => {
    const before = (await target()).menus;
    await call('app_ui_select_menu_item', { appName: name, menuPath: ['Owned Actions', 'Increment Owned Counter'] });
    await waitFor(async () => (await target()).menus === before + 1, 'owned menu counter');
  });
  await test('actual screenshot pixels and mapped process click match the owned button', async () => {
    const frame = button.bounds; strict.ok(frame && frame.width > 0 && frame.height > 0);
    const region = [frame.x, frame.y, frame.width, frame.height].join(',');
    const capture = await call('app_ui_capture_screen', { appName: name, path: join(root, 'owned-button.png'), region });
    const image = nativeImage.createFromPath(capture.path); strict.equal(image.isEmpty(), false);
    strict.deepEqual(image.getSize(), capture.screenshotPixels); strict.ok(image.toBitmap().some(byte => byte !== 0));
    const args = { appName: name, x: capture.screenshotPixels.width / 2, y: capture.screenshotPixels.height / 2, coordinateSpace: 'screenshotPixels' };
    const before = (await target()).clicks, dry = await call('app_ui_click_at', { ...args, dryRun: true }); strict.equal(dry.capabilities.clickCoordinates, true); strict.equal((await target()).clicks, before);
    await call('app_ui_click_at', args); await waitFor(async () => (await target()).clicks === before + 1, 'owned mapped process click');
    console.log('owned_app_ui_capture=' + JSON.stringify({ pixels: capture.screenshotPixels, mapping: capture.clickMapping }));
  });
  await test('waiting cancellation drains its native request and owner replacement invalidates old paths and mappings', async () => {
    const waiting = raw('app_ui_wait_for', { appName: name, query: 'Never Exists Owned Fixture', timeoutMs: 10_000 }); const rejected = strict.rejects(waiting);
    await delay(100); await service.detachSession('owned', 0); await rejected; strict.deepEqual(await service.detachSession('owned', 5000), { complete: true });
    const count = nativeCount; service.attachSession('owned');
    strict.equal((await raw('app_ui_click_element', { appName: name, elementPath: button.path, dryRun: true })).ok, false);
    strict.equal((await raw('app_ui_click_at', { appName: name, x: 1, y: 1, coordinateSpace: 'screenshotPixels', dryRun: true })).ok, false);
    strict.equal(nativeCount, count);
  });
}
let exitCode = 0;
main().catch(error => { exitCode = 1; console.error(error); }).finally(async () => {
  try {
    if (service) strict.deepEqual(await service.close(10_000), { complete: true });
    if (targetPid) {
      try { process.kill(targetPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await waitFor(async () => { try { process.kill(targetPid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'owned native target exit');
      console.log('owned_app_ui_target_cleanup=terminated');
    }
  } catch (error) { exitCode = 1; console.error(error); }
  console.log(`macos-app-ui-electron: ${results.filter(row => row.status === 'passed').length} passed, ${results.filter(row => row.status === 'failed').length} failed, 0 info`);
  app.exit(exitCode);
});
