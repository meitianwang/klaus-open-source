import type { WhatsAppMessageEvent } from '../../native/whatsapp';
import type { ChannelInbound } from './types';

export function whatsappSessionKey(jid: string): string {
  return 'whatsapp:' + jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, ':group');
}
export function whatsappTargetJid(target: string, chatType = 'direct'): string {
  if (!target || Buffer.byteLength(target) > 512 || /[\s\0]/.test(target)) throw new Error('Invalid WhatsApp target');
  return target.includes('@') ? target : target + (chatType === 'group' ? '@g.us' : '@s.whatsapp.net');
}
export function whatsappMessage(event: WhatsAppMessageEvent): ChannelInbound | undefined {
  const { info, message } = event;
  if (info.isFromMe || !info.chatJid || info.chatJid === 'status@broadcast') return;
  let text = [message.conversation, message.extendedText, message.imageCaption, message.videoCaption].find(value => value !== null && value !== '');
  if (text === undefined) {
    text = message.image ? '[图片]' : message.video ? '[视频]' : message.audio ? '[语音]'
      : message.document ? '[文件: ' + (message.document.fileName ?? 'file') + ']'
        : message.sticker ? '[贴纸]' : message.contact ? '[联系人]' : message.location ? '[位置]' : '';
  }
  text = text?.trim(); if (!text) return;
  const group = info.chatJid.endsWith('@g.us'), sender = group ? info.senderJid : info.chatJid;
  return { sessionKey: whatsappSessionKey(info.chatJid), ...(info.id ? { messageId: info.id } : {}), text,
    messageType: 'text', chatType: group ? 'group' : 'private', senderId: sender.replace(/@s\.whatsapp\.net$/, ''),
    ...(info.pushName ? { senderName: info.pushName } : {}), timestamp: info.timestampMs,
    targetId: info.chatJid, ...(group ? { groupId: info.chatJid } : {}) };
}
