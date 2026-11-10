// Window creation: one BrowserWindow per role, each with its OWN preload and flags.
//
// Plan §6.2 item 2 — "各窗口独立最小权限：主窗口、Quick Input、Canvas 不能共用一份全权限
// preload" (the main window, Quick Input and Canvas must not share one all-privileged
// preload). That is satisfied by construction here: `PRELOAD_FOR` maps each role to a
// different bundled file, and every role gets the same hardened `webPreferences`. There is
// no code path by which one window is created with another's preload, because the preload
// is chosen from the role rather than passed in by the caller.
//
// THE SECURITY FLAGS ARE NON-NEGOTIABLE AND IDENTICAL FOR EVERY WINDOW. Set once in
// `securePreferences` so a new window cannot forget one:
//
//   contextIsolation: true            the preload's context is not the page's. Without it
//                                     a page could reach `ipcRenderer` directly and skip
//                                     the shim's capability list entirely.
//   sandbox: true                     the preload gets no Node. Measured: in this
//                                     configuration a preload can require only
//                                     `electron`, `events`, `url` and `timers` — which is
//                                     exactly why the preloads are bundled by esbuild
//                                     (see scripts/build-preload.mjs).
//   nodeIntegration: false            the page gets no Node either.
//   nodeIntegrationInSubFrames: false the default, asserted explicitly because the main
//                                     window renders AGENT-AUTHORED html in an iframe
//                                     (`workspace-panel.ts:1021-1023`,
//                                     `sandbox="allow-scripts"` and deliberately no
//                                     `allow-same-origin`). A subframe must never receive
//                                     a preload. `attributeCaller` refuses non-top frames
//                                     independently, so neither mechanism alone is the
//                                     guarantee — that is the point.
//   webviewTag: false                 the embedded browser is a WebContentsView owned by
//                                     the main process (plan §2, P3), NOT a renderer-created
//                                     `<webview>`. Allowing the tag would let a page open
//                                     an arbitrary web contents with its own privileges.
//
// WHERE THE GEOMETRY CAME FROM. THIS FILE IS NOW THE AUTHORITY: the sizes and chrome
// below were originally chosen to mirror the retired Rust shell's own creation calls so
// the ported app looked and behaved the same, and they were verified against it at that
// time. They are not kept in sync with anything — read the `BrowserWindow` options as the
// contract. Recorded here only as the reason each number exists:
//
//   main         1280x820, min 480x600, hidden until boot, traffic lights at {16,16}.
//                Its titlebar chrome is macOS-only now: `titleBarStyle: 'hidden'` and
//                `transparent` apply on darwin alone, while win32 uses `'default'` with
//                no overlay, i.e. a native caption strip the page does not draw under.
//   quick-input  680x104, "Klaus Quick Input", not resizable/decorated, transparent,
//                always-on-top, all workspaces, skip taskbar, not
//                minimizable/maximizable, hidden until shown
//   recorder     240x64, "Klaus Skill Recording", same transient chrome, visible
//   overlay      covers the display union, "Klaus Computer Use Cursor", same transient
//                chrome, visible, and ignores cursor events — it must never eat a click
//
// That list predates the artifact and canvas roles, which this host added and which have
// no counterpart in the old shell.
//
// The shell's `titleBarStyle: "Overlay"` has no Electron value of that name; on macOS the
// equivalent is `'hidden'`, which keeps the traffic lights while letting content extend
// under them, and `trafficLightPosition` places them where the shell did.

import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

import { appRoot } from '../paths';
import { appUrl } from './protocol';
import { isTrustedAppUrl } from './trusted-origin';
import { blocksWidgetFrameNavigation } from './widget-navigation';

/** The window roles, matching the contract's `roles[].role`. */
export type WindowRoleName = 'main' | 'artifact' | 'quick-input' | 'canvas' | 'prototype' | 'video-editing' | 'ppt' | 'recorder' | 'overlay' | 'pet' | 'voice-chat';

/**
 * Which bundled preload each role gets.
 *
 * Each interactive role has its own bundled preload.
 *
 *   overlay  -> NONE       `overlay.html` invokes nothing and subscribes nothing; the shell
 *                          drives it one way with `window.eval()` (in Electron,
 *                          `webContents.executeJavaScript`). Its contract role is
 *                          `{invoke: [], push: []}`, and the correct implementation of that
 *                          is no preload at all — an isolated-world script that publishes an
 *                          empty shim would be surface without purpose, since nothing on
 *                          that page reads `window.__KLAUS_DESKTOP__`.
 *                          `tests/ipc-contract.test.ts` asserts `overlay.html` contains no
 *                          `core.invoke`, so this stays checked rather than remembered.
 */
const PRELOAD_FOR: Record<WindowRoleName, string | null> = {
  main: 'main.js',
  artifact: 'artifact.js',
  'quick-input': 'quick-input.js',
  canvas: 'canvas.js',
  prototype: 'prototype.js',
  'video-editing': 'video-editing.js',
  ppt: 'ppt.js',
  recorder: 'recorder.js',
  overlay: null,
  pet: 'pet.js',
  'voice-chat': 'voice-chat.js',
};

/** The preload bundle path for a role, or null when the role gets none. */
export function preloadFor(role: WindowRoleName): string | null {
  const file = PRELOAD_FOR[role];
  return file === null ? null : join(appRoot(), 'dist', 'preload', file);
}

/**
 * The hardened preferences every window shares.
 *
 * Spread per-window rather than exported as a frozen object, because Electron mutates the
 * options it is handed and a shared reference would let one window's tweak leak into the
 * next.
 */
function securePreferences(role: WindowRoleName): Electron.WebPreferences {
  const preload = preloadFor(role);
  return {
    ...(preload === null ? {} : { preload }),
    devTools: !app.isPackaged,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    // The role travels to the preload through argv, which a sandboxed preload can read
    // (`process.argv`) and a page under contextIsolation cannot see at all. It selects
    // which shim members the preload publishes; it never authorises anything. The main
    // process resolves the authoritative role from its own registry keyed by WebContents
    // id (`WindowRoleRegistry`), so a renderer editing this list gains shim members, not
    // privileges — pinned by `tests/ipc-binding.test.ts` ("a page cannot escalate by
    // declaring a different role in the payload").
    additionalArguments: [`--klaus-role=${role}`],
  };
}

/** Common chrome for the transient, always-on-top panels. */
const TRANSIENT = {
  resizable: false,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  minimizable: false,
  maximizable: false,
} as const;

/** A transparent companion surface with a separately scoped preload. */
export function createPetWindow(): BrowserWindow {
  return createTrustedWindow({
    ...TRANSIENT,
    title: 'Klaus Pet',
    width: 480,
    height: 320,
    show: false,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    focusable: false,
    ...(process.platform === 'darwin' ? {
      type: 'panel' as const,
      acceptFirstMouse: true,
      // The transparent drawing surface extends beyond the constrained visible content.
      enableLargerThanScreen: true,
    } : {}),
    webPreferences: { ...securePreferences('pet'), backgroundThrottling: false },
  });
}

function createTrustedWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const window = new BrowserWindow(options);
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', event => {
    // A widget's opaque iframe may otherwise navigate itself to an external URL,
    // bypassing connect-src through a top-level navigation of that child frame.
    if (blocksWidgetFrameNavigation(event.initiator?.url, event.frame?.url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return window;
}

/** The live call stays accessible when its conversation is out of view. */
export function createVoiceChatWindow(): BrowserWindow {
  return createTrustedWindow({
    ...TRANSIENT, title: 'Klaus Voice Chat', width: 356, height: 320, focusable: false,
    show: false, hasShadow: false, fullscreenable: false, backgroundColor: '#00000000',
    ...(process.platform === 'darwin' ? { type: 'panel' as const, acceptFirstMouse: true } : {}),
    webPreferences: { ...securePreferences('voice-chat'), backgroundThrottling: false },
  });
}

/**
 * Create the MAIN window.
 *
 * Creating the window hidden is not an oversight — the host
 * keeps the window invisible until boot completes so the user never sees a half-built
 * frame. The caller decides when to `show()`. The retired Rust shell did the same with
 * `visible:false` in its window config.
 */
export function createMainWindow(productName = 'Klaus'): BrowserWindow {
  const window = createTrustedWindow({
    title: productName,
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 600,
    show: false,
      transparent: process.platform === 'darwin',
      titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
      titleBarOverlay: false,
    trafficLightPosition: { x: 16, y: 16 },
    // macOS draws this window transparent. HTML fullscreen then resizes it into
    // native fullscreen, and that transition exits element fullscreen, so a
    // video's fullscreen control snaps the picture back and looks dead. Keep
    // the video in the page top layer instead of resizing the window.
    webPreferences: {
      ...securePreferences('main'),
      ...(process.platform === 'darwin' ? { disableHtmlFullscreenWindowResize: true } : {}),
    },
  });
  // Shared frontend HTML must not replace the packaged product's window identity.
  window.on('page-title-updated', event => event.preventDefault());
  return window;
}

/**
 * Create an ARTIFACT / memory / skill preview window.
 *
 * A dedicated preload and role expose the small artifact bridge.
 */
export function createArtifactWindow(productName = 'Klaus'): BrowserWindow {
  return createTrustedWindow({
    title: productName,
    width: 980,
    height: 720,
    minWidth: 480,
    minHeight: 480,
    show: false,
    transparent: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#ffffff', symbolColor: '#1a1c1f', height: 42 } : false,
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      ...securePreferences('artifact'),
      ...(process.platform === 'darwin' ? { disableHtmlFullscreenWindowResize: true } : {}),
    },
  });
}

/**
 * Create the QUICK INPUT window.
 *
 * 680x104 and invisible until summoned (`quick_input.rs:28-29,420`). The caller positions
 * it; `quick_input.rs:151` centres it horizontally over the target display, which is a
 * placement concern rather than a construction one.
 */
export function createQuickInputWindow(): BrowserWindow {
  return createTrustedWindow({
    title: 'Klaus Quick Input',
    width: 680,
    height: 104,
    show: false,
    ...TRANSIENT,
    webPreferences: securePreferences('quick-input'),
  });
}

/**
 * Create the COMPUTER-USE RECORDER panel (240x64, `recorder.rs:261`).
 *
 * Visible on creation, unlike quick input: the panel's whole purpose is to show that a
 * recording is in progress.
 */
export function createRecorderWindow(lang?: string): BrowserWindow {
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : '';
  const window = createTrustedWindow({
    title: 'Klaus Skill Recording',
    width: 240,
    height: 64,
    show: true,
    ...TRANSIENT,
    webPreferences: securePreferences('recorder'),
  });
  // The language is part of the URL in the shell (`recorder.html?lang=…`), so it is set at
  // load time rather than as a constructor option.
  void window.loadURL(appUrl(`recorder.html${query}`));
  return window;
}

/**
 * Create the COMPUTER-USE CURSOR OVERLAY, covering every display.
 *
 * Two properties matter and are easy to lose:
 *
 *   1. It spans the UNION of all display bounds (`overlay.rs:83-87`, `display_union`), so
 *      a cursor drawn on any monitor is visible.
 *   2. It must NEVER eat a click (`overlay.rs:112`,
 *      `set_ignore_cursor_events(true)`), because it covers the entire desktop. Without
 *      that the app would swallow every mouse event on the machine.
 *
 * No preload at all — see `PRELOAD_FOR.overlay`.
 */
export function createOverlayWindow(): BrowserWindow | null {
  const bounds = displayUnion();
  if (bounds === null) return null;

  const window = createTrustedWindow({
    title: 'Klaus Computer Use Cursor',
    x: bounds.x,
    y: bounds.y,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
    show: true,
    ...TRANSIENT,
    webPreferences: securePreferences('overlay'),
  });
  window.setIgnoreMouseEvents(true);
  void window.loadURL(appUrl('overlay.html'));
  return window;
}

/**
 * The bounding box covering every display.
 *
 * Returns null when there are none, which the caller treats as "do not create the
 * overlay" rather than as a zero-size window — a 0x0 always-on-top transparent window is
 * harmless but pointless, and `overlay.rs:84-86` logs and bails in the same situation.
 */
export function displayUnion(): { x: number; y: number; width: number; height: number } | null {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
