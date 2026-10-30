export const APPROVAL_POLICIES = ['on-request', 'never'] as const;
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export const APPROVAL_REVIEWERS = ['user', 'auto_review'] as const;
export const MODEL_VERBOSITIES = ['low', 'medium', 'high'] as const;
export const REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'] as const;
export const WEB_SEARCH_ACCESS_MODES = ['disabled', 'cached', 'indexed', 'live'] as const;

export type GranularApprovalPolicy = { granular: {
  sandbox_approval: boolean;
  rules: boolean;
  skill_approval: boolean;
  request_permissions: boolean;
  mcp_elicitations: boolean;
} };
export type ApprovalPolicy = typeof APPROVAL_POLICIES[number] | 'untrusted' | 'on-failure' | GranularApprovalPolicy;
export type SandboxMode = typeof SANDBOX_MODES[number];
export type ApprovalReviewer = typeof APPROVAL_REVIEWERS[number];
export type PermissionPreset = 'default' | 'auto' | 'bypassPermissions';
export type LegacyPermissionPreset = PermissionPreset | 'acceptEdits';
export type RuntimeConfigScope = { kind: 'user' } | { kind: 'project'; cwd: string };

export const RUNTIME_SETTING_KEYS = [
  'klaus.approvalPolicy', 'klaus.sandboxMode', 'klaus.sandbox.networkAllowed',
  'klaus.modelVerbosity', 'klaus.reasoningSummary', 'klaus.webSearch.access',
  'klaus.subagentModelCatalog',
] as const;
export type RuntimeSettingKey = typeof RUNTIME_SETTING_KEYS[number];
export type WebSearchAccess = typeof WEB_SEARCH_ACCESS_MODES[number];
export const RUNTIME_POLICY_SETTING_KEYS: readonly string[] = [
  'klaus.approvalPolicy', 'klaus.sandboxMode', 'klaus.sandbox.networkAllowed', 'klaus.approvalsReviewer',
];

export interface SandboxWorkspaceWrite {
  writable_roots: string[];
  network_access: boolean;
  exclude_tmpdir_env_var: boolean;
  exclude_slash_tmp: boolean;
}

export function sandboxWorkspaceWrite(value: unknown): SandboxWorkspaceWrite {
  const table = record(value);
  if (table.writable_roots !== undefined && (!Array.isArray(table.writable_roots) || table.writable_roots.some(root => typeof root !== 'string'))
    || ['network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp'].some(key => table[key] !== undefined && typeof table[key] !== 'boolean')) {
    throw new TypeError('Invalid workspace sandbox configuration');
  }
  return { writable_roots: Array.isArray(table.writable_roots) ? [...table.writable_roots] as string[] : [],
    network_access: table.network_access === true, exclude_tmpdir_env_var: table.exclude_tmpdir_env_var === true, exclude_slash_tmp: table.exclude_slash_tmp === true };
}

export interface RuntimePolicy {
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
  approvalsReviewer: ApprovalReviewer;
  sandboxNetworkAllowed: boolean;
}

/** Decode a persisted execution policy without reconstructing legacy mode authority. */
export function decodeRuntimePolicy(value: unknown): RuntimePolicy | undefined {
  const raw = record(value), approvalPolicy = decodeApprovalPolicy(raw.approvalPolicy);
  if (approvalPolicy === undefined || !SANDBOX_MODES.includes(raw.sandboxMode as SandboxMode)
    || !['user', 'auto_review', 'guardian_subagent', 'automatic'].includes(String(raw.approvalsReviewer))
    || typeof raw.sandboxNetworkAllowed !== 'boolean') return undefined;
  return { approvalPolicy, sandboxMode: raw.sandboxMode as SandboxMode,
    approvalsReviewer: raw.approvalsReviewer === 'user' ? 'user' : 'auto_review',
    sandboxNetworkAllowed: raw.sandboxMode === 'danger-full-access' || raw.sandboxNetworkAllowed };
}

export function runtimePolicyConfig(policy: RuntimePolicy, workspaceWrite?: unknown) {
  const table = sandboxWorkspaceWrite(workspaceWrite);
  if (policy.sandboxMode === 'workspace-write') table.network_access = policy.sandboxNetworkAllowed;
  return { approval_policy: policy.approvalPolicy, approvals_reviewer: policy.approvalsReviewer,
    sandbox_mode: policy.sandboxMode, sandbox_workspace_write: { ...table } };
}

export interface RuntimeConfigMigrationWarning { code: string; message: string; keys: string[] }

export interface RuntimeConfigSnapshot {
  scope: RuntimeConfigScope;
  path: string;
  version: string;
  values: RuntimeSettingValues;
  effective: RuntimeSettingValues;
  sources: Record<string, string>;
  migrationWarnings?: RuntimeConfigMigrationWarning[];
}

export type RuntimeSettingValues = {
  [Key in RuntimeSettingKey]: Key extends 'klaus.approvalPolicy' ? ApprovalPolicy | null : string | null;
};

/** Optional granular permissions default independently; unknown inner fields are ignored. */
export function decodeApprovalPolicy(value: unknown): ApprovalPolicy | undefined {
  if (typeof value === 'string') return ['on-request', 'never', 'untrusted', 'on-failure'].includes(value) ? value as ApprovalPolicy : undefined;
  const outer = record(value), granular = record(outer.granular);
  if (Object.keys(outer).length !== 1 || !Object.hasOwn(outer, 'granular')
    || ['sandbox_approval', 'rules', 'mcp_elicitations'].some(key => typeof granular[key] !== 'boolean')
    || ['skill_approval', 'request_permissions'].some(key => granular[key] !== undefined && typeof granular[key] !== 'boolean')) return undefined;
  return { granular: {
    sandbox_approval: granular.sandbox_approval as boolean, rules: granular.rules as boolean,
    skill_approval: granular.skill_approval === true,
    request_permissions: granular.request_permissions === true,
    mcp_elicitations: granular.mcp_elicitations as boolean,
  } };
}

export interface PermissionSelection {
  mode: PermissionPreset | null;
  preset: PermissionPreset | null;
  effectiveMode: PermissionPreset | 'read-only' | null;
  policy: RuntimePolicy;
  configuredPolicy: RuntimePolicy;
}

export function isLegacyPermissionPreset(value: unknown): value is LegacyPermissionPreset {
  return value === 'default' || value === 'auto' || value === 'bypassPermissions' || value === 'acceptEdits';
}

export function presetRuntimePolicy(preset: LegacyPermissionPreset, current?: RuntimePolicy): RuntimePolicy {
  if (preset === 'auto' && current && current.approvalPolicy === 'on-request' && current.sandboxMode !== 'danger-full-access') return { ...current, approvalsReviewer: 'auto_review' };
  if (preset === 'acceptEdits') return { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', approvalsReviewer: 'user', sandboxNetworkAllowed: true };
  return preset === 'bypassPermissions'
    ? { approvalPolicy: 'never', sandboxMode: 'danger-full-access', approvalsReviewer: 'user', sandboxNetworkAllowed: true }
    : { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', approvalsReviewer: preset === 'auto' ? 'auto_review' : 'user', sandboxNetworkAllowed: false };
}

/** Present a matching preset without changing the configured policy. */
export function classifyRuntimePolicy(policy: RuntimePolicy): PermissionPreset | null {
  if (typeof policy.approvalPolicy === 'object' && policy.approvalsReviewer === 'user'
    && policy.sandboxMode === 'workspace-write' && !policy.sandboxNetworkAllowed) {
    const granular = policy.approvalPolicy.granular;
    if (!granular.sandbox_approval && !granular.rules && !granular.skill_approval && granular.request_permissions && granular.mcp_elicitations) return 'default';
  }
  if (policy.approvalsReviewer === 'auto_review' && policy.approvalPolicy === 'on-request' && policy.sandboxMode !== 'danger-full-access') return 'auto';
  for (const preset of ['default', 'auto', 'bypassPermissions'] as const) {
    const expected = presetRuntimePolicy(preset);
    if (Object.keys(expected).every(key => policy[key as keyof RuntimePolicy] === expected[key as keyof RuntimePolicy])) return preset;
  }
  return null;
}

/** The governed configuration supplies the filesystem policy; absent configuration is read-only. */
export function resolveRuntimePolicy(values: Record<string, unknown>): RuntimePolicy {
  const sandboxMode = SANDBOX_MODES.includes(values.sandbox_mode as SandboxMode) ? values.sandbox_mode as SandboxMode : 'read-only';
  const parsedApproval = decodeApprovalPolicy(values.approval_policy);
  if (values.approval_policy !== null && typeof values.approval_policy === 'object' && parsedApproval === undefined) throw new TypeError('Invalid granular approval policy');
  const approvalPolicy = parsedApproval ?? (sandboxMode === 'danger-full-access' ? 'never' : 'on-request');
  return {
    approvalPolicy, sandboxMode,
    approvalsReviewer: ['auto_review', 'guardian_subagent', 'automatic'].includes(String(values.approvals_reviewer)) ? 'auto_review' : 'user',
    sandboxNetworkAllowed: sandboxMode === 'danger-full-access' ? true
      : sandboxMode === 'workspace-write' && sandboxWorkspaceWrite(values.sandbox_workspace_write).network_access,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Search freshness follows explicit intent first, then the conversation's isolation policy. */
export function resolveWebSearchAccess(values: Record<string, unknown>, sandboxMode = resolveRuntimePolicy(values).sandboxMode): WebSearchAccess {
  const search = record(values.webSearch), desktop = record(record(values.desktop).webSearch);
  if (WEB_SEARCH_ACCESS_MODES.includes(search.access as WebSearchAccess)) return search.access as WebSearchAccess;
  if (search.mode === 'off' || search.mode === 'disabled' || desktop.enabled === false || desktop.enabled === 'off') return 'disabled';
  if (search.mode === 'cached' || search.mode === 'indexed' || search.mode === 'live') return search.mode;
  return sandboxMode === 'danger-full-access' ? 'live' : 'cached';
}
