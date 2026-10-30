import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaFiles } from '../main/services/media-files';
import { createConversationMediaScope } from '../main/services/media-scope';
import { sessionVisualizationsDir } from '../main/services/visualizations';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerFileHandlers } from '../main/ipc/handlers/files';
import { WorkspaceStore } from '../main/services/workspaces';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';
import { assert, assertEqual, Harness } from './harness';

const h = new Harness(), roots: string[] = [];
const owner = 'visualization-owner';

async function fixture(prepareSessionMedia = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'klaus-media-scope-'))); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const visDir = sessionVisualizationsDir(root, owner); await mkdir(visDir, { recursive: true });
  const file = join(visDir, 'dream-settings-memory-model.png');
  const bytes = Buffer.from(PNG_FIXTURE_BASE64, 'base64'); await writeFile(file, bytes);
  const produced = new Set<string>();
  const scope = createConversationMediaScope({
    configRoot: root,
    prepareSessionMedia: async () => prepareSessionMedia,
    resolveSessionDirectory: () => workspace,
    extraRoots: () => [],
    producedBySession: (path, sessionId) => sessionId === owner && produced.has(path),
  });
  const media = new MediaFiles(scope);
  const url = (path: string, sessionId = owner) => `klaus-media://localhost/${Buffer.from(path).toString('base64url')}?s=${sessionId}`;
  return { root, workspace, file, bytes, produced, scope, media, url };
}

h.test('the production media scope serves a Markdown image from the owning visualization directory', async () => {
  const f = await fixture();
  try {
    // No tool result or publication ledger entry: the directory itself is the
    // declared authority, exactly as it is for an inline visualization page.
    const response = await f.media.respond(new Request(f.url(f.file)));
    assertEqual(response.status, 200, 'the owning chat reads the actual image bytes');
    assert(Buffer.from(await response.arrayBuffer()).equals(f.bytes), 'the served bytes match the source image');
  } finally { f.media.close(); }
});

h.test('visualization scope rejects another chat, foreign files and symlink escapes', async () => {
  const f = await fixture();
  const otherVis = sessionVisualizationsDir(f.root, 'other-chat'); await mkdir(otherVis);
  const foreign = join(otherVis, 'foreign.png'); await writeFile(foreign, f.bytes);
  const secret = join(f.root, 'secret.png'); await writeFile(secret, f.bytes);
  const escape = join(sessionVisualizationsDir(f.root, owner), 'escape.png'); await symlink(secret, escape);
  try {
    assertEqual((await f.media.respond(new Request(f.url(f.file, 'other-chat')))).status, 403, 'another chat cannot read this image');
    assertEqual((await f.media.respond(new Request(f.url(foreign)))).status, 403, 'the owning chat cannot read another chat directory');
    assertEqual((await f.media.respond(new Request(f.url(escape)))).status, 403, 'a symlink cannot escape the visualization directory');
  } finally { f.media.close(); }
});

h.test('an unprepared conversation cannot reopen visualization media scope', async () => {
  const f = await fixture(false);
  try { assertEqual((await f.media.respond(new Request(f.url(f.file)))).status, 403, 'deleted or private history grants no media access'); }
  finally { f.media.close(); }
});

h.test('file preview and the media protocol serve the same visualization image authority', async () => {
  const f = await fixture();
  const workspaces = new WorkspaceStore({ configRoot: f.root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const files = registerFileHandlers(new ChannelRegistry(), {
    workspaces, push: () => {}, openPath: async () => {}, revealPath: async () => {}, trashPath: async () => {},
    openPreviewWindow: async () => {}, requestSession: async () => ({}),
    mediaScope: f.scope, toFileUrl: (path, sessionId) => f.media.grant(path, sessionId),
  });
  try {
    const preview = await files.artifactFileUrl({ sessionId: owner, filePath: f.file }) as { ok?: boolean; url?: string; error?: string };
    assert(preview.ok && preview.url, `file preview accepts the same path: ${preview.error || 'no URL'}`);
    const response = await f.media.respond(new Request(preview.url!));
    assertEqual(response.status, 200, 'the file-preview grant reads through the media protocol');
    assert(Buffer.from(await response.arrayBuffer()).equals(f.bytes), 'both surfaces return the original bytes');
    const foreign = await files.artifactFileUrl({ sessionId: 'other-chat', filePath: f.file }) as { ok?: boolean; error?: string };
    assert(!foreign.ok, 'file preview retains the media protocol cross-chat refusal');
  } finally { files.close(); f.media.close(); }
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'media-scope-result.json'), 'media-scope');
  for (const root of roots) await rm(root, { recursive: true, force: true });
  process.exit(failed);
})();
