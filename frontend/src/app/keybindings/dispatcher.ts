// The in-window keybinding dispatcher.
//
// One keydown listener per binding, registered in the capture phase, with the
// chord state machine, the editable-surface exemptions and the two-tier
// dispatch priority.
// Nothing here is simplified: a binding may be a multi-segment chord, a handler
// may decline by returning false, and a later registration wins inside its
// priority tier.

import {
  CHORD_SEGMENT_TIMEOUT_MS,
  parseAcceleratorSegment,
  segmentMatches,
  splitAccelerator,
  type KeybindingPlatform,
  type ParsedSegment,
} from '../../../../contracts/keybindings';
import {
  isEditableSurfaceExempt,
  isWithinEditableSurface,
  isWithinShortcutCapture,
  targetWithinSelector,
} from './capture';

export type DispatchSource = 'keyboard_shortcut' | 'command_menu' | 'native_menu' | 'sidebar_help_menu';

export type CommandHandler = (source: DispatchSource, event?: KeyboardEvent) => boolean | void;

export interface CommandHandlerOptions {
  /** Checked before dispatch; a false answer skips this registration — the
   *  guard for whether a command applies, instead of `when`-clause
   *  expressions. */
  isActive?: (source: DispatchSource) => boolean;
  /** `normal` wins over `fallback`. Default `normal`. */
  priority?: 'normal' | 'fallback';
}

interface HandlerRegistration {
  handler: CommandHandler;
  isActive: (source: DispatchSource) => boolean;
  priority: 'normal' | 'fallback';
}

/** commandId -> registrations, dispatch order matters so it is an
 *  array, not a set. */
const handlers = new Map<string, HandlerRegistration[]>();

/** Handlers that exist even when no component registered one, so a
 *  command can still be dispatched from the native menu or the command menu. */
const fallbackHandlers = new Map<string, CommandHandler>();

export function registerFallbackCommandHandler(commandId: string, handler: CommandHandler): void {
  fallbackHandlers.set(commandId, handler);
}

export function unregisterFallbackCommandHandler(commandId: string): void {
  fallbackHandlers.delete(commandId);
}

export function hasFallbackCommandHandler(commandId: string): boolean {
  return fallbackHandlers.has(commandId);
}

/** How many components currently handle this command. The read-only dialog uses
 *  it as its gate: a command nobody can run is not listed. */
export function registeredHandlerCount(commandId: string): number {
  return handlers.get(commandId)?.length ?? 0;
}

export function registerCommandHandler(
  commandId: string,
  handler: CommandHandler,
  options: CommandHandlerOptions = {},
): () => void {
  const registration: HandlerRegistration = {
    handler,
    isActive: options.isActive ?? (() => true),
    priority: options.priority ?? 'normal',
  };
  const existing = handlers.get(commandId) ?? [];
  existing.push(registration);
  handlers.set(commandId, existing);
  return () => {
    const current = handlers.get(commandId);
    if (current == null) return;
    const index = current.lastIndexOf(registration);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) handlers.delete(commandId);
  };
}

/** Normal tier first (last registration wins), then fallback tier,
 *  then the always-present fallback map. A handler returning false means "not
 *  consumed", so dispatch continues downward. */
export function dispatchCommand(commandId: string, source: DispatchSource, event?: KeyboardEvent): boolean {
  const registrations = handlers.get(commandId);
  for (const priority of ['normal', 'fallback'] as const) {
    for (let index = (registrations?.length ?? 0) - 1; index >= 0; index -= 1) {
      const registration = registrations?.[index];
      if (registration == null || registration.priority !== priority) continue;
      if (!registration.isActive(source)) continue;
      if (registration.handler(source, event) !== false) return true;
    }
  }
  const fallback = fallbackHandlers.get(commandId);
  return fallback != null && fallback(source, event) !== false;
}

/** Dispatch with no keyboard event (menu click, command palette). */
export const runCommand = (commandId: string, source: DispatchSource = 'command_menu'): boolean =>
  dispatchCommand(commandId, source);

// ---------------------------------------------------------------------------
// key listener with chord support
// ---------------------------------------------------------------------------

export interface KeybindingListenerOptions {
  accelerator: string;
  platform: KeybindingPlatform;
  onKeyDown: (event: KeyboardEvent) => void;
  /** Only wired for hold-to-fire bindings; keyup is attached only then. */
  onKeyUp?: (event: KeyboardEvent) => void;
  /** Allow `event.repeat` through. Default false. */
  allowRepeat?: boolean;
  /** Fire even when focus is inside an editable surface. Default false. */
  allowWithinEditable?: boolean;
  /** Default true. */
  enabled?: boolean;
  /** Capture phase. Default true. */
  capture?: boolean;
  /** Restrict dispatch to events inside this selector. */
  onlyWithin?: string;
  /** Let a non-empty text selection inside `onlyWithin` win —
   *  binding ⌘B must not eat a copy gesture. */
  yieldToSelectedText?: boolean;
  /**
   * Extra gate evaluated on EVERY keydown, including the first segment of a
   * chord. Gating only at completion would be enough if a
   * surface-scoped command were unregistered while its surface is closed; Klaus
   * keeps one registration per binding and gates dynamically, so a chord that
   * cannot possibly complete here must not arm — arming calls preventDefault and
   * would steal the prefix from the command that does apply.
   */
  canStart?: (event: KeyboardEvent) => boolean;
  /** Extra selector to ignore. */
  ignoreWithin?: string;
  /** Listener target; defaults to window. */
  target?: EventTarget | null;
}

export interface KeybindingListenerHandle {
  dispose(): void;
}

/** Register one accelerator on one target. Returns a handle; the caller owns
 *  disposal. It is a plain function rather than a hook (`useEffect`) because
 *  non-React modules need it too, so the React layer wraps it. */
export function registerKeybindingListener(options: KeybindingListenerOptions): KeybindingListenerHandle {
  const {
    accelerator, platform, onKeyDown, onKeyUp,
    allowRepeat = false, allowWithinEditable = false, enabled = true, capture = true,
    onlyWithin, yieldToSelectedText = false, ignoreWithin, target, canStart,
  } = options;

  // `platform` drives the `CmdOrCtrl` split, NOT a module-level navigator sniff.
  // Deriving it per call is what makes the same binding resolve to meta on macOS
  // and ctrl on Windows/Linux; a sniffed constant would bind every platform to
  // whichever one the module first evaluated on.
  const isMac = platform === 'macOS';
  const segments: ParsedSegment[] = splitAccelerator(accelerator).map(segment => parseAcceleratorSegment(segment, isMac));
  const isChord = segments.length > 1;

  // Chord state: which segment is expected next, whether the binding already
  // fired (so keyup can pair with it), and the between-segment timeout.
  let fired = false;
  let firedSegment: ParsedSegment | null = null;
  let segmentIndex = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const resetProgress = (): void => {
    segmentIndex = 0;
    if (timeout != null) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
  const resetAll = (): void => {
    fired = false;
    firedSegment = null;
    resetProgress();
  };
  const armSegmentTimeout = (): void => {
    if (timeout != null) clearTimeout(timeout);
    timeout = setTimeout(resetProgress, CHORD_SEGMENT_TIMEOUT_MS);
  };

  const matchesSegment = (event: KeyboardEvent, segment: ParsedSegment | undefined): boolean =>
    segment != null && segmentMatches(event, segment);

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!enabled || typeof event.key !== 'string' || (!allowRepeat && event.repeat)) return;
    const expected = segments[segmentIndex];
    if (expected == null) return;
    const matched = matchesSegment(event, expected);
    // A chord that cannot complete in the current context must not arm: arming
    // calls preventDefault and would steal the prefix from whichever command
    // does apply here (⌘K inside the work panel vs ⌘K opening the command menu).
    if (canStart != null && segmentIndex === 0 && !canStart(event)) return;
    const allowedHere = (matched || segmentIndex !== 0)
      && !isWithinShortcutCapture(event)
      && !(ignoreWithin != null && targetWithinSelector(event.target, ignoreWithin))
      && (allowWithinEditable || (!isChord && isEditableSurfaceExempt(expected, event)) || !isWithinEditableSurface(event));
    if (!allowedHere) return;
    if (!matched) {
      // Wrong key mid-chord: drop the progress, but a key that happens to be
      // the FIRST segment starts a fresh chord rather than being ignored.
      resetProgress();
      const first = segments[0];
      if (first == null || !matchesSegment(event, first)) return;
    }
    if (!isChord) {
      fired = true;
      firedSegment = expected;
      onKeyDown(event);
      return;
    }
    segmentIndex += 1;
    if (segmentIndex < segments.length) {
      // Intermediate segment: swallow it so the browser does not act on the
      // prefix alone (⌘K without its second key), then wait for the rest.
      event.preventDefault();
      armSegmentTimeout();
      return;
    }
    // Final segment: dispatch BEFORE preventing default. Callers decide whether
    // the key was consumed — the runtime prevents default only when the command
    // actually ran — so marking it consumed here would make every chord silently
    // drop, because the runtime's handler ignores an already-prevented event.
    fired = true;
    firedSegment = segments[segments.length - 1] ?? null;
    resetProgress();
    onKeyDown(event);
  };

  const handleKeyUp = (event: KeyboardEvent): void => {
    if (!fired) return;
    const segment = firedSegment;
    if (segment == null) return;
    if (typeof event.key !== 'string') return;
    if (event.ctrlKey !== segment.requireCtrl || event.metaKey !== segment.requireMeta
      || event.altKey !== segment.requireAlt || event.shiftKey !== segment.requireShift) return;
    fired = false;
    firedSegment = null;
    onKeyUp?.(event);
  };

  const listenerTarget = target ?? (typeof window === 'undefined' ? null : window);
  if (listenerTarget == null) {
    resetAll();
    return { dispose: () => {} };
  }
  // EventTarget listeners are typed against Event, so narrow once here rather
  // than at every call site. The check is structural (`key` is a string) rather
  // than `instanceof KeyboardEvent`: in a browser a keydown target only ever
  // receives KeyboardEvent, and the structural form also works for the fake
  // targets the dispatcher tests drive it with.
  const keyDownListener = (event: Event): void => {
    if (typeof (event as KeyboardEvent).key === 'string') handleKeyDown(event as KeyboardEvent);
  };
  const keyUpListener = (event: Event): void => {
    if (typeof (event as KeyboardEvent).key === 'string') handleKeyUp(event as KeyboardEvent);
  };
  listenerTarget.addEventListener('keydown', keyDownListener, capture);
  if (onKeyUp != null) listenerTarget.addEventListener('keyup', keyUpListener, capture);
  return {
    dispose: () => {
      listenerTarget.removeEventListener('keydown', keyDownListener, capture);
      if (onKeyUp != null) listenerTarget.removeEventListener('keyup', keyUpListener, capture);
      resetAll();
    },
  };
}

/** The `onlyWithin` + `yieldToSelectedText` wrapper applied per binding:
 *  dispatch only inside the scope, and let a real text selection win so the
 *  binding cannot swallow a copy.
 *
 *  The target is read structurally (does it have `closest`? an `ownerDocument`
 *  with `getSelection`?) rather than via `instanceof Element`. In a browser a
 *  keydown target is always an Element, so the two forms agree; the structural
 *  form also keeps this rule testable without DOM globals, matching the capture
 *  module's `targetWithinSelector`. */
export function shouldDispatchWithinScope(event: KeyboardEvent, onlyWithin: string | undefined, yieldToSelectedText: boolean): boolean {
  if (event.defaultPrevented) return false;
  const rawTarget = event.target as { closest?: (sel: string) => unknown; ownerDocument?: { getSelection?: () => Selection | null } } | null | undefined;
  // The two DOM members are read once into locals: `closest` narrows the target
  // to something Element-like, and `getSelection` is only reachable through the
  // owner document that a matched scope implies.
  const closest = rawTarget != null && typeof rawTarget === 'object' ? rawTarget.closest : undefined;
  const scope = onlyWithin == null || typeof closest !== 'function'
    ? null
    : (closest.call(rawTarget, onlyWithin) as Element | null) ?? null;
  if (onlyWithin != null && scope == null) return false;
  const getSelection = rawTarget != null && typeof rawTarget === 'object' ? rawTarget.ownerDocument?.getSelection : undefined;
  const selection = yieldToSelectedText && scope != null && typeof getSelection === 'function'
    ? getSelection.call(rawTarget!.ownerDocument!)
    : null;
  const yielding = yieldToSelectedText
    && scope != null
    && selection?.anchorNode != null
    && selection.focusNode != null
    && scope.contains(selection.anchorNode)
    && scope.contains(selection.focusNode)
    && selection.toString().length > 0;
  return !yielding;
}
