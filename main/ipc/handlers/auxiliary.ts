import type { QuickInputRuntime } from '../../app/quick-input';
import type { ClipboardFiles } from '../../services/clipboard-files';
import type { SystemPermissions } from '../../services/system-permissions';
import { object } from '../../services/voice/store';
import { ChannelRegistry, IpcHandlerError } from '../registry';

export interface TextClipboard {
  readText(): string | Promise<string>;
  writeText(value: string): void | Promise<void>;
}

/** Native desktop-only utilities shared by the main and auxiliary windows. */
export function registerAuxiliaryHandlers(registry: ChannelRegistry, deps: {
  quickInput: QuickInputRuntime; clipboard: ClipboardFiles; textClipboard: TextClipboard; permissions: SystemPermissions;
}): void {
  registry.registerAll({
    'quick-input:language': context => deps.quickInput.language(context.senderId),
    'quick-input:hide': context => deps.quickInput.hide(context.senderId, object(context.args[0]).activationId),
    'quick-input:submit': context => deps.quickInput.submit(context.senderId, object(context.args[0]).text),
    'clipboard:read-file-paths': () => deps.clipboard.read(),
    'clipboard:read-text': () => deps.textClipboard.readText(),
    'clipboard:write-text': async context => {
      const value = object(context.args[0]).text;
      if (typeof value !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'text required');
      await deps.textClipboard.writeText(value);
      return { ok: true };
    },
    'system:permissions:check': () => deps.permissions.check(),
    'system:permissions:open': context => deps.permissions.open(object(context.args[0]).type),
    'system:permissions:request': context => deps.permissions.request(object(context.args[0]).type),
  }, 'auxiliary');
}
