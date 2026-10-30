// Arrival detection: noticing when the user reaches a hinted feature, and
// starting that feature's walkthrough when it has one.
//
// Arrival is derived from the DOM rather than recorded from clicks. Navigation
// reaches these surfaces through the sidebar, the command menu, keybindings,
// deep links and agent-driven routing alike; the only thing all of them share is
// the class or attribute they leave behind.
//
// Two properties make this cheap enough to leave running for the page's lifetime:
//
//   - The observer subscribes to the handful of ELEMENTS the registry's rules
//     name, not to the document. Watching `document.body` for class changes
//     would wake on every transcript re-render while a reply streams, which is
//     the single most frequent DOM write in this app. The registry test pins that
//     every declared subject is static markup, so the subscription set cannot
//     silently miss an element built later by a React island.

import { createElement } from 'react'
import { FEATURE_REGISTRY, type FeatureEntry } from './registry'
import { arrived, arrivalSubjectsToWatch } from './arrival'
import { markFeatureSeen, markTourDone, mayStartTour, setTourActive } from './ledger'
import { startsTourOnArrival } from '../../../../contracts/feature-onboarding'
import { FeatureTour } from './tour'
import { mountOverlay, unmountOverlay } from './overlay'

/** Overlay slot id for the walkthrough. */
const TOUR_OVERLAY_ID = 'tour'

let observer: MutationObserver | null = null
let pending = 0
let runningTour: FeatureEntry | null = null

/** Last verdict per entry, so an arrival is recognizable as a TRANSITION.
 *  Without it, sitting on a page the user already reached would keep re-firing
 *  whatever arrival triggers. */
const previousArrival = new Map<string, boolean>()
let initialSweep = true

/** Evaluate every rule once. Records arrivals, and starts a walkthrough only on
 *  a false→true transition outside the first sweep. */
function sweepArrivals(): void {
  for (const entry of FEATURE_REGISTRY) {
    const now = arrived(entry)
    const previous = previousArrival.get(entry.id)
    previousArrival.set(entry.id, now)
    if (!now) continue
    markFeatureSeen(entry.id)
    if (startsTourOnArrival({ previous, now, initialSweep })) maybeStartTour(entry)
  }
  initialSweep = false
}

/** Start an entry's walkthrough. `mayStartTour` carries the remaining gates:
 *  never while the upgrade card is up or owed, never twice, never over a tour
 *  that is already running. */
function maybeStartTour(entry: FeatureEntry): void {
  if (runningTour || !mayStartTour(entry)) return
  runningTour = entry
  setTourActive(true)
  mountOverlay(TOUR_OVERLAY_ID, createElement(FeatureTour, {
    entry,
    onFinish: () => {
      markTourDone(entry.id)
      setTourActive(false)
      runningTour = null
      unmountOverlay(TOUR_OVERLAY_ID)
    },
  }))
}

function scheduleSweep(): void {
  if (pending) return
  pending = requestAnimationFrame(() => {
    pending = 0
    sweepArrivals()
  })
}

/** Record what is already on screen, then start watching. Must be called after
 *  the shell has restored its window state: the first sweep writes arrivals
 *  without starting any walkthrough, so a restored Files panel is acknowledged
 *  rather than greeted with a modal over the user's first frame. */
export function startArrivalObserver(): void {
  if (observer) return
  observer = new MutationObserver(scheduleSweep)
  // Subscribe before the first sweep so an arrival happening during it is not
  // missed, then sweep to establish the baseline verdicts.
  for (const { element, attributes } of arrivalSubjectsToWatch(
    FEATURE_REGISTRY.map(entry => entry.arrival),
  )) {
    observer.observe(element, { attributes: true, attributeFilter: attributes })
  }
  sweepArrivals()
  // Never disconnected: the observer is page-lifetime, matching the shell's other
  // page-level observers. A renderer reload replaces the whole document.
}
