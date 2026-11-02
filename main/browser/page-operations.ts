import { checkRawCdp, timeoutMs } from './policy';
import { BrowserError, json, object, string, type BrowserObject } from './types';
import type { Json } from '../ipc/contract';
import { domScript, elementInfoScript, elementScript, frameCdp, namesElement, resolveElement } from './dom';
import { performAdvancedPageOperation } from './page-advanced';
import { click, computerInput, pressKey, typeText } from './page-input';
import { saveScreenshot } from './page-capture';
import { evaluatePage } from './page-evaluate';
import { readPage, snapshotPage } from './page-reading';
import { waitForPage } from './page-wait';
import { locatePage } from './page-locator';
import { probePage } from './page-probe';
import { consoleLevel, integerTimestampMs } from './event-shapes';

/** A task-owned page transport, shared by native views and the Chrome extension. */
export interface BrowserCdp {
  readonly captureScope?: { root: BrowserCdp; frame: string };
  command(method: string, params?: BrowserObject, frameTarget?: string): Promise<BrowserObject>;
  evaluate(expression: string, frameTarget?: string): Promise<unknown>;
  screenshot(options?: BrowserObject): Promise<BrowserObject>;
  printToPDF(): Promise<BrowserObject>;
  frameTargets(): string[];
  readonly console: BrowserObject[];
  readonly network: BrowserObject[];
  readonly events: BrowserObject[];
  readonly evicted: { console: number; network: number; events: number };
  onEvent(listener: (method: string, params: BrowserObject, frame?: string) => void): () => void;
}

export interface PageOperationContext {
  cdp: BrowserCdp;
  frame?: string;
  signal?: AbortSignal;
  navigate(url: unknown, fields: BrowserObject): Promise<void>;
  history(action: 'back' | 'forward' | 'reload'): Promise<void>;
  download(fields: BrowserObject, timeout: number, cdp: BrowserCdp): Promise<BrowserObject>;
  artifactDirectory?: string;
  authorizeUpload?(documentUrl: string, signal?: AbortSignal): Promise<void>;
  permission?(fields: BrowserObject): Promise<BrowserObject>;
  nativeViewport?(): Promise<BrowserObject>;
}

export async function performPageOperation(context: PageOperationContext, kind: string, fields: BrowserObject): Promise<{ value?: Json; screenshot?: BrowserObject; typed: BrowserObject }> {
  const assertActive = (): void => { if (context.signal?.aborted) throw new BrowserError('cancelled', 'The browser page operation was cancelled.'); };
  assertActive();
  const { frame } = context;
  let cdp = frameCdp(context.cdp, frame);
  const textTarget = fields.text !== undefined && (['click','set_checked','select_option','element_info','file_upload'].includes(kind) || kind === 'computer' && !['type','key','keypress'].includes(String(fields.action)));
  const pointerComputer = kind === 'computer' && ['click','left_click','mouse_click','right_click','middle_click','double_click','triple_click','mouse_move','hover'].includes(String(fields.action));
  if (['type','set_checked','select_option','element_info','file_upload','computer'].includes(kind) && !pointerComputer && (namesElement(fields) || textTarget)) {
    const criteria = { ...fields };
    if (fields.force === true && ['click','set_checked'].includes(kind)) { criteria.visible = false; criteria.enabled = false; }
    if (kind === 'type' || kind === 'computer' && ['type','key','keypress'].includes(String(fields.action))) { delete criteria.text; delete criteria.value; }
    const resolved = await resolveElement(context.cdp, kind === 'file_upload' ? { ...criteria, visible: false } : criteria, frame, false, assertActive);
    assertActive();
    cdp = resolved.cdp; fields = { ...fields, ref: resolved.fields.ref! }; delete fields.selector;
  }
  let value: Json | undefined;
  let screenshot: BrowserObject | undefined;
  let typed: BrowserObject = {};
  switch (kind) {
    case 'navigate':
      if (fields.viewport !== undefined || fields.width !== undefined || fields.height !== undefined) {
        await performAdvancedPageOperation(context, 'resize', fields, (operation, args) => performPageOperation(context, operation, args));
      }
      await context.navigate(fields.url, fields); break;
    case 'back': case 'forward': case 'reload': await context.history(kind); break;
    case 'screenshot': screenshot = await cdp.screenshot(fields); if (fields.save !== false) screenshot = saveScreenshot(screenshot, context.artifactDirectory); value = { ...screenshot }; delete object(value).data; break;
    case 'eval': value = await evaluatePage(cdp,fields); break;
    case 'cdp': {
      if (fields.action === 'events' || fields.method === undefined) {
        value = await readCdpEvents(cdp, fields, frame); break;
      }
      const method = string(fields.method, 'method'); checkRawCdp(method);
      value = await cdp.command(method, object(fields.params ?? fields.commandParams)); break;
    }
    case 'snapshot': value=await snapshotPage(cdp,fields); break;
    case 'read_page': case 'page_text': value=await readPage(cdp,fields); break;
    case 'find': case 'locator': {
      const found = await locatePage(context.cdp, fields, frame);
      value = kind === 'find' ? { ...found, matches: found.elements ?? [] } : found;
      break;
    }
    case 'element_info':
      value = namesElement(fields) ? json(await cdp.evaluate(elementInfoScript(fields))) : await probePage(cdp, fields);
      if (value === null) throw new BrowserError('not_found', 'Element not found.'); break;
    case 'click': value = await click(cdp, fields, context.signal); break;
    case 'type':
      await typeText(cdp, { ...fields, text: typeof fields.text === 'string' ? fields.text : '', pressEnter: false }, context.signal);
      if (typeof fields.key === 'string') await pressKey(cdp, fields.key, context.signal);
      if (fields.pressEnter === true) {
        await pressKey(cdp, 'Enter', context.signal);
        await waitForPage(cdp, { loadState: 'load', timeoutMs: fields.timeoutMs ?? 30_000 }, context.signal);
      }
      break;
    case 'set_checked': {
      if (fields.checked === undefined) fields.checked = true;
      if (typeof fields.checked !== 'boolean') throw new BrowserError('invalid_request', 'checked must be a boolean.');
      const readChecked = async (): Promise<BrowserObject> => object(await cdp.evaluate(domScript(`const named=${elementScript(fields)};const e=named&&named.tagName==='LABEL'&&named.control?named.control:named;if(!e||!e.isConnected)return {ok:false,why:'gone'};const kind=e.tagName==='INPUT'?String(e.type).toLowerCase():'';if(!['checkbox','radio'].includes(kind)&&!['checkbox','radio','switch'].includes(e.getAttribute('role')))return {ok:false,why:'tag',tag:e.tagName};if(e.disabled)return {ok:false,why:'disabled'};return {ok:true,checked:e.checked===true||e.getAttribute('aria-checked')==='true'};`)));
      const controlState = (result: BrowserObject): boolean => {
        if (result.ok === true && typeof result.checked === 'boolean') return result.checked;
        if (result.why === 'gone') throw new BrowserError('not_found', 'The element named is no longer on the page.');
        if (result.why === 'disabled') throw new BrowserError('invalid_request', 'That control is disabled, so its state cannot be changed.');
        if (result.why === 'tag') throw new BrowserError('invalid_request', `That element is not a checkbox, radio or switch (it is a <${String(result.tag ?? 'element').toLowerCase()}>). Use click for an ordinary control.`);
        throw new BrowserError('host_error', `Reading the control's state failed: ${JSON.stringify(result)}`);
      };
      const before = controlState(await readChecked());
      if (before === fields.checked) { value = { ok: true, checked: fields.checked, changed: false }; break; }
      await click(cdp, fields, context.signal);
      const after = controlState(await readChecked());
      if (after !== fields.checked) throw new BrowserError('host_error', `The control did not reach checked=${String(fields.checked)}; it is still ${String(after)}.`);
      value = { ok: true, checked: fields.checked, changed: true }; break;
    }
    case 'select_option': {
      const asked = fields.value ?? fields.values ?? fields.option ?? fields.options;
      const values = Array.isArray(asked) ? asked : [asked];
      if (!values.length || values.some(entry => entry === undefined || entry === null)) throw new BrowserError('invalid_request', 'Provide option value, label, index or options.');
      const result = object(await cdp.evaluate(domScript(`const named=${elementScript(fields)};const e=named&&named.tagName==='LABEL'&&named.control?named.control:named;if(!e||!e.isConnected)return {ok:false,why:'gone'};if(e.tagName!=='SELECT')return {ok:false,why:'tag',tag:e.tagName};if(e.disabled)return {ok:false,why:'disabled'};const wanted=${JSON.stringify(values)},options=Array.from(e.options);const pick=v=>{if(v&&typeof v==='object'){if(v.index!==undefined)return options[Number(v.index)]??null;if(v.value!==undefined)return options.find(o=>o.value===String(v.value))??null;if(v.label!==undefined)return options.find(o=>norm(o.label)===norm(v.label)||norm(o.textContent)===norm(v.label))??null;}const raw=String(v),normalized=norm(raw);return options.find(o=>o.value===raw)||options.find(o=>norm(o.label)===normalized||norm(o.textContent)===normalized)||(/^[0-9]+$/.test(raw)?options[Number(raw)]:null)||null;};const chosen=wanted.map(pick),missing=wanted.filter((_,i)=>!chosen[i]);if(missing.length)return {ok:false,why:'missing',missing,available:options.map(o=>({value:o.value,label:norm(o.label)}) )};if(chosen.length>1&&!e.multiple)return {ok:false,why:'single'};for(const o of options)o.selected=false;for(const o of chosen)o.selected=true;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,selected:chosen.map(o=>o.value),labels:chosen.map(o=>norm(o.label)),value:e.value};`)));
      if (result.ok !== true) {
        if (result.why === 'gone') throw new BrowserError('not_found', 'The element named is no longer on the page.');
        if (result.why === 'tag') throw new BrowserError('invalid_request', `That element is a <${String(result.tag ?? 'element').toLowerCase()}>, not a <select>. For a custom dropdown, click it open and then click the option.`);
        if (result.why === 'disabled') throw new BrowserError('invalid_request', 'That select is disabled, so its value cannot be changed.');
        if (result.why === 'single') throw new BrowserError('invalid_request', 'That select takes one option; it is not a multiple select.');
        if (result.why === 'missing') throw new BrowserError('not_found', `No option matched ${JSON.stringify(result.missing)}. The select offers: ${JSON.stringify(result.available)}.`);
        throw new BrowserError('host_error', `Choosing an option failed: ${JSON.stringify(result)}`);
      }
      value = json(result); break;
    }
    case 'wait_for': value=await waitForPage(cdp,fields,context.signal); break;
    case 'console': case 'network': {
      const action = fields.action ?? 'get';
      if (!['get', 'list', 'clear'].includes(String(action))) throw new BrowserError('unavailable', `${kind} action '${String(action)}' is not implemented.`);
      const entries = kind === 'console' ? cdp.console : cdp.network;
      if (action === 'clear') { entries.length = 0; cdp.evicted[kind] = 0; if (kind === 'console') await cdp.command('Runtime.discardConsoleEntries'); }
      const levels = Array.isArray(fields.levels) ? fields.levels.map(consoleLevel) : typeof fields.level === 'string' ? [consoleLevel(fields.level)] : [];
      if (fields.sinceMs !== undefined && (typeof fields.sinceMs !== 'number' || !Number.isFinite(fields.sinceMs) || fields.sinceMs < 0)) throw new BrowserError('invalid_request', 'sinceMs must be a non-negative number.');
      const cutoff = typeof fields.since === 'number' ? fields.since : typeof fields.sinceMs === 'number' ? Date.now() - fields.sinceMs : undefined;
      const filter = typeof fields.urlFilter === 'string' ? fields.urlFilter.toLowerCase() : '';
      const wanted = entries.filter(entry => (!frame || entry.frameTargetId === frame) && (kind !== 'console' || !levels.length || levels.includes(consoleLevel(entry.level))) && (kind !== 'network' || !filter || String(entry.url).toLowerCase().includes(filter)) && (cutoff === undefined || Number(entry.timestamp) >= cutoff));
      const limit = Math.max(1, Math.min(500, Number(fields.limit ?? fields.maxEntries ?? 50) || 50));
      const kept: BrowserObject[] = wanted.slice(-limit).reverse().map(entry => {
        const copy: BrowserObject = { ...entry };
        if (kind === 'console') {
          copy.level = consoleLevel(entry.level);
          const timestamp = integerTimestampMs(entry.timestamp);
          if (timestamp !== undefined) copy.timestampMs = timestamp;
          if (entry.lineNumber !== undefined) copy.line = entry.lineNumber;
          if (entry.columnNumber !== undefined) copy.column = entry.columnNumber;
        }
        return copy;
      });
      if (kind === 'network') for (const entry of kept) {
        const response = object(entry.response);
        entry.requestId = entry.id ?? null; entry.status = response.status ?? null; entry.mimeType = response.mimeType ?? null; entry.failed = entry.error !== undefined;
        entry.requestHeaders = entry.headers ?? null;
        entry.responseHeaders = response.headers ?? null;
        entry.startedAtMs = integerTimestampMs(entry.timestamp) ?? null;
      }
      if (kind === 'network' && fields.includeBodies === true) for (const entry of kept.slice(0, 10)) {
        if (entry.body !== undefined) { const body = String(entry.body); entry.body = body.slice(0,4000); entry.bodyTruncated = entry.bodyTruncated === true || body.length > 4000; continue; }
        try { const body = await context.cdp.command('Network.getResponseBody', { requestId: entry.id! }, typeof entry.frameTargetId === 'string' ? entry.frameTargetId : frame); entry.body = String(body.body ?? '').slice(0,4000); entry.base64Encoded = body.base64Encoded ?? false; entry.bodyTruncated = String(body.body ?? '').length > 4000; }
        catch (error) { entry.bodyError = error instanceof Error ? error.message : String(error); }
      }
      if (kind === 'network' && fields.includeBodies === true) for (const entry of kept.slice(10)) { delete entry.body; delete entry.base64Encoded; delete entry.bodyTruncated; delete entry.bodyError; }
      if (kind === 'network' && fields.includeBodies !== true) for (const entry of kept) { delete entry.body; delete entry.base64Encoded; delete entry.bodyTruncated; delete entry.bodyError; }
      typed = { [kind]: kept, ...(kind === 'console' ? { entries: kept } : { requests: kept }), count: kept.length, total: wanted.length, truncated: wanted.length > kept.length, evicted: cdp.evicted[kind] };
      if (fields.clear === true) { entries.length = 0; cdp.evicted[kind] = 0; }
      break;
    }
    case 'computer': {
      if (fields.action === 'screenshot' || fields.action === 'zoom') {
        screenshot = await cdp.screenshot({ ...fields, zoom: fields.action === 'zoom' });
        if (fields.save === true) screenshot = saveScreenshot(screenshot, context.artifactDirectory);
        value = { ...screenshot }; delete object(value).data;
      } else value = await computerInput(cdp, fields, context.signal);
      break;
    }
    case 'download':
      value = await context.download(fields, timeoutMs(fields.timeoutMs, 60_000), cdp); break;
    default: {
      const advanced = await performAdvancedPageOperation({ ...context, cdp, frame: undefined }, kind, fields, (operation, args) => performPageOperation({ ...context, cdp, frame: undefined }, operation, args));
      if (!advanced) throw new BrowserError('unavailable', `Browser operation '${kind}' is not implemented.`);
      value = advanced.value; typed = advanced.typed ?? {}; break;
    }
  }
  return { value, screenshot, typed };
}

async function readCdpEvents(cdp: BrowserCdp, fields: BrowserObject, frame?: string): Promise<BrowserObject> {
  const rawMethods = fields.methods === undefined ? [] : fields.methods;
  if (!Array.isArray(rawMethods) || rawMethods.some(method => typeof method !== 'string' || !method)) throw new BrowserError('invalid_request', 'cdp events methods must be an array of method names.');
  const methods = rawMethods as string[];
  for (const method of methods) checkRawCdp(method);
  const after = fields.afterSequence ?? fields.cursor ?? 0;
  const limit = fields.limit ?? 100;
  const wait = fields.timeoutMs ?? 0;
  if (!Number.isSafeInteger(after) || Number(after) < 0) throw new BrowserError('invalid_request', 'afterSequence must be a non-negative integer.');
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 1000) throw new BrowserError('invalid_request', 'cdp events limit must be from 1 to 1000.');
  if (!Number.isFinite(wait) || Number(wait) < 0 || Number(wait) > 60000) throw new BrowserError('invalid_request', 'cdp events timeoutMs must be from 0 to 60000.');
  const select = (): BrowserObject[] => cdp.events.filter(event => Number(event.sequence) > Number(after)
    && (!frame || event.frameTargetId === frame)
    && (!methods.length || methods.includes(String(event.method))));
  let available = select();
  if (!available.length && Number(wait) > 0) {
    await new Promise<void>(resolveWait => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remove = cdp.onEvent((method, _params, eventFrame) => {
        if (frame && eventFrame !== frame || methods.length && !methods.includes(method)) return;
        clearTimeout(timer); remove(); resolveWait();
      });
      timer = setTimeout(() => { remove(); resolveWait(); }, Number(wait));
    });
    available = select();
  }
  const events = available.slice(0, Number(limit)).map(event => ({ ...event }));
  const newestSequence = cdp.events.reduce((newest, event) => Math.max(newest, Number(event.sequence) || 0), Number(after));
  const hasMore = available.length > events.length;
  const cursor = hasMore && events.length ? events.at(-1)!.sequence! : newestSequence;
  const firstSequence = Number(cdp.events[0]?.sequence ?? newestSequence);
  return {
    events,
    count: events.length,
    cursor,
    newest: newestSequence,
    newestSequence,
    hasMore,
    truncated: Number(after) > 0 && firstSequence > Number(after) + 1,
    evicted: cdp.evicted.events,
  };
}
