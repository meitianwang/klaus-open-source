import { mkdtemp, readFile, writeFile, readdir, stat, open, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { WorkspaceStore } from '../main/services/workspaces';
import { AttachmentService, buildMessageInput, uploadLimit, IMAGE_UPLOAD_LIMIT, FILE_UPLOAD_LIMIT } from '../main/services/attachments';
import { decodeBinary } from '../main/ipc/binary';
import { object } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects } from './harness';

const h = new Harness(), roots: string[] = [];
const vector = JSON.parse(readFileSync(join(__dirname, '../../tests/vectors/attachments.json'), 'utf8'));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-attachments-')); roots.push(root);
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  return { root, workspaces, attachments: new AttachmentService(workspaces) };
}
h.test('uploads retain committed limits, exact bytes and textual line counts', async () => {
  const f = await fixture();
  try {
    for (const row of vector.uploadLimits) assertEqual(uploadLimit(row.name, row.mime), row.bytes, 'committed upload ceiling');
    for (const row of vector.textLines) {
      const result = object(await f.attachments.upload({ name: 'notes.md', buffer: { __klausBinary: Buffer.from(row.text).toString('base64') } }));
      assertEqual(result.ok, undefined, 'upload uses bare success fields');
      assertEqual(result.lineCount, row.lines, 'committed line count');
      assertEqual((await readFile(String(result.path))).toString(), row.text, 'exact cached bytes');
      if (process.platform !== 'win32') assertEqual((await stat(String(result.path))).mode & 0o777, 0o600, 'private cache mode');
    }
    const source = join(f.root, 'source.txt'); await writeFile(source, '路径 fixture\n');
    const copied = object(await f.attachments.uploadPath({ path: source }));
    assertEqual(copied.ok, true, 'path uploads use ok field'); assertEqual(copied.lineCount, 1, 'path line count');
    assert((await readFile(String(copied.path))).equals(await readFile(source)), 'streamed copy matches source');
    for (const name of ['path.ext/escape', 'path.ext\\escape', 'path.:stream', 'trailing.']) {
      const result = object(await f.attachments.upload({ name, buffer: [1, 2, 3] }));
      assertEqual(join(f.root, 'uploads', basename(String(result.path))), result.path, 'filename cannot select a parent or stream');
      assert(!basename(String(result.path)).includes(':'), 'no Windows alternate stream');
    }
  } finally { await f.attachments.close(); }
});
h.test('large canonical uploads do not overflow the decoder stack and invalid payloads publish nothing', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(IMAGE_UPLOAD_LIMIT, 0x41), encoded = bytes.toString('base64');
    assertEqual(decodeBinary(encoded, IMAGE_UPLOAD_LIMIT)?.length, IMAGE_UPLOAD_LIMIT, 'full-size base64 is accepted');
    const saved = object(await f.attachments.upload({ name: 'image.png', type: 'image/png', buffer: encoded }));
    assert((await readFile(String(saved.path))).equals(bytes), 'full-size write finishes exactly');
    const before = await readdir(join(f.root, 'uploads'));
    for (const buffer of ['a Gk=', 'aG==', [0, 256], {}, Buffer.alloc(IMAGE_UPLOAD_LIMIT + 1).toString('base64')]) {
      await assertRejects(async () => f.attachments.upload({ name: 'bad.png', buffer }), 'invalid or oversized upload');
    }
    const path = join(f.root, 'huge.pdf'), source = await open(path, 'w'); await source.truncate(FILE_UPLOAD_LIMIT + 1); await source.close();
    assertEqual(object(await f.attachments.uploadPath({ path })).error, 'file_too_large', 'oversized source refused');
    assertEqual(object(await f.attachments.uploadPath({ path: f.root })).ok, false, 'directory refused');
    assertDeepEqual(await readdir(join(f.root, 'uploads')), before, 'no partially written or temporary files remain');
  } finally { await f.attachments.close(); }
});
h.test('inline image and document inputs match fixed wire vectors and reject partial sends', async () => {
  const f = await fixture(), image = join(f.root, 'picture.png'), pdf = join(f.root, 'report.pdf');
  try {
    await writeFile(image, Buffer.from('iVBORw0KGgo=', 'base64')); await writeFile(pdf, '%PDF-1.4\n');
    assertDeepEqual(await buildMessageInput('Read both', [{ path: image, name: 'picture.png' }, { path: pdf, name: 'report.pdf' }]), vector.input, 'engine content parts');
    assertEqual(await buildMessageInput('text only', []), 'text only', 'plain string queue shape remains stable');
    assertEqual(object((await buildMessageInput('', [{ path: image, name: 'extensionless', type: 'image/x-png' }]) as unknown[])[0]).mimeType, 'image/png', 'valid image MIME needs no extension');
    await assertRejects(() => buildMessageInput('Reject all', [{ path: image }, { path: pdf, name: 'wrong.zip' }]), 'unsupported sibling refuses whole message');
    await writeFile(image, ''); await assertRejects(() => buildMessageInput('', [{ path: image }]), 'empty inline media refused');
  } finally { await f.attachments.close(); }
});
h.test('question attachments inline uploaded images and keep other files as references', async () => {
  const f = await fixture();
  try {
    const image = object(await f.attachments.upload({ name: 'screenshot.png', type: 'image/png', buffer: 'iVBORw0KGgo=' }));
    const notes = object(await f.attachments.upload({ name: 'notes.txt', type: 'text/plain', buffer: Buffer.from('notes').toString('base64') }));
    const opaque = object(await f.attachments.upload({ name: 'opaque.png', type: 'application/octet-stream', buffer: 'iVBORw0KGgo=' }));
    assertEqual(opaque.type, 'image/png', 'opaque browser MIME falls back to a supported image extension');
    assertDeepEqual(await f.attachments.answerAttachments({ 'Which details?': [{ ...opaque, type: 'application/octet-stream' }] }), { 'Which details?': [{ type: 'image', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }] }, 'image bytes survive generic MIME metadata');
    const groups = { 'Which details?': [image, notes] };
    assertDeepEqual(await f.attachments.answerAttachments(groups), { 'Which details?': [{ type: 'image', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }] }, 'images become model-visible content, not filename-only strings');
    assertDeepEqual(await f.attachments.answerAttachments({ 'Which details?': [notes] }), {}, 'ordinary files keep their uploaded path references');
    await assertRejects(() => f.attachments.answerAttachments({ 'Which details?': Array.from({ length: 21 }, () => image) }), 'attachment count is bounded across the question batch');
    await assertRejects(() => f.attachments.answerAttachments({ 'Which details?': 'not a list' }), 'malformed lists are refused');
    const outside = join(f.root, 'outside.png'); await writeFile(outside, 'private');
    await assertRejects(() => f.attachments.answerAttachments({ 'Which details?': [{ path: outside, name: 'outside.png' }] }), 'answers cannot inline arbitrary local files');
    await rm(String(image.path));
    await assertRejects(() => f.attachments.answerAttachments(groups), 'missing files refuse the entire attachment answer');
  } finally { await f.attachments.close(); }
});

h.test('directory exclusion refuses uploads and input reads while shutdown refuses new work', async () => {
  const f = await fixture(), project = join(f.root, 'project'); await mkdir(project);
  const path = join(project, 'photo.png'); await writeFile(path, 'picture');
  try {
    const release = await f.workspaces.quiesceDirectory(project);
    assertEqual(object(await f.attachments.uploadPath({ path })).ok, false, 'leased source cannot be opened');
    await assertRejects(() => f.attachments.input('', [{ path }]), 'inline reads respect the same lease');
    release();
    assertEqual(object(await f.attachments.uploadPath({ path })).ok, true, 'released source becomes available');
    await f.attachments.close(); await assertRejects(async () => f.attachments.upload({ buffer: [] }), 'closed service refuses cache writes');
  } finally { await f.attachments.close(); }
});
void (async () => {
  const failed = await h.finish(join(__dirname, 'attachments-result.json'), 'attachments');
  for (const root of roots) await rm(root, { recursive: true, force: true });
  process.exit(failed);
})();
