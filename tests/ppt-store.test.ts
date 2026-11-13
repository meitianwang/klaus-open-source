import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { PptStore, PptStoreError } from '../main/ppt/store';
import { Harness } from './harness';

const h = new Harness();
const logs = resolve(__dirname, '../dist/ppt-store-logs');
mkdirSync(logs, { recursive: true });
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const bytes = (value: string) => Buffer.from(value);
const owner = 'store-fixture';
function fixture(run: (store: PptStore, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'klaus-ppt-store-'));
  try { run(new PptStore(root), root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function storage(root: string, id: string): string { return join(root, 'ppt', hash(owner), id); }
function rejects(code: string, run: () => unknown): void { assert.throws(run, error => error instanceof PptStoreError && error.code === code); }
const firstPath = 'project/slides/slide-a.html';
const firstHtml = '<section id="slide-a"><h1>First title</h1><aside>Notes.</aside></section>';

h.test('native documents persist with strict chat ownership', () => fixture((store, root) => {
  const doc = store.open(owner, 'Presentation');
  assert.equal(doc.version, 'v1'); assert.equal(doc.seq, 1); assert.equal(doc.owner, owner);
  assert.deepEqual(store.files(owner, doc.id), []);
  assert.deepEqual(new PptStore(root).get(owner, doc.id), doc);
  assert.deepEqual(store.list(owner), [doc]); assert.deepEqual(store.list('another-chat'), []);
  rejects('not_found', () => store.get('another-chat', doc.id));
  rejects('invalid_argument', () => store.open('', 'No owner'));
  rejects('invalid_argument', () => store.get(owner, '../outside'));
}));

h.test('atomic publish preserves exact bytes and immutable historical revisions', () => fixture((store, root) => {
  const doc = store.open(owner, 'Presentation');
  const binary = Buffer.from([0, 255, 128, 10, 1, 2, 0]);
  const saved = store.publish(owner, doc.id, { baseVersion: 'v1', writes: [{ path: firstPath, bytes: bytes(firstHtml) }, { path: 'project/image.png', bytes: binary }] });
  assert.equal(saved.version, 'v2'); assert.equal(saved.seq, 2); assert.equal(saved.shas[firstPath], hash(firstHtml));
  assert.deepEqual(Buffer.from(store.read(owner, doc.id, 'project/image.png')), binary);
  const changed = store.publish(owner, doc.id, { baseVersion: 'v2', writes: [{ path: firstPath, bytes: bytes('Updated text'), contentType: 'text/plain' }], remove: ['project/image.png'] });
  assert.equal(changed.version, 'v3');
  assert.equal(Buffer.from(store.read(owner, doc.id, firstPath, 'v2')).toString(), firstHtml);
  assert.deepEqual(Buffer.from(new PptStore(root).read(owner, doc.id, 'project/image.png', 'v2')), binary);
  rejects('not_found', () => store.read(owner, doc.id, 'project/image.png'));
  rejects('not_found', () => store.files(owner, doc.id, 'v9'));
  assert.deepEqual(store.files(owner, doc.id, 'v1'), []);
}));

h.test('stale version and file preconditions reject every change atomically', () => fixture((store, root) => {
  const doc = store.open(owner, 'Presentation');
  store.publish(owner, doc.id, { baseVersion: doc.version, writes: [{ path: firstPath, bytes: bytes(firstHtml) }] });
  const before = readFileSync(join(storage(root, doc.id), 'document.json'));
  const blobNames = readdirSync(join(storage(root, doc.id), 'blobs'));
  let conflict: PptStoreError | undefined;
  try { store.publish(owner, doc.id, { baseVersion: 'v1', writes: [{ path: 'project/new.txt', bytes: bytes('must not appear') }], remove: [firstPath] }); }
  catch (error) { conflict = error as PptStoreError; }
  assert.equal(conflict?.code, 'conflict'); assert.equal(conflict?.live, 'v2');
  rejects('conflict', () => store.publish(owner, doc.id, { writes: [{ path: 'project/new.txt', bytes: bytes('must not appear') }], remove: [firstPath], ifMatch: { [firstPath]: '0'.repeat(64), 'project/new.txt': null } }));
  assert.deepEqual(readFileSync(join(storage(root, doc.id), 'document.json')), before);
  assert.deepEqual(readdirSync(join(storage(root, doc.id), 'blobs')), blobNames);
  assert.equal(Buffer.from(store.read(owner, doc.id, firstPath)).toString(), firstHtml);
  assert.equal(store.files(owner, doc.id).length, 1);
  const ok = store.publish(owner, doc.id, { writes: [{ path: 'project/new.txt', bytes: bytes('created') }], ifMatch: { 'project/new.txt': null } });
  assert.equal(ok.version, 'v3');
}));

h.test('separate store instances observe preconditions and no-op saves retain revisions', () => fixture((store, root) => {
  const doc = store.open(owner, 'Presentation'), other = new PptStore(root);
  store.publish(owner, doc.id, { baseVersion: doc.version, writes: [{ path: firstPath, bytes: bytes(firstHtml) }] });
  rejects('conflict', () => other.publish(owner, doc.id, { baseVersion: doc.version, writes: [{ path: 'project/stale.txt', bytes: bytes('stale') }] }));
  const before = store.get(owner, doc.id);
  const result = other.publish(owner, doc.id, { baseVersion: 'v2', writes: [{ path: firstPath, bytes: bytes(firstHtml) }], remove: ['project/missing.txt'] });
  assert.equal(result.unchanged, true); assert.equal(result.version, 'v2'); assert.deepEqual(result.changed, []);
  assert.deepEqual(store.get(owner, doc.id), before);
}));

h.test('content and runtime paths reject traversal, duplicate changes and invalid encodings', () => fixture(store => {
  const doc = store.open(owner, 'Presentation');
  for (const path of ['../escape', '/absolute', 'project//file', 'project/./file', 'project/../file', 'project\\escape', 'project/a%2fb', 'project/a:b', 'project/a\0b', 'file.cmekshadow']) rejects('invalid_argument', () => store.publish(owner, doc.id, { writes: [{ path, bytes: bytes('x') }] }));
  for (const path of ['index.html', 'INDEX.HTML', 'artifact-type/app.js', '_runtime/a.js', 'SKILL.md']) rejects('read_only_path', () => store.publish(owner, doc.id, { writes: [{ path, bytes: bytes('x') }] }));
  rejects('invalid_argument', () => store.publish(owner, doc.id, { writes: [{ path: firstPath, bytes: bytes('x') }, { path: firstPath, bytes: bytes('y') }] }));
  rejects('invalid_argument', () => store.publish(owner, doc.id, { writes: [{ path: firstPath, bytes: bytes('x') }], remove: [firstPath] }));
  rejects('invalid_argument', () => store.publish(owner, doc.id, { writes: [{ path: 'project/bad.txt', bytes: Buffer.from([255, 254]) }] }));
  rejects('invalid_argument', () => store.publish(owner, doc.id, { writes: [{ path: 'project/good.txt', bytes: bytes('x') }], ifMatch: { 'project/unrelated.txt': null } }));
  assert.equal(store.get(owner, doc.id).version, 'v1');
}));

h.test('file count and per-file byte limits reject before publishing', () => fixture(store => {
  const doc = store.open(owner, 'Presentation');
  rejects('invalid_argument', () => store.publish(owner, doc.id, { writes: Array.from({ length: 257 }, (_, index) => ({ path: `project/${index}.txt`, bytes: bytes('') })) }));
  rejects('too_large', () => store.publish(owner, doc.id, { writes: [{ path: 'project/large.txt', bytes: Buffer.alloc(16 * 1024 * 1024 + 1, 65) }] }));
  rejects('too_large', () => store.publish(owner, doc.id, { writes: [{ path: 'project/large.bin', bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }] }));
  assert.equal(store.get(owner, doc.id).version, 'v1'); assert.deepEqual(store.files(owner, doc.id), []);
}));

h.test('symlinked directories, blobs and metadata cannot redirect document reads or writes', () => fixture((store, root) => {
  const doc = store.open(owner, 'Presentation');
  const saved = store.publish(owner, doc.id, { writes: [{ path: firstPath, bytes: bytes(firstHtml) }] });
  const outside = join(root, 'outside'); mkdirSync(outside); const target = join(outside, 'content'); writeFileSync(target, 'untouched');
  const blob = join(storage(root, doc.id), 'blobs', saved.shas[firstPath]!); rmSync(blob); symlinkSync(target, blob);
  rejects('corrupt', () => store.read(owner, doc.id, firstPath));
  rejects('corrupt', () => store.publish(owner, doc.id, { writes: [{ path: 'project/copy.html', bytes: bytes(firstHtml) }] }));
  assert.equal(readFileSync(target, 'utf8'), 'untouched'); assert.equal(store.get(owner, doc.id).version, 'v2');
  const pointer = join(storage(root, doc.id), 'document.json'); rmSync(pointer); symlinkSync(target, pointer);
  rejects('corrupt', () => store.get(owner, doc.id));
  const otherOwner = join(root, 'ppt', hash('linked-owner')); symlinkSync(outside, otherOwner, 'dir');
  rejects('forbidden', () => store.open('linked-owner', 'Redirected'));
}));

h.test('damaged immutable revisions and content hashes are reported rather than hidden', () => fixture((store, root) => {
  const doc = store.open(owner, 'Presentation');
  store.publish(owner, doc.id, { writes: [{ path: firstPath, bytes: bytes(firstHtml) }] });
  const pointer = JSON.parse(readFileSync(join(storage(root, doc.id), 'document.json'), 'utf8'));
  writeFileSync(join(storage(root, doc.id), 'revisions', pointer.revisions.v2 + '.json'), '{}');
  rejects('corrupt', () => store.files(owner, doc.id));
  assert.deepEqual(store.files(owner, doc.id, 'v1'), []);
}));

h.test('binary assets persist independently from slide revision changes', () => fixture((store, root) => {
  const doc = store.open(owner, 'Presentation'), binary = Buffer.from([0, 255, 255, 128, 3, 0]);
  const uploaded = store.putAsset(owner, doc.id, binary, 'image/png', 'Image fixture.png');
  assert.match(uploaded.id, /^[a-f0-9]{32}$/); assert.equal(uploaded.url, `/_blob/${uploaded.id}`); assert.equal(uploaded.sizeBytes, binary.length);
  assert.deepEqual(Buffer.from(new PptStore(root).asset(owner, doc.id, uploaded.id).bytes), binary);
  assert.equal(store.asset(owner, doc.id, uploaded.id).type, 'image/png'); assert.equal(store.get(owner, doc.id).version, doc.version);
  const listed = store.assets(owner, doc.id); assert.equal(listed.length, 1); assert.equal(listed[0]!.url, `/_blob/${uploaded.id}`); assert.equal(listed[0]!.name, 'Image fixture.png'); assert.equal(listed[0]!.sha256, hash(binary)); assert.equal(typeof listed[0]!.createdAt, 'number');
  store.deleteAsset(owner, doc.id, uploaded.id); store.deleteAsset(owner, doc.id, uploaded.id);
  assert.deepEqual(store.assets(owner, doc.id), []);
  assert.deepEqual(Buffer.from(new PptStore(root).asset(owner, doc.id, uploaded.id).bytes), binary);
  rejects('invalid_argument', () => store.asset(owner, doc.id, '../asset'));
  rejects('not_found', () => store.asset(owner, doc.id, '0'.repeat(32)));
  rejects('not_found', () => store.asset('another-chat', doc.id, uploaded.id));
  store.retitle(owner, doc.id, 'Renamed presentation'); assert.equal(store.get(owner, doc.id).title, 'Renamed presentation');
  assert.equal(store.get(owner, doc.id).version, doc.version);
}));

h.test('validation records describe exact saved hashes without creating a revision', () => fixture((store, root) => {
  const doc = store.open(owner, 'Validation'), saved = store.publish(owner, doc.id, { writes: [{ path: firstPath, bytes: bytes(firstHtml) }] });
  store.recordValidation(owner, doc.id, { version: saved.version, shas: { [firstPath]: saved.shas[firstPath]! }, errors: [], warnings: [{ path: firstPath, line: 2, col: 3, message: 'note' }], contentHash: 'content-hash', slides: [{ id: 'slide-a' }], at: new Date().toISOString() });
  const record = store.validation(owner, doc.id);
  assert.equal(record?.version, 'v2'); assert.equal(record?.shas[firstPath], saved.shas[firstPath]); assert.equal(record?.contentHash, 'content-hash'); assert.equal(record?.warnings[0]!.line, 2);
  assert.equal(store.get(owner, doc.id).version, 'v2');
  const path = join(storage(root, doc.id), 'validation.json'); writeFileSync(path, '{not json');
  assert.equal(store.validation(owner, doc.id), undefined);
  assert.equal(store.get(owner, doc.id).version, 'v2');
}));

h.test('live write locks reject concurrent writers and stale locks can recover', () => fixture((store, root) => {
  const doc = store.open(owner, 'Presentation'), lock = join(storage(root, doc.id), 'write.lock');
  const record = JSON.stringify({ pid: process.pid, token: randomUUID() }); writeFileSync(lock, record);
  rejects('busy', () => store.publish(owner, doc.id, { writes: [{ path: firstPath, bytes: bytes(firstHtml) }] }));
  assert.equal(readFileSync(lock, 'utf8'), record); rmSync(lock);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  writeFileSync(lock, JSON.stringify({ pid: Number(child.stdout), token: randomUUID() }));
  assert.equal(store.publish(owner, doc.id, { writes: [{ path: firstPath, bytes: bytes(firstHtml) }] }).version, 'v2');
  assert.equal(existsSync(lock), false);
}));

function legacy(root: string, bad = false): { id: string; path: string; binary: Buffer; artifact: string } {
  const id = randomUUID(), path = storage(root, id); mkdirSync(join(path, 'blobs'), { recursive: true }); mkdirSync(join(path, 'uploads'));
  const sha = hash(firstHtml), binary = Buffer.from([255, 0, 128, 9]), assetSha = hash(binary), assetId = 'a'.repeat(32);
  writeFileSync(join(path, 'blobs', sha), bad ? 'corrupted' : firstHtml); writeFileSync(join(path, 'uploads', assetSha), binary);
  const artifact = JSON.stringify({ format: 1, versions: [{ ver: 'v1', createdAt: '2026-10-28T01:00:00Z', entry: 'page', files: [] }, { ver: 'v2', createdAt: '2026-10-28T02:00:00Z', entry: 'publish', files: [[firstPath, sha]] }] });
  writeFileSync(join(path, 'artifact.json'), artifact); writeFileSync(join(path, 'desktop.json'), JSON.stringify({ format: 1, type: 'slides', title: 'Existing presentation' }));
  writeFileSync(join(path, 'uploads.json'), JSON.stringify({ format: 1, uploads: [[assetId, { sha256: assetSha, size: binary.length, name: 'Legacy image.png', type: 'image/png', createdAt: 0, by: 'fixture' }]] }));
  return { id, path, binary, artifact };
}
h.test('one-time migration preserves old file bytes, uploads, titles and available history', () => fixture((store, root) => {
  const old = legacy(root), doc = store.get(owner, old.id);
  assert.equal(doc.title, 'Existing presentation'); assert.equal(doc.version, 'v2'); assert.equal(doc.createdAt, '2026-10-28T01:00:00Z');
  assert.deepEqual(store.files(owner, old.id, 'v1'), []); assert.equal(Buffer.from(store.read(owner, old.id, firstPath, 'v2')).toString(), firstHtml);
  assert.deepEqual(Buffer.from(store.asset(owner, old.id, 'a'.repeat(32)).bytes), old.binary);
  assert.equal(store.assets(owner, old.id)[0]!.createdAt, 0);
  assert.equal(readFileSync(join(old.path, 'artifact.json'), 'utf8'), old.artifact); assert.equal(existsSync(join(old.path, 'uploads.json')), true);
  assert.equal(new PptStore(root).publish(owner, old.id, { baseVersion: 'v2', writes: [{ path: firstPath, bytes: bytes('Native update') }] }).version, 'v3');
  assert.equal(Buffer.from(store.read(owner, old.id, firstPath, 'v2')).toString(), firstHtml);
}));

h.test('failed legacy migration leaves the old record and visible pointer untouched', () => fixture((store, root) => {
  const old = legacy(root, true);
  rejects('corrupt', () => store.get(owner, old.id));
  assert.equal(existsSync(join(old.path, 'document.json')), false); assert.equal(readFileSync(join(old.path, 'artifact.json'), 'utf8'), old.artifact);
  assert.equal(existsSync(join(old.path, 'write.lock')), false);
}));

h.test('asset quotas preserve 1000 active files and one GiB while deleted references stay readable', () => fixture((store, root) => {
  const doc = store.open(owner, 'Assets'), initial = store.putAsset(owner, doc.id, bytes('x'), 'image/png', 'Image');
  const path = storage(root, doc.id), manifestPath = join(path, 'document.json');
  const state = JSON.parse(readFileSync(manifestPath, 'utf8')), entry = state.assets[initial.id];
  state.assets = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [(index + 1).toString(16).padStart(32, '0'), { ...entry }]));
  writeFileSync(manifestPath, JSON.stringify(state));
  rejects('too_large', () => store.putAsset(owner, doc.id, bytes('y'), 'image/png', 'Over count'));
  store.deleteAsset(owner, doc.id, '1'.padStart(32, '0'));
  store.putAsset(owner, doc.id, bytes('y'), 'image/png', 'Available slot');
  assert.equal(store.assets(owner, doc.id).length, 1000);
  const large = Buffer.alloc(20 * 1024 * 1024), sha = hash(large);
  writeFileSync(join(path, 'blobs', sha), large);
  state.assets = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [(index + 1).toString(16).padStart(32, '0'), { ...entry, sha256: sha, size: large.length }]));
  writeFileSync(manifestPath, JSON.stringify(state));
  rejects('too_large', () => store.putAsset(owner, doc.id, Buffer.alloc(5 * 1024 * 1024), 'image/png', 'Over bytes'));
  store.putAsset(owner, doc.id, Buffer.alloc(4 * 1024 * 1024), 'image/png', 'Exact capacity');
  store.deleteAsset(owner, doc.id, '1'.padStart(32, '0'));
  assert.equal(store.asset(owner, doc.id, '1'.padStart(32, '0')).bytes.length, large.length);
  store.putAsset(owner, doc.id, large, 'image/png', 'Released capacity');
  assert.equal(store.assets(owner, doc.id).reduce((sum, asset) => sum + asset.sizeBytes, 0), 1024 * 1024 * 1024);
}));

void h.finish(join(logs, 'result.json'), 'ppt-store').then(code => { process.exitCode = code; });
