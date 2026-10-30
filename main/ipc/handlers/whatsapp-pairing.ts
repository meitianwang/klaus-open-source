import type { ChannelRegistry } from '../registry';
import { WhatsAppPairingService, type WhatsAppPairingDeps } from '../../services/channels/whatsapp-pairing';

export const WHATSAPP_PAIRING_CHANNELS = ['channels:whatsapp:start', 'channels:whatsapp:poll'] as const;
export function registerWhatsAppPairingHandlers(registry: ChannelRegistry, deps: WhatsAppPairingDeps & { service?: WhatsAppPairingService }): WhatsAppPairingService {
  const service = deps.service ?? new WhatsAppPairingService(deps);
  registry.register('channels:whatsapp:start', () => service.start(), 'whatsapp-pairing');
  registry.register('channels:whatsapp:poll', () => service.poll(), 'whatsapp-pairing');
  return service;
}
