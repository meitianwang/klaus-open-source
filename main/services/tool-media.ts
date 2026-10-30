import { statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { mimeForExtension, savedPathReferencesFromText, storeBytes } from './media';

export interface ToolMediaSplit { content: string; media: Array<Record<string, Json>> }
export type ToolMediaProjector = (result: Json | undefined) => ToolMediaSplit | undefined;

function storeImageUrl(value: unknown, configRoot?: string): string {
  if (typeof value !== 'string' || !value.startsWith('data:')) throw new Error('not a data URL');
  const comma = value.indexOf(',');
  if (comma === -1) throw new Error('data URL has no payload');
  const metadata = value.slice(5, comma);
  if (!metadata.endsWith(';base64')) throw new Error('only base64 data URLs are supported');
  const encoded = value.slice(comma + 1).trim();
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) throw new Error('invalid base64 payload');
  const mime = metadata.slice(0, -';base64'.length);
  return storeBytes(bytes, mime || undefined, configRoot);
}

/** Normalize only the declared dynamic, MCP, and browser capture result shapes. */
function imageItems(result: Json | undefined): Json[] | undefined {
  const row = object(result);
  if (Array.isArray(row?.contentItems)) return row.contentItems.map(item => {
    const block = object(item);
    if (block?.type === 'input_text') return { ...block, type: 'inputText' };
    if (block?.type === 'input_image') return { ...block, type: 'inputImage', imageUrl: block.image_url ?? block.imageUrl ?? '' };
    return item;
  });
  if (Array.isArray(row?.content) && row.content.some(item => object(item)?.type === 'image')) {
    return row.content.flatMap<Json>(item => {
      const block = object(item);
      if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'inputText', text: block.text }];
      if (block?.type === 'image') return [{ type: 'inputImage', imageUrl: `data:${String(block.mimeType || 'image/png')};base64,${String(block.data || '')}` }];
      return [];
    });
  }
  const response = object(row?.response), value = object(response?.value);
  if (row?.ok !== true || typeof row.operation !== 'string' || !row.operation.startsWith('browser_') || !response) return undefined;
  const artifacts = (Array.isArray(response.artifacts) ? response.artifacts : []).map(object)
    .filter(artifact => artifact?.kind === 'screenshot' && typeof artifact.path === 'string');
  const dataUrl = typeof value?.dataUrl === 'string' && value.dataUrl.startsWith('data:image/') ? value.dataUrl : '';
  if (!dataUrl && !artifacts.length) return undefined;
  const paths = [...new Set([value?.saved === true ? value.path : undefined, ...artifacts.map(artifact => artifact!.path)].filter((path): path is string => typeof path === 'string'))];
  const capture = { ...value }; delete capture.dataUrl; delete capture.data;
  const metadata: Record<string, Json> = { ...response, value: capture }; delete metadata.artifacts;
  const items: Json[] = [];
  if (paths.length) items.push({ type: 'inputText', text: `Saved: ${JSON.stringify([...new Set(paths)])}` });
  if (Object.keys(metadata).length) items.push({ type: 'inputText', text: JSON.stringify(metadata) });
  else if (typeof response.text === 'string') items.push({ type: 'inputText', text: response.text });
  if (dataUrl) items.push({ type: 'inputImage', imageUrl: dataUrl });
  else for (let i = 0; i < paths.length; i++) items.push({ type: 'inputImage', imageUrl: '' });
  return items;
}

/** Tool images become local media entries before a result reaches the renderer. */
export function splitDynamicToolMedia(result: Json | undefined, configRoot?: string): ToolMediaSplit | undefined {
  const items = imageItems(result);
  if (!items) return undefined;
  const saved = items.flatMap(item => {
    const row = object(item);
    return row?.type === 'inputText' && typeof row.text === 'string' ? savedPathReferencesFromText(row.text) : [];
  });
  let savedIndex = 0, content = '';
  const media: Array<Record<string, Json>> = [];
  const append = (text: string): void => { if (content) content += '\n'; content += text; };
  for (const item of items) {
    const row = object(item);
    if (row?.type === 'inputText' && typeof row.text === 'string') append(row.text);
    else if (row?.type === 'inputImage') {
      try {
        let savedPath: string | undefined, sourcePath: string | undefined;
        while (savedIndex < saved.length) {
          const candidate = saved[savedIndex++]!;
          try {
            if (statSync(candidate.path).isFile()) {
              savedPath = candidate.path;
              if (isAbsolute(candidate.path)) sourcePath = candidate.path;
              break;
            }
          } catch { /* Missing generated files still have their declared image bytes. */ }
          if (candidate.exact || saved.length === 1) { if (isAbsolute(candidate.path)) sourcePath = candidate.path; break; }
        }
        // A later tool may move or replace the workspace file. Keep the returned
        // image bytes stable and retain its source path for reply references.
        let path: string;
        try { path = storeImageUrl(row.imageUrl, configRoot); }
        catch (error) { if (!savedPath) throw error; path = savedPath; }
        const mimeType = mimeForExtension(extname(path).slice(1));
        media.push({ path, ...(sourcePath && sourcePath !== path ? { sourcePath } : {}), ...(mimeType ? { mimeType } : {}) });
      } catch (error) {
        append(`[image unavailable: ${error instanceof Error ? error.message : String(error)}]`);
      }
    }
  }
  return { content, media };
}
