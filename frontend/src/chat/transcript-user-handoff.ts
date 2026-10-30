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
export function mergeSubmittedUserHistory(history: UserRow[], liveUnits: LiveRow[], previous: UserRow[]): UserRow[] {
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
    if (index >= 0) {
      const saved = rows[index]
      if (!saved.localRender && source.localRender && saved.text === source.text) rows[index] = { ...saved, localRender: source.localRender }
      continue
    }
    const owner = source.turnId ? rows.findIndex(row => row.turnId === source.turnId) : -1
    if (owner >= 0 && !source.steered && !source.questionAnswer) rows.splice(owner, 0, source)
    else if (source.questionAnswer) {
      const sequence = liveRows.some(row => source.uuid && row.uuid === source.uuid) ? liveRows : previous
      rows.splice(submittedUserInsertionIndex(rows, source, sequence), 0, source)
    } else rows.push(source)
  }
  return rows
}
