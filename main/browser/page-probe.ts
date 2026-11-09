import { randomUUID } from 'node:crypto';
import { domScript, frameCdp } from './dom';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

function probeScript(x: number, y: number, includeAll: boolean): string {
  const prefix = `e-${randomUUID()}-`;
  return domScript(`
    const rows=[],seen=new Set();let crossOriginFrame;
    const path=e=>{const root=e.getRootNode();if(e.id&&root.querySelector('#'+CSS.escape(e.id))===e)return '#'+CSS.escape(e.id);const steps=[];for(let at=e;at?.nodeType===1;at=at.parentNode){const siblings=Array.from(at.parentNode?.children||[]).filter(s=>s.tagName===at.tagName);steps.unshift(at.tagName.toLowerCase()+(siblings.length>1?':nth-of-type('+(siblings.indexOf(at)+1)+')':''));const found=steps.join(' > ');if(root.querySelectorAll(found).length===1)return found;}return steps.join(' > ')};
    const candidates=(e,prefix)=>{const out=[],root=e.getRootNode();const add=sel=>{if(!sel||out.includes(prefix+sel))return;try{if(root.querySelector(sel)===e&&query(prefix+sel)[0]===e)out.push(prefix+sel)}catch{}};if(e.id)add('#'+CSS.escape(e.id));for(const attr of ['data-testid','data-test-id','data-test','data-qa','name','aria-label']){const value=e.getAttribute(attr);if(value)add(e.tagName.toLowerCase()+'['+attr+'='+JSON.stringify(value)+']')}add(path(e));return out};
    const probe=(root,px,py,prefix,depth)=>{
      for(const e of root.elementsFromPoint?.(px,py)||[]){
        if(!e||e.nodeType!==1||seen.has(e))continue;seen.add(e);
        if(e.matches('iframe,frame')&&depth<8){
          const r=e.getBoundingClientRect(),sx=r.width/e.offsetWidth,sy=r.height/e.offsetHeight;
          const matrix=new DOMMatrix(e.ownerDocument.defaultView.getComputedStyle(e).transform);
          if(!(sx>0&&sy>0)||Math.abs(matrix.b)>0.00001||Math.abs(matrix.c)>0.00001)throw new Error('Probing rotated or unrendered frames is unavailable');
          const fx=(px-r.x)/sx-e.clientLeft,fy=(py-r.y)/sy-e.clientTop;
          if(fx>=0&&fy>=0&&fx<e.clientWidth&&fy<e.clientHeight){
            let inner;try{inner=e.contentDocument}catch{}
            if(inner){probe(inner,fx,fy,prefix+path(e)+' >>> ',depth+1);continue}
            crossOriginFrame??={ref:markRef(e,${JSON.stringify(prefix)}),point:{x:fx,y:fy},box:box(e)};
          }
        }
        if(e.shadowRoot&&depth<8)probe(e.shadowRoot,px,py,prefix+path(e)+' >>> ',depth+1);
        if(rows.length>=12)return;
        if(!${includeAll}&&!e.matches('a,area,button,input,select,textarea,summary,label,option,img,video,audio,canvas,[role],[onclick],[tabindex],[contenteditable="true"],[data-testid],[data-test-id],[data-test],[data-qa]')&&e.ownerDocument.defaultView.getComputedStyle(e).cursor!=='pointer')continue;
        const selectors=candidates(e,prefix);rows.push({ref:markRef(e,${JSON.stringify(prefix)}),...info(e),box:box(e),inViewport:(()=>{const r=e.getBoundingClientRect(),w=e.ownerDocument.defaultView;return r.right>0&&r.bottom>0&&r.left<w.innerWidth&&r.top<w.innerHeight})(),selector:{primary:selectors[0]??null,candidates:selectors}});
      }
    };
    const outside=${x}<0||${y}<0||${x}>=innerWidth||${y}>=innerHeight;
    if(!outside)probe(document,${x},${y},'',0);
    return {url:location.href,title:document.title,point:{x:${x},y:${y}},elements:rows,count:rows.length,...(outside?{outsideViewport:{width:innerWidth,height:innerHeight}}:{}),...(crossOriginFrame?{crossOriginFrame}:{})};`);
}

/** Match a frame owner by its actual DOM identity, never a URL shared by other frames. */
async function childForOwner(cdp: BrowserCdp, ref: string): Promise<string> {
  const root = cdp.captureScope?.root ?? cdp;
  const resolved = await cdp.command('Runtime.evaluate', { expression: `(()=>{const e=globalThis.__klausBrowserRefs?.[${JSON.stringify(ref)}];return e?.isConnected?e:null})()`, returnByValue: false });
  const objectId = object(resolved.result).objectId;
  if (typeof objectId !== 'string') throw new BrowserError('stale_target', 'The probed frame owner was removed.');
  let backendNodeId;
  try { backendNodeId = object((await cdp.command('DOM.describeNode', { objectId })).node).backendNodeId; }
  finally { await cdp.command('Runtime.releaseObject', { objectId }).catch(() => {}); }
  for (const frameId of root.remoteFrameIds()) {
    try {
      const owner = await cdp.command('DOM.getFrameOwner', { frameId });
      if (backendNodeId !== undefined && owner.backendNodeId === backendNodeId) return frameId;
    } catch { /* A candidate in a different document cannot resolve this owner. */ }
  }
  throw new BrowserError('stale_target', 'The probed frame has no proven live child target in this page.');
}

export async function probePage(cdp: BrowserCdp, fields: BrowserObject, visited = new Set<string>()): Promise<BrowserObject> {
  const x = fields.x, y = fields.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new BrowserError('invalid_request', 'element_info needs finite viewport coordinates x and y, or an element locator.');
  const result = object(await cdp.evaluate(probeScript(x, y, fields.includeNonInteractable === true)));
  const owner = object(result.crossOriginFrame);
  if (typeof owner.ref === 'string') {
    const target = await childForOwner(cdp, owner.ref);
    if (visited.has(target) || visited.size >= 8) throw new BrowserError('stale_target', 'The frame owner chain changed while probing this point.');
    visited.add(target);
    const child = frameCdp(cdp.captureScope?.root ?? cdp, target);
    const found = await probePage(child, { ...fields, ...object(owner.point) }, visited);
    return { ...found, point: { x, y }, framePoint: found.framePoint ?? owner.point!, frameTargetId: found.frameTargetId ?? target };
  }
  if (cdp.captureScope) result.elements = (result.elements as BrowserObject[]).map(row => ({ ...row, frameTargetId: cdp.captureScope!.frame }));
  return result;
}
