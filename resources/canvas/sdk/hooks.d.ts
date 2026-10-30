import type { CanvasThemeKind, CanvasTokens } from './tokens';
/** The resolved theme handed to a canvas. */
export interface CanvasHostTheme extends CanvasTokens {
    readonly kind: CanvasThemeKind;
    /** The same object, for canvases that destructure `{ tokens }`. */
    readonly tokens: CanvasTokens;
}
export type CanvasTextDirection = 'ltr' | 'rtl';
/** The IDE display language, for canvas-owned static labels. */
export interface CanvasHostLanguage {
    /** BCP-47-ish display locale, lowercased: `zh-cn`, `en-us`. */
    readonly locale: string;
    /** Primary subtag: `zh`, `en`. */
    readonly language: string;
    readonly direction: CanvasTextDirection;
    readonly isChinese: boolean;
    readonly isEnglish: boolean;
}
export type LocalizedTextBundle<T> = Readonly<{
    default: T;
} & Record<string, T>>;
export type SetCanvasState<T> = (action: T | ((prev: T) => T)) => void;
/** A host action. `type` selects the behaviour; the rest is its payload. */
export type CanvasAction = {
    type: string;
    [key: string]: unknown;
};
export interface SendToChatOptions {
    /**
     * Leave false so the text lands in the composer for the user to read and edit.
     * True submits without another user action, which is only right for a canvas
     * running an explicit automation the user asked for.
     */
    submit?: boolean;
    /** Start a fresh session instead of continuing the current one. */
    newChat?: boolean;
}
export type SendToChat = (text: string, options?: SendToChatOptions) => Promise<boolean>;
/** Options for a canvas-initiated annotation request. */
export interface CanvasAnnotationOptions {
    /**
     * Which control asked. Carried for diagnostics only — the window still runs
     * its own picker and collects the user's note there.
     */
    readonly sourceLabel?: string;
}
/** Options for a host action the canvas waits on. */
export interface CanvasActionRequestOptions {
    /** How long to wait before rejecting. Defaults to 30s. */
    readonly timeoutMs?: number;
    /**
     * Rejects the promise early. The host leg already in flight is NOT cancelled:
     * the bridge has no cancel channel, and pretending otherwise would leave a
     * canvas believing a write it started never happened.
     */
    readonly signal?: AbortSignal;
}
/** What the host injects into the page before the canvas module is evaluated. */
export interface CanvasBootstrap {
    filePath: string;
    themeKind: CanvasThemeKind;
    locale: string;
    /** Persisted `useCanvasState` values, from the `.canvas.data.json` sidecar. */
    data: Record<string, unknown>;
}
/**
 * Seed the bridge from the host's injected bootstrap. Called once by the page
 * before the canvas module is evaluated, so the first render already has the
 * right theme and persisted state rather than flashing defaults.
 */
export declare function initCanvasHost(bootstrap: CanvasBootstrap): void;
/** Apply a live theme change from the host. */
export declare function applyCanvasTheme(kind: CanvasThemeKind): void;
/**
 * Apply a live display-language change from the host. Paired with the theme
 * setter rather than left to a reload: both are app appearance settings the user
 * can change with a canvas already open, and only one of them updating would
 * leave the window half-stale.
 */
export declare function applyCanvasLanguage(locale: string): void;
/** Flush any coalesced state writes now. Called on page hide. */
export declare function flushCanvasState(): void;
/** The absolute path of the canvas being rendered. */
export declare function getCanvasFilePath(): string;
/**
 * Resolve an image reference into something an `<img src>` can use.
 *
 * Three forms go through unchanged because they already work in the page: a
 * `data:` URL, an `http(s):` URL, and an absolute `file:` URL. A RELATIVE path is
 * resolved against the canvas's own directory and handed back as a `file:` URL,
 * which is what makes `canvasImage('./shot.png')` work for an image the agent
 * saved beside the canvas.
 *
 * Never build a data URL by hand in a canvas: a base64 image inlined into source
 * is megabytes of text the model has to emit, and it will truncate.
 */
export declare function canvasImage(source: string): string;
/**
 * The active theme. Use `tokens.*` for any colour a canvas paints itself, so it
 * follows the app instead of pinning one appearance.
 */
export declare function useHostTheme(): CanvasHostTheme;
/** The active display language, for canvas-owned labels. */
export declare function useHostLanguage(): CanvasHostLanguage;
/**
 * Pick localized canvas-owned text. Falls back exact locale → primary language →
 * `default`, so a bundle only needs the languages it actually has.
 */
export declare function useLocalizedText<T>(bundle: LocalizedTextBundle<T>): T;
/**
 * State that survives a reload, persisted to the canvas's `.canvas.data.json`
 * sidecar. Use it for what the USER did — an open section, a selected row, a
 * filter — not for data the canvas should have embedded.
 */
export declare function useCanvasState<T>(key: string, defaultValue: T): [T, SetCanvasState<T>];
/**
 * Put text in the chat composer. Returns false when the host refuses, so a
 * button can show a failed state instead of silently doing nothing.
 */
export declare function sendToChat(text: string, options?: SendToChatOptions): Promise<boolean>;
/** A stable `sendToChat`, for handlers that need referential identity. */
export declare function useSendToChat(): SendToChat;
/**
 * Fire-and-forget host actions. The supported set is fixed host-side; an unknown
 * type is refused there rather than silently accepted here, so a typo surfaces.
 */
export declare function dispatchCanvasAction(action: CanvasAction): void;
/** A stable action dispatcher. */
export declare function useCanvasAction(): (action: CanvasAction) => void;
/**
 * Ask the window to enter annotation mode.
 *
 * The split matters and is the whole reason this is an intent rather than an API
 * that returns something: the WINDOW owns picking, the quote it builds, and the
 * note the user types; the canvas only asks for the mode to start. A canvas that
 * could read the selection would be able to watch the user point at things, and
 * a canvas is agent-authored code — so it gets the button, not the answer.
 *
 * Returns false when there is no window to ask, so a canvas-drawn button can
 * stay disabled instead of looking broken.
 */
export declare function startCanvasAnnotation(options?: CanvasAnnotationOptions): boolean;
/** A stable `startCanvasAnnotation`, for an onClick that keeps its identity. */
export declare function useCanvasAnnotation(options?: CanvasAnnotationOptions): () => void;
/**
 * Subscribe to canvas-initiated annotation requests. Called by the page, not by
 * a canvas: it exists so the frame does not have to hardcode the event name that
 * `startCanvasAnnotation` dispatches.
 */
export declare function onCanvasAnnotationRequest(listener: () => void): () => void;
/**
 * Host actions that answer.
 *
 * Separate from `useCanvasAction()` because the failure modes are opposite. A
 * fire-and-forget UI action swallows refusals on purpose — a canvas cannot
 * recover from "reveal failed" and throwing would unmount it. A request the
 * canvas is WAITING on must reject, or the canvas spins on a promise that never
 * settles and the user sees a permanent spinner with no error.
 *
 * The timeout is the reason this cannot just be `api().action(...)`: the bridge
 * promise has no deadline, so a host leg that never replies hangs forever.
 */
export declare function useCanvasActionRequest(): <T = unknown>(action: CanvasAction, options?: CanvasActionRequestOptions) => Promise<T>;
/**
 * Reveal the canvas file in the OS file manager. The one host action a canvas
 * gets by name rather than through the generic dispatcher, because "where is
 * this file" is the question a Canvas preview is always asked.
 */
export declare function revealCanvasFile(): void;
/** Register a page-hide flush. Called once by the page, not by a canvas. */
export declare function installCanvasStateFlush(): void;
