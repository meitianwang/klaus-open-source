import { ChannelRegistry } from '../registry';
import { object } from '../../services/voice/store';
import { VoiceService } from '../../services/voice/service';

/** The existing sixteen channels share one owner-aware service. */
export function registerVoiceHandlers(registry: ChannelRegistry, service: VoiceService): VoiceService {
  registry.registerAll({
    'voice:config:get': context => service.config(context.senderId, object(context.args[0])),
    'voice:mic-permission': context => service.microphone(context.senderId, object(context.args[0])),
    'voice:session:start': context => service.start(context.senderId, object(context.args[0])),
    'voice:session:audio': context => service.audio(context.senderId, object(context.args[0])),
    'voice:session:stop': context => service.stop(context.senderId, object(context.args[0])),
    'voice:session:cancel': context => service.cancel(context.senderId, object(context.args[0])),
    'voice:transcribe': context => service.transcribe(context.senderId, object(context.args[0])),
    'voice:learn': context => service.learn(context.senderId, object(context.args[0])),
  }, 'voice');
  for (const action of ['hotwords:list', 'hotwords:add', 'hotwords:delete', 'hotwords:toggle', 'memories:list', 'memories:delete', 'history:list', 'history:clear']) {
    registry.register(`voice:${action}`, context => service.stored(context.senderId, action, object(context.args[0])), 'voice');
  }
  return service;
}
