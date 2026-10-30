import { mkdtemp, writeFile, rm, symlink, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MediaFiles } from '../main/services/media-files';
import { ImageActions } from '../main/services/image-actions';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness(), roots: string[] = [];
const imageActions = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/image-actions.json'), 'utf8')) as {
  copySuccess: { ok: boolean }; copyFailure: { ok: boolean; error: string };
};
const revocation = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/media-revocation.json'), 'utf8')) as {
  actions: Array<'session' | 'close'>; revokedResponseStatus: number; grantLimit: number;
};
function barrier() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { started, release, wait: async () => { entered(); await pending; } };
}
for (const action of revocation.actions) {
  h.test(`${action} invalidates an ordinary grant while authorization is pending`, async () => {
    const f = await fixture(), blocked = barrier();
    const media = new MediaFiles(async () => { await blocked.wait(); return true; });
    const pending = media.grant(f.path, 's');
    await blocked.started;
    if (action === 'close') media.close(); else media.revokeSession('s');
    blocked.release();
    try { await assertRejects(() => pending, 'a revoked grant cannot publish a new capability'); }
    finally { media.close(); f.media.close(); }
  });
  h.test(`${action} invalidates an ordinary response while authorization is pending`, async () => {
    const f = await fixture(), blocked = barrier(); let hold = false;
    const media = new MediaFiles(async () => { if (hold) await blocked.wait(); return true; });
    const url = await media.grant(f.path, 's'); hold = true;
    const pending = media.respond(new Request(url));
    await blocked.started;
    if (action === 'close') media.close(); else media.revokeSession('s');
    blocked.release();
    try {
      const response = await pending;
      await response.arrayBuffer();
      assertEqual(response.status, revocation.revokedResponseStatus, 'a revoked response must not publish bytes');
    } finally { media.close(); f.media.close(); }
  });
  h.test(`${action} destroys an ordinary media stream already returned to the renderer`, async () => {
    const f = await fixture(); await writeFile(f.path, Buffer.alloc(4 * 1024 * 1024));
    const response = await f.media.respond(new Request(f.url));
    if (action === 'close') f.media.close(); else f.media.revokeSession('s');
    try { await assertRejects(() => response.arrayBuffer(), 'revoked stream must terminate'); }
    finally { f.media.close(); }
  });
}
h.test('grant eviction destroys ordinary streams and invalidates the evicted URL', async () => {
  const f = await fixture(); await writeFile(f.path, Buffer.alloc(4 * 1024 * 1024));
  const media = new MediaFiles(async () => true);
  try {
    const url = await media.grant(f.path, 'original');
    const response = await media.respond(new Request(url));
    for (let index = 0; index < revocation.grantLimit; index++) await media.grant(f.path, `other-${index}`);
    assertEqual((await media.respond(new Request(url))).status, 404, 'evicted URL');
    await assertRejects(() => response.arrayBuffer(), 'eviction terminates existing stream');
  } finally { media.close(); f.media.close(); }
});
h.test('legacy URLs revoke in-flight work but new reads still use current authorization', async () => {
  const f = await fixture(), blocked = barrier(); let hold = true, allowed = true;
  const media = new MediaFiles(async () => { if (hold) { hold = false; await blocked.wait(); } return allowed; });
  const url = `klaus-media://localhost/${Buffer.from(f.path).toString('base64url')}?s=s`;
  try {
    const pending = media.respond(new Request(url));
    await blocked.started; media.revokeSession('s'); blocked.release();
    assertEqual((await pending).status, revocation.revokedResponseStatus, 'pending legacy read is revoked');
    assertEqual(await (await media.respond(new Request(url))).text(), '0123456789', 'new legacy read rechecks authorization');
    await writeFile(f.path, Buffer.alloc(4 * 1024 * 1024));
    const response = await media.respond(new Request(url));
    media.revokeSession('s');
    await assertRejects(() => response.arrayBuffer(), 'legacy stream belongs to its session');
    allowed = false;
    assertEqual((await media.respond(new Request(url))).status, 403, 'new unauthorized legacy read remains forbidden');
  } finally { media.close(); f.media.close(); }
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'klaus-media-'))); roots.push(root);
  await mkdir(join(root, 'project'));
  const path = join(root, 'project', 'file.pdf'); await writeFile(path, '0123456789');
  const media = new MediaFiles(async (candidate, id) => candidate === path && id === 's');
  return { root, path, media, url: await media.grant(path, 's') };
}
h.test('approved media streams exact full, suffix and bounded ranges without active content', async () => {
  const f = await fixture();
  const response = await f.media.respond(new Request(f.url));
  assertEqual(await response.text(), '0123456789', 'full file');
  assertEqual(response.headers.get('content-type'), 'application/pdf', 'PDF viewer content type');
  assertEqual(response.headers.get('content-security-policy'), "default-src 'none'; sandbox", 'file cannot acquire app authority');
  const range = await f.media.respond(new Request(f.url, { headers: { Range: 'bytes=2-4' } }));
  assertEqual(range.status, 206, 'partial status');
  assertEqual(range.headers.get('content-range'), 'bytes 2-4/10', 'exact range');
  assertEqual(await range.text(), '234', 'only requested bytes');
  const suffix = await f.media.respond(new Request(f.url, { headers: { Range: 'bytes=-2' } }));
  assertEqual(await suffix.text(), '89', 'suffix');
  const head = await f.media.respond(new Request(f.url, { method: 'HEAD' }));
  assertEqual(head.headers.get('content-length'), '10', 'HEAD length');
  assertEqual(await head.text(), '', 'HEAD carries no body');
  f.media.close();
});
h.test('media rejects invalid ranges, methods, origins, forged paths and other conversations', async () => {
  const f = await fixture();
  for (const value of ['bytes=20-', 'bytes=5-2', 'bytes=0-1,3-4', 'bytes=-0']) {
    assertEqual((await f.media.respond(new Request(f.url, { headers: { Range: value } }))).status, 416, value);
  }
  assertEqual((await f.media.respond(new Request(f.url, { method: 'POST' }))).status, 405, 'no write method');
  assertEqual((await f.media.respond(new Request(f.url, { headers: { Origin: 'https://example.test' } }))).status, 403, 'external caller rejected');
  assertEqual((await f.media.respond(new Request('klaus-media://file/etc/passwd'))).status, 404, 'URL paths are not disk paths');
  await assertRejects(() => f.media.grant(f.path, 'another-session'), 'grant follows session scope');
  f.media.revokeSession('s');
  assertEqual((await f.media.respond(new Request(f.url))).status, 404, 'changed workspace revokes previous capabilities');
  f.media.close();
});
h.test('replacing an approved file with a symlink cannot reuse its capability', async () => {
  const f = await fixture(), other = join(f.root, 'other');
  await mkdir(other); await writeFile(join(other, 'file.pdf'), 'secret');
  await rm(join(f.root, 'project'), { recursive: true });
  await symlink(other, join(f.root, 'project'), process.platform === 'win32' ? 'junction' : 'dir');
  const response = await f.media.respond(new Request(f.url));
  assert(response.status === 403 || response.status === 404, 'symlink replacement refused');
  f.media.close();
});
h.test('synchronous frontend URLs are decoded strictly and checked against current session scope', async () => {
  const f = await fixture(), legacy = `klaus-media://localhost/${Buffer.from(f.path).toString('base64url')}?s=s`;
  assertEqual(await (await f.media.respond(new Request(legacy))).text(), '0123456789', 'existing frontend URL streams media');
  assertEqual((await f.media.respond(new Request(legacy.replace('?s=s', '?s=other')))).status, 403, 'other session cannot read it');
  assertEqual((await f.media.respond(new Request(legacy + '&unexpected=1'))).status, 404, 'unknown URL parameters refused');
  const text = join(f.root, 'project', 'private.txt'); await writeFile(text, 'private');
  assertEqual((await f.media.respond(new Request(`klaus-media://localhost/${Buffer.from(text).toString('base64url')}?s=s`))).status, 404, 'path URL cannot read arbitrary text');
  f.media.close();
});
h.test('directory deletion cancels ongoing streams and holds new media reads until released', async () => {
  const f = await fixture(); await writeFile(f.path, Buffer.alloc(4 * 1024 * 1024));
  const response = await f.media.respond(new Request(f.url));
  const release = await f.media.quiesceDirectory(join(f.root, 'project'));
  assertEqual((await f.media.respond(new Request(f.url))).status, 423, 'new media reads refused during removal');
  await assertRejects(() => response.arrayBuffer(), 'active stream ended before directory deletion');
  release(); assertEqual((await f.media.respond(new Request(f.url, { method: 'HEAD' }))).status, 200, 'release restores access');
  f.media.close();
});
h.test('image copy waits for the platform write before reporting success', async () => {
  const media = new MediaFiles(async () => false), blocked = barrier();
  const actions = new ImageActions({ media, saveDialog: async () => undefined, reveal: () => {},
    copyImage: async bytes => {
      assert(bytes.equals(Buffer.from(PNG_FIXTURE_BASE64, 'base64')), 'copy preserves the authorized image bytes');
      await blocked.wait();
    },
  });
  let settled = false;
  const pending = actions.copy({ data: PNG_FIXTURE_BASE64, mimeType: 'image/png' }).then(result => { settled = true; return result; });
  try {
    await blocked.started;
    await new Promise<void>(resolve => setImmediate(resolve));
    assertEqual(settled, false, 'an unfinished platform write cannot be acknowledged');
    blocked.release();
    assertDeepEqual(await pending, imageActions.copySuccess, 'the completed write succeeds');
  } finally { blocked.release(); media.close(); }
});
h.test('image copy reports an asynchronous platform rejection', async () => {
  const media = new MediaFiles(async () => false);
  const actions = new ImageActions({ media, saveDialog: async () => undefined, reveal: () => {},
    copyImage: async () => { throw new Error(imageActions.copyFailure.error); },
  });
  try {
    assertDeepEqual(await actions.copy({ data: PNG_FIXTURE_BASE64, mimeType: 'image/png' }), imageActions.copyFailure, 'a failed write stays failed');
  } finally { media.close(); }
});

h.test('image save and reveal retain owner scope, original bytes, MIME filename and cancellation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'klaus-image-actions-'))); roots.push(root);
  const path = join(root, 'verified, UI.png'), destination = join(root, 'copy.png'), png = Buffer.from(PNG_FIXTURE_BASE64, 'base64');
  await writeFile(path, png);
  const media = new MediaFiles(async (file, owner) => file === path && owner === 'owner');
  let chosen: string | undefined = destination, revealed = '', filename = '';
  const actions = new ImageActions({ media, saveDialog: async name => { filename = name; return chosen; },
    copyImage: () => {}, reveal: value => { revealed = value; } });
  try {
    assertEqual((await actions.read({ sessionId: 'foreign', filePath: path })).ok, false, 'another conversation cannot read this source');
    assertEqual((await actions.read({ sessionId: 'owner', filePath: path })).data, PNG_FIXTURE_BASE64, 'original authorized bytes');
    assertEqual((await actions.save({ sessionId: 'owner', filePath: path, name: 'Screenshot.jpg' })).ok, true, 'native save destination accepted');
    assertEqual(filename, 'Screenshot.png', 'filename follows original MIME');
    assert(Buffer.from(await import('node:fs/promises').then(fs => fs.readFile(destination))).equals(png), 'saved copy keeps original bytes');
    assertEqual((await actions.reveal({ sessionId: 'owner', filePath: path })).ok, true, 'scoped reveal');
    assertEqual(revealed, path, 'real source revealed');
    chosen = undefined;
    assertDeepEqual(await actions.save({ sessionId: 'owner', filePath: path }), { ok: true, cancelled: true }, 'cancellation is explicit');
  } finally { media.close(); }
});
h.test('image save revalidates a capability after the native dialog and refuses revoked bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-image-save-revocation-')); roots.push(root);
  const path = join(root, 'UI.png'), destination = join(root, 'copy.png');
  await writeFile(path, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
  const media = new MediaFiles(async (_, owner) => owner === 'owner');
  const actions = new ImageActions({ media, saveDialog: async () => { media.revokeSession('owner'); return destination; },
    copyImage: () => {}, reveal: () => {} });
  try { assertEqual((await actions.save({ sessionId: 'owner', filePath: path })).ok, false, 'revoked capture cannot be saved'); }
  finally { media.close(); }
});

h.test('image inspection checks exact file ownership without transferring bytes and classifies failures', async () => {
  const f = await fixture(), path = join(f.root, 'project', 'verified.png');
  await writeFile(path, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
  const diagnostics: Array<Record<string, string | number>> = [];
  const media = new MediaFiles(async (candidate, id) => candidate === path && id === 'owner');
  const actions = new ImageActions({ media, saveDialog: async () => undefined, copyImage: () => {}, reveal: () => {}, diagnostic: row => diagnostics.push(row) });
  try {
    const result = await actions.read({ filePath: path, sessionId: 'owner', inspect: true });
    assertEqual(result.ok, true, 'a real owner can inspect');
    assertEqual(result.data, undefined, 'HEAD validation transfers no base64');
    assertEqual(result.mimeType, 'image/png', 'actual media type');
    assertEqual((await media.respond(new Request(String(result.url)))).status, 200, 'the returned capability serves that exact image');
    const denied = await actions.read({ filePath: path, sessionId: 'other', inspect: true });
    assertEqual(denied.reason, 'denied', 'a different owner cannot acquire the image');
    const missing = await actions.read({ filePath: join(f.root, 'browser-shot-spliced.jpg'), sessionId: 'owner', inspect: true });
    assertEqual(missing.reason, 'not-found', 'a fabricated filename is never mapped to another picture');
    const release = await media.quiesceDirectory(join(f.root, 'project'));
    assertEqual((await actions.read({ filePath: path, sessionId: 'owner', inspect: true })).reason, 'busy', 'temporary directory removal is distinguishable');
    release();
    assertEqual((await actions.read({ filePath: path, sessionId: 'owner', inspect: true })).ok, true, 'retry recovers after the directory lease is released');
    assertEqual((await actions.read({ filePath: path, sessionId: 'owner', inspect: true, loadFailed: true })).ok, true, 'a prior load error does not label readable metadata as corrupt');
    assertDeepEqual(diagnostics.map(row => row.reason), ['denied', 'not-found', 'busy', 'unavailable'], 'failed loads and validations are durably diagnosable');
    assertEqual(diagnostics.at(-1)?.status, 200, 'the successful reinspection is retained in the failure diagnostic');
  } finally { media.close(); f.media.close(); }
});

h.test('actual image bytes determine display and save MIME when the filename suffix is wrong', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'klaus-image-mime-'))); roots.push(root);
  const path = join(root, 'verification.jpg'), png = Buffer.from(PNG_FIXTURE_BASE64, 'base64');
  await writeFile(path, png);
  const media = new MediaFiles(async (candidate, owner) => candidate === path && owner === 'owner');
  const actions = new ImageActions({ media, saveDialog: async () => undefined, copyImage: () => {}, reveal: () => {} });
  try {
    const inspected = await actions.read({ filePath: path, sessionId: 'owner', inspect: true });
    assertEqual(inspected.mimeType, 'image/png', 'HEAD exposes the actual image format');
    const response = await media.respond(new Request(String(inspected.url)));
    assertEqual(response.headers.get('content-type'), 'image/png', 'GET agrees with inspection');
    assert(Buffer.from(await response.arrayBuffer()).equals(png), 'signature reads preserve the complete image stream');
    const read = await actions.read({ filePath: path, sessionId: 'owner' });
    assertEqual(read.name, 'verification.png', 'save filename follows the content instead of the wrong suffix');
    assertEqual(read.data, PNG_FIXTURE_BASE64, 'saving keeps the exact image bytes');
    const range = await media.respond(new Request(String(inspected.url), { headers: { Range: 'bytes=4-9' } }));
    assert(Buffer.from(await range.arrayBuffer()).equals(png.subarray(4, 10)), 'MIME probing does not shift range reads');
  } finally { media.close(); }
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'media-files-result.json'), 'media-files');
  for (const root of roots) await rm(root, { recursive: true, force: true });
  process.exit(failed);
})();
