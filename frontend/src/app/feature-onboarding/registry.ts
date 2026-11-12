// Built-in feature-discovery registry.
//
// One row per feature worth announcing or explaining. The registry ships inside
// the client and moves with its version, so a walkthrough can never name an
// anchor this build does not have. Adding a feature is a code change reviewed
// next to the feature itself.
//
// Two kinds of row:
//
//   - `release` rows carry the family they shipped in. They are listed on the
//     "what changed" card after an upgrade.
//   - `evergreen` rows carry no version. They exist for surfaces that benefit
//     from a walkthrough regardless of when they shipped.
//
// `arrival` decides when the user has reached a feature. It is a DOM-state
// predicate rather than a click record: navigation reaches these pages through
// the sidebar, the command menu, keybindings and deep links alike, and only the
// resulting DOM state is common to all of them.
//
// It is declared as data — which element, which attributes, what counts — rather
// than as an opaque closure, so the arrival observer can subscribe to exactly
// those elements and nothing else. Watching `document.body` for class changes
// instead would wake on every transcript re-render while a reply streams.

import type { ArrivalRule, FeatureHintKind } from '../../../../contracts/feature-onboarding'

/** A step of a spotlight tour. `anchor` must exist and be visible when the step
 *  runs; a step whose anchor is missing is skipped rather than drawn on nothing,
 *  because pages build their own content asynchronously. */
export interface TourStep {
  anchor: string
  titleKey: string
  bodyKey: string
  /** Open the surface this step points at, and give it a frame to lay out.
   *  Runs before the anchor is measured. */
  reveal?: () => void
  /** Where the bubble prefers to sit. Falls back to whichever side has room. */
  placement?: 'left' | 'right' | 'bottom' | 'top'
}

export interface FeatureEntry {
  id: string
  kind: FeatureHintKind
  /** Release family for `release` rows; null for evergreen ones. */
  since: string | null
  /** The DOM state that satisfies this hint. Declared, not a closure, so the
   *  arrival observer can watch exactly the elements it reads. */
  arrival: ArrivalRule
  tour?: TourStep[]
}

/** The right-hand panel's id and the mode name it carries when the file surface
 *  is showing. Both come from the shipped markup, not from a guess. */
const ARTIFACTS_PANEL_ID = 'artifacts-panel'
const WORKSPACE_MODE: ArrivalRule = { kind: 'panel-mode', panelId: ARTIFACTS_PANEL_ID, mode: 'workspace' }

/** Open the files panel. Goes through the same entry point the side rail and the
 *  command menu use, so the tour cannot drift from real navigation. */
function revealWorkspacePanel(): void {
  const w = window as any
  const panel = document.getElementById(ARTIFACTS_PANEL_ID)
  if (panel && !panel.classList.contains('collapsed') && panel.getAttribute('data-mode') === 'workspace') return
  if (typeof w.openArtifactsPanel === 'function') w.openArtifactsPanel('workspace')
  else document.getElementById('workspace-panel-toggle')?.click()
}

/** Registry order is the order features are listed and evaluated. */
export const FEATURE_REGISTRY: readonly FeatureEntry[] = [
  // --- evergreen: a surface that explains itself on arrival ---
  {
    id: 'workspace-files',
    kind: 'evergreen',
    since: null,
    arrival: WORKSPACE_MODE,
    // No step on the entry button itself. A tour starts on ARRIVAL, so the user
    // has just clicked it — and opening the panel hides the whole side rail
    // (`body.artifacts-open .side-rail { display: none }`), which would make the
    // step unmeasurable anyway. This tour explains what is inside the panel.
    // Both steps anchor a STATIC id from index.html, not a node a React island
    // fills in later: an async container measures zero-height until its content
    // lands, and a step that cannot be measured is a step that gets skipped.
    // The tree step points at the SECTION, not at #artifacts-list, because the
    // list is empty (zero-height) for a project with no files yet — and a tour
    // that starts by opening the Files panel is exactly the situation where the
    // list may well be empty. The section header keeps it measurable.
    // The 6px drag handle is deliberately not a step — spotlighting an invisible
    // strip teaches nothing, and the resize affordance is mentioned in the card.
    tour: [
      {
        anchor: 'monitor-section-workspace',
        titleKey: 'onb_tour_ws_tree_title',
        bodyKey: 'onb_tour_ws_tree_body',
        placement: 'left',
        reveal: revealWorkspacePanel,
      },
      {
        anchor: 'workspace-main-view',
        titleKey: 'onb_tour_ws_preview_title',
        bodyKey: 'onb_tour_ws_preview_body',
        placement: 'bottom',
        reveal: revealWorkspacePanel,
      },
    ],
  },

  // --- release 0.5 ---
  {
    id: 'desktop-pets',
    kind: 'release',
    since: '0.5',
    arrival: { kind: 'settings-tab', stab: 'pets' },
  },
  {
    id: 'workspace-file-tree',
    kind: 'release',
    since: '0.5',
    arrival: WORKSPACE_MODE,
  },
  {
    id: 'queued-messages',
    kind: 'release',
    since: '0.5',
    // Behaviour inside the composer, with no surface of its own to arrive at.
    arrival: { kind: 'never' },
  },
  {
    id: 'message-prediction',
    kind: 'release',
    since: '0.5',
    arrival: { kind: 'never' },
  },
  {
    id: 'pdf-skill',
    kind: 'release',
    since: '0.5',
    arrival: { kind: 'never' },
  },
  {
    id: 'skills-live-reload',
    kind: 'release',
    since: '0.5',
    arrival: { kind: 'view-active', viewId: 'skills-view' },
  },
  {
    id: 'hooks-manager',
    kind: 'release',
    since: '0.5',
    arrival: { kind: 'settings-tab', stab: 'hooks' },
  },
  {
    id: 'power-save',
    kind: 'release',
    since: '0.5',
    arrival: { kind: 'settings-tab', stab: 'preferences' },
  },

  // --- release 0.6 ---
  {
    // Headline surface of this release: prototypes from chat open as a tab of
    // the shared right panel.
    id: 'prototype-panel',
    kind: 'release',
    since: '0.6',
    arrival: { kind: 'panel-mode', panelId: ARTIFACTS_PANEL_ID, mode: 'prototype' },
  },
  {
    id: 'runtime-config',
    kind: 'release',
    since: '0.6',
    arrival: { kind: 'settings-tab', stab: 'preferences' },
  },
  {
    id: 'profile-page',
    kind: 'release',
    since: '0.6',
    arrival: { kind: 'settings-tab', stab: 'profile' },
  },
  {
    id: 'multi-window',
    kind: 'release',
    since: '0.6',
    // Window and menu chrome lives outside the renderer skeleton; there is no
    // in-page surface to arrive at, so this stays card-only.
    arrival: { kind: 'never' },
  },
  {
    id: 'workbuddy-editions',
    kind: 'release',
    since: '0.6',
    arrival: { kind: 'settings-tab', stab: 'models' },
  },
  {
    id: 'media-generation-events',
    kind: 'release',
    since: '0.6',
    // A transcript behaviour with no page of its own.
    arrival: { kind: 'never' },
  },
  {
    id: 'talking-head-skill',
    kind: 'release',
    since: '0.6',
    // Marketplace content: installing it happens in the skills page, which the
    // Extensions entry already leads to; this row only announces it.
    arrival: { kind: 'never' },
  },
  {
    id: 'pets-voice-follow',
    kind: 'release',
    since: '0.6',
    // The behaviour lives on the floating pet window, which the main-window
    // arrival observer cannot see.
    arrival: { kind: 'never' },
  },
  {
    id: 'settings-search',
    kind: 'release',
    since: '0.6',
    // The search box is part of the settings chrome every tab shows; singling
    // out one tab as its arrival would misreport where it lives.
    arrival: { kind: 'never' },
  },
]

