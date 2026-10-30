import { Buffer } from 'node:buffer';
import type { Json } from '../ipc/contract';
type JsonObject = { [key: string]: Json };

const DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const KINDS = ['frame', 'card', 'text', 'button', 'input', 'image', 'ellipse'] as const;
type Kind = typeof KINDS[number];
type Action = { type: 'navigate' | 'overlay' | 'toggle'; target: string };
interface Layer { id: string; kind: Kind; name: string; x: number; y: number; w: number; h: number; text: string; fill: string; color: string; stroke: string; radius: number; fontSize: number; image: string; action: Action | null; componentId: string | null; layout: 'scale' | 'fixed' | 'stretch' }
interface Page { id: string; name: string; device: 'desktop' | 'tablet' | 'mobile'; width: number; height: number; layers: Layer[] }
interface Project { schema: 1; name: string; palette: { brand: string; surface: string; ink: string }; pages: Page[]; components: Array<{ id: string; name: string; layer: Layer }> }
export type LegacyImportParams = { [key: string]: Json | LegacyImportReference | LegacyImportParams | Array<Json | LegacyImportReference | LegacyImportParams> };
export interface LegacyImportReference { legacyResult: string }
export interface LegacyImportStep { command: string; params: LegacyImportParams; bind?: string }
export interface LegacyImportPlan {
  format: 'prototype-studio-schema-1';
  fidelity: 'editable-static-and-navigation';
  title: string;
  /** The caller creates an isolated empty native file and persists backup before running steps. */
  requiresEmptyFile: true;
  backup: { version: number; document: Json };
  warnings: string[];
  requiredCommands: string[];
  steps: LegacyImportStep[];
}
export class LegacyPrototypeImportError extends Error {
  constructor(readonly code: 'LEGACY_INVALID' | 'LEGACY_UNSUPPORTED', readonly field: string, reason: string) {
    super(`${field}: ${reason}`); this.name = 'LegacyPrototypeImportError';
  }
}
function invalid(path: string, reason: string): never { throw new LegacyPrototypeImportError('LEGACY_INVALID', path, reason); }
function unsupported(path: string, reason: string): never { throw new LegacyPrototypeImportError('LEGACY_UNSUPPORTED', path, reason); }

/** Accept data returned by CanvasDocumentStore.get, never source code or the on-disk archive. */
function snapshotData(input: unknown): JsonObject {
  let bytes = 0, entries = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, path: string, depth: number): Json => {
    if (depth > 16 || ++entries > 500_000) invalid(path, 'Document nesting or entry limit exceeded.');
    if (value === null) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(path, 'Expected a finite JSON number.'); return value; }
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > DOCUMENT_BYTES + 128) invalid(path, 'Canvas document exceeds 2 MiB.'); return value; }
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) invalid(path, 'Expected plain JSON data.');
    if (ancestors.has(value)) invalid(path, 'Cyclic data is not a Canvas snapshot.');
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    for (const key of keys) {
      if (typeof key !== 'string') invalid(path, 'Symbol fields are not JSON.');
      const descriptor = descriptors[key]!;
      if (Array.isArray(value) && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) invalid(path, 'Accessors and hidden fields are not JSON.');
    }
    let result: Json;
    if (Array.isArray(value)) {
      if (value.length > 30_000 || keys.length !== value.length + 1) invalid(path, 'Expected a bounded, dense JSON array.');
      result = Array.from({ length: value.length }, (_, index) => {
        if (!descriptors[String(index)]) invalid(path, 'Sparse arrays are not supported.');
        return copy(descriptors[String(index)]!.value, `${path}[${index}]`, depth + 1);
      });
    } else {
      const object: JsonObject = Object.create(null) as JsonObject;
      for (const key of keys as string[]) object[key] = copy(descriptors[key]!.value, `${path}.${key}`, depth + 1);
      result = object;
    }
    ancestors.delete(value); return result;
  };
  return object(copy(input, 'snapshot', 0), 'snapshot', ['version', 'document']);
}
function object(value: unknown, path: string, keys: readonly string[]): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'Expected an object.');
  const result = value as JsonObject;
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid(path, `Expected exactly these fields: ${keys.join(', ')}.`);
  return result;
}
function text(value: unknown, path: string, limit: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > limit || (nonempty && (!value || /[\u0000-\u001f]/.test(value)))) invalid(path, `Expected ${nonempty ? 'nonempty ' : ''}text up to ${limit} characters.`);
  return value;
}
function number(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(path, `Expected a finite number from ${min} to ${max}; values are never clamped.`);
  return value;
}
function enumeration<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(path, `Unsupported value; expected ${options.join('|')}.`);
  return value as T;
}
function color(value: unknown, path: string): string {
  const result = text(value, path, 7);
  if (!/^#[0-9a-f]{6}$/i.test(result)) invalid(path, 'Expected a six-digit hex color.'); return result;
}
function list(value: unknown, path: string, min: number, max: number): Json[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(path, `Expected ${min} to ${max} entries.`); return value as Json[];
}
function unique(ids: string[], path: string): void { if (new Set(ids).size !== ids.length) invalid(path, 'Duplicate identifiers are ambiguous.'); }
function parseLayer(input: unknown, path: string): Layer {
  const value = object(input, path, ['id', 'kind', 'name', 'x', 'y', 'w', 'h', 'text', 'fill', 'color', 'stroke', 'radius', 'fontSize', 'image', 'action', 'componentId', 'layout']);
  let action: Action | null = null;
  if (value.action !== null) {
    const raw = object(value.action, path + '.action', ['type', 'target']);
    action = { type: enumeration(raw.type, path + '.action.type', ['navigate', 'overlay', 'toggle']), target: text(raw.target, path + '.action.target', 80, true) };
  }
  const image = text(value.image, path + '.image', 749_999);
  if (image && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(image)) invalid(path + '.image', 'Expected an embedded legacy image data URL.');
  return { id: text(value.id, path + '.id', 80, true), kind: enumeration(value.kind, path + '.kind', KINDS), name: text(value.name, path + '.name', 100),
    x: number(value.x, path + '.x', 0, 4000), y: number(value.y, path + '.y', 0, 4000), w: number(value.w, path + '.w', 8, 4000), h: number(value.h, path + '.h', 8, 4000),
    text: text(value.text, path + '.text', 2000), fill: color(value.fill, path + '.fill'), color: color(value.color, path + '.color'), stroke: color(value.stroke, path + '.stroke'),
    radius: number(value.radius, path + '.radius', 0, 100), fontSize: number(value.fontSize, path + '.fontSize', 8, 96), image, action,
    componentId: value.componentId === null ? null : text(value.componentId, path + '.componentId', 80, true), layout: enumeration(value.layout, path + '.layout', ['scale', 'fixed', 'stretch']) };
}
function parseProject(input: unknown): Project {
  const value = object(input, 'document', ['schema', 'name', 'palette', 'pages', 'components']);
  if (value.schema !== 1) invalid('document.schema', 'Only prototype-studio schema 1 is recognized.');
  const palette = object(value.palette, 'document.palette', ['brand', 'surface', 'ink']);
  const pages = list(value.pages, 'document.pages', 1, 60).map((raw, index): Page => {
    const path = `document.pages[${index}]`, page = object(raw, path, ['id', 'name', 'device', 'width', 'height', 'layers']);
    const layers = list(page.layers, path + '.layers', 0, 500).map((layer, layerIndex) => parseLayer(layer, `${path}.layers[${layerIndex}]`));
    unique(layers.map(layer => layer.id), path + '.layers');
    return { id: text(page.id, path + '.id', 80, true), name: text(page.name, path + '.name', 120), device: enumeration(page.device, path + '.device', ['desktop', 'tablet', 'mobile']),
      width: number(page.width, path + '.width', 200, 4000), height: number(page.height, path + '.height', 200, 4000), layers };
  });
  const components = list(value.components, 'document.components', 0, 100).map((raw, index) => {
    const path = `document.components[${index}]`, component = object(raw, path, ['id', 'name', 'layer']);
    return { id: text(component.id, path + '.id', 80, true), name: text(component.name, path + '.name', 120), layer: parseLayer(component.layer, path + '.layer') };
  });
  unique(pages.map(page => page.id), 'document.pages'); unique(components.map(component => component.id), 'document.components');
  return { schema: 1, name: text(value.name, 'document.name', 120), palette: { brand: color(palette.brand, 'document.palette.brand'), surface: color(palette.surface, 'document.palette.surface'), ink: color(palette.ink, 'document.palette.ink') }, pages, components };
}
function pngImage(data: string, path: string): void {
  if (!data.toLowerCase().startsWith('data:image/png;base64,')) unsupported(path, 'This importer currently supports embedded PNG images only; other image formats require explicit conversion.');
  const encoded = data.slice(data.indexOf(',') + 1), bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid(path, 'Invalid PNG encoding or header.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_IMAGE_PIXELS) invalid(path, 'PNG dimensions exceed the import limit.');
}
function checkSupported(project: Project): void {
  if (project.components.length) unsupported('document.components', 'Legacy linked-copy component definitions cannot be mapped to native component semantics without a dedicated converter.');
  project.pages.forEach((page, pageIndex) => page.layers.forEach((layer, index) => {
    const path = `document.pages[${pageIndex}].layers[${index}]`;
    if (layer.componentId !== null) unsupported(path + '.componentId', 'Linked-copy component instances cannot be imported as detached shapes.');
    if (layer.kind === 'input') unsupported(path + '.kind', 'A legacy editable input cannot be replaced with static text.');
    if (layer.action?.type === 'navigate' && !project.pages.some(page => page.id === layer.action!.target)) invalid(path + '.action.target', 'Navigation target does not exist.');
    if (layer.action && layer.action.type !== 'navigate') unsupported(path + '.action', 'Legacy overlay and visibility-toggle behavior needs a dedicated interaction converter.');
    if (layer.kind === 'ellipse' && layer.text) unsupported(path + '.text', 'Ellipse text requires elliptical clipping that this importer does not reproduce.');
    if (layer.image && layer.kind !== 'image') unsupported(path + '.image', 'Image data on a non-image layer cannot be represented as an image layer.');
    if (layer.image) pngImage(layer.image, path + '.image');
  }));
}
const ref = (key: string): LegacyImportReference => ({ legacyResult: key });
function constraints(layout: Layer['layout']): JsonObject {
  return layout === 'scale' ? { horizontal: 'scale', vertical: 'scale' } : layout === 'stretch' ? { horizontal: 'leftRight', vertical: 'topBottom' } : { horizontal: 'left', vertical: 'top' };
}

/** Validate the entire snapshot before returning any executable work. No files or histories are read or written. */
export function planLegacyPrototypeImport(input: unknown): LegacyImportPlan {
  const snapshot = snapshotData(input);
  if (!Number.isSafeInteger(snapshot.version) || Number(snapshot.version) < 1) invalid('snapshot.version', 'A saved Canvas document version is required.');
  if (Buffer.byteLength(JSON.stringify(snapshot.document)) > DOCUMENT_BYTES) invalid('document', 'Canvas document exceeds 2 MiB.');
  const project = parseProject(snapshot.document); checkSupported(project);
  const backup = { version: Number(snapshot.version), document: snapshot.document! }, steps: LegacyImportStep[] = [];
  const add = (command: string, params: LegacyImportParams, bind?: string) => steps.push({ command, params, ...(bind ? { bind } : {}) });
  add('page.rename', { name: 'Imported screens' });
  let left = 0;
  project.pages.forEach((page, pageIndex) => {
    const screen = `screen.${pageIndex}`;
    add('node.create', { type: 'frame', name: page.name, x: left, y: 0, width: page.width, height: page.height, select: false,
      props: { fill: project.palette.surface, strokes: [], clip: true, pluginData: { 'klaus.prototype.legacyPage': JSON.stringify({ id: page.id, device: page.device }),
        ...(pageIndex === 0 ? { 'klaus.prototype.legacySnapshot': JSON.stringify(backup) } : {}) } } }, screen);
    left += page.width + 100;
    page.layers.forEach((layer, index) => {
      const key = `layer.${pageIndex}.${index}`, shape = !['text', 'image', 'ellipse'].includes(layer.kind), inset = layer.kind === 'frame' || layer.kind === 'card' ? 14 : 0;
      const width = Math.max(0, layer.w - inset * 2), height = Math.max(0, layer.h - inset * 2);
      const props: JsonObject = { fills: shape ? [layer.fill] : [], strokes: shape ? [layer.stroke] : [], strokeWeight: 1, strokeAlign: 'inside', cornerRadius: layer.radius, clip: true,
        constraints: constraints(layer.layout), pluginData: { 'klaus.prototype.legacyLayer': JSON.stringify(layer) } };
      if (layer.kind === 'card') props.effects = [{ type: 'dropShadow', color: { r: 18 / 255, g: 32 / 255, b: 51 / 255, a: 23 / 255 }, offset: [0, 12], radius: 28, spread: 0 }];
      add('node.create', { type: 'frame', name: layer.name, parent: ref(screen), x: layer.x, y: layer.y, width: layer.w, height: layer.h, props, select: false }, key);
      if (layer.kind === 'ellipse') add('node.create', { type: 'ellipse', name: 'Shape', parent: ref(key), x: 0, y: 0, width: layer.w, height: layer.h,
        props: { fill: layer.fill, stroke: layer.stroke, strokeWeight: 1, strokeAlign: 'inside', constraints: { horizontal: 'leftRight', vertical: 'topBottom' } }, select: false });
      if (layer.kind === 'image' && layer.image) add('image.place', { data: layer.image, name: layer.name, parent: ref(key), x: 0, y: 0, width: layer.w, height: layer.h, mode: 'fill' }, `image.${pageIndex}.${index}`);
      else if (layer.text) add('node.create', { type: 'text', name: layer.name + ' text', text: layer.text, parent: ref(key), x: inset, y: inset, width, height,
        props: { width, height, fill: layer.color, fontFamily: 'Inter', fontSize: layer.fontSize, fontWeight: layer.kind === 'button' ? 650 : layer.kind === 'text' ? 600 : 450,
          lineHeight: '145%', textAutoResize: 'none', textAlign: layer.kind === 'text' || inset ? 'left' : 'center', textAlignVertical: inset ? 'top' : 'middle', constraints: { horizontal: 'leftRight', vertical: 'topBottom' } }, select: false });
    });
  });
  project.pages.forEach((page, pageIndex) => page.layers.forEach((layer, index) => {
    if (layer.action) add('proto.interaction.add', { id: ref(`layer.${pageIndex}.${index}`), dest: ref(`screen.${project.pages.findIndex(page => page.id === layer.action!.target)}`), trigger: { type: 'onClick' }, transition: { type: 'instant' }, durationMs: 0 });
  }));
  add('proto.flow.add', { start: ref('screen.0'), name: project.name || 'Imported prototype' });
  return { format: 'prototype-studio-schema-1', fidelity: 'editable-static-and-navigation', title: project.name, requiresEmptyFile: true, backup,
    warnings: ['This is an editable static design and navigation conversion, not a lossless migration of the legacy editor.',
      'Text metrics, wrapping, line-ending normalization, font weights, shadow rendering and responsive rounding can differ from the legacy browser layout. Review the imported screens.',
      'Palette roles, device categories and legacy identifiers remain source metadata; no native variables or device presets are inferred.',
      'The complete source snapshot is preserved in backup and in the first screen pluginData. Keep the original Canvas source, document and complete history untouched.'],
    requiredCommands: [...new Set(steps.map(step => step.command))], steps };
}

/** Resolve only explicit plan references using numeric node ids returned by earlier commands. */
export function resolveLegacyImportStep(step: LegacyImportStep, bindings: ReadonlyMap<string, number>): { command: string; params: JsonObject } {
  const resolve = (value: unknown): Json => {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) return value.map(resolve);
      const object = value as Record<string, unknown>;
      if (Object.keys(object).length === 1 && typeof object.legacyResult === 'string') {
        const id = bindings.get(object.legacyResult);
        if (!Number.isSafeInteger(id) || Number(id) < 0) invalid('bindings.' + object.legacyResult, 'A prior command must return a safe numeric node id.');
        return id!;
      }
      return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, resolve(entry)]));
    }
    return value as Json;
  };
  return { command: step.command, params: resolve(step.params) as JsonObject };
}
