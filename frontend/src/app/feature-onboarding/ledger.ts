// The discovery ledger: what the user has already arrived at, which release they
// last saw announced, and which walkthroughs they finished.
//
// Storage follows the pattern the sidebar already uses — settings.db is
// authoritative for the ledger and the announced baseline, localStorage only
// exists so the ledger is available on the first frame instead of after the KV
// round trip, and `app:preferences-changed` carries an acknowledgement to the
// other windows.
//
// Two lifetimes share one row, separated by the `tour:` prefix
// (contracts/feature-onboarding.ts): a feature id is recorded on arrival, while
// a walkthrough replays only if its own marker is absent, so arriving twice never
// starts a tour twice.
//
// Both rows are in FEATURE_ONBOARDING_UI_STATE_KEYS, which the host exempts from
// marking a session stale. Without that exemption, acknowledging onboarding state
// would force `session/close` + rebuild on the user's next message.

import {
  FEATURE_BASELINE_KEY,
  FEATURE_ONBOARDING_MIRROR_KEY,
  FEATURE_SEEN_LEDGER_KEY,
  decideOnboarding,
  parseMirror,
  parseSeenLedger,
  releaseFamily,
  serializeMirror,
  tourDoneId,
  tourMayStart,
  unionLedger,
  withFeatureSeen,
} from '../../../../contracts/feature-onboarding'
import { FEATURE_REGISTRY, featureById, type FeatureEntry } from './registry'

const w = () => window as any

interface OnboardingState {
  /** Acknowledged ids: arrived features plus `tour:` completion markers. */
  ledger: string[]
  /** Release features inside the current announcement window. Survives the card
   *  being dismissed, because dismissing the card is not the same as reading
   *  every entry on it. */
  announced: string[]
  /** Family already announced. Written when the card is dismissed, not when the
   *  decision is made, so a launch that fails to render the card retries. */
  baseline: string | null
  /** Family awaiting dismissal; the card shows once per launch. */
  pendingBaseline: string | null
  cardVisible: boolean
  cardDismissed: boolean
  tourActive: boolean
}

let state: OnboardingState = {
  ledger: [],
  announced: [],
  baseline: null,
  pendingBaseline: null,
  cardVisible: false,
  cardDismissed: false,
  tourActive: false,
}

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
 *  ledger only: the announcement window comes from the baseline row, which lives
 *  in settings.db, and guessing it here would announce a release the user has
 *  already seen until the KV read landed. `hydrateOnboarding` reconciles the
 *  ledger against the authoritative row. */
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
 *  like a first install, and a first install is the branch that announces — so
 *  one failed read would replay the upgrade card the user had already dismissed.
 *  `absent` is the only answer that may drive an announcement. */
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

/** Adopt a ledger into state, dropping any announcement it satisfies.
 *
 *  Shared by the cross-window broadcast and by the merge-on-write path below, so
 *  both agree on what adopting someone else's ledger means. Returns whether
 *  anything actually changed, because an unchanged adoption must not emit. */
function adoptLedger(ledger: readonly string[]): boolean {
  const current = state.ledger
  if (ledger.length === current.length && ledger.every(id => current.includes(id))) return false
  state = { ...state, ledger: [...ledger], announced: state.announced.filter(id => !ledger.includes(id)) }
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

export async function hydrateOnboarding(currentVersion: string | null): Promise<void> {
  hydrateFromMirror()
  const [ledgerRead, baselineRead] = await Promise.all([
    kvRead(FEATURE_SEEN_LEDGER_KEY),
    kvRead(FEATURE_BASELINE_KEY),
  ])
  // A failed baseline read cannot be decided, so this launch announces nothing
  // and writes nothing. The row still holds the old family, which makes the next
  // launch announce normally — self-healing, where guessing "absent" would replay
  // a card the user already dismissed. The mirror-derived ledger still loads.
  if (baselineRead.status === 'failed') {
    if (ledgerRead.status === 'value') state = { ...state, ledger: parseSeenLedger(ledgerRead.value) }
    writeMirror()
    emit()
    return
  }
  // The KV row wins whenever it exists; an absent ledger row keeps the mirror's
  // guess so the first paint still has something to show.
  const ledger = ledgerRead.status === 'value' ? parseSeenLedger(ledgerRead.value) : state.ledger
  // An absent baseline row genuinely means "never announced", which is the input
  // that decides a first-install announcement. Falling back to the in-memory
  // value here would make a cleared row read as the previous family and swallow
  // the announcement.
  const baseline = baselineRead.status === 'value' ? (baselineRead.value.trim() || null) : null
  const decision = decideOnboarding({
    baseline,
    currentFamily: releaseFamily(currentVersion),
    registry: FEATURE_REGISTRY.map(entry => ({ id: entry.id, kind: entry.kind, since: entry.since })),
  })
  state = {
    ...state,
    ledger,
    // The window derives from the baseline, so it comes from the decision alone:
    // a stale mirror must not resurrect a previous release's announcement.
    announced: decision.kind === 'announce' ? decision.features : [],
    baseline,
    pendingBaseline: decision.kind === 'announce' ? decision.baseline : null,
  }
  writeMirror()
  emit()
}

/** Acknowledge a feature: it leaves the card's list. */
export function markFeatureSeen(id: string): void {
  if (!id) return
  appendLedger(id)
  if (state.announced.includes(id)) {
    state = { ...state, announced: state.announced.filter(entry => entry !== id) }
    writeMirror()
    emit()
  }
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

export function setCardVisible(visible: boolean): void {
  if (state.cardVisible === visible) return
  state = { ...state, cardVisible: visible }
  emit()
}

/** Dismiss the upgrade card. This is the moment the baseline advances: writing
 *  it earlier would let a launch that failed to render the card silently consume
 *  the announcement. */
export function dismissCard(): void {
  const { pendingBaseline } = state
  state = { ...state, cardVisible: false, cardDismissed: true, pendingBaseline: null }
  if (pendingBaseline) enqueueWrite(() => kvSet(FEATURE_BASELINE_KEY, pendingBaseline))
  emit()
}

export function setTourActive(active: boolean): void {
  if (state.tourActive === active) return
  state = { ...state, tourActive: active }
  emit()
}

/** Whether a feature's walkthrough may start now. A card still owed counts as
 *  holding attention even before it renders, so a tour cannot slip in first.
 *
 *  This answers "is anything else on screen"; whether this particular arrival is
 *  eligible at all — a real transition rather than a surface that was already
 *  open — is `startsTourOnArrival`, decided by the arrival sweep that can see the
 *  previous verdict. */
export function mayStartTour(entry: FeatureEntry): boolean {
  const cardPending = state.pendingBaseline !== null && !state.cardDismissed
  return tourMayStart({
    ledger: state.ledger,
    featureId: entry.id,
    hasTour: Boolean(entry.tour?.length),
    cardVisible: state.cardVisible || cardPending,
    tourActive: state.tourActive,
  })
}

// --- derived views ---

/** Release features still unacknowledged, for the card's list. */
export function cardFeatures(): FeatureEntry[] {
  return state.announced
    .map(id => featureById(id))
    .filter((entry): entry is FeatureEntry => Boolean(entry))
}

/** Whether the upgrade card should be on screen. */
export function shouldShowCard(): boolean {
  return cardOwed() && state.announced.length > 0
}

/** Whether an announcement is still owed this launch, rendered or not. */
function cardOwed(): boolean {
  return !state.cardDismissed && state.pendingBaseline !== null
}
