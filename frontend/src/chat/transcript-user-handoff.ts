interface TranscriptOrderRow {
  uuid?: string
  turnId?: string
  timestamp?: unknown
  isFinalReply?: boolean
  phase?: string
  contentBlocks?: Array<{ phase?: string; messageId?: string }>
  steered?: boolean
  questionAnswer?: unknown
}

interface UserRow extends TranscriptOrderRow {
  role?: string
  text?: unknown
  localRender?: unknown
  userRenderSnapshot?: boolean
  [key: string]: any
}

function messageTime(value: unknown): number | null {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) && time > 0 ? time : null
}

/**
 * Send-time to turn-start attribution tolerance. The optimistic bubble is
 * created a moment before the engine stamps the turn it opened, so a turn that
 * started slightly BEFORE the recorded send time can still be that send's turn.
 */
const TURN_ATTRIBUTION_SLACK_MS = 2000

function finalRow(row: TranscriptOrderRow): boolean {
  return row.isFinalReply === true || row.phase === 'final_answer' || !!row.contentBlocks?.some(block => block.phase === 'final_answer')
}

/** Insert only the missing message; saved rows retain their authoritative order. */
function submittedUserInsertionIndex(rows: TranscriptOrderRow[], source: TranscriptOrderRow, sequence: TranscriptOrderRow[] = []): number {
  if (!source.turnId) return rows.length
  const sameTurn = rows.flatMap((row, index) => row.turnId === source.turnId ? [index] : [])
  if (!sameTurn.length) return rows.length
  const at = sequence.indexOf(source) >= 0 ? sequence.indexOf(source)
    : source.uuid ? sequence.findIndex(row => row.uuid === source.uuid) : -1
  const locate = (row: TranscriptOrderRow) => row.uuid ? rows.findIndex(saved => saved.turnId === source.turnId
    && (saved.uuid === row.uuid || saved.contentBlocks?.some(block => block.messageId === row.uuid))) : -1
  let preceding = -1, following = -1
  if (at >= 0) {
    for (let index = at - 1; index >= 0 && sequence[index].turnId === source.turnId; index--) {
      preceding = locate(sequence[index])
      if (preceding >= 0) break
    }
    for (let index = at + 1; index < sequence.length && sequence[index].turnId === source.turnId; index++) {
      following = locate(sequence[index])
      if (following >= 0) break
    }
  }
  // Adjacent identities survive missing timestamps, summary pages and refreshes.
  if (following >= 0 && (preceding < 0 || preceding < following)) return following
  const segments = sameTurn.filter((index, offset) => offset === 0 || index !== sameTurn[offset - 1] + 1)
    .map(start => { let end = start + 1; while (rows[end]?.turnId === source.turnId) end++; return { start, end } })
  const time = messageTime(source.timestamp)
  const segment = preceding >= 0 ? segments.find(value => preceding >= value.start && preceding < value.end)
    : segments.length === 1 ? segments[0] : time != null ? segments.find(value => rows.slice(value.start, value.end)
      .some(row => { const stamp = messageTime(row.timestamp); return stamp != null && stamp >= time })) : undefined
  if (!segment) return rows.length
  const lower = preceding >= 0 ? preceding + 1 : segment.start
  if (time != null) {
    for (let index = lower; index < segment.end; index++) {
      const stamp = messageTime(rows[index].timestamp)
      if (stamp != null && stamp > time) return index
    }
    if (rows.slice(lower, segment.end).some(row => finalRow(row) && messageTime(row.timestamp) != null)) return segment.end
  }
  // Optional answers belong to their asking turn. Without a timestamp, only a
  // unique segment or an observed neighboring identity may locate that answer.
  if (source.questionAnswer) {
    const final = rows.findIndex((row, index) => index >= lower && index < segment.end && finalRow(row))
    if (final >= 0) return final
  }
  return segment.end
}

type LiveRow = { type: string; key: string; turnId?: string; msg?: UserRow; messageId?: string; startedAtMs?: number; phase?: string; turnTail?: unknown }

/** The live sequence supplies message anchors even when only users are retained. */
function liveTranscriptOrderRows(units: LiveRow[]): UserRow[] {
  return units.map(unit => unit.type === 'live-user' && unit.msg
    ? { ...unit.msg, turnId: unit.msg.turnId || unit.turnId }
    : { uuid: unit.messageId || unit.key, turnId: unit.turnId, timestamp: unit.startedAtMs,
      phase: unit.phase, isFinalReply: !!unit.turnTail || unit.phase === 'final_answer' })
}

/** Keep a submitted row until saved history actually supplies its replacement. */
export function mergeSubmittedUserHistory(history: UserRow[], liveUnits: LiveRow[], previous: UserRow[], turnStarts: Record<string, number> = {}): UserRow[] {
  // Saved rows can still rely on a local display envelope during rollout lag.
  // Carry that envelope by message identity without retaining removed saved rows.
  const previousDisplay = new Map(previous.filter(row => row.role === 'user' && row.uuid && row.localRender)
    .map(row => [row.uuid, row]))
  const rows = history.map(saved => {
    const source = saved.role === 'user' && saved.uuid ? previousDisplay.get(saved.uuid) : undefined
    return !saved.localRender && source?.localRender && source.text === saved.text
      ? { ...saved, localRender: source.localRender } : saved
  })
  const liveRows = liveTranscriptOrderRows(liveUnits)
  const snapshots = [...previous.filter(row => row.userRenderSnapshot), ...liveRows.flatMap((row, index) =>
    liveUnits[index].type === 'live-user' ? [{ ...row, userRenderSnapshot: true }] : [])]
  const matchedLegacy = new Set<UserRow>()
  for (const source of snapshots) {
    let index = source.uuid ? rows.findIndex(row => row.role === 'user' && row.uuid === source.uuid) : -1
    if (index < 0 && source.turnId && !source.steered && !source.questionAnswer) {
      index = rows.findIndex(row => row.role === 'user' && row.turnId === source.turnId && !row.steered && !row.questionAnswer)
    }
    // Older saved rows have no protocol identity; accept only a unique opener match.
    if (index < 0 && !source.steered && !source.questionAnswer && typeof source.text === 'string'
      && snapshots.filter(row => row.text === source.text).length === 1) {
      const legacy = rows.filter(row => row.role === 'user' && !row.uuid && !row.turnId && !row.userRenderSnapshot
        && !row.steered && !row.questionAnswer && row.text === source.text && !matchedLegacy.has(row))
      if (legacy.length === 1) {
        matchedLegacy.add(legacy[0])
        index = rows.indexOf(legacy[0])
      }
    }
    // A snapshot that never received protocol identity at all (the optimistic
    // bubble is created before the engine names the turn, and a handoff can
    // commit before that stamp lands) still describes exactly one saved row.
    // Accept a unique unclaimed text match so it can never paint a second
    // bubble beside the saved projection of the same send. A snapshot that
    // DOES carry a turn id keeps the stricter rules above: a saved history
    // without that turn is a lagging read, and its opener must stay local.
    if (index < 0 && !source.uuid && !source.turnId && !source.steered && !source.questionAnswer
      && typeof source.text === 'string' && snapshots.filter(row => row.text === source.text).length === 1) {
      const sameText = rows.filter(row => row.role === 'user' && !row.userRenderSnapshot
        && !row.steered && !row.questionAnswer && row.text === source.text && !matchedLegacy.has(row))
      if (sameText.length === 1) {
        matchedLegacy.add(sameText[0])
        index = rows.indexOf(sameText[0])
      }
    }
    // Turn-keyed attribution for a snapshot that never received protocol
    // identity at all: the turn object owns its input row from birth, and the
    // turn start clock is this store's equivalent of that ownership. Attribute
    // the send to the earliest turn that started at or after it and merge into
    // that turn's saved opener, instead of painting a second bubble.
    if (index < 0 && !source.uuid && !source.turnId && !source.steered && !source.questionAnswer) {
      const sentAt = messageTime(source.timestamp)
      if (sentAt != null && Object.keys(turnStarts).length > 0) {
        const ownerTurn = Object.keys(turnStarts)
          .filter(id => (turnStarts[id] ?? 0) >= sentAt - TURN_ATTRIBUTION_SLACK_MS)
          .sort((a, b) => (turnStarts[a] ?? 0) - (turnStarts[b] ?? 0))[0]
        if (ownerTurn) {
          const opener = rows.find(row => row.role === 'user' && row.turnId === ownerTurn
            && !row.steered && !row.questionAnswer && !row.userRenderSnapshot && !matchedLegacy.has(row))
          if (opener) {
            matchedLegacy.add(opener)
            index = rows.indexOf(opener)
          }
        } else if (liveUnits.some(unit => unit.type === 'live-error')) {
          // The send never became a turn (refused before admission). Its bubble
          // is retryable local state, not transcript history: a handoff must
          // never commit it as a sent message.
          continue
        }
      }
    }
    if (index >= 0) {
      const saved = rows[index]
      if (!saved.localRender && source.localRender && saved.text === source.text) rows[index] = { ...saved, localRender: source.localRender }
      continue
    }
    // Only an optional answer is ever inserted into saved rows here: it can be
    // missing from a summary page while its asking turn is owned by history.
    // An ordinary opener is NEVER inserted — the turn owns its input row, and
    // when saved history does not hold that turn yet the stream store keeps
    // the live units instead of fabricating a second history row.
    if (source.questionAnswer) {
      const sequence = liveRows.some(row => source.uuid && row.uuid === source.uuid) ? liveRows : previous
      rows.splice(submittedUserInsertionIndex(rows, source, sequence), 0, source)
    }
  }
  return rows
}

/**
 * Turn-keyed ownership of live units at a history handoff.
 *
 * The turn owns its input row from birth: once saved history holds any row of a
 * turn, that turn's live units are the store's to drop; until then they remain
 * the only source for that turn and stay in the live layer. Live units without
 * a turn stamp are attributed to the earliest turn that started at or after
 * their send time (the stamp can race the handoff), and stamped so every
 * downstream consumer segments them under the right turn. A unit no turn can
 * own — a send refused before admission — is dropped: it is retryable local
 * state, never transcript history. Request cards, notices and error rows are
 * host-lifetime surfaces, not turn content: the ordinary sweep keeps deciding
 * them.
 */
const RETAINED_LIVE_UNIT_TYPES = new Set(['live-user', 'live-text', 'live-tools', 'live-thinking-done'])

export function retainUnownedLiveUnits<L extends { type: string; turnId?: string; msg?: unknown; startedAtMs?: number }>(
  units: L[],
  settledHistory: Array<Record<string, unknown>>,
  turnStarts: Record<string, number>,
  hasTerminalError: boolean,
  readAdvanced = true,
  activeRunningTurnId: string | null = null,
  laggingTurnIds: ReadonlySet<string> = new Set(),
): { units: Array<L & { turnId?: string }>; retained: number } {
  const owned = new Set<string>()
  for (const row of settledHistory) if (typeof row.turnId === 'string' && row.turnId) owned.add(row.turnId)
  // A turn whose work has not flushed yet is not owned by saved history: its
  // input row alone must not hand off the live tail.
  const ownedTurn = (id: string) => owned.has(id) && !laggingTurnIds.has(id)
  const out: Array<L & { turnId?: string }> = []
  let retained = 0
  for (const unit of units) {
    if (!RETAINED_LIVE_UNIT_TYPES.has(unit.type)) continue
    const stamped = typeof unit.turnId === 'string' && unit.turnId ? unit.turnId : null
    if (stamped) {
      // A saved row of a still-running turn only proves its input flushed; the
      // turn's work has not settled, so its live units stay with the live
      // layer until the session leaves the running state. Dropping them on a
      // lagging read blanks the streaming tail and, at turn end before the
      // flush lands, the final answer with no stale retry armed.
      if (!ownedTurn(stamped) || stamped === activeRunningTurnId) { out.push(unit); retained++ }
      continue
    }
    const sentAt = messageTime((unit.msg as { timestamp?: unknown } | undefined)?.timestamp) ?? messageTime(unit.startedAtMs)
    const attributed = sentAt == null ? null : Object.keys(turnStarts)
      .filter(id => (turnStarts[id] ?? 0) >= sentAt - TURN_ATTRIBUTION_SLACK_MS)
      .sort((a, b) => (turnStarts[a] ?? 0) - (turnStarts[b] ?? 0))[0] ?? null
    if (attributed) {
      if (!ownedTurn(attributed) || attributed === activeRunningTurnId) { out.push({ ...unit, turnId: attributed }); retained++ }
      continue
    }
    // No turn can own this unit. A terminal word in the live layer means the
    // send never became a turn: retryable local state, never history. Without
    // one, only a read that brought no new saved content can be a lagging
    // flush — an advancing read that still cannot place the unit has nothing
    // left to retain it for.
    if (!hasTerminalError && !readAdvanced && sentAt != null) { out.push(unit); retained++ }
  }
  return { units: out, retained }
}
