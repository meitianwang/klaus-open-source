import { WorkspaceStore } from '../workspaces';

/** Extension scopes accept every explicitly owned root: registered projects and workspace member folders. Session bindings never grant scope authority. */
export function registeredRoots(workspaces: WorkspaceStore): string[] {
  return workspaces.scopeRoots();
}
