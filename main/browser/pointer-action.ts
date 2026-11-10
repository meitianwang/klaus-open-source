import { domScript, elementScript, resolveElement } from './dom';
import { locatorBudget } from './locator-policy';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

export interface PointerTarget { cdp: BrowserCdp; x: number; y: number; guard?: HitGuard; elementCdp?: BrowserCdp }
const ALIGNMENTS = ['center', 'end', 'start'] as const;

/**
 * A dispatch-time hit-target interceptor closes the race between the
 * actionability checks and actual event delivery: a capture-phase listener
 * inspects the first trusted event of the action, and when the coordinates no
 * longer hit the intended element the page never receives the event and the
 * action reports what was in the way instead.
 */
export interface HitGuard {
  /** Remove the interceptor and return 'done' or a description of the node that took the hit. */
  stop(): Promise<string>;
  /** Best-effort removal after a dispatch failure; the verdict is no longer needed. */
  abandon(): void;
}

const HIT_GUARD_EVENTS: Record<'hover' | 'mouse', readonly string[]> = {
  hover: ['mousemove'],
  mouse: ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'auxclick', 'dblclick', 'contextmenu'],
};

/** The resident runtime listens for the union of every guarded mode plus touch events. */
const HIT_GUARD_RUNTIME_EVENTS = [...new Set([...HIT_GUARD_EVENTS.hover, ...HIT_GUARD_EVENTS.mouse, 'touchstart', 'touchend', 'touchcancel'])];

const HIT_GUARD_HELPERS = `
const parentUp = n => n.parentElement ?? (n.parentNode && n.parentNode.nodeType === 11 && n.parentNode.host ? n.parentNode.host : undefined);
const rootOf = n => { let t = n; while (t.parentNode) t = t.parentNode; return t.nodeType === 11 || t.nodeType === 9 ? t : undefined; };
const HIT_BOOLEAN = new Set(['allowfullscreen','async','autofocus','autoplay','checked','controls','default','defer','disabled','formnovalidate','hidden','inert','ismap','itemscope','loop','multiple','muted','nomodule','novalidate','open','playsinline','readonly','required','reversed','selected']);
const HIT_AUTO_CLOSE = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + '\\u2026' : s;
const describeHit = n => {
  if (!n) return 'the document';
  if (n.nodeType === 3) return '#text=' + JSON.stringify(cut(n.nodeValue || '', 50));
  if (n.nodeType !== 1) return '<' + n.nodeName.toLowerCase() + ' />';
  const attrs = [];
  for (let i = 0; i < n.attributes.length; i++) {
    const name = n.attributes[i].name, value = n.attributes[i].value;
    if (name === 'style') continue;
    attrs.push(!value && HIT_BOOLEAN.has(name) ? ' ' + name : ' ' + name + '="' + value + '"');
  }
  attrs.sort((a, b) => a.length - b.length);
  const attrText = cut(attrs.join(''), 500);
  const tag = n.nodeName.toLowerCase();
  if (HIT_AUTO_CLOSE.has(n.nodeName)) return '<' + tag + attrText + '/>';
  const kids = n.childNodes;
  let textOnly = kids.length <= 5;
  for (let i = 0; textOnly && i < kids.length; i++) textOnly = kids[i].nodeType === 3;
  const text = textOnly ? cut(n.textContent || '', 50) : kids.length ? '\\u2026' : '';
  return '<' + tag + attrText + '>' + text + '</' + tag + '>';
};
const expectHitTarget = (point, goal, view) => {
  const chain = [];
  let node = goal;
  for (;;) { const root = rootOf(node); if (!root) break; chain.push(root); if (root.nodeType === 9) break; node = root.host; if (!node) break; }
  let hit;
  for (let level = chain.length - 1; level >= 0; level--) {
    const root = chain[level];
    const all = root.elementsFromPoint(point.x, point.y);
    const top = root.elementFromPoint(point.x, point.y);
    if (top && all[0] && parentUp(top) === all[0]) { const style = view.getComputedStyle(top); if (style && style.display === 'contents') all.unshift(top); }
    if (all[0] && all[0].shadowRoot === root && all[1] === top) all.shift();
    const deepest = all[0];
    if (!deepest) break;
    hit = deepest;
    if (level && deepest !== chain[level - 1].host) break;
  }
  const blockers = [];
  let walk = hit;
  for (; walk && walk !== goal;) { blockers.push(walk); walk = walk.assignedSlot ?? parentUp(walk); }
  if (walk === goal) return 'done';
  const first = describeHit(blockers[0] || document.documentElement);
  let subtree, ancestor = goal;
  for (; ancestor;) { const index = blockers.indexOf(ancestor); if (index !== -1) { if (index > 1) subtree = describeHit(blockers[index - 1]); break; } ancestor = parentUp(ancestor); }
  return subtree ? first + ' from ' + subtree + ' subtree' : first;
};`;

/**
 * Resident per-document hit-guard runtime, injected lazily by the first guard
 * install or synthetic click after each navigation (a navigation wipes it, so
 * every script re-checks and re-injects). It owns one capture-phase listener
 * per guarded event type for the document's lifetime and delegates every
 * trusted event to the currently acquired action target. When the document
 * element is remounted, global listeners can be lost; a probe event verifies
 * they still run and re-registers everything when they do not.
 */
const HIT_GUARD_RUNTIME = `(() => {
  if (globalThis.__klausHitGuardRuntime) return;
  ${HIT_GUARD_HELPERS}
  const EVENTS = ${JSON.stringify(HIT_GUARD_RUNTIME_EVENTS)};
  const PROBE = '__klausHitGuardProbe';
  const runtime = { active: undefined, expectHitTarget, describeHit, parentUp };
  const interceptor = event => {
    const active = runtime.active;
    if (!active || !active.types.has(event.type) || !event.isTrusted) return;
    const at = event.type.startsWith('touch') ? (event.changedTouches && event.changedTouches[0]) || (event.touches && event.touches[0]) : event;
    if (!at) return;
    if (active.verdict === undefined) active.verdict = expectHitTarget({ x: at.clientX, y: at.clientY }, active.target, active.view);
    if (active.verdict !== 'done' && active.verdict !== undefined) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); }
  };
  const registerListeners = () => { for (const type of EVENTS) window.addEventListener(type, interceptor, { capture: true, passive: false }); };
  let sentinel = false;
  const probeListener = () => { sentinel = true; };
  window.addEventListener(PROBE, probeListener);
  registerListeners();
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      let replaced = false;
      for (const node of mutation.addedNodes) if (node === document.documentElement) { replaced = true; break; }
      if (!replaced) continue;
      sentinel = false;
      window.dispatchEvent(new CustomEvent(PROBE));
      if (!sentinel) { window.addEventListener(PROBE, probeListener); registerListeners(); }
      return;
    }
  });
  observer.observe(document, { childList: true });
  globalThis.__klausHitGuardRuntime = runtime;
})()`;

function hitGuardInstallScript(fields: BrowserObject, events: readonly string[]): string {
  return domScript(`
    ${HIT_GUARD_RUNTIME};
    const runtime = globalThis.__klausHitGuardRuntime;
    const e = ${elementScript(fields)};
    let target = e && e.nodeType === 1 ? e : e?.parentElement ?? null;
    if (target && !target.matches('input, textarea, select') && !target.isContentEditable) target = target.closest('button, [role=button], a, [role=link]') || target;
    if (!target || !target.isConnected) return { error: { code: 'not_found', message: 'The matched element was detached.' } };
    const view = target.ownerDocument.defaultView || window;
    // A previous action's acquisition must never leak into this one.
    runtime.active = undefined;
    const types = new Set(${JSON.stringify([...events])});
    // The pre-flight point must be frame-local: getBoundingClientRect lives in
    // the element's own viewport, unlike the mapped dispatch coordinates.
    const rect = target.getBoundingClientRect();
    const early = runtime.expectHitTarget({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, target, view);
    if (early !== 'done') return { intercepted: early };
    runtime.active = { target, types, verdict: undefined, view };
    return { ok: true };
  `);
}

const HIT_GUARD_STOP = `(() => {
  const runtime = globalThis.__klausHitGuardRuntime;
  if (!runtime || !runtime.active) return 'done';
  const verdict = runtime.active.verdict;
  runtime.active = undefined;
  return verdict === undefined ? 'done' : verdict;
})()`;

/**
 * Document-scoped synthetic click: the full pointer/mouse sequence is built
 * and dispatched inside the element's own frame. Every event is preceded by a
 * liveness check (document identity, connection, hit stability and an
 * unobstructed hit path); a prevented pointerdown suppresses the
 * compatibility mouse events, and mousedown walks the focus up from the hit
 * element. Failures return structured errors; the caller never retries them.
 */
export function syntheticClickScript(fields: BrowserObject): string {
  return domScript(`
    ${HIT_GUARD_RUNTIME};
    const runtime = globalThis.__klausHitGuardRuntime;
    const parentUp = runtime.parentUp;
    const left = { error: { code: 'stale_target', message: 'Click target left the selected document.' } };
    const obscured = { error: { code: 'intercepted', message: 'Click target moved or became obscured.' } };
    const e = ${elementScript(fields)};
    if (!e || e.nodeType !== 1 || !e.isConnected) return left;
    const doc = document;
    const rootElement = doc.documentElement;
    const view = doc.defaultView || window;
    const rect = e.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return { error: { code: 'not_visible', message: 'The matched element has no clickable bounding box.' } };
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const o = p => !!p && p.ownerDocument === doc && p.isConnected && p.getRootNode({ composed: true }) === doc;
    const hitAt = () => { let hit = doc.elementFromPoint(x, y); for (;;) { const inner = hit && hit.shadowRoot ? hit.shadowRoot.elementFromPoint(x, y) : null; if (!inner || inner === hit) break; hit = inner; } return hit; };
    const s = hitAt();
    if (!o(e) || !o(s)) return left;
    let failure = null;
    const assertLive = () => {
      if (doc.documentElement !== rootElement || !e.isConnected || !o(e) || !o(s)) { failure = left; throw left.error; }
      if (hitAt() !== s || runtime.expectHitTarget({ x, y }, e, view) !== 'done') { failure = obscured; throw obscured.error; }
    };
    const focusFrom = () => {
      const focusedHere = node => { let at = doc.activeElement; while (at) { if (at === node) return true; at = at.shadowRoot ? at.shadowRoot.activeElement : null; } return false; };
      for (let node = s; node; node = parentUp(node)) {
        if (node.nodeType !== 1) continue;
        const tag = node.nodeName;
        if (tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') continue;
        try { node.focus({ preventScroll: true }); } catch { continue; }
        if (focusedHere(node)) return;
      }
      try { if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur(); } catch { /* nothing focusable to release */ }
    };
    const init = down => ({ bubbles: true, cancelable: true, composed: true, view, clientX: x, clientY: y, button: 0, buttons: down ? 1 : 0, detail: 1, pointerId: -1, pointerType: 'mouse', isPrimary: true });
    let prevented = false;
    try {
      assertLive();
      const pointerDown = new PointerEvent('pointerdown', init(true));
      s.dispatchEvent(pointerDown);
      prevented = pointerDown.defaultPrevented;
      if (!prevented) {
        assertLive();
        s.dispatchEvent(new MouseEvent('mousedown', init(true)));
        focusFrom();
        assertLive();
        s.dispatchEvent(new PointerEvent('pointerup', init(false)));
        assertLive();
        s.dispatchEvent(new MouseEvent('mouseup', init(false)));
      }
      assertLive();
      s.dispatchEvent(new MouseEvent('click', init(false)));
    } catch (problem) {
      if (failure) return failure;
      throw problem;
    }
    return { ok: true };
  `);
}

async function installHitGuard(cdp: BrowserCdp, fields: BrowserObject, mode: 'hover' | 'mouse'): Promise<HitGuard> {
  const installed = object(await cdp.evaluate(hitGuardInstallScript(fields, HIT_GUARD_EVENTS[mode])));
  if (installed.error) { const error = object(installed.error); throw new BrowserError(String(error.code), String(error.message)); }
  if (typeof installed.intercepted === 'string') throw new BrowserError('intercepted', `Pointer events are intercepted by ${installed.intercepted}.`);
  return {
    async stop() {
      try {
        const verdict = await cdp.evaluate(HIT_GUARD_STOP);
        return typeof verdict === 'string' && verdict !== 'done' ? verdict : 'done';
      } catch { return 'done'; }
    },
    abandon() { void cdp.evaluate(HIT_GUARD_STOP).catch(() => {}); },
  };
}

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
    const timer = setTimeout(() => { onTimeout?.(); finish(() => reject(new BrowserError('timeout', `The pointer action exceeded its ${budget} ms deadline.`))); },
      budget === 0 ? 30_000 : Math.max(1, until - Date.now()));
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

/** Verify every owner between a scoped frame and the page, mapping the point to top-level coordinates. */
async function checkFrameOwners(cdp: BrowserCdp, at: BrowserObject, alignment: string, force: boolean, until: number, budget: number, signal?: AbortSignal): Promise<{ x: number; y: number } | undefined> {
  const active = (): void => {
    assertPointerActive(signal);
    if (budget > 0 && Date.now() >= until) throw new BrowserError('timeout', `The pointer action exceeded its ${budget} ms deadline.`);
  };
  const perform = async <T>(work: () => Promise<T>): Promise<T> => { active(); const result = await inBudget(work, until, budget, signal); active(); return result; };
  const root = cdp.captureScope?.root;
  let current: string | undefined = cdp.captureScope?.frame;
  if (!root || !current) return undefined;
  const rootTarget = root.rootFrameId();
  let x = Number(at.x), y = Number(at.y);
  const visited = new Set<string>();
  while (current && current !== rootTarget) {
    active();
    if (visited.has(current) || visited.size >= 8) throw new BrowserError('stale_target', 'The pointer frame owner chain changed.');
    visited.add(current);
    // Both surfaces address an attached frame by its frame id, so no frame-tree
    // round trip is needed to name the frame this hop maps out of.
    const frameId: string = current;
    const size = object(await perform(() => root.evaluate('({width:innerWidth,height:innerHeight})', frameId)));
    const directed = root.frameParent(frameId);
    const candidates: (string | undefined)[] = [];
    if (directed !== undefined && directed !== frameId && !visited.has(directed)) candidates.push(directed === rootTarget ? undefined : directed);
    for (const route of [undefined, ...root.frameTargets().filter(id => !visited.has(id) && id !== directed)]) if (!candidates.some(seen => seen === (route === rootTarget ? undefined : route))) candidates.push(route === rootTarget ? undefined : route);
    let owner: { route: string | undefined; id: number; quad: number[] } | undefined;
    for (const route of candidates) {
      let objectId: string | undefined;
      try {
        const node = await perform(() => root.command('DOM.getFrameOwner', { frameId }, route));
        if (typeof node.backendNodeId !== 'number') continue;
        const resolved = await perform(() => root.command('DOM.resolveNode', { backendNodeId: node.backendNodeId! }, route));
        objectId = object(resolved.object).objectId as string | undefined;
        if (!objectId) continue;
        const scrolled = await perform(() => root.command('Runtime.callFunctionOn', { objectId: objectId!, functionDeclaration: `function(){this.scrollIntoView({block:${JSON.stringify(alignment)},inline:${JSON.stringify(alignment)},behavior:'instant'});const r=this.getBoundingClientRect();return {connected:this.isConnected,x:r.x,y:r.y,width:r.width,height:r.height}}`, returnByValue: true }, route));
        const rect = object(object(scrolled.result).value);
        if (rect.connected !== true) continue;
        const model = object((await perform(() => root.command('DOM.getBoxModel', { backendNodeId: node.backendNodeId! }, route))).model);
        const quad = model.content, border = model.border;
        if (Array.isArray(quad) && quad.length === 8 && quad.every(value => typeof value === 'number' && Number.isFinite(value)) && Array.isArray(border) && border.length === 8) {
          // CDP box models can use enclosing-document coordinates. Normalize the
          // entire quad into this parent's viewport before its location probe.
          const xs = border.filter((_, index) => index % 2 === 0).map(Number), ys = border.filter((_, index) => index % 2 === 1).map(Number);
          const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
          if (!(width > 0 && height > 0 && Number(rect.width) > 0 && Number(rect.height) > 0)) continue;
          const local = quad.map((value, index) => index % 2 === 0 ? Number(rect.x) + (Number(value) - left) * Number(rect.width) / width : Number(rect.y) + (Number(value) - top) * Number(rect.height) / height);
          owner = { route, id: node.backendNodeId, quad: local }; break;
        }
      } catch { active(); /* Only the actual parent document can resolve its frame owner. */ }
      finally { if (objectId) await root.command('Runtime.releaseObject', { objectId }, route).catch(() => {}); }
    }
    if (!owner) throw new BrowserError('stale_target', 'The pointer frame has no live owner in this page.');
    const width = Number(size.width), height = Number(size.height), q = owner.quad;
    if (!(width > 0 && height > 0)) throw new BrowserError('not_visible', 'The pointer frame has no viewport.');
    const u = x / width, v = y / height;
    x = (1-u)*(1-v)*q[0]! + u*(1-v)*q[2]! + u*v*q[4]! + (1-u)*v*q[6]!;
    y = (1-u)*(1-v)*q[1]! + u*(1-v)*q[3]! + u*v*q[5]! + (1-u)*v*q[7]!;
    if (!force) {
      const route = owner.route, ownerId = owner.id;
      const resolved = await perform(() => root.command('DOM.resolveNode', { backendNodeId: ownerId }, route));
      const objectId = object(resolved.object).objectId;
      if (typeof objectId !== 'string') throw new BrowserError('stale_target', 'The pointer frame owner was detached.');
      try {
        const result = await perform(() => root.command('Runtime.callFunctionOn', { objectId, arguments: [{ value: { x, y } }], functionDeclaration: `function(at){const root=this.getRootNode();let hit=(root.elementFromPoint?root:this.ownerDocument).elementFromPoint(at.x,at.y);while(hit?.shadowRoot){const inner=hit.shadowRoot.elementFromPoint(at.x,at.y);if(!inner||inner===hit)break;hit=inner;}return {matched:hit===this||this.contains(hit),description:hit?'<'+hit.tagName.toLowerCase()+(hit.id?'#'+hit.id:'')+'>':'outside the viewport'}}`, returnByValue: true }, route));
        const hit = object(object(result.result).value);
        if (result.exceptionDetails) throw new BrowserError('stale_target', 'The pointer frame owner changed during its hit test.');
        if (hit.matched !== true) throw new BrowserError('intercepted', `${String(hit.description ?? 'Another element')} intercepts pointer events over the frame owner.`);
      } finally { await root.command('Runtime.releaseObject', { objectId }, route).catch(() => {}); }
      // The renderer-side location probe only reads coordinates in the space of
      // the session's own main frame; an in-process parent document keeps the
      // JavaScript hit test above as its interception check.
      const sessionRootSpace = route === undefined || root.frameTargets().includes(route);
      if (sessionRootSpace) {
        let hit: BrowserObject | undefined;
        try { hit = await perform(() => root.command('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true }, route)); }
        catch { active(); /* Some renderer attachments cannot expose a node for this point. */ }
        if (hit && hit.backendNodeId !== owner.id && hit.frameId !== frameId) throw new BrowserError('intercepted', 'Another element intercepts pointer events over the frame owner.');
      }
    }
    current = directed !== undefined && directed !== frameId ? directed : owner.route;
  }
  return { x, y };
}

/**
 * Map a point from an in-process frame's viewport into the page's top-level
 * viewport through the CDP frame-owner chain. A frame that shares the page's
 * process has no input session of its own, so its pointer events dispatch on
 * the page session and must carry top-level coordinates.
 */
export async function framePointToRoot(root: BrowserCdp, frameId: string, x: number, y: number): Promise<{ x: number; y: number }> {
  const rootTarget = root.rootFrameId();
  let current: string | undefined = frameId;
  let px = x, py = y;
  const visited = new Set<string>();
  while (current && current !== rootTarget) {
    if (visited.has(current) || visited.size >= 8) throw new BrowserError('stale_target', 'The pointer frame owner chain changed.');
    visited.add(current);
    const frame: string = current;
    const size = object(await root.evaluate('({width:innerWidth,height:innerHeight})', frame));
    const directed = root.frameParent(frame);
    const candidates: (string | undefined)[] = [];
    if (directed !== undefined && directed !== frame && !visited.has(directed)) candidates.push(directed === rootTarget ? undefined : directed);
    candidates.push(undefined);
    let quad: number[] | undefined;
    for (const route of candidates) {
      let objectId: string | undefined;
      try {
        const node = await root.command('DOM.getFrameOwner', { frameId: frame }, route);
        if (typeof node.backendNodeId !== 'number') continue;
        const resolved = await root.command('DOM.resolveNode', { backendNodeId: node.backendNodeId! }, route);
        objectId = object(resolved.object).objectId as string | undefined;
        if (!objectId) continue;
        const rectResult = await root.command('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){const r=this.getBoundingClientRect();return {connected:this.isConnected,x:r.x,y:r.y,width:r.width,height:r.height}}', returnByValue: true }, route);
        const rect = object(object(rectResult.result).value);
        if (rectResult.exceptionDetails || rect.connected !== true) continue;
        const model = object((await root.command('DOM.getBoxModel', { backendNodeId: node.backendNodeId! }, route)).model);
        const content = model.content, border = model.border;
        if (!Array.isArray(content) || content.length !== 8 || !Array.isArray(border) || border.length !== 8) continue;
        const xs = border.filter((_, index) => index % 2 === 0).map(Number), ys = border.filter((_, index) => index % 2 === 1).map(Number);
        const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
        if (!(width > 0 && height > 0 && Number(rect.width) > 0 && Number(rect.height) > 0)) continue;
        quad = content.map((value, index) => index % 2 === 0 ? Number(rect.x) + (Number(value) - left) * Number(rect.width) / width : Number(rect.y) + (Number(value) - top) * Number(rect.height) / height);
        break;
      } catch { /* Only the actual parent document can resolve its frame owner. */ }
      finally { if (objectId) await root.command('Runtime.releaseObject', { objectId }, route).catch(() => {}); }
    }
    if (!quad) throw new BrowserError('stale_target', 'The pointer frame has no live owner in this page.');
    const width = Number(size.width), height = Number(size.height);
    if (!(width > 0 && height > 0)) throw new BrowserError('not_visible', 'The pointer frame has no viewport.');
    const u = px / width, v = py / height;
    px = (1-u)*(1-v)*quad[0]! + u*(1-v)*quad[2]! + u*v*quad[4]! + (1-u)*v*quad[6]!;
    py = (1-u)*(1-v)*quad[1]! + u*(1-v)*quad[3]! + u*v*quad[5]! + (1-u)*v*quad[7]!;
    current = directed !== undefined && directed !== frame ? directed : undefined;
  }
  return { x: px, y: py };
}

/**
 * The input surface for a scoped frame. A cross-process frame keeps its own
 * session and local coordinates; a frame inside the page's process dispatches
 * on the page session through a top-level coordinate mapping.
 */
export function frameDispatch(cdp: BrowserCdp): { cdp: BrowserCdp; map?: (x: number, y: number) => Promise<{ x: number; y: number }> } {
  const root = cdp.captureScope?.root;
  const frame = cdp.captureScope?.frame;
  if (!root || !frame || root.frameTargets().includes(frame)) return { cdp };
  return { cdp: root, map: (x, y) => framePointToRoot(root, frame, x, y) };
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
    // Zero performs one probe without retrying a failed condition. Remote
    // execution still needs a bounded response window to return diagnostics.
    if (expired || budget > 0 && Date.now() >= until) throw new BrowserError('timeout', `The pointer action exceeded its ${budget} ms deadline.`);
  };
  let last: unknown;
  for (;;) {
    for (const alignment of fields.force === true ? ['center'] : ALIGNMENTS) {
      try {
        active();
        const resolved = await inBudget(() => resolveElement(source, { ...fields, state: 'attached', visible: false, enabled: false, timeoutMs: 0 }, frame, true, active), until, budget, signal, expire);
        active();
        const result = object(await inBudget(() => resolved.cdp.evaluate(preparation(resolved.fields, alignment, fields.force === true)), until, budget, signal, expire));
        active();
        if (result.error) { const error = object(result.error); throw new BrowserError(String(error.code), String(error.message)); }
        const mapped = await inBudget(() => checkFrameOwners(resolved.cdp, result, alignment, fields.force === true, until, budget, signal), until, budget, signal, expire);
        active();
        // The dispatch-time interceptor closes the race between these checks
        // and event delivery. It lives in the element's own frame and inspects
        // the first trusted event; forced actions skip actionability entirely,
        // and a synthetic dispatch re-validates its target before every event.
        const guard = fields.force === true || fields.dispatch === 'synthetic' ? undefined : await inBudget(
          () => installHitGuard(resolved.cdp, resolved.fields, fields.moveOnly === true ? 'hover' : 'mouse'),
          until, budget, signal, expire);
        active();
        // A frame inside the page's process has no input session of its own:
        // its pointer events dispatch on the page session in top-level
        // coordinates. A cross-process frame keeps its session-local point.
        const scope = resolved.cdp.captureScope;
        if (mapped && scope && !scope.root.frameTargets().includes(scope.frame)) return { cdp: scope.root, x: mapped.x, y: mapped.y, guard, elementCdp: resolved.cdp };
        return { cdp: resolved.cdp, x: Number(result.x), y: Number(result.y), guard, elementCdp: resolved.cdp };
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
