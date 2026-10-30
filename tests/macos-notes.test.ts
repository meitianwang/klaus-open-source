import strict from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { MacOsConnectors } from '../main/services/macos-connectors/service';
import { MACOS_TOOL_CONTRACTS } from '../main/services/macos-connectors/tool-contracts';
import { noteBody, notesHtml } from '../main/services/macos-connectors/notes';
import type { MacOsCommand, MacOsCommands } from '../main/native/macos-command';
import type { MacOsCallContext, Row } from '../main/services/macos-connectors/types';

const h = new Harness(), directory = mkdtempSync(join(tmpdir(), 'klaus-macos-notes-'));
const cleanups: Array<() => Promise<unknown>> = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const action = (request: MacOsCommand) => request.executable === '/usr/bin/osascript' && !(request.args[1] ?? '').endsWith('to return version');
const exportPath = (request: MacOsCommand): string => {
  const value = /save item 1 of hits_ in \(POSIX file "([^"\n]+)"\)/.exec(request.args[1]!);
  if (!value) throw new Error('Missing exact fixture export destination'); return value[1]!;
};
function fixture(run?: MacOsCommands['run']) {
  let reply = 'ok'; const requests: MacOsCommand[] = [];
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', applicationAvailable: async () => true, commands: {
    available: async () => true, close: async () => ({ complete: true }), run: async (request, signal) => {
      requests.push(request); if (!action(request)) return request.executable === '/usr/bin/open' ? '' : '1.0';
      return run ? run(request, signal) : reply;
    },
  } });
  service.attachSession('notes'); cleanups.push(() => service.close());
  const context: MacOsCallContext = { sessionId: 'notes', turnId: 'turn', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }) };
  const call = async (tool: string, args: Row = {}) => (await service.call('macos-notes', tool, args, context)).content[0]!.text;
  return { call, service, requests, setReply(value: string) { reply = value; } };
}
const cases: Array<{ tool: string; args: Row; reply: string }> = [
  { tool: 'list_notes', args: { folderName: 'Own\nFolder' }, reply: '[]' },
  { tool: 'search_notes', args: { query: 'Own "query"' }, reply: '[]' },
  { tool: 'read_note', args: { name: 'Own Note', folderName: 'Own' }, reply: '["Title\\nText"]' },
  { tool: 'create_note', args: { title: 'Own <Title>', body: '<x> & literal\nline', folderName: 'Own' }, reply: 'ok' },
  { tool: 'update_note', args: { title: 'Own', folderName: 'Old', newTitle: 'New', newBody: 'Content\nline', newFolder: 'New Folder' }, reply: 'ok' },
  { tool: 'delete_note', args: { title: 'Own', folderName: 'Own' }, reply: 'ok' },
  { tool: 'append_to_note', args: { title: 'Own', content: '<literal> & text', folderName: 'Own' }, reply: 'ok' },
  { tool: 'list_folders', args: {}, reply: '[]' },
  { tool: 'create_folder', args: { name: 'Own', accountName: 'Owned account' }, reply: 'ok' },
  { tool: 'rename_folder', args: { oldName: 'Own', newName: 'New' }, reply: 'ok' },
  { tool: 'delete_folder', args: { name: 'Own' }, reply: 'ok' },
  { tool: 'list_attachments', args: { noteTitle: 'Own', folderName: 'Own' }, reply: '[]' },
  { tool: 'save_attachment', args: { noteTitle: 'Own', attachmentName: 'attachment.txt', savePath: join(directory, 'compile-export.txt'), folderName: 'Own' }, reply: 'ok' },
];
h.test('all thirteen Notes tools retain effect hints with truthful account-dependent deletion descriptions', async () => {
  strict.equal(createHash('sha256').update(JSON.stringify(MACOS_TOOL_CONTRACTS['macos-notes'])).digest('hex'), 'b12f119acc7a23ec69fe3405f8e4316a96b61347ff482141066459382a2fa2ec');
  const { service } = fixture(); strict.equal((await service.capability('macos-notes'))?.tools.length, 13);
  strict.equal(service.tools('macos-notes').find(row => row.name === 'delete_note')!.annotations.destructiveHint, true);
});
h.test('Notes markup escapes text exactly once and preserves lines and literal entities', () => {
  strict.equal(notesHtml('<x> & "quoted" \'a\''), '&lt;x&gt; &amp; &quot;quoted&quot; &#39;a&#39;');
  strict.equal(noteBody('<Title>', 'one &lt;literal&gt;\r\ntwo\n'), '<h1>&lt;Title&gt;</h1><div>one &amp;lt;literal&amp;gt;</div><div>two</div><div></div>');
});
h.test('native plaintext preserves whitespace and an empty note is distinct from a missing note', async () => {
  const { call, setReply, requests } = fixture();
  setReply('["  Title\\nLine 1\\n\\nLine 3  "]'); strict.equal(await call('read_note', { name: 'Own' }), '  Title\nLine 1\n\nLine 3  ');
  strict.match(requests.at(-1)!.args[1]!, /plaintext of n as text/);
  setReply('[""]'); strict.equal(await call('read_note', { name: 'Own' }), '');
  setReply('note_not_found'); await strict.rejects(call('read_note', { name: 'Own' }), /Note not found/);
});
h.test('JSON list results preserve multiline names, snippets and nested folder paths', async () => {
  const { call, setReply } = fixture();
  const record = { folder: 'Own,\nFolder', name: 'Title\tline', modified: 'date' }; setReply(JSON.stringify([record]));
  strict.deepEqual(JSON.parse(await call('list_notes')), { count: 1, notes: [record] });
  const folders = [{ account: 'Account', name: 'Nested\nFolder', path: ['Outer', 'Nested\nFolder'] }]; setReply(JSON.stringify(folders));
  strict.deepEqual(JSON.parse(await call('list_folders')), { count: 1, folders });
  setReply('[{"account":"Account","name":"X","path":"wrong"}]'); await strict.rejects(call('list_folders'), /invalid folder path/);
  setReply('[{"folder":"X"}]'); await strict.rejects(call('list_notes'), /invalid record/);
});
h.test('renaming and replacing a note use the new heading while destination lookup precedes writes', async () => {
  const { call, requests } = fixture();
  await call('update_note', { title: 'Old', newTitle: '<New>', newBody: 'one & two', newFolder: 'Destination' });
  const script = requests.at(-1)!.args[1]!;
  strict.match(script, /<h1>&lt;New&gt;<\/h1><div>one &amp; two<\/div>/);
  strict.ok(script.indexOf('get id of destination_') < script.indexOf('set name of n to'));
  strict.ok(script.indexOf('set body of n to') < script.indexOf('move n to destination_'));
});
h.test('invalid writes fail before starting Notes', async () => {
  const { call, requests } = fixture();
  await strict.rejects(call('create_note', { title: 'Own' }), /body/);
  await strict.rejects(call('update_note', { title: 'Own' }), /at least/);
  await strict.rejects(call('update_note', { title: 'Own', newFolder: '' }), /destination/);
  await strict.rejects(call('save_attachment', { noteTitle: 'Own', attachmentName: 'Own', savePath: 'relative' }), /absolute/);
  strict.equal(requests.length, 0);
});
h.test('missing records and unconfirmed writes return explicit failures', async () => {
  const { call, setReply } = fixture(); setReply('note_not_found');
  await strict.rejects(call('delete_note', { title: 'Own' }), /not found/);
  await strict.rejects(call('append_to_note', { title: 'Own', content: 'Own' }), /not found/);
  setReply('folder_not_found'); await strict.rejects(call('delete_folder', { name: 'Own' }), /Folder not found/);
  setReply(''); await strict.rejects(call('create_note', { title: 'Own', body: '' }), /did not confirm/);
});
h.test('a failed Notes write is not replayed after an application error', async () => {
  let writes = 0; const { call } = fixture(async () => { writes++; throw new Error('(-600) after a possible write'); });
  await strict.rejects(call('create_note', { title: 'Own', body: 'Own' }), /possible write/); strict.equal(writes, 1);
});
h.test('attachment export validates a real private file before replacing the requested output', async () => {
  const destination = join(directory, 'export.txt'); writeFileSync(destination, 'old');
  const { call } = fixture(async request => { const pending = exportPath(request); strict.equal(statSync(join(pending, '..')).mode & 0o777, 0o700); writeFileSync(pending, 'own attachment'); return 'ok'; });
  strict.equal(await call('save_attachment', { noteTitle: 'Own', attachmentName: 'Owned', savePath: destination }), `Saved attachment "Owned" → ${destination}`);
  strict.equal(readFileSync(destination, 'utf8'), 'own attachment'); strict.equal(statSync(destination).mode & 0o777, 0o600);
  strict.equal(readdirSync(directory).some(name => name.startsWith('.klaus-note-attachment-')), false);
});
h.test('missing exports and symlink output preserve the existing destination and remove temporary files', async () => {
  const destination = join(directory, 'preserved.txt'); writeFileSync(destination, 'preserved');
  const absent = fixture(); await strict.rejects(absent.call('save_attachment', { noteTitle: 'Own', attachmentName: 'Own', savePath: destination }), /ENOENT/);
  const invalid = fixture(async request => { symlinkSync(destination, exportPath(request)); return 'ok'; });
  await strict.rejects(invalid.call('save_attachment', { noteTitle: 'Own', attachmentName: 'Own', savePath: destination }), /bounded regular/);
  strict.equal(readFileSync(destination, 'utf8'), 'preserved'); strict.equal(readdirSync(directory).some(name => name.startsWith('.klaus-note-attachment-')), false);
});
h.test('owner close waits for late export completion and removes its unpublished file', async () => {
  const entered = deferred(), gate = deferred(), destination = join(directory, 'cancelled.txt'); writeFileSync(destination, 'preserved');
  const { service, call } = fixture(async request => { entered.resolve(); await gate.promise; writeFileSync(exportPath(request), 'late'); return 'ok'; });
  const pending = call('save_attachment', { noteTitle: 'Own', attachmentName: 'Own', savePath: destination }), rejected = strict.rejects(pending);
  await entered.promise; strict.deepEqual(await service.close(0), { complete: false }); gate.resolve(); await rejected;
  strict.deepEqual(await service.close(), { complete: true }); strict.equal(readFileSync(destination, 'utf8'), 'preserved');
  strict.equal(readdirSync(directory).some(name => name.startsWith('.klaus-note-attachment-')), false);
});
if (process.platform === 'darwin') h.test('every Notes action compiles against the installed native dictionary without accessing notes', async () => {
  let reply = 'ok';
  const { call, requests } = fixture(async request => {
    if (request.args[1]!.includes('save item 1 of hits_')) { writeFileSync(exportPath(request), 'own compilation fixture'); return 'ok'; }
    return reply;
  });
  for (const item of cases) { reply = item.reply; await call(item.tool, item.args); }
  for (const [index, request] of requests.filter(action).entries()) {
    const result = spawnSync('/usr/bin/osacompile', ['-o', join(directory, 'notes-' + index + '.scpt')], { input: request.args[1], encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error; strict.equal(result.status, 0, result.stderr.trim() + '\n' + request.args[1]);
  }
});
else h.info('native Notes script compilation', 'Requires macOS; no user notes were accessed.');
void h.finish(join(directory, 'result.json'), 'macos-notes').then(async code => {
  await Promise.all(cleanups.map(close => close())); rmSync(directory, { recursive: true, force: true }); process.exitCode = code;
}).catch(error => { console.error(error); process.exitCode = 1; });
