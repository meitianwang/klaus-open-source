import { randomUUID } from 'node:crypto';
import { Notification } from 'electron';
import type { DesktopNotice } from '../services/notifications';

/** A friend-task banner routes to the conversation the request waits in; everything else to its own conversation. */
function noticeTarget(value: DesktopNotice): NotificationTarget | undefined {
  if (value.friendTaskId) return { kind: 'friend-task', taskId: value.friendTaskId };
  return value.sessionId ? { kind: 'session', sessionId: value.sessionId } : undefined;
}

export interface NativeNotificationOptions {
  id: string;
  groupId?: string;
  title: string;
  body: string;
  subtitle?: string;
  silent: boolean;
}

/**
 * Where clicking a delivered banner should take the user.
 *
 * A banner outlives its process: macOS Notification Center keeps delivered
 * notifications, and `Notification.getHistory()` repopulates only `id`,
 * `groupId`, title, subtitle and body. The click target therefore has to ride
 * in the `groupId`, which is why it is a tagged string rather than a second
 * in-memory field that a restored banner would silently lose.
 */
export type NotificationTarget = { kind: 'session'; sessionId: string } | { kind: 'friend-task'; taskId: string };

const TARGET_PREFIX = 'friend-task:';

export function notificationGroup(target: NotificationTarget): string {
  return target.kind === 'session' ? target.sessionId : `${TARGET_PREFIX}${target.taskId}`;
}

/** `undefined` for a group that carries no routable destination. */
export function parseNotificationGroup(groupId: string | undefined): NotificationTarget | undefined {
  if (!groupId) return undefined;
  if (groupId.startsWith(TARGET_PREFIX)) {
    const taskId = groupId.slice(TARGET_PREFIX.length);
    return taskId ? { kind: 'friend-task', taskId } : undefined;
  }
  return { kind: 'session', sessionId: groupId };
}

export interface NativeNotificationHandle {
  readonly id: string;
  readonly groupId?: string;
  once(event: 'click' | 'close' | 'failed', listener: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
  show(): void;
}


export interface NativeNotificationApi {
  isSupported(): boolean;
  create(options: NativeNotificationOptions): NativeNotificationHandle;
  history?(): Promise<NativeNotificationHandle[]>;
}

function electronHandle(notice: Notification): NativeNotificationHandle {
  return {
    id: notice.id,
    groupId: notice.groupId,
    once: (event, listener) => { notice.once(event as 'click', listener as () => void); },
    removeAllListeners: () => { notice.removeAllListeners(); },
    show: () => { notice.show(); },
  };
}

const electronApi: NativeNotificationApi = {
  isSupported: () => Notification.isSupported(),
  create: options => electronHandle(new Notification(options)),
  ...(process.platform === 'darwin' ? { history: async () => (await Notification.getHistory()).map(electronHandle) } : {}),
};

export function notificationProbeRequested(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--notification-probe');
}

/** Packaged-app diagnostic for native identity, delivery and click activation. */
export async function runNotificationProbe(holdMs = 30_000): Promise<boolean> {
  process.stdout.write('notification probe\n');
  process.stdout.write(`  route:   Electron Notification (${process.platform})\n`);
  process.stdout.write('  expect:  the Klaus app name and icon; click activation is logged below\n');
  if (!Notification.isSupported()) {
    process.stderr.write('  failed:  desktop notifications are unavailable on this platform\n');
    return false;
  }
  const notice = new Notification({ id: `klaus-${randomUUID()}`, title: 'Klaus', subtitle: 'Task completed', body: 'Notification probe', silent: true });
  let failed = false;
  notice.once('show', () => { process.stdout.write('  shown:   native notification accepted\n'); });
  notice.once('click', () => { process.stdout.write('  clicked: native notification activated Klaus\n'); });
  notice.once('failed', (_event, error) => {
    failed = true;
    process.stderr.write(`  failed:  ${error}\n`);
  });
  try { notice.show(); }
  catch (error) { process.stderr.write(`  failed:  ${String(error)}\n`); return false; }
  process.stdout.write(`  holding: ${Math.ceil(holdMs / 1000)}s for delivery and click events\n`);
  await new Promise(resolve => setTimeout(resolve, holdMs));
  return !failed;
}

export interface NotificationAuthorizationDeps {
  enabled(): boolean;
  request(): Promise<string>;
  log(message: string): void;
}

/** Serialize the renderer permission ask so startup and a settings write cannot race. */
export class NotificationAuthorization {
  private pending?: Promise<void>;
  private closed = false;
  constructor(private readonly deps: NotificationAuthorizationDeps) {}
  ensure(): Promise<void> {
    if (this.closed) return Promise.resolve();
    try { if (!this.deps.enabled()) return Promise.resolve(); }
    catch (error) { this.deps.log(`Notification authorization could not read its setting: ${String(error)}`); return Promise.resolve(); }
    if (this.pending) return this.pending;
    let task!: Promise<void>;
    task = Promise.resolve().then(() => this.deps.request()).then(status => {
      if (this.closed || status === 'granted') return;
      if (status === 'denied') this.deps.log('Desktop notifications are not allowed; enable them in System Settings > Notifications.');
      else this.deps.log(`Desktop notification authorization returned ${status || 'an unknown status'}.`);
    }).catch(error => {
      if (!this.closed) this.deps.log(`Desktop notification authorization failed: ${String(error)}`);
    }).finally(() => { if (this.pending === task) this.pending = undefined; });
    this.pending = task;
    return task;
  }
  close(): void { this.closed = true; }
}

/** Keep native handles alive so every delivered banner remains clickable. */
export class NativeNotifications {
  private readonly visible = new Map<string, NativeNotificationHandle>();
  private closed = false;
  constructor(private readonly deps: { open(target?: NotificationTarget): Promise<void>; log(message: string): void },
    private readonly api: NativeNotificationApi = electronApi,
    private readonly nextId: () => string = () => `klaus-${randomUUID()}`) {}
  private release(notice: NativeNotificationHandle): void {
    if (this.visible.get(notice.id) === notice) this.visible.delete(notice.id);
    notice.removeAllListeners();
  }
  private retain(notice: NativeNotificationHandle, target?: NotificationTarget): void {
    if (this.closed || this.visible.has(notice.id)) return;
    const release = (): void => { this.release(notice); };
    notice.once('click', () => {
      if (!this.closed) void this.deps.open(target).catch(error => this.deps.log(`Notification navigation failed: ${String(error)}`));
      release();
    });
    notice.once('close', release);
    notice.once('failed', (_event, error) => { this.deps.log(`Native notification failed: ${String(error)}`); release(); });
    this.visible.set(notice.id, notice);
  }
  show(value: DesktopNotice): void {
    if (this.closed) return;
    if (!this.api.isSupported()) { this.deps.log('Desktop notifications are unavailable on this platform.'); return; }
    const target = noticeTarget(value);
    const notice = this.api.create({ id: this.nextId(), ...(target ? { groupId: notificationGroup(target) } : {}),
      title: value.title, body: value.body, subtitle: value.subtitle, silent: true });
    this.retain(notice, target);
    try { notice.show(); } catch (error) { this.release(notice); throw error; }
  }
  async restore(): Promise<void> {
    if (this.closed || !this.api.history || !this.api.isSupported()) return;
    let notices: NativeNotificationHandle[];
    try { notices = await this.api.history(); }
    catch (error) { this.deps.log(`Notification history could not be restored: ${String(error)}`); return; }
    if (this.closed) { for (const notice of notices) notice.removeAllListeners(); return; }
    for (const notice of notices) this.retain(notice, parseNotificationGroup(notice.groupId));
  }
  close(): void {
    this.closed = true;
    // Do not dismiss delivered notifications: Notification Center owns their
    // lifetime, and a later Klaus process restores their click handlers.
    for (const notice of this.visible.values()) notice.removeAllListeners();
    this.visible.clear();
  }
}
