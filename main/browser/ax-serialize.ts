import { BrowserError } from './types';

/**
 * Pure accessibility-state rendering: tree filtering, line format, diffing and
 * key-syntax parsing. Nothing here imports Electron or CDP so the whole
 * observation contract is unit-testable in plain node suites.
 */

export interface AxWireValue { type?: string; value?: unknown; relatedNodes?: unknown }
export interface AxWireProperty { name?: string; value?: AxWireValue | unknown }
export interface AxWireNode {
  nodeId?: string;
  ignored?: boolean;
  role?: AxWireValue | string;
  chromeRole?: AxWireValue | string;
  name?: AxWireValue | string;
  description?: AxWireValue | string;
  value?: AxWireValue | string;
  properties?: AxWireProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface AxNodeMeta { bounds?: [number, number, number, number]; tag?: string; inputType?: string }

export interface AxFrameViewport { scrollX: number; scrollY: number; width: number; height: number }

export interface AxFrameInput {
  frameTarget?: string;
  nodes: AxWireNode[];
  meta: Map<number, AxNodeMeta>;
  viewport?: AxFrameViewport | null;
}

export interface AxRenderEntry {
  index: number;
  identity: string;
  line: string;
  depth: number;
  backendNodeId?: number;
  frameTarget?: string;
  actions: string[];
  focused: boolean;
}

export const AX_NO_CHANGE_TEXT = 'There has been no change in the accessibility tree.';
export const AX_DIFF_HEADER = 'The following is a diff from the previous accessibility tree with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.';
export const AX_REMOVED_PREFIX = 'Removed element IDs: ';
export const AX_SELECTED_TEXT_NOTE = 'Note: pay special attention to the selected content. When the user refers to something on screen, they may mean this selection, though they may also mean something else that is visible.';

/** A diff must save at least this share of the full tree, or the full tree ships. */
export const AX_DIFF_MIN_SAVED_RATIO = 0.2;
/** A diff must also save at least this many characters to be worth emitting. */
export const AX_DIFF_MIN_SAVED_CHARS = 512;
/** Hard ceiling on one rendered state, independent of the caller's budget. */
export const AX_TEXT_HARD_LIMIT = 200_000;

const NAME_LIMIT = 160;
const VALUE_LIMIT = 200;
const DESCRIPTION_LIMIT = 80;
const SELECTED_TEXT_LIMIT = 2000;
const MAX_DEPTH = 80;

const wireValue = (value: AxWireValue | string | undefined): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const inner = value.value;
  if (typeof inner === 'string') return inner;
  if (typeof inner === 'number' || typeof inner === 'boolean') return String(inner);
  return '';
};

const singleLine = (value: string, limit: number): string => {
  const flat = value.replace(/\s+/gu, ' ').trim();
  const clipped = Array.from(flat).slice(0, limit).join('');
  return clipped.length < flat.length ? `${clipped}\u2026` : clipped;
};

const quote = (value: string): string => value.replace(/"/gu, "'");

export function axRoleOf(node: AxWireNode): string {
  const role = wireValue(node.role) || wireValue(node.chromeRole);
  if (role === 'StaticText') return 'text';
  return role || 'unknown';
}

function propertiesOf(node: AxWireNode): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const property of node.properties ?? []) {
    if (!property || typeof property.name !== 'string') continue;
    const value = property.value as AxWireValue | undefined;
    out.set(property.name, value && typeof value === 'object' ? value.value : value);
  }
  return out;
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'treeitem', 'disclosuretriangle',
  'scrollbar', 'searchfield', 'input', 'popbutton', 'radiogroup', 'splitter', 'row', 'cell', 'gridcell', 'columnheader', 'rowheader',
]);

const STRUCTURAL_ROLES = new Set([
  'heading', 'img', 'image', 'video', 'audio', 'dialog', 'alertdialog', 'alert', 'menu', 'menubar', 'tree', 'grid',
  'table', 'form', 'search', 'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'tablist', 'toolbar',
  'list', 'listitem', 'article', 'document', 'feed', 'log', 'marquee', 'status', 'timer', 'tooltip', 'application',
  'group', 'region', 'WebArea', 'RootWebArea', 'paragraph', 'code', 'pre', 'blockquote', 'definition', 'term',
  'figure', 'caption', 'directory', 'comment', 'presentation', 'none', 'generic', 'GenericContainer', 'Section', 'section',
]);

/** Roles whose AX value carries user-meaningful content worth rendering. */
const VALUE_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'scrollbar', 'code', 'math', 'timer', 'text',
  'searchfield', 'progressbar', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'cell', 'gridcell',
]);

/** Containers rendered only when they carry a name, value or state. */
const FLATTEN_ROLES = new Set(['generic', 'GenericContainer', 'none', 'presentation', 'group', 'Section', 'section', 'paragraph', 'blockquote', 'article', 'region', 'document', 'figure', 'definition', 'term', 'directory']);

const DROP_ROLES = new Set(['InlineTextBox', 'LineBreak', 'ignored']);

function stateTokens(node: AxWireNode, meta: AxNodeMeta | undefined): string[] {
  const properties = propertiesOf(node);
  const tokens: string[] = [];
  if (properties.get('focused') === true) tokens.push('focused');
  if (properties.get('disabled') === true) tokens.push('disabled');
  if (properties.get('required') === true) tokens.push('required');
  if (properties.get('editable') === true) tokens.push('editable');
  const checked = properties.get('checked');
  if (checked === true) tokens.push('checked');
  else if (checked === 'mixed') tokens.push('checked=mixed');
  if (properties.get('selected') === true) tokens.push('selected');
  const expanded = properties.get('expanded');
  if (expanded === true) tokens.push('expanded');
  else if (expanded === false && (node.role !== undefined || properties.has('expanded'))) tokens.push('collapsed');
  if (properties.get('pressed') === true) tokens.push('pressed');
  if (properties.get('invalid') === true || properties.get('invalid') === 'true') tokens.push('invalid');
  const level = properties.get('level');
  if (typeof level === 'number' && Number.isFinite(level)) tokens.push(`level=${level}`);
  const modal = properties.get('modal');
  if (modal === true) tokens.push('modal');
  if (meta?.inputType === 'password') tokens.push('password');
  return tokens;
}

function isOffscreen(meta: AxNodeMeta | undefined, viewport: AxFrameViewport | null | undefined): boolean {
  if (!meta?.bounds || !viewport) return false;
  const [x, y, width, height] = meta.bounds;
  if (!(width > 0) || !(height > 0)) return false;
  const right = viewport.scrollX + viewport.width;
  const bottom = viewport.scrollY + viewport.height;
  return x + width <= viewport.scrollX || x >= right || y + height <= viewport.scrollY || y >= bottom;
}

export function axIdentity(frameTarget: string | undefined, backendNodeId: number): string {
  return `${frameTarget ?? ''}#${backendNodeId}`;
}

/**
 * Render one frame's wire nodes into flat entries. Child frames graft under
 * their owner node when `owners` maps the frame target to the owner's
 * backend node id; ungrafted frames render as trailing sections.
 */
export function buildAxEntries(frames: AxFrameInput[], owners: Map<string, number>): AxRenderEntry[] {
  const entries: AxRenderEntry[] = [];
  const consumed = new Set<string>();

  const renderFrame = (frame: AxFrameInput, depth: number, visited: Set<string>): void => {
    const byId = new Map<string, AxWireNode>();
    for (const node of frame.nodes) if (typeof node.nodeId === 'string') byId.set(node.nodeId, node);
    const referenced = new Set<string>();
    for (const node of frame.nodes) for (const child of node.childIds ?? []) referenced.add(child);
    const roots = frame.nodes.filter(node => typeof node.nodeId === 'string' && !referenced.has(node.nodeId));
    const start = roots.length ? roots : frame.nodes.slice(0, 1);

    const walk = (node: AxWireNode, currentDepth: number): void => {
      if (typeof node.nodeId === 'string') {
        if (visited.has(node.nodeId)) return;
        visited.add(node.nodeId);
      }
      const children = (node.childIds ?? []).map(id => byId.get(id)).filter((child): child is AxWireNode => child !== undefined);
      if (node.ignored === true || DROP_ROLES.has(axRoleOf(node))) {
        for (const child of children) walk(child, currentDepth);
        return;
      }
      const role = axRoleOf(node);
      const backendNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined;
      const meta = backendNodeId === undefined ? undefined : frame.meta.get(backendNodeId);
      const rawName = wireValue(node.name);
      const name = singleLine(rawName, NAME_LIMIT);
      const isPassword = meta?.inputType === 'password';
      const rawValue = wireValue(node.value);
      const value = isPassword || !rawValue ? '' : singleLine(rawValue, VALUE_ROLES.has(role) || role === 'text' ? VALUE_LIMIT : 0);
      const description = singleLine(wireValue(node.description), DESCRIPTION_LIMIT);
      const states = stateTokens(node, meta);
      const interactive = INTERACTIVE_ROLES.has(role);
      const interesting = Boolean(name) || Boolean(value) || states.length > 0 || interactive || role === 'text' || role === 'heading';
      const actions: string[] = [];
      if (backendNodeId !== undefined && isOffscreen(meta, frame.viewport)) actions.push('Scroll to Visible');

      if (!interesting && (FLATTEN_ROLES.has(role) || !STRUCTURAL_ROLES.has(role))) {
        for (const child of children) walk(child, currentDepth);
        return;
      }
      if (!interesting && children.length) {
        for (const child of children) walk(child, currentDepth);
        return;
      }
      if (currentDepth > MAX_DEPTH) return;

      const index = entries.length;
      const parts = [`[${index}]`, role];
      if (name) parts.push(`"${quote(name)}"`);
      if (value) parts.push(`value="${quote(value)}"`);
      if (description) parts.push(`description="${quote(description)}"`);
      parts.push(...states);
      if (actions.length) parts.push(`actions: ${actions.join(', ')}`);
      const identity = backendNodeId === undefined ? `${frame.frameTarget ?? ''}#unassigned:${index}` : axIdentity(frame.frameTarget, backendNodeId);
      entries.push({
        index, identity, depth: currentDepth, line: `${'  '.repeat(currentDepth)}${parts.join(' ')}`,
        ...(backendNodeId === undefined ? {} : { backendNodeId }), ...(frame.frameTarget ? { frameTarget: frame.frameTarget } : {}),
        actions, focused: states.includes('focused'),
      });

      if (backendNodeId !== undefined) {
        for (const [frameTarget, ownerBackend] of owners) {
          if (ownerBackend === backendNodeId && !consumed.has(frameTarget)) {
            const child = frames.find(entry => entry.frameTarget === frameTarget);
            if (child) { consumed.add(frameTarget); renderFrame(child, currentDepth + 1, new Set()); }
          }
        }
      }
      for (const child of children) walk(child, currentDepth + 1);
    };
    for (const root of start) walk(root, depth);
  };

  const primary = frames.find(frame => frame.frameTarget === undefined) ?? frames[0];
  if (primary) renderFrame(primary, 0, new Set());
  for (const frame of frames) {
    if (frame === primary || consumed.has(frame.frameTarget ?? '')) continue;
    renderFrame(frame, 0, new Set());
  }
  return entries;
}

/** Collapse sorted element ids into inclusive ranges, e.g. `3-7, 12`. */
export function removedIdRanges(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const id of sorted) {
    if (start === undefined) { start = id; previous = id; continue; }
    if (id === (previous ?? 0) + 1) { previous = id; continue; }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = id; previous = id;
  }
  if (start !== undefined) parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return parts.join(', ');
}

export interface AxPreviousLine { index: number; line: string }

export interface AxRenderOptions {
  title: string;
  url: string;
  entries: AxRenderEntry[];
  previous?: Map<string, AxPreviousLine>;
  disableDiffing?: boolean;
  selectedText?: string;
  maxChars: number;
}

export interface AxRenderResult {
  text: string;
  mode: 'full' | 'diff' | 'unchanged';
  added: number;
  changed: number;
  removedIds: number[];
  truncated: boolean;
  shown: number;
  total: number;
}

function focusedFooter(entries: AxRenderEntry[]): string[] {
  const focused = entries.find(entry => entry.focused);
  if (!focused) return [];
  return [`The focused UI element is ${focused.line.trim()}.`];
}

function selectedFooter(selectedText: string | undefined): string[] {
  const text = singleLine(selectedText ?? '', SELECTED_TEXT_LIMIT);
  if (!text) return [];
  return [`Selected text: \`\`\`${text}\`\`\``, AX_SELECTED_TEXT_NOTE];
}

export function renderAxStateText(options: AxRenderOptions): AxRenderResult {
  const budget = Math.min(Math.max(1, options.maxChars), AX_TEXT_HARD_LIMIT);
  const header = [`Title: ${singleLine(options.title, 300)}`, `URL: ${options.url}`];
  const footers = [...focusedFooter(options.entries), ...selectedFooter(options.selectedText)];
  const total = options.entries.length;

  const assemble = (body: string[], truncated: boolean, shown: number): string => {
    const lines = [...header, '', ...body];
    if (truncated) lines.push(`[truncated: showing ${shown} of ${total} elements]`);
    if (footers.length) lines.push('', ...footers);
    return lines.join('\n');
  };

  const fitBody = (lines: string[]): { body: string[]; truncated: boolean } => {
    const reserved = header.join('\n').length + footers.join('\n').length + 80;
    let used = reserved;
    const body: string[] = [];
    for (const line of lines) {
      if (used + line.length + 1 > budget) return { body, truncated: true };
      body.push(line);
      used += line.length + 1;
    }
    return { body, truncated: false };
  };

  const fullLines = options.entries.map(entry => entry.line);

  if (options.previous && !options.disableDiffing) {
    const previous = options.previous;
    const added: number[] = [];
    const changed: number[] = [];
    const diffLines: string[] = [];
    const seen = new Set<string>();
    options.entries.forEach((entry, position) => {
      seen.add(entry.identity);
      const before = previous.get(entry.identity);
      if (!before) { added.push(entry.index); diffLines.push(`+ ${entry.line}`); }
      else if (before.line !== entry.line) { changed.push(entry.index); diffLines.push(`~ ${entry.line}`); }
      void position;
    });
    const removedIds: number[] = [];
    for (const [identity, line] of previous) if (!seen.has(identity)) removedIds.push(line.index);
    if (!added.length && !changed.length && !removedIds.length) {
      return { text: assemble([AX_NO_CHANGE_TEXT], false, total), mode: 'unchanged', added: 0, changed: 0, removedIds: [], truncated: false, shown: total, total };
    }
    const body: string[] = [AX_DIFF_HEADER, ...diffLines];
    if (removedIds.length) body.push(`${AX_REMOVED_PREFIX}${removedIdRanges(removedIds)}`);
    const diffChars = body.reduce((sum, line) => sum + line.length + 1, 0);
    const fullChars = fullLines.reduce((sum, line) => sum + line.length + 1, 0);
    const savesEnough = fullChars - diffChars >= AX_DIFF_MIN_SAVED_CHARS && diffChars <= fullChars * (1 - AX_DIFF_MIN_SAVED_RATIO);
    if (!savesEnough) {
      const fitted = fitBody(fullLines);
      return { text: assemble(fitted.body, fitted.truncated, fitted.body.length), mode: 'full', added: added.length, changed: changed.length, removedIds, truncated: fitted.truncated, shown: fitted.body.length, total };
    }
    const fitted = fitBody(body);
    return { text: assemble(fitted.body, fitted.truncated, diffLines.length), mode: 'diff', added: added.length, changed: changed.length, removedIds, truncated: fitted.truncated, shown: diffLines.length, total };
  }

  const fitted = fitBody(fullLines);
  return { text: assemble(fitted.body, fitted.truncated, fitted.body.length), mode: 'full', added: 0, changed: 0, removedIds: [], truncated: fitted.truncated, shown: fitted.body.length, total };
}

export interface AxKeyCombo {
  /** Canonical modifier names in dispatch order. */
  modifiers: Array<'Meta' | 'Control' | 'Alt' | 'Shift'>;
  key: string;
  code?: string;
  virtualKeyCode?: number;
  /** True when the primary key emits its name as text (letters, digits, space). */
  printable: boolean;
}

const MODIFIER_TOKENS: Record<string, 'Meta' | 'Control' | 'Alt' | 'Shift'> = {
  super: 'Meta', meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta',
  ctrl: 'Control', control: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
};

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', page_up: 'PageUp', page_down: 'PageDown',
  space: ' ', spacebar: ' ', plus: '+', minus: '-',
};

const NAMED_KEY_CODES: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Insert: 45,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32,
};

/** Parse an xdotool-style key expression such as `Return`, `super+c` or `KP_0`. */
export function parseXdotoolKey(input: unknown): AxKeyCombo {
  if (typeof input !== 'string' || !input.trim()) throw new BrowserError('invalid_request', 'A key expression is required.');
  const tokens = input.trim().split('+');
  const modifiers: Array<'Meta' | 'Control' | 'Alt' | 'Shift'> = [];
  let keyToken: string | undefined;
  for (const [position, rawToken] of tokens.entries()) {
    const token = rawToken.trim();
    const lower = token.toLowerCase();
    const modifier = MODIFIER_TOKENS[lower];
    if (modifier) { if (!modifiers.includes(modifier)) modifiers.push(modifier); continue; }
    if (!token && position === tokens.length - 1 && tokens.length > 1) { keyToken = '+'; continue; }
    if (keyToken !== undefined) throw new BrowserError('invalid_request', `Only one ordinary key is supported in '${input}'.`);
    keyToken = token;
  }
  if (keyToken === undefined) throw new BrowserError('invalid_request', `'${input}' contains only modifiers; add one ordinary key.`);
  const numpad = /^KP_(\d)$/iu.exec(keyToken);
  if (numpad) {
    const digit = numpad[1]!;
    return { modifiers, key: digit, code: `Numpad${digit}`, virtualKeyCode: 96 + Number(digit), printable: true };
  }
  if (/^KP_/iu.test(keyToken)) {
    const named = KEY_ALIASES[keyToken.slice(3).toLowerCase()];
    if (!named) throw new BrowserError('invalid_request', `Unknown numpad key '${keyToken}'.`);
    return { modifiers, key: named, code: `Numpad${named === ' ' ? '0' : named}`, virtualKeyCode: NAMED_KEY_CODES[named], printable: named === ' ' };
  }
  const lowered = keyToken.toLowerCase();
  const key = KEY_ALIASES[lowered] ?? keyToken;
  if (Array.from(key).length > 1) {
    if (/^F([1-9]|1[0-9]|2[0-4])$/iu.test(key)) {
      return { modifiers, key: key.toUpperCase(), code: key.toUpperCase(), virtualKeyCode: 111 + Number(key.slice(1)), printable: false };
    }
    if (!NAMED_KEY_CODES[key] && !['Shift', 'Control', 'Alt', 'Meta'].includes(key)) throw new BrowserError('invalid_request', `Unknown key name '${keyToken}'.`);
  }
  const virtualKeyCode = NAMED_KEY_CODES[key] ?? (Array.from(key).length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
  const code = Array.from(key).length === 1
    ? (/[a-z]/iu.test(key) ? `Key${key.toUpperCase()}` : /[0-9]/u.test(key) ? `Digit${key}` : undefined)
    : (NAMED_KEY_CODES[key] !== undefined ? key : undefined);
  return { modifiers, key, ...(code ? { code } : {}), ...(virtualKeyCode !== undefined ? { virtualKeyCode } : {}), printable: Array.from(key).length === 1 };
}

/** Validate a hold duration in seconds (0 through 30) and return milliseconds. */
export function holdDurationMs(input: unknown, field: string): number | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > 30) throw new BrowserError('invalid_request', `${field} must be a number of seconds from 0 through 30.`);
  return Math.round(input * 1000);
}

export const AX_MOUSE_BUTTONS: Record<string, 'left' | 'right' | 'middle'> = {
  left: 'left', l: 'left', right: 'right', r: 'right', middle: 'middle', m: 'middle',
};

export const AX_SCROLL_DIRECTIONS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  up: 'up', u: 'up', down: 'down', d: 'down', left: 'left', l: 'left', right: 'right', r: 'right',
};
