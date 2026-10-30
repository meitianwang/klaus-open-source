import { domScript, elementScript, resolveElement } from './dom';
import { locatorBudget } from './locator-policy';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

interface PointerTarget { cdp: BrowserCdp; x: number; y: number }
const ALIGNMENTS = ['center', 'end', 'start'] as const;

export function assertPointerActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserError('cancelled', 'The browser pointer action was cancelled.');
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  assertPointerActive(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new BrowserError('cancelled', 'The browser pointer action was cancelled.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function inBudget<T>(work: () => Promise<T>, until: number, budget: number, signal?: AbortSignal, onTimeout?: () => void): Promise<T> {
  assertPointerActive(signal);
  if (budget > 0 && Date.now() >= until) {
    onTimeout?.();
    throw new BrowserError('timeout', `The pointer action exceeded its ${budget} ms deadline.`);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => finish(() => reject(new BrowserError('cancelled', 'The browser pointer action was cancelled.')));
    const finish = (settle: () => void): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); settle(); };
    const timer = setTimeout(() => { onTimeout?.(); finish(() => reject(new BrowserError('timeout', `The pointer action exceeded its ${budget} ms deadline.`))); }, Math.max(1, until - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { work().then(value => finish(() => resolve(value)), error => finish(() => reject(error))); }
    catch (error) { finish(() => reject(error)); }
  });
}

function preparation(fields: BrowserObject, alignment: string, force: boolean): string {
  // Keep the live node only for this attempt. A detached or replaced node causes
  // the caller to resolve the original locator again on the next attempt.
  return domScript(`return (async()=>{
    const e=${elementScript(fields)};
    const fail=(code,message)=>({error:{code,message}});
    const connected=()=>!!e?.isConnected;
    if(!connected())return fail('not_found','The matched element was detached.');
    const state=()=>!connected()?fail('not_found','The matched element was detached.'):
      !${force}&&!visible(e)?fail('not_visible','The matched element is not visible.'):
      !${force}&&!enabled(e)?fail('not_enabled','The matched element is disabled.'):null;
    let problem=state();if(problem)return problem;
    const align=${JSON.stringify(alignment)};
    e.scrollIntoView({block:align,inline:align,behavior:'instant'});
    const nextFrame=()=>new Promise(resolve=>{const w=e.ownerDocument.defaultView;let settled=false;const done=()=>{if(settled)return;settled=true;w.clearTimeout(timer);if(frame!==undefined)w.cancelAnimationFrame(frame);resolve()};let frame;const timer=w.setTimeout(done,50);frame=w.requestAnimationFrame(done)});
    const same=(a,b)=>a.left===b.left&&a.top===b.top&&a.width===b.width&&a.height===b.height;
    let rect=e.getBoundingClientRect(),stable=0;
    for(let i=0;i<10&&stable<2;i++){await nextFrame();if(!connected())return fail('not_found','The matched element was detached.');const next=e.getBoundingClientRect();stable=same(rect,next)?stable+1:0;rect=next;}
    problem=state();if(problem)return problem;
    if(!${force}&&stable<2)return fail('not_stable','The matched element is still moving.');
    if(rect.width<=0||rect.height<=0)return fail('not_visible','The matched element has no clickable bounding box.');
    let x=rect.left+rect.width/2,y=rect.top+rect.height/2,node=e,view=e.ownerDocument.defaultView;
    const contains=(owner,hit)=>{for(let at=hit;at;at=at.parentNode||at.host)if(at===owner)return true;return false};
    for(let depth=0;depth<9;depth++){
      if(!${force}){
        if(x<0||y<0||x>=view.innerWidth||y>=view.innerHeight)return fail('not_visible','The matched element could not be scrolled into the viewport.');
        const root=node.getRootNode();let hit=(root.elementFromPoint?root:node.ownerDocument).elementFromPoint(x,y);
        while(hit?.shadowRoot){const inner=hit.shadowRoot.elementFromPoint(x,y);if(!inner||inner===hit)break;hit=inner;}
        if(!contains(node,hit))return fail('intercepted','Pointer events are intercepted by '+(hit?'<'+hit.tagName.toLowerCase()+(hit.id?'#'+hit.id:'')+'>':'another element')+'.');
      }
      if(view===window)return {x,y};
      const owner=view.frameElement;if(!owner)return fail('stale_target','The matched element frame was detached.');
      owner.scrollIntoView({block:align,inline:align,behavior:'instant'});
      const r=owner.getBoundingClientRect(),matrix=new DOMMatrix(view.parent.getComputedStyle(owner).transform);
      const corners=[[0,0],[owner.offsetWidth,0],[owner.offsetWidth,owner.offsetHeight],[0,owner.offsetHeight]].map(([x,y])=>new DOMPoint(x,y).matrixTransform(matrix));
      const left=Math.min(...corners.map(p=>p.x)),top=Math.min(...corners.map(p=>p.y));
      const sx=r.width/(Math.max(...corners.map(p=>p.x))-left),sy=r.height/(Math.max(...corners.map(p=>p.y))-top);
      if(!(sx>0&&sy>0))return fail('not_visible','The frame owner has no rendered dimensions.');
      const mapped=new DOMPoint(owner.clientLeft+x,owner.clientTop+y).matrixTransform(matrix);
      x=r.left+(mapped.x-left)*sx;y=r.top+(mapped.y-top)*sy;node=owner;view=owner.ownerDocument.defaultView;
    }
    return fail('stale_target','The matched element frame chain exceeds eight levels.');
  })();`);
}

/** Verify every cross-process owner in the page before dispatching local input. */
async function checkFrameOwners(cdp: BrowserCdp, at: BrowserObject, alignment: string, force: boolean, until: number, budget: number, signal?: AbortSignal): Promise<void> {
  const active = (): void => {
    assertPointerActive(signal);
    if (Date.now() >= until) throw new BrowserError('timeout', `The pointer action exceeded its ${budget} ms deadline.`);
  };
  const perform = async <T>(work: () => Promise<T>): Promise<T> => { active(); const result = await inBudget(work, until, budget, signal); active(); return result; };
  const root = cdp.captureScope?.root;
  let current = cdp.captureScope?.frame;
  if (!root || !current) return;
  let x = Number(at.x), y = Number(at.y);
  const visited = new Set<string>();
  while (current) {
    active();
    if (visited.has(current) || visited.size >= 8) throw new BrowserError('stale_target', 'The pointer frame owner chain changed.');
    visited.add(current);
    const frame = current;
    const tree = object((await perform(() => root.command('Page.getFrameTree', {}, frame))).frameTree);
    const frameId = object(tree.frame).id;
    const size = object(await perform(() => root.evaluate('({width:innerWidth,height:innerHeight})', frame)));
    let owner: { parent?: string; id: number; quad: number[] } | undefined;
    for (const parent of [undefined, ...root.frameTargets().filter(id => !visited.has(id))]) {
      let objectId: string | undefined;
      try {
        const node = await perform(() => root.command('DOM.getFrameOwner', { frameId: frameId! }, parent));
        if (typeof node.backendNodeId !== 'number') continue;
        const resolved = await perform(() => root.command('DOM.resolveNode', { backendNodeId: node.backendNodeId! }, parent));
        objectId = object(resolved.object).objectId as string | undefined;
        if (!objectId) continue;
        const scrolled = await perform(() => root.command('Runtime.callFunctionOn', { objectId: objectId!, functionDeclaration: `function(){this.scrollIntoView({block:${JSON.stringify(alignment)},inline:${JSON.stringify(alignment)},behavior:'instant'});const r=this.getBoundingClientRect();return {connected:this.isConnected,x:r.x,y:r.y,width:r.width,height:r.height}}`, returnByValue: true }, parent));
        const rect = object(object(scrolled.result).value);
        if (rect.connected !== true) continue;
        const model = object((await perform(() => root.command('DOM.getBoxModel', { backendNodeId: node.backendNodeId! }, parent))).model);
        const quad = model.content, border = model.border;
        if (Array.isArray(quad) && quad.length === 8 && quad.every(value => typeof value === 'number' && Number.isFinite(value)) && Array.isArray(border) && border.length === 8) {
          // CDP box models can use enclosing-document coordinates. Normalize the
          // entire quad into this parent's viewport before its location probe.
          const xs = border.filter((_, index) => index % 2 === 0).map(Number), ys = border.filter((_, index) => index % 2 === 1).map(Number);
          const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
          if (!(width > 0 && height > 0 && Number(rect.width) > 0 && Number(rect.height) > 0)) continue;
          const local = quad.map((value, index) => index % 2 === 0 ? Number(rect.x) + (Number(value) - left) * Number(rect.width) / width : Number(rect.y) + (Number(value) - top) * Number(rect.height) / height);
          owner = { parent, id: node.backendNodeId, quad: local }; break;
        }
      } catch { active(); /* Only the actual parent document can resolve its frame owner. */ }
      finally { if (objectId) await root.command('Runtime.releaseObject', { objectId }, parent).catch(() => {}); }
    }
    if (!owner) throw new BrowserError('stale_target', 'The pointer frame has no live owner in this page.');
    const width = Number(size.width), height = Number(size.height), q = owner.quad;
    if (!(width > 0 && height > 0)) throw new BrowserError('not_visible', 'The pointer frame has no viewport.');
    const u = x / width, v = y / height;
    x = (1-u)*(1-v)*q[0]! + u*(1-v)*q[2]! + u*v*q[4]! + (1-u)*v*q[6]!;
    y = (1-u)*(1-v)*q[1]! + u*(1-v)*q[3]! + u*v*q[5]! + (1-u)*v*q[7]!;
    if (!force) {
      const parent = owner.parent, ownerId = owner.id;
      const resolved = await perform(() => root.command('DOM.resolveNode', { backendNodeId: ownerId }, parent));
      const objectId = object(resolved.object).objectId;
      if (typeof objectId !== 'string') throw new BrowserError('stale_target', 'The pointer frame owner was detached.');
      try {
        const result = await perform(() => root.command('Runtime.callFunctionOn', { objectId, arguments: [{ value: { x, y } }], functionDeclaration: `function(at){const root=this.getRootNode();let hit=(root.elementFromPoint?root:this.ownerDocument).elementFromPoint(at.x,at.y);while(hit?.shadowRoot){const inner=hit.shadowRoot.elementFromPoint(at.x,at.y);if(!inner||inner===hit)break;hit=inner;}return {matched:hit===this||this.contains(hit),description:hit?'<'+hit.tagName.toLowerCase()+(hit.id?'#'+hit.id:'')+'>':'outside the viewport'}}`, returnByValue: true }, parent));
        const hit = object(object(result.result).value);
        if (result.exceptionDetails) throw new BrowserError('stale_target', 'The pointer frame owner changed during its hit test.');
        if (hit.matched !== true) throw new BrowserError('intercepted', `${String(hit.description ?? 'Another element')} intercepts pointer events over the frame owner.`);
      } finally { await root.command('Runtime.releaseObject', { objectId }, parent).catch(() => {}); }
      let hit: BrowserObject | undefined;
      try { hit = await perform(() => root.command('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true }, parent)); }
      catch { active(); /* Some renderer attachments cannot expose a node for this point. */ }
      if (hit && hit.backendNodeId !== owner.id && hit.frameId !== frameId) throw new BrowserError('intercepted', 'Another element intercepts pointer events over the frame owner.');
    }
    current = owner.parent;
  }
}

const RETRYABLE = new Set(['not_found', 'not_visible', 'not_enabled', 'not_stable', 'intercepted', 'stale_target']);

/** Resolve, scroll, stabilize and hit-test under one deadline for each action. */
export async function pointerTarget(root: BrowserCdp, fields: BrowserObject, signal?: AbortSignal): Promise<PointerTarget> {
  const budget = locatorBudget(fields.timeoutMs, 3000, 60000, 'Pointer timeoutMs');
  const until = Date.now() + budget;
  const frame = root.captureScope?.frame;
  const source = root.captureScope?.root ?? root;
  let expired = false;
  const expire = (): void => { expired = true; };
  const active = (): void => {
    assertPointerActive(signal);
    // Zero retains its single immediate probe. Its timer still retires any
    // outstanding recursive search before a late reply can continue it.
    if (expired || budget > 0 && Date.now() >= until) throw new BrowserError('timeout', `The pointer action exceeded its ${budget} ms deadline.`);
  };
  let last: unknown;
  for (;;) {
    for (const alignment of fields.force === true ? ['center'] : ALIGNMENTS) {
      active();
      try {
        const resolved = await inBudget(() => resolveElement(source, { ...fields, state: 'attached', visible: false, enabled: false, timeoutMs: 0 }, frame, true, active), until, budget, signal, expire);
        active();
        const result = object(await inBudget(() => resolved.cdp.evaluate(preparation(resolved.fields, alignment, fields.force === true)), until, budget, signal, expire));
        active();
        if (result.error) { const error = object(result.error); throw new BrowserError(String(error.code), String(error.message)); }
        await inBudget(() => checkFrameOwners(resolved.cdp, result, alignment, fields.force === true, until, budget, signal), until, budget, signal, expire);
        active();
        return { cdp: resolved.cdp, x: Number(result.x), y: Number(result.y) };
      } catch (error) {
        if (error instanceof BrowserError && error.code === 'timeout' && last instanceof Error) throw new BrowserError('timeout', `${error.message} Last actionability check: ${last.message}`);
        const transientContext = error instanceof BrowserError && ['cdp_error', 'evaluation_error'].includes(error.code) && /context.*destroyed|cannot find context|not connected/iu.test(error.message);
        if (!(error instanceof BrowserError) || !RETRYABLE.has(error.code) && !transientContext) throw error;
        last = error;
      }
      if (Date.now() >= until) break;
    }
    if (Date.now() >= until) throw new BrowserError('timeout', `The pointer action did not become actionable within ${budget} ms: ${last instanceof Error ? last.message : String(last)}`);
    await pause(Math.min(100, Math.max(1, until - Date.now())), signal);
  }
}
