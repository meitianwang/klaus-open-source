const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const { readFileSync } = require('node:fs')
const { realpath } = require('node:fs/promises')
const { join, sep } = require('node:path')

const desktopRoot = process.env.KLAUS_WIDGET_DESKTOP_ROOT
const assets = process.env.KLAUS_WIDGET_FULL_CHAT_ASSETS
const profile = process.env.KLAUS_WIDGET_FULL_CHAT_PROFILE
const { registerAppScheme, serveFrontend, appUrl } = require(join(desktopRoot, 'dist/main/app/protocol.js'))
const { WidgetService } = require(join(desktopRoot, 'dist/main/services/widgets.js'))
const { MediaFiles } = require(join(desktopRoot, 'dist/main/services/media-files.js'))
registerAppScheme()
app.setPath('userData', profile)

const sessionId = 'session-12345678'
const calls = []
let widgetReply = null
let currentRevision = 1
ipcMain.handle('widget-full-chat-invoke', (_event, method, payload) => {
  const channel = method === 'ipc_invoke' ? payload?.channel : method
  calls.push({ channel, args: payload?.args })
  if (channel === 'settings:kv:get') return null
  if (channel === 'session:list') return [{ id: sessionId, title: 'Widget fixture', updatedAt: Date.now(), archived: false }]
  if (['session:list-archived', 'project:list', 'workspace:list', 'session:history', 'side-task:list'].includes(channel)) return []
  if (channel === 'session:get-workdir') return { custom: null, hasMessages: false }
  if (channel === 'session:get-resolved-workdir') return desktopRoot
  if (channel === 'app:platform') return 'darwin'
  if (channel === 'session:get-main-model') return { source: 'codex', mode: 'codex:gpt-5' }
  if (channel === 'session:get-main-model-options') return { options: [{ value: 'codex:gpt-5', label: 'GPT-5' }] }
  if (channel === 'artifacts:widget-url') return { ...widgetReply, currentRevision }
  if (channel === 'chat:client-queue-snapshot') return { revision: 0, interrupted: false, items: [] }
  if (channel === 'chat:client-queue-add') return { ok: true, snapshot: { revision: 1, interrupted: false, items: [{ id: payload.args[0].id, item: payload.args[0].item }] } }
  if (channel === 'chat:upload') return { path: join(profile, 'widget-fixture-note.txt'), name: 'widget-fixture-note.txt', type: 'text/plain', size: 4 }
  if (channel === 'chat:send') return { ok: true, turnId: 'fixture-turn' }
  return {}
})

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
/**
 * Poll until the predicate yields a truthy value.
 *
 * The budget is wall-clock rather than an iteration count: this fixture drives a
 * real Electron renderer whose first paint queues a burst of IPC, so a fixed
 * number of polls could expire early on a busy machine and pass on an idle one.
 * A missed deadline reports the renderer's own state, because "timed out"
 * otherwise cannot distinguish a slow start from a card that never asked.
 */
async function waitFor(predicate, label, { timeoutMs = 30_000, intervalMs = 50, diagnose } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`${label} timed out${diagnose ? `: ${JSON.stringify(await diagnose().catch(error => ({ diagnoseError: String(error) })))}` : ''}`)
    await wait(intervalMs)
  }
}
const sent = () => calls.filter(call => call.channel === 'chat:send')
const queued = () => calls.filter(call => call.channel === 'chat:client-queue-add')

async function main() {
  const frontend = serveFrontend()
  const service = new WidgetService(profile, () => desktopRoot)
  const code = '<!doctype html><html><body><button id="send">Send</button><button id="cancel">Cancel</button><button id="stale">Stale</button><button id="cross">Cross</button><button id="queue">Queue</button><button id="draft">Draft</button><script>for(const [id,count] of [["send",1],["cancel",2],["stale",3],["cross",4],["queue",5],["draft",6]])document.getElementById(id).addEventListener("click",()=>window.sendToAgent({count},{submit:id!=="draft"}))</script></body></html>'
  const response = await service.run({ title: 'Counter', widget_code: code }, sessionId, 'full-chat-call')
  const snapshot = JSON.parse(response.contentItems[0].text)
  const checked = await service.snapshotPath(sessionId, snapshot.widgetId, snapshot.revision, snapshot.path)
  const media = new MediaFiles(async (path, id) => {
    try { return path.startsWith(await realpath(join(profile, 'widgets', id)) + sep) } catch { return false }
  })
  widgetReply = { ok: true, url: await media.grantWidgetSnapshot(checked.path, sessionId, checked.root) }
  protocol.handle('klaus-media', request => media.respond(request))
  const win = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: {
    contextIsolation: true, sandbox: true, nodeIntegration: false,
    preload: join(desktopRoot, 'tests/widget-full-chat-preload.cjs'),
  } })
  let phase = 'load'
  const checks = {}
  /** Observed but not asserted: fixture conditions that vary between runs. */
  const info = {}
  try {
    await win.loadURL(appUrl('index.html'))
    await waitFor(() => win.webContents.executeJavaScript('typeof window.klausHandleWidgetInteraction === "function"'), 'chat handler')
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("boot-screen")?.dataset.hidden === "1"'), 'chat initialization')
    phase = 'mount'
    await win.webContents.executeJavaScript(`(async () => {
      await window.switchSession(${JSON.stringify(sessionId)})
      const input = document.getElementById('input')
      input.value = 'Existing draft'
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Existing draft' }))
      const file = new File(['note'], 'widget-fixture-note.txt', { type: 'text/plain' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      const chooser = document.getElementById('file-input')
      chooser.files = transfer.files
      chooser.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    checks.selectedSession = await win.webContents.executeJavaScript(`window.currentSessionId === ${JSON.stringify(sessionId)}`)
    checks.attachmentBefore = await waitFor(() => win.webContents.executeJavaScript('!![...document.querySelectorAll("#previews .kls-attach-chip-name")].find(x => x.textContent.includes("widget-fixture-note.txt"))'), 'attachment')
    await win.webContents.executeJavaScript(readFileSync(join(assets, 'bundle.js'), 'utf8'))
    const mount = await win.webContents.executeJavaScript(`window.__widgetFullChatMount(${JSON.stringify(snapshot)}, ${JSON.stringify(response)})`)
    checks.mountedInsideChat = mount.mountedInsideChat && mount.card
    /**
     * Wait for the card's sandboxed frame, re-presenting the tool result when the
     * live transcript has dropped the fixture's node. The shipped chat rebuilds
     * `#messages` while it settles the session it was switched to; a real
     * transcript card comes from the data projection and cannot be dropped this
     * way, so this is fixture bookkeeping rather than a product concern.
     */
    const mountScript = `window.__widgetFullChatEnsureAttached(${JSON.stringify(snapshot)}, ${JSON.stringify(response)})`
    const waitForWidgetFrame = (label = 'Widget iframe') => waitFor(
      async () => {
        await win.webContents.executeJavaScript(mountScript)
        return win.webContents.mainFrame.frames.find(item => item.url.startsWith('klaus-media://widget/'))
      },
      label,
      { diagnose: async () => ({
        ...await win.webContents.executeJavaScript(mountScript),
        currentSessionId: await win.webContents.executeJavaScript('window.currentSessionId'),
        messagesDisplay: await win.webContents.executeJavaScript('document.getElementById("messages")?.style.display'),
        bootHidden: await win.webContents.executeJavaScript('document.getElementById("boot-screen")?.dataset.hidden'),
        snapshotSessionId: snapshot.sessionId,
        widgetUrlRequests: calls.filter(call => call.channel === 'artifacts:widget-url'),
      }), timeoutMs: 20_000 },
    )
    const frame = await waitForWidgetFrame()
    // Reported rather than asserted: a run that never saw the transcript drop the
    // node proves the delivery path without exercising the re-presentation, and
    // failing such a run would be failing the weather.
    info.cardRebuilds = await win.webContents.executeJavaScript(mountScript).then(report => report.rebuilds)
    checks.capabilityFrame = frame.url === widgetReply.url && await win.webContents.executeJavaScript('document.querySelector("[data-widget-full-chat-test] iframe")?.getAttribute("sandbox") === "allow-scripts allow-forms"')
    /**
     * The live frame, resolved at click time.
     *
     * A re-presented tool result builds a NEW frame, so a handle captured earlier
     * belongs to a detached document and clicking through it would be clicking
     * nothing. Every interaction resolves the current one first.
     */
    const liveFrame = () => {
      const current = win.webContents.mainFrame.frames.find(item => item.url.startsWith('klaus-media://widget/'))
      if (!current) throw new Error('The Widget iframe is gone before the click')
      return current
    }
    const open = async id => {
      await clickWidgetButton(id)
      await waitFor(() => win.webContents.executeJavaScript('!!document.querySelector(".klaus-dialog-overlay:not(.closing) .klaus-dialog-confirm")'), `${id} confirmation`)
    }
    const clickWidgetButton = id => waitFor(async () => {
      await win.webContents.executeJavaScript(mountScript)
      try {
        return await liveFrame().executeJavaScript(`(() => {
          const button = document.getElementById(${JSON.stringify(id)})
          if (document.readyState !== 'complete' || !button) return false
          button.click()
          return true
        })()`)
      } catch (error) {
        // Re-presenting the transcript can detach the frame during navigation.
        if (/disposed|destroyed|detached|frame.*gone|context.*lost/i.test(String(error))) return false
        throw error
      }
    }, `Widget ${id} button ready`, { diagnose: () => win.webContents.executeJavaScript(mountScript), timeoutMs: 20_000 })
    const answer = async choice => {
      await win.webContents.executeJavaScript(`document.querySelector('.klaus-dialog-overlay:not(.closing) .klaus-dialog-${choice}').click(); true`)
      await waitFor(() => win.webContents.executeJavaScript('!document.querySelector(".klaus-dialog-overlay")'), `${choice} dialog close`)
    }
    phase = 'cancel'
    await open('cancel')
    await answer('cancel')
    checks.cancelDoesNotDeliver = sent().length === 0 && queued().length === 0
    phase = 'stale'
    await open('stale')
    currentRevision = 2
    await answer('confirm')
    currentRevision = 1
    checks.staleRevisionDoesNotDeliver = sent().length === 0 && queued().length === 0
    phase = 'cross'
    await open('cross')
    await win.webContents.executeJavaScript('window.currentSessionId = "other-session"; true')
    await answer('confirm')
    await win.webContents.executeJavaScript(`window.currentSessionId = ${JSON.stringify(sessionId)}; true`)
    checks.crossChatDoesNotDeliver = sent().length === 0 && queued().length === 0
    phase = 'draft'
    await clickWidgetButton('draft')
    const draft = await waitFor(async () => {
      const value = await win.webContents.executeJavaScript('document.getElementById("input").value')
      return value.includes('"count":6') ? value : null
    }, 'Widget draft')
    checks.draftOnlyAppends = draft === 'Existing draft\n[Widget: Counter]\n{"count":6}' && sent().length === 0 && queued().length === 0
    phase = 'send'
    await open('send')
    checks.confirmationBeforeSend = sent().length === 0
    await answer('confirm')
    await waitFor(() => sent().length === 1, 'chat:send')
    checks.runningAfterSend = await win.webContents.executeJavaScript(`window.isSessionRunning(${JSON.stringify(sessionId)})`)
    phase = 'queue'
    // The same tool result is presented again on a session the first send left
    // running: that state, not a second card, must route the message to the queue.
    await open('queue')
    await answer('confirm')
    await waitFor(() => queued().length === 1, 'chat:client-queue-add')
    const state = await win.webContents.executeJavaScript(`({
      draft: document.getElementById('input').value,
      attachment: !![...document.querySelectorAll('#previews .kls-attach-chip-name')].find(x => x.textContent.includes('widget-fixture-note.txt')),
      currentSessionId: window.currentSessionId,
    })`)
    const send = sent()[0]?.args?.[0]
    const queue = queued()[0]?.args?.[0]
    checks.sendOnlyWidgetText = sent().length === 1 && send?.sessionId === sessionId && send.text === '[Widget: Counter]\n{"count":1}' && (!send.media || send.media.length === 0)
    checks.queueOnlyWidgetText = queued().length === 1 && queue?.sessionId === sessionId && queue.item?.text === '[Widget: Counter]\n{"count":5}' && queue.item.media.length === 0 && queue.item.liveAttachments.length === 0 && queue.item.pastedCards.length === 0 && queue.item.selectedTextAttachments.length === 0
    checks.queueHasNoEditAnchor = queue?.afterId == null && queue?.beforeId == null
    checks.draftAndAttachmentPreserved = state.currentSessionId === sessionId && state.draft === draft && state.attachment
    process.stdout.write(`WIDGET_FULL_CHAT_RESULT=${JSON.stringify({ checks, info, send, queue, draft })}\n`)
  } catch (error) {
    process.stdout.write(`WIDGET_FULL_CHAT_RESULT=${JSON.stringify({ checks, info, error: `${phase}: ${String(error)}`, callsTail: calls.slice(-12) })}\n`)
    process.exitCode = 1
  } finally {
    win.destroy()
    media.close()
    protocol.unhandle('klaus-media')
    frontend.close()
  }
}
app.whenReady().then(main).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 }).finally(() => app.quit())
