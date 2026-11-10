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
// list, and parameter-level conditions. Conditions that name other origins
// (cookie URLs, redirect locations) collect those URLs so the caller can put
// each one through the same authorization as the current page before the
// command runs. The Storage, Target, WebAuthn, CacheStorage and Database
// domains stay closed. Document interception stays host-reserved for managed
// navigation: a raw Fetch.enable is merged with the host's Document pattern
// instead of replacing it, and Fetch.disable is refused in favour of enabling
// with an empty patterns array.
const CDP_DOMAINS = new Set([
  'Accessibility', 'Animation', 'Audits', 'Console', 'CSS', 'Debugger', 'DOM', 'DOMDebugger', 'DOMSnapshot',
  'Emulation', 'Fetch', 'IO', 'Input', 'Inspector', 'LayerTree', 'Log', 'Network', 'Overlay', 'Page',
  'Performance', 'PerformanceTimeline', 'Profiler', 'Runtime', 'Tracing', 'WebAudio',
]);
const CDP_REFUSED = new Set([
  // Cookie views that skip per-origin authorization, and browser-wide cookie resets.
  'Network.getAllCookies', 'Network.clearBrowserCookies',
  // Navigation, downloads and tabs have named operations that keep policy and leases.
  'Page.navigate', 'Page.navigateToHistoryEntry', 'Page.getNavigationHistory', 'Page.resetNavigationHistory',
  'Page.setDownloadBehavior', 'Page.setInterceptFileChooserDialog',
  // Clearing raw interception goes through Fetch.enable with an empty patterns array.
  'Fetch.disable',
  // Injection, interception and file payloads bypass the guarded named operations.
  'DOM.setFileInputFiles', 'DOM.getFileInfo', 'Page.setBypassCSP', 'Page.addScriptToEvaluateOnNewDocument',
  'Page.addScriptToEvaluateOnLoad', 'Network.setRequestInterception', 'Network.loadNetworkResource',
  'Network.continueInterceptedRequest', 'Network.getResponseBodyForInterception',
  'Network.takeResponseBodyForInterceptionAsStream',
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
  ['Network.getAllCookies', 'Use Network.getCookies with explicit URLs instead.'],
  ['Fetch.disable', 'Use Fetch.enable with an empty patterns array to clear raw interception.'],
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

function refuse(message: string): never { throw new BrowserError('refused_by_policy', message); }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Cookie writes stay bound to one explicit URL each so the affected origin can be authorized. */
function cookieEntryUrl(method: string, entry: Record<string, unknown>): string {
  if (present(entry.domain) || present(entry.sourcePort) || present(entry.sourceScheme)) {
    refuse(`${method} does not accept domain, sourcePort or sourceScheme; bind the cookie to an explicit url.`);
  }
  if (typeof entry.url !== 'string' || entry.url === '') {
    refuse(`${method} requires an explicit url so the affected origin stays authorized.`);
  }
  return entry.url;
}

/** Response headers keep their {name, value} shape; a Location header names another URL to authorize. */
function locationHeaderUrls(params: Record<string, unknown> | undefined): string[] {
  const headers = params?.responseHeaders;
  if (headers === undefined) return [];
  if (!Array.isArray(headers)) refuse('Fetch responseHeaders must be an array of { name, value } objects.');
  const collected: string[] = [];
  for (const header of headers) {
    if (!isRecord(header) || typeof header.name !== 'string' || typeof header.value !== 'string') {
      refuse('Fetch responseHeaders must be an array of { name, value } objects.');
    }
    if (header.name.toLowerCase() === 'location') collected.push(header.value);
  }
  return collected;
}

/**
 * Parameter-level conditions for otherwise-allowed methods. Returns every URL
 * the command touches beyond the current page so the caller can authorize each
 * one before dispatch; violations throw instead of silently narrowing scope.
 */
function validateCdpParams(method: string, params: Record<string, unknown> | undefined): string[] {
  switch (method) {
    case 'Network.getCookies': {
      const urls = params?.urls;
      if (!Array.isArray(urls) || !urls.length || urls.some(url => typeof url !== 'string' || url === '')) {
        refuse('Network.getCookies requires a non-empty urls array so every affected origin stays authorized.');
      }
      return [...urls] as string[];
    }
    case 'Network.setCookie':
      return [cookieEntryUrl(method, params ?? {})];
    case 'Network.setCookies': {
      const cookies = params?.cookies;
      if (!Array.isArray(cookies) || !cookies.length || cookies.some(cookie => !isRecord(cookie))) {
        refuse('Network.setCookies requires a non-empty cookies array of objects.');
      }
      return cookies.map(cookie => cookieEntryUrl(method, cookie as Record<string, unknown>));
    }
    case 'Network.deleteCookies':
      return [cookieEntryUrl(method, params ?? {})];
    case 'Page.deleteCookie': {
      const url = params?.url;
      if (typeof url !== 'string' || url === '') {
        refuse('Page.deleteCookie requires an explicit url so the affected origin stays authorized.');
      }
      return [url];
    }
    case 'Fetch.enable': {
      const patterns = params?.patterns;
      if (patterns === undefined) return [];
      if (!Array.isArray(patterns) || patterns.some(pattern => !isRecord(pattern))) {
        refuse('Fetch.enable patterns must be an array of request pattern objects.');
      }
      for (const pattern of patterns) {
        const resourceType = (pattern as Record<string, unknown>).resourceType;
        if (present(resourceType) && (typeof resourceType !== 'string' || resourceType === 'Document')) {
          refuse('Fetch.enable cannot intercept Document requests; Document interception is host-reserved for managed navigation.');
        }
      }
      return [];
    }
    case 'Fetch.continueRequest': {
      const url = params?.url;
      if (url === undefined) return [];
      if (typeof url !== 'string' || url === '') refuse('Fetch.continueRequest url must be a non-empty string.');
      return [url];
    }
    case 'Fetch.continueResponse':
    case 'Fetch.fulfillRequest':
      return locationHeaderUrls(params);
    default:
      return [];
  }
}

/**
 * Gate a raw CDP command. Returns the URLs the command affects beyond the
 * current page; the caller authorizes each one before dispatch.
 */
export function checkRawCdp(method: string, params?: unknown): string[] {
  const [domain, member, extra] = method.split('.');
  if (!domain || !member || extra) throw new BrowserError('invalid_request', 'A CDP method must be Domain.command.');
  const fields = present(params) ? object(params) : undefined;
  if (!CDP_DOMAINS.has(domain) || CDP_REFUSED.has(method) || refusedCdpParams(method, fields)) {
    const guidance = CDP_GUIDANCE.get(method) ?? 'Use the named browser operation.';
    throw new BrowserError('refused_by_policy', `${method} is not available through raw CDP. ${guidance}`);
  }
  return validateCdpParams(method, fields);
}

export function timeoutMs(input: unknown, fallback = 15_000): number {
  if (input === undefined) return fallback;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 1 || input > 60_000) {
    throw new BrowserError('invalid_request', 'timeoutMs must be between 1 and 60000.');
  }
  return Math.round(input);
}
