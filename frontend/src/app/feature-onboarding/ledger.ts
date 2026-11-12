// The discovery ledger: what the user has already arrived at, which guides they
// have been shown, and which walkthroughs they finished.
//
// Storage follows the pattern the sidebar already uses — settings.db is
// authoritative for the ledger, the guide seen-map and the reading mode,
// localStorage only exists so the ledger is available on the first frame
// instead of after the KV round trip, and `app:preferences-changed` carries an
// acknowledgement to the other windows.
//
// Two lifetimes share one row, separated by the `tour:` prefix
// (contracts/feature-onboarding.ts): a feature id is recorded on arrival, while
// a walkthrough replays only if its own marker is absent, so arriving twice never
// starts a tour twice.
//
// The guide seen-map is a separate row on purpose: it is keyed by guide id and
// overwritten whole on acknowledgement, while the ledger is append-only and
// merged. Mixing an overwrite-whole map into the merge-written row would let a
// concurrent window revive a guide the user just dismissed.
//
// All three rows are in FEATURE_ONBOARDING_UI_STATE_KEYS, which the host exempts
// from marking a session stale. Without that exemption, acknowledging onboarding
// state would force `session/close` + rebuild on the user's next message.

import {
  FEATURE_ONBOARDING_MIRROR_KEY,
  FEATURE_SEEN_LEDGER_KEY,
  GUIDE_SEEN_KEY,
  READING_MODE_KEY,
  defaultGuideId,
  parseGuideSeenMap,
  parseMirror,
  parseReadingMode,
  parseSeenLedger,
  releaseFamily,
  serializeMirror,
  tourDoneId,
  tourMayStart,
  unionLedger,
  withFeatureSeen,
  withGuideSeen,
  type GuideConfig,
  type ReadingMode,
} from '../../../../contracts/feature-onboarding'
import type { FeatureEntry } from './registry'

const w = () => window as any

interface OnboardingState {
  /** Acknowledged ids: arrived features plus `tour:` completion markers. */
  ledger: string[]
  /** Guides already shown, by guide id. */
  guideSeen: Record<string, true>
  /** The control plane's current guide config. Null until the host answers,
   *  which reads as "no guide": the guide is fail-closed. */
  guideConfig: GuideConfig | null
  /** Guide id on screen in this window. Keeps the page the user is reading
   *  mounted across config refreshes and language switches, which must not
   *  re-decide against the seen map (it only gains the id on dismissal). */
  guideOnScreen: string | null
  /** Reading density persisted by the guide's closing page. Null means the
   *  user never chose, which reads as comfortable. */
  readingMode: ReadingMode | null
  tourActive: boolean
}

let state: OnboardingState = {
  ledger: [],
  guideSeen: {},
  guideConfig: null,
  guideOnScreen: null,
  readingMode: null,
  tourActive: false,
}

/** Release family of the running build, injected at boot. The guide's default
 *  id derives from it, so the ledger never reads a second version source. */
let runningFamily: string | null = null

let mirrorHydrated = false
const listeners = new Set<() => void>()
let writeTail: Promise<void> = Promise.resolve()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeOnboarding(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Record the running build's family. Called once at boot, before any guide
 *  decision, so a config push that lands early still resolves a default id. */
export function setRunningVersion(version: string | null): void {
  runningFamily = releaseFamily(version)
}

/** The running build's release family, for content-availability decisions. */
export function currentReleaseFamily(): string | null {
  return runningFamily
}

function safeLocalStorage(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function writeMirror(): void {
  try {
    localStorage.setItem(FEATURE_ONBOARDING_MIRROR_KEY, serializeMirror({ ledger: state.ledger }))
  } catch { /* a full or blocked localStorage must not break the app */ }
}

/** Read the mirror synchronously, before the first paint, so the ledger state is
 *  available immediately instead of after the KV read. The mirror carries the
 *  ledger only: whether a guide is owed also needs the control-plane config,
 *  which arrives asynchronously and must not be guessed on the first frame. */
export function hydrateFromMirror(): void {
  if (mirrorHydrated) return
  const mirror = parseMirror(safeLocalStorage(FEATURE_ONBOARDING_MIRROR_KEY))
  if (mirror) state = { ...state, ledger: mirror.ledger }
  mirrorHydrated = true
  emit()
}

/** A row read that keeps "absent" and "unreadable" apart.
 *
 *  Collapsing them into one null is what makes a transient IPC failure look
 *  like a first install, and a first install is the branch that shows a guide —
 *  so one failed read would replay a guide the user had already dismissed.
 *  `absent` is the only answer that may drive a first show. */
type RowRead = { status: 'value'; value: string } | { status: 'absent' } | { status: 'failed' }

async function kvRead(key: string): Promise<RowRead> {
  const kv = w().klaus?.settings?.kv ?? w().settingsApi?.kv
  if (!kv?.get) return { status: 'failed' }
  try {
    const value = await kv.get(key)
    return value == null ? { status: 'absent' } : { status: 'value', value: String(value) }
  } catch {
    return { status: 'failed' }
  }
}

async function kvGet(key: string): Promise<string | null> {
  const read = await kvRead(key)
  return read.status === 'value' ? read.value : null
}

async function kvSet(key: string, value: string): Promise<void> {
  const kv = w().klaus?.settings?.kv ?? w().settingsApi?.kv
  if (!kv?.set) return
  const result = await kv.set(key, value)
  if (result?.ok === false || result?.error) throw new Error(result.error || 'settings write failed')
}

/** Serialized durable writes. Two acknowledgements landing in quick succession
 *  issue two IPC calls; unserialized they can arrive out of order and leave the
 *  older ledger in settings.db, losing an acknowledgement the user already made. */
function enqueueWrite(run: () => Promise<void>): void {
  writeTail = writeTail.then(run, run).catch(() => {
    // A failed acknowledgement is not worth a toast: the state is already
    // updated in this window, and the next launch re-reads the mirror.
  })
}

function appendLedger(...ids: string[]): void {
  let ledger = state.ledger
  let changed = false
  for (const id of ids) {
    if (!id || ledger.includes(id)) continue
    ledger = withFeatureSeen(ledger, id)
    changed = true
  }
  if (!changed) return
  // Local state moves first so the acknowledgement is not delayed by an IPC
  // round trip; only the durable write trails.
  state = { ...state, ledger }
  writeMirror()
  emit()
  enqueueWrite(() => mergeAndWriteLedger(ledger))
}

/** Adopt a ledger into state.
 *
 *  Shared by the cross-window broadcast and by the merge-on-write path below, so
 *  both agree on what adopting someone else's ledger means. Returns whether
 *  anything actually changed, because an unchanged adoption must not emit. */
function adoptLedger(ledger: readonly string[]): boolean {
  const current = state.ledger
  if (ledger.length === current.length && ledger.every(id => current.includes(id))) return false
  state = { ...state, ledger: [...ledger] }
  writeMirror()
  emit()
  return true
}

/** Persist a ledger without discarding what another window wrote meanwhile.
 *
 *  The row is overwritten whole — settings.db KV has no append — so writing local
 *  state directly would clobber a concurrent acknowledgement and lose an
 *  acknowledgement the user already made. Reading the authoritative row back and
 *  unioning is correct here only because the ledger is append-only (see
 *  `unionLedger`); a ledger that could forget an id would need a tombstone
 *  instead, since a union would revive it.
 *
 *  A failed read falls back to writing local state. Losing another window's
 *  acknowledgement is the lesser harm, and its own broadcast still reaches us. */
async function mergeAndWriteLedger(local: readonly string[]): Promise<void> {
  const durable = await kvGet(FEATURE_SEEN_LEDGER_KEY)
  const merged = durable == null ? [...local] : unionLedger(parseSeenLedger(durable), local)
  await kvSet(FEATURE_SEEN_LEDGER_KEY, JSON.stringify(merged))
  // The row may hold ids this window never saw. Adopting them here keeps the
  // mirror honest without waiting for the broadcast to arrive.
  adoptLedger(merged)
}

/** Load the durable onboarding rows. A failed read leaves the mirror-derived
 *  state in place, which is the same as "show what we last knew"; only an
 *  ABSENT row may drive a first-show decision, and the guide is fail-closed on
 *  top of that. */
export async function hydrateOnboarding(): Promise<void> {
  hydrateFromMirror()
  const [ledgerRead, guideRead, readingRead] = await Promise.all([
    kvRead(FEATURE_SEEN_LEDGER_KEY),
    kvRead(GUIDE_SEEN_KEY),
    kvRead(READING_MODE_KEY),
  ])
  const ledger = ledgerRead.status === 'value' ? parseSeenLedger(ledgerRead.value) : state.ledger
  // An absent seen-map genuinely means "no guide acknowledged yet". A failed
  // read keeps the in-memory map, which on a cold boot is empty — the same
  // answer, and the control plane still has to switch the guide on.
  const guideSeen = guideRead.status === 'value' ? parseGuideSeenMap(guideRead.value) : state.guideSeen
  const readingMode = readingRead.status === 'value' ? parseReadingMode(readingRead.value) : state.readingMode
  state = { ...state, ledger, guideSeen, readingMode }
  writeMirror()
  emit()
}

/** Acknowledge a feature: it leaves the arrival-driven ledger. */
export function markFeatureSeen(id: string): void {
  if (!id) return
  appendLedger(id)
}

/** Record a finished or skipped walkthrough. */
export function markTourDone(featureId: string): void {
  appendLedger(tourDoneId(featureId))
}

/** Adopt a ledger written by another window. The broadcast carries only the key,
 *  so this re-reads the authoritative row. */
export async function applyRemoteLedger(): Promise<void> {
  const raw = await kvGet(FEATURE_SEEN_LEDGER_KEY)
  if (raw == null) return
  adoptLedger(parseSeenLedger(raw))
}

/** Adopt a guide seen-map or reading mode written by another window. The
 *  broadcast carries only the key, so this re-reads both authoritative rows. */
export async function applyRemoteGuideState(): Promise<void> {
  const [seenRaw, readingRaw] = await Promise.all([kvGet(GUIDE_SEEN_KEY), kvGet(READING_MODE_KEY)])
  const seen = seenRaw == null ? state.guideSeen : parseGuideSeenMap(seenRaw)
  const readingMode = readingRaw == null ? state.readingMode : parseReadingMode(readingRaw)
  const sameSeen = Object.keys(seen).length === Object.keys(state.guideSeen).length
    && Object.keys(seen).every(id => state.guideSeen[id])
  if (sameSeen && readingMode === state.readingMode) return
  state = { ...state, guideSeen: seen, readingMode }
  emit()
}

// --- guide state ---

/** Adopt the control plane's guide config. Called by the boot snapshot and by
 *  every push; null means "no answer yet" or "the server switched it off", both
 *  of which read as no guide. */
export function setGuideConfig(config: GuideConfig | null): void {
  if (JSON.stringify(config ?? null) === JSON.stringify(state.guideConfig ?? null)) return
  state = { ...state, guideConfig: config }
  emit()
}

/** The guide id this launch would announce, if any. The control plane may name
 *  one; otherwise the running release family supplies the default, so a new
 *  minor gets a fresh id without a server change while a patch never does. */
export function currentGuideId(): string | null {
  const config = state.guideConfig
  if (!config?.enable) return null
  const named = config.data?.guideId?.trim() || null
  return named || defaultGuideId(runningFamily)
}

/** Whether the guide should be on screen right now. */
export function shouldShowGuide(): boolean {
  if (!state.guideConfig?.enable) return false
  const guideId = currentGuideId()
  if (!guideId) return false
  if (state.guideOnScreen === guideId) return true
  return !state.guideSeen[guideId]
}

/** The guide is on screen in this window. Recorded before the surface paints so
 *  a re-render during its own mount cannot re-decide against the seen map. */
export function setGuideOnScreen(guideId: string | null): void {
  if (state.guideOnScreen === guideId) return
  state = { ...state, guideOnScreen: guideId }
  emit()
}

/** Acknowledge the guide: it will not return for this id. This is the moment the
 *  seen mark is written — on dismissal or completion, never on first paint — so
 *  a launch that failed to render the surface retries on the next one instead of
 *  silently consuming the announcement. */
export function dismissGuide(): void {
  const guideId = state.guideOnScreen ?? currentGuideId()
  state = { ...state, guideOnScreen: null }
  if (!guideId || state.guideSeen[guideId]) { emit(); return }
  const seen = withGuideSeen(state.guideSeen, guideId)
  state = { ...state, guideSeen: seen }
  emit()
  enqueueWrite(() => kvSet(GUIDE_SEEN_KEY, JSON.stringify(seen)))
}

/** Finish the guide with a reading-density choice: acknowledge it and persist
 *  the choice in one pass. */
export function finishGuide(readingMode: ReadingMode): void {
  const guideId = state.guideOnScreen ?? currentGuideId()
  const seen = guideId && !state.guideSeen[guideId] ? withGuideSeen(state.guideSeen, guideId) : state.guideSeen
  state = { ...state, guideOnScreen: null, guideSeen: seen, readingMode }
  emit()
  enqueueWrite(async () => {
    await kvSet(READING_MODE_KEY, readingMode)
    if (guideId) await kvSet(GUIDE_SEEN_KEY, JSON.stringify(seen))
  })
}

export function currentReadingMode(): ReadingMode | null {
  return state.readingMode
}

/** The control plane's content override for one locale, if any. */
export function guideContentFor(locale: 'zh' | 'en') {
  return state.guideConfig?.data?.[locale] ?? null
}

export function guideInitialReadingMode(): ReadingMode | null {
  return state.guideConfig?.data?.initialReadingMode ?? null
}

export function setTourActive(active: boolean): void {
  if (state.tourActive === active) return
  state = { ...state, tourActive: active }
  emit()
}

/** Whether a feature's walkthrough may start now. A guide still owed counts as
 *  holding attention even before it renders, so a tour cannot slip in first.
 *
 *  This answers "is anything else on screen"; whether this particular arrival is
 *  eligible at all — a real transition rather than a surface that was already
 *  open — is `startsTourOnArrival`, decided by the arrival sweep that can see the
 *  previous verdict. */
export function mayStartTour(entry: FeatureEntry): boolean {
  return tourMayStart({
    ledger: state.ledger,
    featureId: entry.id,
    hasTour: Boolean(entry.tour?.length),
    guideVisible: shouldShowGuide(),
    tourActive: state.tourActive,
  })
}
