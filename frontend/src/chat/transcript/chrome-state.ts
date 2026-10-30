export type TranscriptChromeState = 'welcome' | 'loading' | 'transcript'

export interface TranscriptChromeInput {
  sessionId: string | null | undefined
  draftOnly: boolean
  running: boolean
  liveUnitCount: number
  history: readonly unknown[] | null | undefined
}

export type TranscriptContentPresence = 'present' | 'empty' | 'unknown'

export function transcriptContentPresence(
  input: Pick<TranscriptChromeInput, 'running' | 'liveUnitCount' | 'history'>,
): TranscriptContentPresence {
  if (input.running || input.liveUnitCount > 0) return 'present'
  if (input.history == null) return 'unknown'
  return input.history.length > 0 ? 'present' : 'empty'
}

/**
 * Decide which conversation surface should be visible while a session changes.
 *
 * An existing session with unloaded history is not an empty new chat. Keeping
 * that distinction explicit prevents a placeholder title from flashing the
 * welcome screen while the authoritative transcript is still on its way.
 */
export function transcriptChromeState(input: TranscriptChromeInput): TranscriptChromeState {
  if (!input.sessionId || input.draftOnly) return 'welcome'
  const presence = transcriptContentPresence(input)
  if (presence === 'present') return 'transcript'
  if (presence === 'unknown') return 'loading'
  // A real conversation with no turns yet is still a conversation surface: an
  // empty transcript with its composer, never the new-chat welcome screen.
  return 'transcript'
}
