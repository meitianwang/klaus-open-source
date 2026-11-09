import { object, type BrowserObject } from './types';

/**
 * Live frame bookkeeping for one page transport.
 *
 * Site isolation groups frames by site, so a cross-origin iframe on the same
 * site as its parent renders inside the parent's process and never appears as
 * an attached child target. Those frames are only reachable through the
 * session that owns their process: the frame tree lists them, their default
 * execution contexts arrive as Runtime events on that session, and commands
 * address them by injecting the recorded context id (or the frame id for
 * frame-scoped CDP methods).
 *
 * This tracker keeps that routing table up to date from protocol events and a
 * one-time frame-tree seed so command routing stays a synchronous decision.
 */

export interface FrameContextRoute {
  /** Session id of the debugger session that owns the context; undefined is the page's main session. */
  session?: string;
  contextId: number;
  origin: string;
}

/**
 * Rewrite params so a frame-addressed call lands in that frame when it shares
 * its owner's session. Evaluation needs the frame's default context; the
 * accessibility tree accepts an explicit frame scope. Every other method
 * either addresses renderer-global handles (backend node ids, object ids) or
 * is tab-scoped (Input), and passes through unchanged.
 */
export function injectFrameRouteParams(method: string, params: BrowserObject, frameId: string, contextId: number): BrowserObject {
  if (method === 'Runtime.evaluate' && params.contextId === undefined && params.uniqueContextId === undefined) return { ...params, contextId };
  if (method === 'Accessibility.getFullAXTree' && params.frameId === undefined) return { ...params, frameId };
  return params;
}

export class FrameRouteTracker {
  readonly contexts = new Map<string, FrameContextRoute>();
  readonly parents = new Map<string, string>();
  rootFrameId = '';

  clear(): void {
    this.contexts.clear();
    this.parents.clear();
    this.rootFrameId = '';
  }

  /** Drop every context routed through a session that just detached. */
  clearSession(session: string): void {
    for (const [frameId, route] of this.contexts) if (route.session === session) this.contexts.delete(frameId);
  }

  /** Record frames from a Page.getFrameTree result; `explicitParent` attaches a subtree root. */
  seedFrameTree(tree: BrowserObject, explicitParent?: string): void {
    const frame = object(tree.frame);
    const frameId = typeof frame.id === 'string' ? frame.id : '';
    if (!frameId) return;
    const parentId = typeof frame.parentId === 'string' && frame.parentId ? frame.parentId : explicitParent;
    if (parentId && parentId !== frameId) this.parents.set(frameId, parentId);
    for (const child of Array.isArray(tree.childFrames) ? tree.childFrames : []) this.seedFrameTree(object(child), frameId);
  }

  /** Consume frame/context lifecycle events from any session of this page. */
  onEvent(method: string, data: BrowserObject, session?: string): void {
    if (method === 'Runtime.executionContextCreated') {
      const context = object(data.context);
      const aux = object(context.auxData);
      const frameId = typeof aux.frameId === 'string' ? aux.frameId : '';
      const contextId = Number(context.id);
      if (!frameId || aux.isDefault !== true || !Number.isSafeInteger(contextId)) return;
      this.contexts.set(frameId, { ...(session ? { session } : {}), contextId, origin: String(context.origin ?? '') });
    } else if (method === 'Runtime.executionContextDestroyed') {
      const contextId = Number(data.contextId);
      for (const [frameId, route] of this.contexts) {
        if (route.contextId === contextId && (session === undefined) === (route.session === undefined)) this.contexts.delete(frameId);
      }
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const [frameId, route] of this.contexts) if ((session === undefined) === (route.session === undefined)) this.contexts.delete(frameId);
    } else if (method === 'Page.frameAttached') {
      const frameId = typeof data.frameId === 'string' ? data.frameId : '';
      const parentFrameId = typeof data.parentFrameId === 'string' ? data.parentFrameId : '';
      if (frameId && parentFrameId) this.parents.set(frameId, parentFrameId);
    } else if (method === 'Page.frameNavigated') {
      const frame = object(data.frame);
      const frameId = typeof frame.id === 'string' ? frame.id : '';
      if (!frameId) return;
      const parentFrameId = typeof frame.parentId === 'string' && frame.parentId ? frame.parentId : undefined;
      if (parentFrameId) this.parents.set(frameId, parentFrameId);
      else if (session === undefined && !this.rootFrameId) this.rootFrameId = frameId;
    } else if (method === 'Page.frameDetached') {
      const frameId = typeof data.frameId === 'string' ? data.frameId : '';
      if (!frameId) return;
      this.parents.delete(frameId);
      this.contexts.delete(frameId);
      for (const [child, parent] of this.parents) if (parent === frameId) this.parents.delete(child);
    }
  }

  /** Origin recorded for a frame's default context, when known. */
  originOf(frameId: string): string | undefined {
    return this.contexts.get(frameId)?.origin;
  }

  /**
   * A frame needs its own addressing when its document world is not reachable
   * from its parent's world: a cross-origin boundary. Same-origin frames (and
   * about:blank frames inheriting their parent's origin) are walked by page
   * scripts through contentDocument, so probing them separately would only
   * duplicate matches.
   */
  isRemoteFrame(frameId: string): boolean {
    const route = this.contexts.get(frameId);
    if (!route) return false;
    const parent = this.parents.get(frameId);
    const parentOrigin = parent === undefined ? this.originOf(this.rootFrameId) : this.originOf(parent);
    if (!route.origin || !parentOrigin) return true;
    return route.origin !== parentOrigin;
  }
}
