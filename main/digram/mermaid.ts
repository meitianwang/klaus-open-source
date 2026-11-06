// Mermaid flowchart import.
//
// Extraction, not conversion: the source's coordinates, colors and styling are
// discarded by design — a Mermaid renderer's automatic layout is not an editorial
// decision worth keeping. What survives is the content: nodes, labels, shapes,
// edges, edge labels and subgraph membership. The rebuilt diagram is sized from
// its labels and arranged by our own layout engine, so the import is a first-class
// digram document rather than a trace of someone else's renderer.
//
// Supported subset: `flowchart`/`graph` with direction TD|TB|BT|LR|RL, the common
// node bracket shapes, solid/dotted/thick/open/bidirectional arrows, pipe and
// inline edge labels, chained statements (`A --> B --> C`) and nested subgraphs.
// Styling directives (style/classDef/class/linkStyle/click) are skipped and
// reported in a warnings ledger, because digram colors are semantic tones, not
// per-node paint. Other Mermaid diagram families are rejected with a targeted
// error naming what was detected.

import { document, emptyDocument, fitGroups, layout } from './model';
import { json, type Data } from '../visuals/data';
import type { Json } from '../ipc/contract';

export interface MermaidNode { id: string; label: string; shape: string }
export interface MermaidEdge { from: string; to: string; label: string; dash: boolean; arrow: boolean; bidirectional: boolean }
export interface MermaidGroup { id: string; label: string; parent?: string }
export interface MermaidParse {
  direction: 'down' | 'right';
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  groups: MermaidGroup[];
  /** child id (node or group) → innermost subgraph id */
  membership: Map<string, string>;
  warnings: string[];
}

const MAX_SOURCE_CHARS = 200_000;
const MAX_NODES = 2000;
const MAX_EDGES = 4000;

/** Diagram families we can name so the refusal is actionable, not generic. */
const OTHER_FAMILIES: Array<[RegExp, string]> = [
  [/^sequencediagram\b/i, 'sequenceDiagram'],
  [/^classdiagram\b/i, 'classDiagram'],
  [/^statediagram\b/i, 'stateDiagram'],
  [/^erdiagram\b/i, 'erDiagram'],
  [/^gantt\b/i, 'gantt'],
  [/^pie\b/i, 'pie'],
  [/^journey\b/i, 'journey'],
  [/^gitgraph\b/i, 'gitGraph'],
  [/^mindmap\b/i, 'mindmap'],
  [/^timeline\b/i, 'timeline'],
  [/^quadrantchart\b/i, 'quadrantChart'],
  [/^xychart\b/i, 'xychart'],
  [/^sankey\b/i, 'sankey'],
  [/^block(-beta)?\b/i, 'block diagram'],
  [/^requirement(diagram)?\b/i, 'requirementDiagram'],
  [/^c4(context|container|component|dynamic)?\b/i, 'C4 diagram'],
  [/^pie\b/i, 'pie'],
  [/^zenuml\b/i, 'zenuml'],
  [/^packet\b/i, 'packet'],
  [/^kanban\b/i, 'kanban'],
];

const ID_CHAR = /[A-Za-z0-9_\u0080-\uffff]/;
const DIRECTIVE = /^(style|classdef|class|click|linkstyle|callback)\b/i;

function isIdStart(char: string): boolean { return ID_CHAR.test(char); }

/** `<br/>` becomes a space (our labels wrap on their own), entities are decoded,
 *  remaining inline HTML tags are dropped. */
function cleanLabel(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&quot;|#quot;/g, '"')
    .replace(/&amp;|#38;/g, '&')
    .replace(/&lt;|#60;/g, '<')
    .replace(/&gt;|#62;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip `%%` comments outside quoted labels. */
function stripComment(line: string): string {
  let quote = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') quote = !quote;
    else if (!quote && char === '%' && line[index + 1] === '%') return line.slice(0, index);
  }
  return line;
}

interface NodeToken { id: string; label: string; shape: string; next: number }

const WRAPPERS: Array<{ open: string; close: string; shape: string }> = [
  { open: '[[', close: ']]', shape: 'rect' },
  { open: '[(', close: ')]', shape: 'cylinder' },
  { open: '((', close: '))', shape: 'ellipse' },
  { open: '([', close: '])', shape: 'pill' },
  { open: '{{', close: '}}', shape: 'hexagon' },
  { open: '[/', close: '/]', shape: 'parallelogram' },
  { open: '[\\', close: '\\]', shape: 'parallelogram' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'rounded' },
  { open: '{', close: '}', shape: 'diamond' },
  { open: '>', close: ']', shape: 'note' },
];

/** Scan one node token at `start`: a bare id, or an id followed by a bracket
 *  wrapper whose label may be quoted. Returns null when no token is present. */
function scanNodeToken(line: string, start: number): NodeToken | null {
  let cursor = start;
  while (cursor < line.length && /\s/.test(line[cursor]!)) cursor += 1;
  const idStart = cursor;
  while (cursor < line.length && isIdStart(line[cursor]!)) cursor += 1;
  if (cursor === idStart) return null;
  const id = line.slice(idStart, cursor);
  const wrapper = WRAPPERS.find(candidate => line.startsWith(candidate.open, cursor));
  if (!wrapper) return { id, label: id, shape: 'rect', next: cursor };
  const contentStart = cursor + wrapper.open.length;
  const closeAt = findClose(line, contentStart, wrapper.close);
  if (closeAt < 0) throw new Error(`Unbalanced "${wrapper.open}" in node "${id}".`);
  const label = unquote(line.slice(contentStart, closeAt));
  return { id, label: cleanLabel(label) || id, shape: wrapper.shape, next: closeAt + wrapper.close.length };
}

function findClose(line: string, from: number, close: string): number {
  let quote = false;
  for (let index = from; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') { quote = !quote; continue; }
    if (!quote && line.startsWith(close, index)) return index;
  }
  return -1;
}

function unquote(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

interface ArrowToken { label: string; dash: boolean; arrow: boolean; bidirectional: boolean; next: number }

/** Arrow heads we accept, longest first so `-.->` wins over `---` prefixes.
 *  `body` is what precedes the head; inline-label forms are handled separately. */
const HEADS: Array<{ text: string; dash: boolean; arrow: boolean; bidirectional: boolean }> = [
  { text: '<-.->', dash: true, arrow: true, bidirectional: true },
  { text: '<-->', dash: false, arrow: true, bidirectional: true },
  { text: '<==>', dash: false, arrow: true, bidirectional: true },
  { text: '-.->', dash: true, arrow: true, bidirectional: false },
  { text: '-->', dash: false, arrow: true, bidirectional: false },
  { text: '==>', dash: false, arrow: true, bidirectional: false },
  { text: '-.-', dash: true, arrow: false, bidirectional: false },
  { text: '---', dash: false, arrow: false, bidirectional: false },
  { text: '===', dash: false, arrow: false, bidirectional: false },
  { text: '--x', dash: false, arrow: true, bidirectional: false },
  { text: '--o', dash: false, arrow: true, bidirectional: false },
];

/** Scan one arrow at `start`, including the pipe-label form (`-->|text|`) and the
 *  inline-label forms (`-- text -->`, `-. text .->`, `== text ==>`). */
function scanArrow(line: string, start: number): ArrowToken | null {
  let cursor = start;
  while (cursor < line.length && /\s/.test(line[cursor]!)) cursor += 1;
  const rest = line.slice(cursor);
  // Inline-label forms first: they begin like an arrow body but carry text.
  const inline = /^(-\.+|-{2}|={2})\s+([^-=>.][\s\S]*?)\s*(\.->|-->|==>)/.exec(rest);
  if (inline) {
    const body = inline[1]!; const head = inline[3]!;
    return { label: cleanLabel(inline[2] ?? ''), dash: body.startsWith('-.'), arrow: head.endsWith('>'), bidirectional: false, next: cursor + inline[0].length };
  }
  for (const head of HEADS) {
    if (rest.startsWith(head.text)) {
      let next = cursor + head.text.length;
      let label = '';
      const after = line.slice(next);
      const pipe = /^\s*\|([^|]*)\|/.exec(after);
      if (pipe) { label = cleanLabel(pipe[1] ?? ''); next += pipe[0].length; }
      return { label, dash: head.dash, arrow: head.arrow, bidirectional: head.bidirectional, next };
    }
  }
  return null;
}

export function parseMermaidFlowchart(source: string): MermaidParse {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Import source is empty.');
  if (source.length > MAX_SOURCE_CHARS) throw new Error(`Import source exceeds ${MAX_SOURCE_CHARS} characters; split the diagram.`);

  const warnings: string[] = [];
  const nodes = new Map<string, MermaidNode>();
  const groups = new Map<string, MermaidGroup>();
  const membership = new Map<string, string>();
  const edges: MermaidEdge[] = [];
  let direction: 'down' | 'right' = 'down';
  let headerSeen = false;
  let skippedDirectives = 0;
  const groupStack: string[] = [];

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const raw = stripComment(lines[lineNumber] ?? '');
    for (const statementRaw of raw.split(';')) {
      const line = statementRaw.trim();
      if (!line) continue;
      if (!headerSeen) {
        const header = /^(?:flowchart|graph)\s+(td|tb|bt|lr|rl)?\s*$/i.exec(line);
        if (header) {
          headerSeen = true;
          const token = (header[1] ?? 'td').toLowerCase();
          direction = token === 'lr' || token === 'rl' ? 'right' : 'down';
          if (token === 'bt') warnings.push('Bottom-to-top direction is drawn top-to-bottom.');
          if (token === 'rl') warnings.push('Right-to-left direction is drawn left-to-right.');
          continue;
        }
        const known = OTHER_FAMILIES.find(([pattern]) => pattern.test(line));
        if (known) throw new Error(`digram_import supports Mermaid flowchart/graph only; detected ${known[1]}. Draw it with digram_edit ops instead${['gantt', 'pie', 'sankey', 'quadrantChart', 'xychart'].includes(known[1]) ? ' — digram has a native chart node for this kind' : ''}.`);
        throw new Error(`Not a Mermaid flowchart: expected a "flowchart" or "graph" header, found "${line.slice(0, 60)}".`);
      }
      const subgraph = /^subgraph\s+(.+)$/i.exec(line);
      if (subgraph) {
        const spec = subgraph[1]!.trim();
        const bracketed = /^([^\s[]+)\s*\[(.+)\]$/.exec(spec);
        const label = cleanLabel(bracketed ? unquote(bracketed[2]!) : unquote(spec));
        let id = bracketed ? bracketed[1]! : `sg-${groups.size + 1}`;
        if (nodes.has(id) || groups.has(id)) id = `sg-${id}`;
        const group: MermaidGroup = { id, label: label || id };
        const parent = groupStack[groupStack.length - 1];
        if (parent) { group.parent = parent; membership.set(id, parent); }
        groups.set(id, group);
        groupStack.push(id);
        continue;
      }
      if (/^end$/i.test(line)) {
        if (!groupStack.length) warnings.push(`Line ${lineNumber + 1}: "end" without an open subgraph was ignored.`);
        else groupStack.pop();
        continue;
      }
      if (DIRECTIVE.test(line)) { skippedDirectives += 1; continue; }
      if (/^direction\s+/i.test(line)) { warnings.push(`Line ${lineNumber + 1}: per-subgraph direction is ignored; the page direction applies.`); continue; }

      // Statement: nodeToken (arrow nodeToken)*
      const tokens: NodeToken[] = [];
      const arrows: ArrowToken[] = [];
      let cursor = 0;
      const first = scanNodeToken(line, cursor);
      if (!first) { warnings.push(`Line ${lineNumber + 1}: skipped unparseable statement "${line.slice(0, 60)}".`); continue; }
      tokens.push(first); cursor = first.next;
      for (;;) {
        const arrow = scanArrow(line, cursor);
        if (!arrow) break;
        const nextToken = scanNodeToken(line, arrow.next);
        if (!nextToken) { warnings.push(`Line ${lineNumber + 1}: arrow without a target node was skipped.`); break; }
        arrows.push(arrow); tokens.push(nextToken); cursor = nextToken.next;
      }
      for (const token of tokens) registerNode(token);
      for (let index = 0; index < arrows.length; index += 1) {
        const from = tokens[index]!; const to = tokens[index + 1]!; const arrow = arrows[index]!;
        if (from.id === to.id) { warnings.push(`Line ${lineNumber + 1}: self-loop on "${from.id}" was skipped.`); continue; }
        if (edges.length >= MAX_EDGES) throw new Error(`Import exceeds ${MAX_EDGES} edges; split the diagram.`);
        edges.push({ from: from.id, to: to.id, label: arrow.label, dash: arrow.dash, arrow: arrow.arrow, bidirectional: arrow.bidirectional });
      }
    }
  }
  if (!headerSeen) throw new Error('Not a Mermaid flowchart: no "flowchart" or "graph" header found.');
  if (groupStack.length) warnings.push(`${groupStack.length} subgraph(s) were never closed with "end"; they were closed at the document end.`);
  if (skippedDirectives) warnings.push(`${skippedDirectives} styling directive(s) skipped — digram colors are semantic tones set with the tone field.`);
  if (!nodes.size) throw new Error('The flowchart contains no nodes.');
  if (nodes.size + groups.size > MAX_NODES) throw new Error(`Import exceeds ${MAX_NODES} cells; split the diagram.`);

  function registerNode(token: NodeToken): void {
    // Edges may reference a subgraph id directly; the group cell is the endpoint then.
    if (!nodes.has(token.id) && groups.has(token.id)) return;
    const existing = nodes.get(token.id);
    if (existing) {
      // A later bracketed re-declaration upgrades a bare reference's shape/label.
      if (existing.label === existing.id && token.label !== token.id) { existing.label = token.label; existing.shape = token.shape; }
      return;
    }
    nodes.set(token.id, { id: token.id, label: token.label, shape: token.shape });
    const parent = groupStack[groupStack.length - 1];
    if (parent && !membership.has(token.id)) membership.set(token.id, parent);
  }

  return { direction, nodes: [...nodes.values()], edges, groups: [...groups.values()], membership, warnings };
}

// ------------------------------------------------------------------ document

/** Rough label width without a DOM: CJK glyphs count as one em, ASCII as ~0.58. */
function estimateTextWidth(label: string, fontSize: number): number {
  let em = 0;
  for (const char of label) em += (char.codePointAt(0) ?? 32) >= 0x2e80 ? 1 : 0.58;
  return em * fontSize;
}

function nodeSize(label: string, shape: string): { w: number; h: number } {
  const width = Math.round(Math.min(320, Math.max(92, estimateTextWidth(label, 14) + 36)));
  const height = shape === 'diamond' ? Math.max(72, Math.round(width * 0.5)) : shape === 'pill' ? 44 : shape === 'cylinder' ? 60 : 48;
  return { w: shape === 'diamond' ? Math.round(width * 1.25) : width, h: height };
}

/** Build the import result as a laid-out document draft (no id/session yet).
 *  The store stamps identity when it saves. */
export function mermaidToDocumentDraft(parse: MermaidParse, title: string): { draft: { title: string; pages: Json[] }; stats: { nodes: number; edges: number; groups: number } } {
  const cells: Data[] = [];
  const groupIds = new Set(parse.groups.map(group => group.id));
  for (const group of parse.groups) {
    cells.push({ id: group.id, x: 0, y: 0, w: 200, h: 100, shape: 'group', label: group.label, labelValign: 'top', labelAlign: 'start', ...(group.parent ? { parent: group.parent } : {}) });
  }
  for (const item of parse.nodes) {
    const size = nodeSize(item.label, item.shape);
    const parent = parse.membership.get(item.id);
    cells.push({ id: item.id, x: 0, y: 0, ...size, shape: item.shape, label: item.label, ...(parent && groupIds.has(parent) ? { parent } : {}) });
  }
  const edgeCells: Data[] = parse.edges.map((item, index) => ({
    id: `mmd-e${index + 1}`,
    from: item.from,
    to: item.to,
    label: item.label,
    ...(item.dash ? { dash: true } : {}),
    ...(item.arrow ? {} : { arrowTo: 'none' }),
    ...(item.bidirectional ? { arrowFrom: 'arrow' } : {}),
  }));
  const base = document({ ...emptyDocument('import-draft', title, 'import'), pages: [{ id: 'p1', name: 'Page 1', nodes: cells, edges: edgeCells }] });
  const laidOut = layout(base, { kind: 'flow', direction: parse.direction, gap: 64 });
  const fitted = parse.groups.length ? fitGroups(laidOut) : laidOut;
  return { draft: { title, pages: json(fitted.pages) as Json[] }, stats: { nodes: parse.nodes.length, edges: parse.edges.length, groups: parse.groups.length } };
}
