import type { VoiceChatAudioFrame, VoiceChatControl, VoiceChatOffer } from '../../../contracts/voice-chat';
import type { DesktopPetRealtime } from '../../pets/realtime';
import type { Json } from '../contract';
import { ChannelRegistry, IpcHandlerError } from '../registry';
import type { VoiceChatPresentationRuntime } from '../../app/voice-chat-presentation';
export interface VoiceChatOwnership {
  reserve(ownerId: number, requestId: string, sessionId?: string): void | Promise<void>;
  assert(ownerId: number, requestId: unknown, required?: boolean): void;
  end(ownerId: number, requestId: string): void;
}

/** Only a registered main renderer may own the conversation's live audio. */
export function registerVoiceChatHandlers(registry: ChannelRegistry, runtime: DesktopPetRealtime, owns: (id: number) => boolean, presentation: VoiceChatPresentationRuntime, ownership: VoiceChatOwnership): void {
  for (const channel of ['voice:chat:state', 'voice:chat:negotiate', 'voice:chat:end', 'voice:chat:control', 'voice:chat:audio'] as const) {
    registry.register(channel, async context => {
      if (context.role !== 'main' || !owns(context.senderId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Voice chat belongs to a registered main window');
      const value = context.args[0];
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new IpcHandlerError('BAD_REQUEST', 'Expected voice chat arguments');
      const payload = (value ?? {}) as Record<string, unknown>;
      if (channel === 'voice:chat:state') {
        if (payload.sessionId !== undefined && (typeof payload.sessionId !== 'string' || !payload.sessionId || payload.sessionId.length > 512)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid voice conversation');
        return await runtime.state(context.senderId, payload.sessionId as string | undefined) as unknown as Json;
      }
      if (channel === 'voice:chat:negotiate') { ownership.assert(context.senderId, payload.requestId, true); return await runtime.negotiate(context.senderId, payload as unknown as VoiceChatOffer) as unknown as Json; }
      if (channel === 'voice:chat:audio') { ownership.assert(context.senderId, payload.requestId); return await runtime.audio(context.senderId, payload as unknown as VoiceChatAudioFrame) as unknown as Json; }
      if (channel === 'voice:chat:end') { ownership.assert(context.senderId, payload.requestId); const state = await runtime.end(context.senderId, payload as unknown as { requestId: string; generation?: number }); ownership.end(context.senderId, payload.requestId as string); presentation.update(context.senderId, state); return state as unknown as Json; }
      return await runtime.control(context.senderId, payload as unknown as VoiceChatControl) as unknown as Json;
    }, 'voice-chat');
  }
  registry.register('voice:chat:reserve', async context => {
    const value = context.args[0] as Record<string, Json> | undefined;
    if (context.role !== 'main' || !owns(context.senderId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Unknown voice conversation owner');
    if (!value || typeof value.requestId !== 'string' || !/^[\w-]{1,128}$/u.test(value.requestId) || value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 512)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid voice reservation');
    await ownership.reserve(context.senderId, value.requestId, value.sessionId as string | undefined); return null;
  }, 'voice-chat');
  registry.register('voice:chat:present', context => {
    if (context.role !== 'main' || !owns(context.senderId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Unknown voice conversation owner');
    const value = context.args[0] as Record<string, Json> | undefined;
    if (!value || typeof value.eligible !== 'boolean' || value.sessionId !== null && (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 512) || value.notice !== undefined && (typeof value.notice !== 'string' || value.notice.length > 1024)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid voice presentation');
    presentation.present(context.senderId, { eligible: value.eligible, sessionId: value.sessionId as string | null, ...(typeof value.notice === 'string' ? { notice: value.notice } : {}) }); return null;
  }, 'voice-chat');
  registry.register('voice:chat:levels', context => {
    if (context.role !== 'main' || !owns(context.senderId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Unknown voice audio owner');
    const value = context.args[0] as Record<string, Json> | undefined;
    if (!value || typeof value.microphone !== 'number' || typeof value.output !== 'number' || ![value.microphone, value.output].every(level => Number.isFinite(level) && level >= 0 && level <= 1)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid voice audio levels');
    const bands = value.outputBands;
    if (bands !== undefined && (!Array.isArray(bands) || bands.length !== 4 || !bands.every(level => typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 1))) throw new IpcHandlerError('BAD_REQUEST', 'Invalid voice audio spectrum');
    presentation.audioLevels(context.senderId, { microphone: value.microphone, output: value.output, ...(bands ? { outputBands: bands as number[] } : {}) }); return null;
  }, 'voice-chat');
  registry.register('voice:overlay:state', context => {
    if (context.role !== 'voice-chat') throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Unknown voice presentation');
    return presentation.rendererReady(context.senderId) as unknown as Json;
  }, 'voice-chat');
  registry.register('voice:overlay:control', async context => {
    if (context.role !== 'voice-chat') throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Unknown voice presentation');
    const value = context.args[0] as Record<string, Json> | undefined;
    if (!value || typeof value.action !== 'string' || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid voice presentation action');
    await presentation.control(context.senderId, value.action, value.generation); return null;
  }, 'voice-chat');
  registry.register('voice:overlay:interaction', context => {
    const value = context.args[0] as Record<string, Json> | undefined;
    if (context.role !== 'voice-chat' || !value || typeof value.interactive !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'Invalid voice interaction');
    presentation.interaction(context.senderId, value.interactive); return null;
  }, 'voice-chat');
  registry.register('voice:overlay:drag', async context => {
    const value = context.args[0] as Record<string, Json> | undefined;
    if (context.role !== 'voice-chat' || !value || typeof value.phase !== 'string' || !['start', 'move', 'end', 'cancel'].includes(value.phase) || typeof value.x !== 'number' || typeof value.y !== 'number' || ![value.x, value.y].every(Number.isFinite)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid voice drag');
    await presentation.move(context.senderId, value.phase, value.x, value.y); return null;
  }, 'voice-chat');
}
