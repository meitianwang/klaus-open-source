// Shared storage + decision contract for feature discovery.
//
// Two surfaces share one ledger, and the host must agree with the renderer on
// the row names so that acknowledging a hint can never rebuild a live session:
//
//   1. a full-screen post-upgrade guide: a short page sequence introducing the
//      release, closed by a reading-density choice. Its copy ships in the
//      client and may be overridden by the control plane;
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
//   - The guide is remembered by GUIDE ID plus REVISION, both named by the
//     control plane. The client never derives either from its own version:
//     which release gets an announcement, including a patch release, is an
//     ops decision expressed by publishing a config. Same id and revision
//     stays closed once dismissed; bumping the revision re-shows it; a new id
//     always shows.
//   - The guide is fail-closed: it appears only while the control plane says
//     `enable: true`. A client that cannot reach the server stays quiet, like
//     the feature gates, because a half-delivered introduction is worse than
//     none.
//   - The seen mark is written when the user DISMISSES or FINISHES the guide,
//     not when it first paints. Writing it on paint would let a launch that
//     failed to render the surface silently consume the announcement.
//   - The localStorage mirror carries the ledger ONLY. The guide decision also
//     needs the control-plane config, which arrives asynchronously, so a mirror
//     cannot meaningfully guess it and must not try.

/** settings.db KV row holding the JSON seen-ledger: `string[]` of feature ids. */
export const FEATURE_SEEN_LEDGER_KEY = 'onboarding.feature_seen'

/** settings.db KV row holding the guides already shown, as a JSON object
 *  mapping guide id to `true`. Keyed by guide rather than by version so a
 *  corrected re-publish under the same id stays dismissed while a new id
 *  announces again. */
export const GUIDE_SEEN_KEY = 'onboarding.guide_seen'

/** settings.db KV row holding the reading density the guide's closing page
 *  wrote: `"comfortable"` or `"efficient"`. Absent means the user never chose,
 *  which reads as comfortable. */
export const READING_MODE_KEY = 'appearance.reading_mode'

/** localStorage mirror of the ledger, available on the first frame instead of
 *  after the KV round trip. The mirror is never authoritative: the KV read
 *  reconciles it and wins. */
export const FEATURE_ONBOARDING_MIRROR_KEY = 'klaus_onboarding_mirror'

/** Keys whose writes must never mark a live session stale. Acknowledging
 *  onboarding state is pure UI chrome; without this exemption every
 *  acknowledgement would force `session/close` + rebuild on the next call
 *  (main/sessions/configuration.ts). */
export const FEATURE_ONBOARDING_UI_STATE_KEYS: readonly string[] = [
  FEATURE_SEEN_LEDGER_KEY,
  GUIDE_SEEN_KEY,
  READING_MODE_KEY,
]

// --- hint kinds ---

/** What a discovery hint is for.
 *
 *  - `release` — tied to a release family. It may appear in the guide's copy
 *    for users who upgraded across that family.
 *  - `evergreen` — no version tie. It may carry a walkthrough that runs when the
 *    user first reaches the surface, regardless of when it shipped. */
export type FeatureHintKind = 'release' | 'evergreen'

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

// --- guide seen map ---

/** Parse the persisted guide seen-map: guide id → the revision the user last
 *  closed. Anything that is not an object of non-negative integer marks
 *  degrades to an empty map (every guide reads as unseen) rather than
 *  throwing: a corrupt row must never block boot. */
export function parseGuideSeenMap(raw: unknown): Record<string, number> {
  let value: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return {}
    try { value = JSON.parse(text) } catch { return {} }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const seen: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key && typeof entry === 'number' && Number.isInteger(entry) && entry >= 0) seen[key] = entry
  }
  return seen
}

/** Return a new map recording that `guideId` was closed at `revision`. Writing
 *  the same revision again is a no-op, so re-acknowledging never grows the row.
 *  Never mutates the input. */
export function withGuideSeen(map: Readonly<Record<string, number>>, guideId: string, revision: number): Record<string, number> {
  if (!guideId || map[guideId] === revision) return { ...map }
  return { ...map, [guideId]: revision }
}

// --- post-upgrade guide content ---

/** The four scenes a guide page may draw, in the only order they appear. The
 *  sequence is part of the content contract: a page list is accepted whole or
 *  not at all, so a partially overridden guide can never show two pages that
 *  assume a third. */
export const GUIDE_SCENES = ['overview', 'collaboration', 'cocreation', 'automation'] as const
export type GuideScene = (typeof GUIDE_SCENES)[number]

/** Reading density the guide's closing page offers. `comfortable` is the
 *  shipped default; `efficient` widens the transcript column and tightens its
 *  vertical rhythm so more of a long reply fits one screen. */
export type ReadingMode = 'comfortable' | 'efficient'

export interface GuidePage {
  scene: GuideScene
  eyebrow: string
  /** One entry per rendered line. The emphasis is matched against line text. */
  title: string[]
  /** Substring of one title line, drawn in the accent colour with a sweep. */
  emphasis?: string
  description: string
  /** How long this page's artwork timeline runs, in milliseconds. The timeline
   *  drives the page illustration and its progress only; turning a page always
   *  takes user input. */
  durationMs: number
}

export interface GuideLabels {
  next: string
  previous: string
  skip: string
  chooseReading: string
  start: string
  comfortable: string
  efficient: string
  comfortableHint: string
  efficientHint: string
  startTitle: string
  readingDescriptionComfortable: string
  readingDescriptionEfficient: string
}

export const GUIDE_LABEL_FIELDS = [
  'next', 'previous', 'skip', 'chooseReading', 'start', 'comfortable', 'efficient',
  'comfortableHint', 'efficientHint', 'startTitle',
  'readingDescriptionComfortable', 'readingDescriptionEfficient',
] as const satisfies readonly (keyof GuideLabels)[]

export interface GuideLocaleContent {
  features?: GuidePage[]
  labels?: Partial<GuideLabels>
}

export interface GuideData {
  /** Names this publication. Ops chooses it freely — per release, per patch,
   *  per campaign — and the client never derives one from its own version. */
  guideId?: string
  /** Ops bumps this to re-show a guide the audience already closed. Same id
   *  and same revision stays closed; same id with a higher revision shows
   *  again; a new id always shows. */
  revision?: number
  initialReadingMode?: ReadingMode
  zh?: GuideLocaleContent
  en?: GuideLocaleContent
}

/** What the control plane may publish. `enable` is the switch: absent or false
 *  means no guide, so a shipped client stays quiet until the server says
 *  otherwise (fail-closed, like the feature gates). */
export interface GuideConfig {
  schemaVersion: 1
  enable: boolean
  data?: GuideData | null
}

/** The release family the in-package guide pages describe. guide-content.ts
 *  owns the copy; this names the family it speaks for, so the decision layer
 *  can refuse to show last release's pages under this release's guide id. */
export const SHIPPED_GUIDE_FAMILY = '0.7'

/** Whether the guide has anything truthful to show for the running build.
 *
 *  Remote pages speak for any family: ops publishes them per release without a
 *  client build. The in-package pages speak only for the family they were
 *  written for — on a later family with no remote content there is nothing
 *  accurate to show, and showing the previous release's copy under a fresh
 *  guide id would spend the announcement on stale text and mark it seen. */
export function guideContentAvailable(input: {
  family: string | null
  shippedFamily: string | null
  hasRemoteFeatures: boolean
}): boolean {
  if (input.hasRemoteFeatures) return true
  return input.shippedFamily !== null && input.family === input.shippedFamily
}

/** Whether the guide should be on screen now.
 *
 *  The control plane owns every part of this decision: it switches the guide
 *  on, names the publication, and numbers it. The client contributes nothing
 *  but the record of which revision the user last closed — due means "on,
 *  named, and not yet closed at THIS revision". A patch release shows exactly
 *  when ops publishes for it; a corrected re-publish shows again the moment
 *  ops bumps the revision.
 *
 *  `shownThisSession` keeps a guide the user is currently reading on screen
 *  across re-renders — a config refresh or a language switch must not unmount
 *  the page they are on — without re-consulting the seen map, which only gains
 *  the revision once they dismiss or finish. */
export function guideDue(input: {
  enable: boolean
  guideId: string | null
  revision: number
  seen: Readonly<Record<string, number>>
  shownThisSession: boolean
}): boolean {
  if (!input.enable || !input.guideId) return false
  if (input.shownThisSession) return true
  return input.seen[input.guideId] !== input.revision
}

// --- guide config validation ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function readPage(value: unknown, index: number): GuidePage | null {
  if (!isRecord(value)) return null
  // Position fixes the scene: the sequence is the contract, so a list whose
  // nth entry names another scene is refused rather than reordered.
  const scene: GuideScene | undefined = GUIDE_SCENES[index]
  if (!scene || value.scene !== scene) return null
  const eyebrow = nonEmptyString(value.eyebrow)
  const description = nonEmptyString(value.description)
  if (!eyebrow || !description) return null
  if (!Array.isArray(value.title) || value.title.length === 0) return null
  const title: string[] = []
  for (const line of value.title) {
    const text = nonEmptyString(line)
    if (!text) return null
    title.push(text)
  }
  const emphasis = nonEmptyString(value.emphasis) ?? undefined
  const durationMs = value.durationMs
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return null
  return { scene, eyebrow, title, emphasis, description, durationMs }
}

function readLocaleContent(value: unknown): GuideLocaleContent | null {
  if (!isRecord(value)) return null
  const out: GuideLocaleContent = {}
  if (value.features !== undefined) {
    if (!Array.isArray(value.features) || value.features.length !== GUIDE_SCENES.length) return null
    const pages: GuidePage[] = []
    for (let index = 0; index < GUIDE_SCENES.length; index++) {
      const page = readPage(value.features[index], index)
      if (!page) return null
      pages.push(page)
    }
    out.features = pages
  }
  if (value.labels !== undefined) {
    if (!isRecord(value.labels)) return null
    const labels: Partial<GuideLabels> = {}
    for (const key of GUIDE_LABEL_FIELDS) {
      const text = nonEmptyString(value.labels[key])
      if (text) labels[key] = text
    }
    out.labels = labels
  }
  return out
}

/** Validate one control-plane payload into a guide config, or null when it
 *  does not match the contract. Null means "drop it": a half-parsed guide
 *  would show pages that assume copy which never arrived, so the whole payload
 *  is refused rather than partially applied. */
export function parseGuideConfig(value: unknown): GuideConfig | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion !== 1) return null
  if (typeof value.enable !== 'boolean') return null
  const config: GuideConfig = { schemaVersion: 1, enable: value.enable }
  if (value.data === undefined || value.data === null) return config
  if (!isRecord(value.data)) return null
  const data: GuideData = {}
  const guideId = nonEmptyString(value.data.guideId)
  if (guideId) data.guideId = guideId
  if (value.data.revision !== undefined) {
    const revision = value.data.revision
    if (typeof revision !== 'number' || !Number.isFinite(revision) || revision < 0 || Math.floor(revision) !== revision) return null
    data.revision = revision
  }
  if (value.data.initialReadingMode !== undefined) {
    if (value.data.initialReadingMode !== 'comfortable' && value.data.initialReadingMode !== 'efficient') return null
    data.initialReadingMode = value.data.initialReadingMode
  }
  for (const locale of ['zh', 'en'] as const) {
    if (value.data[locale] === undefined) continue
    const content = readLocaleContent(value.data[locale])
    if (!content) return null
    data[locale] = content
  }
  config.data = data
  return config
}

/** Parse the persisted reading mode. Absent or unknown values read as null,
 *  which callers treat as "never chose" (comfortable). */
export function parseReadingMode(raw: unknown): ReadingMode | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text === 'comfortable' || text === 'efficient' ? text : null
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
  /** There is no surface to arrive at; the hint is guide copy only. */
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
  guideVisible: boolean
  tourActive: boolean
}): boolean {
  const { ledger, featureId, hasTour, guideVisible, tourActive } = input
  if (!hasTour || guideVisible || tourActive) return false
  return !isTourDone(ledger, featureId)
}

/** Whether this arrival may start a walkthrough: only a false→true transition.
 *
 *  Two cases this rules out, both of which are worse than showing nothing:
 *
 *  - A surface already open when the sweep first ran (restored window state, a
 *    deep link) is not an arrival the user just made. Launching a walkthrough
 *    over their first frame greets every such launch with a modal.
 *  - A tour deferred because the guide was up must not fire later on some
 *    unrelated mutation while the user is still sitting on that page. The guide
 *    already told them about the feature; a modal appearing minutes later, for
 *    no action they just took, is an interruption with no cause.
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

// --- mirror ---

/** The first-paint mirror. Holds the ledger and nothing else: the guide
 *  decision also needs the control-plane config, which arrives asynchronously
 *  and must not be guessed on the first frame. */
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
