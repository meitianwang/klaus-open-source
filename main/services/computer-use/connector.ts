import { savedImageMarkdown } from '../media';
import { randomUUID } from 'node:crypto';
import { ComputerUsePolicyService, type ComputerUseOperation } from './policy';
import { appGuidanceFor, appGuidancePrefix } from './app-guides';
import { actionLabel, stateText } from './format';
import { COMPUTER_USE_TOOLS } from './tools';
import type { CapturedAudio } from './audio';
import { normalizeKeyChord } from './keys';
import { appIdentity, deadline, number, object, sameApp, string, type AppIdentity, type AppSnapshot, type Bounds,
  type ComputerUseBackend, type ComputerUseContext, type ComputerUseResult, type DesktopSnapshot, type Element,
  type NativeRequest, type Row } from './types';
export { COMPUTER_USE_TOOLS } from './tools';

interface Owner {
  resourceId: string; generation: number; sequence: number; closing: boolean;
  controllers: Set<AbortController>; pending: Set<Promise<unknown>>;
  states: Map<string, { turnId: string; snapshot: AppSnapshot }>;
  taskScope: string;
  /** Bundle identifiers whose first-visit guidance this session already received. */
  guidesSent: Set<string>;
  /** Single-slot cache of the latest full-desktop observation geometry and identity. */
  desktop?: { turnId: string; app: AppIdentity | null; screenshot: { width: number; height: number };
    virtualBounds: Bounds; source: { width: number; height: number } };
  /** Left-button drag held across calls; x and y are physical desktop pixels. */
  desktopDrag?: { dragging: boolean; x: number; y: number };
  /** Sticky after a failed drag cleanup: the desktop input surface stays closed. */
  desktopClosed?: boolean;
  /** The turn a physical stop (Escape, or a locked-use takeover) refused; a new turn starts clean. */
  escStopped?: string;
  /** Verbatim refusal wording of a stopped turn; absent means the Escape stop wording. */
  stopMessage?: string;
}
export interface ComputerUseDependencies {
  policy: ComputerUsePolicyService; backend: ComputerUseBackend;
  saveScreenshot(data: string, mimeType: string): string;
  /** The full-desktop surface exists only where the native helper stitches displays; undefined elsewhere. */
  desktopAvailable?: boolean;
  /** Platform-specific wording a physical Escape stop delivers to the model. */
  escapeStopMessage?: string;
  /** An input action actually auto-unlocked the screen; the host arms the locked-use surface. */
  onAutoUnlocked?(sessionId: string, turnId: string): void;
  /** System audio capture spanning a start and a stop call; undefined where unavailable. */
  audio?: {
    start(sessionId: string, maxDurationMs: number, signal: AbortSignal): Promise<void>;
    stop(sessionId: string, signal: AbortSignal): Promise<CapturedAudio>;
  };
  /** Take the presentation epoch before metadata lookup or an approval await. */
  beginOperation?(sessionId: string): unknown;
  approvedWindow?(sessionId: string, epoch: unknown, surface: Row, signal: AbortSignal): Promise<void>;
  /** Recording and other host-exclusive interaction owners may reject input here. */
  guardInteraction?(sessionId: string, signal: AbortSignal): Promise<void>;
  /**
   * Reports why Computer Use is refused right now, e.g. the screen is locked and
   * the user has not allowed locked-screen control. Undefined means allowed.
   */
  refusal?(sessionId: string): string | undefined;
}
const writes = new Set(['click', 'perform_secondary_action', 'set_value', 'select_text', 'scroll', 'drag', 'press_key', 'type_text', 'paste']);
const desktopWrites = new Set(['desktop_click', 'desktop_drag', 'desktop_drag_handle', 'desktop_move', 'desktop_scroll',
  'desktop_type_text', 'desktop_press_key', 'desktop_paste']);
const DESKTOP_PLATFORM_ERROR = 'The full desktop surface is available only on Windows';
const DESKTOP_TURN_GATE = 'Call get_desktop_screenshot in this assistant turn before sending input';
const DESKTOP_IDENTITY_REQUIRED = 'Desktop input needs a foreground application; focus one and call get_desktop_screenshot again';
const DESKTOP_CLOSED = 'The desktop input session is closed after a failed cleanup; stop and report the error';
/** Model-readable physical-stop wording per platform; pinned by contract vectors. */
export const ESCAPE_STOP_MESSAGES = {
  macos: "This application session has been explicitly stopped by the user for this turn. Stop your work and send a final message noting they stopped the session and you're ready to continue if they want you to. Computer Use can be used again in the next assistant turn.",
  windows: 'Computer Use was stopped by the user with the physical Escape key. Stop your work, do not call further Computer Use tools in this turn, and send a final message noting that the user stopped Computer Use.',
} as const;
/** Model-readable locked-use takeover wording; pinned by the lockscreen contract vectors. */
export const LOCK_PAUSE_MESSAGES = {
  relocked: 'Physical keyboard or mouse input was detected, so the screen was re-locked and this Computer Use turn is paused. Ask the user to unlock the Mac manually; work can continue in a new turn.',
  relockFailed: 'Physical keyboard or mouse input was detected and this Computer Use turn is paused, but the screen could not be re-locked automatically. Ask the user to lock the Mac manually; work can continue in a new turn.',
} as const;
const text = (value: string): ComputerUseResult => ({ content: [{ type: 'text', text: value }] });
const keyOf = (app: AppIdentity) => `${app.path}\0${app.pid ?? 0}`;
function bounds(value: unknown): Bounds {
  const row = object(value, 'window bounds');
  return { x: number(row.x, 'x', -1_000_000, 1_000_000), y: number(row.y, 'y', -1_000_000, 1_000_000),
    width: number(row.width, 'width', 1, 100_000), height: number(row.height, 'height', 1, 100_000) };
}
/**
 * Reads the pixel geometry from a JPEG start-of-frame segment. The declared width and
 * height drive the screenshot-to-window coordinate mapping, so the encoded frame must
 * agree with them exactly; a truncated or inconsistent payload is rejected.
 */
function jpegFrame(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === undefined) return undefined;
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    if (marker === 0xda) return undefined;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8 || offset + 9 > bytes.length) return undefined;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}
export function snapshot(value: unknown, expected: AppIdentity): AppSnapshot {
  const row = object(value, 'state'), app = appIdentity(row.app);
  if (!sameApp(expected, app) || !app.pid) throw new Error('Computer Use application identity changed');
  if (!Array.isArray(row.elements) || row.elements.length > 500) throw new Error('Computer Use accessibility tree exceeds its limit');
  let textBytes = 0; const indexes = new Set<string>(), paths = new Set<string>();
  const elements = row.elements.map((item): Element => {
    const element = object(item, 'element');
    if (typeof element.settable !== 'boolean') throw new Error('Computer Use settable attribute must be a boolean');
    const result: Element = { index: string(element.index, 'element index', 16),
      path: string(element.path, 'element path', 256), depth: number(element.depth, 'element depth', 0, 8, true),
      settable: element.settable === true, actions: [] };
    if (indexes.has(result.index) || paths.has(result.path)) throw new Error('Computer Use accessibility identities are ambiguous');
    indexes.add(result.index); paths.add(result.path);
    for (const key of ['role', 'subrole', 'roleDescription', 'name', 'title', 'label', 'identifier', 'value', 'description', 'help'] as const) {
      if (element[key] != null) { result[key] = string(element[key], key, 4096, true); textBytes += Buffer.byteLength(result[key]!); }
    }
    if (textBytes > 512 * 1024) throw new Error('Computer Use accessibility text exceeds its limit');
    for (const key of ['enabled', 'focused'] as const) if (typeof element[key] === 'boolean') result[key] = element[key];
    if (!Array.isArray(element.actions) || element.actions.length > 64) throw new Error('Computer Use element actions are invalid');
    result.actions = element.actions.map(value => {
      const action = object(value, 'element action'); return { raw: string(action.raw, 'action', 128), description: string(action.description, 'action description', 512, true) };
    });
    if (element.bounds != null) result.bounds = bounds(element.bounds);
    return result;
  });
  const screenshot = object(row.screenshot, 'screenshot'), data = string(screenshot.data, 'image data', 20 * 1024 * 1024);
  const width = number(screenshot.width, 'image width', 1, 4096, true), height = number(screenshot.height, 'image height', 1, 4096, true);
  // The scan window only has to reach the start-of-frame segment; profile or metadata
  // segments precede it, entropy data never does.
  const frame = jpegFrame(Buffer.from(data.slice(0, 65_536), 'base64'));
  if (screenshot.mimeType !== 'image/jpeg' || width * height > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    || frame === undefined || frame.width !== width || frame.height !== height) throw new Error('Computer Use screenshot is invalid');
  const windowBounds = bounds(row.bounds), imageBounds = screenshot.bounds == null ? undefined : bounds(screenshot.bounds);
  if (imageBounds && (imageBounds.x < windowBounds.x || imageBounds.y < windowBounds.y
    || imageBounds.x + imageBounds.width > windowBounds.x + windowBounds.width
    || imageBounds.y + imageBounds.height > windowBounds.y + windowBounds.height)) throw new Error('Computer Use screenshot bounds extend outside the approved window');
  return { app, elements, windowId: number(row.windowId, 'window identifier', 1, Number.MAX_SAFE_INTEGER, true), bounds: windowBounds,
    ...(typeof row.treeTruncated === 'boolean' ? { treeTruncated: row.treeTruncated } : {}),
    ...(typeof row.loading === 'boolean' ? { loading: row.loading } : {}),
    ...(typeof row.observationChanged === 'boolean' ? { observationChanged: row.observationChanged } : {}),
    screenshot: { data, mimeType: 'image/jpeg', width, height, ...(imageBounds ? { bounds: imageBounds } : {}) } };
}
function enumValue(value: unknown, label: string, values: string[], fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`Invalid Computer Use ${label}`); return value;
}
export function validateAction(name: string, args: Row): Row {
  const result: Row = { name };
  if (['perform_secondary_action', 'set_value', 'select_text'].includes(name) || (args.element_index != null && args.element_index !== '')) result.element_index = string(args.element_index, 'element_index', 16);
  if (name === 'click') {
    result.click_count = args.click_count === undefined ? 1 : number(args.click_count, 'click_count', 1, 5, true);
    const button = typeof args.mouse_button === 'string' ? args.mouse_button.trim().toLowerCase() : args.mouse_button;
    result.mouse_button = enumValue(typeof button === 'string' ? ({ l: 'left', r: 'right', m: 'middle' } as Record<string, string>)[button] ?? button : button, 'mouse_button', ['left', 'right', 'middle'], 'left');
    if (args.key !== undefined) result.key = normalizeKeyChord(string(args.key, 'click key', 128));
    if (!result.element_index) { result.x = number(args.x, 'x', 0, 4096); result.y = number(args.y, 'y', 0, 4096); }
  }
  if (name === 'drag') for (const key of ['from_x', 'from_y', 'to_x', 'to_y']) result[key] = number(args[key], key, 0, 4096);
  if (name === 'perform_secondary_action') result.action = string(args.action, 'action', 512);
  if (name === 'set_value') result.value = string(args.value, 'value', 50_000, true);
  if (name === 'type_text') result.text = string(args.text, 'text', 50_000, true);
  if (name === 'select_text') {
    result.text = string(args.text, 'text', 50_000);
    result.prefix = args.prefix === undefined ? '' : string(args.prefix, 'prefix', 50_000, true);
    result.suffix = args.suffix === undefined ? '' : string(args.suffix, 'suffix', 50_000, true);
    result.selection = enumValue(args.selection, 'selection', ['text', 'cursor_before', 'cursor_after'], 'text');
  }
  if (name === 'scroll') {
    const direction = typeof args.direction === 'string' ? args.direction.trim().toLowerCase() : args.direction;
    result.direction = enumValue(typeof direction === 'string' ? ({ u: 'up', d: 'down', l: 'left', r: 'right' } as Record<string, string>)[direction] ?? direction : direction, 'direction', ['up', 'down', 'left', 'right'], 'down');
    result.pages = args.pages === undefined ? 1 : number(args.pages, 'pages', 0.1, 10);
    if (!result.element_index) { result.x = number(args.x, 'x', 0, 4096); result.y = number(args.y, 'y', 0, 4096); }
  }
  if (name === 'press_key') {
    result.key = normalizeKeyChord(string(args.key, 'key', 128));
  }
  if (name === 'paste') {
    result.text = string(args.text, 'text', 50_000, true);
    result.format = enumValue(args.format, 'format', ['text', 'md', 'html'], 'text');
  }
  if ((name === 'click' || name === 'press_key') && args.duration !== undefined) result.duration = number(args.duration, 'duration', 0, 30);
  return result;
}
function coordinates(state: AppSnapshot, x: unknown, y: unknown): { x: number; y: number } {
  const px = number(x, 'screenshot x', 0, state.screenshot.width - Number.EPSILON * state.screenshot.width);
  const py = number(y, 'screenshot y', 0, state.screenshot.height - Number.EPSILON * state.screenshot.height);
  const image = state.screenshot.bounds ?? state.bounds;
  return { x: image.x + px / state.screenshot.width * image.width, y: image.y + py / state.screenshot.height * image.height };
}
/**
 * Validates one stitched full-desktop observation. The encoded frame must agree with
 * the declared geometry exactly, like the windowed capture, because the screenshot
 * size drives the model-to-physical coordinate mapping for every desktop input.
 */
export function desktopSnapshot(value: unknown): DesktopSnapshot {
  const row = object(value, 'desktop state');
  const app = row.app == null ? null : appIdentity(row.app);
  if (app && !app.pid) throw new Error('Computer Use desktop application identity is incomplete');
  const screenshot = object(row.screenshot, 'screenshot'), data = string(screenshot.data, 'image data', 20 * 1024 * 1024);
  const width = number(screenshot.width, 'image width', 1, 4096, true), height = number(screenshot.height, 'image height', 1, 4096, true);
  const frame = jpegFrame(Buffer.from(data.slice(0, 65_536), 'base64'));
  if (screenshot.mimeType !== 'image/jpeg' || width * height > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    || frame === undefined || frame.width !== width || frame.height !== height) throw new Error('Computer Use desktop screenshot is invalid');
  const virtualBounds = bounds(row.virtualBounds);
  const sourceWidth = number(row.sourceWidth, 'source width', 1, 100_000, true), sourceHeight = number(row.sourceHeight, 'source height', 1, 100_000, true);
  if (sourceWidth * sourceHeight > 32_000_000) throw new Error('Computer Use desktop geometry exceeds its limit');
  if (!Array.isArray(row.displays) || !row.displays.length || row.displays.length > 16) throw new Error('Computer Use desktop display list is invalid');
  const displays = row.displays.map((item): { bounds: Bounds; width: number; height: number } => {
    const display = object(item, 'display');
    return { bounds: bounds(display.bounds), width: number(display.width, 'display width', 1, 100_000, true), height: number(display.height, 'display height', 1, 100_000, true) };
  });
  return { app, screenshot: { data, mimeType: 'image/jpeg', width, height }, virtualBounds, displays, sourceWidth, sourceHeight };
}
type DesktopCache = { turnId: string; app: AppIdentity | null; screenshot: { width: number; height: number };
  virtualBounds: Bounds; source: { width: number; height: number } };
export function validateDesktopAction(name: string, args: Row): Row {
  const point = (source: Row, labelX = 'x', labelY = 'y') => ({ x: number(source.x, labelX, 0, 4096), y: number(source.y, labelY, 0, 4096) });
  switch (name) {
    case 'desktop_click': {
      const result: Row = point(args);
      result.click_count = args.click_count === undefined ? 1 : number(args.click_count, 'click_count', 1, 3, true);
      const button = typeof args.mouse_button === 'string' ? args.mouse_button.trim().toLowerCase() : args.mouse_button;
      result.mouse_button = enumValue(typeof button === 'string' ? ({ l: 'left', r: 'right', m: 'middle' } as Record<string, string>)[button] ?? button : button, 'mouse_button', ['left', 'right', 'middle'], 'left');
      return result;
    }
    case 'desktop_move': return point(args);
    case 'desktop_scroll': {
      const result: Row = point(args);
      if (args.delta_x !== undefined) result.delta_x = number(args.delta_x, 'delta_x', -12000, 12000, true);
      if (args.delta_y !== undefined) result.delta_y = number(args.delta_y, 'delta_y', -12000, 12000, true);
      if (!result.delta_x && !result.delta_y) throw new Error('The desktop scroll needs a non-zero delta_x or delta_y');
      return result;
    }
    case 'desktop_type_text': return { text: string(args.text, 'text', 50_000, true) };
    case 'desktop_press_key': {
      const result: Row = { key: normalizeKeyChord(string(args.key, 'key', 128)) };
      if (args.duration !== undefined) result.duration = number(args.duration, 'duration', 0, 30);
      return result;
    }
    case 'desktop_paste': return { text: string(args.text, 'text', 50_000, true), format: enumValue(args.format, 'format', ['text', 'md', 'html'], 'text') };
    case 'desktop_drag': {
      if (!Array.isArray(args.path) || args.path.length < 2 || args.path.length > 16) throw new Error('The desktop drag path needs between 2 and 16 points');
      return { path: args.path.map(item => point(object(item, 'drag path point'), 'path x', 'path y')) };
    }
    case 'desktop_drag_handle': {
      const op = enumValue(args.op, 'drag handle op', ['start', 'move_to', 'end'], '');
      if (!op) throw new Error('The desktop drag handle needs op start, move_to or end');
      return op === 'end' ? { op } : { op, ...point(args) };
    }
    default: throw new Error('Unknown desktop input tool');
  }
}
/** Maps validated screenshot-pixel input onto physical virtual-desktop coordinates. */
function desktopActionValues(name: string, action: Row, cached: DesktopCache): Row {
  const app = cached.app!;
  // The exclusive edge mirrors the windowed mapping: a screenshot pixel coordinate
  // addresses pixel interiors, so the physical point stays inside the desktop.
  const map = (x: unknown, y: unknown) => {
    const px = number(x, 'desktop screenshot x', 0, cached.screenshot.width - Number.EPSILON * cached.screenshot.width);
    const py = number(y, 'desktop screenshot y', 0, cached.screenshot.height - Number.EPSILON * cached.screenshot.height);
    return { x: cached.virtualBounds.x + px / cached.screenshot.width * cached.source.width,
      y: cached.virtualBounds.y + py / cached.screenshot.height * cached.source.height };
  };
  const point = () => map(action.x, action.y);
  switch (name) {
    case 'desktop_click': return { name: 'click', app, ...point(), click_count: action.click_count, mouse_button: action.mouse_button };
    case 'desktop_move': return { name: 'move', app, ...point() };
    case 'desktop_scroll': return { name: 'scroll', app, ...point(),
      ...(action.delta_x === undefined ? {} : { delta_x: action.delta_x }), ...(action.delta_y === undefined ? {} : { delta_y: action.delta_y }) };
    case 'desktop_type_text': return { name: 'type_text', app, text: action.text };
    case 'desktop_press_key': return { name: 'press_key', app, key: action.key, ...(action.duration === undefined ? {} : { duration: action.duration }) };
    case 'desktop_paste': return { name: 'paste', app, text: action.text, format: action.format };
    case 'desktop_drag': return { name: 'drag', app,
      path: (action.path as Row[]).map(item => map(number(item.x, 'path x', 0, 4096), number(item.y, 'path y', 0, 4096))) };
    case 'desktop_drag_handle':
      if (action.op === 'start') return { name: 'mouse_down', app, ...point() };
      if (action.op === 'move_to') return { name: 'mouse_move', ...point() };
      // The caller substitutes the held physical point before releasing.
      return { name: 'mouse_up', x: 0, y: 0 };
    default: throw new Error('Unknown desktop input tool');
  }
}

/** The host authenticates calls; this object owns all session state and serializes desktop actions. */
export class ComputerUseConnector {
  readonly tools = COMPUTER_USE_TOOLS;
  private readonly owners = new Map<string, Owner>();
  private readonly pending = new Set<Promise<unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closing = false;
  constructor(private readonly deps: ComputerUseDependencies) {}
  attachSession(sessionId: string): void {
    string(sessionId, 'sessionId');
    if (this.closing || this.owners.has(sessionId)) throw new Error('Computer Use previous session owner must finish closing');
    if (this.owners.size >= 256) throw new Error('Computer Use session capacity exceeded');
    this.deps.policy.attachSession(sessionId);
    this.owners.set(sessionId, { resourceId: randomUUID(), generation: ++this.generation, sequence: 0, closing: false,
      controllers: new Set(), pending: new Set(), states: new Map(), guidesSent: new Set(), taskScope: this.deps.policy.taskScopeIdentity(sessionId) });
  }
  call(name: string, payload: unknown, context: ComputerUseContext): Promise<ComputerUseResult> {
    // A locked screen refuses new work before any tool state is touched, so a
    // remote turn cannot drive apps while the user is away.
    const refused = this.deps.refusal?.(context.sessionId);
    if (refused) return Promise.reject(new Error(refused));
    const owner = this.owners.get(context.sessionId), tool = this.tools.find(tool => tool.name === name);
    if (this.closing || !owner || owner.closing) return Promise.reject(new Error('Computer Use session owner is unavailable'));
    if (!tool) return Promise.reject(new Error('Unknown Computer Use tool'));
    if (owner.pending.size >= 8 || this.pending.size >= 64) return Promise.reject(new Error('Computer Use tool queue is full'));
    const args = { ...object(payload) }, allowed = new Set(Object.keys(tool.inputSchema.properties));
    // Older sessions may still submit the retired member from their tool catalog.
    if (name === 'set_computer_use_policy' && 'restricted_to_apps' in args) {
      if ('always_allowed_apps' in args) throw new Error('Supply only one saved app list');
      args.always_allowed_apps = args.restricted_to_apps;
      delete args.restricted_to_apps;
    }
    for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`Unknown Computer Use argument: ${key}`);
    let taskScope: string, restricted: boolean;
    try { taskScope = this.deps.policy.taskScopeIdentity(context.sessionId); restricted = this.deps.policy.taskScope(context.sessionId) !== undefined; }
    catch (error) { owner.states.clear(); for (const active of owner.controllers) active.abort(error); return Promise.reject(error); }
    if (owner.taskScope !== taskScope) { owner.states.clear(); owner.taskScope = taskScope; }
    const controller = new AbortController(), abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort(); owner.controllers.add(controller);
    const current = () => {
      controller.signal.throwIfAborted();
      if (this.closing || owner.closing || this.owners.get(context.sessionId) !== owner) throw new Error('Computer Use session owner is unavailable');
      try { this.deps.policy.assertTaskScopeCurrent(context.sessionId, taskScope); }
      catch (error) { owner.states.clear(); throw error; }
    };
    const invoke = async (method: NativeRequest['method'], values: Row, signal = controller.signal): Promise<unknown> => {
      current(); signal.throwIfAborted();
      const result = await this.deps.backend.request({ resourceId: owner.resourceId, operationId: randomUUID(), generation: owner.generation,
        sequence: ++owner.sequence, method, args: { ...values, ...(restricted ? { friendTaskRestricted: true } : {}) } }, signal);
      current(); signal.throwIfAborted(); return result;
    };
    const task = Promise.resolve().then(async () => {
      current();
      const turnId = string(context.turnId, 'turnId');
      // A physical Escape stop refuses the rest of this turn; the next turn starts clean.
      if (owner.escStopped === turnId) throw new Error(owner.stopMessage ?? this.escapeStopMessage());
      if (restricted) this.deps.policy.guardSession(context.sessionId);
      if (name === 'get_computer_use_policy') {
        const description = await this.deps.policy.describeSessionPolicy(context.sessionId, controller.signal); current(); return text(description);
      }
      if (name === 'set_computer_use_policy') {
        if (restricted) throw new Error('Friend tasks cannot change global Computer Use policy');
        const result = await this.deps.policy.setAppPolicy(args, controller.signal); current();
        return text(`${result.notes.join(' ')}\n\n${await this.deps.policy.describePolicy(controller.signal)}`);
      }
      if (name === 'start_audio_recording' || name === 'stop_audio_recording') {
        if (restricted) throw new Error('Friend tasks cannot record system audio');
        const audio = this.deps.audio;
        if (!audio) throw new Error('System audio recording is unavailable on this computer');
        if (name === 'start_audio_recording') {
          const limit = args.max_duration_ms === undefined ? 60000 : number(args.max_duration_ms, 'max_duration_ms', 100, 300000, true);
          await audio.start(context.sessionId, limit, controller.signal); current();
          return text(`Recording system audio. Capture stops automatically after ${limit} ms; call stop_audio_recording to retrieve the recording.`);
        }
        const captured = await audio.stop(context.sessionId, controller.signal); current();
        return { content: [{ type: 'text', text: `System audio recording stopped: ${(captured.recording.durationMs / 1000).toFixed(1)} s at ${captured.recording.sampleRate} Hz, ${captured.recording.channels} channels${captured.recording.limitReached ? '; the duration limit was reached' : ''}.` },
          { type: 'audio', data: captured.data.toString('base64'), mimeType: 'audio/wav' }] };
      }
      if (name === 'get_desktop_screenshot' || desktopWrites.has(name)) {
        if (!this.deps.desktopAvailable) throw new Error(DESKTOP_PLATFORM_ERROR);
        if (restricted) throw new Error('Friend tasks cannot control the full desktop');
        if (owner.desktopClosed) throw new Error(DESKTOP_CLOSED);
        const settings = this.deps.policy.sessionSettings(context.sessionId);
        if (!settings.enabled || !settings.availableOnThisPlatform) throw new Error('Computer Use is unavailable or disabled');
        if (name === 'get_desktop_screenshot') {
          const previous = this.tail;
          const operation = previous.catch(() => {}).then(async () => {
            current();
            await this.deps.guardInteraction?.(context.sessionId, controller.signal); current();
            const state = desktopSnapshot(await invoke('desktopState', {}));
            let lease: ComputerUseOperation | undefined;
            try {
              if (state.app) {
                lease = await this.deps.policy.approve(state.app, { ...context, signal: controller.signal });
                this.deps.policy.assertCurrent(lease);
              }
              const mapping = { screenshotPixelWidth: state.screenshot.width, screenshotPixelHeight: state.screenshot.height,
                screenshotScreenX: state.virtualBounds.x, screenshotScreenY: state.virtualBounds.y,
                screenshotScreenWidth: state.virtualBounds.width, screenshotScreenHeight: state.virtualBounds.height };
              // Only geometry and identity are needed for the next input. Retaining
              // base64 frames here would multiply image memory by sessions.
              const path = this.deps.saveScreenshot(state.screenshot.data, state.screenshot.mimeType);
              current();
              owner.desktop = { turnId, app: state.app, screenshot: { width: state.screenshot.width, height: state.screenshot.height },
                virtualBounds: state.virtualBounds, source: { width: state.sourceWidth, height: state.sourceHeight } };
              const focus = state.app ? `; input goes to ${state.app.name}` : '; no foreground application identity is available, so desktop input stays closed until an application window has focus';
              return { content: [{ type: 'text', text: `Saved: ${JSON.stringify(path)}\nEmbed: ${savedImageMarkdown(path)}\nFull desktop across ${state.displays.length} display(s): ${state.sourceWidth}x${state.sourceHeight} physical pixels, screenshot ${state.screenshot.width}x${state.screenshot.height}${focus}. Desktop input tools use screenshot pixel coordinates.` },
                { type: 'image', data: state.screenshot.data, mimeType: state.screenshot.mimeType }],
                structuredContent: { path, mimeType: state.screenshot.mimeType, saved: true },
                _meta: { klaus: { computerUse: { app: state.app, screenshotMode: 'desktop', displayCount: state.displays.length, mapping } } } };
            } finally { if (lease) this.deps.policy.release(lease); }
          });
          this.tail = operation.catch(() => {}); return await operation;
        }
        const action = validateDesktopAction(name, args);
        const pinned = owner.desktop;
        if (!pinned || pinned.turnId !== turnId) throw new Error(DESKTOP_TURN_GATE);
        if (!pinned.app) throw new Error(DESKTOP_IDENTITY_REQUIRED);
        const app = pinned.app;
        const lease = await this.deps.policy.approve(app, { ...context, signal: controller.signal });
        let enteredNative = false, completed = false;
        try {
          const check = () => { current(); this.deps.policy.assertCurrent(lease); };
          const native = async (method: NativeRequest['method'], values: Row) => { check(); const result = await invoke(method, values, lease.signal); check(); return result; };
          const previous = this.tail;
          const operation = previous.catch(() => {}).then(async () => {
            check();
            await this.deps.guardInteraction?.(context.sessionId, lease.signal); check();
            // A screenshot queued earlier in this turn may have replaced the cache;
            // input only proceeds against the exact pinned observation.
            const cached = owner.desktop;
            if (!cached || cached.turnId !== turnId || !cached.app || !sameApp(cached.app, app)) throw new Error(DESKTOP_TURN_GATE);
            const values = desktopActionValues(name, action, cached);
            if (name === 'desktop_drag_handle') {
              const drag = owner.desktopDrag, dragging = drag?.dragging === true;
              if (action.op === 'start' && dragging) throw new Error('drag handle can only be started once');
              if (action.op === 'move_to' && !dragging) throw new Error('drag handle must be started before moving');
              if (action.op === 'end') {
                if (!dragging) throw new Error('drag handle must be started before ending');
                values.x = drag!.x; values.y = drag!.y;
              }
              // Register the hold before the native call: a cancel between posting
              // the press and its response must still find a drag to release.
              if (action.op === 'start') owner.desktopDrag = { dragging: true, x: Number(values.x), y: Number(values.y) };
            }
            enteredNative = true; await native('desktopAction', values); completed = true;
            if (name === 'desktop_drag_handle') owner.desktopDrag = { dragging: action.op !== 'end', x: Number(values.x), y: Number(values.y) };
            return text(`Applied ${name}. Call get_desktop_screenshot to observe the result.`);
          });
          this.tail = operation.catch(() => {}); return await operation;
        } catch (error) {
          // A user stop surfaces its own wording; it is never an uncertain action.
          if (owner.escStopped === turnId) throw new Error(owner.stopMessage ?? this.escapeStopMessage());
          if (enteredNative && !completed) {
            owner.desktop = undefined;
            if (owner.desktopDrag?.dragging) await this.releaseDesktopDrag(owner);
            if (error instanceof Error && 'computerUseActionStarted' in error && error.computerUseActionStarted === false)
              throw new Error(`No input was sent. Call get_desktop_screenshot before trying again. ${error.message}`);
            throw new Error(`The desktop input may have executed, but its completion was not confirmed. Call get_desktop_screenshot before deciding whether to try again. ${error instanceof Error ? error.message : 'Computer Use failed'}`);
          }
          throw error;
        } finally { this.deps.policy.release(lease); }
      }
      if (name === 'list_apps') {
        if (restricted) {
          const scope = this.deps.policy.taskScope(context.sessionId)!;
          const apps = [];
          for (const selector of scope.apps) {
            current();
            const app = appIdentity(await invoke('resolve', { input: selector.slice(selector.startsWith('bundle:') ? 7 : 5) }));
            this.deps.policy.guardResolvedApp(context.sessionId, app); current();
            apps.push(`${app.name} (${app.path})`);
          }
          return text(apps.join('\n'));
        }
        const settings = this.deps.policy.sessionSettings(context.sessionId);
        if (!settings.enabled || !settings.availableOnThisPlatform) throw new Error('Computer Use is unavailable or disabled');
        const result = object(await invoke('listApps', {}));
        if (!Array.isArray(result.apps) || result.apps.length > 80) throw new Error('Computer Use app list is invalid');
        return text(result.apps.map(item => {
          const app = object(item); return `${string(app.name, 'app name')} (${string(app.path, 'app path')})${app.running === true ? ' [running]' : ''}${typeof app.bundleId === 'string' && app.bundleId ? `, bundle ID ${string(app.bundleId, 'bundle identifier')}` : ''}${typeof app.pid === 'number' ? `, pid ${number(app.pid, 'pid', 1, 0x7fffffff, true)}` : ''}${typeof app.lastUsed === 'string' ? `, last used ${string(app.lastUsed, 'last used', 128)}` : ''}${typeof app.useCount === 'number' ? `, uses ${number(app.useCount, 'use count', 0, Number.MAX_SAFE_INTEGER, true)}` : ''}`;
        }).join('\n') || 'No applications are available.');
      }
      if (args.disable_diff !== undefined && typeof args.disable_diff !== 'boolean') throw new Error('Invalid Computer Use disable_diff');
      const input = string(args.app, 'app').trim();
      const action = writes.has(name) ? validateAction(name, args) : undefined;
      this.deps.policy.guardInput(context.sessionId, input);
      const epoch = this.deps.beginOperation?.(context.sessionId);
      const resolved = appIdentity(await invoke('resolve', { input }));
      const lease = await this.deps.policy.approve(resolved, { ...context, signal: controller.signal });
      let enteredAction = false, actionCompleted = false;
      try {
        const check = () => { current(); this.deps.policy.assertCurrent(lease); };
        const native = async (method: NativeRequest['method'], values: Row) => { check(); const result = await invoke(method, values, lease.signal); check(); return result; };
        const previous = this.tail;
        const operation = previous.catch(() => {}).then(async () => {
          check();
          await this.deps.guardInteraction?.(context.sessionId, lease.signal); check();
          const cached = owner.states.get(keyOf(resolved));
          if (action && (!cached || cached.turnId !== turnId)) throw new Error(`Call get_app_state for ${input} in this assistant turn before sending input`);
          const activateResult = await native('activate', { app: resolved, inputAction: !!action });
          if (object(activateResult).autoUnlocked === true) this.deps.onAutoUnlocked?.(context.sessionId, turnId);
          const active = appIdentity(activateResult);
          if (!sameApp(resolved, active)) throw new Error('Computer Use activated application identity changed');
          if (action && cached) {
            const values: Row = { ...action, app: active, windowId: cached.snapshot.windowId, windowBounds: cached.snapshot.bounds };
            if (action.element_index) {
              const element = cached.snapshot.elements.find(element => element.index === action.element_index);
              if (!element) throw new Error(`Unknown element_index: ${action.element_index}`);
              values.element = element;
              if (name === 'perform_secondary_action') {
                const selected = element.actions.find(item => item.raw === action.action || item.description === action.action || actionLabel(item) === action.action);
                if (!selected) throw new Error('The element does not expose that secondary action'); values.action = selected.raw;
              }
            } else if (name === 'click' || (name === 'scroll' && !action.element_index)) values.point = coordinates(cached.snapshot, action.x, action.y);
            if (name === 'drag') { values.from = coordinates(cached.snapshot, action.from_x, action.from_y); values.to = coordinates(cached.snapshot, action.to_x, action.to_y); }
            if (name === 'press_key' || name === 'type_text' || name === 'paste') values.focusedElement = cached.snapshot.elements.find(element => element.focused);
            enteredAction = true;
            const actionResult = await native('action', values);
            if (object(actionResult).autoUnlocked === true) this.deps.onAutoUnlocked?.(context.sessionId, turnId);
            actionCompleted = true;
          }
          const state = snapshot(await native('state', { app: active }), active);
          const image = state.screenshot.bounds ?? state.bounds;
          const mapping = { screenshotPixelWidth: state.screenshot.width, screenshotPixelHeight: state.screenshot.height,
            screenshotScreenX: image.x, screenshotScreenY: image.y, screenshotScreenWidth: image.width, screenshotScreenHeight: image.height };
          await this.deps.approvedWindow?.(context.sessionId, epoch, { app: state.app, windowId: state.windowId, mapping }, lease.signal); check();
          // Only dimensions and the element tree are needed for the next action.
          // Retaining base64 captures here would multiply image memory by sessions.
          const path = this.deps.saveScreenshot(state.screenshot.data, state.screenshot.mimeType);
          check();
          owner.states.set(keyOf(state.app), { turnId, snapshot: { ...state, screenshot: { ...state.screenshot, data: '' } } });
          if (owner.states.size > 16) owner.states.delete(owner.states.keys().next().value!);
          while ([...this.owners.values()].reduce((total, owner) => total + owner.states.size, 0) > 128) {
            const oldest = [...this.owners.values()].find(value => value.states.size && value !== owner) ?? owner;
            oldest.states.delete(oldest.states.keys().next().value!);
          }
          // Observations diff from the state the model was last shown; the full
          // tree stays available on request, and an action diffs against its own
          // pre-action observation so the effect of the input stays visible.
          const previous = action || args.disable_diff !== true ? cached?.snapshot : undefined;
          const observationText = `Saved: ${JSON.stringify(path)}\nEmbed: ${savedImageMarkdown(path)}\n${stateText(state, previous)}`;
          // First-visit app guidance rides along with the observation text, once
          // per app per session, so the know-how arrives with the first look.
          const guidance = state.app.bundleId !== undefined && !owner.guidesSent.has(state.app.bundleId) ? appGuidanceFor(state.app) : undefined;
          if (guidance !== undefined) owner.guidesSent.add(state.app.bundleId!);
          return { content: [{ type: 'text', text: guidance === undefined ? observationText : appGuidancePrefix(guidance) + observationText }, { type: 'image', data: state.screenshot.data, mimeType: state.screenshot.mimeType }],
            structuredContent: { path, mimeType: state.screenshot.mimeType, saved: true },
            _meta: { klaus: { computerUse: { app: state.app, windowId: state.windowId, screenshotMode: 'alwaysInclude', elementCount: state.elements.length, mapping } } } };
        });
        this.tail = operation.catch(() => {}); return await operation;
      } catch (error) {
        // A user stop surfaces its own wording; it is never an uncertain action.
        if (owner.escStopped === turnId) throw new Error(owner.stopMessage ?? this.escapeStopMessage());
        if (enteredAction) {
          owner.states.delete(keyOf(resolved));
          if (!actionCompleted && error instanceof Error && 'computerUseActionStarted' in error && error.computerUseActionStarted === false) {
            throw new Error(`No input was sent. Read get_app_state before trying again. ${error.message}`);
          }
          throw new Error(`The action may have executed, but its final state was not confirmed. Read get_app_state before deciding whether to try again. ${error instanceof Error ? error.message : 'Computer Use failed'}`);
        }
        throw error;
      } finally { this.deps.policy.release(lease); }
    }).finally(() => {
      context.signal.removeEventListener('abort', abort); owner.controllers.delete(controller); owner.pending.delete(task); this.pending.delete(task);
    });
    owner.pending.add(task); this.pending.add(task); return task;
  }
  /** Best-effort release of a held desktop drag; a failed cleanup closes the desktop input surface. */
  private async releaseDesktopDrag(owner: Owner, budgetMs = 5000): Promise<void> {
    const drag = owner.desktopDrag;
    if (!drag?.dragging) return;
    owner.desktopDrag = { dragging: false, x: drag.x, y: drag.y };
    const budget = Number.isFinite(budgetMs) ? Math.max(500, Math.min(5000, budgetMs)) : 5000;
    try {
      await this.deps.backend.request({ resourceId: owner.resourceId, operationId: randomUUID(), generation: owner.generation,
        sequence: ++owner.sequence, method: 'desktopAction', args: { name: 'mouse_up', x: drag.x, y: drag.y } }, AbortSignal.timeout(budget));
    } catch { owner.desktopClosed = true; }
  }
  /** Wording surfaced to the model when the user pressed the physical Escape key. */
  private escapeStopMessage(): string { return this.deps.escapeStopMessage ?? ESCAPE_STOP_MESSAGES.macos; }
  /**
   * Physical emergency stop for one session: refuses the rest of the given turn and
   * aborts in-flight calls with the stop wording. `message` overrides the wording (a
   * locked-use takeover pauses with its own text); the next turn starts clean.
   */
  stopTurn(sessionId: string, turnId: string, message?: string): void {
    const owner = this.owners.get(sessionId);
    if (!owner || owner.closing || owner.escStopped === turnId) return;
    owner.escStopped = turnId;
    owner.stopMessage = message;
    const stop = new Error(message ?? this.escapeStopMessage());
    for (const controller of owner.controllers) controller.abort(stop);
  }
  /** True when a physical Escape stop already refused this session's current turn. */
  turnStopped(sessionId: string, turnId: string): boolean {
    return this.owners.get(sessionId)?.escStopped === turnId;
  }
  async closeSession(sessionId: string, deadlineMs = 5000): Promise<{ complete: boolean }> {
    const owner = this.owners.get(sessionId); if (!owner) return { complete: true };
    owner.closing = true; owner.states.clear(); for (const controller of owner.controllers) controller.abort(new Error('Computer Use session closed'));
    const started = performance.now();
    const drained = await deadline(Promise.allSettled([...owner.pending]), deadlineMs);
    // A button held across calls must not outlive its session; the release is
    // best-effort and never blocks the close path.
    await this.releaseDesktopDrag(owner, Math.max(0, deadlineMs - (performance.now() - started)));
    const policy = await this.deps.policy.detachSession(sessionId, Math.max(0, deadlineMs - (performance.now() - started)));
    const complete = drained && !owner.pending.size && policy.complete;
    if (complete && this.owners.get(sessionId) === owner) this.owners.delete(sessionId);
    return { complete };
  }
  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closing = true; const started = performance.now();
    const owners = await Promise.all([...this.owners.keys()].map(session => this.closeSession(session, deadlineMs)));
    const remaining = () => Math.max(0, deadlineMs - (performance.now() - started));
    const native = await this.deps.backend.close(remaining()), policy = await this.deps.policy.close(remaining());
    return { complete: owners.every(owner => owner.complete) && native.complete && policy.complete && !this.pending.size };
  }
}
