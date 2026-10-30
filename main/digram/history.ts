import type { Json } from '../ipc/contract';
import { object } from '../services/service-types';
import type { DigramStore } from './store';
import { legacyDiagramArtifact } from '../visuals/artifacts';

/** Called only after reading the actual thread history through the engine facade. */
export function restoreLegacyDiagramCards(history: Json, sessionId: string, store: DigramStore): Json {
  const rows = object(history).messages;
  for (const raw of Array.isArray(rows) ? rows : []) {
    const blocks = object(raw).contentBlocks;
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const tool = object(block), result = object(tool.__result);
      if (tool.type !== 'tool_use' || result.artifact || typeof tool.name !== 'string') continue;
      const artifact = legacyDiagramArtifact(tool.name, result);
      if (!artifact) continue;
      try { store.claimLegacyFromHistory(artifact.id, sessionId); result.artifact = { ...artifact }; }
      catch { /* Missing files or another task's ownership cannot be repaired by a card. */ }
    }
  }
  return history;
}
