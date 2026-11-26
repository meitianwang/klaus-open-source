export type OfficePreviewKind = 'spreadsheet' | 'document' | 'presentation' | 'mindmap';
export type OfficePreviewErrorFamily = OfficePreviewKind | 'pdf';
export const PDF_PREVIEW_EXTENSIONS = new Set(['pdf']);
export function isPdfPreviewExtension(extOrPath: string): boolean {
  const base = extOrPath.split(/[/\\]/).pop() ?? '';
  return (base.includes('.') || base === extOrPath) && PDF_PREVIEW_EXTENSIONS.has(base.slice(base.lastIndexOf('.') + 1).toLowerCase());
}
export type OfficePreviewErrorCode = 'encrypted' | 'too_large' | 'corrupted' | 'empty' | 'unsupported';
export const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const REMOTE_OFFICE_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;

export const TEXT_SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set(['csv', 'tsv']);
export const OFFICE_SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set([
  'xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'xlt', 'et', 'ett', 'ods',
]);
export const OFFICE_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'wps', 'wpt', 'odt', 'rtf',
]);
export const OFFICE_PRESENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm', 'ppt', 'pps', 'pot', 'dps', 'dpt', 'odp',
]);
export const OFFICE_MINDMAP_EXTENSIONS: ReadonlySet<string> = new Set(['xmind']);
export const OFFICE_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  ...OFFICE_SPREADSHEET_EXTENSIONS,
  ...OFFICE_DOCUMENT_EXTENSIONS,
  ...OFFICE_PRESENTATION_EXTENSIONS,
  ...OFFICE_MINDMAP_EXTENSIONS,
]);

export const MARKDOWN_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'mdown', 'mkd']);
export const HTML_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml']);
export const PLAYABLE_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus',
]);
export const PLAYABLE_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4', 'webm', 'mov', 'm4v', 'ogv', '3gp',
]);
export const UNSUPPORTED_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['wma']);
export const UNSUPPORTED_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mkv', 'avi', 'wmv', 'flv', 'f4v', 'mts', 'm2ts', 'mpg', 'mpeg', '3g2', 'vob', 'asf', 'rm', 'rmvb',
]);

export function extOfPath(extOrPath: string): string {
  const base = extOrPath.split(/[/\\]/).pop() ?? '';
  if (!base.includes('.') && base !== extOrPath) return '';
  return base.slice(base.lastIndexOf('.') + 1).toLowerCase();
}

export function isTextSpreadsheetExtension(extOrPath: string): boolean {
  return TEXT_SPREADSHEET_EXTENSIONS.has(extOfPath(extOrPath));
}
export function isMarkdownPreviewExtension(extOrPath: string): boolean {
  return MARKDOWN_PREVIEW_EXTENSIONS.has(extOfPath(extOrPath));
}
export function isHtmlPreviewExtension(extOrPath: string): boolean {
  return HTML_PREVIEW_EXTENSIONS.has(extOfPath(extOrPath));
}
export function isRecognizedUnsupportedMediaExtension(extOrPath: string): boolean {
  const ext = extOfPath(extOrPath);
  return UNSUPPORTED_AUDIO_EXTENSIONS.has(ext) || UNSUPPORTED_VIDEO_EXTENSIONS.has(ext);
}

export function officePreviewFamily(extOrPath: string): OfficePreviewKind | undefined {
  const ext = extOfPath(extOrPath);
  if (!ext) return undefined;
  if (OFFICE_SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
  if (OFFICE_DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (OFFICE_PRESENTATION_EXTENSIONS.has(ext)) return 'presentation';
  if (OFFICE_MINDMAP_EXTENSIONS.has(ext)) return 'mindmap';
  return undefined;
}
export const isOfficePreviewExtension = (extOrPath: string): boolean => officePreviewFamily(extOrPath) !== undefined;

export const INPLACE_WRITABLE_OFFICE_EXTENSIONS: ReadonlySet<string> = new Set([
  'xlsx', 'xlsm', 'xltx', 'xltm', 'ods', 'csv', 'tsv',
  'docx', 'docm', 'dotx', 'dotm', 'odt',
  'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm', 'odp',
  'xmind',
]);

export function isInPlaceWritableOfficeExtension(extOrPath: string): boolean {
  return INPLACE_WRITABLE_OFFICE_EXTENSIONS.has(extOfPath(extOrPath));
}

export function defaultOfficeSaveAsExtension(extOrPath: string, kind?: OfficePreviewKind): string {
  const ext = extOfPath(extOrPath);
  if (INPLACE_WRITABLE_OFFICE_EXTENSIONS.has(ext)) return ext;
  const family = kind ?? officePreviewFamily(extOrPath);
  if (family === 'spreadsheet') return 'xlsx';
  if (family === 'presentation') return 'pptx';
  if (family === 'mindmap') return 'xmind';
  return 'docx';
}

export function saveAsFiltersForOfficeKind(kind: OfficePreviewKind, currentExt?: string): Array<{ name: string; extensions: string[] }> {
  const ext = (currentExt ?? '').replace(/^\./, '').toLowerCase();
  if (kind === 'spreadsheet') {
    if (ext === 'csv') return [{ name: 'CSV', extensions: ['csv'] }, { name: 'TSV', extensions: ['tsv'] }, { name: 'Excel Workbook', extensions: ['xlsx'] }];
    if (ext === 'tsv') return [{ name: 'TSV', extensions: ['tsv'] }, { name: 'CSV', extensions: ['csv'] }, { name: 'Excel Workbook', extensions: ['xlsx'] }];
    return [{ name: 'Excel Workbook', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }, { name: 'TSV', extensions: ['tsv'] }, { name: 'OpenDocument Spreadsheet', extensions: ['ods'] }];
  }
  if (kind === 'presentation') {
    return [{ name: 'PowerPoint Presentation', extensions: ['pptx'] }, { name: 'OpenDocument Presentation', extensions: ['odp'] }];
  }
  if (kind === 'mindmap') {
    return [{ name: 'XMind Workbook', extensions: ['xmind'] }];
  }
  return [{ name: 'Word Document', extensions: ['docx'] }, { name: 'OpenDocument Text', extensions: ['odt'] }];
}

type Align = 'left' | 'center' | 'right';
type Valign = 'top' | 'middle' | 'bottom';
export interface OfficeErrorPreview { kind: 'error'; family: OfficePreviewErrorFamily; code: OfficePreviewErrorCode; detail?: string; maxBytes?: number }
export interface OfficeCellStyle {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; bg?: string;
  align?: Align; valign?: Valign; wrap?: boolean; fontSize?: number;
  borderTop?: string; borderRight?: string; borderBottom?: string; borderLeft?: string;
}
export interface OfficeSpreadsheetCell { r: number; c: number; v: string; f?: string; t?: 's' | 'n' | 'b' | 'e'; rs?: number; cs?: number; s?: number }
export interface OfficeSpreadsheetSheet {
  name: string; hidden?: boolean; totalRows: number; totalCols: number; renderedRows: number; renderedCols: number;
  colWidths?: Array<number | null>; rowHeights?: Array<number | null>; hiddenRows?: number[]; hiddenCols?: number[];
  frozenRows?: number; frozenCols?: number; cells: OfficeSpreadsheetCell[];
}
export type OfficeWorksheet = OfficeSpreadsheetSheet;
export interface OfficeSpreadsheetPreview {
  kind: 'spreadsheet';
  activeSheet: number;
  styles: OfficeCellStyle[];
  sheets: OfficeSpreadsheetSheet[];
  delimiter?: ',' | '\t';
}
export interface OfficeInlineRun {
  text: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean;
  sup?: boolean; sub?: boolean; color?: string; highlight?: string; fontSize?: number; href?: string; br?: boolean;
}
export interface OfficeEmbeddedImage { src: string; alt?: string; widthPx?: number; heightPx?: number }
export interface OfficeDocCell { rowSpan?: number; colSpan?: number; bg?: string; valign?: Valign; blocks: OfficeDocBlock[] }
export type OfficeDocBlock =
  | { kind: 'paragraph'; heading?: 1 | 2 | 3 | 4 | 5 | 6; role?: 'title' | 'subtitle' | 'quote'; align?: Align; indentPt?: number; list?: { ordered: boolean; level: number; marker: string }; bg?: string; runs: OfficeInlineRun[]; images?: OfficeEmbeddedImage[] }
  | { kind: 'table'; colWidthsPct?: number[]; rows: { header?: boolean; cells: OfficeDocCell[] }[] }
  | { kind: 'hr' };
export interface OfficeDocumentPreview { kind: 'document'; title?: string; blocks: OfficeDocBlock[]; footnotes?: { id: string; blocks: OfficeDocBlock[] }[]; truncated?: boolean }
export interface OfficeSlideRun extends OfficeInlineRun { fontFamily?: string }
export interface OfficeSlideParagraph { runs: OfficeSlideRun[]; align?: Align; level?: number; marker?: string }
type SlideBounds = { x: number; y: number; w: number; h: number; rotation?: number };
export type OfficeSlideElement = SlideBounds & (
  | { kind: 'shape'; geom?: 'rect' | 'roundRect' | 'ellipse' | 'line'; fill?: string; stroke?: string; strokeWidthPt?: number; valign?: Valign; paddingPct?: { top: number; right: number; bottom: number; left: number }; paragraphs: OfficeSlideParagraph[] }
  | { kind: 'image'; src: string; alt?: string; crop?: { top: number; right: number; bottom: number; left: number } }
  | { kind: 'table'; colWidthsPct?: number[]; rows: { cells: { rowSpan?: number; colSpan?: number; bg?: string; valign?: Valign; paragraphs: OfficeSlideParagraph[] }[] }[] }
);
export interface OfficeSlide { index: number; hidden?: boolean; background?: string; backgroundImage?: string; elements: OfficeSlideElement[]; notes?: string }
export interface OfficePresentationPreview { kind: 'presentation'; widthPt: number; heightPt: number; slides: OfficeSlide[]; truncated?: boolean }
export interface OfficeMindMapTopic {
  id: string;
  title: string;
  notes?: string;
  labels?: string[];
  markers?: string[];
  href?: string;
  folded?: boolean;
  children?: OfficeMindMapTopic[];
  detached?: OfficeMindMapTopic[];
}
export interface OfficeMindMapSheet {
  id: string;
  title: string;
  rootTopic: OfficeMindMapTopic;
}
export interface OfficeMindMapPreview {
  kind: 'mindmap';
  activeSheet: number;
  sheets: OfficeMindMapSheet[];
  truncated?: boolean;
}
export interface OfficePdfPage { index: number; blocks: OfficeDocBlock[] }
export interface OfficePdfPreview { kind: 'pdf'; pageCount: number; pages: OfficePdfPage[]; truncated?: boolean }
export type OfficeEditablePayload = OfficeSpreadsheetPreview | OfficeDocumentPreview | OfficePresentationPreview | OfficeMindMapPreview;
export type OfficePreviewPayload = OfficePdfPreview | OfficeEditablePayload | OfficeErrorPreview;
