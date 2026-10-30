import { object, type JsonObject } from '../service-types';
import type { ChannelId, ChannelInbound } from './types';

/** A local access file is additional to the platform adapter's own policy. */
export function permitsChannelMessage(id: ChannelId, access: JsonObject, message: ChannelInbound): boolean {
  const direct = message.chatType === 'direct' || message.chatType === 'private';
  const dm = access.dmPolicy ?? 'pairing';
  const supported = id === 'discord' ? ['pairing', 'allowlist', 'disabled'] : ['open', 'pairing', 'allowlist', 'disabled'];
  if (typeof dm !== 'string' || !supported.includes(dm)) return false;
  // Discord's persisted contract disables the whole adapter, including groups.
  if (id === 'discord' && dm === 'disabled') return false;
  const contains = (value: unknown): boolean => Array.isArray(value) && value.includes(message.senderId);
  if (direct) return dm === 'open' || (dm !== 'disabled' && contains(access.allowFrom));
  const groups = object(access.groups), key = message.groupId || message.senderId;
  if (!Object.hasOwn(groups, key)) return false;
  if (!groups[key] || typeof groups[key] !== 'object' || Array.isArray(groups[key])) return false;
  const policy = object(groups[key]);
  if (policy.allowFrom !== undefined && (!Array.isArray(policy.allowFrom) || policy.allowFrom.some(value => typeof value !== 'string'))) return false;
  if (policy.requireMention !== undefined && typeof policy.requireMention !== 'boolean') return false;
  if (Array.isArray(policy.allowFrom) && policy.allowFrom.length && !contains(policy.allowFrom)) return false;
  return policy.requireMention === false || message.mentioned === true;
}
