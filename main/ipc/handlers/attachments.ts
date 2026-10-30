import { ChannelRegistry } from '../registry';
import { AttachmentService } from '../../services/attachments';
import { PastedTextService, pastedTextPayload } from '../../services/pasted-text';
import { object } from '../../services/service-types';
export function registerAttachmentHandlers(registry: ChannelRegistry, attachments: AttachmentService, pastedText: PastedTextService): void {
  registry.register('chat:upload', context => attachments.upload(object(context.args[0])), 'attachments');
  registry.register('chat:upload-path', context => attachments.uploadPath(object(context.args[0])), 'attachments');
  // Large pastes live as host-owned files; the composer carries references only.
  registry.register('chat:pasted-text-create', context => pastedText.create(pastedTextPayload(context.args[0])), 'attachments');
  registry.register('chat:pasted-text-read', context => pastedText.read(pastedTextPayload(context.args[0])), 'attachments');
  registry.register('chat:pasted-text-remove', context => pastedText.remove(pastedTextPayload(context.args[0])), 'attachments');
  registry.register('chat:pasted-text-release', async context => {
    const raw = pastedTextPayload(context.args[0]).paths;
    await pastedText.release(Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []);
    return null;
  }, 'attachments');
}
