import { intlLocale } from '../i18n'
import type { AgentTask } from './engine-events'

/** Task descriptions are model-authored titles, not roles, peer addresses or avatar names. */
export function subagentDisplayName(
  _taskId: string,
  task: AgentTask | null | undefined,
  locale = intlLocale(),
): string {
  const title = typeof task?.description === 'string' ? task.description.replace(/\s+/g, ' ').trim() : ''
  return title || (locale.toLowerCase().startsWith('zh') ? '子智能体' : 'Agent')
}

/** Inline rows show a bounded preview of the name; the full text stays on the
 *  row's accessible name and in the child's own transcript. A description can be
 *  a whole delegated prompt, and an inline activity row that reprints it pushes
 *  every other row of the turn off the screen. */
export const SUBAGENT_NAME_PREVIEW_GRAPHEMES = 160

export function subagentNamePreview(name: string, limit = SUBAGENT_NAME_PREVIEW_GRAPHEMES): string {
  const flat = name.replace(/\s+/g, ' ').trim()
  const graphemes = typeof Intl !== 'undefined' && typeof (Intl as any).Segmenter === 'function'
    ? [...new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' }).segment(flat)].map((part: any) => part.segment)
    : [...flat]
  if (graphemes.length <= limit) return flat
  return `${graphemes.slice(0, limit).join('')}…`
}
