// Feature discovery bootstrap.
//
// Two surfaces, one ledger, and one rule about who may hold the user's
// attention at a time:
//
//   1. the post-upgrade guide: a full-screen page sequence introducing the
//      release, shown once per guide id while the control plane enables it;
//   2. a spotlight walkthrough for the few surfaces that are hard to find from
//      their entry point alone, started by that same arrival.
//
// The guide outranks the walkthrough, because a walkthrough started underneath
// an open guide would cover the thing the user is reading.
//
// Nothing here is on the critical path: hydration runs after the shell has
// restored its window state, and every failure degrades to "show no hint". A
// discovery system that can block boot or throw during first paint is worse
// than no discovery system.

import { createElement } from 'react'
import {
  FEATURE_SEEN_LEDGER_KEY,
  GUIDE_SEEN_KEY,
  READING_MODE_KEY,
  type GuideConfig,
} from '../../../../contracts/feature-onboarding'
import {
  applyRemoteGuideState,
  applyRemoteLedger,
  currentGuideId,
  currentReadingMode,
  dismissGuide,
  finishGuide,
  hydrateFromMirror,
  hydrateOnboarding,
  setGuideConfig,
  setGuideOnScreen,
  setRunningVersion,
  shouldShowGuide,
  subscribeOnboarding,
} from './ledger'
import { startArrivalObserver } from './arrivals'
import { blockingOverlayPresent, mountOverlay, unmountOverlay } from './overlay'
import { applyReadingMode, PostUpgradeGuide } from './guide'

/** Overlay slot id for the guide. */
const GUIDE_OVERLAY_ID = 'guide'

const w = () => window as any

let bootstrapped = false

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
const GUIDE_RETRY_LIMIT = 40
let guideRetries = 0
let guideRetryTimer: number | null = null

/** Paint or unpaint the guide to match the ledger and the control plane. */
function syncGuide(): void {
  if (guideRetryTimer !== null) { clearTimeout(guideRetryTimer); guideRetryTimer = null }
  if (!shouldShowGuide()) {
    unmountOverlay(GUIDE_OVERLAY_ID)
    setGuideOnScreen(null)
    return
  }
  // Another full-screen surface is up. Waiting is not a cosmetic choice: the
  // seen mark is written when the guide is dismissed, so showing it underneath
  // an opaque overlay would spend the announcement on something the user
  // cannot read or close. The retry gives up after a bounded number of polls;
  // the guide then waits for the next launch rather than interrupting.
  if (blockingOverlayPresent()) {
    if (guideRetries++ >= GUIDE_RETRY_LIMIT) return
    guideRetryTimer = window.setTimeout(syncGuide, 500)
    return
  }
  guideRetries = 0
  // Record the id before the surface paints: a re-render during its own mount
  // must not re-decide against a seen map that only gains the id on dismissal.
  setGuideOnScreen(currentGuideId())
  const close = () => {
    unmountOverlay(GUIDE_OVERLAY_ID)
    setGuideOnScreen(null)
    syncGuide()
  }
  mountOverlay(GUIDE_OVERLAY_ID, createElement(PostUpgradeGuide, {
    // The ledger owns the acknowledgement: dismissal or completion is the
    // moment the seen mark is written, never the first paint.
    onDismiss: () => { dismissGuide(); close() },
    onFinish: mode => {
      finishGuide(mode)
      applyReadingMode(mode)
      close()
    },
  }))
}

/** Re-render the guide surface. The guide is re-mounted rather than patched
 *  because its content changes only on a config or ledger write, which is rare. */
function sync(): void {
  syncGuide()
}

/** Start the discovery surfaces. Idempotent: a second call is a no-op, so a
 *  renderer reload path that re-runs boot cannot double-mount. */
export async function bootFeatureOnboarding(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true

  hydrateFromMirror()

  const version = await readAppVersion()
  setRunningVersion(version || null)
  try {
    await hydrateOnboarding()
  } catch {
    // A failed KV read leaves the mirror-derived state in place, which is the
    // same as "show what we last knew".
  }

  // The reading density persists across launches, so apply it before the first
  // transcript paints rather than waiting for the guide to run.
  applyReadingMode(currentReadingMode())

  // One subscription drives the guide: `sync` re-mounts it on every ledger or
  // config change. Neither this nor the preference handler below is ever
  // removed: they live as long as the page, which is how every other page-level
  // listener in the shell behaves, and a renderer reload re-evaluates this
  // module (resetting `bootstrapped`) rather than needing a teardown call.
  subscribeOnboarding(sync)
  // Arrival detection starts only now: it snapshots what is already on screen
  // so a restored panel does not read as an arrival, and that snapshot is only
  // meaningful once the shell has finished restoring.
  startArrivalObserver()

  // Another window acknowledged a hint, dismissed the guide or chose a reading
  // density. The broadcast carries the KV row name and nothing else, so the
  // handler re-reads the authoritative row instead of trusting a payload.
  w().klaus?.on?.appPreferencesChanged?.(
    ({ key }: { key?: string }) => {
      if (key === FEATURE_SEEN_LEDGER_KEY) {
        void applyRemoteLedger().then(sync)
        return
      }
      if (key === GUIDE_SEEN_KEY || key === READING_MODE_KEY) {
        void applyRemoteGuideState().then(() => {
          applyReadingMode(currentReadingMode())
          sync()
        })
      }
    },
  )

  // The control plane owns whether a guide exists at all. The snapshot covers a
  // config that landed before this window booted; the push covers later
  // changes, including the server switching the guide off mid-session.
  const guide = w().klaus?.onboardingGuide
  if (guide?.snapshot) {
    void Promise.resolve(guide.snapshot())
      .then((config: GuideConfig | null) => { setGuideConfig(config); sync() })
      .catch(() => { /* fail-closed: no answer means no guide */ })
  }
  guide?.onUpdated?.((config: GuideConfig | null) => { setGuideConfig(config); sync() })

  sync()

  // The guide and the walkthrough are React islands that resolve their own
  // labels through t(); a language switch does not re-run them, so remount.
  window.addEventListener('klaus:lang-change', sync)
}
