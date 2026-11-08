import { app, nativeImage, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { petAppshot } from '../pets/appshot';
import type { Json } from '../ipc/contract';
import type { ChannelRegistry } from '../ipc/registry';
import { registerComputerUseSettingsHandlers } from '../ipc/handlers/computer-use';
import { registerRecordingHandlers } from '../ipc/handlers/recording';
import { NativeComputerUse, type ComputerUseHelperCommand } from '../native/computer-use';
import { ComputerUseAudioRecorder } from '../services/computer-use/audio';
import { ComputerUsePolicyService } from '../services/computer-use/policy';
import { ComputerUseAppDetails } from '../services/computer-use/app-details';
import type { ComputerUseTaskScope } from '../services/computer-use/policy';
import type { ComputerUseBackend } from '../services/computer-use/types';
import { ComputerUseConnector } from '../services/computer-use/connector';
import { storeBytes } from '../services/media';
import { HostMcpServer } from '../services/mcp/host-server';
import { RecordingConnector, RECORDING_TOOLS } from '../services/recording/connector';
import type { RecordingCommand } from '../services/recording/helper';
import { RecordingService, type RecordingEnded } from '../services/recording/service';
import type { PipService } from '../services/pip';
import { RecorderPanel } from './recorder-panel';
import { bundleIconPathFromRoot, icnsIconDataUrl } from '../browser/site-open';

export interface ComputerUseRuntimeDependencies {
  configRoot: string;
  command?: ComputerUseHelperCommand;
  recordingCommand?: RecordingCommand;
  currentTurn(sessionId: string): string | undefined;
  pip(): PipService | undefined;
  enabledChanged(signal: AbortSignal): Promise<void>;
  createRecorderWindow(): BrowserWindow;
  registerRecorderOwner(window: BrowserWindow): void;
  unregisterRecorderOwner(id: number): void;
  recordingEnded(value: RecordingEnded): Promise<void>;
  /** A Computer Use question died without a user answer; the card must close. */
  onElicitationCancelled?(sessionId: string, requestId: string): void;
  log(kind: string, message: string): void;
  taskScope?(sessionId: string): ComputerUseTaskScope | undefined;
  /** Undefined when Computer Use is allowed; otherwise the reason it is refused. */
  computerUseRefusal?(sessionId: string): string | undefined;
}
interface Owner { retiring: boolean; closing?: Promise<void> }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Computer tools, approval transport and recording share one authenticated task owner. */
export async function createComputerUseRuntime(registry: ChannelRegistry, deps: ComputerUseRuntimeDependencies) {
  const native: NativeComputerUse = new NativeComputerUse({ command: deps.command, autoUnlockEnabled: (): boolean => policy.autoUnlockEnabled() });
  // The native queue applies auto-unlock when an input job actually enters. A
  // separate task backend keeps that decision permanently false for friend work.
  const restrictedNative = new NativeComputerUse({ command: deps.command, autoUnlockEnabled: () => false });
  const metadataNative = new NativeComputerUse({ command: deps.command, autoUnlockEnabled: () => false });
  await Promise.all([native.initialize(), restrictedNative.initialize(), metadataNative.initialize()]);
  const backend: ComputerUseBackend = {
    availability: () => native.availability(),
    request: (request, signal) => {
      const { friendTaskRestricted, ...args } = request.args;
      return (friendTaskRestricted === true ? restrictedNative : native).request({ ...request, args }, signal);
    },
    close: async deadlineMs => {
      const results = await Promise.allSettled([native.close(deadlineMs), restrictedNative.close(deadlineMs), metadataNative.close(deadlineMs)]);
      return { complete: results.every(result => result.status === 'fulfilled' && result.value.complete) };
    },
  };
  const owners = new Map<string, Owner>(), turns = new Map<string, string>(), background = new Set<Promise<unknown>>();
  let closing = false, shutdownFlight: Promise<{ complete: boolean }> | undefined;
  const policy: ComputerUsePolicyService = new ComputerUsePolicyService({ configRoot: deps.configRoot, availability: () => backend.availability(),
    loginPassword: native.loginPassword, taskScope: deps.taskScope,
    enabledChanged: async (enabled, signal) => {
      if (!enabled) await Promise.all([...owners.keys()].filter(id => policy.taskScope(id) === undefined).map(releaseSession));
      signal.throwIfAborted(); await deps.enabledChanged(signal);
    },
  });
  const panel = new RecorderPanel({ createWindow: deps.createRecorderWindow, registerOwner: deps.registerRecorderOwner,
    unregisterOwner: deps.unregisterRecorderOwner, log: message => deps.log('recorder-panel', message) });
  const recording = new RecordingService({ recordingsRoot: join(deps.configRoot, 'computer-use-recordings'), command: deps.recordingCommand,
    policy: () => ({ blockedApps: policy.get().deniedApps }),
    showPanel: state => panel.show(state), closePanel: id => panel.close(id), ended: deps.recordingEnded,
    log: message => deps.log('recording', message),
  });
  panel.bind(recording);
  const recordingConnector = new RecordingConnector(recording);
  const audio = new ComputerUseAudioRecorder({ command: deps.command, root: join(deps.configRoot, 'computer-use-audio'),
    available: () => native.audioAvailable(), log: message => deps.log('computer-use-audio', message) });
  const connector = new ComputerUseConnector({ policy, backend,
    // The full-desktop surface stitches every visible display and drives global
    // input; only the Windows native helper implements it.
    desktopAvailable: process.platform === 'win32',
    refusal: sessionId => deps.computerUseRefusal?.(sessionId),
    saveScreenshot: (data, mime) => storeBytes(Buffer.from(data, 'base64'), mime, deps.configRoot),
    audio: { start: (id, ms, signal) => audio.start(id, ms, signal), stop: (id, signal) => audio.stop(id, signal) },
    beginOperation: id => deps.pip()?.beginOperation(id),
    approvedWindow: async (id, epoch, surface, signal) => {
      signal.throwIfAborted(); if (typeof epoch === 'number') deps.pip()?.approvedWindow(id, epoch, surface);
    },
    guardInteraction: async (_id, signal) => {
      signal.throwIfAborted();
      const state = recording.status();
      if (state.recording === true || state.state === 'approving' || state.state === 'starting') throw new Error('Computer input is paused while the user records a demonstration');
    },
  });
  const recordingNames = new Set(RECORDING_TOOLS.map(tool => tool.name));
  const mcp = new HostMcpServer({ name: 'computer-use', currentTurn: deps.currentTurn,
    onElicitationCancelled: (sessionId, requestId) => deps.onElicitationCancelled?.(sessionId, requestId),
    log: (event, detail) => deps.log('computer-use-mcp', JSON.stringify({ event, ...detail })),
    enabled: () => {
      if (closing) return false;
      for (const id of owners.keys()) {
        try { if (policy.taskScope(id) && policy.sessionSettings(id).enabled) return true; } catch { /* Invalid task scope is unavailable. */ }
      }
      try { return policy.get().enabled; } catch { return false; }
    },
    tools: () => [...connector.tools, ...RECORDING_TOOLS],
    call: async (name, args, context) => {
      context.assertCurrent();
      if (policy.taskScope(context.sessionId) !== undefined) {
        policy.guardSession(context.sessionId);
        if (recordingNames.has(name)) throw new Error('Friend tasks cannot record computer activity');
      }
      if (recordingNames.has(name)) return recordingConnector.call(name, args, context);
      const result = await connector.call(name, args, context);
      if (name === 'set_computer_use_policy') await recording.updatePolicy();
      return result;
    },
  });
  const bundleIcon = async (bundleRoot: string): Promise<string | undefined> => {
    const bundled = icnsIconDataUrl(bundleIconPathFromRoot(bundleRoot) ?? '');
    if (bundled) {
      // Normalize the container's largest entry to a row-sized PNG so the data
      // URL stays small over IPC and remains crisp at 2x scale.
      const normalized = nativeImage.createFromDataURL(bundled).resize({ width: 64, height: 64 }).toDataURL();
      if (normalized.startsWith('data:image/png;base64,')) return normalized;
    }
    try {
      const icon = await app.getFileIcon(bundleRoot);
      return icon.isEmpty() ? undefined : icon.resize({ width: 32, height: 32 }).toDataURL();
    } catch { return undefined; }
  };
  const appDetails = new ComputerUseAppDetails(async selector => {
    if (selector === 'app:self') {
      const path = process.platform === 'darwin' ? process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '') : process.execPath;
      return { name: app.getName(), iconDataUrl: await bundleIcon(path) };
    }
    const input = selector.replace(/^(bundle:|path:|name:)/, '');
    const result = object(await metadataNative.request({ resourceId: 'settings-app-details', operationId: randomUUID(), generation: 1,
      sequence: 1, method: 'resolve', args: { input } }, AbortSignal.timeout(2000)));
    const name = typeof result.name === 'string' ? result.name : input;
    if (typeof result.path !== 'string') return { name };
    return { name, iconDataUrl: await bundleIcon(result.path) };
  });
  registerComputerUseSettingsHandlers(registry, policy, async () => {
    const raw = object(await metadataNative.request({ resourceId: 'settings-app-list', operationId: randomUUID(), generation: 1,
      sequence: 1, method: 'listApps', args: {} }, AbortSignal.timeout(3000)));
    if (!Array.isArray(raw.apps) || raw.apps.length > 80) throw new Error('Computer Use app list is invalid');
    const result = { ...raw, apps: await Promise.all(raw.apps.map(async (item: unknown) => {
      const app = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
      if (typeof app.path !== 'string') return app;
      const iconDataUrl = await bundleIcon(app.path);
      return iconDataUrl ? { ...app, iconDataUrl } : app;
    })) };
    return result as unknown as Json;
  }, async selector => {
    try { return await appDetails.get(selector) as unknown as Json; }
    catch { return { name: selector === 'app:self' ? app.getName() : selector.replace(/^(bundle:|path:|name:)/, '') }; }
  });
  registerRecordingHandlers(registry, panel);

  async function releaseSession(id: string): Promise<void> {
    const owner = owners.get(id); if (!owner) return;
    if (owner.closing) return owner.closing;
    owner.retiring = true; turns.delete(id);
    const native = connector.closeSession(id), recorded = recording.stopSession(id), transport = mcp.releaseSession(id), audioRelease = audio.release(id);
    const work = (async () => {
      const results = await Promise.allSettled([native, recorded, transport, audioRelease]);
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason]
        : result.value && !result.value.complete ? [new Error('Computer Use task resources have not finished closing')] : []);
      if (errors.length) throw new AggregateError(errors, 'Computer Use task cleanup is incomplete');
      if (owners.get(id) === owner) owners.delete(id);
    })();
    owner.closing = work;
    void work.finally(() => { if (owner.closing === work) owner.closing = undefined; }).catch(() => {});
    return work;
  }
  async function releaseAll(): Promise<void> {
    const results = await Promise.allSettled([...owners.keys()].map(id => releaseSession(id)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Computer Use resources have not finished closing');
  }
  function report(task: Promise<unknown>): void {
    background.add(task);
    void task.catch(error => deps.log('computer-use-lifecycle', String(error))).finally(() => background.delete(task));
  }
  return {
    policy, recording,
    async captureAppshot(sourceId?: string, signal = new AbortController().signal, applicationToken?: string, soundEnabled = true) {
      if (closing) throw new Error('Application capture is shutting down');
      const match = sourceId?.match(/^window:(\d+)(?::\d+)?$/), windowId = match ? Number(match[1]) : undefined;
      if (sourceId && !windowId) throw new Error('Application capture requires a window source');
      const processId = applicationToken && /^\d+$/.test(applicationToken) ? Number(applicationToken) : undefined;
      if (applicationToken && (!processId || !Number.isSafeInteger(processId))) throw new Error('The original foreground application is unavailable');
      return petAppshot(await native.request({ resourceId: randomUUID(), operationId: randomUUID(), generation: 1, sequence: 1, method: 'appshot', args: { ...(windowId ? { windowId } : {}), ...(processId ? { processId } : {}), soundEnabled } }, signal));
    },
    ownerAppsAvailable: () => restrictedNative.availability(),
    async hostCapabilities(id: string): Promise<Record<string, Json>> {
      if (closing) throw new Error('Computer Use is shutting down');
      const initialScope = policy.taskScopeIdentity(id);
      if (!policy.sessionSettings(id).enabled) return { mcpServers: [], runtimeCapabilityRoots: [] };
      if (owners.get(id)?.retiring) await releaseSession(id);
      if (closing) throw new Error('Computer Use is shutting down');
      let owner = owners.get(id);
      if (!owner) { connector.attachSession(id); owner = { retiring: false }; owners.set(id, owner); }
      try {
        const capabilities = await mcp.hostCapabilities(id);
        policy.assertTaskScopeCurrent(id, initialScope);
        if (closing || owner.retiring || owners.get(id) !== owner) throw new Error('Computer Use task changed during capability startup');
        return capabilities;
      } catch (error) { await releaseSession(id).catch(failure => deps.log('computer-use-startup', String(failure))); throw error; }
    },
    releaseSession,
    connectionLost: () => report(releaseAll()),
    observe(events: readonly unknown[]): void {
      for (const raw of events) {
        const event = object(raw), id = typeof event.sessionId === 'string' ? event.sessionId : '';
        if (!id || !owners.has(id)) continue;
        const prior = turns.get(id), turn = typeof event.turnId === 'string' ? event.turnId : prior;
        if (event.type === 'stream_mode' && event.mode === 'requesting' && turn) {
          if (prior && prior !== turn) mcp.cancelTurn(id, prior); turns.set(id, turn);
        } else if (event.type === 'done' || event.type === 'interrupted' || (event.type === 'api_error' && event.terminal === true)) {
          if (turn) mcp.cancelTurn(id, turn); turns.delete(id);
        }
      }
    },
    shutdown(): Promise<{ complete: boolean }> {
      if (shutdownFlight) return shutdownFlight;
      closing = true;
      const tasks = [releaseAll(), mcp.shutdown()];
      const task = (async () => {
        const results = await Promise.allSettled(tasks);
        await Promise.allSettled([...background]);
        const reports = await Promise.allSettled([panel.shutdown(), connector.close(), audio.close()]);
        const errors = [...results, ...reports].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        for (const error of errors) deps.log('computer-use-shutdown', String(error));
        return { complete: !errors.length && reports.every(result => result.status === 'fulfilled' && result.value.complete) && owners.size === 0 };
      })();
      shutdownFlight = task;
      void task.finally(() => { if (shutdownFlight === task) shutdownFlight = undefined; }).catch(() => {});
      return task;
    },
  };
}
