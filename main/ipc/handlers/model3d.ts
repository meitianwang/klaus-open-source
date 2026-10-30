import type { Model3DService } from '../../model3d/service';
import { message } from '../../visuals/data';
import type { ChannelRegistry } from '../registry';

/**
 * The side panel's only route into the 3D document. The agent reaches the same
 * document through the MCP tools instead; both funnel through Model3DService, so
 * a panel drag and a tool call can never hold two copies of the scene.
 */
export function registerModel3DHandlers(registry: ChannelRegistry, deps: { service: Model3DService }): void {
  for (const channel of ['model3d:list', 'model3d:get', 'model3d:mesh', 'model3d:apply', 'model3d:render-result']) {
    registry.register(channel, async context => {
      try {
        return await deps.service.invoke(context);
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    }, 'model3d');
  }
}
