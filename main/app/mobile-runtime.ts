import type { FriendMessage, FriendReceiveReceipt } from '../../shared/friends';
import type { IpcRouter } from '../ipc/router';
import type { ChannelRegistry } from '../ipc/registry';
import { IpcHandlerError } from '../ipc/registry';
import { registerMobileBridgeHandlers } from '../ipc/handlers/mobile-bridge';
import type { SessionService } from '../sessions/service';
import { MobileBridgeService } from '../services/mobile/service';
import type { MobileAccount, MobileCallContext, MobileEngineOwner } from '../services/mobile/protocol';
import type { ThreadToolsService } from '../services/thread-tools';
import type { MediaFiles } from '../services/media-files';
import type { FileService } from '../services/files';
import type { DigramService } from '../digram/service';
import { mobileMediaPreview } from '../services/mobile/previews';
import { object, string, type JsonObject } from '../services/service-types';

export function mobileEngineOwner(sessions: SessionService): MobileEngineOwner | undefined {
  const current = sessions.engine();
  return current && !current.client.isClosed() ? { engine: current.client, generation: current.generation } : undefined;
}

/** The phone uses the ordinary named handlers with a pinned engine and a distinct caller identity. */
export function createMobileRuntime(deps: {
  connectionChanged?: () => void;
  friendMessage?: (message: FriendMessage, signal: AbortSignal) => Promise<FriendReceiveReceipt>;
  friendRevoked?: (friendshipId: string) => Promise<void>;
  friendConnected?: () => void;
  friendDisconnected?: () => void;
  registry: ChannelRegistry; router: IpcRouter; sessions: SessionService; configRoot: string;
  relayURL: string; account(): MobileAccount | undefined; isClosing(): boolean; authorizationExpired?(): void;
  hostname?: string;
  log?: (event: string, fields: JsonObject) => void;
  diagnosticsEnabled?: () => boolean;
  threadTools?: Pick<ThreadToolsService, 'receiveRemote'>;
  media?: Pick<MediaFiles, 'grant' | 'respond'>;
  files?: Pick<FileService, 'inlineVisualizationContent'>;
  digram?: Pick<DigramService, 'store' | 'icon'>;
  deviceStatus?: () => Promise<Record<string, string>>;
}): MobileBridgeService {
  const withCatalogOwner = async <T>(context: MobileCallContext, operation: () => Promise<T>): Promise<T> => {
    const current = deps.sessions.engine();
    const assertCurrent = (): void => {
      context.signal.throwIfAborted();
      if (deps.isClosing()) throw new IpcHandlerError('APP_CLOSING', 'The application is shutting down');
      const latest = deps.sessions.engine();
      if (!current || current.client.isClosed() || current.client !== context.owner.engine
        || current.generation !== context.owner.generation || latest?.client !== current.client || latest.generation !== current.generation) {
        throw new IpcHandlerError('ENGINE_DISCONNECTED', 'The mobile catalog request belongs to a previous engine connection');
      }
    };
    assertCurrent();
    const result = await deps.sessions.withEngineOwner(current!, context.signal, operation);
    assertCurrent(); return result;
  };
  const service = new MobileBridgeService({
    connectionChanged: deps.connectionChanged,
    sessionInterestChanged: id => deps.sessions.sessionInterestChanged(id),
    friendMessage: deps.friendMessage,
    friendRevoked: deps.friendRevoked, friendConnected: deps.friendConnected, friendDisconnected: deps.friendDisconnected,
    configRoot: deps.configRoot, relayURL: deps.relayURL, account: deps.account,
    hostname: deps.hostname,
    authorizationExpired: deps.authorizationExpired,
    deviceStatus: deps.deviceStatus,
    log: deps.log,
    diagnosticsEnabled: deps.diagnosticsEnabled,
    engineOwner: () => mobileEngineOwner(deps.sessions),
    ensureEngineOwner: async signal => {
      signal.throwIfAborted();
      const previous = deps.sessions.engine();
      try { await deps.sessions.client(); }
      catch (error) {
        // A closed slot is retired by client(); only connection acquisition may retry it.
        if (!previous?.client.isClosed() || deps.sessions.engine() || deps.isClosing()
          || !(error instanceof IpcHandlerError) || error.code !== 'ENGINE_DISCONNECTED') throw error;
        signal.throwIfAborted(); await deps.sessions.client();
      }
      signal.throwIfAborted();
    },
    catalogPage: (cursor, context) => withCatalogOwner(context, async () => {
      const page = await deps.sessions.catalogPage({ cursor, limit: 100, signal: context.signal });
      return { ...page, rows: page.rows.map(object) };
    }),
    catalogRow: (id, context, priority) => withCatalogOwner(context, () => deps.sessions.catalogRow(id, { signal: context.signal, priority })),
    catalogVisible: id => deps.sessions.isCatalogVisible(id),
    followSession: async (sessionId, { signal, owner, onHistory, priority }) => {
      const current = deps.sessions.engine();
      const assertCurrent = (): void => {
        signal.throwIfAborted();
        if (deps.isClosing()) throw new IpcHandlerError('APP_CLOSING', 'The application is shutting down');
        const latest = deps.sessions.engine();
        if (!current || current.client.isClosed() || latest?.client !== current.client || latest.generation !== owner.generation || current.client !== owner.engine) {
          throw new IpcHandlerError('ENGINE_DISCONNECTED', 'The mobile follow request belongs to a previous engine connection');
        }
      };
      assertCurrent();
      return deps.sessions.withEngineOwner(current!, signal, () => deps.sessions.followHistory(sessionId, undefined, { priority, source: 'thread', signal }, onHistory));
    },
    mediaPreview: deps.media ? (sessionId, path, signal) => mobileMediaPreview(deps.media!, sessionId, path, signal) : undefined,
    inlineVisualizationPreview: deps.files ? async (sessionId, path) => object(await deps.files!.inlineVisualizationContent({ sessionId, filePath: path })) : undefined,
    diagramPreview: deps.digram ? async (sessionId, id) => {
      const document = deps.digram!.store.load(id, sessionId), icons: JsonObject = {};
      for (const page of document.pages) for (const node of page.nodes) {
        const key = string(node.icon); if (!key || Object.hasOwn(icons, key)) continue;
        const path = await deps.digram!.icon(key); if (path !== undefined) icons[key] = path;
      }
      return { document, icons };
    } : undefined,
    threadRequest: deps.threadTools ? async (name, payload, context) => {
      const current = deps.sessions.engine();
      const assertCurrent = (): void => {
        context.assertCurrent();
        if (deps.isClosing()) throw new IpcHandlerError('APP_CLOSING', 'The application is shutting down');
        if (!current || current.client.isClosed() || current.client !== context.owner.engine || current.generation !== context.owner.generation) {
          throw new IpcHandlerError('ENGINE_DISCONNECTED', 'The remote chat request belongs to a previous engine connection');
        }
      };
      assertCurrent();
      return deps.sessions.withEngineOwner(current!, context.signal, () => deps.threadTools!.receiveRemote(name, payload, { ...context, assertCurrent }));
    } : undefined,
    dispatch: async (channel, args, { signal, owner }) => {
      const current = deps.sessions.engine();
      const assertCurrent = (): void => {
        signal.throwIfAborted();
        if (deps.isClosing()) throw new IpcHandlerError('APP_CLOSING', 'The application is shutting down');
        const latest = deps.sessions.engine();
        if (!current || current.client.isClosed() || latest?.client !== current.client || latest.generation !== owner.generation || current.client !== owner.engine) {
          throw new IpcHandlerError('ENGINE_DISCONNECTED', 'The mobile request belongs to a previous engine connection');
        }
      };
      assertCurrent();
      return deps.sessions.withEngineOwner(current!, signal, async () => {
        const result = await deps.router.routeHost('mobile', channel, args, assertCurrent, signal);
        if (!result.ok) throw new IpcHandlerError(result.error.error.code, result.error.error.message);
        return result.value;
      });
    },
  });
  registerMobileBridgeHandlers(deps.registry, service);
  return service;
}
