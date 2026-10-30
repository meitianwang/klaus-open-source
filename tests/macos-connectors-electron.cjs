const { app, BrowserWindow } = require('electron');
const strict = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { MacOsConnectors } = require('../dist/main/services/macos-connectors/service');
const { MacOsCommandRunner } = require('../dist/main/native/macos-command');
const { escapeAppleScript: esc } = require('../dist/main/services/macos-connectors/types');
const { Harness, waitFor } = require('../dist/tests/harness');

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'klaus-finder-electron-')));
app.setPath('userData', path.join(directory, 'profile'));
const h = new Harness();
let service, commands, window, cleanupSequence = 0, trashed = false;
const folder = path.join(directory, 'Own fixture folder'), filename = '中文 "quoted"\tfile\n.txt';
const file = path.join(folder, filename), trashName = 'klaus-finder-trash-' + randomUUID() + '.txt', trashFile = path.join(folder, trashName);
const testTrash = process.env.KLAUS_FINDER_TRASH_FIXTURE === '1';
fs.mkdirSync(folder); fs.writeFileSync(file, 'own fixture'); fs.writeFileSync(trashFile, 'recoverable own fixture');
const context = { sessionId: 'fixture', turnId: 'test', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }), workdir: folder };
const tool = async (name, args = {}) => (await service.call('macos-finder', name, args, context)).content[0].text;
const osa = async script => commands.run({ resourceId: 'fixture-cleanup', operationId: randomUUID(), generation: 1, sequence: ++cleanupSequence,
  executable: '/usr/bin/osascript', args: ['-e', script], timeoutMs: 10_000 }, new AbortController().signal);

app.whenReady().then(async () => {
  commands = new MacOsCommandRunner();
  service = new MacOsConnectors({ configRoot: directory, userHome: directory }); service.attachSession('fixture');
  window = new BrowserWindow({ width: 320, height: 200, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Klaus owned Finder fixture</title><p>Testing only temporary files.</p>');
  h.test('normal Electron sees actual Finder and Shortcuts serving dependencies', async () => {
    strict.equal((await service.capability('macos-finder')).tools.length, 10);
    strict.equal((await service.capability('macos-shortcuts')).tools.length, 2);
  });
  h.test('real Finder tags round-trip custom names and color metadata on an owned file', async () => {
    strict.equal(await tool('set_tags', { path: file, tags: ['Red', 'Klaus Fixture 中文'] }), `Set 2 tag(s) on ${file}`);
    strict.deepEqual(JSON.parse(await tool('get_tags', { path: file })).tags, ['Red', 'Klaus Fixture 中文']);
    strict.equal(fs.readFileSync(file, 'utf8'), 'own fixture');
  });
  h.test('directory JSON preserves tab/newline filenames and real custom tags', async () => {
    const value = JSON.parse(await tool('list_folder', { path: folder }));
    const item = value.items.find(item => item.name === filename);
    strict.ok(item); strict.equal(item.size, 11); strict.deepEqual(item.tags, ['Red', 'Klaus Fixture 中文']);
    strict.equal(JSON.parse(await tool('list_folder', { path: folder, limit: 1 })).count, 1);
  });
  h.test('Finder metadata and comments read back actual temporary-file changes', async () => {
    const metadata = JSON.parse(await tool('get_file_info', { path: file }));
    strict.equal(metadata.size, 11); strict.equal(metadata.kind, 'file'); strict.ok(metadata.created); strict.ok(metadata.modified);
    const comment = 'Klaus "fixture" comment\n第二行';
    await tool('set_comment', { path: file, comment }); strict.equal(JSON.parse(await tool('get_comment', { path: file })).comment, comment);
  });
  h.test('reveal and selection retain the exact owned filename without delimiter loss', async () => {
    await tool('reveal_file', { path: file });
    await waitFor(async () => JSON.parse(await tool('get_selection')).paths.some(value => fs.realpathSync(value) === file), 3000, 'owned file selected');
  });
  h.test('open_file opens only the owned folder and Finder reports that target', async () => {
    await tool('open_file', { path: folder });
    await waitFor(async () => (await osa(`tell application "Finder" to get POSIX path of (target of Finder window "Own fixture folder" as alias)`)).trim() === folder + '/', 3000, 'owned Finder folder opened');
  });
  if (testTrash) h.test('move_to_trash is real and the exact owned file is restored for cleanup', async () => {
    // Opt in only with a test account whose Trash is accessible for cleanup.
    await tool('move_to_trash', { path: trashFile }); trashed = true; strict.equal(fs.existsSync(trashFile), false);
    fs.renameSync(path.join(os.homedir(), '.Trash', trashName), trashFile);
    trashed = false; strict.equal(fs.readFileSync(trashFile, 'utf8'), 'recoverable own fixture');
  });
  else h.info('real trash recovery is not enabled', 'Use KLAUS_FINDER_TRASH_FIXTURE=1 only on an account allowing direct cleanup of its own Trash fixture; this is not a passed trash test.');
  h.test('clearing tags and closing the real owner leave no late work', async () => {
    await tool('set_tags', { path: file, tags: [] }); strict.deepEqual(JSON.parse(await tool('get_tags', { path: file })).tags, []);
    strict.deepEqual(await service.detachSession('fixture'), { complete: true }); strict.deepEqual(await service.close(), { complete: true });
    await strict.rejects(tool('get_tags', { path: file }), /not active/);
  });
  const code = await h.finish(path.join(directory, 'result.json'), 'macos-connectors-electron');
  app.exit(await cleanup(code));
}).catch(async error => { console.error(error); app.exit(await cleanup(1)); });

async function cleanup(code) {
  try {
    if (trashed) fs.renameSync(path.join(os.homedir(), '.Trash', trashName), trashFile);
    // Only windows whose target is this exact temporary folder are touched.
    if (commands) await osa(`tell application "Finder"
      try
        set w to Finder window "Own fixture folder"
        set targetPath to POSIX path of (target of w as alias)
        if targetPath is "${esc(folder + '/')}" then close w
      end try
    end tell`);
    if (service) strict.deepEqual(await service.close(), { complete: true });
    if (commands) strict.deepEqual(await commands.close(), { complete: true });
    if (window && !window.isDestroyed()) window.destroy();
    fs.rmSync(directory, { recursive: true, force: true }); console.log('owned_finder_fixture_cleanup=removed');
  } catch (error) { console.error('owned_finder_fixture_cleanup_failed=' + error.message); return 1; }
  return code;
}
