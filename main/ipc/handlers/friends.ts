import { writeFileSync } from 'node:fs';
import { BrowserWindow, clipboard, dialog, webContents } from 'electron';
import type { Json } from '../contract';
import { payload } from '../arguments';
import { ChannelRegistry, IpcHandlerError } from '../registry';
import type { FriendsService } from '../../services/friends';

/** The window that issued this call, so save dialogs parent to it. */
function senderWindow(context: { senderId: number }): BrowserWindow {
  const contents = webContents.fromId(context.senderId), owner = contents && BrowserWindow.fromWebContents(contents);
  if (!owner) throw new IpcHandlerError('WINDOW_CLOSED', 'The window is no longer available');
  return owner;
}

export function registerFriendsHandlers(registry: ChannelRegistry, service: FriendsService): void {
  const operations = {
    'friends:list': null, 'friends:lookup': 'lookup', 'friends:request': 'request', 'friends:respond': 'respond',
    'friends:set-authorization': 'set-authorization', 'friends:remove': 'remove',
  } as const;
  for (const [channel, type] of Object.entries(operations)) registry.register(channel, async context => {
    if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'Friends management is available in the main window');
    context.assertCurrent?.();
    const result = type === null ? await service.list() : type === 'lookup' ? await service.lookup(payload(context).email) : await service.manage(type, payload(context));
    context.assertCurrent?.(); return result as unknown as Json;
  }, 'friends');
  // The owner's private note for one friend. It is stored on this computer only,
  // so the channel stays main-window like the rest of friend management.
  registry.register('friends:set-remark', async context => {
    if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'Friends management is available in the main window');
    context.assertCurrent?.();
    const result = await service.setRemark(payload(context));
    context.assertCurrent?.(); return result as unknown as Json;
  }, 'friends');
  // The owner's own scannable add-me card. The QR itself is produced host-side
  // (the renderer never sees the encoder); these channels only hand out the
  // finished card and carry its two outward actions.
  registry.register('friends:my-card', async context => {
    if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'The friend card belongs to the main window');
    context.assertCurrent?.();
    return await service.myCard() as unknown as Json;
  }, 'friends');
  registry.register('friends:save-qr-card', async context => {
    if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'The friend card belongs to the main window');
    context.assertCurrent?.();
    const card = await service.myCard();
    if (!card.signedIn) throw new IpcHandlerError('ACCOUNT_REQUIRED', 'Sign in to use friends');
    const owner = senderWindow(context);
    const base = (card.displayName || card.email).replace(/[^\w\u4e00-\u9fff-]+/gu, '_').slice(0, 40) || 'klaus-friend-card';
    const choice = await dialog.showSaveDialog(owner, { defaultPath: `${base}-qr.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (choice.canceled || !choice.filePath) return { saved: false, path: null } as unknown as Json;
    const dataUrl = /^data:image\/png;base64,(?<bytes>.+)$/su.exec(card.qrDataUrl);
    const bytes = dataUrl?.groups?.bytes;
    if (!bytes) throw new IpcHandlerError('INVALID_QR', 'The QR code could not be encoded');
    writeFileSync(choice.filePath, Buffer.from(bytes, 'base64'));
    return { saved: true, path: choice.filePath } as unknown as Json;
  }, 'friends');
  registry.register('friends:share-qr-card', async context => {
    if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'The friend card belongs to the main window');
    context.assertCurrent?.();
    const card = await service.myCard();
    if (!card.signedIn) throw new IpcHandlerError('ACCOUNT_REQUIRED', 'Sign in to use friends');
    clipboard.writeText(`${card.displayName}\n${card.email}\n${card.payload}`);
    return { shared: true } as unknown as Json;
  }, 'friends');
  registry.register('friends:send-message', async context => {
    if(context.role!=='main')throw new IpcHandlerError('FORBIDDEN_CHANNEL','Friend messages belong to the main window');
    context.assertCurrent?.();
    const value=payload(context);
    if(typeof value.text==='string'){
      const metadata=value.displayMetadata && typeof value.displayMetadata==='object' && !Array.isArray(value.displayMetadata)?value.displayMetadata:{};
      const result=await service.dispatchComposerDetailed(value.text,metadata,String(value.sessionId??''));
      context.assertCurrent?.();return result;
    }
    const result=await service.sendMessage(value);context.assertCurrent?.();return result;
  },'friends');
  const runtimeOperations = {
    'friends:runtime': 'runtime', 'friends:set-receiver': 'setReceiver', 'friends:apps': 'apps',
    'friends:approve': 'approve', 'friends:reject': 'reject', 'friends:ignore': 'ignore', 'friends:cancel': 'cancel',
    'friends:save-template': 'saveTemplate', 'friends:revoke-template': 'revokeTemplate', 'friends:retry-reply': 'retryReply',
    'friends:set-default-grant': 'setDefaultGrant', 'friends:resolve-access-request': 'resolveAccessRequest',
    'friends:pending-access-requests': 'pendingAccessRequests',
    'friends:retry-send': 'retrySend', 'friends:prepare-local-assist': 'prepareLocalAssist',
    'friends:request-reply': 'requestReply',
  } as const;
  for (const [channel, method] of Object.entries(runtimeOperations)) registry.register(channel, async context => {
    if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'Friend task authorization belongs to this computer owner');
    context.assertCurrent?.();
    const result = method === 'runtime' ? await service.runtime() : await service[method](payload(context));
    context.assertCurrent?.(); return result as unknown as Json;
  }, 'friends');
}
