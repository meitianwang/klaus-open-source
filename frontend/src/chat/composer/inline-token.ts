/** A serializable inline node, independent of its current DOM element. */
export interface InlineTokenSnapshot {
  start: number
  end: number
  value: string
  data?: unknown
}
