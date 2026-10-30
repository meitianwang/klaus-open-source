// Side tasks: tabs in the right #artifacts-panel (side-chat mode).
// The transcript and composer are the SAME components as the main chat, driven
// by chat.js's ChatSurface abstraction (window.klausSideSurface* hooks + the
// cloned #input-wrapper). This module owns the side-task family (create / close /
// switch, up to 8), the idle-expiry banner, the side-rail entry, and pointing
// the shared side surface at the active side task. The tabs themselves are
// rendered by panels/panel-tabs.tsx, which owns the whole strip.
//
//（迁自 js/side-tasks.js：纯数据面+显隐开关，无 HTML 建造，TS 化原样收编。）
import { selectSideTaskQuoteTarget, type SideTaskQuotePanel } from '../../../../contracts/side-task-quotes'
import { prepareEphemeralSessionStream } from '../stream-store'

const w = () => window as any

interface SideTask {
  id: string
  parentSessionId: string
  title?: string
  initialTitleIndex?: number | null
  createdAt: number
  expiresAt?: number
  sideTaskStatus?: 'starting' | 'active' | 'closing' | 'failed'
}

const api = w().klaus
const artifactsPanel = document.getElementById('artifacts-panel')
const panel = document.getElementById('side-chat-panel')
const messagesEl = document.getElementById('side-messages')
const composerHost = document.getElementById('side-composer-host')
const emptyEl = document.getElementById('side-chat-empty')
const expiredEl = document.getElementById('side-chat-expired')
const recreateBtn = document.getElementById('side-chat-recreate')
const newButton = document.getElementById('side-task-new') as HTMLButtonElement | null

const tasks = new Map<string, SideTask>()
let parentId: string | null = null
let parentReady = false
let expiredSessionId: string | null = null
let activeSideId: string | null = null
let refreshSequence = 0
let expiryRefreshPending = false
let nextExpiryRefreshAt = 0
let navigationRevision = 0
let activationRevision = 0
let pendingSequence = 0
let familyNavigationRevision = -1
let familyRead: Promise<void> | null = null
let titleRevision = 0
const titleUpdates = new Map<string, { revision: number; title: string }>()
interface PendingPanel {
  id: string
  sessionId: string | null
  navigationRevision: number
  previousSideId: string | null
  titleIndex: number
  resolvedSideId: string | null
  cancelled: boolean
  kind: 'loading' | 'creating'
  promise: Promise<unknown>
}
let opening: PendingPanel | null = null
let creation: PendingPanel | null = null
const readyParents = new Set<string>()
const eligibilityReads = new Map<string, Promise<boolean>>()
// Per-session side-chat state: remembers which side task was active and
// whether the panel was open for each parent session the user has visited.
// Lets us auto-restore the same view on switch-back so the user doesn't have
// to reopen the panel every time they navigate away and back.
const stateBySession = new Map<string, { activeSideId: string | null; wasOpen: boolean }>()

const text = (key: string): string => w().tt?.(key) || key
const currentId = (): string | null => w().getCurrentSessionId?.() || null
const showError = (error: unknown) => {
  const message = String((error as any)?.message || error)
  if (w().klausDialog?.alert) w().klausDialog.alert(message)
  else window.alert(message)
}

function find(sessionId: string) {
  return tasks.get(sessionId) || null
}

function panelOpen() {
  return artifactsPanel?.getAttribute('data-mode') === 'side-chat'
    && !artifactsPanel.classList.contains('collapsed')
}

// Remember (or forget) this session's side-chat state so switch-back can
// reopen the same view. Called whenever activeSideId or panel visibility
// changes, and again right before the session itself changes.
function saveStateFor(sessionId: string | null) {
  if (!sessionId) return
  const wasOpen = panelOpen()
  const active = activeSideId && tasks.has(activeSideId) ? activeSideId : null
  if (wasOpen || active) stateBySession.set(sessionId, { activeSideId: active, wasOpen })
  else stateBySession.delete(sessionId)
}

function countdown(expiresAt?: number) {
  const remaining = (expiresAt || 0) - Date.now()
  if (remaining > 10 * 60_000) return ''
  if (remaining <= 0) return text('side_task_expired_short')
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// ── Panel entry ───────────────────────────────────────────────────────────
function pendingPanel() {
  return [creation, opening].find(request => request && !request.cancelled
    && request.sessionId === currentId() && request.navigationRevision === navigationRevision) || null
}

function requestIsCurrent(request: PendingPanel) {
  return !request.cancelled && request.sessionId === currentId()
    && request.navigationRevision === navigationRevision && panelOpen()
}

function cancelPending() {
  for (const request of new Set([opening, creation])) {
    if (!request) continue
    request.cancelled = true
    w().klausSideComposerDiscard?.(request.id)
  }
  opening = null
  creation = null
  activationRevision++
}

function newPending(kind: PendingPanel['kind']): PendingPanel {
  const right = w().KlausPanelTabs?.sideTaskQuotePanels?.().find((panel: SideTaskQuotePanel) => panel.placement === 'right')
  return {
    id: `pending-side-${++pendingSequence}`, sessionId: currentId(), navigationRevision,
    previousSideId: activeSideId && tasks.has(activeSideId) ? activeSideId : null,
    titleIndex: (right?.tabs.length ?? tasks.size) + 1, resolvedSideId: null,
    cancelled: false, kind, promise: Promise.resolve(),
  }
}

async function openFromRail() {
  const pending = pendingPanel()
  if (pending) { w().openArtifactsPanel?.('side-chat'); render(); await pending.promise; return }
  // An already known family does not need a listing round trip before opening.
  if (parentId === currentId()) {
    if (activeSideId && tasks.has(activeSideId)) {
      w().openArtifactsPanel?.('side-chat')
      const activated = setActive(activeSideId)
      void refresh(currentId()).catch(showError)
      await activated
      return
    }
    if (tasks.size === 0 && canCreate()) { await create(); return }
  }
  const request = newPending('loading')
  opening = request
  w().openArtifactsPanel?.('side-chat')
  if (parentId === request.sessionId && activeSideId && tasks.has(activeSideId)) {
    void setActive(activeSideId).catch(showError)
  } else {
    activeSideId = request.id
    w().klausSideSurfaceClear?.()
    w().klausSideComposerPrepare?.(request.id, request.sessionId)
  }
  render()
  request.promise = (async () => {
    try {
      await refresh(request.sessionId)
      if (!requestIsCurrent(request)) return
      if (opening !== request) { await request.promise; return }
      const existing = activeSideId && tasks.has(activeSideId) ? activeSideId
        : [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)[0]?.id
      if (existing) {
        await w().klausSideComposerPromote?.(request.id, existing, false)
        if (!requestIsCurrent(request)) return
        await setActive(existing)
        if (requestIsCurrent(request) && activeSideId === existing) request.resolvedSideId = existing
      } else if (canCreate()) await create()
      else activeSideId = null
    } finally {
      if (opening === request) {
        opening = null
        w().klausSideComposerDiscard?.(request.id)
        if (activeSideId === request.id) activeSideId = null
        render()
      }
    }
  })()
  await request.promise
}

function canCreate() {
  return familyNavigationRevision === navigationRevision && !!parentId && parentReady && tasks.size < 8 && !creation
}

async function create(): Promise<string | null> {
  if (creation && requestIsCurrent(creation)) return await creation.promise as string | null
  if (!canCreate()) { render(); return null }
  const family = parentId!
  const request = opening && requestIsCurrent(opening) ? opening : newPending('creating')
  if (opening === request) opening = null
  request.kind = 'creating'
  creation = request
  activeSideId = request.id
  expiredSessionId = null
  w().openArtifactsPanel?.('side-chat')
  w().klausSideSurfaceClear?.()
  w().klausSideComposerPrepare?.(request.id, family)
  render()
  let createdTask: SideTask | null = null
  request.promise = (async () => {
    try {
      const task: SideTask = await api.session.createSideTask(family, { initialTitleIndex: request.titleIndex })
      if (!task || typeof task.id !== 'string' || !task.id) throw new Error(text('side_task_create_failed'))
      createdTask = task
      if (!requestIsCurrent(request) || parentId !== family || activeSideId !== request.id) {
        const closed = await closeSideTask(task.id)
        if (closed?.ok !== true) throw new Error(closed?.error || text('side_task_close_failed'))
        return null
      }
      await w().klausSideComposerPromote?.(request.id, task.id)
      if (!requestIsCurrent(request) || parentId !== family || activeSideId !== request.id) {
        const closed = await closeSideTask(task.id)
        if (closed?.ok !== true) throw new Error(closed?.error || text('side_task_close_failed'))
        return null
      }
      // A listing started before the fork must not erase the newly returned task.
      refreshSequence++
      prepareEphemeralSessionStream(task.id)
      tasks.set(task.id, task)
      creation = null
      await setActive(task.id)
      if (requestIsCurrent(request) && activeSideId === task.id) request.resolvedSideId = task.id
      return task.id
    } catch (error) {
      if (!createdTask && !requestIsCurrent(request)) return null
      if (requestIsCurrent(request) && activeSideId === request.id) {
        activeSideId = request.previousSideId && tasks.has(request.previousSideId) ? request.previousSideId : null
        if (activeSideId) void setActive(activeSideId).catch(showError)
      }
      throw error
    } finally {
      w().klausSideComposerDiscard?.(request.id)
      if (creation === request) {
        creation = null
        if (activeSideId === request.id) { activeSideId = null; w().klausSideSurfaceClear?.() }
      }
      if (request.navigationRevision === navigationRevision) render()
    }
  })()
  return await request.promise as string | null
}

async function closeSideTask(id: string) {
  await w().klausStopVoiceChatForSession?.(id)
  return api.session.closeSideTask(id)
}

async function close(task: SideTask) {
  const navigation = navigationRevision
  // No confirm dialog: side tasks are ephemeral by design (idle-TTL sweeps
  // them anyway) and the tab's × should behave like closing a browser tab.
  const result = await closeSideTask(task.id)
  if (result?.ok !== true) throw new Error(result?.error || text('side_task_close_failed'))
  // Free the slot + registration in chat.js so the DOM doesn't linger and
  // subsequent events for this id stop being dispatched anywhere.
  w().klausSideSurfaceRemove?.(task.id)
  if (navigation !== navigationRevision) return
  tasks.delete(task.id)
  if (activeSideId === task.id) activationRevision++
  if (activeSideId === task.id) activeSideId = null
  // Discarding the last side task leaves side-chat mode; where the panel goes
  // next is the strip's call (it falls back to the Monitor tab), so this only
  // clears the shared surface.
  if (tasks.size === 0) { exitPanel(); return }
  render()
}

// Leave side-chat mode: clear the shared side surface and drop the active-task
// state. The panel itself stays open — the strip decides which tab takes
// over (it falls back to Monitor), so the panel must not collapse from here or
// it would flash shut and immediately reopen.
function exitPanel() {
  activeSideId = null
  w().klausSideSurfaceClear?.()
  render()
  saveStateFor(currentId())
}

async function setActive(sideId: string) {
  const revision = ++activationRevision
  const navigation = navigationRevision
  const previousSideId = activeSideId
  activeSideId = sideId
  expiredSessionId = null
  try {
    // Bind before exposing the composer; a TTL renewal must not keep it on the old tab.
    const activated = w().klausSideSurfaceActivate?.(sideId)
    render()
    saveStateFor(currentId())
    await activated
    if (revision !== activationRevision || navigation !== navigationRevision) return
    if (tasks.has(sideId)) {
      void api.session.touchSideTask(sideId).then((touched: { ok?: boolean; error?: string }) => {
        if (revision !== activationRevision || navigation !== navigationRevision || activeSideId !== sideId) return
        if (touched?.ok !== true) {
          tasks.delete(sideId)
          w().klausSideSurfaceRemove?.(sideId)
          render()
          showError(new Error(touched?.error || text('side_task_expired')))
        }
      }).catch((error: unknown) => {
        if (revision === activationRevision && navigation === navigationRevision && activeSideId === sideId) showError(error)
      })
    }
  } catch (error) {
    if (revision !== activationRevision || navigation !== navigationRevision) return
    activeSideId = previousSideId && tasks.has(previousSideId) ? previousSideId : null
    if (activeSideId) w().klausSideSurfaceActivate?.(activeSideId)
    else w().klausSideSurfaceClear?.()
    render()
    throw error
  }
}

// Live events stream into the side surface via chat.js's own dispatch. Here we
// only react to turn completion to refresh the tab's title / expiry.
function onEngineEvent(event: { sessionId?: string; type?: string; title?: string } | null) {
  const sid = event?.sessionId
  const title = event?.title
  if (sid && event?.type === 'session_title_updated' && typeof title === 'string' && (tasks.has(sid) || familyRead)) {
    titleUpdates.set(sid, { revision: ++titleRevision, title })
    if (tasks.has(sid)) {
      Object.assign(tasks.get(sid)!, { title, initialTitleIndex: null })
      render()
    }
  }
  if (sid && event?.type === 'user_message') {
    readyParents.add(sid)
    if (sid === parentId) { parentReady = true; render() }
  }
  if (!sid || sid !== activeSideId) return
  if (event?.type === 'done' || event?.type === 'interrupted') {
    refresh(currentId()).catch((error: unknown) => w().showToast?.(String((error as any)?.message || error)))
  }
}

// ── Render (tab descriptors go to the strip; body handled here) ────────
function render() {
  if (!panel) return
  const pending = pendingPanel()
  const pendingActive = pending?.id === activeSideId
  const expired = !!activeSideId && !pendingActive && !tasks.has(activeSideId)
  if (expired) expiredSessionId = activeSideId

  // Hand the family to the strip: one instance tab per live side task,
  // ordered by creation, with the expiry countdown as its badge.
  const ordered = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
  const tabs = ordered.map(task => ({
    id: task.id,
    title: task.initialTitleIndex != null ? defaultTitle(task.initialTitleIndex) : task.title ?? text('side_task_untitled'),
    badge: countdown(task.expiresAt),
  }))
  if (pending) tabs.push({ id: pending.id, title: defaultTitle(pending.titleIndex), badge: '' })
  w().KlausPanelTabs?.syncSideTasks?.(tabs, activeSideId)
  panel.setAttribute('aria-busy', String(!!pendingActive))

  // Body: the shared transcript + composer show when a side task is active;
  // otherwise the expired banner or the empty hint takes their place.
  const hasActive = !!activeSideId && tasks.has(activeSideId)
  if (expiredEl) expiredEl.hidden = !expired
  if (messagesEl) messagesEl.hidden = !hasActive && !pendingActive
  if (composerHost) composerHost.hidden = !hasActive && !pendingActive
  if (emptyEl) {
    emptyEl.hidden = hasActive || pendingActive || expired
    if (!emptyEl.hidden) emptyEl.textContent = addHint()
  }

  // Side-rail entry mirrors the create gate by being PRESENT or ABSENT: the
  // markup ships it hidden and it appears once the parent turn lands. A greyed
  // button plus a tooltip explaining why it cannot be used is noise on a rail
  // this narrow, and the `+` menu reads the same gate to decide whether to list
  // the entry at all, so the two surfaces are never out of step.
  if (newButton) {
    newButton.hidden = !canCreate()
    // Named after the surface, like its `+` menu entry and its tab label: the
    // button itself already reads as "create", so the label doesn't repeat it.
    newButton.setAttribute('aria-label', text('side_task_untitled'))
  }
}

function defaultTitle(index: number) {
  const label = text('side_task_untitled')
  return index === 1 ? label : `${label} ${index}`
}

function addHint() {
  if (!parentId || !parentReady) return text('side_task_empty_hint')
  if (tasks.size >= 8) return text('side_task_limit_hint')
  return text('side_task_untitled')
}

// ── Sync with the main session's side-task family ────────────────────────
async function parentHasUserMessage(sessionId: string): Promise<boolean> {
  if (readyParents.has(sessionId)) return true
  const loaded = w().klausSideTaskHasUserMessage?.(sessionId)
  if (loaded === true) { readyParents.add(sessionId); return true }
  if (loaded === false) return false
  const existing = eligibilityReads.get(sessionId)
  if (existing) return existing
  const request = (async () => {
    const raw = await api.session.history(sessionId)
    const history: Array<{ role?: string }> = Array.isArray(raw) ? raw : (raw?.messages ?? [])
    if (history.some(message => message?.role === 'user')) readyParents.add(sessionId)
    return readyParents.has(sessionId)
  })().finally(() => { if (eligibilityReads.get(sessionId) === request) eligibilityReads.delete(sessionId) })
  eligibilityReads.set(sessionId, request)
  return request
}

function refresh(sessionId: string | null): Promise<void> {
  const reading = refreshFamily(sessionId)
  familyRead = reading
  void reading.then(() => { if (familyRead === reading) familyRead = null }, () => { if (familyRead === reading) familyRead = null })
  return reading
}

async function refreshFamily(sessionId: string | null) {
  const sequence = ++refreshSequence
  const titlesAtStart = titleRevision
  if (!sessionId) {
    parentId = null
    parentReady = false
    tasks.clear()
    familyNavigationRevision = navigationRevision
    if (activeSideId) { activeSideId = null; w().klausSideSurfaceClear?.() }
    render()
    return
  }
  const known = w().getKnownSessionInfo?.(sessionId)
  if (known?.engine && known.engine !== 'klaus' && !tasks.has(sessionId)) {
    parentId = null
    parentReady = false
    tasks.clear()
    familyNavigationRevision = navigationRevision
    if (activeSideId) { activeSideId = null; w().klausSideSurfaceClear?.() }
    render()
    return
  }
  const knownTask = tasks.get(sessionId)
  // A side task is listed by its PARENT id. When the active session is a side
  // task we already track, query its parent's family — never the side task's
  // own id (the backend matches it against no parent and returns empty).
  const listParent = knownTask ? knownTask.parentSessionId : sessionId
  const listed: SideTask[] = await api.session.listSideTasks(listParent)
  if (!Array.isArray(listed)) throw new Error(text('side_task_load_failed'))
  if (sequence !== refreshSequence) return
  const nextParent = listed.find(task => task.id === sessionId)?.parentSessionId || listed[0]?.parentSessionId || (knownTask ? listParent : sessionId)
  const prevParent = parentId
  // Eligibility is monotonic after the first user message. Reuse the transcript
  // store before asking the host for a complete history solely for this gate.
  const ready = await parentHasUserMessage(nextParent)
  if (sequence !== refreshSequence) return
  tasks.clear()
  for (const task of listed) {
    const updated = titleUpdates.get(task.id)
    prepareEphemeralSessionStream(task.id)
    tasks.set(task.id, updated && updated.revision > titlesAtStart ? { ...task, title: updated.title, initialTitleIndex: null } : task)
  }
  for (const id of titleUpdates.keys()) if (!tasks.has(id)) titleUpdates.delete(id)
  parentId = nextParent
  familyNavigationRevision = navigationRevision
  parentReady = ready || readyParents.has(nextParent)
  if (parentId !== prevParent) {
    // The main session (family) changed — the previously-open side task belongs
    // to the old family; reset to the new family instead of mistaking the
    // switch for an expiry.
    expiredSessionId = null
    if ((!activeSideId || !tasks.has(activeSideId)) && activeSideId !== pendingPanel()?.id) {
      activeSideId = null
      w().klausSideSurfaceClear?.()
    }
    // Restore whatever side task was open last time we were on this parent.
    // restoreArtifactsPanelForChatView (in chat.js) already put the panel
    // back in side-chat mode; here we activate the remembered tab so its
    // transcript actually paints.
    const saved = stateBySession.get(sessionId)
    if (!pendingPanel() && saved?.activeSideId && tasks.has(saved.activeSideId)) {
      void setActive(saved.activeSideId).catch(showError)
    }
  } else if (activeSideId && activeSideId !== pendingPanel()?.id && !tasks.has(activeSideId) && panelOpen()) {
    // Same family, but the open side task vanished from the listing: it was
    // closed elsewhere or swept by the idle TTL. Free its slot too so we
    // don't leak a DOM the user can never reach.
    expiredSessionId = activeSideId
    w().klausSideSurfaceRemove?.(activeSideId)
  }
  render()
}

// ── Wiring ────────────────────────────────────────────────────────────────
newButton?.addEventListener('click', () => openFromRail().catch(showError))
recreateBtn?.addEventListener('click', () => create().catch(showError))

window.addEventListener('klaus:session-change', (event) => {
  // Snapshot the outgoing session's state so switching back later can
  // restore the same side tab / panel visibility. Must run BEFORE refresh
  // resets activeSideId / tasks for the new family.
  if (parentId) saveStateFor(parentId)
  const revision = ++navigationRevision
  const sessionId = (event as CustomEvent).detail?.sessionId ?? null
  cancelPending()
  activeSideId = null
  w().klausSideSurfaceClear?.()
  void refresh(sessionId).catch(error => {
    if (revision === navigationRevision && sessionId === currentId()) showError(error)
  })
})
// The rail button's label/tooltip is written from JS, so the DOM walk in
// applyI18n cannot reach it: without this it kept the previous language's
// wording until the next unrelated render.
window.addEventListener('klaus:lang-change', () => render())
window.setInterval(() => {
  if (panelOpen()) render()
  const now = Date.now()
  if (
    expiryRefreshPending
    || now < nextExpiryRefreshAt
    || ![...tasks.values()].some((task) => task.expiresAt && task.expiresAt <= now)
  ) {
    return
  }
  expiryRefreshPending = true
  nextExpiryRefreshAt = now + 5_000
  refresh(currentId())
    .catch(showError)
    .finally(() => { expiryRefreshPending = false })
}, 1000)

;(window as any).KlausSideTasks = {
  find,
  refresh,
  onEngineEvent,
  openFromRail,
  getActiveSideId: () => (activeSideId && tasks.has(activeSideId) ? activeSideId : null),
  // The strip renders the `+` menu; whether a side-task entry belongs in it at
  // all, and what creating one does, live here.
  canCreate,
  create,
  // Called by the strip when a side-task tab is clicked or closed.
  activateById: async (sideId: string) => {
    if (pendingPanel()?.id === sideId) { w().openArtifactsPanel?.('side-chat'); return }
    if (!tasks.has(sideId)) return
    cancelPending()
    w().openArtifactsPanel?.('side-chat')
    await setActive(sideId)
  },
  // A queued request always starts in a fresh side conversation with the same parent context.
  createForQueued: async (sourceSessionId: string): Promise<string | null> => {
    if (sourceSessionId !== currentId()) return null
    const navigation = navigationRevision
    await (familyRead ?? refresh(sourceSessionId))
    if (sourceSessionId !== currentId() || navigation !== navigationRevision || creation) return null
    const sideId = await create()
    return sourceSessionId === currentId() && navigation === navigationRevision ? sideId : null
  },
  // Reuse a visible side tab in panel/strip order before starting another fork.
  askWithSelection: async (text: string): Promise<boolean> => {
    text = text.trim()
    if (!text) return false
    const sessionId = currentId()
    const navigation = navigationRevision
    if (!pendingPanel() && familyNavigationRevision !== navigation) {
      await (familyRead ?? refresh(sessionId))
      if (sessionId !== currentId() || navigation !== navigationRevision) return false
    }
    const pending = pendingPanel()
    const panels: SideTaskQuotePanel[] = w().KlausPanelTabs?.sideTaskQuotePanels?.() || []
    const existing = selectSideTaskQuoteTarget(panels, id => {
      if (pending?.id === id) return true
      const task = tasks.get(id)
      return familyNavigationRevision === navigation && !!task && (task.sideTaskStatus == null || task.sideTaskStatus === 'active')
    })
    let target: string | null = null
    if (existing && pending?.id === existing) {
      w().openArtifactsPanel?.('side-chat')
      activeSideId = existing
      w().klausSideComposerPrepare?.(pending.id, pending.sessionId)
      render()
      w().klausSideComposerAddSelection?.(text)
      // The pending draft owns the quote while its opening/fork resolves.
      await pending.promise
      return sessionId === currentId() && navigation === navigationRevision
        && !pending.cancelled && !!pending.resolvedSideId && activeSideId === pending.resolvedSideId
        && tasks.has(activeSideId) && w().klausSideSurfaceSessionId?.() === activeSideId && panelOpen()
    } else if (existing) {
      cancelPending()
      w().openArtifactsPanel?.('side-chat')
      await setActive(existing)
      target = existing
    } else if (canCreate() || (creation && requestIsCurrent(creation))) {
      const created = create()
      // The client draft exists synchronously; quoting does not wait for the fork.
      if (pendingPanel()?.id === activeSideId) {
        w().klausSideComposerAddSelection?.(text)
        target = await created
        return !!target && sessionId === currentId() && navigation === navigationRevision && activeSideId === target
          && w().klausSideSurfaceSessionId?.() === target && panelOpen()
      }
      target = await created
    } else {
      return false
    }
    if (!target || sessionId !== currentId() || navigation !== navigationRevision || activeSideId !== target
      || !tasks.has(target) || w().klausSideSurfaceSessionId?.() !== target || !panelOpen()) return false
    w().klausSideComposerAddSelection?.(text)
    return true
  },
  closeById: async (sideId: string) => {
    const pending = pendingPanel()
    if (pending?.id === sideId) {
      const previous = pending.previousSideId
      cancelPending()
      if (previous && tasks.has(previous)) await setActive(previous)
      else exitPanel()
      return
    }
    const task = tasks.get(sideId)
    if (!task) return
    await close(task)
  },
  // Promote a side task to a standalone session: fork its transcript, then
  // discard the temporary task. The fork path surfaces its own error, so a
  // failed conversion leaves the side task untouched instead of losing it.
  convertToSession: async (sideId: string) => {
    if (!tasks.has(sideId)) return
    const forked = await w().klausForkSession?.(sideId)
    if (!forked) return
    const closed = await closeSideTask(sideId)
    if (closed?.ok !== true) throw new Error(closed?.error || text('side_task_close_failed'))
    tasks.delete(sideId)
    if (activeSideId === sideId) activeSideId = null
    w().klausSideSurfaceRemove?.(sideId)
    render()
  },
  // Consulted synchronously by chat.js's restoreArtifactsPanelForChatView so
  // the panel keeps its side-chat mode across session switches instead of
  // snapping back to 'monitor' every time.
  wasSideChatOpenFor: (sessionId: string) => !!stateBySession.get(sessionId)?.wasOpen,
}
