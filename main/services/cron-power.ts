import type { PowerSaveBlockerType, PowerSavePreferences, PowerSaveRequest } from '../../contracts/power-save';
import { IpcHandlerError } from '../ipc/registry';
import { configRootFrom } from './config-root';
import { isFailure, kvGet, kvSet } from './settings';
export interface CronPowerBlocker {
  start(type: PowerSaveBlockerType): number;
  stop(id: number): unknown;
  isStarted(id: number): boolean;
}

export interface PowerMonitorSource {
  isOnBatteryPower(): boolean;
  on(event: 'on-ac' | 'on-battery', listener: () => void): unknown;
  removeListener(event: 'on-ac' | 'on-battery', listener: () => void): unknown;
}

const TASK_KEY = 'power.prevent_sleep_while_running';
const REMOTE_KEY = 'power.keep_remote_control_awake_while_plugged_in';

/** Persist policy independently of transient operating-system assertions. */
export class PowerSaveSettings {
  constructor(readonly configRoot = configRootFrom()) {}
  private read(key: string): string | null {
    const value = kvGet(key, this.configRoot);
    if (isFailure(value)) throw new IpcHandlerError(value.code, value.message);
    return value;
  }
  get(): PowerSavePreferences {
    const task = this.read(TASK_KEY) ?? this.read('cron.keep_awake');
    const remote = this.read(REMOTE_KEY) ?? task;
    return { preventSleepWhileRunning: task === '1' || task === 'true', keepRemoteControlAwakeWhilePluggedIn: remote === '1' || remote === 'true' };
  }
  set(key: keyof PowerSavePreferences, enabled: boolean): PowerSavePreferences {
    this.write(key === 'preventSleepWhileRunning' ? TASK_KEY : REMOTE_KEY, enabled);
    return this.get();
  }
  private write(key: string, enabled: boolean): void {
    const result = kvSet(key, enabled ? '1' : '0', this.configRoot);
    if (isFailure(result)) throw new IpcHandlerError(result.code, result.message);
  }
}

/** Aggregate independent window requests into one assertion, with display priority. */
export class PowerSaveController {
  private readonly requests = new Map<number, PowerSaveRequest>();
  private blockerId?: number;
  private blockerType: PowerSaveBlockerType | null = null;
  private closed = false;
  private readonly powerChanged = (): void => { this.refresh(); };
  constructor(readonly blocker: CronPowerBlocker, private readonly monitor: PowerMonitorSource,
    private readonly report: (error: unknown) => void) {
    monitor.on('on-ac', this.powerChanged);
    monitor.on('on-battery', this.powerChanged);
  }
  update(ownerId: number, request: PowerSaveRequest): void {
    if (this.closed) throw new Error('Power service closed');
    this.requests.set(ownerId, { ...request });
    this.sync();
  }
  release(ownerId: number): void { this.requests.delete(ownerId); this.refresh(); }
  private refresh(): void { try { this.sync(); } catch (error) { this.report(error); } }
  private sync(): void {
    const requests = [...this.requests.values()];
    const desired = requests.some(request => request.preventDisplaySleep) ? 'prevent-display-sleep'
      : requests.some(request => request.shouldBlock)
        || requests.some(request => request.keepRemoteControlAwakeWhilePluggedIn) && !this.monitor.isOnBatteryPower()
        ? 'prevent-app-suspension' : null;
    if (desired === this.blockerType && (this.blockerId === undefined || this.blocker.isStarted(this.blockerId))) return;
    if (this.blockerId !== undefined) {
      this.blocker.stop(this.blockerId);
      this.blockerId = undefined;
      this.blockerType = null;
    }
    if (desired !== null) {
      const id = this.blocker.start(desired);
      this.blockerId = id;
      if (!this.blocker.isStarted(id)) throw new Error('Could not hold the power-save blocker');
    }
    this.blockerType = desired;
  }
  close(): void {
    this.closed = true;
    this.monitor.removeListener('on-ac', this.powerChanged);
    this.monitor.removeListener('on-battery', this.powerChanged);
    this.requests.clear();
    this.refresh();
  }
}
