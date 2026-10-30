import type { Json } from '../../ipc/contract';
import type { JsonObject } from '../service-types';

export const CHANNEL_DEFINITIONS = [
  { id: 'feishu', name: 'Feishu', fields: ['app_id', 'app_secret'] },
  { id: 'dingtalk', name: 'DingTalk', fields: ['client_id', 'client_secret'] },
  { id: 'wechat', name: 'WeChat', fields: [] },
  { id: 'wecom', name: 'WeCom', fields: ['bot_id', 'secret'] },
  { id: 'qq', name: 'QQ', fields: ['app_id', 'client_secret'] },
  { id: 'telegram', name: 'Telegram', fields: ['bot_token'] },
  { id: 'discord', name: 'Discord', fields: ['bot_token'] },
  { id: 'whatsapp', name: 'WhatsApp', fields: [] },
] as const;
export type ChannelId = typeof CHANNEL_DEFINITIONS[number]['id'];
export function channelDefinition(id: string): typeof CHANNEL_DEFINITIONS[number] | undefined { return CHANNEL_DEFINITIONS.find(row => row.id === id); }
export interface ChannelInbound {
  sessionKey: string; senderId: string; text: string;
  chatType: 'direct' | 'private' | 'group' | 'thread';
  messageId?: string; messageType?: string; senderName?: string; timestamp?: number;
  groupId?: string; threadId?: string; mentioned?: boolean; dedupKey?: string; media?: Json;
  targetId?: string; replyTo?: { messageId: string };
}
export interface ChannelOutcome { reply?: string | null; manuallySent?: boolean; dropped?: boolean; reason?: string }
export interface ChannelSend {
  targetId: string; text?: string; action?: string; chatType?: string;
  threadId?: string; replyToMessageId?: string; files?: Json[];
  messageId?: string; emoji?: string; format?: string; fileId?: string;
  limit?: number; beforeMessageId?: string; afterMessageId?: string;
}
export interface ChannelAdapterContext {
  configRoot: string; signal: AbortSignal;
  inbound: (message: ChannelInbound, signal: AbortSignal) => Promise<ChannelOutcome>;
  onStatus?: (status: JsonObject) => void;
}
export interface ChannelAdapter {
  /** Resolves only after the transport and all accepted work have stopped. */
  readonly done: Promise<void>;
  status(): JsonObject;
  send(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject>;
  close(): Promise<void>;
}
export type ChannelAdapterFactory = (account: Record<string, string>, context: ChannelAdapterContext) => Promise<ChannelAdapter>;

export async function channelDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
