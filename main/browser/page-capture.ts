import { savedImageMarkdown } from '../services/media';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { domScript, elementScript, namesElement, resolveElement } from './dom';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';
import { frameCaptureRect } from './frame-capture';
import type { Json } from '../ipc/contract';

function finite(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BrowserError('invalid_request', `${name} must be finite.`);
  return value;
}

/** Capture only the requested page or frame, with CSS-space crop coordinates. */
export async function captureScreenshot(root: BrowserCdp, fields: BrowserObject, viewport?: (format: string, quality: number) => Promise<string>): Promise<BrowserObject> {
  const format = fields.format === undefined ? 'jpeg' : fields.format === 'jpg' ? 'jpeg' : fields.format;
  if (format !== 'png' && format !== 'jpeg') throw new BrowserError('invalid_request', 'Screenshot format must be png or jpeg.');
  const quality = finite(fields.quality, 'quality', 80);
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) throw new BrowserError('invalid_request', 'JPEG quality must be an integer between 0 and 100.');
  let cdp = root; let clip: BrowserObject | undefined;
  let element: BrowserObject | undefined;
  if (fields.clip !== undefined || fields.region !== undefined) {
    const asked = fields.clip ?? fields.region;
    if (!asked || typeof asked !== 'object' || Array.isArray(asked)) throw new BrowserError('invalid_request', 'Screenshot clip must be an object.');
    clip = { ...object(asked) };
  } else if (namesElement(fields) || fields.text !== undefined || fields.query !== undefined) {
    const resolved = await resolveElement(root, fields); cdp = resolved.cdp;
    element = object(await cdp.evaluate(domScript(`const e=${elementScript(resolved.fields)};if(!e||!e.isConnected)throw new Error('Element not found');e.scrollIntoView({block:'center',inline:'center'});const r=box(e);return {...r,x:r.x+scrollX,y:r.y+scrollY};`)));
    clip = element;
  }
  const metrics = object(await cdp.evaluate('({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,dpr:devicePixelRatio||1})'));
  if (fields.zoom === true) {
    const amount = finite(fields.amount, 'zoom amount', 2);
    if (amount < 1 || amount > 8) throw new BrowserError('invalid_request', 'Zoom amount must be between 1 and 8.');
    if (clip) clip = { ...clip, x: Math.max(0, finite(clip.x, 'clip.x', 0) - 16), y: Math.max(0, finite(clip.y, 'clip.y', 0) - 16), width: finite(clip.width, 'clip.width') + 32, height: finite(clip.height, 'clip.height') + 32, scale: amount };
    else {
      const width = Math.max(64, Number(metrics.width) / amount), height = Math.max(64, Number(metrics.height) / amount);
      clip = { x: Math.max(0, finite(fields.x, 'x') + Number(metrics.x) - width / 2), y: Math.max(0, finite(fields.y, 'y') + Number(metrics.y) - height / 2), width, height, scale: amount };
    }
  }
  const params: BrowserObject = { format, captureBeyondViewport: fields.fullPage === true };
  if (format === 'jpeg') params.quality = quality;
  if (cdp.captureScope) {
    if (fields.fullPage === true) throw new BrowserError('unavailable', 'A cross-process frame can be captured inside its visible owner; fullPage requires the top-level tab.');
    clip ??= { x:metrics.x!, y:metrics.y!, width:metrics.width!, height:metrics.height!, scale:1 };
    clip = await frameCaptureRect(cdp.captureScope.root, cdp.captureScope.frame, clip);
  } else if (!clip && fields.fullPage === true) {
    const metrics = await cdp.command('Page.getLayoutMetrics'); const size = object(metrics.cssContentSize ?? metrics.contentSize);
    clip = { x: 0, y: 0, width: size.width!, height: size.height!, scale: 1 };
  }
  if (clip) {
    clip = { x: finite(clip.x, 'clip.x', 0), y: finite(clip.y, 'clip.y', 0), width: finite(clip.width, 'clip.width'), height: finite(clip.height, 'clip.height'), scale: finite(clip.scale, 'clip.scale', 1) };
    const { x, y, width, height, scale } = clip as Record<string, number>;
    const dpr = Number(metrics.dpr);
    if (x! < 0 || y! < 0 || width! <= 0 || height! <= 0 || scale! <= 0 || scale! > 8 || width! * scale! * dpr > 16384 || height! * scale! * dpr > 16384 || width! * height! * (scale! * dpr) ** 2 > 64_000_000) throw new BrowserError('invalid_request', 'Screenshot crop is empty or exceeds the image pixel budget.');
    params.clip = clip;
    // Element bounds are in document space; their owner has just scrolled them
    // into view. Explicit clips may extend beyond the current viewport.
    params.captureBeyondViewport = true;
  }
  let overlay: string | undefined; let annotated: BrowserObject | undefined;
  if (fields.annotate !== undefined) {
    const at = object(fields.annotate); const x = finite(at.x, 'annotate.x'), y = finite(at.y, 'annotate.y');
    overlay = `klaus-shot-${randomUUID()}`;
    annotated = object(await cdp.evaluate(domScript(`const els=document.elementsFromPoint(${x},${y}).filter(e=>${at.includeNonInteractable === true}||e.matches('a,button,input,textarea,select,[role],[tabindex]')).slice(0,20);const layer=document.createElement('div');layer.id=${JSON.stringify(overlay)};layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';for(const [i,e] of els.entries()){const r=e.getBoundingClientRect();const mark=document.createElement('div');mark.textContent=String(i+1);mark.style.cssText='position:absolute;border:2px solid #ff1744;color:#ff1744;background:transparent;font:12px sans-serif';Object.assign(mark.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});layer.append(mark)}document.documentElement.append(layer);return {x:${x},y:${y},elements:els.map(info)};`)));
  }
  try {
    let data: string;
    if (!clip && viewport && cdp === root) data = await viewport(format, quality);
    else {
      // Establish a hidden capture lease for Electron's native surface before a
      // CDP crop; it never shows or focuses the browser window.
      if (viewport) await viewport('png', 85);
      if (!viewport && cdp.captureScope) await cdp.captureScope.root.screenshot({ format:'png' });
      const result = await (cdp.captureScope?.root ?? cdp).command('Page.captureScreenshot', params); data = String(result.data ?? '');
    }
    if (!data) throw new BrowserError('host_error', 'The browser returned no screenshot.');
    // Image pixels per CSS pixel: devicePixelRatio already folds in page zoom
    // (including the panel fit-zoom) and the display scale; an explicit clip
    // scale multiplies on top. Reporting it lets a coordinate measured on the
    // image convert back into the pointer coordinate space with one division.
    const dpr = Number(metrics.dpr);
    const scale = Number.isFinite(dpr) && dpr > 0 ? Math.round(dpr * Number(clip?.scale ?? 1) * 1000) / 1000 : undefined;
    return { data, dataUrl: `data:image/${format};base64,${data}`, mimeType: `image/${format}`, ...(scale === undefined ? {} : { scale }), ...(annotated ? { annotated } : {}) };
  } finally { if (overlay) await cdp.evaluate(`document.getElementById(${JSON.stringify(overlay)})?.remove()`).catch(() => {}); }
}

export function saveScreenshot(screenshot: BrowserObject, directory: string | undefined): BrowserObject {
  if (!directory) throw new BrowserError('unavailable', 'The browser artifact directory is not configured.');
  const bytes = Buffer.from(String(screenshot.data ?? ''), 'base64');
  if (!bytes.length) throw new BrowserError('host_error', 'The screenshot has no image bytes.');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `browser-shot-${randomUUID()}.${screenshot.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { ...screenshot, path, bytes: bytes.length, saved: true, markdown: savedImageMarkdown(path) };
}

/** Both browser backends expose the exact embed in the model-visible text block. */
export function captureResultText(screenshot: BrowserObject | undefined, label: unknown): string {
  const context = String(label ?? 'Screenshot');
  if (screenshot?.saved !== true || typeof screenshot.path !== 'string') return context;
  return `Saved: ${JSON.stringify(screenshot.path)}\nEmbed: ${savedImageMarkdown(screenshot.path)}\n${context}`;
}

/**
 * The model-facing result envelope shared by every browser backend:
 * accessibility state is prose and ships as the text block verbatim instead of
 * a JSON encoding, a capture appends its embed text plus an image block, and
 * metadata stays in structuredContent. One implementation so the built-in
 * browser and the external Chrome relay cannot drift apart.
 */
export function answerEnvelope(response: BrowserObject, screenshot: BrowserObject | undefined): { content: Json[]; structured: BrowserObject } {
  const captureText = captureResultText(screenshot, response.url);
  const axText = typeof response.axText === 'string' ? String(response.axText) : undefined;
  let structured = response;
  let textBlock: string;
  if (axText !== undefined) {
    textBlock = screenshot ? `${axText}\n\n${captureText}` : axText;
    structured = { ...response };
    delete structured.axText;
  } else {
    textBlock = screenshot ? captureText : JSON.stringify(response);
  }
  const content: Json[] = [{ type: 'text', text: textBlock }];
  if (screenshot) content.push({ type: 'image', data: screenshot.data ?? '', mimeType: screenshot.mimeType ?? 'image/png' });
  return { content, structured };
}
