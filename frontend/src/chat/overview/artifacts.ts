// The Artifacts section: every file this CONVERSATION changed.
//
// Source is the engine's own record (`session:file-changes`), which arrives
// grouped by turn. It is NOT the git diff, and that is the whole point of the
// section existing separately:
//
//   - Artifacts answers "what did this conversation produce". That is true of a
//     scratch directory, a fresh clone with no commits, and any path that is not
//     a repository at all. The list this section replaced WAS the git changed-file
//     column under a second title, so a non-repo cwd printed "not a git repository"
//     exactly where the produced files belonged.
//   - Changes answers "what does this project have uncommitted", which is a
//     working-tree fact about the whole repo — other tools' edits, the user's own
//     edits, and everything this conversation never touched.
//
// Sub-agent edits count: the engine folds them into the same turn's record, and
// the renderer never sees a nested `diff_update` for them, so this section is the
// only place a forked agent's writes surface.
//
// Two rules this file must not drift from:
//
//   - The panel and capsule are different projections of the same engine record.
//     The panel folds every turn into one session-wide file list, while the capsule
//     reads ONLY its own turn's group.
//   - A count of `null` is UNKNOWN, never 0. The engine sends null when it could
//     not measure a file (no readable baseline, or no exact count affordable), and
//     one unknown file makes that projection's total unknown too. Coercing it (`|| 0`)
//     is what let a turn whose real change was +53 -3 read as a number nothing
//     stood behind.
import { tt } from '../../app/i18n'
import { applyDefaultCollapseState, overviewDeps, styles } from './shared'
import { fileIconSvg } from '../file-icon'
import { icon } from '../../icons/registry'
import type { SpecDocument } from '../spec-document-model'
import { openSiteReference } from '../site-references'
import { endResourcesForSession, openEndResourceFile, subscribeEndResources, type EndResource } from '../end-resources'
import { isUrlTarget, websiteResourceLabel } from '../../../../contracts/end-resources'
import { fileExtension } from '../../../../contracts/file-citation'

const w = () => window as any

/** An engine line count, or `null` when it could not be measured. */
export type LineCount = number | null

export interface ArtifactFile {
  path: string
  relativePath: string
  name: string
  kind: 'create' | 'modify' | 'delete' | string
  added: LineCount
  removed: LineCount
  /** The turn's own unified diff for this file, when the engine recorded one.
   *  Null means no patch was recorded — previews stay off rather than guessing. */
  turnDiff: string | null
}

export interface ArtifactTurn {
  /** `null` for records replayed from a rollout written before turn attribution. */
  turnId: string | null
  files: ArtifactFile[]
  added: LineCount
  removed: LineCount
}

export interface ArtifactSummary {
  files: ArtifactFile[]
  added: LineCount
  removed: LineCount
}

interface ArtifactsState {
  sessionId: string | null
  turns: ArtifactTurn[]
  error: string | null
  loading: boolean
}

const state: ArtifactsState = { sessionId: null, turns: [], error: null, loading: false }

// Per-session cache of the last settled record. Revisiting a session seeds the
// store from here synchronously, so the transcript's per-turn change cards draw
// in the same frame as the transcript instead of popping in one IPC round
// later. File changes live in a record separate from the conversation, and
// this cache is what lets that record paint together with it on reopen.
const sessionCache = new Map<string, ArtifactTurn[]>()

// One fetch per session at a time. Switches and refreshes all funnel through
// here so a history load and the overview panel's own reload cannot double-fetch
// the same session.
const inFlightLoads = new Map<string, Promise<void>>()
const loadTokens = new Map<string, object>()

/** Release the companion file-change record with its retired transcript. */
export function retireArtifactsForSession(sessionId: string): void {
  sessionCache.delete(sessionId)
  inFlightLoads.delete(sessionId)
  loadTokens.delete(sessionId)
  if (state.sessionId === sessionId) {
    state.turns = []
    state.loading = false
    state.error = null
    emit()
  }
}

// ---- pub/sub（React 胶囊 useSyncExternalStore + 本区命令式渲染共用） ----
const listeners = new Set<() => void>()
let version = 0

export function subscribeArtifacts(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function artifactsVersion(): number {
  return version
}

/**
 * One turn's record: the files it changed and their line counts.
 *
 * The id is required: falling back to "the newest group" would show the PREVIOUS
 * turn's numbers for the whole of a new turn that has not written anything yet,
 * which is the stale reading this section stopped producing. No group for that id
 * means nothing to report, and the caller renders nothing.
 */
export function artifactTurn(sessionId: string | null, turnId: string | null): ArtifactTurn | null {
  if (!sessionId || !turnId) return null
  return sessionCache.get(sessionId)?.find(entry => entry.turnId === turnId) ?? null
}

function sessionFileKind(first: string, latest: string): string {
  if (latest === 'delete') return 'delete'
  return first === 'create' ? 'create' : 'modify'
}

function sumLineCounts(previous: LineCount, next: LineCount): LineCount {
  return previous === null || next === null ? null : previous + next
}

/**
 * Fold the engine's per-turn record into the conversation-wide panel model.
 * Repeated paths stay in first-touch order while their latest state wins. Counts
 * accumulate the recorded turn effects because the engine does not expose a
 * separate session-baseline diff, and unknown input keeps the aggregate unknown.
 */
export function aggregateArtifactTurns(turns: readonly ArtifactTurn[]): ArtifactSummary {
  const files = new Map<string, { firstKind: string; file: ArtifactFile }>()
  for (const turn of turns) {
    for (const file of turn.files) {
      const previous = files.get(file.path)
      if (!previous) {
        files.set(file.path, { firstKind: file.kind, file: { ...file } })
        continue
      }
      files.set(file.path, {
        firstKind: previous.firstKind,
        file: {
          ...file,
          kind: sessionFileKind(previous.firstKind, file.kind),
          added: sumLineCounts(previous.file.added, file.added),
          removed: sumLineCounts(previous.file.removed, file.removed),
        },
      })
    }
  }
  const aggregate = [...files.values()].map(entry => entry.file)
  return {
    files: aggregate,
    added: aggregate.reduce<LineCount>((total, file) => sumLineCounts(total, file.added), 0),
    removed: aggregate.reduce<LineCount>((total, file) => sumLineCounts(total, file.removed), 0),
  }
}

function emit(): void {
  version++
  for (const fn of listeners) fn()
  if (typeof document !== 'undefined') renderArtifactsSection()
}

// ==================== Loading ====================

/** A number the engine measured, or null for "not measurable" — never coerced. */
function lineCount(value: unknown): LineCount {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Refetch the session's record. Always loaded for the current session rather than
 * gated behind "is the panel open": the capsule needs the same numbers while the
 * panel is collapsed, and the diff store already had to grow a set of named
 * consumers to undo that gate. One in-memory read per burst is cheaper than that
 * bookkeeping.
 *
 * Concurrent callers share one fetch per session: the transcript's history load
 * and the overview panel's session-change reload ask for the same record within
 * milliseconds of each other, and both must see the same settled state.
 */
export async function reloadArtifacts(): Promise<void> {
  const sessionId = overviewDeps().currentSessionId()
  if (sessionId !== state.sessionId) {
    // A switch shows the new session's own emptiness, never the old one's rows.
    // A cached record for the target seeds it in place, so a revisit never
    // flashes empty before its own rows arrive.
    state.sessionId = sessionId
    state.turns = sessionId ? sessionCache.get(sessionId) ?? [] : []
    state.error = null
  }
  if (!sessionId) {
    state.loading = false
    emit()
    return Promise.resolve()
  }
  state.loading = true
  emit()
  return loadArtifactsForSession(sessionId)
}

function loadArtifactsForSession(sessionId: string): Promise<void> {
  const running = inFlightLoads.get(sessionId)
  if (running) return running
  const isCurrent = () => state.sessionId === sessionId && overviewDeps().currentSessionId() === sessionId
  const token = {}
  loadTokens.set(sessionId, token)
  const valid = () => loadTokens.get(sessionId) === token
  const promise = (async () => {
    try {
      const reply = await w().klaus.session.fileChanges(sessionId)
      if (!valid()) return
      const groups: unknown[] = Array.isArray(reply?.turns) ? reply.turns : []
      const turns = groups.map((group: any) => {
        const rows: unknown[] = Array.isArray(group?.files) ? group.files : []
        return {
          turnId: typeof group?.turnId === 'string' && group.turnId ? group.turnId : null,
          files: rows.map((row: any) => ({
            path: String(row?.path || ''),
            relativePath: String(row?.relativePath || row?.path || ''),
            name: String(row?.name || ''),
            kind: String(row?.kind || 'modify'),
            added: lineCount(row?.added),
            removed: lineCount(row?.removed),
            turnDiff: typeof row?.turnDiff === 'string' ? row.turnDiff : null,
          })).filter(file => !!file.path),
          added: lineCount(group?.stats?.linesAdded),
          removed: lineCount(group?.stats?.linesRemoved),
        }
      }).filter(turn => turn.files.length > 0)
      sessionCache.set(sessionId, turns)
      if (isCurrent()) {
        state.turns = turns
        state.loading = false
        state.error = reply?.error || null
      }
    } catch (err: any) {
      if (valid() && isCurrent()) {
        state.loading = false
        state.error = String(err?.message || err)
      }
    } finally {
      if (valid()) { inFlightLoads.delete(sessionId); loadTokens.delete(sessionId) }
    }
    emit()
  })()
  inFlightLoads.set(sessionId, promise)
  return promise
}

/**
 * The record for one session, ready to draw: a cached record satisfies this
 * synchronously, an uncached one after its independent fetch settles. Pending
 * records never delay the saved transcript; subscribers refresh change cards
 * when their session-owned record arrives.
 */
export function ensureArtifactsForSession(sessionId: string): Promise<void> {
  if (!sessionId) return Promise.resolve()
  if (sessionCache.has(sessionId)) return Promise.resolve()
  // History can finish after the user has switched away. Read its own record,
  // without selecting it in the overview or borrowing the newly active chat.
  return loadArtifactsForSession(sessionId)
}

/**
 * Whether the store already holds a settled record for this session. A cached
 * session answers yes on the very frame the switch lands; anything else must
 * wait for `ensureArtifactsForSession`.
 */
export function artifactsReady(sessionId: string): boolean {
  return sessionCache.has(sessionId)
}

let scheduled: ReturnType<typeof setTimeout> | null = null
function scheduleReload(): void {
  if (scheduled) clearTimeout(scheduled)
  scheduled = setTimeout(() => {
    scheduled = null
    void reloadArtifacts()
  }, 250)
}

/**
 * `diff_update` is the per-edit signal for the main agent. `tool_end` and `done`
 * are what catch a sub-agent's writes: the shell projects nested agent activity
 * as tool progress, so a forked agent's file_change never reaches the renderer
 * as its own event — only the engine's fold knows about it.
 */
export function initArtifactsSection(): void {
  subscribeEndResources(renderArtifactsSection)
  w().klaus?.on?.chatEvent?.((event: any) => {
    if (!event || event.sessionId !== state.sessionId) return
    if (event.type === 'diff_update' || event.type === 'tool_end' || event.type === 'done') scheduleReload()
  })
  void reloadArtifacts()
}

/** Open the panel on this section, expanded — the capsule's review segment. */
export function revealArtifacts(): void {
  w().klausOpenMonitorPanel?.()
  const section = document.getElementById('monitor-section-artifacts')
  if (!section) return
  section.classList.remove('collapsed')
  section.querySelector('.artifacts-section-header')?.setAttribute('aria-expanded', 'true')
  section.scrollIntoView({ block: 'nearest' })
}

// ==================== Rendered section ====================

/** `–` for an unknown count, matching what the capsule shows. */
export function formatLineCount(value: LineCount): string {
  return value === null ? '–' : String(value)
}

function countCell(value: LineCount, kind: 'added' | 'removed'): HTMLElement {
  const el = document.createElement('span')
  el.className = styles[`artifact-${kind}`]
  el.textContent = (kind === 'added' ? '+' : '-') + formatLineCount(value)
  return el
}

function artifactRow(file: ArtifactFile): HTMLElement {
  const deleted = file.kind === 'delete'
  // A deleted file has nothing to open, so its row is not a button. Pretending
  // otherwise buys a click that can only land on "file not found".
  const row = document.createElement(deleted ? 'div' : 'button')
  row.className = styles['artifact-row']
  row.setAttribute('data-kind', file.kind)
  const mark = document.createElement('span')
  mark.className = styles['artifact-icon']
  mark.setAttribute('aria-hidden', 'true')
  mark.innerHTML = fileIconSvg(file.name || file.path)
  const name = document.createElement('span')
  name.className = styles['artifact-name']
  name.textContent = file.name || file.relativePath
  row.append(mark, name)
  if (deleted) {
    const tag = document.createElement('span')
    tag.className = styles['artifact-tag']
    tag.textContent = tt('overview_artifacts_deleted')
    row.appendChild(tag)
  }
  // Zero is printed as nothing: an edit that changed no lines reads worse as
  // "+0 -0" than as a bare row. An UNKNOWN count still prints, as `–`, because
  // the file was measured-and-failed rather than measured-as-zero.
  if (file.added === null || file.added > 0) row.appendChild(countCell(file.added, 'added'))
  if (file.removed === null || file.removed > 0) row.appendChild(countCell(file.removed, 'removed'))
  if (!deleted) {
    ;(row as HTMLButtonElement).type = 'button'
    row.setAttribute('aria-label', file.relativePath || file.path)
    row.addEventListener('click', () => w().klausOpenWorkspaceFilePath?.(file.path))
  }
  return row
}

export function specArtifactDocuments(documents: readonly Pick<SpecDocument, 'sessionId' | 'path' | 'title'>[], sessionId: string): Pick<SpecDocument, 'sessionId' | 'path' | 'title'>[] {
  const seen = new Set<string>()
  return documents.filter(document => {
    if (!sessionId || document.sessionId !== sessionId || !document.path || seen.has(document.path)) return false
    seen.add(document.path)
    return true
  })
}

function specArtifactRow(spec: Pick<SpecDocument, 'sessionId' | 'path' | 'title'>): HTMLButtonElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = styles['artifact-row']
  row.setAttribute('data-kind', 'spec')
  row.setAttribute('aria-label', `${spec.title} — ${spec.path}`)
  const mark = document.createElement('span')
  mark.className = styles['artifact-icon']
  mark.setAttribute('aria-hidden', 'true')
  mark.innerHTML = icon('spec')
  const name = document.createElement('span')
  name.className = styles['artifact-name']
  name.textContent = spec.title
  row.append(mark, name)
  row.addEventListener('click', () => overviewDeps().openSpecDocument({ sessionId: spec.sessionId, path: spec.path }))
  return row
}

/** Every turn's resources, newest turn first, one row per distinct resource. */
export function conversationOutputs(sessionId: string): EndResource[] {
  const outputs: EndResource[] = []
  const seen = new Set<string>()
  for (const turn of [...endResourcesForSession(sessionId)].reverse()) {
    for (const resource of turn.resources) {
      const key = resource.type === 'file' ? `path:${resource.path}` : isUrlTarget(resource.target) ? `url:${resource.target}` : `path:${resource.target}`
      if (seen.has(key)) continue
      seen.add(key)
      outputs.push(resource)
    }
  }
  return outputs
}

function outputArtifactRow(resource: EndResource, sessionId: string): HTMLButtonElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = styles['artifact-row']
  const website = resource.type === 'website'
  const target = website ? resource.target : resource.path
  row.setAttribute('data-kind', website ? 'website' : 'output-file')
  const label = website ? websiteResourceLabel(target) || tt('end_resource_website_title') : target.split(/[\\/]/).pop() || target
  row.setAttribute('aria-label', tt('end_resource_open_named').replace('{title}', label))
  const mark = document.createElement('span')
  mark.className = styles['artifact-icon']
  mark.setAttribute('aria-hidden', 'true')
  mark.innerHTML = website ? icon('tc-globe') : fileIconSvg(target)
  const name = document.createElement('span')
  name.className = styles['artifact-name']
  name.textContent = label
  const type = document.createElement('span')
  type.className = styles['artifact-tag']
  const extension = fileExtension(target).toUpperCase()
  type.textContent = website ? tt('end_resource_website_subtitle') : extension ? tt('end_resource_output_file_type').replace('{extension}', extension) : tt('turn_navigation_file_output')
  row.append(mark, name, type)
  row.addEventListener('click', () => {
    if (website && isUrlTarget(target)) void openSiteReference(sessionId, target)
    else openEndResourceFile(target)
  })
  return row
}

function artifactGroup(title: string, rows: HTMLElement[]): HTMLElement {
  const group = document.createElement('div')
  group.className = 'artifacts-group'
  const heading = document.createElement('div')
  heading.className = 'artifacts-group-title'
  heading.textContent = title
  const list = document.createElement('div')
  list.className = 'artifacts-group-body'
  list.replaceChildren(...rows)
  group.append(heading, list)
  return group
}

export function renderArtifactsSection(): void {
  const body = document.getElementById('monitor-artifacts-body')
  const meta = document.getElementById('monitor-artifacts-count')
  if (!body) return
  const aggregate = aggregateArtifactTurns(state.turns)
  const sessionId = overviewDeps().currentSessionId() || ''
  const specs = specArtifactDocuments(overviewDeps().specDocuments(sessionId), sessionId)
  const outputs = conversationOutputs(sessionId)
  if (meta) {
    const lineCounts = aggregate.files.length === 0 ? '' : [
      aggregate.added === null || aggregate.added > 0 ? `+${formatLineCount(aggregate.added)}` : '',
      aggregate.removed === null || aggregate.removed > 0 ? `-${formatLineCount(aggregate.removed)}` : '',
    ].filter(Boolean).join(' ')
    meta.textContent = [
      outputs.length > 0 ? `${tt('end_resource_outputs')} · ${outputs.length}` : '',
      lineCounts,
    ].filter(Boolean).join(' · ')
  }
  // Standing section: an empty conversation says so in place. Loading only
  // speaks when there is nothing on screen yet, so a refresh mid-turn does not
  // blank the list the user is reading.
  if (aggregate.files.length === 0 && specs.length === 0 && outputs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'ctx-empty'
    empty.textContent = state.error
      ? state.error
      : state.loading ? tt('artifacts_loading') : tt('overview_artifacts_empty')
    body.replaceChildren(empty)
    applyDefaultCollapseState('monitor-section-artifacts')
    return
  }
  const groups: HTMLElement[] = []
  if (specs.length > 0) groups.push(artifactGroup(`${tt('spec_documents')} · ${specs.length}`, specs.map(specArtifactRow)))
  if (outputs.length > 0) groups.push(artifactGroup(`${tt('end_resource_outputs')} · ${outputs.length}`, outputs.map(resource => outputArtifactRow(resource, sessionId))))
  if (aggregate.files.length > 0) {
    const files = aggregate.files.map(artifactRow)
    if (specs.length > 0 || outputs.length > 0) groups.push(artifactGroup(tt('overview_artifacts_files'), files))
    else {
      const rows = document.createElement('div')
      rows.className = 'artifacts-group-body'
      rows.replaceChildren(...files)
      groups.push(rows)
    }
  }
  body.replaceChildren(...groups)
  applyDefaultCollapseState('monitor-section-artifacts')
}
