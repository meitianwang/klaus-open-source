// Server-controlled feature gates — renderer side.
//
// The host resolves each gate per account (src/feature-gates.ts on the server,
// services/feature-gates.ts in the main process) and exposes it through
// `klaus.featureGates.snapshot()` plus the `feature-gates:updated` push. The
// renderer never computes eligibility; it only reflects the resolved boolean.
//
// The first gated feature is team collaboration. Its sidebar entry must not
// exist for an unentitled account — not merely be present-and-disabled — so
// this module owns hiding `#btn-team-collaboration` and, when the gate flips
// off while the user is ON the page, sending them back to chat.
//
// Visibility rules live in a pure reducer so they are unit-testable;
// initFeatureGates owns the DOM and the IPC wiring.

export type GatedFeature = 'teamCollaboration'

export interface FeatureGateSnapshot {
  /** Resolved server values. A key absent here falls back to its client
   *  default (fail-closed for gated features) — see CLIENT_DEFAULTS below. */
  features: Record<string, boolean>
}

/** Compiled defaults used until the server answers. Mirrors
 *  services/feature-gates.ts CLIENT_DEFAULTS: a shipped-but-gated feature is
 *  hidden, not shown, when the control plane is unreachable. */
export const CLIENT_DEFAULTS: Readonly<Record<GatedFeature, boolean>> = {
  teamCollaboration: false,
}

/** Pure resolution: server value wins, otherwise the fail-closed default. */
export function featureEnabled(snapshot: FeatureGateSnapshot | null | undefined, feature: GatedFeature): boolean {
  const value = snapshot?.features?.[feature]
  if (typeof value === 'boolean') return value
  return CLIENT_DEFAULTS[feature]
}

/** Whether the sidebar entry for a gated feature should be visible. Currently
 *  only team collaboration has a sidebar entry; kept as its own function so a
 *  second gated entry is a one-line addition rather than a re-derivation. */
export function shouldShowTeamCollaborationEntry(snapshot: FeatureGateSnapshot | null | undefined): boolean {
  return featureEnabled(snapshot, 'teamCollaboration')
}

export interface FeatureGateDeps {
  snapshot(): Promise<FeatureGateSnapshot>
  onUpdated(handler: (payload: FeatureGateSnapshot) => void): () => void
  /** Hide the sidebar entry (gate closed). */
  setEntryVisible(visible: boolean): void
  /** Called when the gate flips to closed while the page may be showing, so
   *  the host of the view can return the user to chat. */
  onTeamCollaborationDisabled(): void
  /** Called on a closed→open transition. Boot timing: a pending hash route
   *  (e.g. a restored tcProject) is refused while the snapshot is in flight;
   *  this lets the caller replay it once the server opens the gate. */
  onTeamCollaborationEnabled?(): void
  log(message: string): void
}

export interface FeatureGateController {
  /** Latest resolved snapshot; safe to call before the first fetch resolves
   *  (returns null, which every consumer treats as fail-closed defaults). */
  current(): FeatureGateSnapshot | null
  enabled(feature: GatedFeature): boolean
  refresh(): Promise<void>
  dispose(): void
}

/**
 * Wire the gate to the DOM and IPC. Applies the initial (fail-closed) state
 * synchronously so the entry never flashes for an unentitled account, then
 * refreshes from the host and tracks live updates.
 */
export function initFeatureGates(deps: FeatureGateDeps): FeatureGateController {
  let snapshot: FeatureGateSnapshot | null = null
  let disposed = false
  let visible = false

  // Apply the fail-closed default immediately: the sidebar HTML renders the
  // entry unconditionally, so until the first snapshot lands we hide it.
  apply()

  const unsubscribe = deps.onUpdated(payload => {
    const next = normalize(payload)
    // A malformed frame carries no information. Renderer visibility is not the
    // security boundary (the host IPC refuses and the server returns 403), so
    // hold the last known-good snapshot instead of flickering the entry closed
    // on transport corruption.
    if (next) { snapshot = next; apply() }
  })

  function normalize(payload: FeatureGateSnapshot | null | undefined): FeatureGateSnapshot | null {
    if (!payload || typeof payload !== 'object') return null
    const features = (payload as { features?: unknown }).features
    if (!features || typeof features !== 'object' || Array.isArray(features)) return null
    const clean: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(features as Record<string, unknown>)) {
      if (typeof value === 'boolean') clean[key] = value
    }
    return { features: clean }
  }

  function apply(): void {
    if (disposed) return
    const next = shouldShowTeamCollaborationEntry(snapshot)
    const opened = next && !visible
    visible = next
    deps.setEntryVisible(next)
    if (next) {
      if (opened) deps.onTeamCollaborationEnabled?.()
    } else {
      deps.onTeamCollaborationDisabled()
    }
  }

  async function refresh(): Promise<void> {
    try {
      const next = normalize(await deps.snapshot())
      if (disposed) return
      // Same rule as the push: only a well-formed answer replaces the current
      // snapshot. At boot `next` is the first good value (or stays null, which
      // every consumer reads as the fail-closed default).
      if (next) { snapshot = next; apply() }
    } catch (error) {
      deps.log(`feature gate snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  void refresh()

  return {
    current: () => snapshot,
    enabled: feature => featureEnabled(snapshot, feature),
    refresh,
    dispose: () => { disposed = true; unsubscribe() },
  }
}
