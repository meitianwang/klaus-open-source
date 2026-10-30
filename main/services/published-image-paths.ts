import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mimeForExtension } from './media';
import { pathInside } from './workspaces';

interface MarkdownNode {
  type: string;
  url?: string;
  children?: MarkdownNode[];
}

/** Collect image destinations from prose, tables, lists and blockquotes; code is never a publication. */
function imageHrefs(text: string): string[] {
  let root: MarkdownNode;
  try {
    root = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MarkdownNode;
  } catch {
    return [];
  }
  const hrefs: string[] = [];
  const walk = (node: MarkdownNode): void => {
    if (node.type === 'image' && typeof node.url === 'string') hrefs.push(node.url);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return hrefs;
}

/** Only explicit image embeds publish files from the managed output directory. */
export function publishedImagePaths(text: string, root: string, sessionId: string): string[] {
  if (!sessionId || !root || !isAbsolute(root)) return [];
  const paths = new Set<string>();
  for (const href of imageHrefs(text)) {
    let path = href;
    if (/^sandbox:/iu.test(path)) path = path.slice(8);
    try {
      if (/^file:/iu.test(path)) path = fileURLToPath(path);
      else {
        try { path = decodeURI(path).replace(/%23/giu, '#').replace(/%3F/giu, '?'); }
        catch { /* Literal percent signs remain valid filenames. */ }
      }
      if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) continue;
      path = resolve(path);
      const eligible = (candidate: string, directory: string): boolean => {
        if (!pathInside(candidate, directory)) return false;
        const parts = relative(directory, candidate).split(sep);
        // Flat files predate conversation output directories. Nested outputs are
        // confined to their owner; a reference never admits a sibling directory.
        return parts.length === 1 || parts[0] === sessionId;
      };
      if (!eligible(path, resolve(root)) || !mimeForExtension(extname(path).slice(1))?.startsWith('image/')) continue;
      const canonicalRoot = realpathSync(root), canonical = realpathSync(path);
      if (canonicalRoot !== resolve(realpathSync(dirname(root)), basename(root)) || !eligible(canonical, canonicalRoot)
        || !statSync(canonical).isFile()) continue;
      paths.add(path);
    } catch { /* Missing files and symlink escapes do not grant a capability. */ }
  }
  return [...paths];
}
