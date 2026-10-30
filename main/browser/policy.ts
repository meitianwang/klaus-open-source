import { BrowserError, object, type BrowserBounds } from './types';

/** Only web pages and an empty tab belong in the unprivileged browser surface. */
export function navigationUrl(input: unknown): string {
  if (typeof input !== 'string') throw new BrowserError('invalid_request', 'url must be a string.');
  const raw = input.trim();
  if (raw === '' || raw === 'about:blank') return 'about:blank';
  if (raw.length > 16_384 || /[\u0000-\u0020]/u.test(raw)) throw new BrowserError('invalid_request', 'Invalid browser URL.');
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/iu.test(raw);
  const hostPort = /^[\w.-]+:\d+(?:[/?#]|$)/u.test(raw);
  const candidate = local || hostPort ? `http://${raw}` : /^[a-z][a-z\d+.-]*:/iu.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new BrowserError('invalid_request', 'Invalid browser URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BrowserError('refused_by_policy', 'Only http, https and about:blank may open in the browser.');
  }
  return parsed.href;
}

/** Geometry is validated before rounding; NaN must never reach native View APIs. */
export function browserBounds(value: unknown): BrowserBounds {
  const bounds = object(value);
  for (const field of ['x', 'y', 'width', 'height']) {
    if (typeof bounds[field] !== 'number' || !Number.isFinite(bounds[field])) {
      throw new BrowserError('invalid_request', `bounds.${field} must be finite.`);
    }
  }
  if (Number(bounds.width) <= 0 || Number(bounds.height) <= 0) throw new BrowserError('invalid_request', 'Browser bounds must have positive dimensions.');
  return {
    x: Math.max(0, Math.round(Number(bounds.x))), y: Math.max(0, Math.round(Number(bounds.y))),
    width: Math.max(1, Math.round(Number(bounds.width))), height: Math.max(1, Math.round(Number(bounds.height))),
  };
}

const CDP_DOMAINS = new Set([
  'Accessibility', 'Animation', 'CSS', 'DOM', 'DOMDebugger', 'DOMSnapshot', 'Emulation',
  'Input', 'LayerTree', 'Log', 'Network', 'Overlay', 'Page', 'Performance', 'PerformanceTimeline', 'Runtime',
]);
const CDP_REFUSED = new Set([
  'Network.getAllCookies', 'Network.getCookies', 'Page.getCookies', 'Network.setCookie',
  'Network.setCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache',
  'Page.navigate', 'Page.navigateToHistoryEntry', 'Page.setDownloadBehavior', 'DOM.setFileInputFiles',
  'Page.setBypassCSP', 'Page.addScriptToEvaluateOnNewDocument', 'Network.setRequestInterception',
  'Page.addScriptToEvaluateOnLoad', 'Network.loadNetworkResource', 'DOM.getFileInfo',
  'Runtime.addBinding', 'Page.handleJavaScriptDialog', 'Page.setInterceptFileChooserDialog', 'Page.close', 'Page.crash',
]);

export function checkRawCdp(method: string): void {
  const [domain, member, extra] = method.split('.');
  if (!domain || !member || extra) throw new BrowserError('invalid_request', 'A CDP method must be Domain.command.');
  if (!CDP_DOMAINS.has(domain) || CDP_REFUSED.has(method)) {
    throw new BrowserError('refused_by_policy', `${method} is not available through raw CDP. Use the named browser operation.`);
  }
}

export function timeoutMs(input: unknown, fallback = 15_000): number {
  if (input === undefined) return fallback;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 1 || input > 60_000) {
    throw new BrowserError('invalid_request', 'timeoutMs must be between 1 and 60000.');
  }
  return Math.round(input);
}
