import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import {
  SessionArtifactPaths,
  recordArtifactPathsFromChatEvent,
  recordArtifactPathsFromHistory,
} from '../main/services/artifact-paths';
import { assert, Harness } from './harness';
import { MediaFiles } from '../main/services/media-files';
import { mapChatEvents } from '../main/ipc/project';
import { projectSessionHistory } from '../main/sessions/history';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';

const h = new Harness();
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-artifact-paths-'));
  roots.push(root);
  const outside = join(root, 'downloads');
  await mkdir(outside);
  const file = join(outside, 'cover.png');
  await writeFile(file, 'bytes');
  return { root, outside, file };
}

h.test('a diff_update records the path this conversation wrote', async () => {
  const { file } = await fixture();
  const ledger = new SessionArtifactPaths();
  recordArtifactPathsFromChatEvent(ledger, {
    type: 'diff_update', sessionId: 's1', turnId: 't1',
    changes: [{ path: file, kind: 'create', added: 1, removed: 0 }],
  });
  assert(ledger.has('s1', file), 'the written path is admitted');
  assert(!ledger.has('s2', file), 'another conversation does not inherit it');
});

h.test('a tool_end records both its published media and the file it read back', async () => {
  const { file, outside } = await fixture();
  const read = join(outside, 'checked.png');
  await writeFile(read, 'bytes');
  const ledger = new SessionArtifactPaths();
  recordArtifactPathsFromChatEvent(ledger, {
    type: 'tool_end', sessionId: 's1', toolName: 'generate_image', isError: false,
    media: [{ path: file, mimeType: 'image/png' }], content: '',
  });
  recordArtifactPathsFromChatEvent(ledger, {
    type: 'tool_end', sessionId: 's1', toolName: 'read', isError: false,
    content: JSON.stringify({ path: read, found: true, kind: 'image' }),
  });
  assert(ledger.has('s1', file), 'a published image is admitted');
  assert(ledger.has('s1', read), 'a path the agent read back is admitted');
});

h.test('prose is not a path: a failed read and a mentioned path are refused', async () => {
  const { outside } = await fixture();
  const ledger = new SessionArtifactPaths();
  recordArtifactPathsFromChatEvent(ledger, {
    type: 'tool_end', sessionId: 's1', toolName: 'read', isError: true,
    content: JSON.stringify({ path: join(outside, 'missing.png'), found: false }),
  });
  recordArtifactPathsFromChatEvent(ledger, {
    type: 'tool_end', sessionId: 's1', toolName: 'bash', isError: false,
    content: `wrote ${join(outside, 'mentioned.png')} and finished`,
  });
  assert(!ledger.has('s1', join(outside, 'missing.png')), 'a file that was not found is not produced');
  assert(!ledger.has('s1', join(outside, 'mentioned.png')), 'a path in prose is not a record');
});

h.test('the real path matches a record made with a symlinked spelling', async () => {
  // macOS tmpdir resolves /var/folders/… or /tmp to /private/var/… and /private/tmp,
  // which is exactly the mismatch this canonicalization exists for: the renderer
  // asks with the reported spelling, while the media channel re-checks scope with
  // the REAL one (media-files.ts respond). Without both spellings the file is
  // admitted at grant time and refused at serve time — a blank image, no error.
  const dir = await mkdtemp('/tmp/klaus-artifact-paths-');
  roots.push(dir);
  const file = join(dir, 'cover.png');
  await writeFile(file, 'bytes');
  const real = await realpath(file);
  assert(real !== file, `this test needs a symlinked spelling, got ${file} === ${real}`);

  // The production wiring: runtime.ts passes realpathSync as the canonicalizer.
  const ledger = new SessionArtifactPaths({ canonicalize: path => realpathSync(path) });
  recordArtifactPathsFromChatEvent(ledger, { type: 'diff_update', sessionId: 's1', changes: [{ path: file, kind: 'create' }] });
  assert(ledger.has('s1', file), 'the reported spelling matches');
  assert(ledger.has('s1', real), 'the real spelling matches, which is what the media channel checks');

  // The hook is load-bearing: without it the real spelling is refused.
  const naive = new SessionArtifactPaths();
  recordArtifactPathsFromChatEvent(naive, { type: 'diff_update', sessionId: 's1', changes: [{ path: file, kind: 'create' }] });
  assert(naive.has('s1', file), 'the reported spelling still matches');
  assert(!naive.has('s1', real), 'and the real spelling does not — this is the blank-image bug');
});

h.test('relative and foreign shapes are ignored rather than admitted', () => {
  const ledger = new SessionArtifactPaths();
  ledger.record('s1', 'image-1.png');
  ledger.record('s1', '/tmp/x\u0000y.png');
  ledger.record('', '/tmp/z.png');
  recordArtifactPathsFromChatEvent(ledger, { type: 'diff_update', changes: [{ path: '/tmp/no-session.png' }] });
  recordArtifactPathsFromChatEvent(ledger, { type: 'tool_end', sessionId: 's1', content: 'not json' });
  assert(!ledger.has('s1', 'image-1.png'), 'a relative path is not absolute scope');
  assert(!ledger.has('s1', '/tmp/x\u0000y.png'), 'a NUL path is refused');
  assert(!ledger.has('', '/tmp/z.png'), 'an event without a session records nothing');
  assert(!ledger.has('s1', '/tmp/no-session.png'), 'a diff_update without a session records nothing');
});

h.test('a per-session cap stops growth without evicting what was already recorded', () => {
  const ledger = new SessionArtifactPaths({ limits: { sessions: 2, pathsPerSession: 3 } });
  ledger.recordMany('s1', ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png', '/tmp/d.png']);
  assert(ledger.has('s1', '/tmp/a.png'), 'the first records survive');
  assert(!ledger.has('s1', '/tmp/d.png'), 'the cap refuses new paths instead of dropping old ones');
  // Session rotation: admitting a third session forgets the oldest.
  ledger.record('s2', '/tmp/e.png');
  ledger.record('s3', '/tmp/f.png');
  assert(!ledger.has('s1', '/tmp/a.png'), 'the oldest session is rotated out');
  assert(ledger.has('s3', '/tmp/f.png'), 'the newest session is kept');
});

h.test('explicit preview selection is admitted even when tool paths filled the ledger', () => {
  const ledger = new SessionArtifactPaths({ limits: { sessions: 2, pathsPerSession: 2 } });
  ledger.recordMany('s1', ['/tmp/old.png', '/tmp/recent.png']);
  ledger.record('s1', '/tmp/selected.md', true);
  assert(ledger.has('s1', '/tmp/selected.md'), 'the selected file is admitted');
  assert(ledger.has('s1', '/tmp/recent.png'), 'the newer tool path survives');
  assert(!ledger.has('s1', '/tmp/old.png'), 'the oldest entry makes room within the bound');
});

h.test('forget drops one conversation and nothing else', () => {
  const ledger = new SessionArtifactPaths();
  ledger.record('s1', '/tmp/a.png');
  ledger.record('s2', '/tmp/b.png');
  ledger.forget('s1');
  assert(!ledger.has('s1', '/tmp/a.png'), 'the forgotten conversation loses its paths');
  assert(ledger.has('s2', '/tmp/b.png'), 'another conversation is untouched');
});

h.test('a projected history re-fills the ledger, so a reload does not blank the images', async () => {
  const { file, outside } = await fixture();
  const pooled = join(outside, 'pooled.png');
  await writeFile(pooled, 'bytes');
  const history: Json = {
    messages: [
      { id: 'm1', role: 'assistant', contentBlocks: [
        { type: 'tool_use', id: 'c1', name: 'read', __result: { path: file, found: true, kind: 'image' } },
        { type: 'tool_use', id: 'c2', name: 'generate_image', __result: { text: 'Saved', isError: false,
          content: [{ type: 'image', path: pooled, mimeType: 'image/png' }] } },
      ] },
      { id: 'm2', role: 'assistant', contentBlocks: [{ type: 'image', path: pooled }] },
    ],
  };
  const ledger = new SessionArtifactPaths();
  recordArtifactPathsFromHistory(ledger, 's1', history);
  assert(ledger.has('s1', file), 'a path the agent read back is re-admitted');
  assert(ledger.has('s1', pooled), 'a published image is re-admitted');
  recordArtifactPathsFromHistory(ledger, '', history);
  assert(!ledger.has('', file), 'a history without a session records nothing');
});


h.test('child tool media and direct file changes are recorded under the parent owner only', async () => {
  const { file } = await fixture(), ledger = new SessionArtifactPaths();
  const events: Json[] = [{ type: 'tool_end', sessionId: 'foreign', media: [{ path: file }] },
    { type: 'diff_update', sessionId: 'foreign', changes: [{ path: file }] }];
  for (const event of events) {
    recordArtifactPathsFromChatEvent(ledger, { type: 'agent_progress', sessionId: 'parent', agentId: 'child', event });
  }
  assert(ledger.has('parent', file), 'trusted child artifacts survive inside the parent scope');
  assert(!ledger.has('foreign', file) && !ledger.has('child', file), 'inner stream ids grant no file access');
  const ignored = join(file, 'prose.png');
  recordArtifactPathsFromChatEvent(ledger, { type: 'agent_progress', sessionId: 'parent', event: { type: 'text', text: ignored } });
  assert(!ledger.has('parent', ignored), 'prose is never an artifact grant');
});

async function publicationFixture() {
  const { root, outside } = await fixture(), output = join(root, 'artifacts');
  await mkdir(output);
  const file = join(output, 'live-changelog-header.png');
  await writeFile(file, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
  const ledger = new SessionArtifactPaths({ canonicalize: realpathSync, publishedImageRoot: output });
  const media = new MediaFiles(async (path, sessionId) => ledger.has(sessionId, path));
  const text = `The screenshot is ready.\n\n![Verified header](<${file}>)`;
  return { root, outside, output, file, ledger, media, text };
}

function historyForPublication(text: string): Json {
  return { history: [
    { type: 'assistant', uuid: 'shell-call', content: [{ type: 'tool_use', id: 'shell', name: 'bash', input: { command: 'node capture.mjs' } }] },
    { type: 'tool_result', toolUseId: 'shell', content: [{ type: 'text', text: 'Header measurement complete' }],
      output: { exitCode: 0, timedOut: false, aborted: false } },
    { type: 'assistant', uuid: 'final', content: [{ type: 'text', text }] },
  ], finalMessageIds: ['final'] };
}

h.test('a shell screenshot becomes readable before its final image delta is forwarded', async () => {
  const { file, ledger, media, text } = await publicationFixture();
  const url = `klaus-media://localhost/${Buffer.from(file).toString('base64url')}?s=s1`;
  assert((await media.respond(new Request(url))).status === 403, 'a shell write alone does not grant a read');
  for (const delta of [text.slice(0, -2), text.slice(-2)]) {
    const events = mapChatEvents({ type: 'productEvent', method: 'item/agentMessage/delta',
      params: { sessionId: 's1', messageId: 'final', phase: 'final_answer', delta } });
    for (const event of events) recordArtifactPathsFromChatEvent(ledger, event);
  }
  const response = await media.respond(new Request(url));
  assert(response.status === 200, 'the published screenshot is served');
  assert(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(PNG_FIXTURE_BASE64, 'base64')), 'the original image bytes are preserved');
  assert(!ledger.has('s2', file), 'another chat does not inherit the publication');
  media.close();
});

h.test('cold history restores an actual shell result followed by a final Markdown screenshot', async () => {
  const { root, output, file, ledger, media, text } = await publicationFixture();
  const history = projectSessionHistory(historyForPublication(text), 's1', root);
  recordArtifactPathsFromHistory(ledger, 's1', history);
  assert(ledger.has('s1', file), 'a projected final restores the exact screenshot without tool media');
  const restarted = new SessionArtifactPaths({ canonicalize: realpathSync, publishedImageRoot: output });
  recordArtifactPathsFromHistory(restarted, 's1', history);
  const reopened = new MediaFiles(async (path, id) => restarted.has(id, path));
  const response = await reopened.respond(new Request(await reopened.grant(file, 's1')));
  assert(response.status === 200, 'a fresh host restores the saved publication');
  await response.arrayBuffer();
  media.close(); reopened.close();
});

h.test('a screenshot embedded inside a Markdown table publishes the exact file', async () => {
  const { ledger, file } = await publicationFixture();
  recordArtifactPathsFromHistory(ledger, 's1', { messages: [{ role: 'assistant', text:
    `| Check | Evidence |\n|---|---|\n| fonts | ![glyphs](${file}) |` }] });
  assert(ledger.has('s1', file), 'a table-cell image is still an explicit publication');
});

h.test('an image-like token in a table code span is not a publication', async () => {
  const { ledger, file } = await publicationFixture();
  recordArtifactPathsFromHistory(ledger, 's1', { messages: [{ role: 'assistant', text:
    `| Check | Evidence |\n|---|---|\n| example | \`![glyphs](${file})\` |` }] });
  assert(!ledger.has('s1', file), 'inline code does not grant a media capability');
});

h.test('managed publications refuse prose, tool stdout, user images, code and arbitrary paths', async () => {
  const { ledger, file, outside } = await publicationFixture();
  const other = join(outside, 'private.png');
  await writeFile(other, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
  recordArtifactPathsFromChatEvent(ledger, { type: 'tool_end', sessionId: 's1', content: `![output](${file})` });
  recordArtifactPathsFromHistory(ledger, 's1', { messages: [
    { role: 'user', text: `![input](${file})` },
    { role: 'assistant', text: `Saved at ${file}\n\n\`\`\`markdown\n![example](${file})\n\`\`\`\n\n    ![indented](${file})\n\n\`![inline](${file})\`\n\n![outside](${other})` },
  ] });
  assert(!ledger.has('s1', file) && !ledger.has('s1', other), 'only an explicit eligible assistant embed grants a file');
});

h.test('managed publications accept only the current nested output directory and contained real files', async () => {
  const { output, outside, ledger, file } = await publicationFixture();
  const owned = join(output, 's1'), foreign = join(output, 's2');
  await mkdir(owned); await mkdir(foreign);
  const ownFile = join(owned, 'UI shot (one).png'), foreignFile = join(foreign, 'UI.png'), escaped = join(owned, 'escape.png');
  await writeFile(ownFile, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
  await writeFile(foreignFile, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
  await symlink(file, join(outside, 'alias.png'));
  await symlink(join(outside, 'cover.png'), escaped);
  recordArtifactPathsFromHistory(ledger, 's1', { messages: [{ role: 'assistant', text:
    `![own](<${ownFile}>)\n\n![foreign](${foreignFile})\n\n![escape](${escaped})\n\n![alias](${join(outside, 'alias.png')})` }] });
  assert(ledger.has('s1', ownFile), 'spaces and parentheses are published from the owned directory');
  assert(!ledger.has('s1', foreignFile) && !ledger.has('s1', escaped) && !ledger.has('s1', file), 'foreign directories and symlink spellings cannot escape the publication boundary');
});

h.test('streaming code fences survive deltas and oversized messages never publish a suffix', async () => {
  const { ledger, file } = await publicationFixture();
  for (const text of ['```markdown\n', `![example](${file})`, '\n```']) {
    recordArtifactPathsFromChatEvent(ledger, { type: 'text_delta', sessionId: 's1', messageId: 'code', text });
  }
  recordArtifactPathsFromChatEvent(ledger, { type: 'message_complete', sessionId: 's1', messageId: 'code' });
  recordArtifactPathsFromChatEvent(ledger, { type: 'text_delta', sessionId: 's1', messageId: 'huge', text: 'x'.repeat(1024 * 1024 + 1) });
  recordArtifactPathsFromChatEvent(ledger, { type: 'text_delta', sessionId: 's1', messageId: 'huge', text: `\n![suffix](${file})` });
  assert(!ledger.has('s1', file), 'an incomplete bounded message cannot turn code into an image grant');
});

h.test('child publications use the parent owner and independent streaming buffers', async () => {
  const { ledger, file } = await publicationFixture();
  recordArtifactPathsFromChatEvent(ledger, { type: 'text_delta', sessionId: 'parent', messageId: 'same', text: '```\n' });
  recordArtifactPathsFromChatEvent(ledger, { type: 'agent_progress', sessionId: 'parent', agentId: 'child',
    event: { type: 'text_delta', sessionId: 'foreign', messageId: 'same', text: `![header](${file})` } });
  assert(ledger.has('parent', file), 'the child publishes under the parent conversation');
  assert(!ledger.has('child', file) && !ledger.has('foreign', file), 'inner identities never authorize another chat');
});

const exactFiles = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/ui-screenshot-delivery.json'), 'utf8')).exactFileCases as
  Array<{ name: string; toolName: string; output: Json; allowed: boolean }>;
for (const vector of exactFiles) h.test(`exact tool file contract: ${vector.name}`, async () => {
  const { root, file } = await fixture();
  await writeFile(file, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
  const sibling = join(root, 'downloads', 'unrelated.png');
  await writeFile(sibling, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
  const replace = (value: Json): Json => {
    if (typeof value === 'string') return value === '{exportJson}' ? JSON.stringify({ id: 'design', format: 'png', path: file }) : value.replaceAll('{file}', file);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    return value;
  };
  const output = replace(vector.output), ledger = new SessionArtifactPaths({ canonicalize: realpathSync });
  const events = mapChatEvents({ type: 'productEvent', method: 'item/completed', params: { sessionId: 's1', item: {
    type: 'tool_call', id: 'file-call', toolName: vector.toolName, status: 'completed', result: output,
  } } });
  for (const event of events) recordArtifactPathsFromChatEvent(ledger, event);
  assert(ledger.has('s1', file) === vector.allowed, 'live projection preserves only successful declared files');
  const history = projectSessionHistory({ history: [
    { type: 'assistant', uuid: 'call', content: [{ type: 'tool_use', id: 'file-call', name: vector.toolName, input: {} }] },
    { type: 'tool_result', toolUseId: 'file-call', content: typeof output === 'object' && output && !Array.isArray(output) ? output.content ?? [] : [], output },
  ] }, 's1', root);
  const cold = new SessionArtifactPaths({ canonicalize: realpathSync });
  recordArtifactPathsFromHistory(cold, 's1', history);
  assert(cold.has('s1', file) === vector.allowed, 'cold projection preserves the same exact file authority');
  assert(!cold.has('other-chat', file), 'another chat gets no grant');
  const media = new MediaFiles(async (path, id) => cold.has(id, path));
  const url = `klaus-media://localhost/${Buffer.from(file).toString('base64url')}?s=s1`;
  const response = await media.respond(new Request(url));
  assert(response.status === (vector.allowed ? 200 : 403), 'the real media route enforces restored authority');
  await response.arrayBuffer();
  const unrelated = await media.respond(new Request(`klaus-media://localhost/${Buffer.from(sibling).toString('base64url')}?s=s1`));
  assert(unrelated.status === 403, 'a confirmed export grants no directory or sibling access');
  media.close();
});

h.test('failed terminal calls and failed history reads cannot authorize a reported path', async () => {
  const { root, file } = await fixture();
  const ledger = new SessionArtifactPaths();
  for (const event of mapChatEvents({ type: 'productEvent', method: 'item/completed', params: { sessionId: 's1', item: {
    type: 'tool_call', id: 'failed-read', toolName: 'read', status: 'failed', result: { path: file, found: true },
  } } })) recordArtifactPathsFromChatEvent(ledger, event);
  const history = projectSessionHistory({ history: [
    { type: 'assistant', uuid: 'call', content: [{ type: 'tool_use', id: 'failed-read', name: 'read', input: { path: file } }] },
    { type: 'tool_result', toolUseId: 'failed-read', isError: true, content: [], output: { path: file, found: true } },
  ] }, 's1', root);
  recordArtifactPathsFromHistory(ledger, 's1', history);
  assert(!ledger.has('s1', file), 'failure status overrides a success-shaped payload');
});

h.test('a read image retains its original identity after pooling and cold history restore', async () => {
  const { root, file } = await fixture();
  const history = projectSessionHistory({ history: [
    { type: 'assistant', uuid: 'call', content: [{ type: 'tool_use', id: 'read-file', name: 'read', input: { path: file } }] },
    { type: 'tool_result', toolUseId: 'read-file', content: [{ type: 'image', mimeType: 'image/png', base64: PNG_FIXTURE_BASE64 }],
      output: { path: file, found: true, kind: 'image' } },
  ] }, 's1', root) as Record<string, Json>;
  const message = (history.messages as Array<Record<string, Json>>)[0]!;
  const call = (message.contentBlocks as Array<Record<string, Json>>)[0]!;
  const result = call.__result as Record<string, Json>;
  const image = (result.content as Array<Record<string, Json>>).find(block => block.type === 'image')!;
  assert(image.sourcePath === file && image.path !== file, 'the pooled bytes keep the exact original alias');
  const cold = new SessionArtifactPaths({ canonicalize: realpathSync });
  recordArtifactPathsFromHistory(cold, 's1', history);
  assert(cold.has('s1', file), 'the source file remains authorized after reopening');
  assert(cold.has('s1', image.path as string), 'the stable image copy is also available');
});

h.test('a saved read image recovers its source identity when result metadata is stored separately', async () => {
  const { root, file } = await fixture();
  const history = projectSessionHistory({ history: [
    { type: 'assistant', uuid: 'call', content: [{ type: 'tool_use', id: 'read-file', name: 'Read', input: { file_path: file } }] },
    { type: 'tool_result', toolUseId: 'read-file', content: [{ type: 'image', mimeType: 'image/png', base64: PNG_FIXTURE_BASE64 }] },
  ] }, 's1', root) as Record<string, Json>;
  const message = (history.messages as Array<Record<string, Json>>)[0]!;
  const call = (message.contentBlocks as Array<Record<string, Json>>)[0]!;
  const result = call.__result as Record<string, Json>;
  const image = (result.content as Array<Record<string, Json>>).find(block => block.type === 'image')!;
  assert(image.sourcePath === file && image.path !== file, 'the pooled image keeps the source identity from its owning read call');
  const cold = new SessionArtifactPaths({ canonicalize: realpathSync });
  recordArtifactPathsFromHistory(cold, 's1', history);
  assert(cold.has('s1', image.path as string), 'cold history still authorizes the immutable image bytes');
});

const publications = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/ui-screenshot-delivery.json'), 'utf8')).publicationCases as
  Array<{ name: string; source: string; path: string; allowed: boolean }>;
for (const vector of publications) h.test(`managed image publication contract: ${vector.name}`, async () => {
  const { output, ledger } = await publicationFixture(), file = join(output, vector.path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
  const image = `![Screenshot](<${file}>)`;
  if (vector.source === 'tool-output') recordArtifactPathsFromChatEvent(ledger, { type: 'tool_end', sessionId: 's1', content: image });
  else recordArtifactPathsFromHistory(ledger, 's1', { messages: [{
    role: vector.source === 'user-image' ? 'user' : 'assistant',
    text: vector.source === 'assistant-code' ? `\`\`\`markdown\n${image}\n\`\`\``
      : vector.source === 'assistant-table' ? `| Evidence |\n|---|\n| ${image} |`
      : vector.source === 'assistant-prose' ? `Saved at ${file}`
      : vector.source === 'assistant-link' ? `[Screenshot](<${file}>)` : image,
  }] });
  assert(ledger.has('s1', file) === vector.allowed, vector.name);
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'artifact-paths-result.json'), 'artifact-paths');
  for (const root of roots) await rm(root, { recursive: true, force: true });
  process.exit(failed);
})();
