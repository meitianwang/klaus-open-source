// Feature discovery bootstrap.
//
// Two surfaces, one ledger, and one rule about who may hold the user's
// attention at a time:
//
//   1. the upgrade card, shown once per release family;
//   2. a spotlight walkthrough for the few surfaces that are hard to find from
//      their entry point alone, started by that same arrival.
//
// The card outranks the walkthrough, because a walkthrough started underneath an
// open card would cover the thing the user is reading.
//
// Nothing here is on the critical path: hydration runs after the shell has
// restored its window state, and every failure degrades to "show no hint". A
// discovery system that can block boot or throw during first paint is worse than
// no discovery system.

import { createElement } from 'react'
import {
  FEATURE_BASELINE_KEY,
  FEATURE_SEEN_LEDGER_KEY,
} from '../../../../contracts/feature-onboarding'
import {
  applyRemoteLedger,
  cardFeatures,
  dismissCard,
  hydrateFromMirror,
  hydrateOnboarding,
  setCardVisible,
  shouldShowCard,
  subscribeOnboarding,
} from './ledger'
import { startArrivalObserver } from './arrivals'
import { blockingOverlayPresent, mountOverlay, unmountOverlay } from './overlay'
import { FeatureAnnouncementCard } from './card'

/** Overlay slot id for the upgrade card. */
const CARD_OVERLAY_ID = 'card'

const w = () => window as any

let bootstrapped = false
let version = ''

/** Read the running version. `updater:status` already carries it and the About
 *  tab reads the same field, so this adds no second version source. */
async function readAppVersion(): Promise<string> {
  try {
    const status = await w().klaus?.updater?.status?.()
    return typeof status?.currentVersion === 'string' ? status.currentVersion : ''
  } catch {
    return ''
  }
}

/** Retries while another full-screen surface owns the screen. Bounded, because
 *  an overlay the user never closes must not keep a timer alive forever. */
const CARD_RETRY_LIMIT = 40
let cardRetries = 0
let cardRetryTimer: number | null = null

/** Paint or unpaint the card to match the ledger. */
function syncCard(): void {
  if (cardRetryTimer !== null) { clearTimeout(cardRetryTimer); cardRetryTimer = null }
  if (!shouldShowCard()) {
    unmountOverlay(CARD_OVERLAY_ID)
    setCardVisible(false)
    return
  }
  const features = cardFeatures()
  if (!features.length) {
    unmountOverlay(CARD_OVERLAY_ID)
    setCardVisible(false)
    return
  }
  // Another full-screen surface is up. Waiting is not a cosmetic choice: the
  // baseline advances when the card is dismissed, so showing it underneath an
  // opaque overlay would spend the announcement on something the user cannot
  // read or close. The retry gives up after a bounded number of polls; the card
  // then waits for the next launch rather than interrupting.
  if (blockingOverlayPresent()) {
    if (cardRetries++ >= CARD_RETRY_LIMIT) return
    cardRetryTimer = window.setTimeout(syncCard, 500)
    return
  }
  cardRetries = 0
  mountOverlay(CARD_OVERLAY_ID, createElement(FeatureAnnouncementCard, {
    features,
    version,
    onDismiss: () => {
      dismissCard()
      unmountOverlay(CARD_OVERLAY_ID)
      setCardVisible(false)
    },
  }))
  setCardVisible(true)
}

/** Re-render the card surface. The card is re-mounted rather than patched because
 *  its content changes only on a ledger write, which is rare. */
function sync(): void {
  syncCard()
}

/** Start the discovery surfaces. Idempotent: a second call is a no-op, so a
 *  renderer reload path that re-runs boot cannot double-mount. */
export async function bootFeatureOnboarding(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true

  hydrateFromMirror()

  version = await readAppVersion()
  try {
    await hydrateOnboarding(version || null)
  } catch {
    // A failed KV read leaves the mirror-derived state in place, which is the
    // same as "show what we last knew".
  }

  // One subscription drives the card: `sync` re-mounts it on every ledger
  // change. Neither this nor the preference handler below is ever removed: they
  // live as long as the page, which is how every other page-level listener in
  // the shell behaves, and a renderer reload re-evaluates this module (resetting
  // `bootstrapped`) rather than needing a teardown call.
  subscribeOnboarding(sync)
  // Arrival detection starts only now: it snapshots what is already on screen so
  // a restored panel does not read as an arrival, and that snapshot is only
  // meaningful once the shell has finished restoring.
  startArrivalObserver()

  // Another window acknowledged a hint or advanced its baseline. The broadcast
  // carries the KV row name and nothing else, so the handler re-reads the
  // authoritative row instead of trusting a payload.
  w().klaus?.on?.appPreferencesChanged?.(
    ({ key }: { key?: string }) => {
      if (key !== FEATURE_SEEN_LEDGER_KEY && key !== FEATURE_BASELINE_KEY) return
      void applyRemoteLedger().then(sync)
    },
  )

  sync()

  // The card and the walkthrough are React islands that resolve their own labels
  // through t(); a language switch does not re-run them, so remount.
  window.addEventListener('klaus:lang-change', sync)
}
