import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { WorkspaceStore } from '../main/services/workspaces';
import { PastedTextService, PASTED_TEXT_RESTORE_LIMIT } from '../main/services/pasted-text';
import { Harness, assert, assertEqual, assertRejects } from './harness';

const h = new Harness(), roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-pasted-text-')); roots.push(root);
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  return { root, service: new PastedTextService(workspaces) };
}

h.test('create stores the paste under its own directory and records ledger ownership', async () => {
  const f = await fixture();
  const text = 'line one 😀\nline two\n';
  const created = await f.service.create({ text }) as { ok: boolean; path: string; characterCount: number };
  assertEqual(created.ok, true, 'create succeeds');
  assertEqual(created.characterCount, text.length, 'character count is UTF-16 units');
  assertEqual(basename(created.path), 'pasted-text.txt', 'fixed file name');
  assertEqual(await readFile(created.path, 'utf8'), text, 'exact bytes on disk');
  if (process.platform !== 'win32') assertEqual((await stat(created.path)).mode & 0o777, 0o600, 'private file mode');
  const ledger = JSON.parse(await readFile(join(f.root, 'pasted-text', 'pasted-text-attachments.json'), 'utf8'));
  assert(ledger.attachmentPaths.includes(created.path), 'ledger owns the new attachment');
});

h.test('read returns the stored text and refuses foreign paths', async () => {
  const f = await fixture();
  const created = await f.service.create({ text: 'hello paste' }) as { path: string };
  const read = await f.service.read({ path: created.path }) as { ok: boolean; text: string };
  assertEqual(read.ok, true, 'owned path reads back');
  assertEqual(read.text, 'hello paste', 'exact text');
  await assertRejects(() => f.service.read({ path: join(f.root, 'settings.db') }), 'foreign path is refused');
  await assertRejects(() => f.service.read({ path: join(f.root, 'pasted-text', 'x', '..', '..', 'settings.db') }), 'traversal cannot leave the paste root');
  await assertRejects(() => f.service.read({ path: created.path + '.extra' }), 'suffix cannot select another file');
});

h.test('restore bound refuses texts over the editable limit', async () => {
  const f = await fixture();
  const created = await f.service.create({ text: 'x'.repeat(PASTED_TEXT_RESTORE_LIMIT + 1) }) as { path: string };
  const read = await f.service.read({ path: created.path }) as { ok: boolean; error?: string };
  assertEqual(read.ok, false, 'over-bound read reports a restore failure');
  assertEqual(read.error, 'pasted_text_restore_too_large', 'named restore bound');
});

h.test('supplementary characters share the same UTF-16 restore boundary', async () => {
  const f = await fixture();
  for (const extra of ['', 'x']) {
    const text = '😀'.repeat(PASTED_TEXT_RESTORE_LIMIT / 2) + extra;
    const created = await f.service.create({ text }) as { path: string; characterCount: number };
    assertEqual(created.characterCount, text.length, 'host count agrees with editor offsets');
    const read = await f.service.read({ path: created.path }) as { ok: boolean; text?: string };
    assertEqual(read.ok, extra === '', 'restore limit includes exactly 25000 UTF-16 units');
    if (read.ok) assertEqual(read.text, text, 'accepted restore preserves all surrogate pairs');
  }
});

h.test('draft removal deletes owned files and preserves released durable references', async () => {
  const f = await fixture();
  const created = await f.service.create({ text: 'drop me' }) as { path: string };
  const kept = await f.service.create({ text: 'keep me' }) as { path: string };
  await f.service.release([kept.path]);
  await f.service.remove({ path: kept.path });
  await f.service.remove({ path: created.path });
  const entries = await readdir(join(f.root, 'pasted-text'));
  assert(!entries.includes(basename(join(created.path, '..'))), 'removed directory is gone');
  assert(entries.includes(basename(join(kept.path, '..'))), 'released file survives for the sent message');
  const ledger = JSON.parse(await readFile(join(f.root, 'pasted-text', 'pasted-text-attachments.json'), 'utf8'));
  assert(!ledger.attachmentPaths.includes(created.path), 'ledger drops the removed path');
  assert(!ledger.attachmentPaths.includes(kept.path), 'release drops ledger ownership');
  const reopened = new PastedTextService(new WorkspaceStore({ configRoot: f.root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null }));
  await reopened.remove({ path: kept.path });
  assertEqual(await readFile(kept.path, 'utf8'), 'keep me', 'removing a borrowed card after restart preserves the exact durable file');
});

h.test('sweep finishes deletions a previous run left pending', async () => {
  const f = await fixture();
  const created = await f.service.create({ text: 'pending drop' }) as { path: string };
  const ledgerPath = join(f.root, 'pasted-text', 'pasted-text-attachments.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.pendingRemovalPaths = [created.path];
  ledger.attachmentPaths = [];
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const fresh = new PastedTextService(new WorkspaceStore({ configRoot: f.root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null }));
  await fresh.sweep();
  const entries = await readdir(join(f.root, 'pasted-text'));
  assert(!entries.includes(basename(join(created.path, '..'))), 'pending removal finishes on startup');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'pasted-text-result.json'), 'pasted-text');
  for (const root of roots) await rm(root, { recursive: true, force: true });
  process.exit(failed);
})();
