import { resolveWebSearchAccess, runtimePolicyConfig, type RuntimePolicy } from '../../contracts/runtime-settings';
import type { Json } from '../ipc/contract';
import { errorMessage, object, type EngineRequest } from './service-types';

export interface EffectiveRuntimePolicy { policy: RuntimePolicy; effectiveMode?: 'read-only' }
export interface RuntimePolicyProjection {
  applies(sessionId: string): boolean;
  project(sessionId: string, policy: RuntimePolicy): Promise<EffectiveRuntimePolicy>;
}
interface WindowsRuntimePolicyDeps {
  request: EngineRequest;
  isNativeLocal(sessionId: string): boolean;
  log?(kind: string, detail: string): void;
}

export function isNativeLocalWindows(platform: NodeJS.Platform, sessionId: string, remoteBinding: (sessionId: string) => unknown): boolean {
  return platform === 'win32' && (!sessionId || remoteBinding(sessionId) === null);
}

/** Preparation changes the effective policy without changing the saved selection. */
export class WindowsRuntimePolicyProjection implements RuntimePolicyProjection {
  constructor(private readonly deps: WindowsRuntimePolicyDeps) {}
  applies(sessionId: string): boolean { return this.deps.isNativeLocal(sessionId); }
  async project(sessionId: string, policy: RuntimePolicy): Promise<EffectiveRuntimePolicy> {
    if (!this.applies(sessionId)) return { policy };
    let status: Json | undefined;
    try { status = object(await this.deps.request('engine/windowsSandboxReadiness', {})).status; }
    catch (error) {
      this.deps.log?.('windows-readiness-query-failed', errorMessage(error));
      return { policy };
    }
    if (status !== 'notConfigured' && status !== 'updateRequired') return { policy };
    return { effectiveMode: 'read-only', policy: {
      approvalPolicy: 'on-request', sandboxMode: 'read-only', approvalsReviewer: 'user', sandboxNetworkAllowed: false,
    } };
  }
}

export function applyEffectiveRuntimePolicy(init: Record<string, Json>, effective: EffectiveRuntimePolicy, values: Record<string, Json>): void {
  const config = object(init.config);
  Object.assign(config, runtimePolicyConfig(effective.policy, config.sandbox_workspace_write));
  config.webSearch = { ...object(config.webSearch), access: resolveWebSearchAccess(values, effective.policy.sandboxMode) };
  init.config = config;
  delete init.permissionMode;
  init.networkAllowed = effective.policy.sandboxNetworkAllowed;
}
