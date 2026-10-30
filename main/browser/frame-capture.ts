import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

/** Lift a child document's crop into the same tab's top-level document space. */
export async function frameCaptureRect(root: BrowserCdp, frame: string, input: BrowserObject): Promise<BrowserObject> {
  let clip = { ...input }; let current: string | undefined = frame;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current) || visited.size >= 8 || !root.frameTargets().includes(current)) throw new BrowserError('stale_target', 'The screenshot frame is no longer attached to this page.');
    visited.add(current);
    const tree = object((await root.command('Page.getFrameTree', {}, current)).frameTree);
    const frameId = object(tree.frame).id;
    const scroll = object(await root.evaluate('({x:scrollX,y:scrollY})', current));
    let owner: { frame?: string; box: BrowserObject } | undefined;
    for (const parent of [undefined, ...root.frameTargets().filter(id => !visited.has(id))]) {
      let objectId: string | undefined;
      try {
        const node = await root.command('DOM.getFrameOwner', { frameId: frameId! }, parent);
        const resolved = await root.command('DOM.resolveNode', { backendNodeId: node.backendNodeId! }, parent);
        objectId = object(resolved.object).objectId as string | undefined;
        if (!objectId) continue;
        const result = await root.command('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: `function(){const r=this.getBoundingClientRect();const scaleX=r.width/this.offsetWidth,scaleY=r.height/this.offsetHeight;const matrix=new DOMMatrix(getComputedStyle(this).transform);return {x:r.x+this.clientLeft*scaleX,y:r.y+this.clientTop*scaleY,width:this.clientWidth*scaleX,height:this.clientHeight*scaleY,scaleX,scaleY,sx:scrollX,sy:scrollY,rotated:Math.abs(matrix.b)>0.00001||Math.abs(matrix.c)>0.00001}}` }, parent);
        const box = object(object(result.result).value);
        if (!result.exceptionDetails && typeof box.x === 'number') { owner = { frame: parent, box }; break; }
      } catch { /* Only the parent renderer can resolve this frame owner. */ }
      finally { if (objectId) await root.command('Runtime.releaseObject', { objectId }, parent).catch(() => {}); }
    }
    if (!owner) throw new BrowserError('stale_target', 'The screenshot frame has no live owner in this tab.');
    const box = owner.box;
    if (box.rotated) throw new BrowserError('unavailable', 'Screenshots of rotated cross-process frame elements are not available.');
    const sx = Number(box.scaleX), sy = Number(box.scaleY);
    if (![sx, sy].every(value => Number.isFinite(value) && value > 0)) throw new BrowserError('not_visible', 'The screenshot frame has no rendered dimensions.');
    const askedLeft = Number(clip.x) - Number(scroll.x), askedTop = Number(clip.y) - Number(scroll.y);
    const left = Math.max(0, askedLeft), top = Math.max(0, askedTop);
    const width = Math.min(askedLeft + Number(clip.width), Number(box.width) / sx) - left;
    const height = Math.min(askedTop + Number(clip.height), Number(box.height) / sy) - top;
    if (width <= 0 || height <= 0) throw new BrowserError('not_visible', 'The screenshot region is outside its frame viewport.');
    clip = { ...clip, x: Number(box.x) + left * sx + Number(box.sx), y: Number(box.y) + top * sy + Number(box.sy), width: width * sx, height: height * sy };
    current = owner.frame;
  }
  return clip;
}
