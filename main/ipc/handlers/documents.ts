import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { DocumentService, type DocumentOptions } from '../../services/documents';

export function registerDocumentHandlers(registry: ChannelRegistry, options: DocumentOptions): DocumentService {
  const documents = new DocumentService(options);
  registry.registerAll({
    'memory:read-file': context => documents.readMemory(object(context.args[0])),
    'memory:open-window': context => documents.openMemory(object(context.args[0])),
    'memory:reveal': () => documents.revealMemory(),
    'spec:read-doc': context => documents.readSpec(object(context.args[0])),
    'spec:open-doc': context => documents.openSpec(object(context.args[0])),
    'spec:save-doc': context => documents.saveSpec(object(context.args[0])),
  }, 'documents');
  return documents;
}
