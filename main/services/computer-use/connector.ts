import { savedImageMarkdown } from '../media';
import { randomUUID } from 'node:crypto';
import { ComputerUsePolicyService } from './policy';
import { actionLabel, stateText } from './format';
import { COMPUTER_USE_TOOLS } from './tools';
import type { CapturedAudio } from './audio';
import { normalizeKeyChord } from './keys';
import { appIdentity, deadline, number, object, sameApp, string, type AppIdentity, type AppSnapshot, type Bounds,
  type ComputerUseBackend, type ComputerUseContext, type ComputerUseResult, type Element, type NativeRequest, type Row } from './types';
export { COMPUTER_USE_TOOLS } from './tools';

interface Owner {
  resourceId: string; generation: number; sequence: number; closing: boolean;
  controllers: Set<AbortController>; pending: Set<Promise<unknown>>;
  states: Map<string, { turnId: string; snapshot: AppSnapshot }>;
  taskScope: string;
}
export interface ComputerUseDependencies {
  policy: ComputerUsePolicyService; backend: ComputerUseBackend;
  saveScreenshot(data: string, mimeType: string): string;
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
const text = (value: string): ComputerUseResult => ({ content: [{ type: 'text', text: value }] });
const keyOf = (app: AppIdentity) => `${app.path}\0${app.pid ?? 0}`;
function bounds(value: unknown): Bounds {
  const row = object(value, 'window bounds');
  return { x: number(row.x, 'x', -1_000_000, 1_000_000), y: number(row.y, 'y', -1_000_000, 1_000_000),
    width: number(row.width, 'width', 1, 100_000), height: number(row.height, 'height', 1, 100_000) };
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
  const header = Buffer.from(data.slice(0, 32), 'base64');
  if (screenshot.mimeType !== 'image/png' || width * height > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    || header.length < 24 || !header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || header.readUInt32BE(16) !== width || header.readUInt32BE(20) !== height) throw new Error('Computer Use screenshot is invalid');
  const windowBounds = bounds(row.bounds), imageBounds = screenshot.bounds == null ? undefined : bounds(screenshot.bounds);
  if (imageBounds && (imageBounds.x < windowBounds.x || imageBounds.y < windowBounds.y
    || imageBounds.x + imageBounds.width > windowBounds.x + windowBounds.width
    || imageBounds.y + imageBounds.height > windowBounds.y + windowBounds.height)) throw new Error('Computer Use screenshot bounds extend outside the approved window');
  return { app, elements, windowId: number(row.windowId, 'window identifier', 1, Number.MAX_SAFE_INTEGER, true), bounds: windowBounds,
    ...(typeof row.treeTruncated === 'boolean' ? { treeTruncated: row.treeTruncated } : {}),
    ...(typeof row.loading === 'boolean' ? { loading: row.loading } : {}),
    ...(typeof row.observationChanged === 'boolean' ? { observationChanged: row.observationChanged } : {}),
    screenshot: { data, mimeType: 'image/png', width, height, ...(imageBounds ? { bounds: imageBounds } : {}) } };
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
      controllers: new Set(), pending: new Set(), states: new Map(), taskScope: this.deps.policy.taskScopeIdentity(sessionId) });
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
      const input = string(args.app, 'app').trim(), turnId = string(context.turnId, 'turnId');
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
          const active = appIdentity(await native('activate', { app: resolved, inputAction: !!action }));
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
            enteredAction = true; await native('action', values); actionCompleted = true;
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
          return { content: [{ type: 'text', text: `Saved: ${JSON.stringify(path)}\nEmbed: ${savedImageMarkdown(path)}\n${stateText(state, previous)}` }, { type: 'image', data: state.screenshot.data, mimeType: state.screenshot.mimeType }],
            structuredContent: { path, mimeType: state.screenshot.mimeType, saved: true },
            _meta: { klaus: { computerUse: { app: state.app, windowId: state.windowId, screenshotMode: 'alwaysInclude', elementCount: state.elements.length, mapping } } } };
        });
        this.tail = operation.catch(() => {}); return await operation;
      } catch (error) {
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
  async closeSession(sessionId: string, deadlineMs = 5000): Promise<{ complete: boolean }> {
    const owner = this.owners.get(sessionId); if (!owner) return { complete: true };
    owner.closing = true; owner.states.clear(); for (const controller of owner.controllers) controller.abort(new Error('Computer Use session closed'));
    const started = performance.now();
    const drained = await deadline(Promise.allSettled([...owner.pending]), deadlineMs);
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
