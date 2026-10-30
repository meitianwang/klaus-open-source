// One React root per overlay surface, mounted on document.body.
//
// Portalling to body is not a stylistic choice: section children in this app get
// `position: relative` from the environment-page layer rules, which out-specifies
// a `position: fixed` child and clips the overlay into the content flow (the same
// reason ModalPortal exists). These surfaces are mounted imperatively rather than
// rendered from the app tree because their lifetime is driven by the ledger, not
// by a parent component's props.

import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

interface OverlaySlot {
  host: HTMLElement
  root: Root
}

const slots = new Map<string, OverlaySlot>()

/** Mount (or replace) one overlay by id. Re-mounting the same id tears the
 *  previous root down first, so a rapid state change cannot leave two roots
 *  committing into one host.
 *
 *  Props travel through a closure rather than as `createElement` arguments:
 *  `ComponentType<P>` is a union of a function component and a class component,
 *  and their prop signatures are not assignable to one another, so passing `P`
 *  through the factory does not type-check for any `P`. Building the element at
 *  the call site keeps each component's own prop type intact. */
export function mountOverlay(id: string, element: ReactElement): void {
  unmountOverlay(id)
  const host = document.createElement('div')
  host.id = `klaus-feature-onboarding-${id}`
  // display:contents keeps the host out of layout entirely; the overlay's own
  // fixed positioning places it.
  host.style.display = 'contents'
  document.body.appendChild(host)
  const root = createRoot(host)
  slots.set(id, { host, root })
  root.render(element)
}

export function unmountOverlay(id: string): void {
  const slot = slots.get(id)
  if (!slot) return
  slots.delete(id)
  slot.root.unmount()
  slot.host.remove()
}

/** Tear down every overlay this module mounted.
 *
 *  The shipped path unmounts by slot id, because each surface owns its id and
 *  only ever replaces itself. Sweeping all of them exists for the DOM harness,
 *  which resets between measurement phases (card, then tour) and must
 *  not carry the previous phase's overlay into the next. */
export function unmountAllOverlays(): void {
  for (const id of [...slots.keys()]) unmountOverlay(id)
}

/** Full-screen surfaces that already own the user's attention.
 *
 *  The external-session import flow shows its own first-run overlay, and it is
 *  the one modal that reliably competes with the upgrade card: both appear on a
 *  fresh launch, both want to be the only thing on screen. Discovery surfaces
 *  wait for these to go away rather than stacking over them, because a card
 *  underneath an opaque overlay is not a card the user can dismiss — it just
 *  consumes the announcement. */
const BLOCKING_OVERLAY_IDS = [
  'external-import-onboarding',
  'external-import-project-dialog-host',
] as const

export function blockingOverlayPresent(): boolean {
  return BLOCKING_OVERLAY_IDS.some(id => document.getElementById(id) !== null)
}
