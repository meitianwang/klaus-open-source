// The one read path for inline visualizations.
//
// A visualization page is read ONCE, when the host projects a message that
// carries the directive, and the content travels with the projected block. The
// renderer never asks for the file again: there is no second authorization
// surface whose root list could drift from this whitelist. The checks here are
// the whole boundary — containment in THIS conversation's visualization
// directory (realpath on both sides, so a symlink escape and the macOS
// /var→/private/var spelling both behave), the kebab-case file-name shape, and
// the byte cap — and a failed read is data, not an exception: the caller ships
// `contents: null` plus `readError` and the transcript shows a failure card
// that names the page instead of echoing the directive line.
//
// Two IO twins on purpose. History projection runs in an already-async chain
// and reads with promises. The engine event pump projects frames synchronously
// and its frame ORDER is a correctness property, so its read is the bounded
// synchronous twin (a page is capped at 1 MB); making the pump await would let
// two events' frames interleave in the forwarder.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { INLINE_VIS_MAX_BYTES, INLINE_VIS_MAX_CONTENT_CHARS, inlineVisFileEligible, parseInlineVisDirective, type InlineVisFragment } from '../../contracts/inline-visualization';
import { pathInside } from './workspaces';
import { sessionVisualizationsDir } from './visualizations';

/** The pure (no-FS) half: parse plus file-name shape. null means "not a fragment". */
function parseForProjection(line: string) {
  const directive = parseInlineVisDirective(line);
  if (!directive) return null;
  if (!inlineVisFileEligible(basename(directive.path), undefined)) return null;
  return directive;
}

async function resolveAsync(configRoot: string, sessionId: string, path: string): Promise<{ realPath?: string; readError?: string }> {
  if (!sessionId) return { readError: 'invalid session' };
  let realPath: string, realDir: string;
  try {
    realPath = await realpath(path);
    // Resolve both sides: /var and /private/var denote the same root on macOS.
    realDir = await realpath(sessionVisualizationsDir(configRoot, sessionId));
  } catch {
    return { readError: 'file not found' };
  }
  if (!pathInside(realPath, realDir)) return { readError: 'outside the visualization directory' };
  return { realPath };
}

function resolveSync(configRoot: string, sessionId: string, path: string): { realPath?: string; readError?: string } {
  if (!sessionId) return { readError: 'invalid session' };
  let realPath: string, realDir: string;
  try {
    realPath = realpathSync(path);
    // Resolve both sides: /var and /private/var denote the same root on macOS.
    realDir = realpathSync(sessionVisualizationsDir(configRoot, sessionId));
  } catch {
    return { readError: 'file not found' };
  }
  if (!pathInside(realPath, realDir)) return { readError: 'outside the visualization directory' };
  return { realPath };
}

function finishRead(path: string, realPath: string, text: string): InlineVisFragment {
  // Recheck the cap on the decoded text: a file may grow between stat and read.
  if (text.length > INLINE_VIS_MAX_CONTENT_CHARS) return { path, contents: null, readError: 'visualization too large' };
  return { path, contents: text };
}

/** The filesystem half of the whitelist plus the bounded read, async twin. */
async function readByPathAsync(configRoot: string, sessionId: string, path: string): Promise<InlineVisFragment> {
  const resolved = await resolveAsync(configRoot, sessionId, path);
  if (resolved.readError) return { path, contents: null, readError: resolved.readError };
  let info;
  try {
    info = await stat(resolved.realPath!);
  } catch {
    return { path, contents: null, readError: 'file not found' };
  }
  if (!info.isFile()) return { path, contents: null, readError: 'not a file' };
  if (info.size > INLINE_VIS_MAX_BYTES) return { path, contents: null, readError: 'visualization too large' };
  let text: string;
  try {
    text = await readFile(resolved.realPath!, 'utf8');
  } catch {
    return { path, contents: null, readError: 'file not found' };
  }
  return finishRead(path, resolved.realPath!, text);
}

/** Read one directive's page for projection (async twin). */
export async function readInlineVisFragment(configRoot: string, sessionId: string, line: string): Promise<InlineVisFragment | null> {
  const directive = parseForProjection(line);
  if (!directive) return null;
  return readByPathAsync(configRoot, sessionId, directive.path);
}

/**
 * Read one directive's page for projection (bounded synchronous twin, for the
 * engine event pump whose frame order must not interleave).
 */
export function readInlineVisFragmentSync(configRoot: string, sessionId: string, line: string): InlineVisFragment | null {
  const directive = parseForProjection(line);
  if (!directive) return null;
  const resolved = resolveSync(configRoot, sessionId, directive.path);
  if (resolved.readError) return { path: directive.path, contents: null, readError: resolved.readError };
  let info;
  try {
    info = statSync(resolved.realPath!);
  } catch {
    return { path: directive.path, contents: null, readError: 'file not found' };
  }
  if (!info.isFile()) return { path: directive.path, contents: null, readError: 'not a file' };
  if (info.size > INLINE_VIS_MAX_BYTES) return { path: directive.path, contents: null, readError: 'visualization too large' };
  let text: string;
  try {
    text = readFileSync(resolved.realPath!, 'utf8');
  } catch {
    return { path: directive.path, contents: null, readError: 'file not found' };
  }
  return finishRead(directive.path, resolved.realPath!, text);
}

/**
 * Read one page by explicit path, for remote clients that ask by path rather
 * than carrying a projected block. Same whitelist, same refusals.
 */
export async function readInlineVisPage(configRoot: string, sessionId: string, path: string): Promise<InlineVisFragment> {
  if (!path || path.includes('\0') || !isAbsolute(path)) return { path, contents: null, readError: 'invalid filePath' };
  if (!inlineVisFileEligible(basename(path), undefined)) return { path, contents: null, readError: 'invalid visualization file name' };
  return readByPathAsync(configRoot, sessionId, path);
}

/**
 * Read every directive line of one message's text, in order. The caller passes
 * the raw assistant text; the line scan mirrors the renderer's paragraph rule
 * closely enough for projection (whole-line directives only), and the renderer
 * remains the authority on which paragraphs it consumes.
 */
export async function readInlineVisFragments(configRoot: string, sessionId: string, text: string): Promise<InlineVisFragment[]> {
  if (!text || !text.includes('::klaus-inline-vis')) return [];
  const fragments: InlineVisFragment[] = [];
  for (const line of text.split('\n')) {
    const fragment = await readInlineVisFragment(configRoot, sessionId, line.trim());
    if (fragment) fragments.push(fragment);
  }
  return fragments;
}

/** Synchronous twin of `readInlineVisFragments`, for the event pump. */
export function readInlineVisFragmentsSync(configRoot: string, sessionId: string, text: string): InlineVisFragment[] {
  if (!text || !text.includes('::klaus-inline-vis')) return [];
  const fragments: InlineVisFragment[] = [];
  for (const line of text.split('\n')) {
    const fragment = readInlineVisFragmentSync(configRoot, sessionId, line.trim());
    if (fragment) fragments.push(fragment);
  }
  return fragments;
}

/**
 * Attach `inlineVis` fragment arrays to the ASSISTANT text blocks of a
 * projected history reply, in place.
 *
 * The projected reply is the renderer's whole transcript, so this is the one
 * place where history ever carries page content: every later surface (the
 * transcript, copy, mobile) reads the same rows. Rows and blocks keep their
 * existing fields untouched; a block with no eligible directive line simply
 * gets no `inlineVis` key, which is what keeps every current consumer of
 * `contentBlocks` working unchanged.
 */
export async function attachInlineVisFragments(projected: unknown, sessionId: string, configRoot: string | undefined): Promise<void> {
  if (!configRoot || !sessionId) return;
  const reply = projected as { messages?: unknown } | null;
  const rows = Array.isArray(reply?.messages) ? reply!.messages as Array<Record<string, unknown>> : [];
  for (const row of rows) {
    if (row.role !== 'assistant' && row.type !== 'assistant') continue;
    const blocks = Array.isArray(row.contentBlocks) ? row.contentBlocks as Array<Record<string, unknown>> : [];
    for (const block of blocks) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const fragments = await readInlineVisFragments(configRoot, sessionId, block.text);
      if (fragments.length) block.inlineVis = fragments;
    }
  }
}
