/** Routing defaults never represent a concrete Cursor model. */
export function isAutomaticCursorSelection(value: string): boolean {
  if (!value.toLowerCase().startsWith('cursor:')) return false
  const model = value.slice('cursor:'.length).split('[', 1)[0].trim().toLowerCase().replace(/@max$/, '')
  return ['auto', 'auto-smart', 'default'].includes(model)
}
