// The migration carries UI continuity only. Credentials and pending operations
// deliberately have no entry in this contract.
export const LEGACY_UI_STATE_KV_KEY = 'migration.webkit_ui_state.v1';
export const LEGACY_UI_STATE_LOCAL_MARKER = 'klaus.migration.webkitUiState.v1';
export const LEGACY_UI_STATE_CONSUMED = JSON.stringify({ version: 1, state: 'consumed' });

export const LEGACY_UI_STATE_LIMITS = {
  entries: 2048,
  valueChars: 2_500_000,
  totalChars: 5_000_000,
  jsonChars: 10_000_000,
} as const;

const UI_KEYS = new Set([
  'klaus_sidebar_collapsed',
  'klaus_artifacts_collapsed',
  'klaus_artifacts_panel_width',
  'klaus_artifacts_maximized',
  'klaus_artifacts_mode',
  'klaus_diff_files_collapsed',
  'klaus_monitor_sections_collapsed',
  'klaus_monitor_sections_expanded',
  // Historical renderer-side sidebar keys. Since the sidebar rework the
  // authoritative store for group/section collapse is settings.db
  // (`sidebar.project_expanded` / `sidebar.sections_collapsed`, see
  // contracts/sidebar-collapse.ts) with localStorage as a first-paint mirror.
  // Those two rows are deliberately NOT listed here: this migration writes
  // KV→localStorage once, while the collapse rows flow the other way, so
  // staging them would resurrect stale values. The three keys below stay listed
  // for the one-time WebKit import only; the sidebar seeds section state from
  // them on first run and never reads them again afterwards.
  'klaus_project_thread_expanded',
  'klaus_projects_collapsed',
  'klaus_conversations_collapsed',
  'klaus_active_project_workdir',
  'klaus_sidebar_completed_sessions',
  'klaus_session_drafts',
  'klaus_session_histories',
  'klaus_welcome_draft',
  'klaus_welcome_draft_slash_command',
  'klaus_approved_spec_docs_v2',
  'klaus_spec_executions_v1',
]);

export function isLegacyUiStateKey(key: string): boolean {
  return UI_KEYS.has(key) || /^klaus\.panelTabs\.[A-Za-z0-9_-]{1,128}$/.test(key);
}

export interface LegacyUiStateSnapshot {
  version: 1;
  state: 'staged';
  entries: Record<string, string>;
}

export function validLegacyUiStateEntries(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > LEGACY_UI_STATE_LIMITS.entries) return false;
  let chars = 0;
  for (const [key, entry] of entries) {
    if (!isLegacyUiStateKey(key) || typeof entry !== 'string'
      || entry.length > LEGACY_UI_STATE_LIMITS.valueChars) return false;
    chars += key.length + entry.length;
    if (chars > LEGACY_UI_STATE_LIMITS.totalChars) return false;
  }
  return true;
}

export function parseLegacyUiStateSnapshot(raw: unknown): LegacyUiStateSnapshot | null {
  if (typeof raw !== 'string' || raw.length > LEGACY_UI_STATE_LIMITS.jsonChars) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const snapshot = value as Partial<LegacyUiStateSnapshot>;
    return snapshot.version === 1 && snapshot.state === 'staged'
      && validLegacyUiStateEntries(snapshot.entries) ? snapshot as LegacyUiStateSnapshot : null;
  } catch { return null; }
}
