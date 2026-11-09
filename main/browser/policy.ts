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

// Raw CDP is governed in three layers: an allowed-domain list, a refused-method
// list, and parameter-level conditions. The Fetch, Storage, Target, WebAuthn,
// CacheStorage and Database domains stay closed: the host owns Document
// interception for managed navigation on the shared session, and a raw
// Fetch.enable would replace that single per-session configuration.
const CDP_DOMAINS = new Set([
  'Accessibility', 'Animation', 'Audits', 'Console', 'CSS', 'Debugger', 'DOM', 'DOMDebugger', 'DOMSnapshot',
  'Emulation', 'IO', 'Input', 'Inspector', 'LayerTree', 'Log', 'Network', 'Overlay', 'Page', 'Performance',
  'PerformanceTimeline', 'Profiler', 'Runtime', 'Tracing', 'WebAudio',
]);
const CDP_REFUSED = new Set([
  // Cookie and cache storage is host-managed on this unprivileged surface.
  'Network.getAllCookies', 'Network.getCookies', 'Page.getCookies', 'Page.deleteCookie', 'Network.setCookie',
  'Network.setCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache',
  // Navigation, downloads, dialogs and tabs have named operations that keep policy and leases.
  'Page.navigate', 'Page.navigateToHistoryEntry', 'Page.getNavigationHistory', 'Page.resetNavigationHistory',
  'Page.setDownloadBehavior', 'Page.setInterceptFileChooserDialog', 'Page.handleJavaScriptDialog', 'Page.close',
  // Injection, interception and file payloads bypass the guarded named operations.
  'DOM.setFileInputFiles', 'DOM.getFileInfo', 'Page.setBypassCSP', 'Page.addScriptToEvaluateOnNewDocument',
  'Page.addScriptToEvaluateOnLoad', 'Network.setRequestInterception', 'Network.loadNetworkResource',
  'Network.continueInterceptedRequest', 'Network.getResponseBodyForInterception',
  'Network.takeResponseBodyForInterceptionAsStream', 'Runtime.addBinding',
  // Keyboard input belongs to the type and press_key operations so focus and editability stay guarded.
  'Input.dispatchKeyEvent', 'Input.setInterceptDrags', 'Input.dispatchDragEvent',
  // Session-wide or device-bound network switches.
  'Network.getCertificate', 'Network.deleteDeviceBoundSession', 'Network.enableDeviceBoundSessions',
  'Network.setCookieControls', 'Network.setExtraHTTPHeaders', 'Network.replayXHR',
  // Page and tracing switches that alter browser-wide behaviour.
  'Page.crash', 'Page.disable', 'Page.setAdBlockingEnabled', 'Page.setRPHRegistrationMode',
  'Page.setSPCTransactionMode', 'Tracing.requestMemoryDump',
]);

/** Recovery guidance per refused method; everything else falls back to the named-operation hint. */
const CDP_GUIDANCE = new Map([
  ['DOM.setFileInputFiles', 'Use the file_upload operation to drive the file chooser instead.'],
  ['Page.setInterceptFileChooserDialog', 'Use the file_upload operation to drive the file chooser instead.'],
  ['Input.dispatchDragEvent', 'Use the file_upload operation for file payloads; drags run as real mouse input.'],
  ['Input.dispatchKeyEvent', 'Use the type or press_key operations so focus and editability stay guarded.'],
  ['Page.navigate', 'Use the navigate operation so URL policy and navigation leases apply.'],
  ['Page.navigateToHistoryEntry', 'Use the back or forward operations instead.'],
  ['Page.getNavigationHistory', 'Use the back or forward operations instead.'],
  ['Page.reload', 'Use the reload operation; a load-time script is not supported.'],
  ['Page.setDownloadBehavior', 'Downloads are host-managed; use the download operation.'],
  ['Page.handleJavaScriptDialog', 'Dialogs are host-managed; answer them through the dialog operation.'],
  ['Page.close', 'Use the tabs operation to close a tab.'],
  ['Network.getAllCookies', 'Cookie storage is host-managed on this surface.'],
  ['Network.getCookies', 'Cookie storage is host-managed on this surface.'],
  ['Fetch.enable', 'Document interception is host-reserved for managed navigation.'],
  ['Fetch.disable', 'Document interception is host-reserved for managed navigation.'],
]);

const present = (value: unknown): boolean => value !== undefined && value !== null;

/** System-level tracing and memory-dump captures stay out of the unprivileged surface. */
function tracingStartRefused(params: Record<string, unknown> | undefined): boolean {
  const traceConfig = params?.traceConfig;
  const plain = typeof traceConfig === 'object' && traceConfig !== null && !Array.isArray(traceConfig)
    ? traceConfig as Record<string, unknown> : undefined;
  return present(params?.perfettoConfig)
    || params?.tracingBackend === 'system'
    || (typeof params?.options === 'string' && params.options.split(',').some(part => part.trim() === 'enable-systrace'))
    || (plain !== undefined && (plain.enableSystrace === true || present(plain.memoryDumpConfig)));
}

/** Parameter-level refusals: the method is allowed, this payload would escalate it. */
function refusedCdpParams(method: string, params: Record<string, unknown> | undefined): boolean {
  switch (method) {
    case 'Fetch.continueResponse':
    case 'Fetch.fulfillRequest':
      return present(params?.binaryResponseHeaders);
    case 'Network.configureDurableMessages':
      return present(params?.maxTotalBufferSize);
    case 'Network.enable':
      return params?.enableDurableMessages === true;
    case 'Page.createIsolatedWorld':
      return params?.grantUniveralAccess === true;
    case 'Page.reload':
      return present(params?.scriptToEvaluateOnLoad);
    case 'Tracing.start':
      return tracingStartRefused(params);
    default:
      return false;
  }
}

export function checkRawCdp(method: string, params?: unknown): void {
  const [domain, member, extra] = method.split('.');
  if (!domain || !member || extra) throw new BrowserError('invalid_request', 'A CDP method must be Domain.command.');
  const fields = present(params) ? object(params) : undefined;
  if (!CDP_DOMAINS.has(domain) || CDP_REFUSED.has(method) || refusedCdpParams(method, fields)) {
    const guidance = CDP_GUIDANCE.get(method) ?? 'Use the named browser operation.';
    throw new BrowserError('refused_by_policy', `${method} is not available through raw CDP. ${guidance}`);
  }
}

export function timeoutMs(input: unknown, fallback = 15_000): number {
  if (input === undefined) return fallback;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 1 || input > 60_000) {
    throw new BrowserError('invalid_request', 'timeoutMs must be between 1 and 60000.');
  }
  return Math.round(input);
}
