import { DOM_HELPERS, elementScript, namesElement, resolveElement } from './dom';
import { aborted, downloadFilename, saveDownload, suggestedFilename, withAbort } from './downloads';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

export function namesMedia(fields: BrowserObject): boolean { return namesElement(fields) || fields.text !== undefined || fields.x !== undefined || fields.y !== undefined || typeof fields.url === 'string' && /^(?:blob|data):/u.test(fields.url); }

/** Read original page-owned bytes in bounded CDP messages, without navigating. */
export async function downloadPageMedia(
  cdp: BrowserCdp,
  input: BrowserObject,
  directory: string,
  id: string,
  signal: AbortSignal,
  assertUrl: (url: unknown) => string,
  authorize?: (url: string, signal: AbortSignal) => Promise<void> | void,
): Promise<BrowserObject> {
  let fields = input;
  if (namesElement(fields) || fields.text !== undefined) { const found = await withAbort(resolveElement(cdp, fields), signal); cdp = found.cdp; fields = found.fields; }
  const explicitUrl = !namesElement(fields) && fields.text === undefined && fields.x === undefined && fields.y === undefined;
  if (!explicitUrl && !namesElement(fields) && (!Number.isFinite(fields.x) || !Number.isFinite(fields.y))) throw new BrowserError('invalid_request','Media coordinates require finite x and y.');
  const probe = namesElement(fields) ? elementScript(fields) : `(()=>{let e=document.elementFromPoint(${Number(fields.x)},${Number(fields.y)});for(let i=0;e&&i<8;i++){const inner=e.shadowRoot?.elementFromPoint(${Number(fields.x)},${Number(fields.y)});if(!inner||inner===e)break;e=inner;}return e;})()`;
  const key = `__klausDownload_${id.replace(/-/gu,'')}`;
  const access = `globalThis[${JSON.stringify(key)}]`;
  const cleanup = (): Promise<unknown> => cdp.evaluate(`(()=>{const s=${access};if(s){s.controller.abort();s.reader?.cancel().catch(()=>{});clearTimeout(s.timer);delete ${access};}return true;})()`);
  const abortExternal = (): void => { void cleanup().catch(() => {}); };
  signal.addEventListener('abort', abortExternal, { once: true });
  if (signal.aborted) abortExternal();
  try {
    const metadata = object(await withAbort(cdp.evaluate(`(()=>{${DOM_HELPERS}
      const controller=new AbortController(); const state={controller}; ${access}=state;
      state.timer=setTimeout(()=>{controller.abort();state.reader?.cancel().catch(()=>{});delete ${access};},65000);
      const from=e=>{
        if(!e)return null;const tag=e.tagName.toLowerCase();
        if(tag==='canvas'||tag==='svg')return {node:e,tag,url:null};
        let url=tag==='img'?e.currentSrc||e.src:['video','audio'].includes(tag)?e.currentSrc||e.querySelector('source[src]')?.src||e.poster:tag==='source'?e.src:tag==='a'?e.href:'';
        if(!url){const found=/url\\(["']?([^"')]+)["']?\\)/.exec(e.ownerDocument.defaultView.getComputedStyle(e).backgroundImage);if(found)url=new URL(found[1],e.ownerDocument.baseURI).href;}
        return url?{node:e,tag,url}:null;
      };
      let found;
      ${explicitUrl ? `found={url:${JSON.stringify(input.url)},tag:'url',node:null};` : `const e=${probe};found=from(e)||from(e?.querySelector('img,video,audio,source,canvas,svg,a[href]'));`}
      if(!found)throw new Error('The element has no downloadable image, media, canvas, SVG or link.');
      state.source=found;return {url:found.url,tag:found.tag,filename:found.node?.getAttribute('download')||null};
    })()`),signal));
    if (typeof metadata.url === 'string' && !/^(?:blob|data):/u.test(metadata.url)) {
      assertUrl(metadata.url);
      if (authorize) await authorize(metadata.url, signal);
      aborted(signal);
    }
    const started = object(await withAbort(cdp.evaluate(`(async()=>{
      const s=${access};if(!s)throw new Error('The media document was replaced');const source=s.source;
      let blob,response;
      if(source.tag==='canvas')blob=await new Promise((resolve,reject)=>{try{source.node.toBlob(value=>value?resolve(value):reject(new Error('Canvas export failed')),'image/png');}catch(error){reject(error);}});
      else if(source.tag==='svg')blob=new Blob([new XMLSerializer().serializeToString(source.node)],{type:'image/svg+xml'});
      else {response=await fetch(source.url,{credentials:'include',signal:s.controller.signal});if(!response.ok)throw new Error('Media fetch returned HTTP '+response.status);}
      if(s.controller.signal.aborted)throw new Error('The media download was canceled');
      s.reader=(blob?blob.stream():response.body)?.getReader();if(!s.reader)throw new Error('The media has no readable body');s.pending=null;s.offset=0;
      return {mimeType:blob?.type||response.headers.get('content-type')||'application/octet-stream',url:response?.url||source.url,contentDisposition:response?.headers.get('content-disposition')||null};
    })()`),signal));
    const resolvedUrl = typeof started.url === 'string' ? started.url : '';
    if (resolvedUrl && resolvedUrl !== metadata.url && !/^(?:blob|data):/u.test(resolvedUrl)) {
      assertUrl(resolvedUrl);
      if (authorize) await authorize(resolvedUrl, signal);
      aborted(signal);
    }
    const mime = String(started.mimeType).split(';')[0];
    const fallback = metadata.tag === 'canvas' ? 'canvas.png' : metadata.tag === 'svg' ? 'image.svg' : typeof metadata.filename === 'string' && metadata.filename ? metadata.filename : typeof metadata.url === 'string' && /^https?:/u.test(metadata.url) ? suggestedFilename(metadata.url, typeof started.contentDisposition === 'string' ? started.contentDisposition : undefined) : `download${({ 'image/png':'.png','image/jpeg':'.jpg','image/svg+xml':'.svg','video/mp4':'.mp4','audio/mpeg':'.mp3','text/plain':'.txt' } as Record<string,string>)[mime ?? ''] ?? ''}`;
    const filename = downloadFilename(input.filename ?? input.saveAs, suggestedFilename(`https://download.invalid/${encodeURIComponent(fallback)}`));
    async function* chunks(): AsyncGenerator<Uint8Array> {
      let total=0;
      for (;;) {
        aborted(signal);
        const chunk=object(await withAbort(cdp.evaluate(`(async()=>{const s=${access};if(!s||s.controller.signal.aborted)throw new Error('The media document or download was released');if(!s.pending||s.offset>=s.pending.length){const next=await s.reader.read();if(next.done)return {done:true};s.pending=next.value;s.offset=0;}const part=s.pending.subarray(s.offset,s.offset+32768);s.offset+=part.length;return {done:false,data:btoa(String.fromCharCode(...part))};})()`),signal));
        if(chunk.done===true)break;
        if(typeof chunk.data!=='string'||chunk.data.length>45000||!/^[A-Za-z0-9+/]*={0,2}$/u.test(chunk.data))throw new BrowserError('download_failed','The page returned an invalid media chunk.');
        const bytes=Buffer.from(chunk.data,'base64');total+=bytes.length;
        if(total>256*1024*1024)throw new BrowserError('download_limit','Page media exceeds the 256 MiB transfer limit. Use a direct HTTP URL download for larger files.');
        yield bytes;
      }
    }
    const saved=await saveDownload(directory,id,filename,chunks(),signal);
    return {...saved,tag:metadata.tag ?? 'url',url:typeof started.url==='string' && !started.url.startsWith('data:') ? started.url : null,mimeType:mime ?? '',via:'page-stream'};
  } finally {
    // The page has its own deadline too, so a destroyed transport cannot leave a
    // fetch running indefinitely after the host stops awaiting this operation.
    signal.removeEventListener('abort', abortExternal);
    await Promise.race([cleanup().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,250))]);
  }
}
