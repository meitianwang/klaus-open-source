// Code review components: a diff the reader can follow, with comments anchored to
// specific lines.
//
// This is the one place the SDK does syntax-adjacent work, and it deliberately
// does NOT highlight syntax. Tokenizing arbitrary source needs a grammar per
// language, and a wrong highlight is worse than none — it marks a string as a
// keyword and the reader stops trusting the whole panel. What actually makes a
// diff readable is line numbers, add/remove tint, and a stable place to hang a
// comment, so that is what these build.
//
// Diff INPUT is pre-parsed. A canvas embeds its data, so parsing a unified diff at
// render time would be work done in the wrong place: the agent already has the
// hunks and can hand them over structured.

import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'

import { Button, Row, Stack, Tag, Text, TextArea } from './core-primitives'
import { useHostTheme } from './hooks'
import type { CanvasTokens } from './tokens'

/** One line of a diff. `context` lines are unchanged. */
export interface DiffLine {
  kind: 'added' | 'removed' | 'context'
  /** Line number in the OLD file. Absent on an added line. */
  oldLine?: number
  /** Line number in the NEW file. Absent on a removed line. */
  newLine?: number
  content: string
}

/** Which side of the diff a line belongs to, for anchoring a comment. */
export type DiffSide = 'old' | 'new'

/** Where a comment is attached. */
export interface DiffAnchor {
  line: number
  side: DiffSide
  /** The line's text at the time the comment was made, so a stale anchor is
   *  visible rather than silently pointing at different code. */
  content?: string
}

/** A stable key for an anchor, for React keys and store lookups. */
export function diffAnchorKey(anchor: DiffAnchor): string {
  return `${anchor.side}:${anchor.line}`
}

function lineColors(tokens: CanvasTokens, kind: DiffLine['kind']) {
  switch (kind) {
    case 'added':
      return { background: tokens.diff.addedBg, marker: tokens.diff.added, sign: '+' }
    case 'removed':
      return { background: tokens.diff.removedBg, marker: tokens.diff.removed, sign: '-' }
    default:
      return { background: 'transparent', marker: 'transparent', sign: ' ' }
  }
}

export interface DiffGroupProps {
  /** The file this hunk belongs to. Shown only when `showHeader`. */
  filename?: string
  lines: DiffLine[]
  /** Show the file header row. Off when `FileReview` already drew one. */
  showHeader?: boolean
  /** Called when a line's gutter is clicked, to start a comment. */
  onLineClick?: (anchor: DiffAnchor) => void
  /** Rendered under a line: an existing comment thread, or a draft editor. */
  renderBelowLine?: (anchor: DiffAnchor) => ReactNode
  /** Collapse runs of unchanged lines longer than this. 0 disables. */
  collapseContext?: number
  style?: CSSProperties
}

/** A run of lines that is either shown or folded. */
type Chunk = { kind: 'lines'; lines: DiffLine[] } | { kind: 'fold'; count: number; lines: DiffLine[] }

/**
 * Fold long runs of context.
 *
 * A generated review often hands over a whole file, and 300 unchanged lines
 * between two hunks means the reader scrolls past the thing they came for. The
 * first and last few lines of a run are kept so each hunk still has visible
 * surroundings.
 */
function chunk(lines: DiffLine[], collapseContext: number): Chunk[] {
  if (collapseContext <= 0) return [{ kind: 'lines', lines }]
  const KEEP = 3
  const out: Chunk[] = []
  let run: DiffLine[] = []
  const flushRun = () => {
    if (run.length === 0) return
    if (run.length > collapseContext) {
      out.push({ kind: 'lines', lines: run.slice(0, KEEP) })
      out.push({ kind: 'fold', count: run.length - KEEP * 2, lines: run.slice(KEEP, -KEEP) })
      out.push({ kind: 'lines', lines: run.slice(-KEEP) })
    } else {
      out.push({ kind: 'lines', lines: run })
    }
    run = []
  }
  let changed: DiffLine[] = []
  const flushChanged = () => {
    if (changed.length === 0) return
    out.push({ kind: 'lines', lines: changed })
    changed = []
  }
  for (const line of lines) {
    if (line.kind === 'context') {
      flushChanged()
      run.push(line)
    } else {
      flushRun()
      changed.push(line)
    }
  }
  flushChanged()
  flushRun()
  return out
}

export function DiffGroup({
  filename,
  lines,
  showHeader = true,
  onLineClick,
  renderBelowLine,
  collapseContext = 0,
  style,
}: DiffGroupProps) {
  const { tokens } = useHostTheme()
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const chunks = useMemo(() => chunk(lines, collapseContext), [lines, collapseContext])

  const anchorFor = (line: DiffLine): DiffAnchor => {
    // A removed line has no position in the new file, so it can only be anchored
    // on the old side. Everything else anchors on the new side, which is what a
    // reviewer means by "this line".
    const side: DiffSide = line.kind === 'removed' ? 'old' : 'new'
    const number = side === 'old' ? line.oldLine : line.newLine
    return { line: number ?? 0, side, content: line.content }
  }

  const gutter: CSSProperties = {
    width: 40,
    minWidth: 40,
    padding: '0 6px',
    textAlign: 'right',
    color: tokens.text.quaternary,
    fontVariantNumeric: 'tabular-nums',
    userSelect: 'none',
  }

  const renderLines = (group: DiffLine[]) =>
    group.map((line, index) => {
      const colors = lineColors(tokens, line.kind)
      const anchor = anchorFor(line)
      const below = renderBelowLine?.(anchor)
      return (
        <div key={`${line.oldLine ?? 'x'}-${line.newLine ?? 'x'}-${index}`}>
          <div
            style={{
              display: 'flex',
              background: colors.background,
              // The clickable target is the whole row, so a reviewer does not
              // have to hit a 40px gutter.
              cursor: onLineClick ? 'pointer' : 'default',
            }}
            onClick={onLineClick ? () => onLineClick(anchor) : undefined}
          >
            <span style={gutter}>{line.oldLine ?? ''}</span>
            <span style={gutter}>{line.newLine ?? ''}</span>
            <span
              aria-hidden="true"
              style={{
                width: 14,
                minWidth: 14,
                textAlign: 'center',
                color: colors.marker,
                userSelect: 'none',
              }}
            >
              {colors.sign}
            </span>
            <code
              style={{
                flex: 1,
                minWidth: 0,
                paddingRight: 10,
                color: tokens.text.primary,
                // Preserve indentation but still wrap: a long line must not add a
                // horizontal scrollbar to the whole review.
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {line.content || ' '}
            </code>
          </div>
          {below ? <div style={{ padding: '6px 10px 6px 94px' }}>{below}</div> : null}
        </div>
      )
    })

  return (
    <div
      style={{
        border: `1px solid ${tokens.stroke.primary}`,
        borderRadius: tokens.radius.sm,
        overflow: 'hidden',
        background: tokens.bg.elevated,
        ...style,
      }}
    >
      {showHeader && filename ? (
        <div
          style={{
            padding: '7px 10px',
            background: tokens.bg.chrome,
            borderBottom: `1px solid ${tokens.stroke.primary}`,
            fontFamily: tokens.fontFamily.mono,
            fontSize: tokens.fontSize.caption,
            color: tokens.text.secondary,
            wordBreak: 'break-all',
          }}
        >
          {filename}
        </div>
      ) : null}
      <div
        style={{
          fontFamily: tokens.fontFamily.mono,
          fontSize: tokens.typography.mono.fontSize,
          lineHeight: tokens.typography.mono.lineHeight,
        }}
      >
        {chunks.map((entry, index) =>
          entry.kind === 'lines' ? (
            <div key={index}>{renderLines(entry.lines)}</div>
          ) : expanded.has(index) ? (
            <div key={index}>{renderLines(entry.lines)}</div>
          ) : (
            <button
              key={index}
              type="button"
              onClick={() => setExpanded(new Set(expanded).add(index))}
              style={{
                display: 'block',
                width: '100%',
                padding: '3px 10px 3px 94px',
                background: tokens.fill.tertiary,
                border: 'none',
                borderTop: `1px solid ${tokens.stroke.secondary}`,
                borderBottom: `1px solid ${tokens.stroke.secondary}`,
                textAlign: 'left',
                font: 'inherit',
                fontSize: tokens.fontSize.caption,
                color: tokens.text.tertiary,
                cursor: 'pointer',
              }}
            >
              Show {entry.count} unchanged {entry.count === 1 ? 'line' : 'lines'}
            </button>
          ),
        )}
      </div>
    </div>
  )
}

// ── Comments ──────────────────────────────────────────────────────────────────

export interface ThreadComment {
  id: string
  author: string
  body: ReactNode
  /** Rendered as given. Format it for the reader. */
  timestamp?: ReactNode
}

export interface ReviewCommentProps {
  comment: ThreadComment
  style?: CSSProperties
}

export function ReviewComment({ comment, style }: ReviewCommentProps) {
  const { tokens } = useHostTheme()
  return (
    <Stack gap="micro" style={style}>
      <Row gap="inline">
        <Text size="small" weight="medium">
          {comment.author}
        </Text>
        {comment.timestamp ? (
          <Text tone="quaternary" size="small">
            {comment.timestamp}
          </Text>
        ) : null}
      </Row>
      <div
        style={{
          fontSize: tokens.fontSize.bodySm,
          color: tokens.text.secondary,
          // Comments come from a model and carry real newlines.
          whiteSpace: 'pre-wrap',
        }}
      >
        {comment.body}
      </div>
    </Stack>
  )
}

export interface ReviewThreadProps {
  anchor: DiffAnchor
  comments: ThreadComment[]
  status?: 'open' | 'resolved'
  onResolve?: () => void
  /** Rendered under the comments: a reply box, a fix button. */
  footer?: ReactNode
  style?: CSSProperties
}

/** A comment thread on one line. */
export function ReviewThread({ anchor, comments, status = 'open', onResolve, footer, style }: ReviewThreadProps) {
  const { tokens } = useHostTheme()
  return (
    <div
      style={{
        padding: '9px 11px',
        borderRadius: tokens.radius.sm,
        border: `1px solid ${tokens.stroke.primary}`,
        background: tokens.bg.editor,
        // The panel is inside a monospace diff; comments are prose.
        fontFamily: tokens.fontFamily.sans,
        ...style,
      }}
    >
      <Stack gap="component">
        <Row gap="inline" justify="space-between">
          <Text tone="quaternary" size="small">
            {anchor.side === 'old' ? 'Old' : 'New'} line {anchor.line}
          </Text>
          <Row gap="inline">
            {status === 'resolved' ? <Tag tone="success">resolved</Tag> : null}
            {status === 'open' && onResolve ? (
              <Button size="sm" variant="ghost" onClick={onResolve}>
                Resolve
              </Button>
            ) : null}
          </Row>
        </Row>
        {comments.map((comment) => (
          <ReviewComment key={comment.id} comment={comment} />
        ))}
        {footer}
      </Stack>
    </div>
  )
}

// ── Draft editor ──────────────────────────────────────────────────────────────

export interface CommentDraftProps {
  anchor: DiffAnchor
  /** Called with the typed text. */
  onSubmit: (text: string) => void
  onCancel: () => void
  submitLabel?: string
  placeholder?: string
  style?: CSSProperties
}

/** The box a reviewer types a new comment into. */
export function CommentDraft({
  anchor,
  onSubmit,
  onCancel,
  submitLabel = 'Comment',
  placeholder = 'What is wrong with this line?',
  style,
}: CommentDraftProps) {
  const { tokens } = useHostTheme()
  const [text, setText] = useState('')
  return (
    <div
      style={{
        padding: '9px 11px',
        borderRadius: tokens.radius.sm,
        border: `1px solid ${tokens.accent.highlight}`,
        background: tokens.bg.editor,
        fontFamily: tokens.fontFamily.sans,
        ...style,
      }}
    >
      <Stack gap="component">
        <Text tone="quaternary" size="small">
          {anchor.side === 'old' ? 'Old' : 'New'} line {anchor.line}
        </Text>
        <TextArea value={text} onChange={setText} placeholder={placeholder} rows={3} />
        <Row gap="inline" justify="end">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!text.trim()}
            onClick={() => {
              onSubmit(text.trim())
              setText('')
            }}
          >
            {submitLabel}
          </Button>
        </Row>
      </Stack>
    </div>
  )
}

// ── File review ───────────────────────────────────────────────────────────────

export interface ReviewThreadRecord {
  id: string
  anchor: DiffAnchor
  comments: ThreadComment[]
  status?: 'open' | 'resolved'
}

export interface FileReviewProps {
  filename: string
  lines: DiffLine[]
  threads?: ReviewThreadRecord[]
  /** The line currently being commented on. */
  draftAnchor?: DiffAnchor
  onRequestComment?: (anchor: DiffAnchor) => void
  onDiscardDraft?: () => void
  onSubmitDraft?: (anchor: DiffAnchor, text: string) => void
  onResolveThread?: (threadId: string) => void
  /** Rendered per thread, e.g. a SendToChatButton that asks for the fix. */
  renderThreadFooter?: (thread: ReviewThreadRecord) => ReactNode
  collapseContext?: number
  style?: CSSProperties
}

/**
 * One file's diff with its comment threads.
 *
 * The composition that makes a review canvas: a diff, threads pinned to lines,
 * and a draft box on the line being commented. Wiring these together per canvas
 * is how three canvases end up with three different anchoring rules.
 */
export function FileReview({
  filename,
  lines,
  threads = [],
  draftAnchor,
  onRequestComment,
  onDiscardDraft,
  onSubmitDraft,
  onResolveThread,
  renderThreadFooter,
  collapseContext = 0,
  style,
}: FileReviewProps) {
  const byKey = useMemo(() => {
    const map = new Map<string, ReviewThreadRecord[]>()
    for (const thread of threads) {
      const key = diffAnchorKey(thread.anchor)
      map.set(key, [...(map.get(key) ?? []), thread])
    }
    return map
  }, [threads])

  const open = threads.filter((thread) => thread.status !== 'resolved').length

  return (
    <Stack gap="inline" style={style}>
      <Row gap="inline" justify="space-between">
        <Text weight="medium" truncate>
          {filename}
        </Text>
        {threads.length > 0 ? (
          <Row gap="micro">
            <Tag tone={open > 0 ? 'warning' : 'success'}>
              {open > 0 ? `${open} open` : 'all resolved'}
            </Tag>
          </Row>
        ) : null}
      </Row>
      <DiffGroup
        lines={lines}
        showHeader={false}
        collapseContext={collapseContext}
        onLineClick={onRequestComment}
        renderBelowLine={(anchor) => {
          const key = diffAnchorKey(anchor)
          const existing = byKey.get(key) ?? []
          const isDraft = draftAnchor ? diffAnchorKey(draftAnchor) === key : false
          if (existing.length === 0 && !isDraft) return null
          return (
            <Stack gap="inline">
              {existing.map((thread) => (
                <ReviewThread
                  key={thread.id}
                  anchor={thread.anchor}
                  comments={thread.comments}
                  status={thread.status}
                  onResolve={onResolveThread ? () => onResolveThread(thread.id) : undefined}
                  footer={renderThreadFooter?.(thread)}
                />
              ))}
              {isDraft && draftAnchor ? (
                <CommentDraft
                  anchor={draftAnchor}
                  onCancel={() => onDiscardDraft?.()}
                  onSubmit={(text) => onSubmitDraft?.(draftAnchor, text)}
                />
              ) : null}
            </Stack>
          )
        }}
      />
    </Stack>
  )
}

// ── Plain source view ─────────────────────────────────────────────────────────

export interface CodeBlockProps {
  code: string
  /** Shown in the header. Not used for highlighting — see the module comment. */
  language?: string
  filename?: string
  /** Start numbering here, for an excerpt from the middle of a file. */
  startLine?: number
  /** 1-based line numbers to tint, relative to `startLine`. */
  highlightLines?: number[]
  maxHeight?: number | string
  style?: CSSProperties
}

/** A source excerpt with line numbers. For quoting code that is not a diff. */
export function CodeBlock({
  code,
  language,
  filename,
  startLine = 1,
  highlightLines = [],
  maxHeight,
  style,
}: CodeBlockProps) {
  const { tokens } = useHostTheme()
  const highlighted = new Set(highlightLines)
  // A trailing newline would otherwise render as a phantom final line.
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <div
      style={{
        border: `1px solid ${tokens.stroke.primary}`,
        borderRadius: tokens.radius.sm,
        overflow: 'hidden',
        background: tokens.bg.elevated,
        ...style,
      }}
    >
      {filename || language ? (
        <Row
          justify="space-between"
          style={{
            padding: '6px 10px',
            background: tokens.bg.chrome,
            borderBottom: `1px solid ${tokens.stroke.primary}`,
          }}
        >
          <span
            style={{
              fontFamily: tokens.fontFamily.mono,
              fontSize: tokens.fontSize.caption,
              color: tokens.text.secondary,
              wordBreak: 'break-all',
            }}
          >
            {filename}
          </span>
          {language ? (
            <Text tone="quaternary" size="small">
              {language}
            </Text>
          ) : null}
        </Row>
      ) : null}
      <div
        data-canvas-scroll
        style={{
          maxHeight,
          overflow: 'auto',
          fontFamily: tokens.fontFamily.mono,
          fontSize: tokens.typography.mono.fontSize,
          lineHeight: tokens.typography.mono.lineHeight,
        }}
      >
        {lines.map((line, index) => {
          const number = startLine + index
          return (
            <div
              key={index}
              style={{
                display: 'flex',
                background: highlighted.has(number) ? tokens.accent.highlightBg : 'transparent',
              }}
            >
              <span
                style={{
                  width: 44,
                  minWidth: 44,
                  padding: '0 8px',
                  textAlign: 'right',
                  color: tokens.text.quaternary,
                  fontVariantNumeric: 'tabular-nums',
                  userSelect: 'none',
                }}
              >
                {number}
              </span>
              <code
                style={{
                  flex: 1,
                  minWidth: 0,
                  paddingRight: 10,
                  color: tokens.text.primary,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {line || ' '}
              </code>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Review thread store ───────────────────────────────────────────────────────

export interface ReviewThreadStore {
  threads: ReviewThreadRecord[]
  /** The line a comment is being written on, if any. */
  draft?: DiffAnchor
  /** Open the draft editor on a line. */
  requestComment: (anchor: DiffAnchor) => void
  discardDraft: () => void
  /** Turn the draft into a thread. Returns the new thread id. */
  submitDraft: (anchor: DiffAnchor, comment: Omit<ThreadComment, 'id'>) => string
  appendComment: (threadId: string, comment: Omit<ThreadComment, 'id'>) => void
  resolveThread: (threadId: string) => void
  reset: () => void
}

/**
 * The thread bookkeeping a review canvas would otherwise rewrite every time.
 *
 * `FileReview` is deliberately controlled — it renders the threads it is handed
 * and reports clicks — because a review canvas may want threads that came from
 * the agent, from disk, or from the user in this session. The cost is that every
 * such canvas re-implements the same five operations, and gets id generation
 * wrong the same way: reusing the anchor as the id, so a second comment on one
 * line silently replaces the first.
 *
 * In-memory by design. Persisting through `useCanvasState` would write every
 * keystroke of an in-progress comment into the sidecar; a canvas that wants
 * threads to survive a reload should store the SUBMITTED ones itself.
 */
export function useReviewThreadStore(): ReviewThreadStore {
  const [threads, setThreads] = useState<ReviewThreadRecord[]>([])
  const [draft, setDraft] = useState<DiffAnchor | undefined>(undefined)
  // A counter, not a random id: within one canvas it is enough to be unique, and
  // a deterministic id keeps a re-render from looking like a new thread.
  const nextId = useRef(1)

  const requestComment = useCallback((anchor: DiffAnchor) => setDraft(anchor), [])
  const discardDraft = useCallback(() => setDraft(undefined), [])

  const submitDraft = useCallback(
    (anchor: DiffAnchor, comment: Omit<ThreadComment, 'id'>) => {
      const id = `thread-${nextId.current++}`
      setThreads((previous) => [
        ...previous,
        { id, anchor, status: 'open', comments: [{ ...comment, id: `${id}-1` }] },
      ])
      setDraft(undefined)
      return id
    },
    [],
  )

  const appendComment = useCallback((threadId: string, comment: Omit<ThreadComment, 'id'>) => {
    setThreads((previous) =>
      previous.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              comments: [
                ...thread.comments,
                { ...comment, id: `${threadId}-${thread.comments.length + 1}` },
              ],
            }
          : thread,
      ),
    )
  }, [])

  const resolveThread = useCallback((threadId: string) => {
    setThreads((previous) =>
      previous.map((thread) =>
        thread.id === threadId ? { ...thread, status: 'resolved' as const } : thread,
      ),
    )
  }, [])

  const reset = useCallback(() => {
    setThreads([])
    setDraft(undefined)
  }, [])

  return useMemo(
    () => ({
      threads,
      draft,
      requestComment,
      discardDraft,
      submitDraft,
      appendComment,
      resolveThread,
      reset,
    }),
    [threads, draft, requestComment, discardDraft, submitDraft, appendComment, resolveThread, reset],
  )
}
