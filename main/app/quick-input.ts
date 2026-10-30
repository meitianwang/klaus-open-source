import { randomUUID } from 'node:crypto';
import type { BrowserWindow, Rectangle } from 'electron';
import { IpcHandlerError } from '../ipc/registry';

export interface QuickInputDependencies {
  createWindow(): BrowserWindow;
  pageUrl: string;
  workArea(): Rectangle;
  language(): string | undefined;
  registerOwner(window: BrowserWindow): void;
  unregisterOwner(ownerId: number): void;
  /** Reject pending pushes on navigation, renderer loss and destruction. */
  invalidateDelivery(ownerId: number): void;
  attachVoiceOwner(ownerId: number): void | Promise<void>;
  detachVoiceOwner(ownerId: number, deadlineMs: number): Promise<{ complete: boolean }>;
  deliverFocus(ownerId: number, value: { language: 'zh' | 'en'; preserveDraft: boolean; activationId: string }): Promise<void>;
  /** Show the main window, wait for its subscriber, then acknowledge ipc:quick-input:submit.
   * Deduplicate submissionId before creating a conversation; never retry automatically.
   */
  submitToMain(value: { text: string; submissionId: string }, signal: AbortSignal): Promise<void>;
  log(message: string): void;
  platform?: NodeJS.Platform;
  deadlineMs?: number;
}
interface Ready { promise: Promise<void>; resolve(): void; reject(error: Error): void }
interface Owner {
  window: BrowserWindow; id: number; generation: number; attached: boolean;
  ready: Ready; loaded: boolean; resume: boolean; destroyed: boolean; preserveDraft: boolean;
  navigationSeen: boolean;
  activationId?: string;
  focusing: boolean;
  focus?: Ready;
  detach?: Promise<{ complete: boolean }>;
}
interface Submission { text: string; id: string; owner: Owner; activationId?: string; abort: AbortController; done: Promise<{ ok: boolean; error?: string }> }
function readiness(): Ready {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'quick-input-failed'; }
async function wait<T>(task: Promise<T>, signal: AbortSignal, timeout: number): Promise<T> {
  if (signal.aborted) throw new Error('quick-input-cancelled');
  let timer: NodeJS.Timeout | undefined, abort: () => void = () => {};
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      abort = () => reject(new Error('quick-input-cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error('quick-input-deadline')), timeout);
    })]);
  } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

/** One transient window, with separate renderer and visible voice-owner lifetimes. */
export class QuickInputRuntime {
  private current: Owner | undefined;
  private readonly owners = new Set<Owner>();
  private readonly work = new Set<Promise<unknown>>();
  private closing = false;
  private generation = 0;
  private showing: { abort: AbortController; done: Promise<{ ok: boolean; error?: string }> } | undefined;
  private submission: Submission | undefined;
  private retry: { text: string; id: string; owner: Owner } | undefined;
  private readonly timeout: number;

  constructor(private readonly deps: QuickInputDependencies) { this.timeout = Math.max(1, Math.min(60_000, deps.deadlineMs ?? 10_000)); }
  snapshot(): { visible: boolean; focused: boolean; preparing: boolean; submitting: boolean; closing: boolean } {
    const window = this.current && !this.current.destroyed ? this.current.window : undefined;
    return { visible: Boolean(window?.isVisible()), focused: Boolean(window?.isFocused()), preparing: Boolean(this.showing), submitting: Boolean(this.submission), closing: this.closing };
  }
  language(ownerId?: number): 'zh' | 'en' {
    if (ownerId !== undefined) this.requireOwner(ownerId, false);
    return this.deps.language() === 'zh' ? 'zh' : 'en';
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.work.add(task); void task.finally(() => this.work.delete(task)).catch(() => {}); return task;
  }
  private requireOwner(id: number, visible = true): Owner {
    const owner = this.current;
    if (this.closing || !owner || owner.id !== id || owner.destroyed || visible && (!owner.attached || !owner.window.isVisible())) {
      throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Quick input caller is not active');
    }
    return owner;
  }
  private detach(owner: Owner, milliseconds = this.timeout): Promise<{ complete: boolean }> {
    owner.attached = false;
    if (owner.detach) return owner.detach;
    // Invoke immediately so no IPC call can start voice work while closure is queued.
    let pending: Promise<{ complete: boolean }>;
    try { pending = this.deps.detachVoiceOwner(owner.id, milliseconds); }
    catch (error) { pending = Promise.reject(error); }
    const done = pending.then(result => {
      if (result.complete && owner.destroyed) this.owners.delete(owner);
      return result;
    }).finally(() => { if (owner.detach === done) owner.detach = undefined; });
    owner.detach = done; return this.track(done);
  }
  private invalidate(owner: Owner, reason: string): void {
    owner.generation = ++this.generation;
    owner.activationId = undefined;
    this.showing?.abort.abort();
    this.deps.invalidateDelivery(owner.id);
    if (this.submission?.owner === owner) this.submission.abort.abort(new Error(reason));
    if (this.retry?.owner === owner) this.retry = undefined;
    if (!owner.window.isDestroyed()) owner.window.hide();
    void this.detach(owner).then(result => {
      if (!result.complete) this.deps.log('Quick input voice owner has not drained');
    }).catch(error => this.deps.log(errorText(error)));
  }
  private create(): Owner {
    const window = this.deps.createWindow();
    const owner: Owner = { window, id: window.webContents.id, generation: ++this.generation, attached: false,
      ready: readiness(), loaded: false, resume: false, destroyed: false, preserveDraft: false, navigationSeen: false, focusing: false };
    this.current = owner; this.owners.add(owner);
    try { this.deps.registerOwner(window); }
    catch (error) { window.destroy(); this.current = undefined; this.owners.delete(owner); throw error; }
    if ((this.deps.platform ?? process.platform) === 'darwin') {
      window.setAlwaysOnTop(true, 'floating');
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    window.on('blur', () => {
      // AppKit may deliver the previous hide's blur after show/focus has completed.
      if (!owner.destroyed && !owner.focusing && window.isVisible() && !window.isFocused()) void this.hide().catch(error => this.deps.log(errorText(error)));
    });
    window.on('focus', () => { if (!owner.destroyed && window.isFocused()) owner.focus?.resolve(); });
    window.on('hide', () => {
      if (owner.destroyed || window.isVisible()) return;
      this.showing?.abort.abort();
      if (owner.attached) void this.detach(owner).catch(error => this.deps.log(errorText(error)));
    });
    window.webContents.on('did-start-navigation', details => {
      if (!details.isMainFrame || details.isSameDocument) return;
      if (!owner.navigationSeen) { owner.navigationSeen = true; return; }
      owner.resume = window.isVisible();
      owner.ready.reject(new Error('quick-input-navigated')); owner.ready = readiness(); owner.loaded = false;
      this.invalidate(owner, 'quick-input-navigated');
    });
    window.webContents.on('did-finish-load', () => {
      owner.loaded = true; owner.ready.resolve();
      if (owner.resume && !this.closing && !owner.destroyed) {
        owner.resume = false;
        // The previous show may still be unwinding from navigation cancellation.
        void (this.showing?.done ?? Promise.resolve()).then(() => this.show()).catch(error => this.deps.log(errorText(error)));
      }
    });
    window.webContents.on('render-process-gone', () => {
      owner.ready.reject(new Error('quick-input-renderer-exited'));
      this.invalidate(owner, 'quick-input-renderer-exited'); window.destroy();
    });
    window.on('closed', () => {
      owner.destroyed = true; owner.ready.reject(new Error('quick-input-window-closed'));
      this.invalidate(owner, 'quick-input-window-closed'); this.deps.unregisterOwner(owner.id);
      if (this.current === owner) this.current = undefined;
    });
    void window.loadURL(this.deps.pageUrl).catch(error => {
      owner.ready.reject(error instanceof Error ? error : new Error('quick-input-load-failed'));
      this.deps.log(errorText(error)); if (!window.isDestroyed()) window.destroy();
    });
    return owner;
  }
  show(): Promise<{ ok: boolean; error?: string }> {
    if (this.closing) return Promise.resolve({ ok: false, error: 'quick-input-closed' });
    if (this.showing) return this.showing.done;
    const abort = new AbortController();
    const done = this.track(this.summon(abort).catch(error => ({ ok: false, error: errorText(error) })));
    this.showing = { abort, done };
    void done.finally(() => { if (this.showing?.done === done) this.showing = undefined; });
    return done;
  }
  private async summon(abort: AbortController): Promise<{ ok: boolean; error?: string }> {
    const signal = abort.signal;
    for (const retired of this.owners) {
      if (retired.destroyed && !(await wait(this.detach(retired), signal, this.timeout)).complete) throw new Error('quick-input-owner-still-closing');
    }
    const owner = this.current ?? this.create();
    try {
      // loadURL starts navigation synchronously; the newly created readiness belongs to it.
      if (!owner.loaded) await wait(owner.ready.promise, signal, this.timeout);
      const generation = owner.generation;
      if (!(await wait(this.detach(owner), signal, this.timeout)).complete) throw new Error('quick-input-owner-still-closing');
      if (signal.aborted || this.closing || owner.destroyed || owner !== this.current || generation !== owner.generation) throw new Error('quick-input-cancelled');
      const attachment = this.track(Promise.resolve(this.deps.attachVoiceOwner(owner.id)).then(async () => {
        owner.attached = true;
        if (signal.aborted || this.closing || owner.destroyed || owner !== this.current || generation !== owner.generation) {
          await this.detach(owner); throw new Error('quick-input-cancelled');
        }
      }));
      await wait(attachment, signal, this.timeout);
      owner.activationId = randomUUID();
      const area = this.deps.workArea(), width = Math.min(680, Math.max(1, area.width)), height = Math.min(104, Math.max(1, area.height));
      owner.window.setBounds({ width, height, x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, area.y + area.height * 0.22))) });
      owner.focus = readiness(); owner.focusing = true;
      owner.window.show(); owner.window.focus();
      if (owner.window.isFocused()) owner.focus.resolve();
      // Windows can acknowledge focus after the previous hide's blur notification.
      await wait(owner.focus.promise, signal, this.timeout); owner.focusing = false;
      await wait(this.track(this.deps.deliverFocus(owner.id, { language: this.language(), preserveDraft: owner.preserveDraft, activationId: owner.activationId })), signal, this.timeout);
      if (signal.aborted || owner.destroyed || !owner.attached || !owner.window.isVisible()) throw new Error('quick-input-cancelled');
      owner.preserveDraft = false; return { ok: true };
    } catch (error) {
      // A deadline is cancellation too: a late physical attach must immediately detach.
      abort.abort(); owner.focusing = false;
      if (!owner.destroyed) owner.window.hide();
      await this.detach(owner); throw error;
    }
  }
  toggle(): Promise<{ ok: boolean; error?: string }> {
    const owner = this.current;
    return owner && !owner.destroyed && owner.window.isVisible() && owner.window.isFocused() ? this.hide().then(() => ({ ok: true })) : this.show();
  }
  async hide(ownerId?: number, activationId?: unknown): Promise<{ ok: true; complete: boolean }> {
    const owner = ownerId === undefined ? this.current : this.requireOwner(ownerId, false);
    // Renderer blur/visibility messages can arrive after a subsequent summon.
    if (ownerId !== undefined && (!owner?.activationId || activationId !== owner.activationId)) return { ok: true, complete: true };
    this.showing?.abort.abort();
    if (!owner) return { ok: true, complete: true };
    owner.resume = false;
    if (!owner.destroyed) owner.window.hide();
    return { ok: true, ...await this.detach(owner) };
  }
  submit(ownerId: number, value: unknown): Promise<{ ok: boolean; error?: string }> {
    const owner = this.requireOwner(ownerId), text = typeof value === 'string' ? value.trim() : '';
    if (!text) return Promise.resolve({ ok: false, error: 'empty' });
    if (text.length > 8000) return Promise.resolve({ ok: false, error: 'too-long' });
    if (this.submission) return Promise.resolve({ ok: false, error: 'quick-input-submit-busy' });
    const id = this.retry?.owner === owner && this.retry.text === text ? this.retry.id : randomUUID();
    const abort = new AbortController();
    const submission: Submission = { text, id, owner, activationId: owner.activationId, abort, done: Promise.resolve({ ok: false }) };
    // Keep the same id after an ambiguous failure so an explicit user retry is deduplicable.
    this.retry = { text, id, owner }; this.submission = submission; owner.preserveDraft = true;
    const done = this.track(Promise.resolve().then(async () => {
      if (abort.signal.aborted) throw new Error('quick-input-cancelled');
      await this.deps.submitToMain({ text, submissionId: id }, abort.signal);
      if (abort.signal.aborted || owner.destroyed) throw new Error('quick-input-cancelled');
      this.retry = undefined; owner.preserveDraft = false;
      if (owner.activationId === submission.activationId) await this.hide();
      return { ok: true };
    }).catch(error => ({ ok: false, error: errorText(error) })).finally(() => {
      if (this.submission === submission) this.submission = undefined;
    }));
    submission.done = done; return done;
  }
  async shutdown(milliseconds = this.timeout): Promise<{ complete: boolean }> {
    this.closing = true; this.showing?.abort.abort(); this.submission?.abort.abort();
    const resources = [...this.owners];
    for (const owner of resources) if (!owner.window.isDestroyed()) owner.window.destroy();
    const detached = resources.map(owner => this.detach(owner, milliseconds));
    const reports = Promise.allSettled(detached);
    const settled = Promise.all([Promise.allSettled([...this.work]), reports]);
    try {
      const [, result] = await wait(settled, new AbortController().signal, Math.max(1, Math.min(60_000, milliseconds)));
      return { complete: result.every(row => row.status === 'fulfilled' && row.value.complete) && this.owners.size === 0 };
    } catch { return { complete: false }; }
  }
}
