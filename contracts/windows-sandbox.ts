export const WINDOWS_SANDBOX_SETUP_MODES = ['elevated', 'unelevated'] as const;
export const WINDOWS_SANDBOX_LEVELS = [...WINDOWS_SANDBOX_SETUP_MODES, 'mxc'] as const;
export const WINDOWS_SANDBOX_SETTING_KEY = 'klaus.windows.sandbox';

export type WindowsSandboxSetupMode = typeof WINDOWS_SANDBOX_SETUP_MODES[number];
export type WindowsSandboxLevel = typeof WINDOWS_SANDBOX_LEVELS[number];
export interface WindowsSandboxReadinessResponse {
  status: 'ready' | 'notConfigured' | 'updateRequired';
}
export interface WindowsSandboxSetupStartParams {
  mode: WindowsSandboxSetupMode;
  cwd?: string | null;
}
export interface WindowsSandboxSetupStartResponse { started: boolean }
export interface WindowsSandboxSetupCompletedNotification {
  mode: WindowsSandboxSetupMode;
  success: boolean;
  error: string | null;
}

export function isWindowsSandboxSetupMode(value: unknown): value is WindowsSandboxSetupMode {
  return value === 'elevated' || value === 'unelevated';
}
export function isWindowsSandboxSetupCompleted(value: unknown): value is WindowsSandboxSetupCompletedNotification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return isWindowsSandboxSetupMode(event.mode) && typeof event.success === 'boolean'
    && (event.error === null || typeof event.error === 'string');
}
