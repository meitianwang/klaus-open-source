import type { Json } from '../ipc/contract';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserManager, BrowserPage } from './manager';
import { toolText } from '../services/cron-tools';

export const RUN_PREVIEW_TOOL_SPEC: Json = {
  type: 'function',
  name: 'run_preview',
  description: 'Open an explicit http(s) preview URL in a background Browser tab. The page is not shown to the user automatically. Use this only when a preview server already supplies a URL; this tool does not start that server.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL of an already running preview.' },
      name: { type: 'string', description: 'Optional short human-readable name for the preview.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

export interface PreviewState {
  sessionId: string;
  toolCallId: string;
  name: string;
  url: string;
  tabId?: string;
  status: 'running' | 'ready' | 'failed';
  error?: string;
}

type PreviewBrowser = Pick<BrowserManager, 'assertNavigation' | 'createPreviewTab' | 'navigate' | 'page' | 'conversationId' | 'focusRevision'>;
interface Entry {
  sessionId: string;
  url: string;
  page?: BrowserPage;
  status: PreviewState['status'];
  error?: string;
  work?: Promise<void>;
}
interface Record { entry: Entry; name: string; sessionId: string; toolCallId: string }

export class RunPreview {
  private readonly calls = new Map<string, Record>();
  private readonly urls = new Map<string, Entry>();

  constructor(private readonly browser: PreviewBrowser, private readonly changed: (sessionId: string, toolCallId: string) => void) {}

  private key(sessionId: string, id: string): string { return `${sessionId}\0${id}`; }

  private validatedUrl(input: unknown): string {
    if (typeof input !== 'string' || !/^https?:\/\//i.test(input)) throw new BrowserError('invalid_request', 'run_preview requires an absolute http(s) URL.');
    const url = this.browser.assertNavigation(input);
    if (!/^https?:\/\//i.test(url)) throw new BrowserError('refused_by_policy', 'Preview URLs must use http or https.');
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new BrowserError('refused_by_policy', 'Preview URLs cannot contain credentials.');
    return parsed.href;
  }

  private notify(entry: Entry): void {
    for (const call of this.calls.values()) if (call.entry === entry) this.changed(call.sessionId, call.toolCallId);
  }

  private snapshot(call: Record): PreviewState {
    const { entry } = call;
    return {
      sessionId: call.sessionId, toolCallId: call.toolCallId, name: call.name, url: entry.url,
      ...(entry.page ? { tabId: entry.page.id } : {}),
      status: entry.status, ...(entry.error ? { error: entry.error } : {}),
    };
  }

  private pageIsOpen(entry: Entry): boolean {
    if (!entry.page) return false;
    try { this.browser.page(entry.sessionId, entry.page.id); return true; }
    catch {
      entry.page = undefined;
      entry.status = 'failed';
      entry.error = 'The preview tab was closed.';
      return false;
    }
  }

  private async navigate(entry: Entry, assertCurrent?: () => void): Promise<void> {
    entry.status = 'running'; entry.error = undefined;
    this.notify(entry);
    try {
      assertCurrent?.();
      if (!entry.page) entry.page = await this.browser.createPreviewTab(entry.sessionId);
      this.notify(entry);
      assertCurrent?.();
      await this.browser.navigate(entry.page, entry.url);
      assertCurrent?.();
      entry.status = 'ready';
    } catch (error) {
      entry.status = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
    }
    this.notify(entry);
  }

  async start(args: Json, sessionId: string, toolCallId: string, assertCurrent: () => void): Promise<Json> {
    assertCurrent();
    const fields = object(args);
    const url = this.validatedUrl(fields.url);
    const name = typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim().slice(0, 256) : url;
    const callKey = this.key(sessionId, toolCallId), urlKey = this.key(sessionId, url);
    const prior = this.calls.get(callKey);
    if (prior && prior.entry.url !== url) throw new BrowserError('invalid_request', 'A preview tool call cannot change its URL.');
    if (prior) {
      await prior.entry.work;
      return toolText(JSON.stringify(this.snapshot(prior)), prior.entry.status === 'ready');
    }
    let entry = this.urls.get(urlKey);
    if (entry && entry.page && !this.pageIsOpen(entry)) { this.urls.delete(urlKey); entry = undefined; }
    if (!entry) {
      entry = { sessionId, url, status: 'running' };
      this.urls.set(urlKey, entry);
    }
    this.calls.set(callKey, { entry, sessionId, toolCallId, name });
    const record = this.calls.get(callKey)!;
    if (!entry.work || entry.status === 'failed') {
      entry.work = this.navigate(entry, assertCurrent);
    }
    this.notify(entry);
    await entry.work;
    const result = this.snapshot(record);
    return toolText(JSON.stringify(result), result.status === 'ready');
  }

  private visibleScope(fields: BrowserObject): { sessionId: string; toolCallId: string } {
    const sessionId = fields.sessionId, toolCallId = fields.toolCallId, revision = fields.focusRevision;
    if (typeof sessionId !== 'string' || typeof toolCallId !== 'string' || !Number.isSafeInteger(revision)
      || sessionId !== this.browser.conversationId || revision !== this.browser.focusRevision) {
      throw new BrowserError('stale_scope', 'The preview request belongs to a task that is no longer visible.');
    }
    return { sessionId, toolCallId };
  }

  private assertScope(fields: BrowserObject): Record {
    const { sessionId, toolCallId } = this.visibleScope(fields);
    const call = this.calls.get(this.key(sessionId, toolCallId));
    if (!call) throw new BrowserError('not_found', 'No host-owned run_preview call exists for this task.');
    return call;
  }

  state(fields: BrowserObject): PreviewState {
    const call = this.assertScope(fields);
    if (call.entry.page && !this.pageIsOpen(call.entry)) this.notify(call.entry);
    return this.snapshot(call);
  }

  async retry(fields: BrowserObject): Promise<PreviewState> {
    const call = this.assertScope(fields), entry = call.entry;
    if (entry.status !== 'failed') throw new BrowserError('invalid_request', 'Only a failed preview navigation can be retried.');
    entry.work = this.navigate(entry);
    await entry.work;
    this.assertScope(fields);
    return this.snapshot(call);
  }

  async open(fields: BrowserObject): Promise<PreviewState> {
    const { sessionId, toolCallId } = this.visibleScope(fields);
    const url = this.validatedUrl(fields.url);
    const key = this.key(sessionId, toolCallId);
    let call = this.calls.get(key);
    if (call && call.entry.url !== url) throw new BrowserError('invalid_request', 'A preview tool call cannot change its URL.');
    if (!call) {
      let entry = this.urls.get(this.key(sessionId, url));
      if (!entry || entry.page && !this.pageIsOpen(entry)) {
        entry = { sessionId, url, status: 'running' };
        this.urls.set(this.key(sessionId, url), entry);
      }
      call = { entry, sessionId, toolCallId, name: typeof fields.name === 'string' ? fields.name.slice(0, 256) : url };
      this.calls.set(key, call);
    }
    if (call.entry.status === 'running' && call.entry.work) await call.entry.work;
    if (!this.pageIsOpen(call.entry) || call.entry.status === 'failed') {
      call.entry.work = this.navigate(call.entry);
      await call.entry.work;
    }
    this.assertScope(fields);
    return this.snapshot(call);
  }

  releaseSession(sessionId: string): void {
    for (const [key, call] of this.calls) if (call.sessionId === sessionId) this.calls.delete(key);
    for (const [key, entry] of this.urls) if (entry.sessionId === sessionId) this.urls.delete(key);
  }
}
