// Shared storage contract for sidebar collapse state.
//
// Both the host (main/sessions/configuration.ts) and the renderer
// (frontend/src/chat/sidebar/collapse.ts, chat.ts) agree on these names, so the
// exemption that keeps a sidebar toggle from rebuilding a live session cannot
// drift from the keys the renderer actually writes.
//
// Section collapse persists as one object row (`sidebar-collapsed-sections-v1`)
// and per-project group expansion as a tri-state. The tri-state lives in ONE
// JSON row rather than one row per project: the renderer's `settings:kv:get` is
// single-key with no scan, so per-project rows would force N awaits after the
// session list arrives before the first paint. One row keeps the same observable
// semantics (per-project tri-state memory) and hydrates in a single read.

/** Sidebar section order, top to bottom. Drives render order and the key set of
 *  the persisted section-collapse object. */
export const SIDEBAR_SECTION_KEYS = ['pinned', 'channels', 'projects', 'recent'] as const
export type SidebarSectionKey = (typeof SIDEBAR_SECTION_KEYS)[number]

/** settings.db KV row holding `{ [SidebarSectionKey]: boolean }`. */
export const SIDEBAR_SECTIONS_COLLAPSED_KEY = 'sidebar.sections_collapsed'
/** settings.db KV row holding `{ [projectKey]: boolean }` (tri-state by presence). */
export const SIDEBAR_PROJECT_EXPANDED_KEY = 'sidebar.project_expanded'

/**
 * Broadcast key for the dragged Projects-section order.
 *
 * The order itself is NOT a `settings:kv` row — it lives in the workspace store's
 * own row (`workspace.sidebar_project_order`, written by `projects:reorder`)
 * because it must be reconciled against the project registry in the same
 * transaction. This constant is only the name the host emits on
 * `app:preferences-changed` after that write, so every other window re-reads the
 * list and adopts the new order instead of keeping the arrangement it painted
 * before the drag.
 *
 * It is deliberately NOT in `SIDEBAR_UI_STATE_KEYS`: that list exempts KV rows
 * from marking a session stale, and no KV write ever carries this key.
 */
export const SIDEBAR_PROJECT_ORDER_CHANGED_KEY = 'sidebar.project_order'

/** Keys whose writes must never mark a live session stale: folding a sidebar
 *  group or section is pure UI chrome and must not trigger `session/close` +
 *  rebuild (main/sessions/configuration.ts). */
export const SIDEBAR_UI_STATE_KEYS: readonly string[] = [
  SIDEBAR_SECTIONS_COLLAPSED_KEY,
  SIDEBAR_PROJECT_EXPANDED_KEY,
]
