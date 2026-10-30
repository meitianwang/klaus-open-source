import { DESKTOP_PET_CHANNELS, type PetDragPoint, type PetElementLayout, type PetImportRequest, type PetRect } from '../../../contracts/desktop-pet';
import type { DesktopPetRuntime } from '../../app/desktop-pet';
import type { Json } from '../contract';
import { ChannelRegistry, IpcHandlerError, type HandlerContext } from '../registry';

export { DESKTOP_PET_CHANNELS };
function object(value: Json | undefined): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new IpcHandlerError('INVALID_ARGUMENT', 'Expected a desktop pet argument object');
  return value;
}
function text(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 8000) throw new IpcHandlerError('INVALID_ARGUMENT', 'Expected a nonempty string'); return value; }
function numeric(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new IpcHandlerError('INVALID_ARGUMENT', 'Expected a finite number'); return value; }
function version(value: unknown): 1 | 2 | undefined { if (value === undefined) return; if (value === 1 || value === 2) return value; throw new IpcHandlerError('INVALID_ARGUMENT', 'Invalid pet sprite version'); }
function importRequest(value: Record<string, unknown>, preview = false): PetImportRequest { return { name: preview && (value.name === undefined || value.name === '') ? 'Pet' : text(value.name), imageUrl: text(value.imageUrl), description: typeof value.description === 'string' ? value.description : undefined, spriteVersion: version(value.spriteVersion) }; }
function point(value: Record<string, unknown>): PetDragPoint { return { x: typeof value.x === 'number' ? numeric(value.x) : 0, y: typeof value.y === 'number' ? numeric(value.y) : 0, screenX: value.screenX === undefined ? undefined : numeric(value.screenX), screenY: value.screenY === undefined ? undefined : numeric(value.screenY) }; }
function json(value: unknown): Json { return value === undefined ? null : value as Json; }
function owner(ctx: HandlerContext, runtime: DesktopPetRuntime): void { if (!runtime.ownsWebContents(ctx.senderId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Desktop pet window is not owned by caller'); }
export function registerDesktopPetHandlers(registry: ChannelRegistry, runtime: DesktopPetRuntime): void {
  for (const channel of DESKTOP_PET_CHANNELS) registry.register(channel, async ctx => {
    const value = object(ctx.args[0]);
    switch (channel) {
      case 'desktop-pet:get-state': await runtime.initialize(); return json(runtime.snapshot());
      case 'desktop-pet:update-settings': return json(await runtime.updateSettings(value));
      case 'desktop-pet:show': return json(await runtime.show());
      case 'desktop-pet:hide': return json(await runtime.hide());
      case 'desktop-pet:toggle': return json(await runtime.toggle());
      case 'desktop-pet:renderer-ready': owner(ctx, runtime); return json(runtime.rendererReady(ctx.senderId));
      case 'desktop-pet:set-layout': owner(ctx, runtime); return json(runtime.setLayout(ctx.senderId, value as unknown as PetElementLayout));
      case 'desktop-pet:complete-focus': owner(ctx, runtime); return runtime.completeFocus(ctx.senderId, numeric(value.requestId), numeric(value.layoutRevision));
      case 'desktop-pet:set-regions': owner(ctx, runtime); runtime.setRegions(ctx.senderId, value.regions as PetRect[]); return null;
      case 'desktop-pet:drag-start': owner(ctx, runtime); runtime.startDrag(ctx.senderId, point(value)); return null;
      case 'desktop-pet:drag-move': owner(ctx, runtime); runtime.moveDrag(ctx.senderId, point(value)); return null;
      case 'desktop-pet:drag-end': owner(ctx, runtime); runtime.endDrag(ctx.senderId, point(value), value.altKey === true); return null;
      case 'desktop-pet:throw': owner(ctx, runtime); runtime.throw(ctx.senderId, numeric(value.velocityX), numeric(value.velocityY), value.bounce === true); return null;
      case 'desktop-pet:stash': owner(ctx, runtime); if (value.edge !== null && value.edge !== 'left' && value.edge !== 'right') throw new IpcHandlerError('INVALID_ARGUMENT', 'Invalid stash edge'); runtime.stash(ctx.senderId, value.edge); return null;
      case 'desktop-pet:set-composer-focused': owner(ctx, runtime); if (typeof value.focused !== 'boolean') throw new IpcHandlerError('INVALID_ARGUMENT', 'Expected composer focus state'); runtime.setComposerFocused(ctx.senderId, value.focused); return null;
      case 'desktop-pet:set-keyboard': owner(ctx, runtime); runtime.setKeyboard(ctx.senderId, value.active === true); return null;
      case 'desktop-pet:respond-task': owner(ctx, runtime); return json(await runtime.respondTask(ctx.senderId, { taskId: text(value.taskId), requestId: text(value.requestId), response: value.response }));
      case 'desktop-pet:submit': owner(ctx, runtime); await runtime.submit(ctx.senderId, text(value.text)); return null;
      case 'desktop-pet:open-task': await runtime.openTask(text(value.id)); return null;
      case 'desktop-pet:open-main': await runtime.openMain(); return null;
      case 'desktop-pet:open-settings': await runtime.openSettings(); return null;
      case 'desktop-pet:context-menu': owner(ctx, runtime); runtime.contextMenu(ctx.senderId, value.taskId === undefined ? undefined : text(value.taskId)); return null;
      case 'desktop-pet:import-file': return json(await runtime.importFile({ name: typeof value.name === 'string' ? value.name : undefined, description: typeof value.description === 'string' ? value.description : undefined, spriteVersion: version(value.spriteVersion) }));
      case 'desktop-pet:preview-url': return json(await runtime.previewUrl(importRequest(value, true)));
      case 'desktop-pet:import-url': return json(await runtime.importUrl(importRequest(value)));
      case 'desktop-pet:delete-pet': return json(await runtime.deletePet(text(value.id)));
      case 'desktop-pet:refresh-catalog': return json(await runtime.refreshCatalog());
      case 'desktop-pet:open-folder':
      case 'desktop-pet:create-pet': await runtime.createPet(); return null;
      case 'desktop-pet:upgrade-pet': await runtime.createPet(text(value.id)); return null;
      case 'desktop-pet:acknowledge-task': runtime.acknowledgeTask(text(value.id)); return null;
      case 'desktop-pet:set-task-muted': owner(ctx, runtime); if (typeof value.muted !== 'boolean') throw new IpcHandlerError('INVALID_ARGUMENT', 'Expected notification mute state'); return json(await runtime.setTaskMuted(text(value.id), value.muted));
      case 'desktop-pet:dismiss-task': runtime.dismissTask(text(value.id)); return null;
      case 'desktop-pet:clear-completed': runtime.clearCompleted(); return null;
    }
  }, 'desktop-pet');
}
