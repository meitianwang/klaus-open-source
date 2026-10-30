// Serve the built frontend from a privileged custom scheme.
//
// WHY NOT `loadFile`. The Vite build emits ABSOLUTE asset paths — `frontend-dist/
// index.html` carries 38 `src="/assets/…"` / `href="/assets/…"` references and
// `vite.config.ts` sets no `base`, so it defaults to `/`. The build was written for the
// retired Rust shell, which served that directory from its own origin
// (`tauri://localhost`, with `"frontendDist": "../../frontend-dist"` in its window
// config), where `/assets/x` resolves against the origin. Under Electron's `file://` the
// same string resolves against the FILESYSTEM ROOT, so every module request 404s and the
// window stays blank.
//
// Changing `base` in `vite.config.ts` would fix the symptom but would modify a frontend
// build that has been shipping unchanged: plan §3 forbids maintaining a second UI
// ("不能复制一份 UI 再分别修改"), and §6.2 item 1 requires the existing frontend to load
// UNCHANGED. So the host adapts instead: serve the same directory from its own standard
// scheme, which reproduces the origin-relative resolution the build was written for.
// That second client is gone now, which removes the original reason for the constraint
// but not the conclusion — the bundle still loads as built, and this file is what makes
// it work.
//
// MEASURED, not assumed. Loading `klaus-app://app/index.html` in Electron 44.2.0 against
// the real `frontend-dist` boots the app to its login screen: `window.__KLAUS_DESKTOP__` present
// with keys `["core","event","window"]`, 106 KB of app-root HTML, 11 stylesheets, and the
// page issuing 47 invoke calls across 18 distinct channels. `standard: true` is what makes
// the absolute asset paths resolve; without it the scheme behaves like `file` and cannot
// resolve relative or absolute URLs (see `registerSchemesAsPrivileged` in electron.d.ts).
//
// Font assets, including the small KaTeX WOFF2 files, remain separate same-origin
// resources. The Vite build checks their emitted CSS references against the output
// assets so `font-src 'self'` can remain intact without blocked inline fonts.
// `connect-src` likewise lists `ipc: http://ipc.localhost`, which were the retired shell's
// own IPC schemes and are now VESTIGIAL: the bridge uses `contextBridge`/`ipcRenderer`,
// not `fetch`, so nothing on the page contacts either origin. Nothing is bypassed:
// `bypassCSP` is left at its default `false`, so the page's policy is enforced exactly as
// the frontend wrote it.

import { net, protocol } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { frontendDist } from '../paths';
import { APP_HOST, APP_SCHEME } from './trusted-origin';
import { isTrustedAppUrl } from './trusted-origin';
import { MEDIA_SCHEME } from '../services/media-files';
export { APP_HOST, APP_SCHEME } from './trusted-origin';

/**
 * The scheme the built frontend is served from.
 *
 * Chosen to be unambiguous and unrelated to `klaus-media:`, which is a SEPARATE existing
 * channel for local media assets (`media.rs:29`) and is ported on its own schedule — this
 * one only serves the UI bundle.
 */

/** The host part of the app origin, so URLs read as `klaus-app://app/index.html`. */

/** The URL of a page inside the bundle, e.g. `index.html` or `quick-input.html`. */
export function appUrl(page: string): string {
  const clean = page.replace(/^\/+/, '');
  return `${APP_SCHEME}://${APP_HOST}/${clean}`;
}

/**
 * Declare the scheme's privileges.
 *
 * MUST run before `app.whenReady()` and MUST be called exactly once — Electron documents
 * both constraints on `registerSchemesAsPrivileged`, and calling it after ready throws.
 * That is why this is a separate exported function the entry point calls at module scope
 * rather than inside a ready callback.
 *
 *   standard        resolve `/assets/…` against the origin — the whole point.
 *   secure          treat the origin as trustworthy, so `crypto.subtle` and friends work.
 *   supportFetchAPI let the page `fetch()` its own bundle resources.
 *   corsEnabled     module scripts and workers are fetched cross-origin by the loader.
 *   stream          `<video>`/`<audio>` expect buffered responses; the media surface needs
 *                   range-request style streaming rather than one big body.
 *   codeCache       V8 code cache for the bundle, only honoured when `standard` is set.
 *
 *   bypassCSP is deliberately OMITTED (default false): the frontend's own policy must
 *   stay in force. Weakening it to make a font load would trade a cosmetic console
 *   warning for losing XSS protection on the main window.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'klaus-pet', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

/**
 * Serve `frontend-dist` over the scheme. Call once after `app.whenReady()`.
 *
 * The root is resolved ONCE and every request is checked against it, because the handler
 * answers URLs it does not control: `decodeURIComponent` of an attacker-chosen path can
 * contain `..`, and a directory traversal here would read arbitrary files with the app's
 * own privileges. `relative()` is the check — a result starting with `..` or an absolute
 * path means the resolved target escaped the root, so it is refused with 403 rather than
 * served. Symlinks are not resolved here; the bundle contains none, and adding
 * `realpathSync` would turn a missing-file 404 into a throw.
 *
 * Missing files answer 404 rather than falling back to `index.html`. An SPA-style
 * fallback would be wrong for this app: the pages are distinct documents
 * (`index.html`, `quick-input.html`, `canvas.html`, `recorder.html`, `overlay.html`,
 * `artifact.html`) reached by their own windows, and silently serving the main window's
 * HTML for a mistyped asset path would produce a confusing blank secondary window instead
 * of an obvious failed request.
 */
export function serveFrontend(): { root: string; missing: boolean; close(): void } {
  const root = resolve(frontendDist());
  const missing = !existsSync(root);

  protocol.handle(APP_SCHEME, (request) => {
    if (!isTrustedAppUrl(request.url)) return new Response('forbidden', { status: 403 });
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('malformed url', { status: 400 });
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const target = join(root, pathname);
    const escaped = relative(root, target);
    if (escaped.startsWith('..') || isAbsolute(escaped)) {
      return new Response('forbidden', { status: 403 });
    }

    // `net.fetch` on a file URL is Electron's supported way to hand a local file to the
    // renderer: it sets the content type from the extension and supports range requests,
    // which the `stream` privilege above exists for.
    if (!existsSync(target)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });

  return { root, missing, close: () => protocol.unhandle(APP_SCHEME) };
}
