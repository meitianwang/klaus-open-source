import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { goalOwnedRoot } from '../sessions/goal-objectives';
import { pathInside } from './workspaces';
import { sessionVisualizationsDir } from './visualizations';

export interface ConversationMediaScopeDeps {
  configRoot: string;
  prepareSessionMedia: (sessionId: string) => Promise<boolean>;
  resolveSessionDirectory: (sessionId: string) => string;
  extraRoots: (sessionId: string) => string[];
  producedBySession: (path: string, sessionId: string) => boolean;
}

/** The single authorization policy used by every klaus-media file request. */
export function createConversationMediaScope(deps: ConversationMediaScopeDeps) {
  return async (path: string, sessionId: string): Promise<boolean> => {
    const roots = [join(deps.configRoot, 'media')];
    // Goal submissions copy their attachments into a per-conversation owned
    // directory; the owning conversation may show those images back.
    if (sessionId) roots.push(goalOwnedRoot(deps.configRoot, sessionId));
    if (sessionId && await deps.prepareSessionMedia(sessionId)) {
      roots.push(
        deps.resolveSessionDirectory(sessionId),
        ...deps.extraRoots(sessionId),
        join(deps.configRoot, 'uploads'),
        join(deps.configRoot, 'widgets', sessionId),
        // Markdown images and inline pages share this conversation-owned output
        // directory. Excluding it here rejects the image bytes even when the
        // file-preview service has already accepted the very same path.
        sessionVisualizationsDir(deps.configRoot, sessionId),
      );
      if (path.endsWith('.digram.json')) roots.push(join(deps.configRoot, 'digram'));
    }
    for (const root of roots) {
      try { if (pathInside(path, await realpath(root))) return true; } catch { /* Optional roots may not exist yet. */ }
    }
    // Tool paths and files selected in the trusted viewer remain showable outside
    // the roots. Each ledger entry is one canonical file, so no directory or write
    // capability is widened by it.
    return !!sessionId && deps.producedBySession(path, sessionId);
  };
}
