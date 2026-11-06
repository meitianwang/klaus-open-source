import { randomUUID } from 'node:crypto';
import { domScript } from './dom';
import { callPageTool, exportContent, pageAssets } from './page-content';
import { uploadFiles } from './file-upload';
import { BrowserError, json, object, type BrowserObject } from './types';
import type { Json } from '../ipc/contract';
import type { BrowserCdp, PageOperationContext } from './page-operations';

type Performed = { value?: Json; typed?: BrowserObject };

export async function performAdvancedPageOperation(context: PageOperationContext, kind: string, fields: BrowserObject, perform: (kind: string, fields: BrowserObject) => Promise<Performed>): Promise<Performed | undefined> {
  const cdp = context.cdp;
  if (kind === 'form_input') {
    const entries = fields.fields ?? fields.inputs;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new BrowserError('invalid_request', 'form_input needs 1 to 100 fields.');
    const filled: Json[] = [];
    for (const [index, raw] of entries.entries()) {
      const entry = object(raw), value = entry.value ?? entry.text;
      try {
        const criteria: BrowserObject = { ...entry, visible: false }; delete criteria.text; delete criteria.value;
        const found = await perform('element_info', criteria); const info = object(found.value);
        if (['checkbox','radio','switch','menuitemcheckbox','menuitemradio'].includes(String(info.role))) {
          const checked = typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : ['true','yes','1','on','checked'].includes(String(value).toLowerCase());
          await perform('set_checked', { ...entry, checked });
        } else if (info.tag === 'select') await perform('select_option', { ...entry, option: value ?? null });
        else await perform('type', { ...entry, text: typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value) });
        filled.push({ index, named: entry });
      } catch (error) { throw new BrowserError(error instanceof BrowserError ? error.code : 'host_error', 'Field ' + (index + 1) + ' of ' + entries.length + ' failed: ' + (error instanceof Error ? error.message : String(error))); }
    }
    if (fields.submit !== undefined) {
      if (!Object.keys(object(fields.submit)).length) throw new BrowserError('invalid_request', 'submit must be an explicit element locator.');
      await perform('click', object(fields.submit));
      await perform('wait_for', { loadState: 'load', timeoutMs: fields.timeoutMs ?? 30_000 });
    }
    return { value: { filled } };
  }
  if (kind === 'resize') return { value: await resize(context, fields) };
  if (kind === 'file_upload') return { value: await uploadFiles(cdp, fields, perform, context.signal, context.authorizeUpload) };
  if (kind === 'content_export') {
    const value = await exportContent(context, fields);
    return { value, ...(typeof value.content === 'string' ? { typed: { text: value.content } } : {}) };
  }
  if (kind === 'page_assets') return { value: await pageAssets(context, fields) };
  if (kind === 'webmcp') return { value: await callPageTool(cdp, fields, perform) };
  if (kind === 'clipboard') {
    const value = await clipboard(cdp, fields);
    return { value, ...(typeof value.text === 'string' ? { typed: { text: value.text } } : {}) };
  }
  if (kind === 'permission') {
    if (!context.permission) throw new BrowserError('unavailable', 'The browser permission service is not configured.');
    return { value: await context.permission(fields) };
  }
  return undefined;
}

const viewport = (cdp: BrowserCdp): Promise<unknown> => cdp.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:matchMedia("(pointer: coarse)").matches})');
async function resize(context: PageOperationContext, fields: BrowserObject): Promise<BrowserObject> {
  const cdp = context.cdp;
  const reset = fields.reset === true || fields.viewport === null || ['reset','clear'].includes(String(fields.action));
  if (reset) {
    await cdp.command('Emulation.clearDeviceMetricsOverride');
    await cdp.command('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
    const native = await context.nativeViewport?.();
    if (!native || !Number.isFinite(native.width) || !Number.isFinite(native.height) || Number(native.width) <= 0 || Number(native.height) <= 0) throw new BrowserError('unavailable', 'The browser did not report a native viewport to verify the reset. Reload the bundled extension if needed.');
    let actual = object(await viewport(cdp)); const matches = (): boolean => actual.width === native.width && actual.height === native.height;
    for (let step = 0; step < 10 && !matches(); step += 1) { await new Promise(resolveWait => setTimeout(resolveWait, 25)); actual = object(await viewport(cdp)); }
    let viaNativeSize = false;
    if (!matches()) {
      // Some Chromium builds acknowledge clear without restoring their layout.
      // Use the native view/tab size, never the page's spoofable outerWidth.
      await cdp.command('Emulation.setDeviceMetricsOverride', { width: native.width!, height: native.height!, deviceScaleFactor: 0, mobile: false });
      actual = object(await viewport(cdp)); viaNativeSize = true;
    }
    if (!matches()) throw new BrowserError('host_error', 'The page viewport did not return to its native size.');
    return { reset: true, viewport: actual, viaNativeSize };
  }
  const asked = { ...fields, ...object(fields.viewport) }, width = Number(asked.width), height = Number(asked.height), scale = Number(asked.deviceScaleFactor ?? 1);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 10000 || height > 10000 || !Number.isFinite(scale) || scale <= 0 || scale > 8) throw new BrowserError('invalid_request', 'resize needs width/height from 1 to 10000 and deviceScaleFactor greater than 0 and at most 8.');
  if (asked.mobile !== undefined && typeof asked.mobile !== 'boolean') throw new BrowserError('invalid_request', 'mobile must be a boolean.');
  await cdp.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: asked.mobile === true });
  await cdp.command('Emulation.setTouchEmulationEnabled', { enabled: asked.mobile === true, maxTouchPoints: 1 });
  return { reset: false, viewport: json(await viewport(cdp)) };
}

function clipboardHtml(items: Json): string {
  if (!Array.isArray(items) || !items.length) throw new BrowserError('invalid_request', 'Clipboard items must be a non-empty array.');
  const escape = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
  return items.flatMap(raw => Array.isArray(object(raw).entries) ? object(raw).entries as Json[] : [raw]).map(raw => {
    const entry = object(raw), mime = String(entry.mimeType ?? '');
    if (typeof entry.base64 === 'string') {
      if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/u.test(mime) || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(entry.base64) || entry.base64.length > 6 * 1024 * 1024) throw new BrowserError('invalid_request', 'Binary clipboard entries need supported image MIME and bounded base64.');
      return '<img src="data:' + mime + ';base64,' + entry.base64 + '">';
    }
    if (typeof entry.text !== 'string') throw new BrowserError('invalid_request', 'Clipboard entry needs text or image base64.');
    return mime === 'text/html' ? entry.text : escape(entry.text);
  }).join('');
}

async function clipboard(cdp: BrowserCdp, fields: BrowserObject): Promise<BrowserObject> {
  let action = String(fields.action ?? (fields.text !== undefined || fields.items !== undefined ? 'write' : 'read'));
  action = ({ read_text: 'read', write_text: 'write' } as Record<string, string>)[action] ?? action;
  if (action === 'write' && fields.text === undefined && fields.items !== undefined) action = 'write_items';
  if (!['read','write','read_items','write_items'].includes(action)) throw new BrowserError('invalid_request', 'Unknown clipboard action: ' + action);
  const writing = action.startsWith('write'), rich = action.endsWith('items');
  if (writing && !rich && typeof fields.text !== 'string') throw new BrowserError('invalid_request', 'Writing the clipboard needs text.');
  const value = writing ? rich ? clipboardHtml(fields.items!) : String(fields.text) : '';
  const id = '__klausClipboard_' + randomUUID().replace(/-/gu, ''), key = JSON.stringify(id);
  try {
    await cdp.evaluate(domScript('const e=document.createElement(' + JSON.stringify(rich ? 'div' : 'textarea') + ');e.id=' + key + ';e.style.cssText="position:fixed;left:0;top:0;width:2px;height:2px;opacity:0";e.__previous=active();e.__selection=Array.from({length:document.getSelection()?.rangeCount||0},(_,i)=>document.getSelection().getRangeAt(i).cloneRange());' + (rich ? 'e.contentEditable="true";e.innerHTML=' + JSON.stringify(value) + ';' : 'e.value=' + JSON.stringify(value) + ';') + 'document.body.append(e);e.focus();' + (rich ? 'const r=document.createRange();r.selectNodeContents(e);const s=document.getSelection();s.removeAllRanges();s.addRange(r);' : 'e.select();') + 'if(document.activeElement!==e)throw new Error("Clipboard scratch field could not be focused");'));
    const letter = writing ? 'c' : 'v', modifiers = process.platform === 'darwin' ? 4 : 2;
    await cdp.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: letter, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0), modifiers, commands: [writing ? 'copy' : 'paste'] });
    await cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0), modifiers });
    if (writing) return { wrote: rich ? fields.items! : fields.text!, via: 'editing-command' };
    const read = await cdp.evaluate('(async()=>{const e=document.getElementById(' + key + ');if(!e)throw new Error("Clipboard scratch field disappeared");if(!' + rich + ')return e.value;const entries=[];if(e.innerText)entries.push({mimeType:"text/plain",text:e.innerText});if(e.innerHTML)entries.push({mimeType:"text/html",text:e.innerHTML});for(const img of e.querySelectorAll("img")){const r=await fetch(img.src,{signal:AbortSignal.timeout(5000)}),blob=await r.blob();if(blob.size>4*1024*1024)throw new Error("Clipboard image exceeds the 4 MiB read limit");const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});entries.push({mimeType:blob.type,base64:String(data).split(",")[1]});}return entries;})()');
    return rich ? { entries: json(read), via: 'editing-command' } : { text: json(read), via: 'editing-command' };
  } finally {
    await cdp.evaluate('(()=>{const e=document.getElementById(' + key + ');if(!e)return;const p=e.__previous,ranges=e.__selection;e.remove();if(p?.isConnected)p.focus();const s=document.getSelection();if(s&&ranges){s.removeAllRanges();for(const r of ranges)if(r.startContainer.isConnected&&r.endContainer.isConnected)s.addRange(r);}})()').catch(() => {});
  }
}

export function permissionCommand(fields: BrowserObject): { method: string; params: BrowserObject } {
  const action = String(fields.action ?? 'grant');
  if (action === 'reset') return { method: 'Browser.resetPermissions', params: {} };
  let parsed: URL; try { parsed = new URL(String(fields.origin)); } catch { throw new BrowserError('invalid_request', 'permission needs an http(s) origin.'); }
  if (!['http:','https:'].includes(parsed.protocol)) throw new BrowserError('invalid_request', 'permission needs an http(s) origin.');
  const origin = parsed.origin;
  if (action === 'grant') {
    if (!Array.isArray(fields.permissions) || !fields.permissions.length || fields.permissions.some(p => typeof p !== 'string' || !p)) throw new BrowserError('invalid_request', 'grant needs a non-empty permissions array.');
    return { method: 'Browser.grantPermissions', params: { origin, permissions: fields.permissions } };
  }
  if (action === 'set') {
    const permission = typeof fields.permission === 'string' ? { name: fields.permission } : object(fields.permission), setting = fields.setting ?? 'prompt';
    if (typeof permission.name !== 'string' || !permission.name || !['granted','denied','prompt'].includes(String(setting))) throw new BrowserError('invalid_request', 'set needs permission and setting granted, denied or prompt.');
    return { method: 'Browser.setPermission', params: { origin, permission, setting } };
  }
  throw new BrowserError('invalid_request', 'Unknown permission action: ' + action);
}
