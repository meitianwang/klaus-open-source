const HOST_NAME = 'com.klaus.chromeextension'
const DEBUGGER_PROTOCOL_VERSION = '1.3'
const NATIVE_RECONNECT_ALARM = `native-transport-reconnect:${HOST_NAME}`
const CLIENT_HEARTBEAT_ALARM = 'client-heartbeat-alarm'
const BUILD_CHECK_ALARM = 'extension-build-check'
const BUILD_MARKER_FILE = 'klaus-build.json'
let loadedBuildMarker = null
const STORAGE_TAB_GROUPS_KEY = 'TAB_GROUPS'
const BORROWED_TABS_KEY = 'KLAUS_BORROWED_TABS'
const PENDING_UPDATE_KEY = 'KLAUS_PENDING_EXTENSION_UPDATE'
const DEFAULT_SESSION_TITLE = 'Klaus'
const DELIVERABLE_GROUP_TITLE = '✅ Klaus'
const DEFAULT_TAB_GROUP_COLOR = 'blue'
const TAB_GROUP_COLORS = ['grey', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']
const VALID_TAB_GROUP_COLORS = new Set([DEFAULT_TAB_GROUP_COLOR, ...TAB_GROUP_COLORS])
const RECONNECT_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000
const CONTENT_SCRIPT_TIMEOUT_MS = 1_000
const CURSOR_ARRIVAL_TIMEOUT_MS = 1_500
const MAX_USER_TABS = 1_000

let nativePort = null
let reconnectTimeoutId = null
let reconnectAttempt = 0
let nativeStatus = {
  state: 'disconnected',
  hostName: HOST_NAME,
  lastChecked: Date.now(),
  reconnectAttempt: 0,
}
let nextNativeRequestId = 1
const pendingNativeRequests = new Map()

const sessions = new Map()
const tabSessions = new Map()
const borrowedTabs = new Map()
const borrowedClaimLocks = new Map()
let borrowedTabsReady
const attachedTargets = new Set()
const targetLocks = new Map()
const flatSessionOwners = new Map()
const activeTabIds = new Set()
const activeTabIdByWindowId = new Map()
const contentScriptPrepareByTabId = new Map()
const cursorArrivalWaiters = new Map()
const downloadFilenamesById = new Map()
const downloadUrlsById = new Map()
const ownedDownloads = new Map()
const ownedMediaTransfers = new Map()
let nextCursorMoveSequence = 1
let activeTabsInitialized = false

const tabGroups = {
  initialized: false,
  sessionGroups: new Map(),
  sessionGroupTitles: new Map(),
  groupMetadata: new Map(),
  deliverableGroupId: null,
}

initialize().catch(error => {
  console.error('[klaus-chrome-extension] startup failed:', normalizeError(error))
})

async function initialize() {
  connectNative()
  registerRuntimeListeners()
  registerUpdateLifecycle()
  void captureLoadedBuildMarker()
  ensureAlarm(BUILD_CHECK_ALARM, 30).catch(() => {})
  registerDebuggerListeners()
  registerDownloadListeners()
  registerActiveTabListeners()
  await ensureExtensionInstanceId()
  await initializeTabGroups()
  await refreshActiveTabs()
  await ensureAlarm(CLIENT_HEARTBEAT_ALARM, 0.5)
}

function registerRuntimeListeners() {
  chrome.runtime.onInstalled.addListener(() => {
    ensureExtensionInstanceId(true).catch(() => {})
  })

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'GET_NATIVE_HOST_STATUS') {
      const status = refreshNativeStatus()
      sendResponse({ ok: status.state === 'connected', status, error: status.error })
      return true
    }

    if (message?.type === 'GET_AGENT_CURSOR_STATE') {
      const tabId = sender.tab?.id
      sendResponse({ ok: true, state: readCursorOverlayState(Number.isInteger(tabId) ? tabId : -1) })
      return true
    }

    if (message?.type === 'AGENT_CURSOR_ARRIVED') {
      const tabId = sender.tab?.id
      if (
        Number.isInteger(tabId) &&
        typeof message.sessionId === 'string' &&
        typeof message.turnId === 'string' &&
        Number.isInteger(message.moveSequence)
      ) {
        const key = cursorArrivalKey(message.sessionId, message.turnId, message.moveSequence)
        cursorArrivalWaiters.get(key)?.()
        sendResponse({ ok: true })
      } else {
        sendResponse({ ok: false })
      }
      return true
    }

    return false
  })

  chrome.alarms?.onAlarm?.addListener?.(alarm => {
    if (alarm.name === NATIVE_RECONNECT_ALARM) {
      if (nativePort) {
        clearAlarm(NATIVE_RECONNECT_ALARM)
      } else {
        runReconnectAttempt()
      }
      return
    }

    if (alarm.name === CLIENT_HEARTBEAT_ALARM) {
      heartbeatNativeHost().catch(() => {})
    }

    if (alarm.name === BUILD_CHECK_ALARM) {
      checkDeployedBuildUpdate().catch(() => {})
      applyPendingExtensionUpdate().catch(() => {})
    }
  })
}

function registerUpdateLifecycle() {
  chrome.runtime.onUpdateAvailable?.addListener?.(details => {
    deferExtensionReload(details?.version).catch(error => {
      console.warn('[klaus-chrome-extension] failed to stage update:', normalizeError(error))
    })
  })

  chrome.runtime.onStartup?.addListener?.(() => {
    applyPendingExtensionUpdate().catch(() => {})
  })
}

async function deferExtensionReload(version) {
  if (!chrome.storage?.session) {
    if (!isBrowserControlActive()) chrome.runtime.reload()
    return
  }
  await chrome.storage.session.set({ [PENDING_UPDATE_KEY]: typeof version === 'string' && version ? version : 'pending' })
  await applyPendingExtensionUpdate()
}

async function applyPendingExtensionUpdate() {
  if (isBrowserControlActive() || !chrome.storage?.session) return false
  const stored = await chrome.storage.session.get(PENDING_UPDATE_KEY).catch(() => null)
  if (!stored?.[PENDING_UPDATE_KEY]) return false
  await chrome.storage.session.remove(PENDING_UPDATE_KEY).catch(() => {})
  chrome.runtime.reload()
  return true
}

async function readDeployedBuildMarker() {
  try {
    const response = await fetch(chrome.runtime.getURL(BUILD_MARKER_FILE), { cache: 'no-store' })
    if (!response.ok) return null
    const record = await response.json()
    return typeof record?.build === 'string' && record.build ? record.build : null
  } catch { return null }
}

async function captureLoadedBuildMarker() {
  loadedBuildMarker = await readDeployedBuildMarker()
}

// An unpacked install keeps serving the build that was on disk when this
// worker started. The host refreshes the deployed copy on its own schedule,
// so poll the marker and take the new build over at the next idle moment.
async function checkDeployedBuildUpdate() {
  const onDisk = await readDeployedBuildMarker()
  if (!onDisk || loadedBuildMarker === null || onDisk === loadedBuildMarker) return
  if (!isBrowserControlActive()) {
    chrome.runtime.reload()
    return
  }
  await chrome.storage?.session?.set?.({ [PENDING_UPDATE_KEY]: `build:${onDisk}` }).catch?.(() => {})
}

async function reloadExtensionOnRequest() {
  if (!isBrowserControlActive()) {
    chrome.runtime.reload()
    return {}
  }
  await chrome.storage?.session?.set?.({ [PENDING_UPDATE_KEY]: 'pending' }).catch?.(() => {})
  return { deferred: true }
}

function registerDebuggerListeners() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (Number.isInteger(source?.tabId) && method === 'Target.attachedToTarget' && params?.targetInfo?.type === 'iframe' && typeof params.sessionId === 'string') {
      flatSessionOwners.set(params.sessionId, { tabId: source.tabId, parentSessionId: source.sessionId || null })
    } else if (method === 'Target.detachedFromTarget') {
      forgetFlatSession(params?.sessionId)
    }
    postNative({
      jsonrpc: '2.0',
      method: 'onCDPEvent',
      params: { source, method, params: params || {} },
    })
  })

  chrome.debugger.onDetach.addListener(source => {
    if (Number.isInteger(source?.tabId)) {
      attachedTargets.delete(targetKey({ tabId: source.tabId }))
      for (const [id, owner] of flatSessionOwners) if (owner.tabId === source.tabId) flatSessionOwners.delete(id)
    }
    if (typeof source?.targetId === 'string') attachedTargets.delete(targetKey({ targetId: source.targetId }))
  })
}

function registerDownloadListeners() {
  chrome.downloads?.onCreated?.addListener?.(item => {
    if (!isBrowserControlActive() || !isValidDownloadId(item.id)) return
    const url = typeof item.finalUrl === 'string' ? item.finalUrl : item.url
    // A fresh download usually has no filename yet; that is not a reason to keep
    // quiet about it starting.
    if (typeof item.filename === 'string' && item.filename) {
      downloadFilenamesById.set(item.id, item.filename)
    }
    if (typeof url === 'string') downloadUrlsById.set(item.id, url)
    emitDownloadChange({
      id: String(item.id),
      ...(typeof item.filename === 'string' && item.filename ? { filename: item.filename } : {}),
      ...(typeof url === 'string' ? { url } : {}),
      status: 'started',
    })
  })

  chrome.downloads?.onChanged?.addListener?.(delta => {
    if (!isValidDownloadId(delta.id)) return
    const named = typeof delta.filename?.current === 'string' && delta.filename.current
      ? delta.filename.current
      : downloadFilenamesById.get(delta.id)
    if (named) downloadFilenamesById.set(delta.id, named)
    const url = downloadUrlsById.get(delta.id)
    const status = downloadStatus(delta)
    if (!status) return
    // The STATUS is the point; the filename is a courtesy. Requiring one dropped
    // every change for a download whose name Chrome had not settled yet — which is
    // the normal state of a download that fails early, since `onCreated` reports an
    // empty filename. The waiter then saw nothing at all and reported a timeout
    // instead of the failure that had happened.
    emitDownloadChange({
      id: String(delta.id),
      ...(named ? { filename: named } : {}),
      ...(url ? { url } : {}),
      status,
    })
  })
}

function registerActiveTabListeners() {
  chrome.tabs.onActivated?.addListener?.(event => {
    setWindowActiveTab(event.windowId, event.tabId)
    emitTabsChanged('activated', event.tabId)
  })
  chrome.tabs.onCreated?.addListener?.(tab => {
    if (tab.active === true && Number.isInteger(tab.id) && Number.isInteger(tab.windowId)) {
      setWindowActiveTab(tab.windowId, tab.id)
    }
    emitTabsChanged('created', tab.id)
  })
  chrome.tabs.onUpdated?.addListener?.((tabId, changes) => {
    if (['title', 'url', 'favIconUrl', 'status'].some(key => key in changes)) emitTabsChanged('updated', tabId)
  })
  chrome.tabs.onRemoved?.addListener?.(tabId => {
    emitTabsChanged('removed', tabId)
    if (borrowedTabs.delete(tabId)) saveBorrowedTabs().catch(() => {})
    for (const [id, download] of ownedDownloads) if (download.tabId === tabId) {
      ownedDownloads.delete(id)
      chrome.downloads.cancel(id).catch(() => {})
    }
    for (const [key, owner] of ownedMediaTransfers) if (owner.tabId === tabId) ownedMediaTransfers.delete(key)
    for (const [id, owner] of flatSessionOwners) if (owner.tabId === tabId) flatSessionOwners.delete(id)
    attachedTargets.delete(targetKey({ tabId }))
    contentScriptPrepareByTabId.delete(tabId)
    for (const session of sessions.values()) {
      session.tabIds.delete(tabId)
      session.tabOrigins.delete(tabId)
      session.cursorByTabId.delete(tabId)
      if (session.activeTabId === tabId) session.activeTabId = null
    }
    tabSessions.delete(tabId)
    activeTabIds.delete(tabId)
    for (const [windowId, activeTabId] of activeTabIdByWindowId.entries()) {
      if (activeTabId === tabId) activeTabIdByWindowId.delete(windowId)
    }
  })
  chrome.tabs.onReplaced?.addListener?.(tabId => { emitTabsChanged('replaced', tabId); refreshActiveTabs().catch(() => {}) })
  chrome.tabs.onAttached?.addListener?.(() => refreshActiveTabs().catch(() => {}))
  chrome.tabs.onDetached?.addListener?.(() => refreshActiveTabs().catch(() => {}))
  chrome.windows?.onCreated?.addListener?.(() => refreshActiveTabs().catch(() => {}))
  chrome.windows?.onFocusChanged?.addListener?.(() => refreshActiveTabs().catch(() => {}))
  chrome.windows?.onRemoved?.addListener?.(() => refreshActiveTabs().catch(() => {}))
}

function emitTabsChanged(reason, tabId) {
  postNative({ jsonrpc: '2.0', method: 'onTabsChanged', params: { reason, ...(Number.isInteger(tabId) ? { tabId } : {}) } })
}

function connectNative(options = {}) {
  if (nativePort) return true
  let port
  try {
    port = chrome.runtime.connectNative(HOST_NAME)
    checkDeployedBuildUpdate().catch(() => {})
  } catch (error) {
    updateNativeStatus(options.failureState || 'disconnected', { error: normalizeError(error) })
    scheduleReconnect()
    return false
  }

  nativePort = port
  reconnectAttempt = 0
  clearReconnectTimeout()
  clearAlarm(NATIVE_RECONNECT_ALARM)
  updateNativeStatus('connected')
  port.onMessage.addListener(handleNativeMessage)
  port.onDisconnect.addListener(() => {
    if (nativePort !== port) return
    nativePort = null
    for (const owner of [...ownedMediaTransfers.values()]) void cancelPageMedia(owner.sessionId, owner.tabId)
    rejectPendingNativeRequests(chrome.runtime.lastError?.message || 'native host disconnected')
    updateNativeStatus('disconnected', { error: chrome.runtime.lastError?.message })
    scheduleReconnect()
  })
  return true
}

function scheduleReconnect() {
  if (!nativePort) {
    reconnectAttempt += 1
    updateNativeStatus('reconnecting', { error: nativeStatus.error, nextRetryMs: RECONNECT_MS })
    scheduleReconnectTimeout()
    ensureAlarm(NATIVE_RECONNECT_ALARM, 0.5).catch(() => {})
  }
}

function scheduleReconnectTimeout() {
  if (nativePort || reconnectTimeoutId != null) return
  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null
    runReconnectAttempt()
  }, RECONNECT_MS)
}

function clearReconnectTimeout() {
  if (reconnectTimeoutId != null) clearTimeout(reconnectTimeoutId)
  reconnectTimeoutId = null
}

function runReconnectAttempt() {
  if (nativePort) return
  clearReconnectTimeout()
  reconnectAttempt += 1
  if (!connectNative({ failureState: 'reconnecting' })) scheduleReconnectTimeout()
}

function refreshNativeStatus() {
  updateNativeStatus(nativePort ? 'connected' : nativeStatus.state, {
    error: nativeStatus.error,
    nextRetryMs: nativeStatus.nextRetryMs,
  })
  return { ...nativeStatus }
}

function updateNativeStatus(state, extra = {}) {
  nativeStatus = {
    state,
    hostName: HOST_NAME,
    lastChecked: Date.now(),
    reconnectAttempt,
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.nextRetryMs ? { nextRetryMs: extra.nextRetryMs } : {}),
  }
  chrome.storage?.local?.set?.({ NATIVE_HOST_STATUS: nativeStatus }).catch?.(() => {})
}

function postNative(message) {
  try {
    if (!nativePort) throw new Error('Native transport is disconnected; reconnect is pending')
    nativePort.postMessage(message)
  } catch {
    nativePort = null
    scheduleReconnect()
  }
}

function requestNative(method, params, timeoutMs = 3_000) {
  if (!nativePort) {
    scheduleReconnect()
    return Promise.reject(new Error('Native transport is disconnected; reconnect is pending'))
  }
  const id = nextNativeRequestId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingNativeRequests.delete(id)
      reject(new Error(`Timed out waiting for native host method ${method}.`))
    }, timeoutMs)
    pendingNativeRequests.set(id, { resolve, reject, timer })
    try {
      nativePort.postMessage({ jsonrpc: '2.0', id, method, params })
    } catch (error) {
      clearTimeout(timer)
      pendingNativeRequests.delete(id)
      reject(error)
      nativePort = null
      scheduleReconnect()
    }
  })
}

function rejectPendingNativeRequests(message) {
  for (const pending of pendingNativeRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error(message))
  }
  pendingNativeRequests.clear()
}

function handleNativeMessage(message) {
  if (!message || typeof message !== 'object') return

  if (typeof message.id === 'number' && !('method' in message) && pendingNativeRequests.has(message.id)) {
    const pending = pendingNativeRequests.get(message.id)
    pendingNativeRequests.delete(message.id)
    clearTimeout(pending.timer)
    if ('error' in message) pending.reject(new Error(message.error?.message || 'Native host request failed'))
    else pending.resolve(message.result)
    return
  }

  if (typeof message.id !== 'number' && typeof message.method === 'string') {
    handleNativeNotification(message.method, message.params || {})
    return
  }

  if (typeof message.id !== 'number' || typeof message.method !== 'string') return

  handleNativeRequest(message.id, message.method, message.params || {})
}

async function handleNativeRequest(id, method, params) {
  const requestSession = startRequest(method, params)
  try {
    const result = await dispatch(method, params)
    postNative({ jsonrpc: '2.0', id, result })
  } catch (error) {
    postNative({
      jsonrpc: '2.0',
      id,
      error: {
        code: 1,
        message: normalizeError(error),
      },
    })
  } finally {
    finishRequest(requestSession)
    applyPendingExtensionUpdate().catch(() => {})
  }
}

function handleNativeNotification(method, params) {
  switch (method) {
    case 'moveMouse':
      moveMouse(params).catch(error => {
        console.warn('[klaus-chrome-extension] moveMouse notification failed:', normalizeError(error))
      })
      break
    case 'turnEnded':
      turnEnded(params).catch(() => {})
      break
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'ping':
      return 'pong'
    case 'getInfo':
      return getInfo()
    case 'getTabs':
      return getTabs(params)
    case 'focusTab':
      return focusTab(params)
    case 'getUserTabs':
      resolveSession(params)
      return getUserTabs(params)
    case 'createTab':
      return createTab(params)
    case 'discardCreatedTab':
      return discardCreatedTab(params)
    case 'claimUserTab':
      return claimUserTab(params)
    case 'finalizeTabs':
      return finalizeTabs(params)
    case 'nameSession':
      return nameSession(params)
    case 'getUserHistory':
      resolveSession(params)
      return getUserHistory(params)
    case 'managementCall':
      resolveSession(params)
      return managementCall(params)
    case 'managementAuditTrail':
      resolveSession(params)
      return managementAuditTrail()
    case 'download':
      return downloadForSession(params)
    case 'getDownload':
      return getOwnedDownload(params)
    case 'listDownloads':
      return listOwnedDownloads(params)
    case 'registerMediaTransfer':
      return registerMediaTransfer(params)
    case 'releaseMediaTransfer':
      return releaseMediaTransfer(params)
    case 'cancelDownload':
      return cancelOwnedDownload(params)
    case 'reloadExtension':
      return reloadExtensionOnRequest()
    case 'attach':
      return attach(params)
    case 'detach':
      return detach(params)
    case 'attachTarget':
      return attachTarget(params)
    case 'detachTarget':
      return detachTarget(params)
    case 'executeCdp':
      return executeCdp(params)
    case 'executeBrowserPermissionCdp':
      resolveSession(params)
      return executeBrowserPermissionCdp(params)
    case 'executeUnhandledCommand':
      resolveSession(params)
      throw new Error(`Chrome does not support command "${String(params?.type || 'unknown')}".`)
    case 'moveMouse':
      return moveMouse(params)
    case 'turnEnded':
      return turnEnded(params)
    default:
      throw new Error(`Unsupported Klaus Chrome native request: ${method}`)
  }
}

async function getInfo() {
  const extensionInstanceId = await ensureExtensionInstanceId()
  return {
    name: 'Chrome',
    version: chrome.runtime.getManifest().version,
    type: 'extension',
    metadata: {
      extensionId: chrome.runtime.id,
      extensionInstanceId,
      extensionHostName: HOST_NAME,
      buildMarker: loadedBuildMarker,
      controlActive: isBrowserControlActive(),
      fileSchemeAccessAllowed: typeof chrome.extension?.isAllowedFileSchemeAccess === 'function' ? await chrome.extension.isAllowedFileSchemeAccess() : null,
      capabilities: ['task_downloads', 'flat_cdp_sessions', 'tab_mentions_v1', 'browser_management'],
    },
  }
}

async function getTabs(params) {
  const session = resolveSession(params)
  const tabs = await listSessionTabs(session)
  return Promise.all(tabsWithLogicalActive(session, tabs).map(async tab => ({ ...tab, zoomFactor: await chrome.tabs.getZoom(tab.id) })))
}

async function focusTab(params) {
  const session = resolveSession(params)
  const tabId = numericTabId(params.tabId)
  // A preview is a reference to an already owned tab, never permission to claim
  // a user's tab or a different task's page. Restore only durable group ownership.
  if (!session.tabIds.has(tabId) && !(await restoreSessionTabFromGroup(session, tabId))) {
    throw new Error(`Tab ${tabId} is not part of browser session ${session.sessionId}`)
  }
  const tab = await chrome.tabs.get(tabId)
  if (!tabHasId(tab) || !Number.isInteger(tab.windowId)) {
    throw new Error(`Chrome tab ${tabId} no longer has a window`)
  }
  if (Number.isInteger(tab.groupId) && tab.groupId !== -1) {
    const owner = await getSessionIdForChromeGroup(tab.groupId)
    if (owner && owner !== session.sessionId) {
      throw new Error(`Tab ${tabId} now belongs to browser session ${owner}`)
    }
  }
  const activated = await chrome.tabs.update(tabId, { active: true })
  if (activated?.id !== tabId || activated.active !== true || !Number.isInteger(activated.windowId)) {
    throw new Error(`Chrome did not activate tab ${tabId}`)
  }
  const window = await chrome.windows.update(activated.windowId, { focused: true })
  if (window?.focused !== true) throw new Error(`Chrome did not focus tab ${tabId}'s window`)
  session.activeTabId = tabId
  return true
}

async function getUserTabs(params = {}) {
  const terms = String(params.query || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const limit = Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, MAX_USER_TABS) : MAX_USER_TABS
  const tabs = (await chrome.tabs.query({}))
    .filter(tabHasId)
    .filter(tab => params.tabId === undefined || tab.id === params.tabId)
    .filter(tab => params.includeFavicons !== true || /^https?:\/\//i.test(tab.url || ''))
    .filter(tab => terms.every(term => `${tab.title || ''} ${tab.url || ''}`.toLowerCase().includes(term)))
    .sort((a, b) => lastAccessed(b) - lastAccessed(a) || (a.windowId ?? 0) - (b.windowId ?? 0) || (a.index ?? 0) - (b.index ?? 0))
    .slice(0, limit)
  const groupTitles = await tabGroupTitles(tabs)
  return Promise.all(tabs.map(async tab => ({ ...normalizeTab(tab, groupTitles),
    ...(params.includeFavicons === true ? { faviconUrl: await tabFavicon(tab) } : {}) })))
}

const tabFaviconCache = new Map()
async function tabFavicon(tab) {
  if (!tab.url || !tab.favIconUrl) return null
  const key = `${tab.url}\n${tab.favIconUrl}`
  if (tabFaviconCache.has(key)) return tabFaviconCache.get(key)
  try {
    // Read Chromium's local favicon cache; never fetch the website from the picker.
    const address = new URL(chrome.runtime.getURL('_favicon/'))
    address.searchParams.set('pageUrl', tab.url)
    address.searchParams.set('size', '16')
    const response = await fetch(address.href, { signal: AbortSignal.timeout(1000) })
    const mime = response.headers.get('content-type')?.split(';')[0]
    if (!response.ok || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon'].includes(mime)) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > 65536) return null
    const value = `data:${mime};base64,${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}`
    if (tabFaviconCache.size >= 256) tabFaviconCache.delete(tabFaviconCache.keys().next().value)
    tabFaviconCache.set(key, value)
    return value
  } catch { return null }
}

async function createTab(params) {
  const session = resolveSession(params)
  const tab = await createChromeTab()
  session.activeTabId = tab.id
  await ensureSessionTab(session, tab.id, 'agent')
  await requireSessionTab(session, tab.id, { trackOverlay: true })
  // The tab is created in the BACKGROUND on purpose: opening a page to read is
  // not a reason to take over the window the user is looking at. Report what it
  // actually is rather than asserting `active: true` — that claim was wrong, and
  // it hid the fact that pointer input aimed at an unrendered page is discarded.
  // The driver gets input into a background page with `Emulation`/`Page`
  // lifecycle CDP instead, so nothing here has to select the tab.
  return { ...toBasicTab(tab), active: tab.active === true }
}

// Cancellation targets one newly created tab without finalizing its siblings.
async function discardCreatedTab(params) {
  const session = resolveSession(params)
  const tabId = numericTabId(params.tabId)
  if (!session.tabIds.has(tabId) || session.tabOrigins.get(tabId) !== 'agent') {
    throw new Error(`Tab ${tabId} is not an agent-created tab owned by this session`)
  }
  await cancelPageMedia(session.sessionId, tabId)
  for (const [id, download] of ownedDownloads) {
    if (download.sessionId !== session.sessionId || download.tabId !== tabId) continue
    await chrome.downloads.cancel(id).catch(() => {})
    ownedDownloads.delete(id)
  }
  await detachAttachedTabIdsBestEffort([tabId])
  await removeTabs([tabId])
  await untrackTab(session, tabId)
  if (session.activeTabId === tabId) session.activeTabId = session.tabIds.values().next().value ?? null
  await cleanupSessionGroup(session)
  return {}
}

async function claimUserTab(params) {
  const tabId = numericTabId(params.tabId ?? params.tab_id)
  const pending = (borrowedClaimLocks.get(tabId) || Promise.resolve()).catch(() => {}).then(() => claimUserTabLocked(params))
  borrowedClaimLocks.set(tabId, pending)
  try { return await pending }
  finally { if (borrowedClaimLocks.get(tabId) === pending) borrowedClaimLocks.delete(tabId) }
}

async function claimUserTabLocked(params) {
  const session = resolveSession(params)
  const tabId = numericTabId(params.tabId ?? params.tab_id)
  const tab = await chrome.tabs.get(tabId)
  if (!tabHasId(tab)) throw new Error(`Chrome tab ${tabId} has no id`)
  if (tab.url?.startsWith('chrome://')) throw new Error(`Chrome internal tab ${tabId} cannot be claimed`)
  if (params.expectedUrl !== undefined && (tab.url !== params.expectedUrl || (tab.title || tab.url) !== params.expectedTitle)) {
    throw new Error(`Referenced tab ${tabId} changed since it was mentioned; select it again`)
  }
  await initializeBorrowedTabs()
  const owner = borrowedTabs.get(tabId)
  if (owner && owner !== session.sessionId) throw new Error(`Tab ${tabId} is already part of browser session ${owner}`)
  const groupSessionId = Number.isInteger(tab.groupId) && tab.groupId !== -1
    ? await getSessionIdForChromeGroup(tab.groupId)
    : null
  if (groupSessionId && groupSessionId !== session.sessionId) {
    throw new Error(`Tab ${tabId} is already part of browser session ${groupSessionId}`)
  }
  if (groupSessionId === session.sessionId) await restoreSessionTabFromGroup(session, tabId)
  const current = await chrome.tabs.get(tabId)
  if (params.expectedUrl !== undefined && (current.url !== params.expectedUrl || (current.title || current.url) !== params.expectedTitle)) {
    throw new Error(`Referenced tab ${tabId} changed since it was mentioned; select it again`)
  }
  session.activeTabId = tabId
  // Borrowing a human tab keeps its original window, position, and group.
  // chrome.storage.session survives worker suspension but not a browser restart.
  if (!session.tabIds.has(tabId) || session.tabOrigins.get(tabId) !== 'agent') {
    borrowedTabs.set(tabId, session.sessionId)
    await saveBorrowedTabs()
    session.tabIds.add(tabId)
    session.tabOrigins.set(tabId, 'user')
    attachTabSession(tabId, session.sessionId)
  }
  await requireSessionTab(session, tabId, { trackOverlay: true })
  return { ...toBasicTab(tab), active: true }
}

async function finalizeTabs(params) {
  const session = resolveSession(params)
  const tabs = await listSessionTabs(session)
  const keep = parseKeepTabs(params.keep, new Set(tabs.map(tab => tab.id)))
  const handoffTabIds = []
  const deliverableTabIds = []
  const agentTabIds = []
  const userTabIds = []

  for (const tab of tabs) {
    const status = keep.get(tab.id)
    if (status === 'handoff') {
      handoffTabIds.push(tab.id)
      continue
    }
    if (status === 'deliverable') {
      deliverableTabIds.push(tab.id)
      continue
    }
    if (session.tabOrigins.get(tab.id) === 'agent') agentTabIds.push(tab.id)
    else userTabIds.push(tab.id)
  }

  const detachedTabIds = [...deliverableTabIds, ...agentTabIds, ...userTabIds]
  // A claimed user tab remains open. Abort only this host's bounded media
  // readers in its frames before relinquishing task ownership and CDP.
  await Promise.all(detachedTabIds.map(tabId => cancelPageMedia(session.sessionId, tabId)))
  for (const [id, download] of ownedDownloads) {
    if (download.sessionId !== session.sessionId || !detachedTabIds.includes(download.tabId)) continue
    await chrome.downloads.cancel(id).catch(() => {})
    ownedDownloads.delete(id)
  }
  await detachAttachedTabIdsBestEffort(detachedTabIds)
  if (deliverableTabIds.length > 0) await moveTabsToDeliverableGroup(deliverableTabIds)
  if (userTabIds.length > 0) await releaseTabsFromSessionGroup(session, userTabIds)
  if (agentTabIds.length > 0) await removeTabs(agentTabIds)

  for (const tabId of detachedTabIds) await untrackTab(session, tabId)
  session.activeTabId = handoffTabIds.includes(session.activeTabId) ? session.activeTabId : handoffTabIds[0] ?? null
  await cleanupSessionGroup(session)
  return {}
}

async function nameSession(params) {
  const session = resolveSession(params)
  const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : DEFAULT_SESSION_TITLE
  session.name = name
  tabGroups.sessionGroupTitles.set(session.sessionId, name)
  await updateSessionGroupPresentation(session).catch(() => {})
  await saveTabGroups().catch(() => {})
  return {}
}

async function getUserHistory(params) {
  const query = nullableString(params.query, '')
  const limit = historyLimit(params.limit ?? params.max_results)
  const queryInfo = { text: query, maxResults: limit, startTime: dateValue(params.from, 'from') ?? 0 }
  const endTime = dateValue(params.to, 'to')
  if (endTime != null) queryInfo.endTime = endTime
  return (await chrome.history.search(queryInfo)).flatMap(item => {
    if (typeof item.url !== 'string' || !Number.isFinite(item.lastVisitTime)) return []
    return [{
      url: item.url,
      ...(item.title ? { title: item.title } : {}),
      dateVisited: new Date(item.lastVisitTime).toISOString(),
    }]
  })
}

// Native download handles belong to one task and one still-owned tab. The host
// never has to infer ownership from a global event URL or a local filename.
async function downloadForSession(params) {
  const session = resolveSession(params)
  const tabId = numericTabId(params.tabId)
  await requireSessionTab(session, tabId)
  if (typeof params.url !== 'string') throw new Error('download requires url')
  const url = new URL(params.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web URLs can be downloaded')
  if ([...ownedDownloads.values()].filter(item => item.sessionId === session.sessionId).length >= 100) throw new Error('This task has reached its download handle limit')
  const filename = params.filename
  if (filename !== undefined && (typeof filename !== 'string' || !filename || filename.trim() !== filename || filename.length > 200 || /[\\/:*?"<>|\u0000-\u001f]/u.test(filename) || /[. ]$/u.test(filename) || /^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(filename))) throw new Error('filename must be a safe basename')
  const timeout = params.timeoutMs ?? 60000
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60000) throw new Error('Invalid download timeoutMs')
  const deadline = Date.now() + timeout
  const id = await chrome.downloads.download({ url: url.href, ...(filename === undefined ? {} : { filename }), saveAs: false, conflictAction: 'uniquify' })
  if (!isValidDownloadId(id)) throw new Error('Chrome did not return a download id')
  if (!session.tabIds.has(tabId) || Date.now() >= deadline) {
    await chrome.downloads.cancel(id).catch(() => {})
    if ((await chrome.downloads.search({ id }))[0]?.state === 'complete') await chrome.downloads.removeFile(id).catch(() => {})
    throw new Error('The download task was released or timed out while starting')
  }
  ownedDownloads.set(id, { sessionId: session.sessionId, tabId })
  return { id: String(id) }
}

async function getOwnedDownload(params) {
  const session = resolveSession(params)
  const id = Number(params.id)
  const owner = ownedDownloads.get(id)
  if (!isValidDownloadId(id) || !owner || owner.sessionId !== session.sessionId || !session.tabIds.has(owner.tabId)) throw new Error('Download does not belong to this active browser task')
  if (params.tabId !== undefined && numericTabId(params.tabId) !== owner.tabId) throw new Error('Download does not belong to this page')
  const item = (await chrome.downloads.search({ id }))[0]
  if (!item) throw new Error('Chrome download no longer exists')
  return { id: String(id), url: item.finalUrl || item.url, originalUrl: item.url, path: item.filename || null, filePath: item.filename || null, filename: item.filename ? item.filename.split(/[\\/]/u).pop() : null, status: item.state === 'complete' ? 'completed' : item.state === 'interrupted' ? item.error === 'USER_CANCELED' ? 'canceled' : 'failed' : 'in_progress', error: item.error || null, bytes: item.bytesReceived }
}

async function listOwnedDownloads(params) {
  const session = resolveSession(params)
  const tabId = numericTabId(params.tabId)
  await requireSessionTab(session, tabId)
  const downloads = []
  for (const [id, owner] of ownedDownloads) {
    if (owner.sessionId === session.sessionId && owner.tabId === tabId) downloads.push(await getOwnedDownload({ ...params, id: String(id) }))
  }
  return { downloads }
}

function mediaTransferKey(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(id)) throw new Error('Invalid media transfer id')
  return '__klausDownload_' + id.replace(/-/gu, '')
}

async function registerMediaTransfer(params) {
  const session = resolveSession(params)
  const tabId = numericTabId(params.tabId)
  await requireSessionTab(session, tabId)
  const key = mediaTransferKey(params.id)
  if (ownedMediaTransfers.has(key)) throw new Error('This media transfer already exists')
  if ([...ownedMediaTransfers.values()].filter(owner => owner.sessionId === session.sessionId).length >= 100) throw new Error('Media transfer limit reached')
  ownedMediaTransfers.set(key, { sessionId: session.sessionId, tabId })
  return { registered: true }
}

async function releaseMediaTransfer(params) {
  const session = resolveSession(params)
  const key = mediaTransferKey(params.id)
  const owner = ownedMediaTransfers.get(key)
  if (!owner) return { released: false }
  if (owner.sessionId !== session.sessionId || owner.tabId !== numericTabId(params.tabId)) throw new Error('Media transfer does not belong to this page')
  ownedMediaTransfers.delete(key)
  return { released: true }
}

async function cancelPageMedia(sessionId, tabId) {
  const keys = []
  for (const [key, owner] of ownedMediaTransfers) if (owner.sessionId === sessionId && owner.tabId === tabId) { keys.push(key); ownedMediaTransfers.delete(key) }
  if (!keys.length) return
  // Exact ids keep a delayed cleanup from touching a later task's transfer.
  await withTimeout(chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN', args: [keys],
    func: keys => {
      for (const key of keys) {
        try { const transfer = globalThis[key]; if (!transfer) continue; transfer.controller?.abort(); transfer.reader?.cancel().catch(() => {}); clearTimeout(transfer.timer); delete globalThis[key] } catch {}
      }
    },
  }), 1000, 'media transfer cleanup').catch(() => {})
}

async function cancelOwnedDownload(params) {
  const current = await getOwnedDownload(params)
  if (current.status === 'in_progress') await chrome.downloads.cancel(Number(current.id))
  return getOwnedDownload(params)
}

async function attach(params) {
  const session = resolveSession(params)
  const tabId = numericTabId(params.tabId ?? params.tab_id)
  await requireSessionTab(session, tabId)
  await attachDebugger({ tabId })
  return {}
}

async function detach(params) {
  const session = resolveSession(params)
  const tabId = numericTabId(params.tabId ?? params.tab_id)
  await requireSessionTab(session, tabId)
  await detachDebugger({ tabId })
  return {}
}

async function attachTarget(params) {
  const target = cdpTarget(params)
  if (Number.isInteger(target.tabId)) {
    const session = resolveSession(params)
    await requireSessionTab(session, target.tabId)
  }
  await attachDebugger(target)
  return {}
}

async function detachTarget(params) {
  const target = cdpTarget(params)
  if (Number.isInteger(target.tabId)) {
    const session = resolveSession(params)
    await requireSessionTab(session, target.tabId)
  }
  await detachDebugger(target)
  return {}
}

async function executeCdp(params) {
  const method = typeof params.method === 'string' ? params.method : ''
  if (!method) throw new Error('executeCdp requires method.')
  if (method === 'Target.getTargets') {
    return { targetInfos: await chrome.debugger.getTargets() }
  }

  const target = cdpTarget(params)
  if (Number.isInteger(target.tabId)) {
    const session = resolveSession(params)
    await requireSessionTab(session, target.tabId)
    if (!attachedTargets.has(targetKey(target))) throw new Error('Debugger unattached')
  }

  try {
    return await withTimeout(
      chrome.debugger.sendCommand(target, method, objectParam(params.commandParams)),
      timeoutMs(params.timeoutMs),
      `CDP command ${method}`,
    )
  } catch (error) {
    if (method === 'DOM.setFileInputFiles' && uploadAccessDenied(error)) {
      throw new Error(`To enable file upload, open chrome://extensions/?id=${chrome.runtime.id} in Chrome, select Details for Klaus, and enable "Allow access to file URLs." Then retry the upload.`)
    }
    // A command that never came back releases the tab: holding a debugger
    // whose last command timed out would leave the page paused and the
    // debugging notice up until the turn ends.
    if (Number.isInteger(target.tabId) && params.preserveDebuggerOnTimeout !== true && isCdpCommandTimeout(error)) {
      await detachDebugger(target).catch(() => {})
    }
    throw error
  }
}

function isCdpCommandTimeout(error) {
  const message = typeof error === 'string' ? error : error && typeof error === 'object' ? error.message : undefined
  return typeof message === 'string' && message.startsWith('Timed out after ') && message.includes(' waiting for CDP command ')
}

function uploadAccessDenied(error) {
  const message = typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? error.message : undefined
  if (message === 'Not allowed') return true
  try {
    const value = typeof message === 'string' ? JSON.parse(message) : message
    return value?.code === -32000 && value?.message === 'Not allowed'
  } catch { return false }
}

async function executeBrowserPermissionCdp(params) {
  const method = typeof params.method === 'string' ? params.method : ''
  const commandParams = objectParam(params.commandParams)
  if (method === 'Browser.grantPermissions') {
    const origin = normalizedPermissionOrigin(commandParams.origin)
    const permissions = Array.isArray(commandParams.permissions) ? commandParams.permissions : []
    return setContentPermissions(origin, permissions, 'allow')
  }
  if (method === 'Browser.setPermission') {
    const origin = normalizedPermissionOrigin(commandParams.origin)
    const permission = commandParams.permission && typeof commandParams.permission === 'object'
      ? commandParams.permission.name
      : commandParams.permission
    const setting = browserPermissionSetting(commandParams.setting)
    return setContentPermissions(origin, [permission], setting)
  }
  if (method === 'Browser.resetPermissions') {
    await clearContentPermissions()
    return {}
  }
  throw new Error(`Unsupported browser permission CDP method: ${method}`)
}

async function setContentPermissions(origin, permissions, setting) {
  if (!chrome.contentSettings) throw new Error('Chrome contentSettings permission is not available. Reload the Klaus Chrome extension.')
  const pattern = contentSettingsPattern(origin)
  const names = permissions.map(contentSettingNameForPermission).filter(Boolean)
  if (!names.length) throw new Error('No supported browser permissions were provided.')
  const applied = await Promise.all(names.map(async name => {
    const api = chrome.contentSettings[name]
    if (!api?.set) throw new Error(`Chrome content setting "${name}" is not available.`)
    await api.set({ primaryPattern: pattern, secondaryPattern: pattern, setting })
    const current = await api.get({ primaryUrl: origin, secondaryUrl: origin }).catch(() => null)
    return { name, pattern, setting, current }
  }))
  return { applied }
}

async function clearContentPermissions() {
  if (!chrome.contentSettings) throw new Error('Chrome contentSettings permission is not available. Reload the Klaus Chrome extension.')
  const names = ['location', 'notifications', 'camera', 'microphone']
  await Promise.all(names.map(name => chrome.contentSettings[name]?.clear?.({ scope: 'regular' }).catch(() => {})))
  return {}
}

function normalizedPermissionOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Browser permission command requires origin.')
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Unsupported browser permission origin: ${value}`)
  return parsed.origin
}

function contentSettingsPattern(origin) {
  const parsed = new URL(origin)
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}/*`
}

function browserPermissionSetting(value) {
  if (value === 'granted' || value === 'allow') return 'allow'
  if (value === 'denied' || value === 'block') return 'block'
  if (value === 'prompt' || value === 'ask') return 'ask'
  throw new Error(`Unsupported browser permission setting: ${String(value)}`)
}

function contentSettingNameForPermission(permission) {
  switch (String(permission || '')) {
    case 'geolocation':
      return 'location'
    case 'notifications':
      return 'notifications'
    case 'camera':
      return 'camera'
    case 'microphone':
      return 'microphone'
    default:
      throw new Error(`Unsupported browser permission: ${String(permission)}`)
  }
}

async function moveMouse(params) {
  const session = resolveSession(params)
  const tabId = numericTabId(params.tabId ?? params.tab_id)
  const x = Number(params.x)
  const y = Number(params.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('moveMouse requires finite x and y coordinates')
  await requireSessionTab(session, tabId, { trackOverlay: true })

  const moveSequence = nextCursorMoveSequence++
  const visible = await isActiveVisibleNormalTab(tabId)
  const waiter = params.waitForArrival !== false && visible
    ? createCursorArrivalWaiter(session.sessionId, session.currentTurnId, moveSequence)
    : null
  const ok = await setCursorState(session, tabId, {
    visible: true,
    x,
    y,
    moveSequence,
    ...(!visible ? { animateMovement: false } : {}),
  })
  if (waiter) {
    if (!ok) waiter.cancel()
    else await waiter.promise
  }
  return {}
}

async function turnEnded(params) {
  const sessionId = requireSessionId(params)
  const turnId = requireTurnId(params)
  const session = sessions.get(sessionId)
  if (session?.currentTurnId === turnId) {
    await detachAttachedTabIdsBestEffort([...session.tabIds])
    session.currentTurnId = null
    await stopSession(session)
    checkDeployedBuildUpdate().catch(() => {})
  }
  return {}
}

function resolveSession(params) {
  const sessionId = requireSessionId(params)
  const turnId = requireTurnId(params)
  let session = sessions.get(sessionId)
  if (!session) {
    session = {
      sessionId,
      currentTurnId: turnId,
      name: tabGroups.sessionGroupTitles.get(sessionId) || DEFAULT_SESSION_TITLE,
      tabIds: new Set(),
      tabOrigins: new Map(),
      cursorByTabId: new Map(),
      activeTabId: null,
      isRunning: false,
      activeRequests: 0,
      abortController: null,
    }
    sessions.set(sessionId, session)
  }
  if (session.currentTurnId !== turnId) session.cursorByTabId.clear()
  session.currentTurnId = turnId
  return session
}

function requireSessionId(params) {
  if (typeof params?.session_id !== 'string' || !params.session_id) throw new Error('Missing required browser session_id')
  return params.session_id
}

function requireTurnId(params) {
  if (typeof params?.turn_id !== 'string' || !params.turn_id) throw new Error('Missing required browser turn_id')
  return params.turn_id
}

async function ensureSessionTab(session, tabId, origin) {
  session.tabIds.add(tabId)
  session.tabOrigins.set(tabId, origin)
  attachTabSession(tabId, session.sessionId)
  await ensureSessionGroup(session, tabId, origin).catch(() => {})
}

async function requireSessionTab(session, tabId, options = {}) {
  if (!session.tabIds.has(tabId)) {
    const restored = await restoreSessionTabFromGroup(session, tabId)
    if (!restored) throw new Error(`Tab ${tabId} is not part of browser session ${session.sessionId}`)
  }
  await startSession(session, { publishTabs: options.trackOverlay === true })
  if (options.trackOverlay === true) await trackTab(session, tabId)
}

async function startSession(session, options = {}) {
  session.isRunning = true
  if (!session.abortController || session.abortController.signal.aborted) session.abortController = new AbortController()
  if (options.publishTabs !== false) await publishSessionTabs(session)
}

async function stopSession(session) {
  if (!session.isRunning) return
  session.isRunning = false
  session.abortController?.abort?.()
  if (session.activeRequests === 0) session.abortController = null
  await publishSessionTabs(session)
}

function isBrowserControlActive() {
  for (const session of sessions.values()) {
    if (session.isRunning || session.activeRequests > 0) return true
  }
  return false
}

function startRequest(method, params) {
  if (method === 'turnEnded') return null
  if (typeof params?.session_id !== 'string' || typeof params?.turn_id !== 'string') return null
  const session = resolveSession(params)
  session.activeRequests += 1
  if (!session.abortController || session.abortController.signal.aborted) session.abortController = new AbortController()
  return session
}

function finishRequest(session) {
  if (!session) return
  session.activeRequests = Math.max(0, session.activeRequests - 1)
  if (session.activeRequests === 0 && !session.isRunning) session.abortController = null
}

function attachTabSession(tabId, sessionId) {
  let sessionIds = tabSessions.get(tabId)
  if (!sessionIds) {
    sessionIds = new Set()
    tabSessions.set(tabId, sessionIds)
  }
  sessionIds.add(sessionId)
}

function initializeBorrowedTabs() {
  if (!borrowedTabsReady) borrowedTabsReady = (async () => {
    const stored = await chrome.storage.session.get(BORROWED_TABS_KEY)
    const value = stored?.[BORROWED_TABS_KEY]
    if (value && typeof value === 'object') for (const [id, owner] of Object.entries(value)) {
      if (Number.isSafeInteger(Number(id)) && Number(id) > 0 && typeof owner === 'string' && owner) borrowedTabs.set(Number(id), owner)
    }
  })()
  return borrowedTabsReady
}

async function saveBorrowedTabs() {
  await chrome.storage.session.set({ [BORROWED_TABS_KEY]: Object.fromEntries(borrowedTabs) })
}

function detachTabSession(tabId, sessionId) {
  const sessionIds = tabSessions.get(tabId)
  if (!sessionIds) return
  sessionIds.delete(sessionId)
  if (sessionIds.size === 0) tabSessions.delete(tabId)
}

function isTabTracked(tabId) {
  return (tabSessions.get(tabId)?.size ?? 0) > 0
}

function getHighestPrioritySessionIdForTab(tabId) {
  const sessionIds = tabSessions.get(tabId)
  if (!sessionIds) return null
  for (const sessionId of sessionIds) {
    if (sessions.get(sessionId)?.isRunning) return sessionId
  }
  return null
}

async function trackTab(session, tabId) {
  session.tabIds.add(tabId)
  attachTabSession(tabId, session.sessionId)
  await publishTabState(tabId)
}

async function untrackTab(session, tabId) {
  if (borrowedTabs.get(tabId) === session.sessionId) { borrowedTabs.delete(tabId); await saveBorrowedTabs() }
  session.tabIds.delete(tabId)
  session.tabOrigins.delete(tabId)
  session.cursorByTabId.delete(tabId)
  if (session.activeTabId === tabId) session.activeTabId = null
  detachTabSession(tabId, session.sessionId)
  await publishTabState(tabId)
}

async function listSessionTabs(session) {
  const tabIds = await getSessionGroupTabIds(session)
  for (const tabId of tabIds) {
    session.tabIds.add(tabId)
    if (!session.tabOrigins.has(tabId)) session.tabOrigins.set(tabId, recoveredTabOrigin(session, tabId))
    attachTabSession(tabId, session.sessionId)
  }

  const tabs = []
  for (const tabId of session.tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tabHasId(tab) && !tab.url?.startsWith('chrome://')) tabs.push(tab)
    } catch {
      if (borrowedTabs.get(tabId) === session.sessionId) { borrowedTabs.delete(tabId); await saveBorrowedTabs() }
      session.tabIds.delete(tabId)
      session.tabOrigins.delete(tabId)
      detachTabSession(tabId, session.sessionId)
    }
  }

  if (tabs.length === 0) await cleanupSessionGroup(session)
  return tabs.map(toBasicTab)
}

function tabsWithLogicalActive(session, tabs) {
  const activeId = resolveLogicalActiveTabId(session, tabs)
  return tabs.map(tab => ({ ...tab, active: activeId == null ? tab.active === true : tab.id === activeId }))
}

function resolveLogicalActiveTabId(session, tabs) {
  if (tabs.length === 0) return null
  if (session.activeTabId != null && tabs.some(tab => tab.id === session.activeTabId)) return session.activeTabId
  const active = tabs.find(tab => tab.active)?.id ?? tabs[0]?.id ?? null
  session.activeTabId = active
  return active
}

async function createChromeTab() {
  const windowId = await focusedNormalWindowId()
  const tab = windowId == null
    ? await createChromeWindowTab()
    : await chrome.tabs.create({ active: false, url: 'about:blank', windowId })
  if (!tabHasId(tab)) throw new Error('Created tab has no id')
  return tab
}

async function focusedNormalWindowId() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })
  const focused = windows.find(item => item.focused && item.id != null)
  return focused?.id ?? windows.find(item => item.id != null)?.id ?? null
}

async function createChromeWindowTab() {
  const window = await chrome.windows.create({ focused: false, type: 'normal', url: 'about:blank' })
  const tab = window?.tabs?.find(tabHasId)
  if (tab) return tab
  if (window?.id == null) throw new Error('Created Chrome window has no id')
  const created = await chrome.tabs.create({ active: false, url: 'about:blank', windowId: window.id })
  if (!tabHasId(created)) throw new Error('Created tab has no id')
  return created
}

async function initializeTabGroups() {
  if (tabGroups.initialized) return
  tabGroups.initialized = true
  const stored = await chrome.storage?.local?.get?.(STORAGE_TAB_GROUPS_KEY).catch(() => null)
  const value = stored?.[STORAGE_TAB_GROUPS_KEY]
  if (value && typeof value === 'object') {
    tabGroups.sessionGroups = new Map(Object.entries(value.sessionGroups || {}).map(([key, groupId]) => [key, Number(groupId)]).filter(([, groupId]) => Number.isInteger(groupId)))
    tabGroups.sessionGroupTitles = new Map(Object.entries(value.sessionGroupTitles || {}).filter(([, title]) => typeof title === 'string'))
    tabGroups.deliverableGroupId = Number.isInteger(value.deliverableGroupId) ? value.deliverableGroupId : null
    for (const item of Array.isArray(value.groups) ? value.groups : []) {
      if (item && Number.isInteger(item.chromeGroupId)) tabGroups.groupMetadata.set(item.chromeGroupId, normalizeGroupMetadata(item))
    }
  }
  registerTabGroupListeners()
  await reconcileAllGroupPresentations()
}

function registerTabGroupListeners() {
  chrome.tabGroups?.onCreated?.addListener?.(group => {
    if (Number.isInteger(group?.id)) reconcileGroupPresentation(group.id, group).catch(() => {})
  })
  chrome.tabGroups?.onUpdated?.addListener?.(group => {
    if (Number.isInteger(group?.id)) reconcileGroupPresentation(group.id, group).catch(() => {})
  })
  chrome.tabGroups?.onRemoved?.addListener?.(groupId => {
    tabGroups.groupMetadata.delete(groupId)
    if (tabGroups.deliverableGroupId === groupId) tabGroups.deliverableGroupId = null
    for (const [sessionId, chromeGroupId] of tabGroups.sessionGroups.entries()) {
      if (chromeGroupId === groupId) tabGroups.sessionGroups.delete(sessionId)
    }
    saveTabGroups().catch(() => {})
  })
}

async function ensureSessionGroup(session, tabId, origin) {
  if (!chrome.tabs.group || !chrome.tabGroups?.update) return
  await initializeTabGroups()
  let groupId = tabGroups.sessionGroups.get(session.sessionId)
  let metadata = Number.isInteger(groupId) ? tabGroups.groupMetadata.get(groupId) : null
  if (!metadata || !(await readGroup(metadata.chromeGroupId))) {
    if (Number.isInteger(groupId)) tabGroups.groupMetadata.delete(groupId)
    groupId = await chrome.tabs.group({ tabIds: [tabId] })
    metadata = normalizeGroupMetadata({
      chromeGroupId: groupId,
      mainTabId: tabId,
      secondaryTabIds: [],
      title: session.name,
      createdAt: Date.now(),
      presentationColor: randomTabGroupColor(),
      tabOrigins: { [tabId]: origin },
    })
    tabGroups.sessionGroups.set(session.sessionId, groupId)
    tabGroups.groupMetadata.set(groupId, metadata)
  } else {
    await addTabToGroup(metadata.chromeGroupId, tabId)
    metadata.tabOrigins[String(tabId)] = origin
  }
  await updateSessionGroupPresentation(session)
  await saveTabGroups()
}

async function restoreSessionTabFromGroup(session, tabId) {
  await initializeBorrowedTabs()
  if (borrowedTabs.get(tabId) === session.sessionId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tabHasId(tab)) { borrowedTabs.delete(tabId); await saveBorrowedTabs(); return false }
    session.tabIds.add(tabId)
    session.tabOrigins.set(tabId, 'user')
    attachTabSession(tabId, session.sessionId)
    return true
  }
  await initializeTabGroups()
  const groupId = tabGroups.sessionGroups.get(session.sessionId)
  if (!Number.isInteger(groupId)) return false
  const tabs = await chrome.tabs.query({ groupId }).catch(() => [])
  if (!tabs.some(tab => tab.id === tabId)) return false
  session.tabIds.add(tabId)
  session.tabOrigins.set(tabId, recoveredTabOrigin(session, tabId))
  attachTabSession(tabId, session.sessionId)
  return true
}

// Whether this session OPENED a tab or merely borrowed it, recovered from the
// group's own durable record rather than assumed.
//
// That one fact is what `finalizeTabs` decides on: a tab Klaus opened is removed
// when the work ends, a tab it claimed from the user is handed back. MV3 shuts the
// service worker down whenever it goes idle, which drops the in-memory map, so
// treating an unknown origin as 'user' meant that after any pause the session's
// own throwaway tabs were reclassified as the user's and `close` RELEASED them
// into the window instead of closing them — answered as a successful close with
// the tab still sitting there. Measured on a real Chrome: a probe tab outlived its
// own `close` and could then be neither claimed nor attached by anything.
//
// The record is already persisted per group (`groupMetadata.tabOrigins`); this
// only stops ignoring it.
function recoveredTabOrigin(session, tabId) {
  const groupId = tabGroups.sessionGroups.get(session.sessionId)
  if (!Number.isInteger(groupId)) return 'user'
  const metadata = tabGroups.groupMetadata.get(groupId)
  return metadata?.tabOrigins?.[String(tabId)] === 'agent' ? 'agent' : 'user'
}

async function getSessionIdForChromeGroup(groupId) {
  await initializeTabGroups()
  for (const [sessionId, chromeGroupId] of tabGroups.sessionGroups.entries()) {
    if (chromeGroupId === groupId) return sessionId
  }
  return null
}

async function getSessionGroupTabIds(session) {
  await initializeBorrowedTabs()
  const borrowed = [...borrowedTabs].filter(([, owner]) => owner === session.sessionId).map(([id]) => id)
  await initializeTabGroups()
  const groupId = tabGroups.sessionGroups.get(session.sessionId)
  if (!Number.isInteger(groupId)) return borrowed
  const tabs = await chrome.tabs.query({ groupId }).catch(() => [])
  return [...new Set([...borrowed, ...tabs.map(tab => tab.id).filter(Number.isInteger)])]
}

async function releaseTabsFromSessionGroup(session, tabIds) {
  if (!chrome.tabs.ungroup || tabIds.length === 0) return
  tabIds = tabIds.filter(tabId => borrowedTabs.get(tabId) !== session.sessionId)
  if (!tabIds.length) return
  try {
    await chrome.tabs.ungroup(tabIds.length === 1 ? tabIds[0] : tabIds)
  } catch {}
  await refreshSessionGroupFromChrome(session)
}

async function moveTabsToDeliverableGroup(tabIds) {
  if (!chrome.tabs.group || !chrome.tabGroups?.update || tabIds.length === 0) return
  await initializeTabGroups()
  let groupId = tabGroups.deliverableGroupId
  if (!Number.isInteger(groupId) || !(await readGroup(groupId))) {
    groupId = await chrome.tabs.group({ tabIds })
    tabGroups.deliverableGroupId = groupId
  } else {
    await chrome.tabs.group({ groupId, tabIds: tabIds.length === 1 ? tabIds[0] : tabIds })
  }
  const metadata = normalizeGroupMetadata({
    chromeGroupId: groupId,
    mainTabId: tabIds[0] ?? null,
    secondaryTabIds: tabIds.slice(1),
    title: DELIVERABLE_GROUP_TITLE,
    presentationColor: DEFAULT_TAB_GROUP_COLOR,
    tabOrigins: {},
  })
  tabGroups.groupMetadata.set(groupId, metadata)
  await reconcileGroupPresentation(groupId).catch(() => {})
  await saveTabGroups()
}

async function cleanupSessionGroup(session) {
  await initializeTabGroups()
  const groupId = tabGroups.sessionGroups.get(session.sessionId)
  if (!Number.isInteger(groupId)) return
  const tabs = await chrome.tabs.query({ groupId }).catch(() => [])
  if (tabs.length > 0) {
    await refreshSessionGroupFromChrome(session)
    return
  }
  tabGroups.sessionGroups.delete(session.sessionId)
  tabGroups.groupMetadata.delete(groupId)
  await saveTabGroups()
}

async function refreshSessionGroupFromChrome(session) {
  await initializeTabGroups()
  const groupId = tabGroups.sessionGroups.get(session.sessionId)
  if (!Number.isInteger(groupId)) return
  const metadata = tabGroups.groupMetadata.get(groupId)
  if (!metadata) return
  const tabs = await chrome.tabs.query({ groupId }).catch(() => [])
  const ids = tabs.map(tab => tab.id).filter(Number.isInteger)
  metadata.mainTabId = ids[0] ?? metadata.mainTabId
  metadata.secondaryTabIds = ids.slice(1)
  for (const key of Object.keys(metadata.tabOrigins)) {
    if (!ids.includes(Number(key))) delete metadata.tabOrigins[key]
  }
  await saveTabGroups()
}

async function updateSessionGroupPresentation(session) {
  if (!chrome.tabGroups?.update) return
  await initializeTabGroups()
  const groupId = tabGroups.sessionGroups.get(session.sessionId)
  if (!Number.isInteger(groupId)) return
  const metadata = tabGroups.groupMetadata.get(groupId)
  if (metadata) {
    metadata.title = session.name || tabGroups.sessionGroupTitles.get(session.sessionId) || DEFAULT_SESSION_TITLE
    metadata.presentationColor = validTabGroupColor(metadata.presentationColor) ? metadata.presentationColor : randomTabGroupColor()
  }
  await reconcileGroupPresentation(groupId).catch(() => {})
}

async function reconcileAllGroupPresentations() {
  for (const sessionId of tabGroups.sessionGroups.keys()) {
    const session = sessions.get(sessionId) || {
      sessionId,
      name: tabGroups.sessionGroupTitles.get(sessionId) || DEFAULT_SESSION_TITLE,
    }
    await updateSessionGroupPresentation(session).catch(() => {})
  }
  if (Number.isInteger(tabGroups.deliverableGroupId)) {
    const metadata = tabGroups.groupMetadata.get(tabGroups.deliverableGroupId)
    if (metadata) metadata.title = DELIVERABLE_GROUP_TITLE
    await reconcileGroupPresentation(tabGroups.deliverableGroupId).catch(() => {})
  }
}

async function addTabToGroup(groupId, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab || tab.groupId === groupId) return
  await chrome.tabs.group({ groupId, tabIds: tabId })
}

async function readGroup(groupId) {
  if (!chrome.tabGroups?.get) return null
  try {
    return await chrome.tabGroups.get(groupId)
  } catch {
    return null
  }
}

function normalizeGroupMetadata(item) {
  const tabOrigins = item.tabOrigins && typeof item.tabOrigins === 'object' ? item.tabOrigins : {}
  return {
    chromeGroupId: Number(item.chromeGroupId),
    mainTabId: Number.isInteger(item.mainTabId) ? item.mainTabId : null,
    secondaryTabIds: Array.isArray(item.secondaryTabIds) ? item.secondaryTabIds.filter(Number.isInteger) : [],
    createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    title: typeof item.title === 'string' ? item.title : undefined,
    presentationColor: validTabGroupColor(item.presentationColor) ? item.presentationColor : undefined,
    tabOrigins: Object.fromEntries(Object.entries(tabOrigins).filter(([key, value]) => Number.isInteger(Number(key)) && (value === 'agent' || value === 'user'))),
  }
}

async function reconcileGroupPresentation(groupId, chromeGroup = null) {
  const metadata = tabGroups.groupMetadata.get(groupId)
  if (!metadata || !chrome.tabGroups?.update) return
  const presentationColor = groupId === tabGroups.deliverableGroupId
    ? DEFAULT_TAB_GROUP_COLOR
    : metadata.presentationColor || randomTabGroupColor()
  metadata.presentationColor = presentationColor
  const title = metadata.title || DEFAULT_SESSION_TITLE
  const current = chromeGroup || await readGroup(groupId)
  const patch = {}
  if (!current || current.title !== title) patch.title = title
  if (!current || current.color !== presentationColor) patch.color = presentationColor
  if (!current || current.collapsed !== false) patch.collapsed = false
  if (Object.keys(patch).length > 0) await chrome.tabGroups.update(groupId, patch).catch(() => {})
}

function randomTabGroupColor() {
  return TAB_GROUP_COLORS[Math.floor(Math.random() * TAB_GROUP_COLORS.length)] || TAB_GROUP_COLORS[0]
}

function validTabGroupColor(value) {
  return typeof value === 'string' && VALID_TAB_GROUP_COLORS.has(value)
}

async function saveTabGroups() {
  await chrome.storage?.local?.set?.({
    [STORAGE_TAB_GROUPS_KEY]: {
      groups: Array.from(tabGroups.groupMetadata.values()),
      sessionGroups: Object.fromEntries(tabGroups.sessionGroups.entries()),
      sessionGroupTitles: Object.fromEntries(tabGroups.sessionGroupTitles.entries()),
      ...(Number.isInteger(tabGroups.deliverableGroupId) ? { deliverableGroupId: tabGroups.deliverableGroupId } : {}),
    },
  })
}

async function attachDebugger(target) {
  await withTargetLock(target, async () => {
    const key = targetKey(target)
    if (attachedTargets.has(key)) return
    try {
      await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION)
    } catch (error) {
      if (!normalizeError(error).includes('Another debugger')) throw error
    }
    attachedTargets.add(key)
  })
}

async function detachDebugger(target) {
  await withTargetLock(target, async () => {
    const key = targetKey(target)
    if (!attachedTargets.has(key)) return
    try {
      await chrome.debugger.detach(target)
    } finally {
      attachedTargets.delete(key)
    }
  })
}

async function detachAttachedTabIdsBestEffort(tabIds) {
  await Promise.allSettled(tabIds.map(tabId => attachedTargets.has(targetKey({ tabId })) ? detachDebugger({ tabId }) : null))
}

async function withTargetLock(target, fn) {
  const key = targetKey(target)
  const previous = targetLocks.get(key) || Promise.resolve()
  let release
  const current = previous.catch(() => {}).then(() => new Promise(resolve => { release = resolve }))
  targetLocks.set(key, current)
  try {
    await previous.catch(() => {})
    return await fn()
  } finally {
    release()
    if (targetLocks.get(key) === current) targetLocks.delete(key)
  }
}

function cdpTarget(params) {
  const target = params.target && typeof params.target === 'object' ? params.target : {}
  if (typeof target.targetId === 'string') return { targetId: target.targetId }
  if (typeof params.targetId === 'string') return { targetId: params.targetId }
  const tabId = numericTabId(target.tabId ?? params.tabId ?? params.tab_id)
  const sessionId = target.sessionId ?? params.sessionId
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string' || flatSessionOwners.get(sessionId)?.tabId !== tabId) throw new Error('CDP frame session does not belong to this Chrome tab')
    return { tabId, sessionId }
  }
  return { tabId }
}

function forgetFlatSession(sessionId) {
  if (typeof sessionId !== 'string') return
  flatSessionOwners.delete(sessionId)
  for (const [child, owner] of flatSessionOwners) if (owner.parentSessionId === sessionId) forgetFlatSession(child)
}

function targetKey(target) {
  if (Number.isInteger(target.tabId)) return `tab:${target.tabId}`
  if (typeof target.targetId === 'string') return `target:${target.targetId}`
  return 'unknown'
}

async function publishSessionTabs(session) {
  await Promise.all([...session.tabIds].map(tabId => publishTabState(tabId)))
}

async function publishTabState(tabId) {
  await publishTabCursorState(tabId)
}

async function publishTabCursorState(tabId) {
  if (!(await prepareContentScript(tabId))) return false
  try {
    const response = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'AGENT_CURSOR_STATE', state: readCursorOverlayState(tabId) }),
      CONTENT_SCRIPT_TIMEOUT_MS,
      'cursor state publish',
    )
    return response?.ok === true
  } catch {
    return false
  }
}

async function prepareContentScript(tabId) {
  if (await pingContentScript(tabId)) return true
  if (!isTabTracked(tabId)) return false
  let pending = contentScriptPrepareByTabId.get(tabId)
  if (!pending) {
    pending = injectContentScript(tabId).finally(() => contentScriptPrepareByTabId.delete(tabId))
    contentScriptPrepareByTabId.set(tabId, pending)
  }
  return pending
}

async function injectContentScript(tabId) {
  try {
    await withTimeout(
      chrome.scripting.executeScript({
        files: ['content-scripts/klaus.js'],
        injectImmediately: true,
        target: { tabId },
      }),
      CONTENT_SCRIPT_TIMEOUT_MS,
      'content script injection',
    )
  } catch {
    return false
  }
  return pingContentScript(tabId)
}

async function pingContentScript(tabId) {
  try {
    const response = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PING' }),
      CONTENT_SCRIPT_TIMEOUT_MS,
      'content script ping',
    )
    return response?.ok === true
  } catch {
    return false
  }
}

async function setCursorState(session, tabId, cursor) {
  if (!session.isRunning) return false
  session.cursorByTabId.set(tabId, cursor)
  return publishTabCursorState(tabId)
}

function readCursorOverlayState(tabId) {
  const sessionId = getHighestPrioritySessionIdForTab(tabId)
  const session = sessionId ? sessions.get(sessionId) : null
  if (!session?.isRunning) return emptyCursorState()
  const cursor = session.cursorByTabId.get(tabId) || null
  const isObserved = activeTabIds.has(tabId)
  return {
    cursor: !isObserved && cursor != null ? { visible: false, x: cursor.x, y: cursor.y } : cursor,
    isVisible: isObserved,
    sessionId,
    turnId: session.currentTurnId,
  }
}

function emptyCursorState() {
  return { cursor: null, isVisible: false, sessionId: null, turnId: null }
}

function createCursorArrivalWaiter(sessionId, turnId, moveSequence) {
  const key = cursorArrivalKey(sessionId, turnId, moveSequence)
  let timer = null
  let resolveWaiter = null
  const finish = () => {
    if (timer != null) clearTimeout(timer)
    cursorArrivalWaiters.delete(key)
    resolveWaiter?.()
  }
  return {
    cancel: finish,
    promise: new Promise(resolve => {
      resolveWaiter = resolve
      timer = setTimeout(finish, CURSOR_ARRIVAL_TIMEOUT_MS)
      cursorArrivalWaiters.set(key, finish)
    }),
  }
}

function cursorArrivalKey(sessionId, turnId, moveSequence) {
  return `${sessionId}:${turnId}:${moveSequence}`
}

async function refreshActiveTabs() {
  const tabs = await chrome.tabs.query({ active: true }).catch(() => [])
  const nextActiveTabIds = new Set()
  const nextByWindowId = new Map()
  for (const tab of tabs) {
    if (Number.isInteger(tab.id) && Number.isInteger(tab.windowId)) {
      nextActiveTabIds.add(tab.id)
      nextByWindowId.set(tab.windowId, tab.id)
    }
  }
  const changed = symmetricDifference(activeTabIds, nextActiveTabIds)
  activeTabIds.clear()
  nextActiveTabIds.forEach(tabId => activeTabIds.add(tabId))
  activeTabIdByWindowId.clear()
  nextByWindowId.forEach((tabId, windowId) => activeTabIdByWindowId.set(windowId, tabId))
  activeTabsInitialized = true
  await Promise.all([...changed].map(tabId => publishTabState(tabId)))
}

function setWindowActiveTab(windowId, tabId) {
  if (!activeTabsInitialized) {
    refreshActiveTabs().catch(() => {})
    return
  }
  const changed = new Set()
  const previous = activeTabIdByWindowId.get(windowId)
  if (previous !== tabId) {
    if (Number.isInteger(previous)) {
      activeTabIds.delete(previous)
      changed.add(previous)
    }
    activeTabIdByWindowId.set(windowId, tabId)
    activeTabIds.add(tabId)
    changed.add(tabId)
  }
  Promise.all([...changed].map(id => publishTabState(id))).catch(() => {})
}

function symmetricDifference(left, right) {
  const out = new Set()
  for (const item of left) if (!right.has(item)) out.add(item)
  for (const item of right) if (!left.has(item)) out.add(item)
  return out
}

async function isActiveVisibleNormalTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.active !== true || !Number.isInteger(tab.windowId)) return false
    const window = await chrome.windows.get(tab.windowId)
    return window.type === 'normal' && window.state !== 'minimized'
  } catch {
    return false
  }
}

async function removeTabs(tabIds) {
  if (tabIds.length === 0) return
  await chrome.tabs.remove(tabIds.length === 1 ? tabIds[0] : tabIds).catch(() => {})
}

function parseKeepTabs(keep, knownTabIds) {
  if (!Array.isArray(keep)) throw new Error('finalizeTabs requires a keep array')
  const map = new Map()
  for (const entry of keep) {
    let tabId
    let status
    if (entry && typeof entry === 'object') {
      tabId = numericTabId(entry.tabId ?? entry.tab_id)
      status = entry.status
    } else {
      tabId = numericTabId(entry)
      status = 'handoff'
    }
    if (!knownTabIds.has(tabId)) throw new Error(`finalizeTabs cannot keep unknown tab ${tabId}`)
    if (status !== 'handoff' && status !== 'deliverable') throw new Error(`finalizeTabs received invalid status ${String(status)}`)
    if (map.has(tabId)) throw new Error(`finalizeTabs received duplicate tab ${tabId}`)
    map.set(tabId, status)
  }
  return map
}

function normalizeTab(tab, groupTitles = new Map()) {
  const groupTitle = Number.isInteger(tab.groupId) ? groupTitles.get(tab.groupId) : undefined
  const opened = lastAccessed(tab)
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    groupId: tab.groupId,
    ...(tab.title == null ? {} : { title: tab.title }),
    ...(tab.url == null ? {} : { url: tab.url }),
    ...(tab.favIconUrl == null ? {} : { faviconUrl: tab.favIconUrl }),
    ...(opened > 0 ? { lastOpened: new Date(opened).toISOString() } : {}),
    ...(groupTitle ? { tabGroup: groupTitle } : {}),
    ...(tab.active === true ? { active: true } : {}),
  }
}

function toBasicTab(tab) {
  return {
    id: tab.id,
    ...(Number.isFinite(tab.width) ? { width: tab.width } : {}),
    ...(Number.isFinite(tab.height) ? { height: tab.height } : {}),
    ...(tab.title == null ? {} : { title: tab.title }),
    ...(tab.url == null ? {} : { url: tab.url }),
    ...(tab.active === true ? { active: true } : {}),
  }
}

async function tabGroupTitles(tabs) {
  const groupIds = new Set(tabs.map(tab => tab.groupId).filter(groupId => Number.isInteger(groupId) && groupId !== -1))
  const entries = await Promise.all([...groupIds].map(async groupId => {
    try {
      const title = (await chrome.tabGroups.get(groupId)).title?.trim()
      return title ? [groupId, title] : null
    } catch {
      return null
    }
  }))
  return new Map(entries.filter(Boolean))
}

function tabHasId(tab) {
  return Number.isInteger(tab?.id)
}

function lastAccessed(tab) {
  return Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0
}

function numericTabId(value) {
  const tabId = Number(value)
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Chrome tab id must be numeric.')
  return tabId
}

function objectParam(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function nullableString(value, fallback) {
  if (value == null) return fallback
  if (typeof value !== 'string') throw new Error('getUserHistory requires query to be a string')
  return value
}

function historyLimit(value) {
  if (value == null) return 100
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('getUserHistory requires limit to be a positive integer')
  }
  return value
}

function dateValue(value, name) {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error(`getUserHistory requires ${name} to be a valid date`)
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`getUserHistory requires ${name} to be a valid date`)
  return parsed
}

function timeoutMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : REQUEST_TIMEOUT_MS
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${label}.`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer != null) clearTimeout(timer)
  })
}

function isValidDownloadId(id) {
  return typeof id === 'number' && Number.isInteger(id) && id >= 0
}

function downloadStatus(delta) {
  switch (delta.state?.current) {
    case 'complete':
      return 'complete'
    case 'interrupted':
      return delta.error?.current === 'USER_CANCELED' ? 'canceled' : 'failed'
    case 'in_progress':
      return 'in_progress'
    default:
      return undefined
  }
}

function emitDownloadChange(change) {
  postNative({
    jsonrpc: '2.0',
    method: 'onDownloadChange',
    params: { ...change, ...(ownedDownloads.has(Number(change.id)) ? { sessionId: ownedDownloads.get(Number(change.id)).sessionId, tabId: ownedDownloads.get(Number(change.id)).tabId } : {}) },
  })
}

async function heartbeatNativeHost() {
  if (!nativePort) {
    scheduleReconnect()
    return
  }
  try {
    await requestNative('ping', {}, 3_000)
  } catch {
    try {
      nativePort.disconnect()
    } catch {}
    nativePort = null
    scheduleReconnect()
    await stopActiveSessions()
    const targets = await chrome.debugger.getTargets().catch(() => [])
    await Promise.allSettled(targets
      .filter(target => Number.isInteger(target.tabId))
      .map(target => chrome.debugger.detach({ tabId: target.tabId }).catch(() => {})))
    attachedTargets.clear()
  }
}

async function stopActiveSessions() {
  for (const session of sessions.values()) await stopSession(session)
}

async function ensureExtensionInstanceId(force = false) {
  const stored = await chrome.storage?.local?.get?.('extensionInstanceId').catch(() => ({}))
  if (!force && typeof stored?.extensionInstanceId === 'string') return stored.extensionInstanceId
  const id = crypto.randomUUID()
  await chrome.storage?.local?.set?.({ extensionInstanceId: id }).catch(() => {})
  return id
}

async function ensureAlarm(name, periodInMinutes) {
  if (!chrome.alarms?.get || !chrome.alarms?.create) return
  if (!(await chrome.alarms.get(name))) {
    await chrome.alarms.create(name, { periodInMinutes })
  }
}

function clearAlarm(name) {
  chrome.alarms?.clear?.(name).catch?.(() => {})
}

function normalizeError(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error ?? 'Unknown error')
}

// Browser management: an allowlisted slice of chrome.bookmarks, chrome.tabGroups,
// chrome.tabs and chrome.windows that an active task turn may call. Mutating calls
// are recorded in a best-effort session audit ledger (bounded, time-windowed and
// serialized); ledger or snapshot failures never block the call itself.
const MANAGEMENT_ALLOWLIST = {
  bookmarks: {
    create: { audit: true, validate: validateManagementBookmarkUrl },
    get: {},
    getChildren: {},
    getSubTree: {},
    getTree: {},
    move: { audit: true },
    remove: { audit: true },
    search: {},
    update: { audit: true, validate: validateManagementBookmarkUrl },
  },
  tabGroups: {
    get: {},
    move: { audit: true, validate: validateManagementTabGroup },
    query: {},
    update: { audit: true, validate: validateManagementTabGroup },
  },
  tabs: {
    get: {},
    group: { audit: true },
    move: { audit: true, validate: validateManagementTabsMove },
    query: {},
    remove: { audit: true, validate: validateManagementTabIds },
    ungroup: { audit: true, validate: validateManagementTabIds },
    update: { audit: true, validate: validateManagementTabsUpdate },
  },
  windows: {
    create: { audit: true },
    get: {},
    getAll: {},
    getCurrent: {},
    getLastFocused: {},
    update: { audit: true, validate: validateManagementWindowsUpdate },
  },
}
const MANAGEMENT_TABS_UPDATE_PROPERTIES = new Set(['autoDiscardable', 'pinned'])
const MANAGEMENT_TAB_GROUP_UPDATE_PROPERTIES = new Set(['collapsed', 'color', 'title'])
const MANAGEMENT_WINDOWS_UPDATE_PROPERTIES = new Set(['focused', 'height', 'left', 'state', 'top', 'width'])
const MANAGEMENT_WINDOWS_CREATE_PROPERTIES = new Set(['focused', 'height', 'left', 'state', 'tabId', 'top', 'type', 'width'])
const MANAGEMENT_AUDIT_STORAGE_KEY = 'klausBrowserManagementAudit'
const MANAGEMENT_AUDIT_LIMIT = 50
const MANAGEMENT_AUDIT_WINDOW_MS = 72 * 60 * 60 * 1000
let managementAuditQueue = Promise.resolve()

async function managementCall(params) {
  const namespace = String(params?.namespace ?? '')
  const method = String(params?.method ?? '')
  if (!Object.hasOwn(MANAGEMENT_ALLOWLIST, namespace)) throw new Error(`Chrome API chrome.${namespace}.${method} is not allowed`)
  const allowedMethods = MANAGEMENT_ALLOWLIST[namespace]
  if (!Object.hasOwn(allowedMethods, method)) throw new Error(`Chrome API chrome.${namespace}.${method} is not allowed`)
  const entry = allowedMethods[method]
  const call = { namespace, method, args: Array.isArray(params?.args) ? params.args : [] }
  const invoke = async () => {
    if (namespace === 'windows' && method === 'create') {
      const options = await validateManagementWindowsCreate(call)
      const create = { ...options, incognito: false }
      if (!Object.hasOwn(options, 'tabId')) create.url = 'about:blank'
      return chrome.windows.create(create)
    }
    await entry.validate?.(call)
    const api = chrome[namespace]
    if (api == null || !Object.hasOwn(api, method)) throw new Error(`Chrome API chrome.${namespace}.${method} is unavailable`)
    const target = Reflect.get(api, method)
    if (typeof target !== 'function') throw new Error(`Chrome API chrome.${namespace}.${method} is unavailable`)
    const args = namespace === 'tabs' && method === 'group' ? [await normalizeManagementTabsGroup(call), ...call.args.slice(1)] : call.args
    return Reflect.apply(target, api, args)
  }
  return entry.audit ? auditedManagementCall(call, invoke) : invoke()
}

async function managementAuditTrail() {
  return withManagementAuditLock(async () => ({ changes: (await readManagementAuditLedger()).toReversed() }))
}

async function validateManagementWindowsCreate(call) {
  if (call.args.length > 1) throw new Error('Chrome API windows.create accepts at most one argument')
  const options = managementPlainOptions(call.args.length === 0 ? {} : call.args[0], MANAGEMENT_WINDOWS_CREATE_PROPERTIES, 'windows.create', true)
  if (options.type !== undefined && options.type !== 'normal') throw new Error('Chrome API windows.create only supports normal windows')
  managementRejectLockedFullscreen(options.state, 'windows.create')
  if (!Object.hasOwn(options, 'tabId')) return options
  const tab = await chrome.tabs.get(managementRequireId(options.tabId, 'tab ID'))
  if (tab.pinned) throw new Error('Chrome API windows.create cannot move a pinned tab without changing its pinning')
  await managementRequireNormalWindow(tab.windowId, 'windows.create')
  await managementRejectSharedGroupsInWindows([tab.windowId])
  return options
}

async function validateManagementWindowsUpdate(call) {
  const windowId = managementRequireId(call.args[0], 'window ID')
  const options = managementPlainOptions(call.args[1], MANAGEMENT_WINDOWS_UPDATE_PROPERTIES, 'windows.update')
  managementRejectLockedFullscreen(options.state, 'windows.update')
  await managementRequireNormalWindow(windowId, 'windows.update')
}

async function validateManagementTabGroup(call) {
  const groupId = managementRequireId(call.args[0], 'group ID')
  if (call.method === 'update') managementPlainOptions(call.args[1], MANAGEMENT_TAB_GROUP_UPDATE_PROPERTIES, 'tabGroups.update')
  await managementRequireUnsharedGroup(groupId)
}

async function validateManagementTabsUpdate(call) {
  const options = managementPlainOptions(call.args[1], MANAGEMENT_TABS_UPDATE_PROPERTIES, 'tabs.update')
  const tabId = managementRequireId(call.args[0], 'tab ID')
  if (options.pinned === true) await managementTabsRejectingSharedGroups([tabId])
}

async function validateManagementTabsMove(call) {
  const tabIds = managementRequireTabIds(call.args[0])
  const options = managementPlainObject(call.args[1], 'tabs.move')
  const tabs = await Promise.all(tabIds.map(id => chrome.tabs.get(id)))
  const windowIds = new Set(tabs.map(({ windowId }) => windowId))
  if (Object.hasOwn(options, 'windowId')) windowIds.add(managementRequireId(options.windowId, 'window ID'))
  await managementRejectSharedGroupsInWindows(windowIds)
}

async function validateManagementTabIds(call) {
  await managementTabsRejectingSharedGroups(managementRequireTabIds(call.args[0]))
}

async function normalizeManagementTabsGroup(call) {
  const options = managementPlainObject(call.args[0], 'tabs.group')
  const tabs = await managementTabsRejectingSharedGroups(managementRequireTabIds(options.tabIds))
  let createProperties
  let windowId
  if (Object.hasOwn(options, 'groupId')) {
    windowId = (await managementRequireUnsharedGroup(managementRequireId(options.groupId, 'group ID'))).windowId
  } else {
    createProperties = options.createProperties === undefined ? {} : managementPlainObject(options.createProperties, 'tabs.group createProperties')
    windowId = createProperties.windowId === undefined ? tabs[0].windowId : managementRequireId(createProperties.windowId, 'createProperties.windowId')
  }
  if (tabs.some(tab => tab.windowId !== windowId)) throw new Error('Chrome API tabs.group cannot move tabs between windows; group tabs separately by window. Use tabs.move only for user-requested transfers.')
  return createProperties === undefined ? options : { ...options, createProperties: { ...createProperties, windowId } }
}

function validateManagementBookmarkUrl(call) {
  const options = managementPlainObject(call.args[call.method === 'create' ? 0 : 1], `bookmarks.${call.method}`)
  if (!Object.hasOwn(options, 'url')) return
  try {
    if (typeof options.url === 'string') {
      const { protocol } = new URL(options.url)
      if (protocol === 'http:' || protocol === 'https:') return
    }
  } catch {}
  throw new Error(`Chrome API bookmarks.${call.method} requires a valid http or https URL`)
}

function managementPlainOptions(value, allowed, label, allowEmpty = false) {
  const options = managementPlainObject(value, label)
  const keys = Object.keys(options)
  if ((!allowEmpty && keys.length === 0) || keys.some(key => !allowed.has(key))) throw new Error(`Chrome API ${label} contains an unsupported property`)
  return options
}

function managementPlainObject(value, label) {
  if (!managementIsPlainObject(value)) throw new Error(`Chrome API ${label} requires a plain options object`)
  return value
}

function managementIsPlainObject(value) {
  if (value == null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || Object.getPrototypeOf(proto) === null
}

function managementRequireTabIds(value) {
  const ids = Array.isArray(value) ? value : [value]
  if (ids.length === 0) throw new Error('Chrome API requires at least one tab ID')
  return ids.map(id => managementRequireId(id, 'tab ID'))
}

function managementRequireId(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Chrome API requires an explicit valid ${label}`)
  return value
}

async function managementRequireNormalWindow(windowId, label) {
  const window = await chrome.windows.get(windowId)
  if (window.type !== 'normal' || window.incognito) throw new Error(`Chrome API ${label} requires a normal non-incognito window`)
}

function managementRejectLockedFullscreen(state, label) {
  if (state === 'locked-fullscreen') throw new Error(`Chrome API ${label} cannot lock a window in fullscreen`)
}

async function managementRejectSharedGroupsInWindows(windowIds) {
  await managementRejectSharedGroupsForTabs((await Promise.all([...windowIds].map(windowId => chrome.tabs.query({ windowId })))).flat())
}

async function managementRequireUnsharedGroup(groupId) {
  const group = await chrome.tabGroups.get(groupId)
  if (group.shared) throw new Error(`Chrome API cannot modify shared tab group ${groupId} without permission to share`)
  return group
}

async function managementTabsRejectingSharedGroups(tabIds) {
  const tabs = await Promise.all([...new Set(tabIds)].map(id => chrome.tabs.get(id)))
  await managementRejectSharedGroupsForTabs(tabs)
  return tabs
}

async function managementRejectSharedGroupsForTabs(tabs) {
  const groupIds = new Set(tabs.map(({ groupId }) => groupId))
  groupIds.delete(-1)
  await Promise.all([...groupIds].map(id => managementRequireUnsharedGroup(id)))
}

async function auditedManagementCall(call, invoke) {
  return withManagementAuditLock(async () => {
    const ledger = await readManagementAuditLedger().catch(() => {})
    if (ledger == null) return await invoke()
    const before = await managementBeforeSnapshot(call).catch(() => {})
    if (before == null) return await invoke()
    const result = await invoke()
    if (!managementSnapshotIsRelevant(call, before)) return result
    const entry = { args: call.args, before, createdAt: Date.now(), method: call.method, namespace: call.namespace }
    if (typeof result === 'number') entry.result = result
    else if (managementIsPlainObject(result) && typeof result.id === 'string') entry.result = { id: result.id }
    else if (call.namespace === 'windows' && managementIsPlainObject(result) && typeof result.id === 'number') entry.result = result.id
    ledger.push(entry)
    await writeManagementAuditLedger(ledger).catch(() => {})
    return result
  })
}

async function managementBeforeSnapshot(call) {
  switch (call.namespace) {
    case 'bookmarks':
      return await managementBookmarkSnapshot(call.args[0])
    case 'tabs':
      return await managementTabLayoutSnapshot(call.method === 'remove' ? (Array.isArray(call.args[0]) ? call.args[0] : [call.args[0]]) : [])
    case 'tabGroups':
      return await managementTabLayoutSnapshot()
    case 'windows':
      return await managementWindowsSnapshot(call)
    default:
      throw new Error(`Unhandled browser management namespace: ${call.namespace}`)
  }
}

async function managementWindowsSnapshot(call) {
  const snapshot = {
    windows: (await chrome.windows.getAll({ windowTypes: ['normal'] }))
      .filter(({ incognito }) => !incognito)
      .flatMap(({ focused, height, id, left, state, top, width }) => id == null ? [] : [{ focused, height, id, left, state, top, width }]),
  }
  if (call.method === 'create' && managementIsPlainObject(call.args[0]) && Object.hasOwn(call.args[0], 'tabId')) snapshot.tabLayout = (await managementTabLayoutSnapshot()).tabLayout
  return snapshot
}

async function managementBookmarkSnapshot(bookmarkId) {
  if (typeof bookmarkId !== 'string') return {}
  const [bookmark] = await chrome.bookmarks.get(bookmarkId)
  if (bookmark == null) throw new Error(`Chrome bookmark ${bookmarkId} is unavailable`)
  const { id, index, parentId, title, url } = bookmark
  return { bookmarks: [{ id, index, parentId, title, url }] }
}

async function managementTabLayoutSnapshot(removeTabIds = []) {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups?.query?.({}).catch(() => []) ?? []])
  const scoped = tabs.filter(({ incognito }) => !incognito)
  const referencedGroups = new Set(scoped.map(({ groupId }) => groupId))
  return {
    tabLayout: {
      tabs: scoped.flatMap(({ autoDiscardable, groupId, id, index, pinned, url, windowId }) => id == null ? [] : [{ autoDiscardable, groupId, id, index, pinned, windowId, ...(removeTabIds.includes(id) ? { url } : {}) }]),
      groups: groups.filter(({ id }) => referencedGroups.has(id)).map(({ collapsed, color, id, title, windowId }) => ({ collapsed, color, id, title, windowId })),
    },
  }
}

function managementSnapshotIsRelevant(call, before) {
  if (call.namespace === 'bookmarks') return true
  if (call.namespace === 'windows') return call.method === 'create' || (before.windows?.some(({ id }) => id === call.args[0]) ?? false)
  const tabs = before.tabLayout?.tabs ?? []
  if (call.namespace === 'tabGroups') return tabs.some(({ groupId }) => groupId === call.args[0])
  const target = call.args[0]
  const ids = managementIsPlainObject(target) ? target.tabIds : target
  return (Array.isArray(ids) ? ids : [ids]).every(id => tabs.some(({ id: tabId }) => tabId === id))
}

async function readManagementAuditLedger() {
  const stored = await chrome.storage.session.get(MANAGEMENT_AUDIT_STORAGE_KEY)
  const oldest = Date.now() - MANAGEMENT_AUDIT_WINDOW_MS
  return (stored[MANAGEMENT_AUDIT_STORAGE_KEY] ?? []).filter(({ createdAt }) => createdAt >= oldest).slice(-MANAGEMENT_AUDIT_LIMIT)
}

async function writeManagementAuditLedger(entries) {
  await chrome.storage.session.set({ [MANAGEMENT_AUDIT_STORAGE_KEY]: entries.slice(-MANAGEMENT_AUDIT_LIMIT) })
}

function withManagementAuditLock(task) {
  const run = managementAuditQueue.then(task)
  managementAuditQueue = run.then(() => {}, () => {})
  return run
}
