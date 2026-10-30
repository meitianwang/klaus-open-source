import { performance } from 'node:perf_hooks';
import type { PipPort, PipPortCallbacks } from '../native/pip';

export const PIP_PREFERENCES_KEY = 'computer_use.pip.preferences';
export const PIP_PUSH_CHANNEL = 'computer-use-pip:state';
type ObjectValue = Record<string, unknown>;
type Visibility = 'shown' | 'hidden';
interface Preferences {
  alwaysHidePictureInPicture: boolean; taskVisibilities: Record<string, Visibility>; maxDisplaySize: number; anchor?: string;
}
interface Turn { id: string; epoch: number; ended: boolean; computerActive: boolean; browserActive: Set<string> }
interface Presentation { session: string; epoch: number; revision: number; browser?: string; target: ObjectValue; command: ObjectValue }
export interface PipState extends Preferences {
  supported: boolean; revision: number; activeTaskIds: string[]; zoomFactor: number; error: string | null; errorSessionId: string | null;
}
export interface PipOwner { id: number; handle: Buffer }
export interface PipDependencies {
  /** Availability includes the unpacked producer and same-process native capability. */
  availability(): { supported: boolean; error?: string };
  createNative(owner: PipOwner, callbacks: PipPortCallbacks): PipPort;
  readPreferences(): string | null;
  /** Synchronous settings transaction: throw on failure; never return an error as a value. */
  writePreferences(raw: string): void;
  language(): string;
  deliver(ownerId: number, channel: typeof PIP_PUSH_CHANNEL, state: PipState, signal: AbortSignal): Promise<void>;
  focusBrowser(target: ObjectValue, signal: AbortSignal): Promise<void>;
}

const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === 'string' && value.length <= 4096 ? value : '';
const id = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const anchors = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const size = (value: unknown): number => finite(value) ? Math.max(100, Math.min(400, value)) : 200;

function preferences(raw: string | null): Preferences {
  const defaults: Preferences = { alwaysHidePictureInPicture: false, taskVisibilities: {}, maxDisplaySize: 200 };
  if (!raw) return defaults;
  const value = object(JSON.parse(raw));
  for (const [key, visibility] of Object.entries(object(value.taskVisibilities))) {
    if (key && (visibility === 'shown' || visibility === 'hidden')) Object.defineProperty(defaults.taskVisibilities, key, { value: visibility, writable: true, configurable: true, enumerable: true });
  }
  defaults.alwaysHidePictureInPicture = value.alwaysHidePictureInPicture === true;
  defaults.maxDisplaySize = size(value.maxDisplaySize);
  if (anchors.has(text(value.anchor))) defaults.anchor = text(value.anchor);
  return defaults;
}

/** Validate layout data even when its registered window is not the active native host. */
export function normalizePipHostLayout(payload: unknown): ObjectValue {
  const value = object(payload);
  if (value.hostId !== 'klaus-main-thread' || value.presentationScope !== 'thread') throw new Error('Unknown Picture-in-Picture host or scope');
  if (value.sessionId !== null && !text(value.sessionId)) throw new Error('Invalid Picture-in-Picture layout session');
  const rect = (input: unknown): ObjectValue | null => {
    if (input === null || input === undefined) return null;
    const item = object(input);
    if (!['x', 'y', 'width', 'height'].every(key => finite(item[key])) || Number(item.width) < 0 || Number(item.height) < 0) throw new Error('Invalid Picture-in-Picture rectangle');
    return { x: item.x, y: item.y, width: item.width, height: item.height };
  };
  for (const key of ['visible', 'animated', 'isCodexHomeAvailable']) if (typeof value[key] !== 'boolean') throw new Error('Invalid Picture-in-Picture layout flag');
  if (!finite(value.devicePixelRatio) || value.devicePixelRatio <= 0 || value.devicePixelRatio > 16) throw new Error('Invalid Picture-in-Picture pixel ratio');
  const points = value.anchors == null ? null : (() => {
    if (!Array.isArray(value.anchors) || value.anchors.length > 4) throw new Error('Invalid Picture-in-Picture anchors');
    return value.anchors.map(raw => {
      const anchor = object(raw), point = object(anchor.point);
      if (!anchors.has(text(anchor.alignment)) || !finite(point.x) || !finite(point.y)) throw new Error('Invalid Picture-in-Picture anchor');
      return { alignment: anchor.alignment, point: { x: point.x, y: point.y } };
    });
  })();
  const rectangles = value.anchorRects == null ? null : Object.fromEntries(['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map(key => [key, rect(object(value.anchorRects)[key])]));
  // Build an allowlist. Renderer JSON can never turn a layout into capture, execution or shutdown.
  return { type: 'layout', hostId: 'klaus-main-thread', sessionId: value.sessionId, presentationScope: 'thread',
    visible: value.visible, animated: value.animated, isCodexHomeAvailable: value.isCodexHomeAvailable,
    devicePixelRatio: value.devicePixelRatio, anchorRect: rect(value.anchorRect), containerRect: rect(value.containerRect),
    anchors: points, anchorRects: rectangles, interactionPassthroughRect: null };
}

/** TS owns all session, turn, visibility, browser routing and persistence decisions. */
export class PipService {
  private preferences: Preferences = preferences(null);
  private readonly turns = new Map<string, Turn>();
  private readonly presentations = new Map<string, Presentation>();
  private readonly calls = new Map<string, number>();
  private nativeActive = new Set<string>();
  private contentRevision = 0;
  private revision = 0;
  private zoomFactor = 1;
  private error: string | null = null;
  private errorSession: string | null = null;
  private owner?: { id: number; generation: number; port?: PipPort; closing: boolean };
  private ownerGeneration = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private snapshotPending?: PipState;
  private pushing = false;
  private closed = false;
  private availability: { supported: boolean; error?: string };
  constructor(private readonly deps: PipDependencies) {
    try { this.availability = deps.availability(); } catch (error) { this.availability = { supported: false, error: String(error) }; }
    try { this.preferences = preferences(deps.readPreferences()); } catch (error) { this.error = `Could not read Picture-in-Picture preferences: ${String(error)}`; }
    if (!this.availability.supported && this.availability.error) this.error = this.availability.error;
  }
  snapshot(): PipState {
    return { ...structuredClone(this.preferences), supported: this.availability.supported, revision: this.revision,
      activeTaskIds: this.activeTasks(), zoomFactor: this.zoomFactor, error: this.error, errorSessionId: this.errorSession };
  }
  private activeTasks(): string[] {
    return [...new Set([...this.turns].filter(([, turn]) => !turn.ended && (turn.computerActive || turn.browserActive.size))
      .map(([session]) => session).concat([...this.nativeActive]))].sort();
  }
  attachOwner(owner: PipOwner): void {
    if (this.closed) throw new Error('Picture-in-Picture service is closed');
    if (this.owner) throw new Error('The previous Picture-in-Picture owner must finish detaching');
    if (!integer(owner.id)) throw new Error('Invalid Picture-in-Picture owner');
    const state = { id: owner.id, generation: ++this.ownerGeneration, closing: false } as NonNullable<PipService['owner']>;
    this.owner = state;
    try {
      if (this.availability.supported) state.port = this.deps.createNative(owner, {
        onEvent: event => { if (this.owner === state && !state.closing) this.nativeEvent(event); },
        onError: error => { if (this.owner === state && !state.closing) this.setError(error.message); },
      });
      this.publish();
      for (const presentation of this.presentations.values()) if (this.accepts(presentation.session, presentation.epoch)) this.command(presentation.command);
    } catch (error) { this.owner = undefined; throw error; }
  }
  private assertOwner(ownerId: number): void {
    if (this.closed || !this.owner || this.owner.id !== ownerId || this.owner.closing) throw new Error('Picture-in-Picture owner is unavailable');
  }
  getState(ownerId: number): PipState { this.assertOwner(ownerId); return this.snapshot(); }
  setVisibility(ownerId: number, value: unknown): PipState {
    this.assertOwner(ownerId); this.changeVisibility(object(value)); return this.snapshot();
  }
  private changeVisibility(value: ObjectValue): void {
    const session = text(value.sessionId), scope = value.scope, visible = value.visible;
    if (typeof visible !== 'boolean' || !['task', 'all'].includes(String(scope)) || (scope === 'all' && visible) || (scope === 'task' && !session)) {
      throw new Error('Choose a task, or hide all active tasks; visible must be a boolean');
    }
    this.persist(next => {
      if (scope === 'all') {
        next.alwaysHidePictureInPicture = true;
        for (const own of new Set([...this.activeTasks(), ...(session ? [session] : [])])) {
          Object.defineProperty(next.taskVisibilities, own, { value: 'hidden', enumerable: true, configurable: true, writable: true });
        }
      } else {
        if (visible) next.alwaysHidePictureInPicture = false;
        Object.defineProperty(next.taskVisibilities, session, { value: visible ? 'shown' : 'hidden', enumerable: true, configurable: true, writable: true });
      }
    });
  }
  private persist(mutate: (next: Preferences) => void): void {
    const next = structuredClone(this.preferences); mutate(next);
    this.deps.writePreferences(JSON.stringify(next));
    this.preferences = next; this.revision++; this.publish();
  }
  private rememberVisibility(session: string): void {
    if (Object.hasOwn(this.preferences.taskVisibilities, session)) return;
    const visibility = this.preferences.alwaysHidePictureInPicture ? 'hidden' : 'shown';
    Object.defineProperty(this.preferences.taskVisibilities, session, { value: visibility, enumerable: true, configurable: true, writable: true });
  }
  setHostLayout(ownerId: number, payload: unknown): { ok: true } {
    this.assertOwner(ownerId);
    this.command(normalizePipHostLayout(payload));
    return { ok: true };
  }
  zoomChanged(factor: number): void {
    if (!finite(factor) || factor <= 0 || factor > 16 || this.zoomFactor === factor) return;
    this.zoomFactor = factor; this.revision++; this.publish();
  }
  private turn(session: string): Turn {
    if (!text(session)) throw new Error('Picture-in-Picture requires a session ID');
    let turn = this.turns.get(session);
    if (!turn) {
      if (this.turns.size >= 4096) throw new Error('Picture-in-Picture session capacity exceeded');
      turn = { id: '', epoch: 0, ended: false, computerActive: false, browserActive: new Set() }; this.turns.set(session, turn);
    }
    return turn;
  }
  /** Capture this lease before a permission prompt or browser operation. */
  beginOperation(session: string): number { return this.turn(session).epoch; }
  private accepts(session: string, epoch: number): boolean {
    const turn = this.turns.get(session); return !!turn && !turn.ended && turn.epoch === epoch && !this.closed;
  }
  private removePresentations(predicate: (value: Presentation) => boolean): string[] {
    const ids = [...this.presentations].filter(([, value]) => predicate(value)).map(([key]) => key);
    for (const key of ids) this.presentations.delete(key);
    return ids;
  }
  private endTurn(session: string, turnId: string, completed: boolean): void {
    const turn = this.turn(session);
    if (turn.ended || (turnId && turn.id && turnId !== turn.id)) return;
    const epoch = turn.epoch;
    turn.ended = true; turn.epoch++; turn.computerActive = false; turn.browserActive.clear(); this.nativeActive.delete(session);
    for (const key of this.calls.keys()) if (JSON.parse(key)[0] === session) this.calls.delete(key);
    const browserIds = [...this.presentations].filter(([, value]) => value.session === session && value.browser).map(([key]) => key);
    this.removePresentations(value => value.session === session);
    this.command({ type: 'remove', presentationIds: browserIds, sessionId: session, throughEpoch: epoch });
    this.command(completed ? { type: 'endSession', sessionId: session, throughEpoch: epoch }
      : { type: 'remove', allForSession: true, sessionId: session, throughEpoch: epoch });
  }
  observe(events: readonly unknown[]): void {
    if (this.closed) return;
    let changed = false;
    for (const raw of events) {
      const event = object(raw), session = text(event.sessionId); if (!session) continue;
      const turn = this.turn(session);
      if (event.type === 'stream_mode' && event.mode === 'requesting') {
        const turnId = text(event.turnId);
        if (turn.ended || (turnId && turn.id !== turnId)) {
          if (!turn.ended) this.endTurn(session, '', false);
          turn.epoch++; turn.computerActive = false; turn.browserActive.clear();
        }
        if (turnId) turn.id = turnId; turn.ended = false;
        changed = true;
      } else if (event.type === 'tool_start') {
        if (turn.ended) continue;
        const call = text(event.toolCallId);
        if (call) {
          if (this.calls.size >= 1024) { this.setError('Picture-in-Picture operation capacity exceeded', session); continue; }
          this.calls.set(JSON.stringify([session, call]), turn.epoch);
        }
        if (/^mcp__computer[-_]use__/.test(text(event.toolName)) && !turn.computerActive) {
          turn.computerActive = true; this.rememberVisibility(session); changed = true;
        }
      } else if (event.type === 'tool_end') {
        const key = JSON.stringify([session, text(event.toolCallId)]), lease = this.calls.get(key); this.calls.delete(key);
        if (lease !== undefined && event.isError !== true && event.computerUse) this.approvedWindow(session, lease, event.computerUse);
      } else if (event.type === 'done' || event.type === 'interrupted' || (event.type === 'api_error' && event.terminal === true)) {
        this.endTurn(session, text(event.turnId), event.type === 'done');
        changed = true;
      } else continue;
    }
    if (changed) { this.revision++; this.publish(); }
  }
  /** Call only after Computer Use has approved this exact application under this lease. */
  approvedWindow(session: string, lease: number, raw: unknown): void {
    if (!this.accepts(session, lease)) return;
    const surface = object(raw), app = object(surface.app);
    if (!integer(app.pid, 0x7fffffff)) return;
    const key = `window:${JSON.stringify([session, app.pid])}`;
    if (!this.capacity(key, session)) return;
    const revision = ++this.contentRevision;
    this.turn(session).computerActive = true; this.rememberVisibility(session);
    const command: ObjectValue = { type: 'upsertWindow', presentationId: key, sessionId: session, turnId: this.turn(session).id,
      epoch: lease, contentRevision: revision, pid: app.pid, title: text(app.name) };
    if (integer(surface.windowId, 0xffffffff)) command.windowId = surface.windowId;
    if (Array.isArray(surface.associatedWindowIds)) command.associatedWindowIds = surface.associatedWindowIds.filter(value => integer(value, 0xffffffff)).slice(0, 32);
    const mapping = object(surface.mapping), bounds = { x: mapping.screenshotScreenX, y: mapping.screenshotScreenY, width: mapping.screenshotScreenWidth, height: mapping.screenshotScreenHeight };
    if (Object.values(bounds).every(finite) && Number(bounds.width) > 0 && Number(bounds.height) > 0) command.bounds = bounds;
    this.presentations.set(key, { session, epoch: lease, revision, target: { pid: app.pid, bundleId: text(app.bundleId) }, command });
    this.revision++; this.publish(); this.command(command);
  }
  cursor(session: string, lease: number, raw: unknown): void {
    if (!this.accepts(session, lease)) return;
    const value = object(raw);
    if (!finite(value.x) || !finite(value.y)) return;
    this.command({ type: 'cursor', sessionId: session, epoch: lease, x: value.x, y: value.y, active: value.active === true });
  }
  browserResult(session: string, lease: number, raw: unknown): void {
    if (!this.accepts(session, lease)) return;
    const result = object(raw), surface = object(object(result._meta)['klaus/toolSurface']), browser = text(surface.browserId);
    if (surface.kind !== 'browserUse' || !browser || !['chrome', 'iab', 'cdp'].includes(text(surface.backend))) return;
    const cleanup = (ids: string[]) => this.command({ type: 'remove', presentationIds: ids, sessionId: session, throughEpoch: lease, throughContentRevision: this.contentRevision });
    if (surface.sessionEnded === true) {
      cleanup(this.removePresentations(value => value.session === session && value.browser === browser));
      this.turn(session).browserActive.delete(browser);
    } else {
      if (result.isError !== true) { this.turn(session).browserActive.add(browser); this.rememberVisibility(session); }
      const tabs = Array.isArray(surface.openTabIds) ? new Set(surface.openTabIds.map(id).filter(Boolean)) : undefined;
      if (tabs) cleanup(this.removePresentations(value => value.session === session && value.browser === browser && !tabs.has(id(value.target.tabId))));
      const screenshot = object(surface.screenshot), tab = id(screenshot.tabId), url = typeof screenshot.url === 'string' ? screenshot.url : '';
      if (result.isError !== true && tab && (!tabs || tabs.has(tab)) && url.length <= 32 * 1024 * 1024 && /^data:image\/(png|jpeg|webp|gif);base64,.+$/.test(url)) {
        const key = `browser:${JSON.stringify([session, browser, tab])}`;
        if (this.capacity(key, session)) {
          const target: ObjectValue = { ...surface, sessionId: session, tabId: screenshot.tabId }; delete target.screenshot;
          const revision = ++this.contentRevision;
          const command: ObjectValue = { type: 'upsertBrowser', presentationId: key, sessionId: session, tabId: screenshot.tabId,
            epoch: lease, contentRevision: revision, dataUrl: url, title: text(surface.title) };
          this.presentations.set(key, { session, epoch: lease, revision, browser, target, command });
          this.command(command);
        }
      }
    }
    this.revision++; this.publish();
  }
  private capacity(key: string, session: string): boolean {
    if (this.presentations.has(key) || this.presentations.size < 32) return true;
    this.setError('Picture-in-Picture supports at most 32 current sources', session); return false;
  }
  removeSession(session: string, deleted: boolean): void {
    const turn = this.turns.get(session); if (turn) this.endTurn(session, '', false);
    this.removePresentations(value => value.session === session);
    this.command({ type: 'remove', sessionId: session, allForSession: true, throughEpoch: turn?.epoch ?? 0 });
    if (deleted) this.persist(next => { delete next.taskVisibilities[session]; });
    this.revision++; this.publish();
  }
  private current(event: ObjectValue): boolean {
    const session = text(event.sessionId), epoch = event.epoch, presentationId = text(event.presentationId);
    if (session && epoch !== undefined && this.turns.get(session)?.epoch !== epoch) return false;
    if (presentationId) {
      const own = this.presentations.get(presentationId);
      if (!own || own.epoch !== epoch || own.session !== session || (event.contentRevision !== undefined && own.revision !== event.contentRevision)) return false;
    }
    return true;
  }
  private command(command: ObjectValue): void {
    if (!this.owner?.port || this.owner.closing || this.closed) return;
    if (['upsertWindow', 'upsertBrowser', 'cursor'].includes(text(command.type)) && !this.current(command)) return;
    try { this.owner.port.command(command); } catch (error) { this.setError(String(error), text(command.sessionId) || undefined); }
  }
  private nativeEvent(event: ObjectValue): void {
    try {
      if (event.type === 'ownerClosed') { void this.detachOwner(this.owner!.id); return; }
      if (event.type === 'visibility') this.changeVisibility(event);
      else if (event.type === 'resize' && finite(event.maxDisplaySize)) this.persist(next => { next.maxDisplaySize = size(event.maxDisplaySize); });
      else if (event.type === 'placement' && anchors.has(text(event.anchor))) this.persist(next => { next.anchor = text(event.anchor); });
      else if (event.type === 'state' && Array.isArray(event.activeTaskIds)) {
        const ids = event.activeTaskIds.map(text).filter(session => this.turns.has(session) && !this.turns.get(session)!.ended);
        if (JSON.stringify([...new Set(ids)].sort()) !== JSON.stringify([...this.nativeActive].sort())) {
          this.nativeActive = new Set(ids); this.revision++; this.publish(false);
        }
      } else if (event.type === 'error' && this.current(event) && text(event.message)) this.setError(text(event.message), text(event.sessionId) || undefined);
      else if (event.type === 'ready' && this.error && this.current(event) && (!this.errorSession || this.errorSession === event.sessionId)) {
        this.error = null; this.errorSession = null; this.revision++; this.publish(false);
      } else if (event.type === 'focus' && this.current(event)) {
        const key = text(event.presentationId), own = this.presentations.get(key);
        if (!own?.browser) return;
        const controller = new AbortController(); this.controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(new Error('Preview focus timed out')), 5000); timeout.unref();
        const focus = Promise.resolve().then(() => this.deps.focusBrowser(structuredClone(own.target), controller.signal)).catch(error => {
          if (!controller.signal.aborted && this.presentations.get(key) === own) this.setError(String(error), own.session);
        }).finally(() => { clearTimeout(timeout); this.controllers.delete(controller); this.pending.delete(focus); });
        this.pending.add(focus);
      }
    } catch (error) { this.setError(String(error)); this.publish(); }
  }
  private setError(error: string, session?: string): void {
    const message = error.slice(0, 4096);
    if (this.error === message && this.errorSession === (session ?? null)) return;
    this.error = message; this.errorSession = session ?? null; this.revision++; this.publish(false);
  }
  private publish(native = true): void {
    if (this.closed || !this.owner || this.owner.closing) return;
    if (native) {
      const chinese = this.deps.language().startsWith('zh');
      this.command({ ...structuredClone(this.preferences), type: 'preferences', labels: chinese ?
        { hide: '隐藏', hideForTask: '对此任务隐藏', hideForAllActiveTasks: '对所有活动中的任务隐藏', returnToApp: '将画中画移回 Klaus' } :
        { hide: 'Hide', hideForTask: 'Hide for this chat', hideForAllActiveTasks: 'Hide for all active chats', returnToApp: 'Return Picture-in-Picture to Klaus' } });
    }
    this.snapshotPending = this.snapshot();
    if (!this.pushing) this.startPush();
  }
  private startPush(): void {
    const owner = this.owner; if (!owner || owner.closing || this.closed || !this.snapshotPending) return;
    this.pushing = true;
    const task = (async () => {
      while (this.owner === owner && !owner.closing && this.snapshotPending) {
        const snapshot = this.snapshotPending; this.snapshotPending = undefined;
        const controller = new AbortController(); this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(new Error('Preview state acknowledgement timed out')), 4000); timer.unref();
        try { await this.deps.deliver(owner.id, PIP_PUSH_CHANNEL, snapshot, controller.signal); }
        catch (error) {
          if (!owner.closing) { this.error = `Picture-in-Picture state delivery failed: ${String(error)}`.slice(0, 4096); this.errorSession = null; this.revision++; }
          this.snapshotPending = undefined; break;
        } finally { clearTimeout(timer); this.controllers.delete(controller); }
      }
    })().finally(() => { this.pushing = false; this.pending.delete(task); if (this.snapshotPending) this.startPush(); });
    this.pending.add(task);
  }
  async detachOwner(ownerId: number, deadlineMs = 5000, preservePresentations = false): Promise<{ complete: boolean }> {
    const owner = this.owner;
    if (!owner || owner.id !== ownerId) return { complete: true };
    if (!owner.closing) {
      owner.closing = true; this.snapshotPending = undefined;
      // A host-window handoff retains approved sources; document retirement revokes their leases.
      if (!preservePresentations) {
        for (const turn of this.turns.values()) { turn.epoch++; turn.computerActive = false; turn.browserActive.clear(); }
        this.calls.clear(); this.presentations.clear(); this.nativeActive.clear();
      }
      this.revision++;
      for (const controller of this.controllers) controller.abort(new Error('Picture-in-Picture owner detached'));
    }
    const duration = Math.max(0, Math.min(30_000, Number.isFinite(deadlineMs) ? deadlineMs : 5000)), deadline = performance.now() + duration;
    const native = await owner.port?.close(duration);
    while (this.pending.size && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const complete = (native?.complete ?? true) && this.pending.size === 0;
    if (complete && this.owner === owner) this.owner = undefined;
    return { complete };
  }
  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closed = true;
    return this.owner ? this.detachOwner(this.owner.id, deadlineMs) : { complete: this.pending.size === 0 };
  }
}
