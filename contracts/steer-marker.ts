// Input attribution is provider-invisible and belongs to the actual admission.
// The leading text marker is read only for records written before this contract.

export const STEER_HISTORY_MARKER = '<!-- klaus-steered-message -->'
export type InputKind = 'turn' | 'steer'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function inputKind(metadata: unknown): InputKind | undefined {
  const presentation = record(record(metadata)?.inputPresentation)
  return presentation?.version === 1 && (presentation.kind === 'turn' || presentation.kind === 'steer')
    ? presentation.kind : undefined
}

/** Replace caller-supplied attribution with the actual host admission kind. */
export function withInputPresentation(metadata: unknown, kind: InputKind) {
  return { ...record(metadata), inputPresentation: { version: 1, kind } }
}

export function isSteerMarkerBlock(block: unknown): boolean {
  const row = record(block)
  return row?.type === 'text' && row.text === STEER_HISTORY_MARKER
}

/** Modern metadata always wins. Unknown versions preserve authored text too. */
export function presentUserInput<T>(content: T, metadata?: unknown): { content: T; steered: boolean } {
  const kind = inputKind(metadata)
  if (record(metadata)?.inputPresentation !== undefined) return { content, steered: kind === 'steer' }
  // A historical generated marker always preceded at least one input block.
  // An untagged authored message with this exact shape is inherently ambiguous.
  const legacy = Array.isArray(content) && content.length > 1 && isSteerMarkerBlock(content[0])
  return { content: legacy ? content.slice(1) as T : content, steered: legacy }
}

/** Compatibility reader: remove only the historical leading control block. */
export function withoutSteerMarker<T>(content: T[]): T[] {
  return presentUserInput(content).content
}
