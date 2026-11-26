export type OfficePreviewKind = 'spreadsheet' | 'document' | 'presentation';
export type OfficePreviewErrorFamily = OfficePreviewKind | 'pdf';
export const PDF_PREVIEW_EXTENSIONS = new Set(['pdf']);
export function isPdfPreviewExtension(extOrPath: string): boolean {
  const base = extOrPath.split(/[/\\]/).pop() ?? '';
  return (base.includes('.') || base === extOrPath) && PDF_PREVIEW_EXTENSIONS.has(base.slice(base.lastIndexOf('.') + 1).toLowerCase());
}
export type OfficePreviewErrorCode = 'encrypted' | 'too_large' | 'corrupted' | 'empty' | 'unsupported';
export const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const REMOTE_OFFICE_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
export const OFFICE_SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'ods']);
export const OFFICE_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['docx', 'docm', 'dotx', 'dotm', 'doc', 'odt', 'rtf']);
export const OFFICE_PRESENTATION_EXTENSIONS: ReadonlySet<string> = new Set(['pptx', 'pptm', 'ppsx', 'potx', 'potm', 'ppt', 'pps', 'odp']);
export const OFFICE_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([...OFFICE_SPREADSHEET_EXTENSIONS, ...OFFICE_DOCUMENT_EXTENSIONS, ...OFFICE_PRESENTATION_EXTENSIONS]);
export function officePreviewFamily(extOrPath: string): OfficePreviewKind | undefined {
  const base = extOrPath.split(/[/\\]/).pop() ?? '';
  const ext = base.slice(base.lastIndexOf('.') + 1).toLowerCase();
  if (!base.includes('.') && base !== extOrPath) return undefined;
  if (OFFICE_SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
  if (OFFICE_DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (OFFICE_PRESENTATION_EXTENSIONS.has(ext)) return 'presentation';
  return undefined;
}
export const isOfficePreviewExtension = (extOrPath: string): boolean => officePreviewFamily(extOrPath) !== undefined;
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
export interface OfficeSpreadsheetPreview { kind: 'spreadsheet'; activeSheet: number; styles: OfficeCellStyle[]; sheets: OfficeSpreadsheetSheet[] }
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
export interface OfficePdfPage { index: number; blocks: OfficeDocBlock[] }
export interface OfficePdfPreview { kind: 'pdf'; pageCount: number; pages: OfficePdfPage[]; truncated?: boolean }
export type OfficePreviewPayload = OfficePdfPreview | OfficeSpreadsheetPreview | OfficeDocumentPreview | OfficePresentationPreview | OfficeErrorPreview;
