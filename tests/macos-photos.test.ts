import strict from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { MacOsConnectors } from '../main/services/macos-connectors/service';
import { MACOS_TOOL_CONTRACTS } from '../main/services/macos-connectors/tool-contracts';
import { collectPhotoFiles } from '../main/services/macos-connectors/photos-files';
import { photoAssets } from '../main/services/macos-connectors/photos-model';
import type { MacOsCommand } from '../main/native/macos-command';
import type { MacOsCallContext, Row } from '../main/services/macos-connectors/types';

const h = new Harness(), directory = mkdtempSync(join(tmpdir(), 'klaus-macos-photos-'));
const cleanups: Array<() => Promise<unknown>> = [], source = join(directory, process.platform === 'win32' ? 'Own photo 图片.jpg' : 'Own "photo"\n图片.jpg'), library = join(directory, 'Own Library.photoslibrary');
writeFileSync(source, 'owned media fixture'); mkdirSync(library);
const sourceHash = () => createHash('sha256').update(readFileSync(source)).digest('hex');
const asset = { id: 'asset-1', name: 'A\tname\n你好', filename: 'Own\nfile.jpg', date: 'Monday, 1 January 2024 at 12:00:00', favorite: true, width: 4032, height: 3024, altitude: 3.5, location: [10.5, -120], keywords: ['comma, inside', '多行\nkeyword'], description: 'Text\nsecond line' };
const isVersion = (script: string) => /^tell application id "com.apple.Photos" to return version$/.test(script);
const isActivation = (script: string) => script.includes('Application activation timed out');
const decodeLiteral = (value: string) => value.replace(/\\([\\"])/g, '$1');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  const requests: MacOsCommand[] = []; let reply: unknown = { id: 'asset-1' }, actionError: Error | undefined, uiError: Error | undefined, exportGate: (() => Promise<void>) | undefined, exportKind = 'valid';
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', applicationAvailable: async () => true, commands: {
    available: async () => true, close: async () => ({ complete: true }), run: async request => {
      requests.push(request); const script = request.args[1] || '';
      if (request.executable === '/usr/bin/open') return '';
      if (request.executable === '/usr/bin/mdfind') return library + '\0';
      if (isVersion(script)) return 'Fixture Photos 11';
      if (isActivation(script)) return 'ok';
      if (script.includes('set p to first application process')) { if (uiError) throw uiError; return 'ok'; }
      if (actionError) throw actionError;
      if (script.includes('export targetItems to POSIX file')) {
        if (exportGate) await exportGate();
        const match = /export targetItems to POSIX file "((?:\\.|[^"\\])*)"/.exec(script); strict.ok(match);
        const path = decodeLiteral(match[1]!); strict.ok(path.includes('.klaus-photos-export-'));
        if (exportKind === 'valid') writeFileSync(join(path, process.platform === 'win32' ? 'Own export.jpg' : 'Own\nexport.jpg'), 'owned exported bytes');
        if (exportKind === 'symlink') symlinkSync(source, join(path, 'foreign.jpg'));
        return '{"exported":1}';
      }
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  } }); service.attachSession('fixture'); cleanups.push(() => service.close());
  const context: MacOsCallContext = { sessionId: 'fixture', turnId: 'turn', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }) };
  const call = async (name: string, args: Row = {}) => JSON.parse((await service.call('macos-photos', 'photos_' + name, args, context)).content[0]!.text);
  return { call, service, requests, context, setReply(value: unknown) { reply = value; }, setActionError(value?: Error) { actionError = value; }, setUiError(value?: Error) { uiError = value; }, setExportGate(value: () => Promise<void>) { exportGate = value; }, setExportKind(value: string) { exportKind = value; } };
}
h.test('twelve services pin 131 tools and Photos declares precise effect and duplicate-checking semantics', async () => {
  strict.equal(createHash('sha256').update(JSON.stringify(MACOS_TOOL_CONTRACTS['macos-photos'])).digest('hex'), 'f94697017212ca5f29238510313392b8c2ef6327d0870e3e83c7e084e70ec78d');
  strict.equal(Object.values(MACOS_TOOL_CONTRACTS).reduce((count, tools) => count + tools.length, 0), 131);
  const f = fixture(); strict.equal((await f.service.capability('macos-photos'))?.tools.length, 38); strict.equal(f.requests.length, 0);
  strict.equal(f.service.tools('macos-photos').find(tool => tool.name === 'photos_run_ui_action')!.annotations.destructiveHint, true);
});
h.test('Photos permission evidence distinguishes library reads, UI capability and a requested window', async () => {
  const f = fixture(); f.setReply({ name: 'Photos', version: '11', mediaCount: 0 }); const result = await f.call('check_permission');
  strict.equal(result.permissions.libraryRead, true); strict.equal(result.permissions.libraryWrite, 'not_checked'); strict.equal(result.permissions.accessibility, 'not_checked');
  f.setActionError(new Error('Automation denied')); const refused = await f.call('check_permission'); strict.equal(refused.ok, false); strict.match(refused.error, /Automation denied/);
  f.setActionError(); const opened = await f.call('request_permission'); strict.equal(opened.requested, true); strict.equal(opened.permissionsConfirmed, false);
});
h.test('asset metadata preserves multiline strings, comma keywords, typed numbers and unknown values without delimiter parsing', async () => {
  const values = photoAssets(JSON.stringify([asset]), 1); strict.equal(values[0]!.name, asset.name); strict.deepEqual(values[0]!.keywords, asset.keywords); strict.equal(values[0]!.location, '10.5,-120'); strict.equal(values[0]!.width, 4032);
  strict.throws(() => photoAssets(JSON.stringify([{ ...asset, favorite: 'false' }]), 1), /invalid asset metadata/);
  strict.throws(() => photoAssets(JSON.stringify([{ ...asset, location: [91, 0] }]), 1), /invalid location/);
  const f = fixture(); f.setReply([asset]); strict.equal((await f.call('get_asset', { assetId: 'asset-1' })).asset.description, asset.description);
  f.setReply([]); await strict.rejects(f.call('get_asset', { assetId: 'missing' }), /selected asset/);
});
h.test('invalid metadata, duplicate ids and a destructive action masquerading as an edit fail before native dispatch', async () => {
  const f = fixture();
  for (const [name, args] of [
    ['update_metadata', { assetId: 'asset-1', location: { latitude: 91, longitude: 0 } }],
    ['update_metadata', { assetId: 'asset-1', date: '2026-02-30' }],
    ['update_metadata', { assetId: 'asset-1', favorite: 'yes' }],
    ['batch_update_metadata', { assetIds: ['same', 'same'], title: 'x' }],
    ['apply_edit', { assetId: 'asset-1', action: 'delete_selected' }],
    ['export_assets', { assetIds: ['asset-1'], destination: 'relative' }],
  ] as Array<[string, Row]>) await strict.rejects(f.call(name, args));
  strict.equal(f.requests.length, 0);
});
h.test('batch metadata resolves all identities first and never repeats an uncertain write', async () => {
  const f = fixture(); f.setReply({ ids: ['a', 'b'] }); strict.equal((await f.call('batch_update_metadata', { assetIds: ['a', 'b'], title: 'A\nB', keywords: ['literal, comma'] })).updated, 2);
  const script = f.requests.at(-1)!.args[1]!;
  strict.ok(script.indexOf('Photos asset id was not found') < script.indexOf('set name of targetItem')); strict.match(script, /Photos text update was not confirmed/);
  const before = f.requests.length; f.setActionError(new Error('Connection ended after write')); await strict.rejects(f.call('update_metadata', { assetId: 'a', title: 'x' }), /after write/);
  const actions = f.requests.slice(before).filter(request => request.executable === '/usr/bin/osascript' && !isVersion(request.args[1]!)); strict.equal(actions.length, 1);
});
h.test('missing count and malformed mutation results are errors rather than zero or successful no-ops', async () => {
  const f = fixture(); f.setReply({ mediaCount: 0, favoriteCount: 0, albumCount: 0 }); await strict.rejects(f.call('get_library_summary'), /folderCount/);
  f.setReply({ updated: 0 }); await strict.rejects(f.call('set_favorite', { assetIds: ['a'], favorite: true }), /did not confirm/);
  f.setReply({ ids: ['different'] }); await strict.rejects(f.call('batch_update_metadata', { assetIds: ['a'], title: 'x' }), /all requested/);
  f.setReply({ id: '' }); await strict.rejects(f.call('create_album', { name: 'Own' }), /must not be empty/);
});
h.test('import duplicate checking uses the native inverse flag and owned media bytes are unchanged', async () => {
  const f = fixture(), original = sourceHash(); f.setReply([{ id: 'new', name: null, filename: 'file.jpg' }]);
  strict.equal((await f.call('import_files', { paths: [source] })).skipDuplicates, true); strict.match(f.requests.at(-1)!.args[1]!, /skip check duplicates false/);
  await f.call('import_files', { paths: [source], skipDuplicates: false }); strict.match(f.requests.at(-1)!.args[1]!, /skip check duplicates true/);
  strict.equal(sourceHash(), original); const before = f.requests.length;
  await strict.rejects(f.call('import_files', { paths: [source, source] }), /duplicate/); strict.equal(f.requests.length, before);
});
h.test('actual bounded folder enumeration preserves unusual filenames, skips directory symlinks and reports truncation', async () => {
  const root = join(directory, 'scan'), nested = join(root, 'nested'); mkdirSync(nested, { recursive: true }); writeFileSync(join(root, process.platform === 'win32' ? 'Own 图片.jpg' : 'Own\n图片.jpg'), 'x'); writeFileSync(join(nested, 'child.mp4'), 'x'); writeFileSync(join(root, 'skip.txt'), 'x');
  if (process.platform !== 'win32') symlinkSync(nested, join(root, 'link'));
  const flat = await collectPhotoFiles(root, false, new AbortController().signal); strict.equal(flat.files.length, 1); if (process.platform !== 'win32') strict.ok(flat.files[0]!.includes('\n'));
  const deep = await collectPhotoFiles(root, true, new AbortController().signal); strict.equal(deep.files.length, 2); strict.equal(deep.skippedSymlinks, process.platform === 'win32' ? 0 : 1);
  const large = join(directory, 'large'); mkdirSync(large); for (let i = 0; i < 201; i++) writeFileSync(join(large, i + '.jpg'), 'x');
  const bounded = await collectPhotoFiles(large, false, new AbortController().signal); strict.equal(bounded.files.length, 200); strict.equal(bounded.truncated, true);
  const canceled = new AbortController(); canceled.abort(); await strict.rejects(collectPhotoFiles(root, true, canceled.signal));
});
h.test('export publishes validated owned files in a unique directory without replacing existing destination content', async () => {
  const destination = join(directory, 'export'); mkdirSync(destination); writeFileSync(join(destination, 'existing.jpg'), 'existing');
  const f = fixture(); f.setReply(['asset-1']); const result = await f.call('export_assets', { assetIds: ['asset-1'], destination });
  strict.equal(result.exported, 1); strict.equal(result.requestedDestination, destination); strict.notEqual(result.destination, destination);
  strict.equal(readFileSync(result.files[0], 'utf8'), 'owned exported bytes'); strict.equal(readFileSync(join(destination, 'existing.jpg'), 'utf8'), 'existing');
  if (process.platform !== 'win32') strict.equal(statSync(result.files[0]).mode & 0o777, 0o600);
  strict.equal(readdirSync(destination).some(name => name.startsWith('.klaus-photos-export-')), false);
});
h.test('failed exports preserve existing files and remove unpublished directories instead of claiming success', async () => {
  const destination = join(directory, 'failed-export'); mkdirSync(destination); writeFileSync(join(destination, 'existing.jpg'), 'existing');
  const f = fixture(); f.setReply(['asset-1']); f.setExportKind('empty'); await strict.rejects(f.call('export_preview', { assetIds: ['asset-1'], destination }), /did not produce/);
  if (process.platform !== 'win32') { f.setExportKind('symlink'); await strict.rejects(f.call('export_preview', { assetIds: ['asset-1'], destination }), /invalid file/); }
  strict.deepEqual(readdirSync(destination), ['existing.jpg']); strict.equal(readFileSync(join(destination, 'existing.jpg'), 'utf8'), 'existing');
});
h.test('owner close waits for an in-flight export and removes its unpublished output after the native request settles', async () => {
  const destination = join(directory, 'canceled-export'), f = fixture(), entered = deferred(), release = deferred();
  f.setReply(['asset-1']); f.setExportGate(async () => { entered.resolve(); await release.promise; });
  const work = f.call('export_assets', { assetIds: ['asset-1'], destination }), rejected = strict.rejects(work); await entered.promise;
  strict.deepEqual(await f.service.close(0), { complete: false }); release.resolve(); await rejected; strict.deepEqual(await f.service.close(), { complete: true }); strict.deepEqual(readdirSync(destination), []);
});
h.test('UI edits check exact Photos selection and use the official clockwise shortcut without asserting an edited result', async () => {
  const f = fixture(); f.setReply({ id: 'asset-1' }); const result = await f.call('apply_edit', { assetId: 'asset-1', action: 'rotate_clockwise' });
  strict.equal(result.requested, true); strict.equal(result.completed, false); const script = f.requests.at(-1)!.args[1]!;
  strict.match(script, /keystroke "r" using \{command down, option down\}/); strict.match(script, /selected Photos asset changed/); strict.match(script, /pending confirmation sheet/);
  f.setUiError(new Error('The Photos selection changed')); const refused = await f.call('apply_edit', { assetId: 'asset-1', action: 'enhance' }); strict.equal(refused.ok, false); strict.equal(refused.requested, null);
});
h.test('destructive batches stop at the first unconfirmed request and leave the remaining ids undispatched', async () => {
  const f = fixture(); f.setReply({ id: 'asset-1' }); const result = await f.call('batch_destructive_action', { action: 'delete_assets', assetIds: ['asset-1', 'asset-2'] });
  strict.equal(result.ok, false); strict.equal(result.attempted, 1); strict.deepEqual(result.remainingIds, ['asset-2']); strict.equal(result.results[0].requested, true);
  strict.equal(f.requests.filter(request => (request.args[1] || '').includes('click chosen_')).length, 1);
  strict.equal(f.requests.some(request => (request.args[1] || '').includes('keystroke (ASCII character 127)')), false);
});
h.test('UI cancellation rejects and drains rather than being converted into a manual-handoff success', async () => {
  const f = fixture(); f.setReply({ id: 'asset-1' }); f.context.assertCurrent = () => { if (f.requests.some(request => (request.args[1] || '').includes('click chosen_'))) throw new Error('The turn changed'); };
  await strict.rejects(f.call('set_hidden', { assetId: 'asset-1', hidden: true }), /turn changed/); strict.deepEqual(await f.service.close(), { complete: true });
});
h.test('iCloud and Recently Deleted handoffs never report account changes or completed recovery', async () => {
  const f = fixture(); f.setUiError(new Error('System Events denied')); const sync = await f.call('prepare_icloud_sync', { openSystemSettings: true });
  strict.equal(sync.canFullyAutomate, false); strict.equal(sync.photosSettingsRequested, false); strict.equal(sync.openedPhotosSettings, null); strict.match(sync.photosSettingsError, /denied/);
  const recovery = await f.call('recover_recently_deleted'); strict.equal(recovery.ok, false); strict.equal(recovery.completed, false); strict.equal(recovery.needsHandoff, true);
});
if (process.platform === 'darwin') h.test('all 38 Photos entrypoints generate native-compilable scripts without executing any user-library operation', async () => {
  const f = fixture(), exportDir = join(directory, 'compile-export'), cases: Array<[string, Row, unknown]> = [
    ['check_permission', {}, { name: 'Photos', version: '11', mediaCount: 0 }], ['request_permission', {}, {}], ['prepare_icloud_sync', {}, {}],
    ['list_libraries', { roots: [directory] }, []], ['open_library', { path: library }, {}], ['get_current_library', {}, { app: 'Photos', version: '11' }],
    ['get_library_summary', {}, { mediaCount: 0, favoriteCount: 0, albumCount: 0, folderCount: 0 }], ['reveal_in_app', { assetId: 'asset-1' }, { id: 'asset-1' }],
    ['list_albums', {}, [{ type: 'folder', id: 'folder-1', name: 'Own', parent: null, count: null }]], ['list_assets', { albumId: 'album-1', favorite: true }, [asset]], ['get_asset', { assetName: 'Own' }, [asset]],
    ['get_selection', {}, [asset]], ['search', { query: 'Own "photo"' }, [asset]], ['export_preview', { assetIds: ['asset-1'], destination: exportDir }, ['asset-1']],
    ['import_files', { paths: [source], albumId: 'album-1' }, [{ id: 'new', name: null, filename: 'Own' }]], ['import_folder', { folder: join(directory, 'scan'), recursive: false }, [{ id: 'new', name: null, filename: 'Own' }]],
    ['export_assets', { assetName: 'Own', destination: exportDir }, ['asset-1']], ['export_album', { albumName: 'Own', destination: exportDir }, ['asset-1']],
    ['create_album', { name: 'Own', parentFolderId: 'parent' }, { id: 'album-new' }], ['create_folder', { name: 'Own', parentFolderName: 'Own' }, { id: 'folder-new' }],
    ['rename_container', { containerId: 'own', containerType: 'album', newName: 'New' }, { id: 'own' }], ['delete_container', { containerName: 'Own' }, { id: 'own' }],
    ['add_assets_to_album', { albumId: 'own', assetName: 'Own' }, { added: 1, albumId: 'own' }], ['remove_assets_from_album', { albumName: 'Own', assetIds: ['asset-1'] }, { id: 'own' }],
    ['move_assets_in_album', { albumName: 'Own', assetIds: ['asset-1'], toIndex: 2 }, { id: 'own' }], ['duplicate_asset', { assetName: 'Own' }, { id: 'new', name: null }],
    ['set_favorite', { assetName: 'Own', favorite: true }, { updated: 1 }], ['set_hidden', { assetId: 'asset-1', hidden: true }, { id: 'asset-1' }],
    ['update_metadata', { assetName: 'Own', title: 'Title\nline', description: 'Text', keywords: ['with,comma'], date: '2026-09-08T12:00:00Z', location: { latitude: 12.5, longitude: -122 }, favorite: true }, { ids: ['asset-1'] }],
    ['batch_update_metadata', { assetIds: ['asset-1'], description: 'Own' }, { ids: ['asset-1'] }], ['apply_edit', { assetId: 'asset-1', action: 'rotate_clockwise' }, { id: 'asset-1' }],
    ['revert_edits', { assetId: 'asset-1' }, { id: 'asset-1' }], ['run_ui_action', { assetId: 'asset-1', action: 'open_edit' }, { id: 'asset-1' }],
    ['prepare_handoff', { query: 'Own' }, 'ok'], ['delete_assets', { assetId: 'asset-1' }, { id: 'asset-1' }], ['recover_recently_deleted', {}, {}], ['permanently_delete_recently_deleted', {}, {}],
    ['batch_destructive_action', { action: 'set_hidden', assetIds: ['asset-1'], hidden: false }, { id: 'asset-1' }],
  ];
  strict.deepEqual(cases.map(row => 'photos_' + row[0]).sort(), MACOS_TOOL_CONTRACTS['macos-photos'].map(tool => tool.name).sort());
  for (const [name, args, reply] of cases) { f.setReply(reply); await f.call(name, args); }
  for (const [index, request] of f.requests.filter(request => request.executable === '/usr/bin/osascript').entries()) {
    const source = request.args[1]!, result = spawnSync('/usr/bin/osacompile', ['-o', join(directory, 'photo-' + index + '.scpt')], { input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error; strict.equal(result.status, 0, result.stderr.trim() + '\n' + source);
  }
}); else h.info('native Photos script compilation', 'Requires macOS; no user library was opened or changed.');
void h.finish(join(directory, 'result.json'), 'macos-photos').then(async code => {
  await Promise.all(cleanups.map(close => close())); rmSync(directory, { recursive: true, force: true }); process.exitCode = code;
}).catch(error => { console.error(error); process.exitCode = 1; });
