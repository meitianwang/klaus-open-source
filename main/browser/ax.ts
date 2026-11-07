import { randomUUID } from 'node:crypto';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';
import { domScript, frameCdp } from './dom';
import { click, computerInput, typeText } from './page-input';
import { saveScreenshot } from './page-capture';
import { readLimit } from './page-reading';
import { locatorBudget } from './locator-policy';
import { assertBrowserActionActive, pauseBrowserAction } from './action-cancellation';
import {
  AX_MOUSE_BUTTONS, AX_SCROLL_DIRECTIONS, buildAxEntries, holdDurationMs, parseXdotoolKey,
  removedIdRanges, renderAxStateText,
  type AxFrameInput, type AxFrameViewport, type AxKeyCombo, type AxNodeMeta,
  type AxPreviousLine, type AxRenderEntry, type AxWireNode,
} from './ax-serialize';

/**
 * Accessibility-state observation and index-addressed actions.
 *
 * The state capture renders the platform accessibility tree as text with
 * integer element indices, diffs against the previous capture of the same
 * document, and waits for the tree to go quiet before reading. Actions
 * resolve an element index to a live node, bridge it into the trusted
 * pointer/keyboard pipeline, and re-capture fresh state into the error text
 * when an interaction fails.
 */

export interface AxContext { cdp: BrowserCdp; signal?: AbortSignal; artifactDirectory?: string }

interface AxTabStore {
  documentKey?: string;
  snapshotId?: string;
  entries?: AxRenderEntry[];
  byIdentity?: Map<string, AxPreviousLine>;
  lastAxUpdateMs: number;
  subscribed: boolean;
}

const AX_QUIET_THRESHOLD_MS = 100;
const AX_QUIET_FAST_THRESHOLD_MS = 50;
const AX_QUIET_CAP_MS = 750;
const AX_QUIET_POLL_MS = 25;
const AX_RECAPTURE_TEXT_LIMIT = 20_000;
const AX_UPDATE_EVENTS = new Set(['Accessibility.loadComplete', 'Accessibility.nodesUpdated', 'Accessibility.update']);
const RECAPTURE_CODES = new Set(['not_found', 'not_visible', 'not_enabled', 'not_stable', 'intercepted', 'stale_target', 'timeout', 'stale_snapshot']);

const axStores = new WeakMap<object, AxTabStore>();

function rootCdp(cdp: BrowserCdp): BrowserCdp { return cdp.captureScope?.root ?? cdp; }

function axStoreFor(cdp: BrowserCdp): AxTabStore {
  const root = rootCdp(cdp);
  let store = axStores.get(root);
  if (!store) {
    store = { lastAxUpdateMs: 0, subscribed: false };
    axStores.set(root, store);
  }
  if (!store.subscribed) {
    store.subscribed = true;
    const tracked = store;
    root.onEvent(method => { if (AX_UPDATE_EVENTS.has(method)) tracked.lastAxUpdateMs = Date.now(); });
  }
  return store;
}

/** Let in-flight accessibility updates settle before reading the new state. */
async function waitForAxQuiet(store: AxTabStore, fast: boolean, signal?: AbortSignal): Promise<void> {
  const threshold = fast ? AX_QUIET_FAST_THRESHOLD_MS : AX_QUIET_THRESHOLD_MS;
  const deadline = Date.now() + AX_QUIET_CAP_MS;
  while (store.lastAxUpdateMs > 0 && Date.now() - store.lastAxUpdateMs < threshold && Date.now() < deadline) {
    await pauseBrowserAction(AX_QUIET_POLL_MS, signal);
  }
}

const wireNodes = (value: unknown): AxWireNode[] => (Array.isArray(value) ? value : []).map(entry => object(entry) as unknown as AxWireNode);

async function currentDocumentKey(root: BrowserCdp): Promise<string> {
  const tree = object(await root.command('Page.getFrameTree'));
  const frame = object(object(tree.frameTree).frame);
  const targetId = (root as { targetId?: string }).targetId ?? '';
  return `${targetId}|${String(frame.loaderId ?? '')}`;
}

/** Join layout bounds and input types onto AX nodes; failures degrade to none. */
async function snapshotMeta(root: BrowserCdp, frameTarget?: string): Promise<Map<number, AxNodeMeta>> {
  const out = new Map<number, AxNodeMeta>();
  try {
    const snapshot = object(await root.command('DOMSnapshot.captureSnapshot', { computedStyles: [] }, frameTarget));
    const strings = (Array.isArray(snapshot.strings) ? snapshot.strings : []).map(String);
    for (const rawDocument of Array.isArray(snapshot.documents) ? snapshot.documents : []) {
      const document = object(rawDocument);
      const nodes = object(document.nodes);
      const layout = object(document.layout);
      const backendIds = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId : [];
      const nodeNames = Array.isArray(nodes.nodeName) ? nodes.nodeName : [];
      const attributes = Array.isArray(nodes.attributes) ? nodes.attributes : [];
      const nodeIndex = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
      const bounds = Array.isArray(layout.bounds) ? layout.bounds : [];
      for (let position = 0; position < nodeIndex.length; position += 1) {
        const nodeAt = Number(nodeIndex[position]);
        const box = bounds[position];
        const backend = Number(backendIds[nodeAt]);
        if (!Number.isSafeInteger(backend) || !Array.isArray(box) || box.length < 4) continue;
        const tag = String(strings[Number(nodeNames[nodeAt])] ?? '').toLowerCase();
        let inputType = '';
        const attributePairs = attributes[nodeAt];
        if (Array.isArray(attributePairs)) {
          for (let pair = 0; pair + 1 < attributePairs.length; pair += 2) {
            if (strings[Number(attributePairs[pair])] === 'type') { inputType = String(strings[Number(attributePairs[pair + 1])] ?? '').toLowerCase(); break; }
          }
        }
        out.set(backend, { bounds: [Number(box[0]), Number(box[1]), Number(box[2]), Number(box[3])], tag, ...(inputType ? { inputType } : {}) });
      }
    }
  } catch { /* bounds metadata is best effort; the tree renders without it. */ }
  return out;
}

async function viewportOf(root: BrowserCdp, frameTarget?: string): Promise<AxFrameViewport | null> {
  try {
    const metrics = object(await root.evaluate('({scrollX,scrollY,width:innerWidth,height:innerHeight})', frameTarget));
    const viewport = { scrollX: Number(metrics.scrollX), scrollY: Number(metrics.scrollY), width: Number(metrics.width), height: Number(metrics.height) };
    return Object.values(viewport).every(Number.isFinite) ? viewport : null;
  } catch { return null; }
}

interface AxCaptureResult {
  text: string;
  mode: 'full' | 'diff' | 'unchanged';
  snapshotId: string;
  elementCount: number;
  shown: number;
  added: number;
  changed: number;
  removedIds: number[];
  truncated: boolean;
}

/** Capture, render, diff and commit one accessibility state for this tab. */
async function captureAxTree(context: AxContext, store: AxTabStore, fields: BrowserObject): Promise<AxCaptureResult> {
  const root = rootCdp(context.cdp);
  const signal = context.signal;
  assertBrowserActionActive(signal);
  const documentKey = await currentDocumentKey(root);
  const frames: AxFrameInput[] = [];
  const pushFrame = async (frameTarget?: string): Promise<void> => {
    assertBrowserActionActive(signal);
    await root.command('Accessibility.enable', {}, frameTarget).catch(() => {});
    const tree = object(await root.command('Accessibility.getFullAXTree', {}, frameTarget));
    frames.push({
      ...(frameTarget ? { frameTarget } : {}),
      nodes: wireNodes(tree.nodes),
      meta: await snapshotMeta(root, frameTarget),
      viewport: await viewportOf(root, frameTarget),
    });
  };
  await pushFrame(undefined);
  for (const frameTarget of root.frameTargets()) {
    try { await pushFrame(frameTarget); } catch { assertBrowserActionActive(signal); /* a detached child frame contributes nothing */ }
  }
  const owners = new Map<string, number>();
  for (const frame of frames) {
    if (!frame.frameTarget) continue;
    for (const parent of [undefined, ...frames.filter(other => other !== frame && other.frameTarget !== undefined).map(other => other.frameTarget!)]) {
      try {
        const owner = object(await root.command('DOM.getFrameOwner', { frameId: frame.frameTarget }, parent));
        if (typeof owner.backendNodeId === 'number') { owners.set(frame.frameTarget, owner.backendNodeId); break; }
      } catch { assertBrowserActionActive(signal); /* only the actual parent document can resolve the owner */ }
    }
  }
  const info = object(await root.evaluate('({url:location.href,title:document.title})'));
  const selectedText = String(await root.evaluate('(()=>{try{const selection=document.getSelection();return selection?String(selection):""}catch{return ""}})()').catch(() => ''));
  const previous = store.documentKey === documentKey ? store.byIdentity : undefined;
  const entries = buildAxEntries(frames, owners);
  const maxChars = readLimit(fields.maxChars ?? fields.maxCharacters, 60000, 200000, 'maxChars');
  const rendered = renderAxStateText({
    title: String(info.title ?? ''),
    url: String(info.url ?? ''),
    entries,
    previous,
    disableDiffing: fields.disableDiffing === true || fields.full === true,
    selectedText,
    maxChars,
  });
  const snapshotId = randomUUID();
  const byIdentity = new Map<string, AxPreviousLine>();
  for (const entry of entries) byIdentity.set(entry.identity, { index: entry.index, line: entry.line });
  store.documentKey = documentKey;
  store.snapshotId = snapshotId;
  store.entries = entries;
  store.byIdentity = byIdentity;
  return {
    text: rendered.text, mode: rendered.mode, snapshotId, elementCount: rendered.total, shown: rendered.shown,
    added: rendered.added, changed: rendered.changed, removedIds: rendered.removedIds, truncated: rendered.truncated,
  };
}

/** The `ax_state` operation: text state (diff by default), screenshot, or both. */
export async function captureAxState(context: AxContext, fields: BrowserObject): Promise<{ value: BrowserObject; typed: BrowserObject; screenshot?: BrowserObject }> {
  const root = rootCdp(context.cdp);
  const mode = String(fields.mode ?? 'state');
  if (!['state', 'screenshot', 'both'].includes(mode)) throw new BrowserError('invalid_request', 'ax_state mode must be state, screenshot or both.');
  const store = axStoreFor(root);
  await waitForAxQuiet(store, fields.fast === true, context.signal);
  let screenshot: BrowserObject | undefined;
  if (mode !== 'state') {
    screenshot = await root.screenshot(fields);
    if (fields.save !== false) screenshot = saveScreenshot(screenshot, context.artifactDirectory);
  }
  if (mode === 'screenshot') {
    const value: BrowserObject = { ...screenshot };
    delete value.data;
    return { value, typed: {}, screenshot };
  }
  const captured = await captureAxTree(context, store, fields);
  const value: BrowserObject = {
    snapshotId: captured.snapshotId, state: captured.mode, elementCount: captured.elementCount, shown: captured.shown,
    added: captured.added, changed: captured.changed, removed: captured.removedIds.length,
    ...(captured.removedIds.length ? { removedIds: removedIdRanges(captured.removedIds) } : {}),
    truncated: captured.truncated,
  };
  return { value, typed: { axText: captured.text }, ...(screenshot ? { screenshot } : {}) };
}

/** Re-read state after a failed action so the error carries fresh context. */
async function recaptureForError(context: AxContext, store: AxTabStore): Promise<string | undefined> {
  try {
    await waitForAxQuiet(store, true, undefined);
    const captured = await captureAxTree({ ...context, signal: undefined }, store, { maxChars: AX_RECAPTURE_TEXT_LIMIT });
    return captured.text.slice(0, AX_RECAPTURE_TEXT_LIMIT);
  } catch { return undefined; }
}

const MARK_REF_SOURCE = `function () {
  const global = globalThis;
  const refs = global.__klausBrowserRefs || (global.__klausBrowserRefs = Object.create(null));
  const keys = global.__klausBrowserRefKeys || (global.__klausBrowserRefKeys = new WeakMap());
  let ref = keys.get(this);
  if (!ref || refs[ref] !== this) {
    ref = 'e-ax-' + (global.__klausBrowserRefNext = (global.__klausBrowserRefNext || 0) + 1);
    refs[ref] = this;
    keys.set(this, ref);
  }
  const tag = this.tagName ? String(this.tagName).toLowerCase() : '';
  return { ref, connected: this.isConnected === true, tag, type: this.type ? String(this.type).toLowerCase() : '', editable: this.isContentEditable === true };
}`;

const SET_VALUE_SOURCE = `function (value) {
  const element = this;
  if (!element.isConnected) return { ok: false, reason: 'gone' };
  const tag = String(element.tagName || '').toLowerCase();
  const type = String(element.type || '').toLowerCase();
  const editable = element.isContentEditable === true;
  const role = String((element.getAttribute && element.getAttribute('role')) || '').toLowerCase();
  const blocked = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden', 'range', 'color'];
  const settable = tag === 'select' || tag === 'textarea' || (tag === 'input' && !blocked.includes(type)) || editable
    || ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role);
  if (!settable) return { ok: false, reason: 'not_settable', tag: tag || 'element' };
  if (element.disabled === true) return { ok: false, reason: 'disabled' };
  const text = String(value ?? '');
  if (tag === 'select') {
    const options = Array.from(element.options || []);
    const match = options.find(option => option.value === text)
      || options.find(option => String(option.label || option.textContent || '').trim() === text.trim());
    if (!match) return { ok: false, reason: 'missing_option', available: options.slice(0, 50).map(option => ({ value: option.value, label: String(option.label || option.textContent || '').trim() })) };
    match.selected = true;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, tag };
  }
  element.focus();
  if (editable) {
    element.textContent = text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return { ok: true, tag: 'contenteditable' };
  }
  const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(element, text); else element.value = text;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, tag, ...(type === 'password' ? {} : { value: element.value }) };
}`;

const SELECT_TEXT_SOURCE = `function (text, prefix, suffix, selectionType) {
  const element = this;
  if (!element.isConnected) return { ok: false, reason: 'gone' };
  const tag = String(element.tagName || '').toLowerCase();
  const hasValue = tag === 'input' || tag === 'textarea';
  if (!hasValue && element.isContentEditable !== true) return { ok: false, reason: 'not_editable' };
  const needle = String(text ?? '');
  if (!needle) return { ok: false, reason: 'empty_text' };
  const content = hasValue ? String(element.value ?? '') : String(element.textContent ?? '');
  const matches = [];
  for (let at = content.indexOf(needle); at !== -1 && matches.length < 100; at = content.indexOf(needle, at + needle.length)) matches.push(at);
  const filtered = matches.filter(start => {
    if (prefix && !content.slice(0, start).endsWith(String(prefix))) return false;
    if (suffix && !content.slice(start + needle.length).startsWith(String(suffix))) return false;
    return true;
  });
  if (!filtered.length) return { ok: false, reason: 'not_found', occurrences: matches.length };
  if (filtered.length > 1) return { ok: false, reason: 'ambiguous', occurrences: filtered.length };
  const start = filtered[0];
  const end = start + needle.length;
  element.focus();
  if (hasValue) {
    if (selectionType === 'cursor_before') element.setSelectionRange(start, start);
    else if (selectionType === 'cursor_after') element.setSelectionRange(end, end);
    else element.setSelectionRange(start, end);
    return { ok: true, start, end };
  }
  const selection = document.getSelection();
  if (!selection) return { ok: false, reason: 'no_selection_api' };
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let cumulative = 0;
  let placed = 0;
  let node;
  while ((node = walker.nextNode())) {
    const length = String(node.textContent ?? '').length;
    if (placed === 0 && start >= cumulative && start <= cumulative + length) { range.setStart(node, start - cumulative); placed = 1; }
    if (placed === 1 && end >= cumulative && end <= cumulative + length) { range.setEnd(node, end - cumulative); placed = 2; break; }
    cumulative += length;
  }
  if (placed < 2) return { ok: false, reason: 'range_failed' };
  selection.removeAllRanges();
  if (selectionType === 'cursor_before') range.collapse(true);
  else if (selectionType === 'cursor_after') range.collapse(false);
  selection.addRange(range);
  return { ok: true, start, end };
}`;

const ELEMENT_POINT_SOURCE = `function () {
  this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = this.getBoundingClientRect();
  return {
    x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    clientHeight: this.clientHeight || 0,
    scrollable: (this.scrollHeight > this.clientHeight + 1) || (this.scrollWidth > this.clientWidth + 1),
  };
}`;

const MODIFIER_VIRTUAL_KEY_CODES: Record<string, number> = { Alt: 18, Control: 17, Meta: 91, Shift: 16 };
const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function acceleratorCommand(combo: AxKeyCombo, mask: number): string | undefined {
  const accelerator = (mask & (process.platform === 'darwin' ? 4 : 2)) !== 0;
  if (!accelerator) return undefined;
  const map: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: (mask & 8) !== 0 ? 'redo' : 'undo', y: 'redo' };
  return map[combo.key.toLowerCase()];
}

/** Dispatch one key combination as real key events, optionally holding it down. */
async function dispatchAxKeyCombo(cdp: BrowserCdp, combo: AxKeyCombo, frameTarget: string | undefined, holdMs: number | undefined, signal?: AbortSignal): Promise<void> {
  let mask = 0;
  const pressed: Array<{ key: string; mask: number }> = [];
  try {
    for (const modifier of combo.modifiers) {
      mask |= MODIFIER_BITS[modifier]!;
      assertBrowserActionActive(signal);
      await cdp.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: modifier, windowsVirtualKeyCode: MODIFIER_VIRTUAL_KEY_CODES[modifier]!, modifiers: mask }, frameTarget);
      pressed.push({ key: modifier, mask });
    }
    const command = acceleratorCommand(combo, mask);
    if (holdMs && command && ['copy', 'paste', 'cut'].includes(command)) throw new BrowserError('unavailable', 'Held clipboard shortcuts are unsupported.');
    const printable = combo.printable && (mask & 6) === 0;
    const primary: BrowserObject = { key: combo.key, ...(combo.code ? { code: combo.code } : {}), windowsVirtualKeyCode: combo.virtualKeyCode ?? 0, modifiers: mask };
    assertBrowserActionActive(signal);
    await cdp.command('Input.dispatchKeyEvent', { ...primary, type: printable ? 'keyDown' : 'rawKeyDown', ...(printable ? { text: combo.key } : {}), ...(command ? { commands: [command] } : {}) }, frameTarget);
    if (combo.key === 'Enter' && mask === 0) await cdp.command('Input.dispatchKeyEvent', { ...primary, type: 'char', text: '\r', unmodifiedText: '\r' }, frameTarget);
    if (holdMs) await pauseBrowserAction(holdMs, signal);
  } finally {
    const comboMask = mask;
    await cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: combo.key, ...(combo.code ? { code: combo.code } : {}), windowsVirtualKeyCode: combo.virtualKeyCode ?? 0, modifiers: comboMask }, frameTarget).catch(() => {});
    for (const entry of [...pressed].reverse()) {
      await cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: entry.key, windowsVirtualKeyCode: MODIFIER_VIRTUAL_KEY_CODES[entry.key]!, modifiers: entry.mask & ~MODIFIER_BITS[entry.key]! }, frameTarget).catch(() => {});
    }
  }
}

/** Write the session clipboard through a scratch field so paste can reuse it. */
async function writeVirtualClipboard(cdp: BrowserCdp, frameTarget: string | undefined, text: string, html: string | undefined, signal?: AbortSignal): Promise<void> {
  const id = `__klausAxClipboard_${randomUUID().replace(/-/gu, '')}`;
  const key = JSON.stringify(id);
  assertBrowserActionActive(signal);
  await cdp.evaluate(domScript(`const e=document.createElement(${html === undefined ? "'textarea'" : "'div'"});e.id=${key};e.style.cssText='position:fixed;left:0;top:0;width:2px;height:2px;opacity:0';e.__previous=active();${html === undefined ? `e.value=${JSON.stringify(text)};` : `e.contentEditable='true';e.innerHTML=${JSON.stringify(html)};`}document.body.append(e);e.focus();${html === undefined ? 'e.select();' : 'const r=document.createRange();r.selectNodeContents(e);const s=document.getSelection();s.removeAllRanges();s.addRange(r);'}if(document.activeElement!==e)throw new Error('Clipboard scratch field could not be focused');`), frameTarget);
  try {
    const mask = process.platform === 'darwin' ? 4 : 2;
    await cdp.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'c', windowsVirtualKeyCode: 67, modifiers: mask, commands: ['copy'] }, frameTarget);
    await cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', windowsVirtualKeyCode: 67, modifiers: mask }, frameTarget);
  } finally {
    await cdp.evaluate(`(()=>{const e=document.getElementById(${key});if(!e)return;const previous=e.__previous;e.remove();if(previous?.isConnected)previous.focus();})()`, frameTarget).catch(() => {});
  }
}

const AX_ACTIONS = new Set(['click', 'type_text', 'set_value', 'paste', 'press_key', 'scroll', 'select_text', 'secondary_action', 'drag']);

function axPoint(fields: BrowserObject): { x: number; y: number } | undefined {
  const raw = Array.isArray(fields.point) ? { x: fields.point[0], y: fields.point[1] } : fields;
  if (raw.x === undefined || raw.y === undefined) return undefined;
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new BrowserError('invalid_request', 'Point coordinates must be finite x and y values.');
  return { x, y };
}

function axPointFrom(value: unknown): { x: number; y: number } | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new BrowserError('invalid_request', 'The drag target point must be finite x and y values.');
  return { x, y };
}

async function resolveAxEntry(root: BrowserCdp, store: AxTabStore, fields: BrowserObject): Promise<AxRenderEntry> {
  if (!store.snapshotId || !store.entries) throw new BrowserError('invalid_request', 'No accessibility snapshot yet. Call ax_state first to obtain element indices.');
  if (fields.snapshotId !== undefined && String(fields.snapshotId) !== store.snapshotId) throw new BrowserError('stale_snapshot', 'The accessibility snapshot belongs to a previous capture. Call ax_state again for fresh element indices.');
  const documentKey = await currentDocumentKey(root);
  if (store.documentKey !== undefined && documentKey !== store.documentKey) throw new BrowserError('stale_snapshot', 'The accessibility snapshot belongs to a previous page. Call ax_state again.');
  const index = Number(fields.elementIndex ?? fields.index);
  if (!Number.isSafeInteger(index) || index < 0 || index >= store.entries.length) throw new BrowserError('invalid_request', `elementIndex must be an integer from 0 to ${store.entries.length - 1} of the latest ax_state.`);
  const entry = store.entries[index]!;
  if (entry.backendNodeId === undefined) throw new BrowserError('invalid_request', 'That element cannot be addressed by index.');
  return entry;
}

async function withAxElement<T>(root: BrowserCdp, entry: AxRenderEntry, work: (objectId: string) => Promise<T>): Promise<T> {
  const backendNodeId = entry.backendNodeId;
  if (backendNodeId === undefined) throw new BrowserError('invalid_request', 'That element cannot be addressed by index.');
  const frameTarget = entry.frameTarget;
  let objectId: string | undefined;
  try {
    const resolved = object(await root.command('DOM.resolveNode', { backendNodeId }, frameTarget));
    objectId = object(resolved.object).objectId as string | undefined;
    if (!objectId) throw new BrowserError('not_found', 'The element is no longer in the page. Call ax_state again for fresh element indices.');
    return await work(objectId);
  } catch (error) {
    if (error instanceof BrowserError && error.code === 'cdp_error' && /could not find node with given id/iu.test(error.message)) throw new BrowserError('not_found', 'The element is no longer in the page. Call ax_state again for fresh element indices.');
    throw error;
  } finally {
    if (objectId) await root.command('Runtime.releaseObject', { objectId }, frameTarget).catch(() => {});
  }
}

async function callOnAxElement(root: BrowserCdp, entry: AxRenderEntry, functionDeclaration: string, args: BrowserObject[]): Promise<BrowserObject> {
  return withAxElement(root, entry, async objectId => {
    const result = object(await root.command('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args, returnByValue: true }, entry.frameTarget));
    if (result.exceptionDetails) throw new BrowserError('evaluation_error', String(object(object(result.exceptionDetails).exception).description ?? 'The accessibility action failed in the page.'));
    return object(object(result.result).value);
  });
}

async function bridgeAxRef(root: BrowserCdp, entry: AxRenderEntry): Promise<{ scoped: BrowserCdp; ref: string }> {
  const info = await callOnAxElement(root, entry, MARK_REF_SOURCE, []);
  if (info.connected !== true) throw new BrowserError('not_found', 'The element was detached. Call ax_state again for fresh element indices.');
  return { scoped: entry.frameTarget ? frameCdp(root, entry.frameTarget) : root, ref: String(info.ref) };
}

async function focusAxElement(root: BrowserCdp, entry: AxRenderEntry): Promise<BrowserCdp> {
  await callOnAxElement(root, entry, 'function () { this.focus(); return { ok: true }; }', []);
  return entry.frameTarget ? frameCdp(root, entry.frameTarget) : root;
}

/** Hold one ordinary key down across a click sequence, modifiers ride the mouse events. */
async function withHeldKey(cdp: BrowserCdp, combo: AxKeyCombo | undefined, signal: AbortSignal | undefined, work: () => Promise<void>): Promise<void> {
  if (!combo || !combo.key) { await work(); return; }
  let mask = 0;
  for (const modifier of combo.modifiers) mask |= MODIFIER_BITS[modifier]!;
  const primary: BrowserObject = { key: combo.key, ...(combo.code ? { code: combo.code } : {}), windowsVirtualKeyCode: combo.virtualKeyCode ?? 0, modifiers: mask };
  try {
    assertBrowserActionActive(signal);
    await cdp.command('Input.dispatchKeyEvent', { ...primary, type: 'rawKeyDown' });
    await work();
  } finally {
    await cdp.command('Input.dispatchKeyEvent', { ...primary, type: 'keyUp' }).catch(() => {});
  }
}

const comboModifiers = (combo: AxKeyCombo | undefined): string[] | undefined => (combo ? combo.modifiers.map(modifier => modifier.toLowerCase()) : undefined);

async function dispatchAxAction(context: AxContext, root: BrowserCdp, store: AxTabStore, action: string, fields: BrowserObject): Promise<BrowserObject> {
  const signal = context.signal;
  switch (action) {
    case 'click': {
      const budget = locatorBudget(fields.timeoutMs, 30000, 60000, 'AX action timeoutMs');
      const holdMs = holdDurationMs(fields.duration, 'duration');
      const button = AX_MOUSE_BUTTONS[String(fields.mouseButton ?? fields.button ?? 'left').toLowerCase()];
      if (!button) throw new BrowserError('invalid_request', 'mouseButton must be left/l, right/r or middle/m.');
      const clickCount = Number(fields.clickCount ?? 1);
      if (![1, 2, 3].includes(clickCount)) throw new BrowserError('invalid_request', 'clickCount must be 1, 2 or 3.');
      const combo = fields.key !== undefined || fields.keys !== undefined ? parseXdotoolKey(Array.isArray(fields.keys) ? fields.keys.join('+') : fields.key) : undefined;
      const modifiersList = comboModifiers(combo);
      if (fields.elementIndex === undefined && fields.index === undefined) {
        const point = axPoint(fields);
        if (!point) throw new BrowserError('invalid_request', 'click needs an elementIndex or a point.');
        await withHeldKey(root, combo, signal, async () => {
          await click(root, { x: point.x, y: point.y, button, clickCount, ...(modifiersList ? { modifiers: modifiersList } : {}), ...(holdMs ? { holdMs } : {}) }, signal);
        });
        return { ok: true, action, via: 'point' };
      }
      const entry = await resolveAxEntry(root, store, fields);
      const bridged = await bridgeAxRef(root, entry);
      await withHeldKey(bridged.scoped, combo, signal, async () => {
        await click(bridged.scoped, { ref: bridged.ref, timeoutMs: budget, button, clickCount, ...(modifiersList ? { modifiers: modifiersList } : {}), ...(holdMs ? { holdMs } : {}) }, signal);
      });
      return { ok: true, action, elementIndex: entry.index, via: 'ax' };
    }
    case 'type_text': {
      if (typeof fields.text !== 'string') throw new BrowserError('invalid_request', 'type_text needs text.');
      if (fields.elementIndex === undefined && fields.index === undefined) {
        await typeText(root, { text: fields.text }, signal);
        return { ok: true, action, via: 'focus' };
      }
      const entry = await resolveAxEntry(root, store, fields);
      const bridged = await bridgeAxRef(root, entry);
      await typeText(bridged.scoped, { ref: bridged.ref, text: fields.text }, signal);
      return { ok: true, action, elementIndex: entry.index, via: 'ax' };
    }
    case 'set_value': {
      const raw = fields.value;
      if (typeof raw !== 'string' && typeof raw !== 'number') throw new BrowserError('invalid_request', 'set_value needs a string or number value.');
      const entry = await resolveAxEntry(root, store, fields);
      const result = await callOnAxElement(root, entry, SET_VALUE_SOURCE, [{ value: String(raw) }]);
      if (result.ok !== true) {
        if (result.reason === 'gone') throw new BrowserError('not_found', 'The element is no longer in the page. Call ax_state again.');
        if (result.reason === 'disabled') throw new BrowserError('invalid_request', 'That control is disabled, so its value cannot be set.');
        if (result.reason === 'not_settable') throw new BrowserError('invalid_request', `The value of that <${String(result.tag ?? 'element')}> cannot be set directly. Use click or type_text.`);
        if (result.reason === 'missing_option') throw new BrowserError('not_found', `No option matched. The select offers: ${JSON.stringify(result.available ?? [])}`);
        throw new BrowserError('host_error', `Setting the value failed: ${JSON.stringify(result)}`);
      }
      return { ok: true, action, elementIndex: entry.index, ...(result.tag !== undefined ? { tag: result.tag } : {}), ...(result.value !== undefined ? { value: result.value } : {}) };
    }
    case 'paste': {
      if (typeof fields.text !== 'string') throw new BrowserError('invalid_request', 'paste needs text.');
      const format = String(fields.format ?? 'text');
      if (!['text', 'md', 'html'].includes(format)) throw new BrowserError('invalid_request', 'paste format must be text, md or html.');
      let scoped: BrowserCdp = root;
      let elementIndex: number | undefined;
      if (fields.elementIndex !== undefined || fields.index !== undefined) {
        const entry = await resolveAxEntry(root, store, fields);
        elementIndex = entry.index;
        scoped = await focusAxElement(root, entry);
      }
      await writeVirtualClipboard(scoped, undefined, fields.text, format === 'html' ? fields.text : undefined, signal);
      await dispatchAxKeyCombo(scoped, parseXdotoolKey(process.platform === 'darwin' ? 'super+v' : 'ctrl+v'), undefined, undefined, signal);
      return { ok: true, action, format, ...(elementIndex === undefined ? {} : { elementIndex }) };
    }
    case 'press_key': {
      const combo = parseXdotoolKey(Array.isArray(fields.keys) ? fields.keys.join('+') : fields.key);
      const holdMs = holdDurationMs(fields.duration, 'duration');
      let scoped: BrowserCdp = root;
      if (fields.elementIndex !== undefined || fields.index !== undefined) {
        const entry = await resolveAxEntry(root, store, fields);
        scoped = await focusAxElement(root, entry);
      }
      await dispatchAxKeyCombo(scoped, combo, undefined, holdMs, signal);
      return { ok: true, action, key: combo.key, ...(holdMs ? { heldMs: holdMs } : {}) };
    }
    case 'scroll': {
      const direction = AX_SCROLL_DIRECTIONS[String(fields.direction ?? '').toLowerCase()];
      if (!direction) throw new BrowserError('invalid_request', 'scroll direction must be up, down, left or right (u/d/l/r accepted).');
      const pages = fields.pages === undefined ? 1 : Number(fields.pages);
      if (!Number.isFinite(pages) || pages < 0 || pages > 100) throw new BrowserError('invalid_request', 'scroll pages must be from 0 through 100.');
      let x: number;
      let y: number;
      let basis: number | undefined;
      let scoped: BrowserCdp = root;
      if (fields.elementIndex !== undefined || fields.index !== undefined) {
        const entry = await resolveAxEntry(root, store, fields);
        const located = await callOnAxElement(root, entry, ELEMENT_POINT_SOURCE, []);
        x = Number(located.x);
        y = Number(located.y);
        if (located.scrollable === true && Number(located.clientHeight) > 0) basis = Number(located.clientHeight);
        scoped = entry.frameTarget ? frameCdp(root, entry.frameTarget) : root;
      } else {
        const point = axPoint(fields);
        if (!point) throw new BrowserError('invalid_request', 'scroll needs an elementIndex or a point.');
        x = point.x;
        y = point.y;
      }
      const viewport = object(await scoped.evaluate('({width:innerWidth,height:innerHeight})'));
      const height = basis ?? Math.max(1, Number(viewport.height) - 24);
      const width = Math.max(1, Number(viewport.width) - 24);
      const deltaX = direction === 'left' ? -pages * width : direction === 'right' ? pages * width : 0;
      const deltaY = direction === 'up' ? -pages * height : direction === 'down' ? pages * height : 0;
      assertBrowserActionActive(signal);
      await scoped.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, pointerType: 'mouse' });
      return { ok: true, action, direction, pages, deltaX, deltaY };
    }
    case 'select_text': {
      if (typeof fields.text !== 'string' || !fields.text) throw new BrowserError('invalid_request', 'select_text needs the text to select.');
      const selectionType = String(fields.selectionType ?? 'text');
      if (!['text', 'cursor_before', 'cursor_after'].includes(selectionType)) throw new BrowserError('invalid_request', 'selectionType must be text, cursor_before or cursor_after.');
      const entry = await resolveAxEntry(root, store, fields);
      const result = await callOnAxElement(root, entry, SELECT_TEXT_SOURCE, [
        { value: fields.text },
        { value: fields.prefix === undefined ? null : String(fields.prefix) },
        { value: fields.suffix === undefined ? null : String(fields.suffix) },
        { value: selectionType },
      ]);
      if (result.ok !== true) {
        if (result.reason === 'gone') throw new BrowserError('not_found', 'The element is no longer in the page. Call ax_state again.');
        if (result.reason === 'not_editable') throw new BrowserError('invalid_request', 'select_text needs an editable element.');
        if (result.reason === 'not_found') throw new BrowserError('not_found', `No occurrence matched${Number(result.occurrences ?? 0) > 0 ? ` (${String(result.occurrences)} filtered by prefix/suffix)` : ''}. The text is not in this editable element.`);
        if (result.reason === 'ambiguous') throw new BrowserError('invalid_request', `${String(result.occurrences)} occurrences match. Disambiguate with prefix or suffix.`);
        if (result.reason === 'range_failed') throw new BrowserError('host_error', 'The selection range could not be placed.');
        throw new BrowserError('host_error', `Selecting text failed: ${JSON.stringify(result)}`);
      }
      return { ok: true, action, elementIndex: entry.index, selectionType, ...(result.start !== undefined ? { start: result.start } : {}), ...(result.end !== undefined ? { end: result.end } : {}) };
    }
    case 'secondary_action': {
      const name = fields.name ?? fields.secondaryAction;
      if (typeof name !== 'string' || !name.trim()) throw new BrowserError('invalid_request', 'secondary_action needs the exact exposed action name.');
      const entry = await resolveAxEntry(root, store, fields);
      if (!entry.actions.length) throw new BrowserError('invalid_request', 'This element exposes no secondary actions.');
      if (!entry.actions.includes(name)) throw new BrowserError('invalid_request', `Unknown action '${name}'. Exposed actions: ${entry.actions.join(', ')}. Do not guess action names.`);
      await callOnAxElement(root, entry, 'function () { this.scrollIntoView({ block: \'center\', inline: \'center\', behavior: \'instant\' }); return { ok: true }; }', []);
      return { ok: true, action, elementIndex: entry.index, secondaryAction: name };
    }
    case 'drag': {
      const from = axPoint(fields);
      const to = axPointFrom(fields.to);
      if (!from || !to) throw new BrowserError('invalid_request', 'drag needs a start point (point or x/y) and a to point.');
      await computerInput(root, { action: 'drag', path: [from, to], ...(fields.keys !== undefined ? { keys: fields.keys } : {}) }, signal);
      return { ok: true, action, from, to };
    }
    default:
      throw new BrowserError('invalid_request', `Unknown ax_action '${action}'.`);
  }
}

/** The `ax_action` operation; a failed interaction returns fresh state with the error. */
export async function performAxAction(context: AxContext, fields: BrowserObject): Promise<BrowserObject> {
  const root = rootCdp(context.cdp);
  const store = axStoreFor(root);
  const action = String(fields.action ?? '');
  if (!AX_ACTIONS.has(action)) throw new BrowserError('invalid_request', `ax_action needs an action: ${[...AX_ACTIONS].join(', ')}.`);
  // An explicit null element index means "no element" (the focused-element
  // path), matching the documented index-or-null spelling; normalize it to
  // absent so dispatch never reads null as element zero.
  if (fields.elementIndex === null || fields.index === null) {
    fields = { ...fields };
    if (fields.elementIndex === null) delete fields.elementIndex;
    if (fields.index === null) delete fields.index;
  }
  try {
    assertBrowserActionActive(context.signal);
    return await dispatchAxAction(context, root, store, action, fields);
  } catch (error) {
    if (error instanceof BrowserError && RECAPTURE_CODES.has(error.code) && store.snapshotId) {
      const fresh = await recaptureForError(context, store);
      if (fresh) throw new BrowserError(error.code, `${error.message}\n\nLatest accessibility state:\n${fresh}`);
    }
    throw error;
  }
}
