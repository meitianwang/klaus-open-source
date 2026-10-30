import type { DigramService } from '../../digram/service';
import { message } from '../../visuals/data';
import type { ChannelRegistry } from '../registry';

export function registerDigramHandlers(registry: ChannelRegistry,deps: { service: DigramService }): void {
  for(const channel of ['digram:list','digram:get','digram:apply-edit','digram:export','digram:icons','digram:history','digram:revert','digram:render-result']) {
    registry.register(channel,async context=>{try{return await deps.service.invoke(context);}catch(error){return {ok:false,error:message(error)};}},'digram');
  }
}
