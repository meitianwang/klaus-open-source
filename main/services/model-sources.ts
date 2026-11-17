/** Model sources supported by account settings and engine selection. */
export const AUTH_MODES = ['custom', 'codex', 'subscription', 'cursor', 'qoder', 'qwenwork', 'workbuddy', 'antigravity', 'trae', 'kiro', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark'] as const;

export const DEFAULT_AUTH_MODE = 'custom';

/** Auxiliary targets must retain one concrete model and its variant parameters. */
export function isCursorModelAlias(modelId: string): boolean {
  return /^(?:auto(?:-smart)?|default|high|medium|low)(?:\[.*\])?(?:@max)?$/i.test(modelId);
}
