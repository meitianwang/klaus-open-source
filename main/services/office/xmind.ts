import { randomUUID } from 'node:crypto';
import type { OfficeMindMapPreview, OfficeMindMapSheet, OfficeMindMapTopic } from '../../../contracts/office-preview';
import { attrLocal, childByLocal, childrenByLocal, escapeXml, escapeXmlAttr, OfficeParseError, textContent, type XmlElement, type ZipArchive } from './xml';
import { buildZipBuffer, patchZipBuffer, readAllZipEntries } from './zip-writer';

const MAX_TOPICS = 5000;

function safeHref(raw?: string): string | undefined {
  if (!raw || /[\x00-\x20\x7f]/.test(raw)) return undefined;
  try {
    const u = new URL(raw);
    return /^(https?:|mailto:|xmind:)/i.test(u.protocol) ? raw : undefined;
  } catch {
    return undefined;
  }
}

interface RawXmindJsonTopic {
  id?: unknown;
  title?: unknown;
  branch?: unknown;
  href?: unknown;
  labels?: unknown;
  markers?: unknown;
  notes?: { plain?: { content?: unknown } };
  children?: {
    attached?: unknown;
    detached?: unknown;
    summary?: unknown;
  };
}

function parseJsonTopic(raw: RawXmindJsonTopic, counter: { count: number; truncated: boolean }, fallbackIndex: number): OfficeMindMapTopic | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  if (counter.count >= MAX_TOPICS) {
    counter.truncated = true;
    return undefined;
  }
  counter.count += 1;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `topic-${counter.count}-${fallbackIndex}`;
  const title = typeof raw.title === 'string' ? raw.title : raw.title != null ? String(raw.title) : '';
  const notesRaw = raw.notes?.plain?.content;
  const notes = typeof notesRaw === 'string' && notesRaw.trim() ? notesRaw : undefined;
  const labels = Array.isArray(raw.labels)
    ? raw.labels.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;
  const markers = Array.isArray(raw.markers)
    ? raw.markers
        .map(m => (typeof m === 'string' ? m : m && typeof m === 'object' && 'markerId' in m && typeof (m as { markerId?: unknown }).markerId === 'string' ? (m as { markerId: string }).markerId : ''))
        .filter(Boolean)
    : undefined;
  const href = typeof raw.href === 'string' ? safeHref(raw.href) : undefined;
  const folded = raw.branch === 'folded' ? true : undefined;

  const attachedRaw = Array.isArray(raw.children?.attached) ? raw.children!.attached : [];
  const detachedRaw = Array.isArray(raw.children?.detached) ? raw.children!.detached : [];
  const children: OfficeMindMapTopic[] = [];
  for (let i = 0; i < attachedRaw.length; i++) {
    const child = parseJsonTopic(attachedRaw[i] as RawXmindJsonTopic, counter, i);
    if (child) children.push(child);
  }
  const detached: OfficeMindMapTopic[] = [];
  for (let i = 0; i < detachedRaw.length; i++) {
    const child = parseJsonTopic(detachedRaw[i] as RawXmindJsonTopic, counter, i);
    if (child) detached.push(child);
  }
  return {
    id,
    title,
    ...(notes ? { notes } : {}),
    ...(labels?.length ? { labels } : {}),
    ...(markers?.length ? { markers } : {}),
    ...(href ? { href } : {}),
    ...(folded ? { folded } : {}),
    ...(children.length ? { children } : {}),
    ...(detached.length ? { detached } : {}),
  };
}

function parseXmlTopic(node: XmlElement, counter: { count: number; truncated: boolean }, fallbackIndex: number): OfficeMindMapTopic | undefined {
  if (counter.count >= MAX_TOPICS) {
    counter.truncated = true;
    return undefined;
  }
  counter.count += 1;
  const id = attrLocal(node, 'id')?.trim() || `topic-${counter.count}-${fallbackIndex}`;
  const titleNode = childByLocal(node, 'title');
  const title = titleNode ? textContent(titleNode) : '';
  const notesPlain = childByLocal(childByLocal(node, 'notes'), 'plain');
  const notesText = notesPlain ? textContent(notesPlain).trim() : '';
  const labelsNode = childByLocal(node, 'labels');
  const labels = labelsNode
    ? childrenByLocal(labelsNode, 'label').map(l => textContent(l).trim()).filter(Boolean)
    : [];
  const markerRefs = childByLocal(node, 'marker-refs');
  const markers = markerRefs
    ? childrenByLocal(markerRefs, 'marker-ref').map(m => attrLocal(m, 'marker-id') ?? '').filter(Boolean)
    : [];
  const href = safeHref(node.attrs['xlink:href'] ?? attrLocal(node, 'href'));
  const folded = attrLocal(node, 'branch') === 'folded' ? true : undefined;

  const childrenContainer = childByLocal(node, 'children');
  const children: OfficeMindMapTopic[] = [];
  const detached: OfficeMindMapTopic[] = [];
  for (const topicsGroup of childrenByLocal(childrenContainer, 'topics')) {
    const groupType = (attrLocal(topicsGroup, 'type') ?? 'attached').toLowerCase();
    const target = groupType === 'detached' ? detached : children;
    const topicElements = childrenByLocal(topicsGroup, 'topic');
    for (let i = 0; i < topicElements.length; i++) {
      const parsed = parseXmlTopic(topicElements[i]!, counter, i);
      if (parsed) target.push(parsed);
    }
  }

  return {
    id,
    title,
    ...(notesText ? { notes: notesText } : {}),
    ...(labels.length ? { labels } : {}),
    ...(markers.length ? { markers } : {}),
    ...(href ? { href } : {}),
    ...(folded ? { folded } : {}),
    ...(children.length ? { children } : {}),
    ...(detached.length ? { detached } : {}),
  };
}

export async function parseXmindArchive(zip: ZipArchive): Promise<{ preview: OfficeMindMapPreview; truncated: boolean }> {
  const counter = { count: 0, truncated: false };
  const jsonBytes = await zip.read('content.json', 32 * 1024 * 1024);
  if (jsonBytes) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBytes.toString('utf8'));
    } catch {
      throw new OfficeParseError('corrupted', 'Invalid XMind content.json');
    }
    const rawSheets = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && 'rootTopic' in parsed ? [parsed] : []);
    const sheets: OfficeMindMapSheet[] = [];
    for (let i = 0; i < rawSheets.length; i++) {
      const item = rawSheets[i] as { id?: unknown; title?: unknown; rootTopic?: RawXmindJsonTopic } | undefined;
      if (!item || typeof item !== 'object' || !item.rootTopic) continue;
      const rootTopic = parseJsonTopic(item.rootTopic, counter, 0);
      if (!rootTopic) continue;
      const sheetId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `sheet-${i + 1}`;
      const sheetTitle = typeof item.title === 'string' && item.title.trim() ? item.title : `Canvas ${i + 1}`;
      sheets.push({ id: sheetId, title: sheetTitle, rootTopic });
    }
    if (!sheets.length) throw new OfficeParseError('corrupted', 'XMind workbook has no sheets');

    let activeSheet = 0;
    const metaBytes = await zip.read('metadata.json', 1024 * 1024);
    if (metaBytes) {
      try {
        const meta = JSON.parse(metaBytes.toString('utf8')) as { activeSheetId?: unknown };
        if (typeof meta.activeSheetId === 'string') {
          const idx = sheets.findIndex(s => s.id === meta.activeSheetId);
          if (idx >= 0) activeSheet = idx;
        }
      } catch { /* optional metadata */ }
    }
    return {
      preview: { kind: 'mindmap', activeSheet, sheets, truncated: counter.truncated || undefined },
      truncated: counter.truncated,
    };
  }

  const xmlRoot = await zip.readXml('content.xml');
  if (xmlRoot) {
    const rawSheets = childrenByLocal(xmlRoot, 'sheet');
    const sheets: OfficeMindMapSheet[] = [];
    for (let i = 0; i < rawSheets.length; i++) {
      const sheetEl = rawSheets[i]!;
      const topicEl = childByLocal(sheetEl, 'topic');
      if (!topicEl) continue;
      const rootTopic = parseXmlTopic(topicEl, counter, 0);
      if (!rootTopic) continue;
      const sheetId = attrLocal(sheetEl, 'id')?.trim() || `sheet-${i + 1}`;
      const titleEl = childByLocal(sheetEl, 'title');
      const sheetTitle = (titleEl ? textContent(titleEl).trim() : '') || `Canvas ${i + 1}`;
      sheets.push({ id: sheetId, title: sheetTitle, rootTopic });
    }
    if (!sheets.length) throw new OfficeParseError('corrupted', 'XMind XML workbook has no sheets');
    return {
      preview: { kind: 'mindmap', activeSheet: 0, sheets, truncated: counter.truncated || undefined },
      truncated: counter.truncated,
    };
  }

  throw new OfficeParseError('corrupted', 'Missing XMind content.json or content.xml');
}

function serializeJsonTopic(topic: OfficeMindMapTopic): Record<string, unknown> {
  const id = topic.id?.trim() || randomUUID();
  const out: Record<string, unknown> = {
    id,
    class: 'topic',
    title: topic.title ?? '',
  };
  if (topic.folded) out.branch = 'folded';
  if (topic.href) out.href = topic.href;
  if (topic.notes?.trim()) out.notes = { plain: { content: topic.notes } };
  if (topic.labels?.length) out.labels = topic.labels.filter(Boolean);
  if (topic.markers?.length) out.markers = topic.markers.filter(Boolean).map(markerId => ({ markerId }));
  const attached = topic.children?.map(serializeJsonTopic) ?? [];
  const detached = topic.detached?.map(serializeJsonTopic) ?? [];
  if (attached.length || detached.length) {
    out.children = {
      ...(attached.length ? { attached } : {}),
      ...(detached.length ? { detached } : {}),
    };
  }
  return out;
}

function serializeXmlTopic(topic: OfficeMindMapTopic): string {
  const id = escapeXmlAttr(topic.id?.trim() || randomUUID());
  const attrs = [
    `id="${id}"`,
    topic.folded ? 'branch="folded"' : '',
    topic.href ? `xlink:href="${escapeXmlAttr(topic.href)}"` : '',
  ].filter(Boolean).join(' ');
  const parts: string[] = [`<title>${escapeXml(topic.title ?? '')}</title>`];
  if (topic.notes?.trim()) {
    parts.push(`<notes><plain>${escapeXml(topic.notes)}</plain></notes>`);
  }
  if (topic.labels?.length) {
    parts.push(`<labels>${topic.labels.filter(Boolean).map(l => `<label>${escapeXml(l)}</label>`).join('')}</labels>`);
  }
  if (topic.markers?.length) {
    parts.push(`<marker-refs>${topic.markers.filter(Boolean).map(m => `<marker-ref marker-id="${escapeXmlAttr(m)}"/>`).join('')}</marker-refs>`);
  }
  const attached = topic.children ?? [];
  const detached = topic.detached ?? [];
  if (attached.length || detached.length) {
    const groups: string[] = [];
    if (attached.length) groups.push(`<topics type="attached">${attached.map(serializeXmlTopic).join('')}</topics>`);
    if (detached.length) groups.push(`<topics type="detached">${detached.map(serializeXmlTopic).join('')}</topics>`);
    parts.push(`<children>${groups.join('')}</children>`);
  }
  return `<topic ${attrs}>${parts.join('')}</topic>`;
}

export function serializeXmindXml(preview: OfficeMindMapPreview): string {
  const sheetsXml = preview.sheets.map((sheet, index) => {
    const id = escapeXmlAttr(sheet.id?.trim() || `sheet-${index + 1}`);
    return `<sheet id="${id}">${serializeXmlTopic(sheet.rootTopic)}<title>${escapeXml(sheet.title || `Canvas ${index + 1}`)}</title></sheet>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">${sheetsXml}</xmap-content>`;
}

export async function writeXmindArchive(preview: OfficeMindMapPreview, existingBytes?: Buffer): Promise<Buffer> {
  const sheets = preview.sheets.length ? preview.sheets : [{
    id: randomUUID(),
    title: 'Canvas 1',
    rootTopic: { id: randomUUID(), title: 'Central Topic' },
  }];
  const contentJson = JSON.stringify(sheets.map((sheet, idx) => ({
    id: sheet.id?.trim() || randomUUID(),
    class: 'sheet',
    title: sheet.title || `Canvas ${idx + 1}`,
    rootTopic: serializeJsonTopic(sheet.rootTopic),
  })), null, 2);

  const activeSheet = sheets[Math.max(0, Math.min(sheets.length - 1, preview.activeSheet || 0))]!;
  let existingEntries: Map<string, Buffer> | undefined;
  if (existingBytes && existingBytes.length >= 4 && existingBytes.readUInt32LE(0) === 0x04034b50) {
    try { existingEntries = await readAllZipEntries(existingBytes); } catch { existingEntries = undefined; }
  }

  let metadataObj: Record<string, unknown> = {
    creator: { name: 'Klaus', version: '1.0' },
    activeSheetId: activeSheet.id,
  };
  if (existingEntries?.has('metadata.json')) {
    try {
      const parsed = JSON.parse(existingEntries.get('metadata.json')!.toString('utf8'));
      if (parsed && typeof parsed === 'object') metadataObj = { ...(parsed as Record<string, unknown>), activeSheetId: activeSheet.id };
    } catch { /* ignore malformed old metadata */ }
  }

  const fileEntries: Record<string, Record<string, unknown>> = {
    'content.json': {},
    'metadata.json': {},
  };
  if (existingEntries) {
    for (const key of existingEntries.keys()) {
      if (key !== 'manifest.json') fileEntries[key] = {};
    }
  }
  const updates: Record<string, Buffer | string | null> = {
    'content.json': contentJson,
    'metadata.json': JSON.stringify(metadataObj, null, 2),
  };
  if (!existingEntries || existingEntries.has('content.xml')) {
    updates['content.xml'] = serializeXmindXml({ ...preview, sheets });
    fileEntries['content.xml'] = {};
  }
  updates['manifest.json'] = JSON.stringify({ 'file-entries': fileEntries }, null, 2);

  if (existingEntries) {
    return patchZipBuffer(existingBytes, updates);
  }
  return buildZipBuffer(Object.entries(updates).filter((entry): entry is [string, string | Buffer] => entry[1] !== null));
}

export function summarizeMindMapTopic(topic: OfficeMindMapTopic, depth = 0, lines: string[] = []): string[] {
  const indent = '  '.repeat(Math.min(depth, 12));
  const prefix = depth === 0 ? '# ' : `${indent}- `;
  lines.push(`${prefix}${topic.title || '(Untitled)'}`);
  if (topic.notes?.trim()) {
    for (const noteLine of topic.notes.trim().split(/\r?\n/)) {
      lines.push(`${indent}  > ${noteLine}`);
    }
  }
  for (const child of topic.children ?? []) summarizeMindMapTopic(child, depth + 1, lines);
  for (const floating of topic.detached ?? []) summarizeMindMapTopic(floating, depth + 1, lines);
  return lines;
}
