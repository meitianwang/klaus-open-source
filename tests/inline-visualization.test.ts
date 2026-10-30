// The inline-visualization read path, end to end through the shared module.
//
// The renderer never reads a page: history projection (and the settle frame)
// carries the content, read once under this whitelist. So the security
// boundary for "the model asked to mount a page in the transcript" is
// `readInlineVisFragment` / its synchronous twin / `readInlineVisPage`, and
// every test below pins one refusal direction the shared contract promises:
// containment in the conversation's own visualization directory (with a
// symlink escape refused), the kebab-case file-name shape, the 1 MB cap, and
// the happy path that returns the page text. A refusal is DATA — a fragment
// with `contents: null` and a `readError` — because the transcript renders an
// honest failure card from it; a line the pure half refuses yields NO
// fragment, which is what keeps the directive visible as text. Appear/disappear
// is asserted in BOTH directions because a whitelist that only ever refuses is
// a feature that silently stopped working.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerFileHandlers } from '../main/ipc/handlers/files';
import { ensureSessionVisualizationsDir, sessionVisualizationsDir } from '../main/services/visualizations';
import { attachInlineVisFragments, readInlineVisFragment, readInlineVisFragmentsSync, readInlineVisFragmentSync } from '../main/services/inline-vis-read';
import { WorkspaceStore } from '../main/services/workspaces';
import { assert, assertEqual, Harness } from './harness';

const h = new Harness();
const roots: string[] = [];

interface VisReply { ok?: boolean; url?: string; html?: string; error?: string }
interface Fixture { root: string; visDir: string; content: (filePath: string, sessionId?: string) => Promise<VisReply>; line: (path: string) => string }

function fixture(): Fixture {
  // The whole fixture tree sits under a REAL path (html-preview-fixture.ts's
  // rule): /var is a symlink to /private/var on macOS, and a scope root built
  // on the unresolved tmpdir spelling makes the realpath containment checks
  // fail for legitimate pages.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'klaus-inline-vis-')));
  roots.push(root);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const registry = new ChannelRegistry();
  const visDir = sessionVisualizationsDir(root, 's1');
  ensureSessionVisualizationsDir(root, 's1');
  const files = registerFileHandlers(registry, {
    workspaces, push: () => {},
    openPath: async () => {}, revealPath: async () => {}, trashPath: async () => {},
    openPreviewWindow: async () => {},
    requestSession: async () => ({}),
  });
  return {
    root, visDir,
    content: (filePath, sessionId = 's1') => files.inlineVisualizationContent({ sessionId, filePath }) as Promise<VisReply>,
    line: path => `::klaus-inline-vis{path="${path}"}`,
  };
}

h.test('a page in the conversation directory is projected with its content', async () => {
  const f = fixture();
  const page = join(f.visDir, 'home-dashboard.html');
  writeFileSync(page, '<html><body>ok</body></html>');
  const fragment = await readInlineVisFragment(f.root, 's1', f.line(page));
  assertEqual(fragment?.contents, '<html><body>ok</body></html>', 'the page text rides the fragment');
  assertEqual(fragment?.path, page, 'the fragment names the projected page');
  // The synchronous twin the event pump uses makes the same decision.
  assertEqual(readInlineVisFragmentSync(f.root, 's1', f.line(page))?.contents, '<html><body>ok</body></html>', 'the synchronous twin reads the same bytes');
});

h.test('a page OUTSIDE the visualization directory is refused as data', async () => {
  const f = fixture();
  const stranger = join(f.root, 'workspace', 'evil.html');
  writeFileSync(stranger, '<html></html>');
  const fragment = await readInlineVisFragment(f.root, 's1', f.line(stranger));
  assertEqual(fragment?.contents, null, 'no content for a stranger');
  assertEqual(fragment?.readError, 'outside the visualization directory', 'the refusal names containment');
});

h.test('a symlink INSIDE the directory pointing out is refused (realpath containment)', async () => {
  const f = fixture();
  const secret = join(f.root, 'secret.html');
  writeFileSync(secret, '<html>secret</html>');
  symlinkSync(secret, join(f.visDir, 'escape.html'));
  const fragment = await readInlineVisFragment(f.root, 's1', f.line(join(f.visDir, 'escape.html')));
  assertEqual(fragment?.contents, null, 'no content through the symlink');
  assert(fragment?.readError, 'the escape names its refusal');
});

h.test('a name that is not kebab-case .html yields NO fragment, so the line stays text', async () => {
  const f = fixture();
  for (const name of ['Page.HTML', 'my_page.html', 'page.htm']) {
    assertEqual(await readInlineVisFragment(f.root, 's1', f.line(join(f.visDir, name))), null, name);
    assertEqual(readInlineVisFragmentSync(f.root, 's1', f.line(join(f.visDir, name))), null, `${name} sync twin`);
  }
});

h.test('a well-formed name whose page is missing is a refusal fragment, not silence', async () => {
  const f = fixture();
  const fragment = await readInlineVisFragment(f.root, 's1', f.line(join(f.visDir, 'sub-dir-page.html')));
  assertEqual(fragment?.contents, null, 'no content for a missing page');
  assertEqual(fragment?.readError, 'file not found', 'the transcript can name the missing page');
});

h.test("another conversation's visualization directory is refused for this one", async () => {
  const f = fixture();
  const other = sessionVisualizationsDir(f.root, 's2');
  mkdirSync(other, { recursive: true });
  const page = join(other, 'theirs.html');
  writeFileSync(page, '<html></html>');
  const fragment = await readInlineVisFragment(f.root, 's1', f.line(page));
  assertEqual(fragment?.contents, null, 'no content for another conversation');
  assertEqual(fragment?.readError, 'outside the visualization directory', 'cross-conversation containment');
});

h.test('a page over the 1 MB cap is refused even inside the directory', async () => {
  const f = fixture();
  const big = join(f.visDir, 'big-page.html');
  writeFileSync(big, '<html>' + 'x'.repeat(1024 * 1024) + '</html>');
  const bigFragment = await readInlineVisFragment(f.root, 's1', f.line(big));
  assertEqual(bigFragment?.contents, null, 'no content over the cap');
  assertEqual(bigFragment?.readError, 'visualization too large', 'the refusal names the cap');
  // Just under the cap is fine: the boundary is inclusive.
  const ok = join(f.visDir, 'ok-page.html');
  const body = '<html>' + 'x'.repeat(1024 * 1024 - 20) + '</html>';
  writeFileSync(ok, body);
  assertEqual((await readInlineVisFragment(f.root, 's1', f.line(ok)))?.contents, body, 'just under the cap is granted');
});

h.test('projection attaches fragments to assistant text blocks only', async () => {
  const f = fixture();
  const page = join(f.visDir, 'home-dashboard.html');
  writeFileSync(page, '<html><body>ok</body></html>');
  const directive = f.line(page);
  const projected = {
    messages: [
      { role: 'user', contentBlocks: [{ type: 'text', text: directive }] },
      { role: 'assistant', contentBlocks: [{ type: 'text', text: `Here it is.\n${directive}` }, { type: 'thinking', thinking: directive }] },
    ],
  };
  await attachInlineVisFragments(projected, 's1', f.root);
  const rows = projected.messages as Array<Record<string, any>>;
  assertEqual(rows[0]!.contentBlocks[0].inlineVis, undefined, 'a user row never carries page content');
  const blocks = rows[1]!.contentBlocks;
  assertEqual(blocks[0].inlineVis?.length, 1, 'the assistant text block carries the fragment');
  assertEqual(blocks[0].inlineVis[0].contents, '<html><body>ok</body></html>', 'with its content');
  assertEqual(blocks[1].inlineVis, undefined, 'a thinking block is not a directive surface');
});

h.test('the message-text scan reads every directive line in order', async () => {
  const f = fixture();
  const first = join(f.visDir, 'first-page.html');
  const second = join(f.visDir, 'second-page.html');
  writeFileSync(first, '<html>1</html>');
  writeFileSync(second, '<html>2</html>');
  const text = `intro\n${f.line(first)}\nprose\n${f.line(second)}\n${f.line(join(f.root, 'workspace', 'missing.html'))}`;
  const fragments = readInlineVisFragmentsSync(f.root, 's1', text);
  assertEqual(fragments.length, 3, 'every directive line in order');
  assertEqual(fragments[0]?.contents, '<html>1</html>', 'first page content');
  assertEqual(fragments[1]?.contents, '<html>2</html>', 'second page content');
  assertEqual(fragments[2]?.contents, null, 'a missing page is a refusal, not a skip');
});

h.test('remote inline pages use the committed bounded content whitelist', async () => {
  const f = fixture();
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-inline-visualization-vectors.json'), 'utf8')) as { cases: { name: string; relativePath: string; sessionId: string; bytes?: number; html?: string; allowed: boolean }[] };
  for (const vector of vectors.cases) {
    const path = join(f.root, vector.relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    const html = vector.html ?? 'x'.repeat(vector.bytes ?? 0);
    writeFileSync(path, html);
    const reply = await f.content(path, vector.sessionId);
    assertEqual(reply.ok === true, vector.allowed, vector.name);
    if (vector.allowed) assertEqual(reply.html, html, 'exact bounded HTML');
    else assert(!reply.html, 'a refused page returns no contents');
  }
});

h.test('remote inline content refuses a visualization symlink escape', async () => {
  const f = fixture(), secret = join(f.root, 'secret.html'), link = join(f.visDir, 'escape.html');
  writeFileSync(secret, '<html>private</html>');
  symlinkSync(secret, link);
  const reply = await f.content(link);
  assert(!reply.ok && !reply.html && reply.error, 'escape returns no bytes');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'inline-visualization-result.json'), 'inline-visualization');
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exit(failed);
})();
