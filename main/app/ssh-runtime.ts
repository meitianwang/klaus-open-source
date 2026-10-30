import { homedir, userInfo } from 'node:os';
import type { BrowserWindow } from 'electron';
import type { Json } from '../ipc/contract';
import type { ChannelRegistry } from '../ipc/registry';
import { registerSshHandlers } from '../ipc/handlers/ssh';
import { SshConnectionPool, type SshPoolOptions } from '../services/ssh-pool';
import type { SshOptions } from '../native/ssh';

export type SshIdentity = Pick<SshOptions, 'userHome' | 'localUser' | 'agentPath'>;

/** SSH resources belong to a renderer lifetime; hiding its window keeps them alive. */
export function createSshRuntime(window: BrowserWindow, registry: ChannelRegistry, deps: {
  addonPath: string;
  identity?: SshIdentity;
  deliver(senderId: number, channel: string, value: Json): Promise<void>;
  log(kind: string, message: string): void;
  createTransport?: SshPoolOptions['createTransport'];
}): { pool: SshConnectionPool; attachWindow(window: BrowserWindow): void; shutdown: () => Promise<{ complete: boolean }> } {
  const pool = new SshConnectionPool({
    ...(deps.identity ?? { userHome: homedir(), localUser: userInfo().username,
      agentPath: process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? String.raw`\\.\pipe\openssh-ssh-agent` : null) }),
    addonPath: deps.addonPath,
    deliver: (senderId, channel, value) => deps.deliver(senderId, channel, value),
    createTransport: deps.createTransport,
  });
  const handlers = registerSshHandlers(registry, pool);
  const owners = new Set<number>();
  let closing = false, pending: Promise<void> = Promise.resolve();
  let shutdown: Promise<{complete:boolean}> | undefined;
  const attachWindow = (owner: BrowserWindow): void => {
    const senderId = owner.webContents.id;
    if (owners.has(senderId)) return;
    if (closing) throw new Error('SSH resources are shutting down');
    owners.add(senderId); handlers.attachOwner(senderId);
    const recycle = (reattach: boolean): void => {
      pending = pending.then(async () => {
        const result = await handlers.detachOwner(senderId);
        if (!result.complete) throw new Error('SSH renderer resources did not finish closing');
        if (reattach && !closing && !owner.isDestroyed()) handlers.attachOwner(senderId);
      }).catch(error => deps.log('ssh-owner-error', String(error)));
    };
    owner.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) recycle(true); });
    owner.webContents.on('render-process-gone', () => recycle(false));
    owner.on('closed', () => { owners.delete(senderId); recycle(false); });
  };
  attachWindow(window);
  return { pool, attachWindow, shutdown: () => shutdown ??= (async () => {
    closing = true; await pending;
    const result = await handlers.shutdown(5000);
    deps.log('ssh-shutdown', JSON.stringify(result));
    return result;
  })() };
}
