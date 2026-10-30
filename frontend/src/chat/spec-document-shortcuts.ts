/** Find navigation must not consume approval shortcuts or keys outside its panel. */
export function specFindNavigationDirection(
  event: {
    key: string
    metaKey?: boolean
    ctrlKey?: boolean
    altKey?: boolean
    shiftKey?: boolean
    isComposing?: boolean
    keyCode?: number
    defaultPrevented?: boolean
  },
  context: { findOpen: boolean; focusInside: boolean },
): -1 | 1 | null {
  if (!context.findOpen || !context.focusInside || event.defaultPrevented || event.key !== 'Enter'
    || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.keyCode === 229) return null
  return event.shiftKey ? -1 : 1
}
