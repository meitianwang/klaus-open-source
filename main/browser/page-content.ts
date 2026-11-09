import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { domScript } from './dom';
import { isolatedWorldEvaluate, WEBMCP_WORLD } from './page-evaluate';
import { timeoutMs } from './policy';
import { BrowserError, json, object, type BrowserObject } from './types';
import type { BrowserCdp, PageOperationContext } from './page-operations';

export function contentFormat(fields: BrowserObject, fallback = 'text'): string {
  const format = String(fields.contentType ?? fields.content_type ?? fields.format ?? fallback).toLowerCase();
  const canonical = ({ md: 'markdown', domsnapshot: 'domSnapshot', dom_snapshot: 'domSnapshot', snapshot: 'domSnapshot' } as Record<string, string>)[format] ?? format;
  if (!['text','markdown','html','domSnapshot','pdf','mhtml'].includes(canonical)) throw new BrowserError('invalid_request', `Unknown content format '${format}'.`);
  return canonical;
}

/** Structural Markdown comes from the live document, including open shadow roots. */
const READ_CONTENT = String.raw`
const markdown = (node, depth = 0) => {
  if (node.nodeType === 3) return node.textContent.replace(/[\t ]+/g,' ');
  if (node.nodeType !== 1 && node.nodeType !== 11) return '';
  const tag=(node.tagName||'').toLowerCase();
  if (['script','style','noscript','template','head'].includes(tag) || node.hidden || node.getAttribute?.('aria-hidden')==='true')return '';
  const children=()=>Array.from(node.childNodes).map(n=>markdown(n,depth+1)).join('')+(node.shadowRoot?markdown(node.shadowRoot,depth+1):'');
  const text=children();
  if (/^h[1-6]$/.test(tag))return '\n\n'+'#'.repeat(Number(tag[1]))+' '+norm(text)+'\n\n';
  if(tag==='a'&&node.href)return '['+norm(text)+']('+node.href+')';
  if(tag==='img'&&node.src)return '!['+(node.alt||'')+']('+node.src+')';
  if(tag==='strong'||tag==='b')return '**'+text+'**';if(tag==='em'||tag==='i')return '*'+text+'*';
  if(tag==='del'||tag==='s')return '~~'+text+'~~';
  if(tag==='pre')return '\n\n'+String.fromCharCode(96).repeat(3)+'\n'+node.textContent+'\n'+String.fromCharCode(96).repeat(3)+'\n\n';
  if(tag==='code')return String.fromCharCode(96)+text+String.fromCharCode(96);
  if(tag==='br')return '\n';if(tag==='hr')return '\n\n---\n\n';
  if(tag==='blockquote')return '\n\n'+text.trim().split('\n').map(l=>'> '+l).join('\n')+'\n\n';
  if(tag==='li'){const list=node.parentElement;const n=list?.tagName==='OL'?Array.from(list.children).indexOf(node)+1+'. ':'- ';return '\n'+n+text.trim();}
  if(tag==='table') {const rows=Array.from(node.rows||[]).map(r=>Array.from(r.cells).map(c=>norm(markdown(c))).join(' | '));if(!rows.length)return '';return '\n\n| '+rows[0]+' |\n| '+Array.from(node.rows[0].cells).map(()=> '---').join(' | ')+' |\n'+rows.slice(1).map(r=>'| '+r+' |').join('\n')+'\n\n';}
  if(['p','div','section','article','main','header','footer','ul','ol'].includes(tag))return '\n\n'+text.trim()+'\n\n';
  return text;
};
`;

export async function readContent(cdp: BrowserCdp, fields: BrowserObject): Promise<BrowserObject> {
  const format = contentFormat(fields);
  if (!['text','markdown','html','domSnapshot'].includes(format)) throw new BrowserError('invalid_request', 'Reading URLs supports text, markdown, html or domSnapshot.');
  const scope = fields.scope ?? fields.selector ?? '';
  if (typeof scope !== 'string') throw new BrowserError('invalid_request', 'Content scope must be a selector string.');
  const named = Number(fields.maxChars ?? fields.maxCharacters ?? fields.limit ?? 200000);
  const cap = Number.isFinite(named) && named > 0 ? Math.min(named,200000) : 200000;
  return object(await cdp.evaluate(domScript(`${READ_CONTENT}
    const scope=${JSON.stringify(scope)};const e=scope?query(scope)[0]:document.body;if(!e)throw new Error('Content scope did not match an element');
    const format=${JSON.stringify(format)};
    let content=format==='html'?e.outerHTML:format==='markdown'?markdown(e).replace(/\\n{3,}/g,'\\n\\n').trim():format==='domSnapshot'?JSON.stringify(Array.from(e.querySelectorAll('*')).filter(visible).slice(0,1000).map(info)):e.innerText||e.textContent||'';
    const glyphs=Array.from(content);content=glyphs.slice(0,${cap}).join('');
    return {format,content,chars:Array.from(content).length,truncated:glyphs.length>${cap},scope:scope||null,title:document.title,url:location.href};`)));
}

export function workspaceExportUrl(input: unknown, format: unknown, gid?: unknown): BrowserObject {
  let url: URL; try { url = new URL(String(input)); } catch { throw new BrowserError('invalid_request', 'The current page is not a Google Workspace document.'); }
  const allowed: Record<string, string[]> = {
    document: ['pdf','docx','odt','rtf','txt','html','epub','md'],
    spreadsheets: ['xlsx','ods','pdf','csv','tsv','html'], presentation: ['pptx','odp','pdf','txt','svg','png','jpeg'], drawings: ['pdf','svg','png','jpeg'],
  };
  const [,editor,segment,id] = url.pathname.split('/'); const kind=String(format).trim().toLowerCase();
  if(url.protocol!=='https:'||!['docs.google.com','drive.google.com'].includes(url.hostname)||!editor||segment!=='d'||!id||!/^[-\w]{12,}$/u.test(id)||!allowed[editor])throw new BrowserError('invalid_request','The current page is not a Google Doc, Sheet, Slide or Drawing.');
  if(!allowed[editor]!.includes(kind))throw new BrowserError('invalid_request',`Google ${editor} cannot export ${kind}. Allowed: ${allowed[editor]!.join(', ')}.`);
  const exported = new URL(editor==='drawings'?`https://docs.google.com/${editor}/d/${id}/export/${kind}`:`https://docs.google.com/${editor}/d/${id}/export?format=${kind}`);
  if(editor==='spreadsheets'&&typeof gid==='string'&&gid)exported.searchParams.set('gid',gid);
  return {editor,documentId:id,url:exported.href,format:kind};
}

/** In-page caption-track extraction for the current YouTube watch page. */
const youtubeTranscriptSource = (language: string): string => `(async () => {
  const pr = window.ytInitialPlayerResponse;
  const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) return { ok: false, reason: 'no_captions', url: location.href, title: document.title };
  const want = ${JSON.stringify(language)}.toLowerCase();
  const manual = tracks.filter(track => track && track.kind !== 'asr');
  const pool = manual.length ? manual : tracks;
  const byWant = want
    ? pool.find(track => String(track.languageCode || '').toLowerCase() === want)
      || pool.find(track => String(track.languageCode || '').toLowerCase().startsWith(want))
    : undefined;
  const track = byWant || pool[0];
  if (!track || !track.baseUrl) return { ok: false, reason: 'no_captions', url: location.href, title: document.title };
  const separator = String(track.baseUrl).includes('?') ? '&' : '?';
  let response;
  try {
    response = await fetch(String(track.baseUrl) + separator + 'fmt=json3', { credentials: 'include', signal: AbortSignal.timeout(20000) });
  } catch (error) {
    return { ok: false, reason: 'fetch_failed', message: String((error && error.message) || error) };
  }
  if (!response.ok) return { ok: false, reason: 'fetch_failed', status: response.status };
  const data = await response.json();
  const lines = [];
  for (const event of (data && Array.isArray(data.events)) ? data.events : []) {
    if (!event || !Array.isArray(event.segs)) continue;
    const text = event.segs.map(segment => String(segment && segment.utf8 != null ? segment.utf8 : '')).join('').replace(/\\s+/gu, ' ').trim();
    if (!text) continue;
    lines.push({ startMs: Number(event.tStartMs || 0), durationMs: Number(event.dDurationMs || 0), text });
  }
  if (!lines.length) return { ok: false, reason: 'empty_transcript', url: location.href };
  const name = track.name || {};
  return {
    ok: true,
    url: location.href,
    title: String((pr.videoDetails && pr.videoDetails.title) || document.title || ''),
    language: String(track.languageCode || ''),
    trackName: String(name.simpleText || (Array.isArray(name.runs) && name.runs[0] && name.runs[0].text) || track.languageCode || ''),
    generated: track.kind === 'asr',
    lines,
  };
})()`;

/** Caption transcript of the current YouTube watch page through its own caption tracks. */
async function youtubeTranscript(context: PageOperationContext, fields: BrowserObject): Promise<BrowserObject> {
  const language = typeof fields.language === 'string' ? fields.language.trim() : '';
  const result = object(await context.cdp.evaluate(youtubeTranscriptSource(language)));
  if (result.ok !== true) {
    const reason = String(result.reason ?? '');
    if (reason === 'no_captions') throw new BrowserError('not_found', `This page exposes no caption tracks${typeof result.url === 'string' && result.url ? ` (${String(result.url)})` : ''}. Open the YouTube watch page first; some videos and live streams have no captions.`);
    if (reason === 'fetch_failed') throw new BrowserError('host_error', `Fetching the caption track failed${result.status !== undefined ? ` with HTTP ${String(result.status)}` : ''}${typeof result.message === 'string' && result.message ? `: ${String(result.message)}` : '.'}`);
    throw new BrowserError('not_found', 'The caption track returned no transcript lines.');
  }
  const lines = (Array.isArray(result.lines) ? result.lines : []).map(object);
  const stamp = (value: unknown): string => {
    const total = Math.max(0, Math.floor(Number(value ?? 0) / 1000));
    const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
    const mm = String(minutes).padStart(2, '0'), ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const rendered = lines.map(line => `[${stamp(line.startMs)}] ${String(line.text ?? '')}`).join('\n');
  const asked = Number(fields.maxChars ?? fields.maxCharacters);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 200000) : 200000;
  const content = rendered.length > limit ? `${rendered.slice(0, limit)}\n[transcript truncated at ${limit} characters]` : rendered;
  return {
    format: 'youtube_transcript',
    video: { title: String(result.title ?? ''), url: String(result.url ?? '') },
    language: String(result.language ?? ''),
    trackName: String(result.trackName ?? ''),
    generated: result.generated === true,
    lineCount: lines.length,
    content,
  };
}

export async function exportContent(context: PageOperationContext, fields: BrowserObject): Promise<BrowserObject> {
  if(typeof fields.gsuite==='string'&&fields.gsuite.trim()) {
    const page=object(await context.cdp.evaluate('({url:location.href,title:document.title})'));
    const exported=workspaceExportUrl(page.url,fields.gsuite,fields.gid);
    const result=await context.download({url:exported.url!},timeoutMs(fields.timeoutMs,60000),context.cdp);
    return {...result,format:exported.format!,gsuite:exported};
  }
  const askedFormat = String(fields.contentType ?? fields.content_type ?? fields.format ?? '').trim().toLowerCase();
  if (askedFormat === 'youtube_transcript' || askedFormat === 'youtube-transcript') return youtubeTranscript(context, fields);
  const format=contentFormat(fields,'pdf');
  if(['text','markdown','html','domSnapshot'].includes(format))return readContent(context.cdp,{...fields,format});
  if(format==='pdf') {
    const printed=await context.cdp.printToPDF();
    if(typeof printed.data!=='string'||!printed.data)throw new BrowserError('host_error','Chromium returned an empty PDF.');
    return {format,dataUrl:`data:application/pdf;base64,${printed.data}`};
  }
  const snapshot=await context.cdp.command('Page.captureSnapshot',{format:'mhtml'});
  if(typeof snapshot.data!=='string'||!snapshot.data)throw new BrowserError('host_error','Chromium returned an empty page archive.');
  return {format,data:snapshot.data};
}

const ASSET_INVENTORY = String.raw`
const assets=[],seen=new Set(),inlineSvgs=[];
const add=(raw,kind,source,name='')=>{
  if(!raw)return;let url;try{url=new URL(raw,source?.baseURI||document.baseURI).href;}catch{return;}
  if(!/^(https?:|blob:|data:)/i.test(url)||url.startsWith('data:')&&url.length>2048||seen.has(url))return;
  seen.add(url);assets.push({id:'a-'+assets.length,kind,url,name:name||url.split('/').pop()?.split('?')[0]||kind,source:source?.tagName?.toLowerCase()||'performance'});
};
for(const root of roots())for(const e of root.querySelectorAll('*')){
  const tag=e.tagName.toLowerCase();
  if(tag==='img'){add(e.currentSrc||e.src,'image',e,e.alt);for(const row of (e.srcset||'').split(','))add(row.trim().split(/\s+/)[0],'image',e,e.alt);}
  if(tag==='source'){add(e.src,e.parentElement?.tagName==='VIDEO'?'video':'image',e);for(const row of(e.srcset||'').split(','))add(row.trim().split(/\s+/)[0],'image',e);}
  if(tag==='video'||tag==='audio'){add(e.currentSrc||e.src,tag,e);add(e.poster,'image',e);}
  if(tag==='script')add(e.src,'script',e);
  if(tag==='link')add(e.href,/icon/i.test(e.rel)?'image':e.rel==='stylesheet'?'stylesheet':'link',e);
  if(tag==='svg'&&inlineSvgs.length<40&&e.outerHTML.length<60000)inlineSvgs.push({id:'svg-'+inlineSvgs.length,html:e.outerHTML});
}
let checked=0;
for(const root of roots())for(const e of root.querySelectorAll('*')){if(++checked>1500)break;const style=e.ownerDocument.defaultView.getComputedStyle(e);for(const key of ['backgroundImage','borderImageSource','maskImage','listStyleImage'])for(const m of style[key].matchAll(/url\(["']?(.*?)["']?\)/g))add(m[1],'image',e);}
for(const entry of performance.getEntriesByType('resource')){const url=entry.name;const kind=/\.(woff2?|ttf|otf)(\?|$)/i.test(url)?'font':/\.(png|jpe?g|svg|gif|webp|avif|ico)(\?|$)/i.test(url)?'image':/\.css(\?|$)/i.test(url)?'stylesheet':/\.js(\?|$)/i.test(url)?'script':/\.(mp4|webm)(\?|$)/i.test(url)?'video':entry.initiatorType;add(url,kind,null);}
const byKind={};for(const asset of assets)byKind[asset.kind]=(byKind[asset.kind]||0)+1;
return {pageUrl:location.href,assets,inlineSvgs,summary:{byKind,totalCount:assets.length,inlineSvgCount:inlineSvgs.length}};
`;

export async function pageAssets(context: PageOperationContext, fields: BrowserObject): Promise<BrowserObject> {
  const inventory=object(await context.cdp.evaluate(domScript(ASSET_INVENTORY)));
  const action=String(fields.action??'list');
  if(['list','get','inventory'].includes(action))return inventory;
  if(!['bundle','export','save'].includes(action))throw new BrowserError('invalid_request',`Unknown page_assets action '${action}'.`);
  if(!context.artifactDirectory)throw new BrowserError('unavailable','Browser artifact storage is not configured.');
  const rows=(Array.isArray(inventory.assets)?inventory.assets:[]).map(object),ids=Array.isArray(fields.assetIds)?fields.assetIds:[],kinds=Array.isArray(fields.kinds)?fields.kinds:['image'];
  const chosen=rows.filter(row=>ids.length?ids.includes(row.id!):kinds.includes(row.kind!));
  if(!chosen.length)throw new BrowserError('not_found','No page assets match these kinds or assetIds.');
  if(chosen.length>200)throw new BrowserError('invalid_request','Select at most 200 assets in one bundle.');
  const directory=join(context.artifactDirectory,'page-assets',`bundle-${randomUUID()}`);await mkdir(directory,{recursive:true});
  const saved: BrowserObject[]=[],failures: BrowserObject[]=[];const started=Date.now();
  for(const [index,row] of chosen.entries()) {
    try {
      // The browser session supplies cookies and referrer. Host-side fetch would lose the login.
      const fetched=object(await context.cdp.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(row.url)},{credentials:'include',signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('HTTP '+r.status);const cap=4*1024*1024;if(Number(r.headers.get('content-length'))>cap){await r.body?.cancel();throw new Error('Asset exceeds the 4 MiB bundle limit; download it separately');}const reader=r.body.getReader(),parts=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>cap){await reader.cancel();throw new Error('Asset exceeds the 4 MiB bundle limit; download it separately');}parts.push(value);}let binary='';for(const part of parts)for(let n=0;n<part.length;n+=8192)binary+=String.fromCharCode(...part.subarray(n,n+8192));return {base64:btoa(binary),contentType:r.headers.get('content-type')||'application/octet-stream'};})()`));
      if(typeof fetched.base64!=='string')throw new BrowserError('host_error','Page returned no asset bytes.');
      const bytes=Buffer.from(fetched.base64,'base64');
      const mime=String(fetched.contentType??'').split(';')[0];
      const suffix=({'image/png':'png','image/jpeg':'jpg','image/svg+xml':'svg','image/gif':'gif','image/webp':'webp','text/css':'css','font/woff2':'woff2','video/mp4':'mp4'} as Record<string,string>)[mime!]??'bin';
      let safe=String(row.name||new URL(String(row.url)).pathname.split('/').pop()||'asset').replace(/[^a-zA-Z0-9._-]/gu,'-').replace(/^\.+|\.+$/gu,'').slice(0,80)||'asset';if(!safe.includes('.'))safe+=`.${suffix}`;
      const name=`${String(index).padStart(3,'0')}-${safe}`,path=join(directory,name);await writeFile(path,bytes,{flag:'wx'});
      saved.push({...row,name,path,bytes:bytes.length,contentType:fetched.contentType??null});
    }catch(error){failures.push({id:row.id??null,url:row.url??null,reason:error instanceof Error?error.message:String(error)});}
  }
  const summary={requestedCount:chosen.length,downloadedCount:saved.length,failedCount:failures.length,elapsedMs:Date.now()-started};
  const manifestPath=join(directory,'manifest.json');await writeFile(manifestPath,JSON.stringify({pageUrl:inventory.pageUrl,assets:saved,failures,summary},null,2),{flag:'wx'});
  return {directoryPath:directory,manifestPath,assets:saved,failures,summary};
}

/** The form surface is enumerated in an isolated world: clean DOM prototypes a page cannot forge. */
export const WEBMCP_FORMS = domScript(`const tools=[],surfaces=[];
for(const form of query('form[tool-name]')){const name=norm(form.getAttribute('tool-name'));if(!name)continue;const properties={},required=[];for(const e of form.querySelectorAll('input[name],select[name],textarea[name]')){properties[e.name]={type:e.type==='checkbox'?'boolean':['number','range'].includes(e.type)?'number':'string',description:e.getAttribute('tool-param-description')||label(e)||null};if(e.required)required.push(e.name);}tools.push({name,via:'form',description:form.getAttribute('tool-description')||null,inputSchema:{type:'object',properties,required}});}
if(tools.length)surfaces.push('form[tool-name]');
return {tools,surfaces,pageUrl:location.href};`);

/** The modelContext surface is a page-world object; only the main world can read it. */
export const WEBMCP_CONTEXT = domScript(`const tools=[],surfaces=[];let opaque=false;
const context=navigator.modelContext;let listed;
if(context){surfaces.push('navigator.modelContext');for(const key of ['tools','_tools','registeredTools','toolRegistry']){const found=context[key];if(found){listed=Array.isArray(found)?found:found instanceof Map?Array.from(found.values()):typeof found==='object'?Object.values(found):null;if(listed)break;}}if(listed)for(const tool of listed)if(tool?.name)tools.push({name:tool.name,via:'script',description:tool.description||null,inputSchema:tool.inputSchema||null});if(!listed){surfaces.push('navigator.modelContext:opaque');opaque=true;}}
return {tools,surfaces,opaque,pageUrl:location.href};`);

const WEBMCP_MAX_TOOLS = 100;
const WEBMCP_MAX_DESCRIPTOR_BYTES = 65536;
const WEBMCP_STALE = '__klausStalePageUrl';

const rows = (value: unknown): BrowserObject[] => (Array.isArray(value) ? value : []).map(object);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value : []).map(item => String(item));

/** Enumerate both readable surfaces and enforce the descriptor limits host-side, where a page cannot bypass them. */
async function listPageTools(cdp: BrowserCdp): Promise<BrowserObject> {
  const forms = object(await isolatedWorldEvaluate(cdp, WEBMCP_WORLD, WEBMCP_FORMS));
  const script = object(await cdp.evaluate(WEBMCP_CONTEXT));
  const tools = [...rows(forms.tools), ...rows(script.tools)];
  if (tools.length > WEBMCP_MAX_TOOLS) throw new BrowserError('unavailable', `This page declares ${tools.length} agent tools, above the supported limit of ${WEBMCP_MAX_TOOLS}. The site must correct its configuration and reload the page to retry.`);
  const bytes = Buffer.byteLength(JSON.stringify(tools));
  if (bytes > WEBMCP_MAX_DESCRIPTOR_BYTES) throw new BrowserError('unavailable', `This page's agent tool descriptors total ${bytes} bytes, above the supported limit of ${WEBMCP_MAX_DESCRIPTOR_BYTES}. The site must correct its configuration and reload the page to retry.`);
  const surfaces = [...new Set([...texts(forms.surfaces), ...texts(script.surfaces)])];
  const opaque = script.opaque === true;
  return {
    tools, surfaces, available: tools.length > 0, opaque,
    note: opaque ? 'The page registers tools in an opaque browser registry; this surface cannot enumerate or call them.' : tools.length ? null : 'This page declares no agent tools.',
    pageUrl: typeof forms.pageUrl === 'string' ? forms.pageUrl : typeof script.pageUrl === 'string' ? script.pageUrl : null,
  };
}

async function staleGuarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof Error && error.message.includes(WEBMCP_STALE)) throw new BrowserError('stale_target', 'The page navigated while its agent tools were in use; list the page tools again.');
    throw error;
  }
}

export async function callPageTool(cdp: BrowserCdp, fields: BrowserObject, perform: (kind: string, fields: BrowserObject) => Promise<unknown>): Promise<BrowserObject> {
  const found = await listPageTools(cdp), wanted = fields.name ?? fields.tool;
  if (wanted === undefined) return found;
  if (typeof wanted !== 'string' || !wanted) throw new BrowserError('invalid_request', 'A page tool name must be a non-empty string.');
  const tools = rows(found.tools), tool = tools.find(row => row.name === wanted);
  if (!tool) throw new BrowserError('not_found', `This page declares no readable tool named '${wanted}'.`);
  const input = object(fields.input ?? fields.arguments);
  // The document that declared the tool must survive until the call: a
  // navigation in between invalidates the listing like a stale registration.
  const pageUrl = typeof found.pageUrl === 'string' ? found.pageUrl : '';
  const staleCheck = `if(${JSON.stringify(pageUrl)}&&location.href!==${JSON.stringify(pageUrl)})throw new Error(${JSON.stringify(WEBMCP_STALE)});`;
  if (tool.via === 'script') {
    const value = await staleGuarded(() => cdp.evaluate(`(async()=>{${staleCheck}const context=navigator.modelContext;let listed;for(const key of ['tools','_tools','registeredTools','toolRegistry']){const found=context?.[key];if(found){listed=Array.isArray(found)?found:found instanceof Map?Array.from(found.values()):typeof found==='object'?Object.values(found):null;if(listed)break;}}const tool=(listed||[]).find(t=>t?.name===${JSON.stringify(wanted)}),run=tool&&(tool.execute||tool.handler||tool.call);if(typeof run!=='function')throw new Error('Page tool is gone or is not callable');return await run.call(tool,${JSON.stringify(input)});})()`));
    return { called: wanted, via: 'script', value: json(value) };
  }
  const selector = `form[tool-name=${JSON.stringify(wanted)}]`;
  if (Object.keys(input).length) await perform('form_input', { fields: Object.entries(input).map(([key, value]) => ({ selector: `${selector} [name=${JSON.stringify(key)}]`, value, clear: true })) });
  const submitted = await staleGuarded(() => isolatedWorldEvaluate(cdp, WEBMCP_WORLD, domScript(`
    ${staleCheck}
    const form=query(${JSON.stringify(selector)})[0];if(!form)throw new Error('Page form is gone');if(!form.reportValidity())throw new Error('Page rejected the form values');const button=form.querySelector('button[type=submit],input[type=submit],button:not([type])');if(button){button.click();return 'button';}if(typeof form.requestSubmit==='function'){form.requestSubmit();return 'requestSubmit';}throw new Error('Page form has no submit control');`)));
  return { called: wanted, via: 'form', filled: Object.keys(input), submittedVia: json(submitted) };
}
