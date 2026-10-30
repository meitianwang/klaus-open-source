import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerFileHandlers } from '../main/ipc/handlers/files';
import { MediaFiles } from '../main/services/media-files';
import { SessionArtifactPaths, recordArtifactPathsFromChatEvent } from '../main/services/artifact-paths';
import { pathInside, WorkspaceStore } from '../main/services/workspaces';
import { assert, assertEqual, assertRejects, Harness, waitFor } from './harness';
import { createHtmlPreviewFixture } from './html-preview-fixture';

const h = new Harness();
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/html-preview-vectors.json'), 'utf8')) as {
  document: string; opaqueOrigin: string;
  resources: Array<{ relative: string; path: string; type: string }>;
  refusedRelativePaths: string[];
};
const fixtures: Array<{ root: string; media: MediaFiles }> = [];
const accessVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/artifact-preview-access-vectors.json'), 'utf8')) as {
  sessionId: string; otherSessionId: string;
  externalFiles: Array<{ name: string; content: string }>;
  deniedRoles: string[]; invalidPaths: string[];
};

async function fixture() {
  const files = await createHtmlPreviewFixture();
  const state = { allowed: true, roots: [files.workspace], hook: undefined as (() => Promise<void>) | undefined };
  const media = new MediaFiles(async (path, id) => {
    await state.hook?.();
    return state.allowed && id === 's' && state.roots.some(root => pathInside(path, root));
  });
  fixtures.push({ ...files, media });
  const url = await media.grantHtmlPreview(files.entry, 's', files.workspace);
  return { ...files, media, url, state };
}
const opaque = { headers: { Origin: vectors.opaqueOrigin } };
function blockNextScopeCheck(f: Awaited<ReturnType<typeof fixture>>) {
  let entered = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.state.hook = async () => { f.state.hook = undefined; entered = true; await pending; };
  return { release, entered: () => entered };
}

h.test('HTML and relative stylesheet, module, JSON and image bytes retain their token and MIME types', async () => {
  const f = await fixture(), document = await f.media.respond(new Request(f.url));
  assertEqual(document.status, 200, 'HTML response');
  assertEqual(document.headers.get('content-type'), 'text/html', 'HTML is rendered as a document');
  assertEqual(await document.text(), await readFile(f.entry, 'utf8'), 'document bytes are not rewritten');
  const policy = document.headers.get('content-security-policy')!;
  assert(policy.includes('sandbox allow-scripts;'), 'interactive sandbox');
  assert(!policy.includes('allow-same-origin'), 'document keeps an opaque origin');
  assert(!policy.includes('klaus-app:'), 'document cannot acquire the host origin');
  assert(policy.includes(`connect-src klaus-media://preview/${new URL(f.url).pathname.split('/')[1]}/;`), 'fetch confined to the preview capability');
  for (const resource of vectors.resources) {
    const url = new URL(resource.relative, f.url);
    assertEqual(url.pathname.split('/')[1], new URL(f.url).pathname.split('/')[1], 'relative URL retains token');
    const response = await f.media.respond(new Request(url, opaque));
    assertEqual(response.status, 200, resource.relative);
    assertEqual(response.headers.get('content-type'), resource.type, resource.path + ' MIME');
    assertEqual(response.headers.get('access-control-allow-origin'), 'null', 'opaque module/fetch origin');
    assertEqual(Buffer.from(await response.arrayBuffer()).toString('base64'), (await readFile(join(f.workspace, resource.path))).toString('base64'), 'exact resource bytes');
  }
});

h.test('artifacts:file-url chooses HTML preview scope and keeps ordinary media on its existing path', async () => {
  const f = await fixture(), calls: string[] = [], registry = new ChannelRegistry();
  const workspaces = new WorkspaceStore({ configRoot: join(f.root, 'config'), push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.bindSession('s', { workdir: f.workspace });
  const service = registerFileHandlers(registry, {
    workspaces, watch: false, push: () => {}, openPath: async () => {}, revealPath: () => {}, trashPath: async () => {},
    requestSession: async () => ({}), openPreviewWindow: async () => {},
    toFileUrl: (path, id) => { calls.push('media'); return f.media.grant(path, id); },
    toHtmlPreviewUrl: (path, id, scopeRoot) => { calls.push(scopeRoot); return f.media.grantHtmlPreview(path, id, scopeRoot); },
  });
  const invoke = async (filePath: string): Promise<Record<string, Json>> => registry.lookup('artifacts:file-url')!({
    channel: 'artifacts:file-url', args: [{ sessionId: 's', filePath }], senderId: 1, role: 'main',
  }) as Promise<Record<string, Json>>;
  try {
    const html = await invoke(f.entry);
    assertEqual(html.ok, true, 'registered handler returns a preview URL');
    assertEqual(new URL(String(html.url)).hostname, 'preview', 'HTML selects isolated preview');
    assertEqual(calls[0], f.workspace, 'host derives the verified workspace scope');
    const image = await invoke(join(f.workspace, 'assets/pixel.svg'));
    assertEqual(new URL(String(image.url)).hostname, 'file', 'ordinary media keeps its single-file grant');
    assertEqual(calls[1], 'media', 'ordinary callback');
    assertEqual((await f.media.respond(new Request(String(image.url), opaque))).status, 403, 'opaque origin does not gain ordinary media access');
    const response = await f.media.respond(new Request(String(image.url)));
    assertEqual(response.headers.get('content-security-policy'), "default-src 'none'; sandbox", 'ordinary media policy unchanged');
    await response.arrayBuffer();
    const upload = join(workspaces.configRoot, 'uploads', 'report.html'); await mkdir(join(workspaces.configRoot, 'uploads'), { recursive: true }); await writeFile(upload, '<h1>Uploaded report</h1>');
    f.state.roots.push(join(workspaces.configRoot, 'uploads'));
    const uploaded = await invoke(upload);
    assertEqual(uploaded.ok, true, 'uploaded HTML receives the same preview capability');
    assertEqual(calls[2], join(workspaces.configRoot, 'uploads'), 'uploaded HTML keeps the specific verified root');
    assertEqual(await (await f.media.respond(new Request(String(uploaded.url)))).text(), '<h1>Uploaded report</h1>', 'upload streams from its actual scope');
  } finally { service.close(); }
});

h.test('a page this conversation wrote outside its roots previews, and stays unwritable', async () => {
  const f = await fixture(), registry = new ChannelRegistry();
  const workspaces = new WorkspaceStore({ configRoot: join(f.root, 'config'), push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.bindSession('s', { workdir: f.workspace });
  const outside = join(f.root, 'downloads');
  await mkdir(outside, { recursive: true });
  const produced = join(outside, 'cover.png'), page = join(outside, 'report.html'), stranger = join(outside, 'stranger.png');
  await writeFile(produced, 'bytes'), await writeFile(page, '<h1>Report</h1>'), await writeFile(stranger, 'not mine');
  // The real ledger, filled the way the event pump fills it: a diff_update naming
  // the file this conversation wrote. Both deliverables sit OUTSIDE the workspace
  // (a ~/Downloads cover, a page under .klaus/), which is exactly the case the
  // roots cannot cover.
  const ledger = new SessionArtifactPaths();
  for (const path of [produced, page]) {
    recordArtifactPathsFromChatEvent(ledger, { type: 'diff_update', sessionId: 's', changes: [{ path, kind: 'create' }] });
  }
  // The runtime's own media scope, reduced to what matters here: the workspace
  // roots plus the ledger. Both preview grants below flow through it, so a
  // pass means the file is served, not merely that a URL was minted.
  const media = new MediaFiles(async (path, id) => id === 's'
    && (pathInside(path, f.workspace) || ledger.has(id, path)));
  fixtures.push({ ...f, media });
  const service = registerFileHandlers(registry, {
    workspaces, watch: false, push: () => {}, openPath: async () => {}, revealPath: () => {}, trashPath: async () => {},
    requestSession: async () => ({}), openPreviewWindow: async () => {},
    producedBySession: (path, id) => ledger.has(id, path),
    toFileUrl: (path, id) => media.grant(path, id),
    toHtmlPreviewUrl: (path, id, scopeRoot) => media.grantHtmlPreview(path, id, scopeRoot),
  });
  const invoke = async (channel: string, filePath: string, extra: Record<string, Json> = {}): Promise<Record<string, Json>> =>
    registry.lookup(channel)!({ channel, args: [{ sessionId: 's', filePath, ...extra }], senderId: 1, role: 'main' }) as Promise<Record<string, Json>>;
  try {
    const image = await invoke('artifacts:file-url', produced);
    assertEqual(image.ok, true, 'a produced image outside the roots gets a preview URL');
    assertEqual(new URL(String(image.url)).hostname, 'file', 'an image keeps its single-file grant');
    assertEqual(await (await media.respond(new Request(String(image.url)))).text(), 'bytes', 'the produced image actually streams');
    // A produced page keeps the sandboxed HTML capability, bounded by its own directory.
    const html = await invoke('artifacts:file-url', page);
    assertEqual(html.ok, true, 'a produced page gets an HTML preview capability');
    assertEqual(new URL(String(html.url)).hostname, 'preview', 'HTML still selects the isolated preview');
    assertEqual(await (await media.respond(new Request(String(html.url)))).text(), '<h1>Report</h1>', 'the produced page renders from its own directory scope');
    // A path this conversation never named stays refused.
    assertEqual((await invoke('artifacts:file-url', stranger)).error, 'path outside preview scope', 'an unrecorded neighbour is still out of scope');
    // The ledger widens PREVIEW only. Writing or renaming through the ledger entry
    // is refused, so a conversation cannot edit a file outside its workspace here.
    assertEqual((await invoke('workspace:write', produced, { content: 'tampered' })).error, 'path outside session workspace', 'a produced path stays unwritable');
    assertEqual((await invoke('workspace:rename', produced, { newName: 'other.png' })).error, 'path outside session workspace', 'rename stays root-scoped');
    assertEqual(await readFile(produced, 'utf8'), 'bytes', 'the refused write changed nothing');
  } finally { service.close(); }
});

h.test('selected external files preview without tool provenance, including after reopening', async () => {
  const f = await fixture(), { sessionId, otherSessionId } = accessVectors;
  const workspaces = new WorkspaceStore({ configRoot: join(f.root, 'config'), push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.bindSession(sessionId, { workdir: f.workspace });
  workspaces.bindSession(otherSessionId, { workdir: f.workspace });
  const outside = join(f.root, 'external reports'); await mkdir(outside);
  const neighbour = join(outside, 'private.md'); await writeFile(neighbour, 'not selected');
  const alias = join(f.workspace, 'selected.md');
  const workspaceAlias = join(f.root, 'workspace-alias'); await symlink(f.workspace, workspaceAlias, 'dir');
  workspaces.bindSession('aliased-workspace', { workdir: workspaceAlias });
  const editable = join(f.workspace, 'editable.md'); await writeFile(editable, '# Editable');
  for (const file of accessVectors.externalFiles) await writeFile(join(outside, file.name), file.content);
  const selected = join(outside, accessVectors.externalFiles[0]!.name);
  await symlink(selected, alias);
  // Fresh ledgers model both a shell-created file without events and reopening.
  for (let round = 0; round < 2; round++) {
    const ledger = new SessionArtifactPaths(), registry = new ChannelRegistry();
    const media = new MediaFiles(async (path, id) => id === sessionId && ledger.has(id, path));
    fixtures.push({ ...f, media });
    const service = registerFileHandlers(registry, {
      workspaces, watch: false, push: () => {}, openPath: async () => {}, revealPath: () => {}, trashPath: async () => {},
      requestSession: async () => ({}), openPreviewWindow: async () => {},
      producedBySession: (path, id) => ledger.has(id, path), authorizePreviewPath: (path, id) => ledger.record(id, path, true),
      toFileUrl: (path, id) => media.grant(path, id),
      toHtmlPreviewUrl: (path, id, scopeRoot) => media.grantHtmlPreview(path, id, scopeRoot),
    });
    const invoke = async (channel: string, filePath: string, id = sessionId, role = 'main', extra: Record<string, Json> = {}): Promise<Record<string, Json>> =>
      registry.lookup(channel)!({ channel, args: [{ sessionId: id, filePath, ...extra }], senderId: 1, role }) as Promise<Record<string, Json>>;
    try {
      assertEqual((await invoke('artifacts:read', selected)).error, 'path outside preview scope', 'ordinary reads cannot authorize themselves');
      for (const role of accessVectors.deniedRoles) await assertRejects(() => invoke('artifacts:authorize-preview', selected, sessionId, role), role + ' cannot authorize files');
      assert(!ledger.has(sessionId, selected), 'untrusted roles grant nothing');
      for (const path of accessVectors.invalidPaths) assertEqual((await invoke('artifacts:authorize-preview', path)).error, 'invalid path', 'invalid path refused');
      assertEqual((await invoke('artifacts:authorize-preview', selected, '')).error, 'invalid path', 'session required');
      assertEqual((await invoke('artifacts:authorize-preview', join(outside, 'missing.md'))).error, 'file not found', 'missing file is reported precisely');
      assertEqual((await invoke('artifacts:authorize-preview', outside)).error, 'not a file', 'directories cannot become grants');
      for (const file of accessVectors.externalFiles) {
        const path = join(outside, file.name), grant = await invoke('artifacts:authorize-preview', path);
        assertEqual(grant.ok, true, 'explicit selection authorizes this file');
        const read = await invoke('artifacts:read', String(grant.filePath));
        assertEqual(read.content, file.content, 'selected external bytes load');
        assertEqual(read.readonly, true, 'external preview does not offer an unsupported save');
        if (file.name.endsWith('.html')) {
          const url = await invoke('artifacts:file-url', String(grant.filePath));
          const response = await media.respond(new Request(String(url.url)));
          assertEqual(await response.text(), file.content, 'selected HTML streams through the isolated capability');
          assertEqual((await media.respond(new Request(new URL('private.md', String(url.url)), opaque))).status, 403, 'HTML cannot fetch an unselected neighbour');
        }
      }
      const aliasGrant = await invoke('artifacts:authorize-preview', alias);
      assertEqual(aliasGrant.filePath, selected, 'the viewer reads the canonical target of a selected alias');
      assertEqual((await invoke('artifacts:read', neighbour)).error, 'path outside preview scope', 'a neighbouring file stays private');
      assertEqual((await invoke('artifacts:read', selected, otherSessionId)).error, 'path outside preview scope', 'another session receives no grant');
      assertEqual((await invoke('workspace:write', selected, sessionId, 'main', { content: 'changed' })).error, 'path outside session workspace', 'selection grants no write access');
      assertEqual((await invoke('workspace:list', outside)).error, 'path outside session workspace', 'selection grants no directory access');
      assertEqual((await invoke('workspace:reveal', selected)).ok, true, 'the selected external file can be revealed');
      assertEqual((await invoke('workspace:reveal', neighbour)).error, 'path outside preview scope', 'reveal still refuses an unselected neighbour');
      const editableGrant = await invoke('artifacts:authorize-preview', join(workspaceAlias, 'editable.md'), 'aliased-workspace');
      assertEqual((await invoke('artifacts:read', String(editableGrant.filePath), 'aliased-workspace')).readonly, false, 'a symlinked workspace remains editable');
      assertEqual(await readFile(selected, 'utf8'), accessVectors.externalFiles[0]!.content, 'external bytes remain unchanged');
      if (round === 1) {
        await rm(selected); await symlink(neighbour, selected);
        assertEqual((await invoke('artifacts:read', selected)).error, 'path outside preview scope', 'a recorded path cannot retarget to an unselected neighbour');
      }
    } finally { service.close(); }
  }
});

h.test('the media channel serves a produced file and refuses its unrecorded neighbour', async () => {
  const f = await fixture();
  const outside = join(f.root, 'outside-media');
  await mkdir(outside, { recursive: true });
  const produced = join(outside, 'cover.png'), stranger = join(outside, 'stranger.png');
  await writeFile(produced, 'mine'), await writeFile(stranger, 'not mine');
  const ledger = new SessionArtifactPaths();
  recordArtifactPathsFromChatEvent(ledger, { type: 'tool_end', sessionId: 's', media: [{ path: produced }] });
  // The runtime's scope callback, minus the roots this file is outside of: the
  // ledger entry is the only thing that can admit it.
  const scoped = new MediaFiles(async (path, id) => id === 's' && ledger.has(id, path));
  fixtures.push({ ...f, media: scoped });
  const url = await scoped.grant(produced, 's');
  const served = await scoped.respond(new Request(url));
  assertEqual(served.status, 200, 'a produced file streams');
  assertEqual(await served.text(), 'mine', 'the exact bytes come back');
  assertEqual((await assertRejects(() => scoped.grant(stranger, 's'), 'unrecorded file') as Error).message, 'The file is outside this conversation', 'an unrecorded file is refused at grant time');
  assertEqual((await assertRejects(() => scoped.grant(produced, 'other'), 'other session') as Error).message, 'The file is outside this conversation', 'another conversation does not inherit the record');
});

h.test('encoded HTML and resource names preserve spaces, Unicode and literal percent signs', async () => {
  const f = await fixture(), entry = join(f.workspace, 'pages', 'report #1-中文.html');
  await writeFile(entry, '<script src="../assets/100%25%20done.js"></script>');
  await writeFile(join(f.workspace, 'assets', '100% done.js'), 'window.loaded = true;');
  const url = await f.media.grantHtmlPreview(entry, 's', f.workspace);
  assert(new URL(url).pathname.endsWith('report%20%231-%E4%B8%AD%E6%96%87.html'), 'entry encoding retains filename identity');
  assertEqual(await (await f.media.respond(new Request(url))).text(), '<script src="../assets/100%25%20done.js"></script>', 'encoded document');
  const resource = new URL('../assets/100%25%20done.js', url);
  assertEqual(await (await f.media.respond(new Request(resource, opaque))).text(), 'window.loaded = true;', 'resource is decoded exactly once');
});

h.test('preview refuses traversal, forged tokens, unsupported files, external origins and writes', async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, 'assets', 'secret.env'), 'FIXTURE_ONLY=private');
  for (const relative of vectors.refusedRelativePaths) {
    const response = await f.media.respond(new Request(new URL(relative, f.url)));
    assert(response.status === 403 || response.status === 404, relative);
  }
  const url = new URL(f.url);
  assertEqual((await f.media.respond(new Request(f.url.replace(url.pathname.split('/')[1]!, '0'.repeat(48))))).status, 404, 'unguessable token required');
  assertEqual((await f.media.respond(new Request(f.url, { headers: { Origin: 'https://outside.test' } }))).status, 403, 'external origin refused');
  assertEqual((await f.media.respond(new Request(f.url, { method: 'POST', ...opaque }))).status, 405, 'preview has no write surface');
  assertEqual((await f.media.respond(new Request(f.url.replace('://preview/', '://file/').replace(/\/pages\/report\.html$/u, '')))).status, 404, 'preview token is not an ordinary file grant');
  await assertRejects(() => f.media.grantHtmlPreview(f.entry, 'other', f.workspace), 'different conversation refused');
  await assertRejects(() => f.media.grantHtmlPreview(f.entry, 's', join(f.workspace, 'assets')), 'unrelated scope root refused');
});

h.test('relative resource and entry symlinks cannot escape after a capability is issued', async () => {
  const f = await fixture(), alias = join(f.workspace, 'assets', 'linked.json');
  await symlink(join(f.workspace, 'assets', 'data.json'), alias);
  const url = new URL('../assets/linked.json', f.url);
  const valid = await f.media.respond(new Request(url, opaque));
  assertEqual(valid.status, 200, 'in-scope symlink'); await valid.arrayBuffer();
  await rm(alias); await symlink(join(f.root, 'outside.json'), alias);
  assertEqual((await f.media.respond(new Request(url, opaque))).status, 403, 'same URL rechecks its new target');
  await writeFile(join(f.root, 'outside.html'), '<script>outside()</script>');
  await rm(f.entry); await symlink(join(f.root, 'outside.html'), f.entry);
  assertEqual((await f.media.respond(new Request(f.url))).status, 403, 'entry replacement also rechecks scope');
});

h.test('the preview preserves a symlink entry URL base and pins the granted root identity', async () => {
  const f = await fixture(), alias = join(f.workspace, 'report.html');
  await symlink(f.entry, alias);
  const url = await f.media.grantHtmlPreview(alias, 's', f.workspace);
  assert(new URL(url).pathname.endsWith('/report.html') && !new URL(url).pathname.endsWith('/pages/report.html'), 'relative base keeps the selected path');
  const moved = join(f.root, 'moved'); await rename(f.workspace, moved);
  await symlink(moved, f.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  assertEqual((await f.media.respond(new Request(f.url))).status, 403, 'root alias cannot retarget an existing grant');
});

h.test('scope changes and explicit revocation apply to every resource request', async () => {
  const f = await fixture(), resource = new URL('../assets/data.json', f.url);
  f.state.allowed = false;
  assertEqual((await f.media.respond(new Request(resource, opaque))).status, 403, 'current conversation scope is authoritative');
  f.state.allowed = true;
  f.media.revokeSession('s');
  assertEqual((await f.media.respond(new Request(f.url))).status, 404, 'deleted session loses the document');
  assert((await f.media.respond(new Request(resource, opaque))).status >= 400, 'deleted session loses relative resources');
  const replacement = await f.media.grantHtmlPreview(f.entry, 's', f.workspace);
  assert(replacement !== f.url, 'new authorization cannot resurrect an old token');
});

h.test('revocation during an asynchronous scope check prevents late grants and responses', async () => {
  const f = await fixture();
  const grantGate = blockNextScopeCheck(f), pendingGrant = f.media.grantHtmlPreview(f.entry, 's', f.workspace);
  await waitFor(grantGate.entered, 1000, 'grant reached scope check');
  f.media.revokeSession('s'); grantGate.release();
  await assertRejects(() => pendingGrant, 'revoked issuance never returns a capability');
  const url = await f.media.grantHtmlPreview(f.entry, 's', f.workspace);
  const responseGate = blockNextScopeCheck(f), pendingResponse = f.media.respond(new Request(url));
  await waitFor(responseGate.entered, 1000, 'response reached scope check');
  f.media.revokeSession('s'); responseGate.release();
  const response = await pendingResponse;
  assertEqual(response.status, 403, 'late scope answer cannot start streaming');
  assertEqual(await response.text(), '', 'no bytes after revocation');
});

h.test('revocation and directory removal stop open preview streams and fence new reads', async () => {
  const f = await fixture(), resource = join(f.workspace, 'assets', 'large.json');
  await writeFile(resource, Buffer.alloc(4 * 1024 * 1024));
  const url = new URL('../assets/large.json', f.url), response = await f.media.respond(new Request(url, opaque));
  f.media.revokeSession('s');
  await assertRejects(() => response.arrayBuffer(), 'revoke cancels the existing stream');
  const replacement = await f.media.grantHtmlPreview(f.entry, 's', f.workspace);
  const next = await f.media.respond(new Request(new URL('../assets/large.json', replacement), opaque));
  const release = await f.media.quiesceDirectory(f.workspace);
  try {
    assertEqual((await f.media.respond(new Request(replacement))).status, 423, 'workspace mutation fences new HTML reads');
    await assertRejects(() => next.arrayBuffer(), 'directory removal drains the active resource stream');
    await assertRejects(() => f.media.grantHtmlPreview(f.entry, 's', f.workspace), 'no grant during directory removal');
  } finally { release(); }
  const head = await f.media.respond(new Request(replacement, { method: 'HEAD' }));
  assertEqual(head.status, 200, 'release restores an unchanged workspace');
  assertEqual(await head.text(), '', 'HEAD never streams');
  f.media.close();
  assertEqual((await f.media.respond(new Request(replacement))).status, 410, 'shutdown closes preview reads');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'html-preview-result.json'), 'html-preview');
  for (const fixture of fixtures) { fixture.media.close(); await rm(fixture.root, { recursive: true, force: true }); }
  process.exit(failed);
})();
