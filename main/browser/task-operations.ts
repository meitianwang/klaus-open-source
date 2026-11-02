import { contentFormat, readContent } from './page-content';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

export interface TemporaryPage { id: number; cdp: BrowserCdp }
export interface ReadUrlsContext {
  create(): Promise<TemporaryPage>;
  navigate(page: TemporaryPage, url: string, fields: BrowserObject, signal?: AbortSignal): Promise<void>;
  close(page: TemporaryPage): Promise<void>;
  tabs(): Promise<number[]>;
  selected(): number | undefined;
  restore(id: number | undefined): void;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserError('cancelled', 'The browser page read was cancelled.');
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new BrowserError('cancelled', 'The browser page read was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

/** Each temporary tab closes before the next opens; selection belongs to the caller. */
export async function readUrls(context: ReadUrlsContext, fields: BrowserObject, signal?: AbortSignal): Promise<BrowserObject> {
  assertActive(signal);
  const wanted = typeof fields.urls === 'string' ? [fields.urls] : fields.urls;
  if (!Array.isArray(wanted) || !wanted.length || wanted.some(url => typeof url !== 'string' || !url.trim())) throw new BrowserError('invalid_request', 'read_urls needs non-empty URL strings.');
  const format = contentFormat(fields);
  if (!['text','markdown','html','domSnapshot'].includes(format)) throw new BrowserError('invalid_request', 'read_urls supports text, markdown, html or domSnapshot.');
  const timeout = fields.timeoutMs === undefined ? 20000 : Number(fields.timeoutMs);
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120000) throw new BrowserError('invalid_request', 'read_urls timeoutMs must be from 0 to 120000.');
  const selected = context.selected(), temporary: TemporaryPage[] = [], pages: BrowserObject[] = [];
  for (const url of wanted.slice(0,10) as string[]) {
    let page: TemporaryPage | undefined;
    try {
      assertActive(signal);
      page = await context.create(); temporary.push(page);
      assertActive(signal);
      let timedOut = false;
      try { await abortable(context.navigate(page, url, { ...fields, timeoutMs: timeout }, signal), signal); }
      catch (error) { if (error instanceof BrowserError && error.code === 'timeout') timedOut = true; else throw error; }
      assertActive(signal);
      const result = await abortable(readContent(page.cdp, { maxChars: 20000, ...fields, contentType: format }), signal);
      assertActive(signal);
      pages.push({ requestedUrl: url, ...result, ok: true, ...(timedOut ? { timedOut: true } : {}) });
    } catch (error) { assertActive(signal); pages.push({ requestedUrl: url, url, ok: false, error: error instanceof Error ? error.message : String(error) }); }
    finally { if (page) await context.close(page).catch(() => {}); context.restore(selected); }
  }
  const remaining = await context.tabs(), pending = temporary.filter(page => remaining.includes(page.id));
  for (const page of pending) await context.close(page).catch(() => {});
  context.restore(selected);
  const after = await context.tabs();
  return { pages, contentType: format, count: pages.length, requested: wanted.length, truncated: pages.length < wanted.length, selectedTab: selected ?? null, selectedTabUnchanged: selected === context.selected(), temporaryTabsClosed: temporary.every(page => !after.includes(page.id)), pendingAtClose: pending.length };
}

export async function navigateForRead(
  cdp: BrowserCdp,
  url: string,
  fields: BrowserObject,
  signal?: AbortSignal,
  stopOnAbort?: () => void,
): Promise<void> {
  assertActive(signal);
  const until = ({ dom_content_loaded: 'domcontentloaded', domContentLoaded: 'domcontentloaded', network_idle: 'networkidle', networkIdle: 'networkidle' } as Record<string,string>)[String(fields.waitUntil ?? 'load')] ?? String(fields.waitUntil ?? 'load');
  if (!['load','domcontentloaded','networkidle','commit'].includes(until)) throw new BrowserError('invalid_request', 'Unknown read_urls waitUntil: ' + until);
  const requestedTimeout = fields.timeoutMs ?? 30000;
  if (typeof requestedTimeout !== 'number' || !Number.isFinite(requestedTimeout) || requestedTimeout < 0) throw new BrowserError('invalid_request', 'Navigation timeoutMs must be a non-negative finite number.');
  const timeout = Math.min(requestedTimeout, 120000);
  let changed = Date.now();
  const activity = new Set(['Network.requestWillBeSent','Network.responseReceived','Network.dataReceived','Network.loadingFinished','Network.loadingFailed','Network.webSocketFrameReceived','Network.webSocketFrameSent','Network.eventSourceMessageReceived']);
  const remove = cdp.onEvent(method => {
    if (activity.has(method)) changed = Date.now();
  });
  const stop = (): void => {
    if (stopOnAbort) stopOnAbort();
    else void cdp.command('Page.stopLoading').catch(() => {});
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const response = await abortable(cdp.command('Page.navigate', { url }), signal);
    if (response.errorText) throw new BrowserError('navigation_failed', String(response.errorText));
    if (timeout === 0 || until === 'commit') return;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      assertActive(signal);
      try {
        const state = await abortable(cdp.evaluate('document.readyState'), signal);
        if (until === 'domcontentloaded' && (state === 'interactive' || state === 'complete') || until === 'load' && state === 'complete' || until === 'networkidle' && state === 'complete' && Date.now() - changed >= 500) return;
      } catch (error) { assertActive(signal); if (error instanceof BrowserError && ['stale_tab','unavailable'].includes(error.code)) throw error; }
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    throw new BrowserError('timeout', 'The page did not reach ' + until + '.');
  } finally {
    signal?.removeEventListener('abort', stop);
    remove();
  }
}

export async function runBatch(fields: BrowserObject, run: (kind: string, fields: BrowserObject) => Promise<BrowserObject>): Promise<BrowserObject> {
  const raw = fields.operations ?? fields.steps;
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new BrowserError('invalid_request', 'A batch needs 1 to 20 operations.');
  const steps = raw.map((value,index) => {
    const step = object(value), kind = step.type ?? step.operation;
    if (typeof kind !== 'string' || !kind || kind === 'batch') throw new BrowserError('invalid_request', 'Batch step ' + (index + 1) + ' needs a type other than batch.');
    return { kind, fields: step };
  });
  const results: BrowserObject[] = [];
  for (const [index,step] of steps.entries()) {
    try {
      const result = await run(step.kind, step.fields);
      if (result.isError === true) throw new BrowserError(String(object(result.error).code ?? 'host_error'),String(object(result.error).message ?? 'Batch step failed.'));
      results.push({ step:index+1,type:step.kind,result:result.structuredContent ?? result });
    } catch (error) {
      return { asked:steps.length,completed:results.length,results,stopped:{step:index+1,type:step.kind,code:error instanceof BrowserError?error.code:'host_error',error:error instanceof Error?error.message:String(error)} };
    }
  }
  return { asked:steps.length,completed:results.length,results };
}

/** A stopped batch is a failed operation with a useful partial result. Keep
 * completed side effects visible so a caller does not repeat them blindly. */
export function batchResponse(value: BrowserObject): BrowserObject {
  if (value.stopped === undefined) return { value };
  const stopped = object(value.stopped);
  return { value, partial: true, error: {
    code: 'host_error',
    message: `Batch stopped at step ${String(stopped.step)} (${String(stopped.type)}): ${String(stopped.error)}`,
    details: stopped,
  } };
}
