// Shared storage + decision contract for feature discovery.
//
// Two surfaces share one ledger, and the host must agree with the renderer on
// the row names so that acknowledging a hint can never rebuild a live session:
//
//   1. a "what changed in this release" card shown once after an upgrade;
//   2. an optional multi-step spotlight tour for the features that need one.
//
// Everything is I/O free here so the rules are unit-testable and pinned by
// contracts/vectors/feature-onboarding-vectors.json.
//
// Design notes that are easy to get backwards:
//
//   - The seen-ledger is an ACCUMULATIVE ARRAY, not one boolean per feature.
//     A feature is new exactly when its id is absent from the array, so adding
//     a feature to the registry needs no migration and a retired feature leaves
//     a harmless orphan string behind.
//   - The version baseline is a RELEASE FAMILY (`major.minor`), never the full
//     version string. Comparing full strings would re-announce on every patch
//     release; comparing families announces once per minor and stays quiet for
//     `0.5.0 → 0.5.3`.
//   - The localStorage mirror carries the ledger ONLY. The announcement window
//     is derived from the baseline row, which lives in settings.db, so a mirror
//     that also cached the window would announce a release the user has already
//     seen until the KV read landed.

/** settings.db KV row holding the JSON seen-ledger: `string[]` of feature ids. */
export const FEATURE_SEEN_LEDGER_KEY = 'onboarding.feature_seen'

/** settings.db KV row holding the last announced release family, e.g. `"0.5"`. */
export const FEATURE_BASELINE_KEY = 'onboarding.last_seen_release_family'

/** localStorage mirror of both rows, available on the first frame instead of
 *  after the KV round trip. The mirror is never authoritative: the KV read
 *  reconciles it and wins. */
export const FEATURE_ONBOARDING_MIRROR_KEY = 'klaus_onboarding_mirror'

/** Keys whose writes must never mark a live session stale. Acknowledging
 *  onboarding state is pure UI chrome; without this exemption every
 *  acknowledgement would force `session/close` + rebuild on the next call
 *  (main/sessions/configuration.ts). */
export const FEATURE_ONBOARDING_UI_STATE_KEYS: readonly string[] = [
  FEATURE_SEEN_LEDGER_KEY,
  FEATURE_BASELINE_KEY,
]

// --- release family ---

/** Reduce a version string to its `major.minor` family with leading zeros
 *  stripped, so `0.5.0` and `0.5.3` are the same family and `0.10` sorts above
 *  `0.9`. Returns null for anything unparseable, which callers must treat as
 *  "cannot decide" rather than as "no change". */
export function releaseFamily(version: string | null | undefined): string | null {
  if (typeof version !== 'string') return null
  const match = /^\s*(\d+)\.(\d+)/.exec(version)
  if (!match) return null
  return `${Number(match[1])}.${Number(match[2])}`
}

/** Numeric family ordering. Both sides must already be normalized by
 *  `releaseFamily`; a non-family input compares as 0 rather than throwing. */
export function compareReleaseFamilies(a: string, b: string): number {
  const parse = (family: string): [number, number] => {
    const [major, minor] = family.split('.')
    return [Number(major) || 0, Number(minor) || 0]
  }
  const [aMajor, aMinor] = parse(a)
  const [bMajor, bMinor] = parse(b)
  return aMajor - bMajor || aMinor - bMinor
}

// --- seen ledger ---

/** Parse the persisted ledger. Anything that is not an array of strings
 *  degrades to an empty ledger (all features read as new) rather than throwing,
 *  because a corrupt row must never block the app from booting. */
export function parseSeenLedger(raw: unknown): string[] {
  let value: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return []
    try { value = JSON.parse(text) } catch { return [] }
  }
  if (!Array.isArray(value)) return []
  const seen: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry && !seen.includes(entry)) seen.push(entry)
  }
  return seen
}

/** Return a new ledger with `id` appended. Already-present ids are a no-op, so
 *  re-acknowledging never grows the row. Never mutates the input. */
export function withFeatureSeen(ledger: readonly string[], id: string): string[] {
  if (!id || ledger.includes(id)) return [...ledger]
  return [...ledger, id]
}

/** Merge two ledgers into their union, preserving `base` order and appending
 *  what only `other` has.
 *
 *  This is what makes a multi-window write safe. The row is overwritten whole
 *  (settings.db KV has no append), so two windows acknowledging different
 *  features inside one round trip would otherwise let the later write clobber
 *  the earlier one and lose an acknowledgement the user already made. A broadcast
 *  narrows that window but does not close it: the other window may already have
 *  queued a write built from state it read before ours landed.
 *
 *  Union is correct here and only here because the ledger is APPEND-ONLY — no
 *  code path removes an id, so nothing can be wrongly revived by merging. A
 *  ledger that gained a "forget this hint" action would need a tombstone instead. */
export function unionLedger(base: readonly string[], other: readonly string[]): string[] {
  const merged = [...base]
  for (const id of other) {
    if (id && !merged.includes(id)) merged.push(id)
  }
  return merged
}

// --- arrival rules ---

/** What counts as "the user reached this feature".
 *
 *  Declared as data rather than as an opaque closure so the arrival observer can
 *  watch exactly the elements and attributes a rule reads. A single body-wide
 *  `class` observer instead would wake on every transcript re-render while a
 *  reply streams, and would have to re-evaluate every rule only to find nothing
 *  had changed. */
export type ArrivalRule =
  /** A full-page sidebar view carries `.active` while it is the current page. */
  | { kind: 'view-active'; viewId: string }
  /** A settings tab is open when the overlay is active AND the panel names it. */
  | { kind: 'settings-tab'; stab: string }
  /** The right-hand panel is open in a given mode and not collapsed. */
  | { kind: 'panel-mode'; panelId: string; mode: string }
  /** A toggle button reports its own pressed state. */
  | { kind: 'aria-pressed'; id: string }
  /** Card-only: there is no surface to arrive at. */
  | { kind: 'never' }

/** The settings overlay root and the panel that names the open tab. Neither has
 *  a stable id in the shell markup, so they are reached by selector. */
export const SETTINGS_VIEW_ID = 'settings-view'
export const SETTINGS_PANEL_SELECTOR = '.settings-main'

export interface ArrivalSubjects {
  ids: string[]
  selectors: string[]
  attributes: string[]
}

/** Which elements and attributes a rule depends on. Pure, so the observer's
 *  subscription set is derivable and testable without a DOM. */
export function arrivalSubjects(rule: ArrivalRule): ArrivalSubjects {
  switch (rule.kind) {
    case 'view-active':
      return { ids: [rule.viewId], selectors: [], attributes: ['class'] }
    case 'settings-tab':
      return { ids: [SETTINGS_VIEW_ID], selectors: [SETTINGS_PANEL_SELECTOR], attributes: ['class', 'data-stab'] }
    case 'panel-mode':
      return { ids: [rule.panelId], selectors: [], attributes: ['class', 'data-mode'] }
    case 'aria-pressed':
      return { ids: [rule.id], selectors: [], attributes: ['aria-pressed'] }
    case 'never':
      return { ids: [], selectors: [], attributes: [] }
  }
}

/** The union of every rule's subjects, deduplicated, in first-seen order. This
 *  is the complete set the arrival observer needs — and nothing outside it can
 *  change an arrival verdict. */
export function unionArrivalSubjects(rules: readonly ArrivalRule[]): ArrivalSubjects {
  const ids: string[] = []
  const selectors: string[] = []
  const attributes: string[] = []
  for (const rule of rules) {
    const subject = arrivalSubjects(rule)
    for (const id of subject.ids) if (!ids.includes(id)) ids.push(id)
    for (const selector of subject.selectors) if (!selectors.includes(selector)) selectors.push(selector)
    for (const attribute of subject.attributes) if (!attributes.includes(attribute)) attributes.push(attribute)
  }
  return { ids, selectors, attributes }
}

// --- tour completion ---

/** Prefix separating "the user arrived at this feature" from "the user finished
 *  its walkthrough" inside the one ledger row.
 *
 *  Two facts with different lifetimes share a row because they are always read
 *  and written together, and a second KV row would mean a second round trip.
 *  The feature id is recorded on arrival; a tour replays only if its own marker
 *  is absent, so arriving twice never starts it twice. */
export const TOUR_DONE_PREFIX = 'tour:'

export function tourDoneId(featureId: string): string {
  return `${TOUR_DONE_PREFIX}${featureId}`
}

/** Whether a feature's walkthrough was completed or explicitly skipped. Both
 *  count as done: a user who skipped it has declined, and replaying on the next
 *  arrival turns a dismissal into a recurring interruption. */
export function isTourDone(ledger: readonly string[], featureId: string): boolean {
  return ledger.includes(tourDoneId(featureId))
}

/** A tour may only start while nothing else holds the user's attention. The
 *  arrival-transition rule that keeps a boot-restored surface from launching a
 *  walkthrough is `startsTourOnArrival`, not a flag here. */
export function tourMayStart(input: {
  ledger: readonly string[]
  featureId: string
  hasTour: boolean
  cardVisible: boolean
  tourActive: boolean
}): boolean {
  const { ledger, featureId, hasTour, cardVisible, tourActive } = input
  if (!hasTour || cardVisible || tourActive) return false
  return !isTourDone(ledger, featureId)
}

/** Whether this arrival may start a walkthrough: only a false→true transition.
 *
 *  Two cases this rules out, both of which are worse than showing nothing:
 *
 *  - A surface already open when the sweep first ran (restored window state, a
 *    deep link) is not an arrival the user just made. Launching a walkthrough
 *    over their first frame greets every such launch with a modal.
 *  - A tour deferred because the upgrade card was up must not fire later on some
 *    unrelated mutation while the user is still sitting on that page. The card
 *    already told them about the feature; a modal appearing minutes later, for no
 *    action they just took, is an interruption with no cause.
 *
 *  `previous === undefined` means the entry was never evaluated, which only
 *  happens on the first sweep — and the first sweep records arrivals without
 *  starting anything, which is what `initialSweep` makes explicit. */
export function startsTourOnArrival(input: {
  previous: boolean | undefined
  now: boolean
  initialSweep: boolean
}): boolean {
  return !input.initialSweep && input.previous === false && input.now
}

// --- announcement decision ---

/** Minimal shape the decision needs from the registry; the renderer's full
 *  entry type extends this. */
export interface FeatureVersionRecord {
  id: string
  kind: FeatureHintKind
  /** Release family the feature first shipped in, e.g. `"0.5"`. Null for
   *  evergreen hints, which are not tied to any release and therefore never
   *  enter an announcement window. */
  since: string | null
}

export type OnboardingDecisionKind = 'baseline' | 'idle' | 'announce'

export interface OnboardingDecision {
  kind: OnboardingDecisionKind
  /** Feature ids inside the announcement window, in registry order. Empty
   *  unless `kind === 'announce'`. */
  features: string[]
  /** The family to persist as the new baseline. Null means "do not write",
   *  which is the case when the running version could not be parsed. */
  baseline: string | null
}

/** Decide what a launch should show.
 *
 *  - `idle` — the running family is not newer than the baseline, or the running
 *    version could not be parsed. Patch releases and downgrades land here.
 *  - `announce` — either an upgrade across at least one minor (window
 *    `(baseline, current]`), or a missing baseline with features in the running
 *    family. A user who skipped two releases catches up on both; a feature
 *    shipped before their baseline never resurfaces.
 *  - `baseline` — a missing baseline with nothing to announce. Record the
 *    running family and stay quiet.
 *
 *  A missing baseline covers both a first install and an upgrade performed
 *  before this system existed; the two are indistinguishable from stored state.
 *  Announcing the running family serves both: the upgrading user learns what
 *  they just got, and a first-time user gets one orientation card for the
 *  release they installed. Staying silent instead would permanently hide the
 *  introducing release from every existing installation, which is the larger
 *  loss. */
export function decideOnboarding(input: {
  baseline: string | null
  currentFamily: string | null
  registry: readonly FeatureVersionRecord[]
}): OnboardingDecision {
  const { baseline, currentFamily, registry } = input
  if (!currentFamily) return { kind: 'idle', features: [], baseline: null }
  const releasable = registry.filter(entry => entry.kind === 'release' && releaseFamily(entry.since))
  if (!baseline) {
    const features = releasable
      .filter(entry => releaseFamily(entry.since) === currentFamily)
      .map(entry => entry.id)
    return features.length
      ? { kind: 'announce', features, baseline: currentFamily }
      : { kind: 'baseline', features: [], baseline: currentFamily }
  }
  if (compareReleaseFamilies(currentFamily, baseline) <= 0) {
    return { kind: 'idle', features: [], baseline: null }
  }
  const features: string[] = []
  for (const entry of releasable) {
    const family = releaseFamily(entry.since)!
    if (compareReleaseFamilies(family, baseline) > 0 && compareReleaseFamilies(family, currentFamily) <= 0) {
      features.push(entry.id)
    }
  }
  return { kind: 'announce', features, baseline: currentFamily }
}

// --- hint kinds ---

/** What a discovery hint is for.
 *
 *  - `release` — tied to a release family. It is listed on the "what changed"
 *    card for users who upgraded across that family.
 *  - `evergreen` — no version tie. It may carry a walkthrough that runs when the
 *    user first reaches the surface, regardless of when it shipped. */
export type FeatureHintKind = 'release' | 'evergreen'

// --- mirror ---

/** The first-paint mirror. Holds the ledger and nothing else: every fact it
 *  could carry beyond that is either derivable (the announcement window, from
 *  the baseline) or must not be guessed (whether a card was dismissed). */
export interface OnboardingMirror {
  ledger: string[]
}

export function parseMirror(raw: string | null | undefined): OnboardingMirror | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object') return null
    return { ledger: parseSeenLedger(value.ledger) }
  } catch {
    return null
  }
}

export function serializeMirror(mirror: OnboardingMirror): string {
  return JSON.stringify({ ledger: mirror.ledger })
}
