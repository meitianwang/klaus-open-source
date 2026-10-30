import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CanvasDocumentStore } from '../main/canvas/document-store';
import { LegacyPrototypeImportError, planLegacyPrototypeImport, resolveLegacyImportStep } from '../main/prototype/legacy';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1cAAAAASUVORK5CYII=';
function layer(overrides: Record<string, unknown> = {}) {
  return { id: 'headline', kind: 'text', name: 'Headline', x: 28, y: 80, w: 325, h: 110, text: 'Build something great', fill: '#ffffff', color: '#17243a', stroke: '#d8e0ec', radius: 12, fontSize: 36, image: '', action: null, componentId: null, layout: 'scale', ...overrides };
}
function snapshot() {
  return { version: 3, document: { schema: 1, name: 'Saved prototype', palette: { brand: '#635bff', surface: '#ffffff', ink: '#17243a' },
    pages: [{ id: 'home', name: 'Home', device: 'mobile', width: 390, height: 844, layers: [layer()] }], components: [] as Array<Record<string, unknown>> } };
}
function rejects(value: unknown, code: 'LEGACY_INVALID' | 'LEGACY_UNSUPPORTED', field?: string) {
  throws(() => planLegacyPrototypeImport(value), (error: unknown) => {
    ok(error instanceof LegacyPrototypeImportError); equal(error.code, code); if (field) equal(error.field, field); return true;
  });
}

test('saved snapshots produce editable native steps with explicit fidelity and detached backup data', () => {
  const input = snapshot(), plan = planLegacyPrototypeImport(input);
  equal(plan.title, 'Saved prototype'); equal(plan.fidelity, 'editable-static-and-navigation'); equal(plan.requiresEmptyFile, true);
  deepEqual(JSON.parse(JSON.stringify(plan.backup)), input); ok(plan.warnings.some(message => message.includes('not a lossless migration')));
  const screen = plan.steps.find(step => step.bind === 'screen.0')!;
  equal(screen.command, 'node.create'); equal(screen.params.type, 'frame'); equal(screen.params.width, 390); equal(screen.params.height, 844);
  const label = plan.steps.find(step => step.params.type === 'text')!;
  equal(label.params.text, 'Build something great'); equal(label.params.width, 325); equal(label.params.height, 110);
  const props = label.params.props as Record<string, unknown>; equal(props.textAutoResize, 'none'); equal(props.textAlign, 'left');
  const sourceMetadata = (screen.params.props as Record<string, Record<string, string>>).pluginData!['klaus.prototype.legacySnapshot']!;
  deepEqual(JSON.parse(sourceMetadata), input);
  input.document.pages[0]!.layers[0]!.text = 'Later edit'; equal((plan.backup.document as typeof input.document).pages[0]!.layers[0]!.text, 'Build something great');
});

test('screens, stacking, geometry, constraints and cross-screen navigation resolve only returned node ids', () => {
  const input = snapshot(); input.document.pages[0]!.layers = [layer({ kind: 'frame', id: 'hero', text: '', x: 0, y: 0, w: 390, h: 310, radius: 0, layout: 'fixed' }),
    layer({ kind: 'button', id: 'start', text: 'Continue', action: { type: 'navigate', target: 'details' }, layout: 'stretch' })];
  input.document.pages.push({ id: 'details', name: 'Details', device: 'tablet', width: 768, height: 1024, layers: [] });
  const plan = planLegacyPrototypeImport(input), ids = new Map<string, number>(), seen: Array<{ command: string; params: Record<string, unknown> }> = [];
  let next = 100;
  for (const step of plan.steps) {
    const resolved = resolveLegacyImportStep(step, ids); seen.push(resolved);
    if (step.bind) ids.set(step.bind, next++);
  }
  const screens = seen.filter(step => (step.params.props as Record<string, Record<string, string>> | undefined)?.pluginData?.['klaus.prototype.legacyPage']);
  equal(screens.length, 2); equal(screens[0]!.params.x, 0); equal(screens[1]!.params.x, 490);
  const layers = seen.filter(step => (step.params.props as Record<string, Record<string, string>> | undefined)?.pluginData?.['klaus.prototype.legacyLayer']);
  deepEqual(layers.map(step => step.params.name), ['Headline', 'Headline']);
  deepEqual((layers[0]!.params.props as Record<string, unknown>).constraints, { horizontal: 'left', vertical: 'top' });
  deepEqual((layers[1]!.params.props as Record<string, unknown>).constraints, { horizontal: 'leftRight', vertical: 'topBottom' });
  const interaction = seen.find(step => step.command === 'proto.interaction.add')!;
  equal(interaction.params.id, ids.get('layer.0.1')); equal(interaction.params.dest, ids.get('screen.1'));
  ok(seen.indexOf(interaction) > seen.findIndex(step => step.params.name === 'Details'));
  deepEqual(interaction.params.transition, { type: 'instant' }); equal(interaction.params.durationMs, 0);
  const flow = seen.find(step => step.command === 'proto.flow.add')!; equal(flow.params.start, ids.get('screen.0'));
  throws(() => resolveLegacyImportStep(plan.steps.find(step => step.bind === 'layer.0.0')!, new Map()), /prior command/);
  throws(() => resolveLegacyImportStep(plan.steps.find(step => step.bind === 'layer.0.0')!, new Map([['screen.0', NaN]])), /safe numeric/);
});

test('supported card, ellipse and PNG layers retain editable children and original metadata', () => {
  const input = snapshot(); input.document.pages[0]!.layers = [layer({ id: 'card', kind: 'card' }), layer({ id: 'circle', kind: 'ellipse', text: '' }), layer({ id: 'photo', kind: 'image', text: '', image: png })];
  const plan = planLegacyPrototypeImport(input);
  const image = plan.steps.find(step => step.command === 'image.place')!; equal(image.params.data, png); equal(image.params.mode, 'fill'); equal(image.params.width, 325);
  const card = plan.steps.find(step => step.bind === 'layer.0.0')!;
  ok(Array.isArray((card.params.props as Record<string, unknown>).effects));
  const ellipse = plan.steps.find(step => step.params.type === 'ellipse')!; equal(ellipse.params.width, 325); equal(ellipse.params.height, 110);
  equal(plan.requiredCommands.includes('image.place'), true); equal(plan.steps.some(step => step.command === 'file.open' || step.command === 'file.new'), false);
});

test('component definitions, instances, overlay, toggle and live inputs fail the whole plan explicitly', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ kind: 'input' }, '.kind'], [{ componentId: 'button-main' }, '.componentId'],
    [{ action: { type: 'overlay', target: 'headline' } }, '.action'], [{ action: { type: 'toggle', target: 'headline' } }, '.action'],
    [{ kind: 'ellipse' }, '.text'], [{ image: png }, '.image'],
  ];
  for (const [overrides, suffix] of cases) {
    const input = snapshot(); input.document.pages[0]!.layers[0] = layer(overrides);
    rejects(input, 'LEGACY_UNSUPPORTED', 'document.pages[0].layers[0]' + suffix);
  }
  const input = snapshot(); input.document.components.push({ id: 'main', name: 'Main button', layer: layer() });
  rejects(input, 'LEGACY_UNSUPPORTED', 'document.components');
});

test('unknown formats, extra fields, unknown nodes and incomplete snapshots are refused without normalization', () => {
  rejects(snapshot().document, 'LEGACY_INVALID', 'snapshot'); rejects({ version: 0, document: null }, 'LEGACY_INVALID', 'snapshot.version');
  rejects({ ...snapshot(), history: [] }, 'LEGACY_INVALID', 'snapshot'); rejects({ ...snapshot(), version: 1.5 }, 'LEGACY_INVALID', 'snapshot.version');
  rejects({ ...snapshot(), document: { ...snapshot().document, schema: 2 } }, 'LEGACY_INVALID', 'document.schema');
  for (const fields of [{ kind: 'video' }, { unexpected: 'keep me' }, { x: -1 }, { h: 9000 }, { fill: 'red' }, { layout: 'grid' }, { action: { type: 'script', target: 'eval' } }]) {
    const input = snapshot(); input.document.pages[0]!.layers[0] = layer(fields); rejects(input, 'LEGACY_INVALID');
  }
  const missing = snapshot(); delete (missing.document.pages[0]!.layers[0] as Record<string, unknown>).radius; rejects(missing, 'LEGACY_INVALID');
});

test('dangling navigation and duplicate ids are rejected before native work is produced', () => {
  const dangling = snapshot(); dangling.document.pages[0]!.layers[0] = layer({ action: { type: 'navigate', target: 'missing' } });
  rejects(dangling, 'LEGACY_INVALID', 'document.pages[0].layers[0].action.target');
  const duplicateLayer = snapshot(); duplicateLayer.document.pages[0]!.layers.push(layer()); rejects(duplicateLayer, 'LEGACY_INVALID', 'document.pages[0].layers');
  const duplicatePage = snapshot(); duplicatePage.document.pages.push(structuredClone(duplicatePage.document.pages[0]!)); rejects(duplicatePage, 'LEGACY_INVALID', 'document.pages');
});

test('document byte limits, page and layer limits, nonfinite numbers and unsafe JSON are enforced', () => {
  const manyPages = snapshot(); manyPages.document.pages = Array.from({ length: 61 }, (_, index) => ({ ...manyPages.document.pages[0]!, id: String(index) })); rejects(manyPages, 'LEGACY_INVALID', 'document.pages');
  const manyLayers = snapshot(); manyLayers.document.pages[0]!.layers = Array.from({ length: 501 }, (_, index) => layer({ id: String(index) })); rejects(manyLayers, 'LEGACY_INVALID', 'document.pages[0].layers');
  const nonfinite = snapshot(); nonfinite.document.pages[0]!.layers[0]!.x = Infinity; rejects(nonfinite, 'LEGACY_INVALID');
  rejects({ version: 3, document: { payload: 'x'.repeat(2 * 1024 * 1024 + 129) } }, 'LEGACY_INVALID');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; rejects(cyclic, 'LEGACY_INVALID');
  rejects({ version: 3, document: new Date() }, 'LEGACY_INVALID');
  const getter = snapshot(); let read = false;
  Object.defineProperty(getter.document, 'name', { enumerable: true, get() { read = true; throw new Error('Must not run'); } }); rejects(getter, 'LEGACY_INVALID'); equal(read, false);
  const sparse = snapshot(); sparse.document.pages[0]!.layers = new Array(1); rejects(sparse, 'LEGACY_INVALID');
  rejects(JSON.parse('{"version":3,"document":{"__proto__":{"polluted":true}}}'), 'LEGACY_INVALID'); equal(({} as Record<string, unknown>).polluted, undefined);
});

test('image data URLs are bounded and checked before commands are returned', () => {
  const cases: Array<[string, 'LEGACY_INVALID' | 'LEGACY_UNSUPPORTED']> = [
    ['https://example.com/image.png', 'LEGACY_INVALID'], ['data:image/png;base64,AAAA', 'LEGACY_INVALID'],
    [png + 'A', 'LEGACY_INVALID'], ['data:image/jpeg;base64,/9j/2Q==', 'LEGACY_UNSUPPORTED'],
    ['data:image/gif;base64,R0lGODlhAQABAIAAAA==', 'LEGACY_UNSUPPORTED'], ['data:image/png;base64,' + 'A'.repeat(750000), 'LEGACY_INVALID'],
  ];
  const oversized = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'); oversized.writeUInt32BE(8193, 16); cases.push(['data:image/png;base64,' + oversized.toString('base64'), 'LEGACY_INVALID']);
  for (const [image, code] of cases) { const input = snapshot(); input.document.pages[0]!.layers[0] = layer({ kind: 'image', text: '', image }); rejects(input, code); }
});

test('the real Canvas get snapshot imports without changing TSX bytes, archive bytes or history', () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-prototype-legacy-')), file = join(root, 'existing.canvas.tsx'), archive = join(root, 'existing.canvas.document.json');
  try {
    const source = 'throw new Error("Legacy source must never execute");\n'; writeFileSync(file, source);
    const documents = new CanvasDocumentStore(root, () => file), project = snapshot().document;
    documents.apply(file, 0, project); documents.apply(file, 1, { ...project, name: 'Second revision' }); documents.apply(file, 2, project);
    const bytes = readFileSync(archive), history = documents.history(file), input = documents.get(file);
    equal(input.version, 3); const plan = planLegacyPrototypeImport(input); equal(plan.backup.version, 3);
    deepEqual(readFileSync(archive), bytes); equal(readFileSync(file, 'utf8'), source); deepEqual(documents.history(file), history);
    equal(JSON.parse(bytes.toString()).history.length, 2); equal(JSON.parse(bytes.toString()).history[1].document.name, 'Second revision');
    const invalid = documents.get(file) as { document: unknown; version: number }; invalid.document = { unsupported: true }; rejects(invalid, 'LEGACY_INVALID');
    deepEqual(readFileSync(archive), bytes); equal(readFileSync(file, 'utf8'), source);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
