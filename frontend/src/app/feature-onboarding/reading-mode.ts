// Reading density: the one preference the guide's closing page writes.
//
// `comfortable` is the shipped layout. `efficient` widens the transcript column
// and tightens its vertical rhythm so more of a long reply fits one screen.
// The override lives here rather than in the guide because it must apply on
// every launch, including the ones where no guide runs: the choice persists in
// settings.db and is re-applied at boot before the first transcript paints.

import { READING_MODE_KEY, type ReadingMode } from '../../../../contracts/feature-onboarding'

const ATTRIBUTE = 'data-reading-mode'

/** Apply a reading mode to the document. Null means "never chose", which is
 *  comfortable: the attribute is removed rather than set to a default value, so
 *  the base rules stay the single source of the shipped layout. */
export function applyReadingMode(mode: ReadingMode | null): void {
  const root = document.documentElement
  if (mode === 'efficient') root.setAttribute(ATTRIBUTE, 'efficient')
  else root.removeAttribute(ATTRIBUTE)
}

/** The row name, re-exported so the boot path and the preference broadcast
 *  handler share one import site. */
export const READING_MODE_ROW = READING_MODE_KEY
