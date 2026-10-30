import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import { loadNativeAddon } from '../native/binding';
import { NativeCapabilities } from '../native/service';
import { registerNativeHandlers } from '../ipc/handlers/native';
import { ChannelRegistry, IpcHandlerError } from '../ipc/registry';
import type { Json } from '../ipc/contract';
import { appRoot, expandHomePrefix } from '../paths';
import { sessionDir } from '../services/session-init';
import { explicitWorkspaceSearchRoot } from '../services/workspace-search-root';

function directory(value: string | undefined): string | undefined {
  if (!value || value.includes('\0')) return undefined;
  const expanded = expandHomePrefix(value, homedir());
  if (!expanded) return undefined;
  const path = resolve(expanded);
  try { return statSync(path).isDirectory() ? path : undefined; } catch { return undefined; }
}

export function createNativeRuntime(window: BrowserWindow, registry: ChannelRegistry, deps: {
  configRoot: string;
  packaged: boolean;
  /** Main-process test injection; packaged apps always use their signed resource. */
  fixtureAddonPath?: string;
  deliver(senderId: number, channel: string, value: Json): Promise<void>;
  log(kind: string, detail: string): void;
  searchRoots?(sessionId: string): Promise<{ root: string; extraRoots: string[] }>;
  /** The session's bound working directory, used to refuse terminals for remote workspaces. */
  sessionWorkdir?(sessionId: string): string | null;
}) {
  const filename = `klaus-native-${process.platform}-${process.arch}.node`;
  const addonPath = deps.packaged ? join(process.resourcesPath, 'native', filename)
    : deps.fixtureAddonPath ?? join(appRoot(), 'native', 'artifacts', filename);
  const addon = loadNativeAddon(addonPath);
  const binding = new addon.NativeHost();
  const capabilities = new NativeCapabilities(binding, (owner, id, error) => deps.log('native-resource-error', `${owner} ${id}: ${error.message}`));
  const owners = new Map<number, BrowserWindow>();
  let closing = false;
  let ready: Promise<void> = Promise.resolve();
  const handlers = registerNativeHandlers(registry, {
    capabilities, deliver: deps.deliver,
    resolveSearchRoots: async (context, payload) => {
      await ready;
      if (closing || !owners.has(context.senderId) || context.role !== 'main') throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'This window does not own workspace search');
      const id = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      const root = explicitWorkspaceSearchRoot(payload.root, id, context.channel);
      if (root) return { root, extraRoots: [] };
      if (id && deps.searchRoots) {
        const roots = await deps.searchRoots(id);
        if (roots.root.startsWith('ssh://')) throw new IpcHandlerError('REMOTE_WORKSPACE', 'File search for a remote workspace runs through the remote_find and remote_grep tools.');
        return roots;
      }
      return {
        root: id ? sessionDir(id, deps.configRoot) : directory(process.env.CANONICAL_CWD) ?? sessionDir('__control__', deps.configRoot),
        extraRoots: [],
      };
    },
    resolveTerminalOptions: async (context, payload) => {
      await ready;
      if (closing || !owners.has(context.senderId) || context.role !== 'main') throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'This window does not own a terminal');
      const requestedCwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      const bound = sessionId && deps.sessionWorkdir ? deps.sessionWorkdir(sessionId) : null;
      if (bound?.startsWith('ssh://') || requestedCwd.startsWith('ssh://')) throw new IpcHandlerError('REMOTE_WORKSPACE', 'The terminal runs on this computer; this chat’s workspace is on another machine. Use remote_exec for remote commands.');
      const cwd = directory(requestedCwd || undefined) ?? homedir();
      if (cwd.startsWith('ssh://')) throw new IpcHandlerError('REMOTE_WORKSPACE', 'The terminal runs on this computer; this chat’s workspace is on another machine. Use remote_exec for remote commands.');
      const configured = process.env.SHELL;
      const command = process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe'
        : configured && !configured.includes('\0') && existsSync(configured) ? configured
        : existsSync('/bin/zsh') ? '/bin/zsh' : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
      const args = process.platform !== 'win32' && basename(command).includes('sh') ? ['-l'] : [];
      return { cwd, command, args, env: [
        { key: 'TERM', value: 'xterm-256color' }, { key: 'COLORTERM', value: 'truecolor' }, { key: 'PWD', value: cwd },
      ] };
    },
  });
  const attachWindow = (owner: BrowserWindow): void => {
    const senderId = owner.webContents.id;
    if (owners.has(senderId)) return;
    if (closing) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Native resources are shutting down');
    owners.set(senderId, owner); handlers.attachOwner(senderId);
    const recycle = (reattach: boolean): void => {
      ready = ready.then(async () => {
        const result = await handlers.detachOwner(senderId);
        if (!result.complete) throw new Error('Native renderer resources did not finish closing');
        if (reattach && !closing && !owner.isDestroyed()) handlers.attachOwner(senderId);
      }).catch(error => deps.log('native-owner-error', String(error)));
    };
    owner.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) recycle(true); });
    owner.webContents.on('render-process-gone', () => recycle(false));
    owner.on('closed', () => { owners.delete(senderId); recycle(false); });
  };
  attachWindow(window);
  return {
    attachWindow,
    addon,
    addonPath,
    capabilities,
    counts: () => binding.counts(),
    quiesceDirectory: (root: string, deadlineMs?: number) => handlers.quiesceDirectory(root, deadlineMs),
    shutdown: () => { closing = true; return capabilities.shutdown(2500); },
  };
}
