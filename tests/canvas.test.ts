import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CanvasStore } from '../main/canvas/store';
import { CanvasDocumentStore } from '../main/canvas/document-store';
import { checkCanvas, sdkExports } from '../main/canvas/check';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';

const h = new Harness();
const root = mkdtempSync(join(__dirname, 'canvas-store-'));
const store = new CanvasStore(root, resolve(__dirname, '../../resources'));
const file = join(store.canvases, 'report.canvas.tsx');
const source = "import { Stack as Layout, Text } from 'klaus/canvas';\nexport default function Report(){return <Layout><Text>Report</Text></Layout>}";
const documentVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/canvas-document-vectors.json'), 'utf8')) as {
  first: { title: string }; second: { title: string }; expectedVersions: number[]; historyAfterRestore: number[];
};

h.test('provisioning uses the shipped SDK and heals managed edits without replacing authored files', () => {
  store.provision(); writeFileSync(file, source);
  const index = join(store.root, 'sdk', 'index.d.ts'); const expected = readFileSync(index, 'utf8');
  assert(sdkExports(expected).has('Stack'), 'the public SDK exports Stack');
  writeFileSync(index, 'damaged'); store.provision();
  assertEqual(readFileSync(index, 'utf8'), expected, 'managed declarations restored');
  assertEqual(readFileSync(file, 'utf8'), source, 'authored canvas retained');
});
h.test('static authoring diagnostics accept aliases and distinguish comments from executable mistakes', () => {
  assertDeepEqual(checkCanvas(source + '\n// fetch("outside") is unavailable', new Set(['Stack','Text']), true), [], 'clean source and named alias');
  const bad = checkCanvas("import { Stak } from 'klaus/canvas';\nimport x from 'node:fs';\nfetch ('/data');", new Set(['Stack']), true);
  assert(bad.some(item => item.message.includes('no default export')), 'default component required');
  assert(bad.some(item => item.message.includes("did you mean 'Stack'")), 'near miss names the real export');
  assert(bad.some(item => item.message.includes('Node built-ins')), 'unresolvable import reason');
  assert(bad.some(item => item.line === 3 && item.message.includes('network')), 'actual spaced fetch call reported');
});
h.test('load and state merge return the page contract using actual sidecar files', () => {
  assertEqual(store.check(file).clean, true, 'shipped declaration check');
  store.writeState(file, { count: 2 }); store.writeState(file, { choice: 'b' });
  const reply = store.load(file);
  assertEqual(reply.source, source, 'source bytes'); assertEqual(reply.themeKind, 'dark', 'first paint theme present');
  assertDeepEqual(reply.data, { count: 2, choice: 'b' }, 'coalesced state merges');
  assertEqual((store.list().canvases as unknown[]).length, 1, 'actual authored file listed');
});
h.test('versioned documents preserve edits, reject stale writes and restore prior revisions', () => {
  const documents = new CanvasDocumentStore(store.root, input => store.path(input));
  assertDeepEqual(documents.get(file), { version: 0, document: null }, 'new project');
  assertEqual(documents.apply(file, documentVector.expectedVersions[0], documentVector.first).version, documentVector.expectedVersions[1], 'first revision');
  assertEqual(documents.apply(file, documentVector.expectedVersions[1], documentVector.second).version, documentVector.expectedVersions[2], 'second revision');
  let conflict = false;
  try { documents.apply(file, documentVector.expectedVersions[1], { title: 'Stale' }); } catch (error) { conflict = String(error).includes('version conflict'); }
  assert(conflict, 'stale author refused');
  assertDeepEqual(documents.get(file), { version: documentVector.expectedVersions[2], document: documentVector.second }, 'latest document preserved');
  assertDeepEqual((documents.history(file).revisions as Array<{ version: number }>).map(row => row.version), [documentVector.expectedVersions[1]], 'previous revision available');
  assertDeepEqual(documents.restore(file, documentVector.expectedVersions[2], documentVector.expectedVersions[1]), { version: documentVector.expectedVersions[3], document: documentVector.first }, 'restore creates a new revision');
  assertDeepEqual((documents.history(file).revisions as Array<{ version: number }>).map(row => row.version), documentVector.historyAfterRestore, 'later version remains recoverable');
  let oversized = false;
  try { documents.apply(file, 3, { data: 'x'.repeat(2 * 1024 * 1024) }); } catch { oversized = true; }
  assert(oversized, 'oversized project refused');
});
h.test('versioned document paths cannot read outside Canvas or follow symlinks', () => {
  const documents = new CanvasDocumentStore(store.root, input => store.path(input));
  const outside = join(root, 'outside-document.canvas.tsx'); writeFileSync(outside, source);
  let refused = false;
  try { documents.apply(outside, 0, { title: 'Escaped' }); } catch { refused = true; }
  assert(refused, 'outside project refused');
  const linked = join(store.canvases, 'linked.canvas.document.json'); symlinkSync(outside, linked);
  const canvas = join(store.canvases, 'linked.canvas.tsx'); writeFileSync(canvas, source);
  refused = false;
  try { documents.get(canvas); } catch { refused = true; }
  assert(refused, 'linked project refused');
});
h.test('out-of-scope paths and symbolic links cannot become Canvas reads or state writes', () => {
  const outside = join(root, 'outside.canvas.tsx'); writeFileSync(outside, source);
  const linked = join(store.canvases, 'link.canvas.tsx'); symlinkSync(outside, linked);
  for (const path of [outside, linked, join(store.canvases, '..', '..', 'outside.canvas.tsx')]) {
    let rejected = false; try { store.load(path); } catch { rejected = true; } assert(rejected, 'out-of-scope canvas refused');
  }
  const sidecar = file.replace(/\.tsx$/, '.data.json'); rmSync(sidecar); symlinkSync(outside, sidecar);
  let rejected = false; try { store.writeState(file, { changed: true }); } catch { rejected = true; }
  assert(rejected, 'symbolic state target refused'); assertEqual(readFileSync(outside, 'utf8'), source, 'outside bytes untouched');
});

void h.finish(join(__dirname, 'canvas-result.json'), 'canvas').then(code => { rmSync(root, { recursive: true, force: true }); process.exit(code); });
