import { WORKSPACE_DEPENDENCIES_ENABLED_KEY, type WorkspaceDependenciesView } from '../../contracts/workspace-dependency-settings';
import { isFailure, kvGet } from './settings';
import type { WorkspaceDependenciesManager, WorkspaceDependenciesStatus } from './workspace-dependencies';

export interface WorkspaceDependencySettingsService {
  status(): WorkspaceDependenciesView;
  ensure(): Promise<WorkspaceDependenciesStatus>;
  diagnose(): Promise<WorkspaceDependenciesView>;
  reinstall(): Promise<WorkspaceDependenciesView>;
}

export interface WorkspaceDependencySettingsOptions {
  configRoot: string;
  notify?: () => void;
  enabled?: () => boolean;
}

/** An unreadable preference row must not silently withdraw the managed runtime. */
export function workspaceDependenciesEnabled(configRoot: string): boolean {
  const value = kvGet(WORKSPACE_DEPENDENCIES_ENABLED_KEY, configRoot);
  if (isFailure(value)) return true;
  return value !== 'off';
}

function view(status: WorkspaceDependenciesStatus, enabled: boolean): WorkspaceDependenciesView {
  return {
    enabled,
    state: enabled ? status.state : 'disabled',
    ...(status.version ? { version: status.version } : {}),
    ...(status.pythonVersion ? { pythonVersion: status.pythonVersion } : {}),
    ...(status.logPath ? { logPath: status.logPath } : {}),
    ...(enabled && status.error ? { error: status.error } : {}),
  };
}

/**
 * Gates the managed runtime behind the settings preference and exposes the
 * diagnose and reinstall actions the configuration page offers. The gate reads
 * the preference on every call so a write from any window applies immediately.
 */
export function createWorkspaceDependencySettingsService(
  manager: WorkspaceDependenciesManager,
  options: WorkspaceDependencySettingsOptions,
): WorkspaceDependencySettingsService {
  const enabled = options.enabled ?? (() => workspaceDependenciesEnabled(options.configRoot));
  const notify = (): void => { try { options.notify?.(); } catch { /* A failed push must not fail the action itself. */ } };
  const track = (pending: Promise<unknown>): void => { pending.then(() => notify(), () => notify()); };
  return {
    status: () => view(manager.status(), enabled()),
    ensure: () => {
      if (!enabled()) {
        return Promise.resolve({
          ...manager.status(), state: 'disabled' as const,
          error: 'Workspace dependencies are disabled in Settings. Enable them to use the managed runtime.',
        });
      }
      const pending = manager.ensure();
      track(pending);
      return pending;
    },
    diagnose: async () => {
      if (!enabled()) return view(manager.status(), false);
      const status = await manager.diagnose();
      notify();
      return view(status, true);
    },
    reinstall: async () => {
      if (!enabled()) return view(manager.status(), false);
      await manager.reset();
      const pending = manager.ensure();
      track(pending);
      return view(manager.status(), true);
    },
  };
}
