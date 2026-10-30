import { captureScreenshot } from './page-capture';
import { randomUUID } from 'node:crypto';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';
import { locatorBudget, validateLocator } from './locator-policy';

/** Page-only helpers. Nothing in this source can import or call the host bridge. */
export const DOM_HELPERS = String.raw`
const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const roots = (root = document, depth = 0) => {
  const out = [root]; if (depth >= 4) return out;
  for (const host of root.querySelectorAll('*')) {
    if (host.shadowRoot) out.push(...roots(host.shadowRoot, depth + 1));
    if (host.matches('iframe,frame')) { try { if (host.contentDocument) out.push(...roots(host.contentDocument, depth + 1)); } catch {} }
  }
  return out;
};
const query = (selector, root = document) => {
  const parts = String(selector).split(/\s+>>>\s+/);
  let found = roots(root).flatMap(r => Array.from(r.querySelectorAll(parts[0])));
  for (const part of parts.slice(1)) found = found.flatMap(host => {
    let inner = host.shadowRoot;
    try { inner ||= host.contentDocument; } catch {}
    return inner ? roots(inner).flatMap(r => Array.from(r.querySelectorAll(part))) : [];
  });
  return Array.from(new Set(found));
};
const refs = globalThis.__klausBrowserRefs ||= Object.create(null);
const refKeys = globalThis.__klausBrowserRefKeys ||= new WeakMap();
const markRef = (e, prefix) => {let ref=refKeys.get(e);if(ref&&refs[ref]===e)return ref;ref=prefix+(globalThis.__klausBrowserRefNext=(globalThis.__klausBrowserRefNext||0)+1);refs[ref]=e;refKeys.set(e,ref);return ref;};
const resolve = spec => {
  const ref = spec.ref ?? spec.refId;
  if (ref !== undefined) return refs[ref]?.isConnected ? refs[ref] : null;
  return spec.selector ? query(spec.selector)[0] ?? null : null;
};
const label = e => {
  const ids = (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  const root = e.getRootNode();
  return norm(ids.map(id => root.querySelector('#' + CSS.escape(id))?.textContent || '').join(' ')) ||
    norm(e.labels && Array.from(e.labels).map(l => l.innerText || l.textContent).join(' ')) || norm(e.closest('label')?.textContent);
};
const name = e => norm(e.getAttribute('aria-label') || label(e) || e.getAttribute('alt') || e.innerText || e.getAttribute('placeholder') || (e.type==='password'?'':e.value) || e.getAttribute('title'));
const role = e => {
  if (e.getAttribute('role')) return e.getAttribute('role').split(' ')[0];
  const t = e.tagName.toLowerCase(), type = e.type;
  if (t === 'input') return ({checkbox:'checkbox',radio:'radio',search:'searchbox',number:'spinbutton',range:'slider',button:'button',submit:'button',reset:'button',file:'input',hidden:'input'})[type] || 'textbox';
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'select') return e.multiple || e.size > 1 ? 'listbox' : 'combobox';
  if (t === 'a') return e.hasAttribute('href') ? 'link' : 'generic';
  return ({button:'button',textarea:'textbox',img:'img',nav:'navigation',main:'main',aside:'complementary',ul:'list',ol:'list',li:'listitem',table:'table',tr:'row',td:'cell',th:e.scope === 'row' ? 'rowheader' : 'columnheader',thead:'rowgroup',tbody:'rowgroup',tfoot:'rowgroup',option:'option',progress:'progressbar',output:'status',summary:'button',fieldset:'group',dialog:'dialog',form:'form'})[t] || t;
};
const box = e => {
  const r = e.getBoundingClientRect(); let x = r.x, y = r.y, view = e.ownerDocument.defaultView;
  while (view && view !== window) { const frame = view.frameElement; if (!frame) break; const b=frame.getBoundingClientRect(); x += b.x + frame.clientLeft; y += b.y + frame.clientTop; view = frame.ownerDocument.defaultView; }
  return {x,y,width:r.width,height:r.height};
};
const visible = e => { const r=e.getBoundingClientRect(),s=e.ownerDocument.defaultView.getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; };
const enabled = e => {if(e.matches(':disabled'))return false;for(let at=e;at;at=at.parentNode||at.host){const state=at.getAttribute?.('aria-disabled');if(state==='true')return false;if(state==='false')break;}return true;};
const info = e => !e || !e.isConnected ? null : ({tag:e.tagName.toLowerCase(),role:role(e),name:name(e),text:norm(e.innerText || e.textContent).slice(0,2000),type:e.type || null,value:e.type==='password'?null:e.value??null,checked:typeof e.checked==='boolean'?e.checked:e.hasAttribute('aria-checked')?e.getAttribute('aria-checked')==='true':null,visible:visible(e),enabled:enabled(e),...box(e)});
const active = () => { let e=document.activeElement; for(let i=0;e&&i<8;i++){const next=e.shadowRoot?.activeElement;let nested;try{nested=e.contentDocument?.activeElement;}catch{}if(!next&&!nested)break;e=next||nested;} return e; };
const SELECTABLE = 'a,area,button,input,select,textarea,summary,label,option,[role],[onclick],[tabindex],[contenteditable="true"],[data-testid],[data-test-id],[data-test],[data-qa],[aria-label],img,video,audio,canvas,h1,h2,h3,h4,h5,h6,table,thead,tbody,tfoot,tr,td,th,ul,ol,menu,li,nav,main,aside,form,search,dialog,header,footer,section,progress,output,fieldset,details,hr';
const TEXTUAL = 'p,span,div,strong,em,b,i,small,time,code,pre,blockquote,dd,dt,figcaption,caption,address,legend,cite,q,mark,abbr,dfn,ins,del,s';
const matches = (e, f) => {
  const match = (actual, wanted) => wanted === undefined || wanted === '' || (f.exact === true ? norm(actual).toLowerCase() === norm(wanted).toLowerCase() : norm(actual).toLowerCase().includes(norm(wanted).toLowerCase()));
  if (f.role && norm(role(e)).toLowerCase() !== norm(f.role).toLowerCase()) return false;
  if (f.label && (e.tagName === 'LABEL' || !(e.labels !== undefined || e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby') || e.isContentEditable))) return false;
  if (!match(name(e),f.name) || (!match(label(e),f.label)&&!match(e.getAttribute('aria-label'),f.label)) || !match(e.getAttribute('placeholder'),f.placeholder) || !match(e.getAttribute('data-testid')||e.getAttribute('data-test-id')||e.getAttribute('data-test')||e.getAttribute('data-qa'),f.testId)) return false;
  if (!match(name(e), f.text) || !match(e.innerText || e.textContent, f.hasText)) return false;
  if (f.hasNotText && match(e.innerText || e.textContent, f.hasNotText)) return false;
  const child = criterion => typeof criterion === 'string' ? query(criterion,e).length>0 : locate(criterion,e).length>0;
  if (f.has && !child(f.has)) return false; if(f.hasNot && child(f.hasNot))return false;
  const shown=visible(e),ready=enabled(e);
  if(f.state==='visible'&&!shown||f.state==='hidden'&&shown||f.state==='enabled'&&(!shown||!ready)||f.state==='disabled'&&ready)return false;
  if(f.state===undefined && f.visible!==false && (!shown || f.enabled!==false&&!ready))return false;
  if (f.enabled === true && !enabled(e)) return false;
  return true;
};
const locate = (input, root = document) => {
  const f = {...input,...(typeof input.locator === 'object' ? input.locator : {})};
  if (typeof input.locator === 'string') f.selector = input.locator;
  delete f.locator;
  if (f.query !== undefined && f.text === undefined) f.text=f.query;
  const alternatives=f.any??f.or;let candidates;
  if(Array.isArray(alternatives)){
    const shared=Object.fromEntries(['state','exact','within','visible','enabled'].filter(key=>f[key]!==undefined).map(key=>[key,f[key]]));
    candidates=alternatives.flatMap(one=>locate({...shared,...one},root));
  }
  else if (f.ref !== undefined || f.refId !== undefined) {const e=resolve(f); candidates=e?[e]:[];}
  else if (f.within) { const parents=typeof f.within==='string'?(refs[f.within]?.isConnected?[refs[f.within]]:f.within.startsWith('e-')?[]:query(f.within,root)):locate(f.within,root); const local={...f};for(const key of ['within','nth','first','last'])delete local[key]; candidates=parents.flatMap(p=>locate(local,p)); }
  else candidates=query(f.selector || (f.text||f.hasText?SELECTABLE+','+TEXTUAL:SELECTABLE),root);
  let found=Array.from(new Set(candidates)).filter(e=>Array.isArray(alternatives)||matches(e,f));
  if(!Array.isArray(alternatives)&&!f.selector&&f.ref===undefined&&f.refId===undefined){const matched=new Set(found),wrapped=new Set();for(const e of found)for(let at=e.parentNode;at;at=at.parentNode||at.host)if(matched.has(at))wrapped.add(at);found=found.filter(e=>!wrapped.has(e));}
  if (f.nth !== undefined) { const n=Number(f.nth); found=Number.isInteger(n)?[found[n<0?found.length+n:n]].filter(Boolean):[]; }
  if (f.first===true)found=found.slice(0,1);if(f.last===true)found=found.slice(-1);
  return found;
};
`;

export function domScript(body: string): string { return `(() => { ${DOM_HELPERS}\n${body}\n})()`; }
export function elementScript(fields: BrowserObject): string { return `resolve(${JSON.stringify(fields)})`; }
export function elementInfoScript(fields: BrowserObject): string { return domScript(`return info(${elementScript(fields)});`); }
export function namesElement(fields: BrowserObject): boolean { return ['selector', 'ref', 'refId', 'locator', 'role', 'name', 'label', 'placeholder', 'testId', 'within', 'query', 'has', 'hasNot', 'hasText', 'hasNotText', 'any', 'or'].some(key => fields[key] !== undefined); }

/** A scoped adapter cannot address a sibling tab or a different frame. */
export function frameCdp(cdp: BrowserCdp, frame?: string): BrowserCdp {
  if (!frame) return cdp;
  const scoped: BrowserCdp = {
    captureScope: { root: cdp.captureScope?.root ?? cdp, frame },
    command: (method, params) => cdp.command(method, params, frame),
    evaluate: expression => cdp.evaluate(expression, frame),
    screenshot: options => captureScreenshot(scoped, options ?? {}), frameTargets: () => [], console: cdp.console, network: cdp.network, events: cdp.events,
    evicted: cdp.evicted,
    printToPDF: () => Promise.reject(new BrowserError('invalid_request', 'PDF export addresses the whole tab, not frameTargetId.')),
    onEvent: listener => cdp.onEvent((method, params, source) => { if(source === frame) listener(method, params, source); }),
  };
  return scoped;
}

export async function locateElements(cdp: BrowserCdp, fields: BrowserObject, frame?: string): Promise<BrowserObject[]> {
  const result = await probeElements(cdp, fields, frame);
  return result.elements as BrowserObject[];
}

export async function probeElements(cdp: BrowserCdp, fields: BrowserObject, frame?: string, limit = 200, assertActive?: () => void): Promise<BrowserObject> {
  assertActive?.();
  fields = validateLocator(fields);
  const prefix = `e-${randomUUID()}-`;
  const source = domScript(`const all=locate(${JSON.stringify(fields)});const elements=all.slice(0,${limit}).map(e=>({ref:markRef(e,${JSON.stringify(prefix)}),...info(e),box:box(e),inViewport:(()=>{const r=e.getBoundingClientRect(),w=e.ownerDocument.defaultView;return r.right>0&&r.bottom>0&&r.left<w.innerWidth&&r.top<w.innerHeight})(),${fields.textContent===true?'textContent:e.textContent===null?null:e.textContent.slice(0,20000),...(e.textContent?.length>20000?{textContentTruncated:true}:{}),':''}${fields.attribute!==undefined?'attribute:e.getAttribute('+JSON.stringify(fields.attribute)+'),':''}}));return {url:location.href,title:document.title,elements,count:elements.length,total:all.length,truncated:all.length>elements.length};`);
  const result = object(await cdp.evaluate(source, frame));
  assertActive?.();
  const elements = (Array.isArray(result.elements) ? result.elements : []).map(value => ({ ...object(value), ...(frame ? { frameTargetId: frame } : {}) }));
  return { ...result, elements };
}

export async function resolveElement(cdp: BrowserCdp, fields: BrowserObject, frame?: string, uniqueVisibleFallback = false, assertActive?: () => void): Promise<{ cdp: BrowserCdp; fields: BrowserObject }> {
  assertActive?.();
  fields = validateLocator(fields);
  const result = await searchElements(cdp, fields, frame, 200, fields.ref !== undefined || fields.refId !== undefined ? 0 : 5000, 60000, assertActive);
  assertActive?.();
  const candidates = result.elements as BrowserObject[];
  if (!candidates.length) throw new BrowserError('not_found', 'No element matches this locator. Refresh the snapshot or locator.');
  const visibleCandidates = candidates.filter(entry => entry.visible === true);
  if (candidates.length > 1 && (fields.strict === true || uniqueVisibleFallback && visibleCandidates.length !== 1)) {
    const matches = candidates.slice(0, 10).map(entry => ({ ref: entry.ref, role: entry.role, name: entry.name, tag: entry.tag, frameTargetId: entry.frameTargetId ?? null }));
    throw new BrowserError('ambiguous_locator', `This locator matches ${String(result.total)} elements. Narrow it with within, nth or an exact name. Matches: ${JSON.stringify(matches)}`);
  }
  const selected = uniqueVisibleFallback && candidates.length > 1 ? visibleCandidates[0]! : candidates[0]!;
  const resolved: BrowserObject = { ...fields, ref: selected.ref! }; delete resolved.selector;
  return { cdp: frameCdp(cdp, typeof selected.frameTargetId === 'string' ? selected.frameTargetId : frame), fields: resolved };
}

/** Search only this page, then its owned OOPIFs if the addressed document is empty. */
export async function searchElements(cdp: BrowserCdp, fields: BrowserObject, frame?: string, limit = 200, defaultTimeout = 5000, maximumTimeout = 30000, assertActive?: () => void): Promise<BrowserObject> {
  assertActive?.();
  fields = validateLocator(fields);
  const until = Date.now() + locatorBudget(fields.timeoutMs, defaultTimeout, maximumTimeout, 'Locator timeoutMs');
  const alternatives = fields.any ?? fields.or;
  let latest: BrowserObject = { elements: [], count: 0, total: 0, truncated: false };
  for (;;) {
    assertActive?.();
    try {
      if (Array.isArray(alternatives)) {
        const shared = Object.fromEntries(['state', 'exact', 'within', 'visible', 'enabled', 'frames', 'attribute', 'textContent'].filter(key => fields[key] !== undefined).map(key => [key, fields[key]!])) as BrowserObject;
        const union: BrowserObject[] = []; const seen = new Set<string>(); let total = 0; let truncated = false;
        for (const alternative of alternatives) {
          assertActive?.();
          const found = await searchElements(cdp, { ...shared, ...object(alternative), timeoutMs: 0 }, frame, limit, 0, maximumTimeout, assertActive);
          assertActive?.();
          total += Number(found.total); truncated ||= found.truncated === true;
          for (const row of found.elements as BrowserObject[]) { const key = `${String(row.frameTargetId ?? '')}:${String(row.ref)}`; if (!seen.has(key)) { seen.add(key); union.push(row); } }
        }
        let kept = union;
        if (typeof fields.nth === 'number') kept = [union[fields.nth < 0 ? union.length + fields.nth : fields.nth]!].filter(Boolean);
        if (fields.first === true) kept = kept.slice(0, 1); if (fields.last === true) kept = kept.slice(-1);
        latest = { elements: kept.slice(0, limit), count: Math.min(kept.length, limit), total, truncated: truncated || kept.length > limit, alternatives: alternatives.length };
        if (Number(latest.count) > 0) return latest;
      } else {
        latest = await probeElements(cdp, fields, frame, limit, assertActive);
        assertActive?.();
        if (Number(latest.count) > 0) return latest;
        if (!frame && fields.frames !== false) for (const child of cdp.frameTargets()) {
          assertActive?.();
          const found = await probeElements(cdp, fields, child, limit, assertActive);
          assertActive?.();
          if (Number(found.count) > 0) return found;
        }
      }
    } catch (error) {
      assertActive?.();
      if (!(error instanceof BrowserError) || !['cdp_error', 'evaluation_error'].includes(error.code) || !/context.*destroyed|cannot find context/iu.test(error.message)) throw error;
    }
    if (Date.now() >= until) return latest;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, until - Date.now()))));
    assertActive?.();
  }
}
