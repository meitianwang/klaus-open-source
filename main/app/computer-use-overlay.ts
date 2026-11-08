import { BrowserWindow, screen } from 'electron';

/**
 * The "Klaus is using your computer" banner shown while a Computer Use turn drives
 * input. It is a separate surface from the picture-in-picture projection of the
 * operated window: the projection shows WHAT is being controlled, this banner states
 * THAT control is active and how to take over. Neither replaces the other.
 *
 * The banner never steals focus and never swallows a click — the whole point is that
 * the person can grab the machine back at any moment, so it is non-activating and
 * click-through. Physical Escape is the stop affordance the copy advertises; the key
 * itself is watched by the native helper (see services/computer-use/escape-watch.ts),
 * not by this window.
 */

/** Banner copy, verbatim. Pinned by the computer-use observation contract vectors. */
export const COMPUTER_USE_OVERLAY_COPY = {
  en: { title: 'Klaus is using your computer', hint: 'Press Esc to stop' },
  zh: { title: 'Klaus 正在操作你的电脑', hint: '按 Esc 停止' },
} as const;

export type ComputerUseOverlayLanguage = keyof typeof COMPUTER_USE_OVERLAY_COPY;

export interface ComputerUseOverlayDependencies {
  /** Resolved UI language; anything with a `zh` prefix reads the zh copy. */
  language(): string | undefined;
  log(message: string): void;
}

/** Width/height of the pill. Kept here because the HTML layout assumes them. */
const OVERLAY_WIDTH = 420;
const OVERLAY_HEIGHT = 52;
/** Gap between the banner top and the work-area top edge. */
const OVERLAY_TOP_MARGIN = 12;

/** Centre a banner horizontally inside one display work area, near its top edge. */
export function overlayBannerBounds(area: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  return { x: Math.round(area.x + (area.width - OVERLAY_WIDTH) / 2), y: area.y + OVERLAY_TOP_MARGIN, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT };
}

/** Shared construction options: every banner is a non-activating, click-through panel. */
const bannerWindowOptions = () => ({
  title: 'Klaus Computer Use',
  width: OVERLAY_WIDTH,
  height: OVERLAY_HEIGHT,
  show: false,
  frame: false,
  transparent: true,
  resizable: false,
  movable: true,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  hasShadow: false,
  focusable: false,
  alwaysOnTop: true,
  backgroundColor: '#00000000',
  // A panel never activates the app when shown, so the banner cannot pull
  // focus from whatever the person or the automation is working in.
  ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
  webPreferences: {
    // No preload, no Node and no script: this is a static, click-through
    // status banner rendered from a fixed data URL.
    javascript: false,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    devTools: false,
  },
});

/** Shared post-construction behaviour: above other panels, on every workspace, click-through. */
function configureBanner(window: BrowserWindow): void {
  // Above normal overlays so it survives other always-on-top panels; visible on
  // every workspace including full-screen ones so it is never hidden by the app
  // the operator is being pulled into.
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Never eat a click: the person must be able to reach whatever is under it.
  window.setIgnoreMouseEvents(true);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function resolveLanguage(value: string | undefined): ComputerUseOverlayLanguage {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the banner document for one language. Dark mode is handled by the page via
 * `prefers-color-scheme`, so the same markup serves both appearances. The product
 * ships no right-to-left locale, so the layout is fixed left-to-right by design.
 */
export function computerUseOverlayHtml(language: ComputerUseOverlayLanguage): string {
  const copy = COMPUTER_USE_OVERLAY_COPY[language];
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: transparent; overflow: hidden;
    -webkit-user-select: none; user-select: none; cursor: default; }
  body { display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", system-ui, sans-serif; }
  .pill { display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 16px;
    border-radius: 20px; background: rgba(255, 255, 255, 0.82);
    box-shadow: 0 2px 16px rgba(0, 0, 0, 0.18); backdrop-filter: blur(18px) saturate(1.4);
    -webkit-backdrop-filter: blur(18px) saturate(1.4); }
  .dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: #f5a524;
    box-shadow: 0 0 0 0 rgba(245, 165, 36, 0.6); animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(245, 165, 36, 0.55); }
    70% { box-shadow: 0 0 0 7px rgba(245, 165, 36, 0); } 100% { box-shadow: 0 0 0 0 rgba(245, 165, 36, 0); } }
  .title { font-size: 13px; font-weight: 600; color: #1a1c1f; white-space: nowrap; }
  .sep { flex: none; width: 1px; height: 16px; background: rgba(0, 0, 0, 0.14); }
  .hint { font-size: 12px; font-weight: 500; color: #6b7280; white-space: nowrap; }
  @media (prefers-color-scheme: dark) {
    .pill { background: rgba(32, 34, 38, 0.82); box-shadow: 0 2px 18px rgba(0, 0, 0, 0.5); }
    .title { color: #f2f3f5; }
    .sep { background: rgba(255, 255, 255, 0.16); }
    .hint { color: #9aa0a6; }
  }
</style>
</head>
<body>
  <div class="pill">
    <span class="dot"></span>
    <span class="title">${escapeHtml(copy.title)}</span>
    <span class="sep"></span>
    <span class="hint">${escapeHtml(copy.hint)}</span>
  </div>
</body>
</html>`;
}

/**
 * One lazily created, reused banner window. `show` positions it over the display that
 * currently holds the cursor so it tracks the operator across monitors; `hide` keeps
 * the window alive for the next turn; `destroy` tears it down at shutdown.
 */
export class ComputerUseOverlay {
  private window?: BrowserWindow;
  private loadedLanguage?: ComputerUseOverlayLanguage;
  private destroyed = false;
  private allDisplays = false;
  private extras: BrowserWindow[] = [];
  constructor(private readonly deps: ComputerUseOverlayDependencies) {}

  get visible(): boolean {
    const window = this.window;
    return !!window && !window.isDestroyed() && window.isVisible();
  }

  /** Show the banner for the current turn; a visible banner stays where it is. Never throws. */
  show(): void {
    if (this.destroyed) return;
    try {
      const window = this.ensureWindow();
      // The banner is anchored where the turn started: automation moves the real
      // cursor across displays, and a banner that followed it would jump around.
      if (window.isVisible()) return;
      this.loadCopy(window, resolveLanguage(this.deps.language()));
      this.place(window);
      window.showInactive();
      if (this.allDisplays) this.layoutExtras();
    } catch (error) { this.deps.log(`computer use overlay failed to show: ${String(error)}`); }
  }

  /**
   * Cover every display instead of only the cursor's. Locked-use mode turns this
   * on: the screen was unlocked by automation, so the banner has to face whoever
   * walks up to any monitor. Applies immediately while visible; `hide` returns to
   * the single-display banner.
   */
  setAllDisplays(on: boolean): void {
    if (this.destroyed || this.allDisplays === on) return;
    this.allDisplays = on;
    if (!this.visible) return;
    if (on) this.layoutExtras(); else this.clearExtras();
  }

  /** Hide the banner without destroying it; a no-op when it is not up. */
  hide(): void {
    this.clearExtras();
    this.allDisplays = false;
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    try { if (window.isVisible()) window.hide(); }
    catch (error) { this.deps.log(`computer use overlay failed to hide: ${String(error)}`); }
  }

  /** Permanently tear the banner down; later `show` calls are ignored. */
  destroy(): void {
    this.destroyed = true;
    this.clearExtras();
    this.allDisplays = false;
    const window = this.window;
    this.window = undefined; this.loadedLanguage = undefined;
    if (window && !window.isDestroyed()) { try { window.destroy(); } catch { /* already gone */ } }
  }

  private ensureWindow(): BrowserWindow {
    let window = this.window;
    if (window && window.isDestroyed()) { window = undefined; this.window = undefined; this.loadedLanguage = undefined; }
    if (!window) {
      window = new BrowserWindow(bannerWindowOptions());
      configureBanner(window);
      window.on('closed', () => { if (this.window === window) { this.window = undefined; this.loadedLanguage = undefined; } });
      this.window = window;
    }
    return window;
  }

  /** (Re)load the banner document; only called while the window is hidden. */
  private loadCopy(window: BrowserWindow, language: ComputerUseOverlayLanguage): void {
    if (this.loadedLanguage === language) return;
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(computerUseOverlayHtml(language))}`);
    this.loadedLanguage = language;
  }

  /** Centre the banner horizontally on the cursor's display, near the top edge. */
  private place(window: BrowserWindow): void {
    try {
      window.setBounds(overlayBannerBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea));
    } catch (error) { this.deps.log(`computer use overlay failed to place: ${String(error)}`); }
  }

  /** One banner per display other than the cursor's; the pool is turn-scoped. */
  private layoutExtras(): void {
    try {
      const language = resolveLanguage(this.deps.language());
      const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const targets = screen.getAllDisplays().filter(display => display.id !== cursorDisplay.id);
      // A cheap rebuild whenever the display count changes keeps bounds and
      // displays paired without tracking identities across hot-plug events.
      if (this.extras.length !== targets.length) { this.clearExtras(); this.extras = targets.map(() => this.createBanner(language)); }
      this.extras.forEach((extra, index) => {
        if (extra.isDestroyed()) return;
        const target = targets[index];
        if (target) extra.setBounds(overlayBannerBounds(target.workArea));
        if (!extra.isVisible()) extra.showInactive();
      });
    } catch (error) { this.deps.log(`computer use overlay failed to cover displays: ${String(error)}`); }
  }

  private clearExtras(): void {
    for (const extra of this.extras) if (!extra.isDestroyed()) { try { extra.destroy(); } catch { /* already gone */ } }
    this.extras = [];
  }

  private createBanner(language: ComputerUseOverlayLanguage): BrowserWindow {
    const window = new BrowserWindow(bannerWindowOptions());
    configureBanner(window);
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(computerUseOverlayHtml(language))}`);
    return window;
  }
}
