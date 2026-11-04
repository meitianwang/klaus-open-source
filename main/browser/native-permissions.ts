import { BrowserError } from './types';

export type NativePermissionSetting = 'granted' | 'denied' | 'prompt';
export interface NativePermissionPage {
  isDestroyed(): boolean;
  setPermission(origin: string, name: string, setting: NativePermissionSetting): void;
  resetPermissions(): void;
}

const aliases: Record<string, string> = { videoCapture: 'camera', audioCapture: 'microphone' };
const supported = new Set(['geolocation', 'notifications', 'camera', 'microphone']);
type OriginSettings = Map<string, Map<string, NativePermissionSetting>>;

/** Decisions belong to a task and are replayed into its genuine native pages. */
export class NativeTaskPermissions {
  private readonly tasks = new Map<string, OriginSettings>();

  constructor(private readonly pages: () => Iterable<{ owner: string; native: NativePermissionPage }>) {}

  attach(owner: string, native: NativePermissionPage): void {
    for (const [origin, names] of this.tasks.get(owner) ?? []) {
      for (const [name, setting] of names) native.setPermission(origin, name, setting);
    }
  }

  set(owner: string, origin: string, asked: string[], setting: NativePermissionSetting): string[] {
    const names = [...new Set(asked.map(name => aliases[name] ?? name))];
    const unsupported = names.filter(name => !supported.has(name));
    if (unsupported.length) throw new BrowserError('unavailable', `The native browser does not support these task permissions: ${unsupported.join(', ')}.`);
    const targets = [...this.pages()].filter(page => page.owner === owner && !page.native.isDestroyed());
    try {
      for (const page of targets) {
        for (const name of names) page.native.setPermission(origin, name, setting);
      }
    } catch (error) {
      // Restore every live page from the unchanged task record if applying a
      // group failed. A destroyed page no longer has a permission scope.
      for (const page of targets) {
        if (page.native.isDestroyed()) continue;
        page.native.resetPermissions();
        this.attach(owner, page.native);
      }
      throw error;
    }
    const origins = this.tasks.get(owner) ?? new Map();
    const permissions = origins.get(origin) ?? new Map();
    for (const name of names) {
      if (setting === 'prompt') permissions.delete(name);
      else permissions.set(name, setting);
    }
    if (permissions.size) origins.set(origin, permissions);
    else origins.delete(origin);
    if (origins.size) this.tasks.set(owner, origins);
    else this.tasks.delete(owner);
    return names;
  }

  reset(owner?: string): void {
    for (const page of this.pages()) {
      if ((owner === undefined || page.owner === owner) && !page.native.isDestroyed()) page.native.resetPermissions();
    }
    if (owner === undefined) this.tasks.clear();
    else this.tasks.delete(owner);
  }
}
