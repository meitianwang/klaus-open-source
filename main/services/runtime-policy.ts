import { decodeRuntimePolicy, isLegacyPermissionPreset, resolveRuntimePolicy, resolveWebSearchAccess, runtimePolicyConfig, type RuntimePolicy, type LegacyPermissionPreset } from '../../contracts/runtime-settings';
import type { Json } from '../ipc/contract';
import { sessionRuntimePolicy } from './session-store';
import { isFailure, kvGet, withSettingsTransaction } from './settings';
import { IpcHandlerError } from '../ipc/registry';
import { object } from './service-types';

export function storedPermissionMode(configRoot: string): LegacyPermissionPreset | undefined {
  const raw = kvGet('composer.permission_mode', configRoot);
  if (isFailure(raw)) throw new IpcHandlerError(raw.code, raw.message);
  return isLegacyPermissionPreset(raw) ? raw : undefined;
}

export function finishPermissionDefaultMigration(configRoot: string, mode: LegacyPermissionPreset | undefined): void {
  withSettingsTransaction(configRoot, db => {
    db.prepare('DELETE FROM settings WHERE key=?').run('migrated.composer_permission_v2');
    if (!mode) return;
    if (db.prepare('SELECT value FROM settings WHERE key=?').get('composer.permission_mode')?.value !== mode) return;
    db.prepare('DELETE FROM settings WHERE key=?').run('composer.permission_mode');
  });
}

/** A frozen canonical policy is the only execution authority. */
export function runtimePolicyForSession(sessionId: string, values: Record<string, Json>, configRoot: string, override?: RuntimePolicy, freeze = true): { policy: RuntimePolicy } {
  if (override) return { policy: override };
  const frozen = sessionRuntimePolicy(sessionId, configRoot);
  if (frozen) return decodeSavedPolicy(frozen);
  const policy = resolveRuntimePolicy(values);
  if (!freeze) return { policy };
  const saved = sessionRuntimePolicy(sessionId, configRoot, { policy: { ...policy } });
  return saved ? decodeSavedPolicy(saved) : { policy };
}

function decodeSavedPolicy(saved: Record<string, Json>): { policy: RuntimePolicy } {
  const policy = decodeRuntimePolicy(saved.policy);
  if (!policy) throw new IpcHandlerError('SESSION_POLICY_INVALID', 'The saved conversation policy is invalid');
  return { policy };
}

export function applyRuntimeSettings(init: Record<string, Json>, values: Record<string, Json>, sessionId: string, configRoot: string, override?: RuntimePolicy): { policy: RuntimePolicy } {
  const { policy } = runtimePolicyForSession(sessionId, values, configRoot, override), config = object(init.config);
  Object.assign(config, runtimePolicyConfig(policy, values.sandbox_workspace_write));
  config.modelVerbosity = ['low', 'medium', 'high'].includes(String(values.modelVerbosity)) ? values.modelVerbosity! : null;
  config.reasoningSummary = ['auto', 'concise', 'detailed', 'none'].includes(String(values.reasoningSummary)) ? values.reasoningSummary! : 'auto';
  const search = object(values.webSearch);
  config.webSearch = { ...search, access: resolveWebSearchAccess(values, policy.sandboxMode) };
  init.config = config;
  init.networkAllowed = policy.sandboxNetworkAllowed;
  delete init.permissionMode;
  return { policy };
}
