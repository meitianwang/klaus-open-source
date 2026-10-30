import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { ImageActions } from '../../services/image-actions';

export function registerImageHandlers(registry: ChannelRegistry, images: ImageActions): void {
  registry.register('media:read-image', ctx => images.read(object(ctx.args[0])), 'images');
  registry.register('media:save-image', ctx => images.save(object(ctx.args[0])), 'images');
  registry.register('media:copy-image', ctx => images.copy(object(ctx.args[0])), 'images');
  registry.register('media:reveal-image', ctx => images.reveal(object(ctx.args[0])), 'images');
}

