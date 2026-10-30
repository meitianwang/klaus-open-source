import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { directive } from 'micromark-extension-directive';
import { directiveFromMarkdown } from 'mdast-util-directive';
import { parse } from 'node-html-parser';
import { parseSelectedTextEnvelope } from './selected-text-envelope';

interface TextNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: TextNode[];
}

const blockChildren = new Set(['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'tableCell', 'containerDirective']);
const scriptClosings = { script: /<\/\s*script\s*>/i, style: /<\/\s*style\s*>/i };

/** Extract recognized request sections, retaining the whole request after a page context. */
export function sideTaskTitleRequest(input: string): string {
  const pageStart = '<page-comment-context>\n';
  const pageEnd = '\n</page-comment-context>\n';
  const requestStart = '## My request:\n';
  if (input.startsWith(pageStart)) {
    const end = input.indexOf(pageEnd, pageStart.length);
    const offset = end + pageEnd.length;
    if (end >= 0 && input.startsWith(requestStart, offset)) return input.slice(offset + requestStart.length).trim();
  }
  // The desktop's persisted quote format has numbered inline markers. Decode
  // only its validated envelope before applying the generic request rule.
  const selected = parseSelectedTextEnvelope(input);
  const request = selected?.message ?? input;
  const sections = request.split(/## My request(?: for Codex)?:/g);
  return (sections.length > 1 ? sections[sections.length - 1]! : request).trim();
}

function normalizeDirectives(input: string): string {
  if (!input.includes('::')) return input;
  let fence: { marker: string; length: number } | null = null;
  return input.split('\n').map(line => {
    const wasInFence = fence !== null;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match) {
      const delimiter = match[1]!;
      const suffix = match[2]!;
      const marker = delimiter[0]!;
      if (fence) {
        if (marker === fence.marker && delimiter.length >= fence.length && !suffix.trim()) fence = null;
      } else if (marker !== '`' || !suffix.includes('`')) fence = { marker, length: delimiter.length };
    }
    return wasInFence || fence ? line : line.replace(/(^|[^:])::([A-Za-z][A-Za-z0-9_-]*)(?=[[{])/g, '$1:$2');
  }).join('\n');
}

function plainNode(node: TextNode): string {
  if (node.type === 'html') {
    const value = node.value ?? '';
    if (/^(?:<!--(?:(?!-->)[\s\S])*-->\s*)+$/.test(value.trim())) return '';
    const html = parse(value);
    for (const element of [...html.querySelectorAll('script'), ...html.querySelectorAll('style')]) element.remove();
    return html.structuredText;
  }
  if (node.children) {
    const children: string[] = [];
    let suppressed: 'script' | 'style' | null = null;
    for (const child of node.children) {
      if (suppressed) {
        if (child.type === 'html' && scriptClosings[suppressed].test(child.value ?? '')) suppressed = null;
        continue;
      }
      if (child.type === 'html') {
        const opening = /<\s*(script|style)\b[^>]*>/i.exec(child.value ?? '');
        const tag = opening?.[1];
        if ((tag === 'script' || tag === 'style') && !opening![0].endsWith('/>') && !scriptClosings[tag].test(child.value ?? '')) {
          suppressed = tag;
          continue;
        }
      }
      children.push(plainNode(child));
    }
    return children.join(blockChildren.has(node.type) ? ' ' : '');
  }
  return node.value ?? node.alt ?? '';
}

/** Avoid literal autolinks consuming text inside an unbalanced Markdown label. */
function titleGfm() {
  const extension = gfm();
  if (!extension.text) return extension;
  const cache = new WeakMap<object, { index: number; token: { _balanced?: boolean } }>();
  for (const [code, constructs] of Object.entries(extension.text)) {
    if (!constructs) continue;
    extension.text[Number(code)] = (Array.isArray(constructs) ? constructs : [constructs]).map(construct => {
      if (!construct.name?.endsWith('Autolink')) return construct;
      const previous = construct.previous;
      return { ...construct, previous(code) {
        if (previous && !previous.call(this, code)) return false;
        const cached = cache.get(this.events);
        if (cached && this.events[cached.index]?.[1] === cached.token && !cached.token._balanced) return false;
        for (let index = this.events.length - 1; index >= 0; index--) {
          const token = this.events[index]![1];
          if ((token.type === 'labelLink' || token.type === 'labelImage') && !token._balanced) {
            cache.set(this.events, { index, token });
            return false;
          }
          if ('_gfmAutolinkLiteralWalkedInto' in token && token._gfmAutolinkLiteralWalkedInto === true) break;
        }
        return true;
      } } satisfies typeof construct;
    });
  }
  return extension;
}

const markdownExtensions = [titleGfm(), directive()];
const markdownTreeExtensions = [gfmFromMarkdown(), directiveFromMarkdown()];

/** Side labels use request text and Markdown structure, without a title-length cap. */
export function sideTaskTitle(input: string): string | null {
  const request = sideTaskTitleRequest(input);
  const text = normalizeDirectives(request.replace(/\uE200[^\uE201]*\uE201/g, '')).trim();
  if (!text) return null;
  if (/^[\p{L}\p{M}\p{N} .,!?\u0027\u0022’()-]+$/u.test(text)
    && !text.startsWith('-') && !/^\d+[.)](?: |$)/.test(text)) return text.replace(/ +/g, ' ');
  const tree = fromMarkdown(text, { extensions: markdownExtensions, mdastExtensions: markdownTreeExtensions });
  const title = plainNode(tree).replace(/\s+/g, ' ').trim();
  return title || null;
}
