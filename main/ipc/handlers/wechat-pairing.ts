import type { ChannelRegistry } from '../registry';
import { WechatPairingService, type WechatPairingDeps } from '../../services/channels/wechat-pairing';

export const WECHAT_PAIRING_CHANNELS = ['channels:wechat:qrStart', 'channels:wechat:qrPoll'] as const;
export function registerWechatPairingHandlers(registry: ChannelRegistry, deps: WechatPairingDeps & { service?: WechatPairingService }): WechatPairingService {
  const service = deps.service ?? new WechatPairingService(deps);
  registry.register('channels:wechat:qrStart', () => service.start(), 'wechat-pairing');
  registry.register('channels:wechat:qrPoll', () => service.poll(), 'wechat-pairing');
  return service;
}
