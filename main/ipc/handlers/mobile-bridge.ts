import type { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import type { MobileBridgeService } from '../../services/mobile/service';

export const MOBILE_BRIDGE_CHANNELS = [
  'settings:mobile-bridge:get',
  'settings:mobile-bridge:set',
  'settings:mobile-bridge:rotate-token',
  'settings:mobile-bridge:restart',
  'settings:mobile-bridge:devices',
  'settings:mobile-bridge:remove-device',
  'settings:mobile-bridge:rename-device',
] as const;
export function registerMobileBridgeHandlers(registry: ChannelRegistry, service: MobileBridgeService): void {
  registry.register(MOBILE_BRIDGE_CHANNELS[0], () => service.get(), 'mobile-bridge');
  registry.register(MOBILE_BRIDGE_CHANNELS[1], ctx => service.set(object(ctx.args[0])), 'mobile-bridge');
  registry.register(MOBILE_BRIDGE_CHANNELS[2], () => service.rotateToken(), 'mobile-bridge');
  registry.register(MOBILE_BRIDGE_CHANNELS[3], () => service.restart(), 'mobile-bridge');
  registry.register(MOBILE_BRIDGE_CHANNELS[4], () => service.listDevices(), 'mobile-bridge');
  registry.register(MOBILE_BRIDGE_CHANNELS[5], ctx => service.removeDevice(object(ctx.args[0])), 'mobile-bridge');
  registry.register(MOBILE_BRIDGE_CHANNELS[6], ctx => service.renameDevice(object(ctx.args[0])), 'mobile-bridge');
}
