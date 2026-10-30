// Evaluating an arrival rule against the live DOM, and deriving exactly which
// elements the arrival observer must watch to evaluate every rule.
//
// The rules themselves are declared as data in the registry and typed in
// contracts/feature-onboarding.ts, which is what makes this possible: an opaque
// predicate would force the observer to watch the whole document for any class
// change, waking on every transcript re-render while a reply streams. Declaring
// the subject lets each rule subscribe to its own element and its own
// attributes, so streaming, session-list re-renders and unrelated panels cost
// nothing here.
//
// This module is the only place in the feature that reads the DOM to answer
// "has the user got there". Detection (arrivals.ts) and the rules (ledger.ts)
// stay separate, so a paint can never be the thing that decides arrival.

import {
  SETTINGS_PANEL_SELECTOR,
  arrivalSubjects,
  unionArrivalSubjects,
  type ArrivalRule,
} from '../../../../contracts/feature-onboarding'
import type { FeatureEntry } from './registry'

/** Whether a rule is satisfied right now. Every branch reads only attributes,
 *  never layout, so evaluating the whole registry is cheap enough to run inside
 *  a frame callback. */
function evaluateArrival(rule: ArrivalRule): boolean {
  switch (rule.kind) {
    case 'view-active':
      return document.getElementById(rule.viewId)?.classList.contains('active') === true
    case 'settings-tab': {
      // Both halves matter: the overlay can stay in the DOM after it closes, and
      // the panel keeps the tab it last showed, so either alone reads stale.
      if (document.getElementById('settings-view')?.classList.contains('active') !== true) return false
      return document.querySelector(SETTINGS_PANEL_SELECTOR)?.getAttribute('data-stab') === rule.stab
    }
    case 'panel-mode': {
      const panel = document.getElementById(rule.panelId)
      if (!panel || panel.classList.contains('collapsed')) return false
      return panel.getAttribute('data-mode') === rule.mode
    }
    case 'aria-pressed':
      return document.getElementById(rule.id)?.getAttribute('aria-pressed') === 'true'
    case 'never':
      return false
  }
}

/** Whether an entry's hint is satisfied. A missing or throwing rule reads as
 *  unarrived, so a registry typo cannot stall arrival detection. */
export function arrived(entry: Pick<FeatureEntry, 'arrival'> | null | undefined): boolean {
  if (!entry) return false
  try { return evaluateArrival(entry.arrival) } catch { return false }
}

/** The elements one rule reads, resolved now. */
function resolveSubjects(rule: ArrivalRule): Array<{ element: Element; attributes: string[] }> {
  const subject = arrivalSubjects(rule)
  const resolved: Array<{ element: Element; attributes: string[] }> = []
  for (const id of subject.ids) {
    const element = document.getElementById(id)
    if (element) resolved.push({ element, attributes: subject.attributes })
  }
  for (const selector of subject.selectors) {
    for (const element of document.querySelectorAll(selector)) {
      resolved.push({ element, attributes: subject.attributes })
    }
  }
  return resolved
}

/** The complete subscription set: every element a rule reads, each watched for
 *  the union of the attributes the registry declares.
 *
 *  The ELEMENT set is what matters. Nothing outside it can change an arrival
 *  verdict, so the observer never watches the document as a whole — that is what
 *  keeps a streaming reply from waking it. Sharing one attribute list across
 *  those few elements costs nothing: an element watched for an attribute it does
 *  not carry simply never fires. */
export function arrivalSubjectsToWatch(rules: readonly ArrivalRule[]): Array<{ element: Element; attributes: string[] }> {
  const { attributes } = unionArrivalSubjects(rules)
  const elements = new Set<Element>()
  for (const rule of rules) {
    for (const { element } of resolveSubjects(rule)) elements.add(element)
  }
  return [...elements].map(element => ({ element, attributes }))
}

/** Subject ids and selectors the registry declares, whether or not they resolve
 *  right now. Every one of them must exist in the static shell markup: if a rule
 *  named an element some React island builds later, the observer would subscribe
 *  to nothing and that hint would never clear. */
export function declaredSubjects(rules: readonly ArrivalRule[]): { ids: string[]; selectors: string[] } {
  const union = unionArrivalSubjects(rules)
  return { ids: union.ids, selectors: union.selectors }
}
