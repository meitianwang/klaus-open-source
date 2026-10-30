/**
 * Goal objectives carry owned image attachments as Markdown reference lines
 * (`![Goal image N](target)`), one per line, because the objective string is
 * what the engine persists and what grants the model its owned-read authority.
 * Those lines are wire scaffolding: every human-facing projection of the
 * objective turns them back into thumbnails and keeps the internal paths out
 * of prose, clipboard text and status rows.
 */
const GOAL_IMAGE_LINE = /^!\[Goal image \d+\]\(([^()\s]+)\)$/u
const GOAL_OWNED_SEGMENT = /[/\\]goal-objectives[/\\]/u

export interface GoalImageReference {
  name: string
  target: string
  remote: boolean
}

function remoteName(target: string): string {
  const path = target.split('?')[0] || target
  return path.split('/').pop() || 'image'
}

function referenceOf(line: string): GoalImageReference | null {
  const match = GOAL_IMAGE_LINE.exec(line.trim())
  if (!match) return null
  const target = match[1]!
  if (/^https?:\/\//i.test(target)) return { name: remoteName(target), target, remote: true }
  // Local references only qualify inside the host-owned goal directory; the
  // same syntax pointing anywhere else is ordinary user text and stays text.
  const local = target.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(target)
  if (!local || !GOAL_OWNED_SEGMENT.test(target)) return null
  return { name: target.split(/[\\/]/u).pop() || 'image', target, remote: false }
}

/** Split owned-image reference lines out of an objective's display text. */
export function extractGoalImageReferences(text: string): { displayText: string; images: GoalImageReference[] } | null {
  if (typeof text !== 'string' || !text.includes('![Goal image ')) return null
  const images: GoalImageReference[] = []
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const reference = referenceOf(line)
    if (reference) images.push(reference)
    else kept.push(line)
  }
  if (!images.length) return null
  return { displayText: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), images }
}

export function stripGoalImageReferences(text: string): string {
  return extractGoalImageReferences(text)?.displayText ?? text
}
