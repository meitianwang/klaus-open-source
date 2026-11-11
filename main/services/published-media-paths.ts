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
    root = fromMarkdown(text, { extensions: [gfm({ singleTilde: false })], mdastExtensions: [gfmFromMarkdown()] }) as MarkdownNode;
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

/**
 * Explicit image embeds in an assistant-authored message publish the exact file
 * they name.
 *
 * The message is the publication: the reply points the user at that image, and
 * the renderer will ask the media channel for the same absolute path. Which
 * command wrote the file, and whether it used an absolute, `~/` or relative
 * spelling, no longer matters. Inside the managed output store the per-
 * conversation ownership rule still applies; outside it, an existing regular
 * image, audio or video file is enough. Code blocks, prose, links and user messages never
 * publish anything.
 */
export function publishedMediaPaths(text: string, root: string, sessionId: string): string[] {
  if (!sessionId || !root || !isAbsolute(root)) return [];
  const paths = new Set<string>();
  const managedRoot = resolve(root);
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
      if (!/^(?:image|audio|video)\//u.test(mimeForExtension(extname(path).slice(1)) ?? '')) continue;
      const eligible = (candidate: string, directory: string): boolean => {
        if (!pathInside(candidate, directory)) return false;
        const parts = relative(directory, candidate).split(sep);
        // Flat files predate conversation output directories. Nested outputs are
        // confined to their owner; a reference never admits a sibling directory.
        return parts.length === 1 || parts[0] === sessionId;
      };
      const canonical = realpathSync(path);
      if (!statSync(canonical).isFile()) continue;
      const reportedInside = pathInside(path, managedRoot);
      // The managed store is created on first publish; a conversation may show
      // an existing file before that directory exists.
      let canonicalRoot = '';
      try { canonicalRoot = realpathSync(managedRoot); } catch { /* Not created yet. */ }
      const canonicalInside = canonicalRoot !== '' && pathInside(canonical, canonicalRoot);
      if (reportedInside || canonicalInside) {
        if (!canonicalRoot || canonicalRoot !== resolve(realpathSync(dirname(managedRoot)), basename(managedRoot))) continue;
        // A reported path inside the store must stay inside the store and
        // belong to this conversation. A reported path outside may point into
        // the store only when the canonical target belongs to this conversation.
        if (reportedInside) {
          if (!eligible(path, managedRoot) || !canonicalInside || !eligible(canonical, canonicalRoot)) continue;
        } else if (!eligible(canonical, canonicalRoot)) continue;
      }
      paths.add(path);
    } catch { /* Missing files and symlink escapes do not grant a capability. */ }
  }
  return [...paths];
}
