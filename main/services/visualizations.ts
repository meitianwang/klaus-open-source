// Thread-scoped inline-visualization directories.
//
// Every thread gets a dedicated visualization directory that is BOTH a sandbox
// writable root (so the agent can write pages there without a permission
// prompt) and the ONLY root the read handler will serve visualization pages
// from. The layout is
// `join(configRoot, 'visualizations', <rendererId>)`. One directory per host
// session id — side tasks and conversations never share one, because the
// preview capability granted to the transcript is scoped to this conversation
// and must not reach a file another conversation wrote.
//
// This module owns the path layout, the mkdir-on-demand, and the whitelist the
// file service consults when minting a `klaus-media://preview` URL for the
// renderer. It never widens WRITE scope by itself: the directory enters the
// session's `sandbox_workspace_write.writable_roots` through the session-init path
// (sessions/service.ts), which is where write grants live.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The directory holding every conversation's visualization subdirectory. */
export function visualizationsRoot(configRoot: string): string {
  return join(configRoot, 'visualizations');
}

/**
 * One conversation's visualization directory.
 *
 * `sessionId` is the renderer-side session id, which is also the engine's
 * thread identity, so the directory is stable across restarts. The layout is
 * flat per conversation — a date-nesting layer would only help if the config
 * root were a user-browsed surface, which it is not, and a flat layout keeps
 * the whitelist check a single `pathInside`. Resolved through `realpath` by
 * every caller that enforces
 * containment: on macOS `/var` is a symlink to `/private/var`, and containment
 * is only honest when both sides are real paths.
 */
export function sessionVisualizationsDir(configRoot: string, sessionId: string): string {
  if (!sessionId || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    throw new Error('Invalid session id for a visualization directory');
  }
  return join(visualizationsRoot(configRoot), sessionId);
}

/** Create the directory on demand; the agent may also create it itself. */
export function ensureSessionVisualizationsDir(configRoot: string, sessionId: string): string {
  const dir = sessionVisualizationsDir(configRoot, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
