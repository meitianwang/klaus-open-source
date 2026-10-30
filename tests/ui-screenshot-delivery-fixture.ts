import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, nativeImage, protocol } from 'electron'
import { createServer } from 'node:http'
import { copyFile, mkdir, readFile, realpath, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { strict as assert } from 'node:assert'
import { once } from 'node:events'
import { MediaFiles } from '../main/services/media-files'
import { ImageActions } from '../main/services/image-actions'
import { ImageZoomCommands } from '../main/app/image-zoom-commands'
import { PNG_FIXTURE_BASE64 } from './fixtures/media'
import { SessionArtifactPaths, recordArtifactPathsFromHistory } from '../main/services/artifact-paths'
import { realpathSync } from 'node:fs'
import { projectSessionHistory } from '../main/sessions/history'
import { createConversationMediaScope } from '../main/services/media-scope'

protocol.registerSchemesAsPrivileged([{ scheme: 'klaus-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])
app.setPath('userData', process.env.KLAUS_IMAGE_PROFILE!)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  const evidence = process.env.KLAUS_IMAGE_EVIDENCE_DIR!, owner = 'screenshot-owner'
  const root = await realpath(process.env.KLAUS_IMAGE_PROFILE!)
  const output = join(root, 'artifacts')
  const workspace = join(root, 'workspace')
  await mkdir(output); await mkdir(workspace)
  const first = join(output, 'verified, UI (one).png'), second = join(output, 'second.png'), saved = join(root, 'saved.png')
  const source = process.env.KLAUS_IMAGE_SOURCE
  if (source) await copyFile(source, first); else await writeFile(first, Buffer.from(PNG_FIXTURE_BASE64, 'base64'))
  await copyFile(first, second)
  let bytes: Buffer = await readFile(first)
  let missing = true
  const server = createServer((request, response) => {
    if (missing && request.url === '/missing.png') { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); response.end(bytes)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  process.env.KLAUS_IMAGE_REMOTE = 'http://127.0.0.1:' + address.port + '/screenshot.png'
  process.env.KLAUS_IMAGE_FIRST = first; process.env.KLAUS_IMAGE_SECOND = second
  let allowed = true, revealed = '', requestedName = '', copied = 0
  const attachments: Array<{ target: string; bytes: number[] }> = [], reads: Array<{ owner: string; path: string }> = []
  const mediaConfigRoot = process.env.KLAUS_IMAGE_CONFIG_ROOT || root
  const publicationRoot = join(mediaConfigRoot, 'artifacts')
  let ledger = new SessionArtifactPaths({ canonicalize: realpathSync, publishedImageRoot: output })
  const mediaScope = createConversationMediaScope({
    configRoot: mediaConfigRoot,
    prepareSessionMedia: async () => true,
    resolveSessionDirectory: () => workspace,
    extraRoots: () => [],
    producedBySession: (path, sessionId) => ledger.has(sessionId, path),
  })
  const media = new MediaFiles(async (path, sessionId) => allowed && mediaScope(path, sessionId))
  const publication = projectSessionHistory({ history: [
    { type: 'assistant', uuid: 'capture-command', content: [{ type: 'tool_use', id: 'shell', name: 'bash', input: { command: 'node capture.mjs' } }] },
    { type: 'tool_result', toolUseId: 'shell', content: [{ type: 'text', text: 'Header measurement complete' }], output: { exitCode: 0 } },
    { type: 'assistant', uuid: 'final', content: [{ type: 'text', text: `![Verified UI](<${first}>)\n\n![Second UI](<${second}>)` }] },
  ] }, owner, root)
  const actions = new ImageActions({ media, saveDialog: async name => { requestedName = name; return saved },
    copyImage: async png => { const image = nativeImage.createFromBuffer(png); assert(!image.isEmpty()); await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]); copied++ },
    reveal: path => { revealed = path } })
  protocol.handle('klaus-media', request => media.respond(request))
  for (const method of ['read', 'save', 'copy', 'reveal'] as const) ipcMain.handle('image-test:' + method, (_, args) => actions[method](args))
  ipcMain.handle('image-test:clipboard', async (_, text) => { await clipboard.writeText(text); return { ok: true } })
  ipcMain.handle('image-test:attach', (_, value) => { attachments.push(value); return { ok: true } })
  ipcMain.handle('image-test:file-url', async (_, args) => { reads.push(args); return { ok: true, url: await media.grant(args.path, args.owner) } })
  ipcMain.handle('image-test:read-artifact', (_, args) => { reads.push(args); return { ok: false, error: 'Image tabs must retain their original source' } })
  const window = new BrowserWindow({ width: 1180, height: 840, show: false,
    webPreferences: { preload: join(dirname(process.env.KLAUS_IMAGE_HTML!), 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  window.webContents.on('console-message', details => { process.stderr.write('Renderer: ' + details.message + '\n') })
  const evaluate = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  const zoomCommands = new ImageZoomCommands({
    onBeforeInput: listener => { window.webContents.on('before-input-event', listener); return () => window.webContents.removeListener('before-input-event', listener) },
    evaluate,
    nativeZoom: command => window.webContents.setZoomLevel(command === 'fit' ? 0 : window.webContents.getZoomLevel() + (command === 'in' ? .5 : -.5)),
  })
  zoomCommands.start()
  const until = async (code: string) => {
    for (let count = 0; count < 200; count++) { if (await evaluate<boolean>(code)) return; await wait(20) }
    throw new Error('DOM timeout: ' + code + '; ' + JSON.stringify(await evaluate('window.uiScreenshotFixture?.inspect()')))
  }
  const checks: Record<string, boolean> = {}
  const check = async (name: string, value: boolean) => {
    checks[name] = value; await appendFile(join(evidence, 'steps.log'), name + ': ' + value + '\n')
    assert(value, name)
  }
  const click = (selector: string) => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()')
  const key = async (value: string) => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode: value }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: value }); await wait(35) }
  const capture = async (name: string) => { await wait(50); await writeFile(join(evidence, name + '.png'), (await window.webContents.capturePage()).toPNG()) }
  try {
    const originalUrl = `klaus-media://localhost/${Buffer.from(first).toString('base64url')}?s=${owner}`
    await check('shellImageDeniedBeforePublication', (await media.respond(new Request(originalUrl))).status === 403)
    recordArtifactPathsFromHistory(ledger, owner, publication)
    await check('shellImageRestoredFromRealHistoryProjection', (await actions.read({ sessionId: owner, filePath: first, inspect: true })).ok === true)
    await check('unrelatedChatCannotReadPublishedScreenshot', (await actions.read({ sessionId: 'other-chat', filePath: first, inspect: true })).ok === false)
    await window.loadFile(process.env.KLAUS_IMAGE_HTML!)
    window.showInactive()
    await until('window.uiScreenshotFixture && document.querySelector("#messages .msg.assistant img")?.naturalWidth > 0')
    if (process.env.KLAUS_IMAGE_REPLAY_HISTORY) {
      const snapshots = JSON.parse(await readFile(process.env.KLAUS_IMAGE_REPLAY_HISTORY, 'utf8')) as Array<{
        sessionId: string; history: any; final: any; paths: string[];
      }>
      for (const [index, snapshot] of snapshots.entries()) {
        // Restore saved evidence through the production publication root. No
        // workspace or output directory is granted directly by this fixture.
        ledger = new SessionArtifactPaths({ canonicalize: realpathSync, publishedImageRoot: publicationRoot })
        recordArtifactPathsFromHistory(ledger, snapshot.sessionId, snapshot.history)
        await evaluate(`window.uiScreenshotFixture.history(${JSON.stringify([snapshot.final])}, ${JSON.stringify(snapshot.sessionId)})`)
        await until(`document.querySelectorAll("#messages .msg.assistant img").length === ${snapshot.paths.length} && [...document.querySelectorAll("#messages .msg.assistant img")].every(image => image.naturalWidth > 0)`)
        await check(`originalHistory${index}LoadsPublishedImages`, true)
        await check(`originalHistory${index}KeepsOwner`, await evaluate(`[...document.querySelectorAll("#messages [data-media-session]")].every(node => node.dataset.mediaSession === ${JSON.stringify(snapshot.sessionId)})`))
        await evaluate('document.querySelector("#messages .msg.assistant img").scrollIntoView({block:"center"})')
        await capture(`original-history-${index}`)
        // Recreate the host ledger and the transcript again to exercise a second
        // cold reopen rather than retaining a lucky live grant.
        ledger = new SessionArtifactPaths({ canonicalize: realpathSync, publishedImageRoot: publicationRoot })
        recordArtifactPathsFromHistory(ledger, snapshot.sessionId, snapshot.history)
        await evaluate('window.uiScreenshotFixture.unmount()')
        await evaluate(`window.uiScreenshotFixture.history(${JSON.stringify([snapshot.final])}, ${JSON.stringify(snapshot.sessionId)})`)
        await until(`document.querySelectorAll("#messages .msg.assistant img").length === ${snapshot.paths.length} && [...document.querySelectorAll("#messages .msg.assistant img")].every(image => image.naturalWidth > 0)`)
        await check(`originalHistory${index}ColdReopenLoadsPublishedImages`, true)
      }
      ledger = new SessionArtifactPaths({ canonicalize: realpathSync, publishedImageRoot: output })
      recordArtifactPathsFromHistory(ledger, owner, publication)
      await evaluate('window.uiScreenshotFixture.final(false)')
      await until('document.querySelector("#messages .msg.assistant img")?.naturalWidth > 0')
    }
    if (!source) {
      bytes = (await window.webContents.capturePage()).toPNG()
      await writeFile(first, bytes); await writeFile(second, bytes)
      const loaded = once(window.webContents, 'did-finish-load'); window.webContents.reload(); await loaded
      await until('window.uiScreenshotFixture && document.querySelector("#messages .msg.assistant img")?.naturalWidth > 100')
    }
    await check('finalMarkdownLoadsWithOwningScope', await evaluate('window.uiScreenshotFixture.inspect().finalImages === 1 && window.uiScreenshotFixture.inspect().sourceOwners.every(owner => owner === "screenshot-owner")'))
    await check('observationsNotDuplicatedAtTurnEnd', await evaluate('window.uiScreenshotFixture.inspect().figures === 1'))
    await capture('final-reply')
    for (const replay of [false, true]) {
      await evaluate(`window.uiScreenshotFixture.sentAttachment(${replay})`)
      await until('document.querySelector("button[data-media-thumb] img")?.naturalWidth > 0')
      await check(replay ? 'replayedAttachmentRetainsOwner' : 'optimisticAttachmentRetainsOwner',
        await evaluate('document.querySelector("button[data-media-thumb]").dataset.mediaSession === "screenshot-owner"'))
      await click('button[data-media-thumb]')
      await until('document.querySelector(".image-preview-stage img")?.naturalWidth > 0')
      await check(replay ? 'replayedAttachmentPreviewLoads' : 'optimisticAttachmentPreviewLoads',
        await evaluate('document.querySelector(".image-preview-status").hidden'))
      await capture(replay ? 'replayed-attachment-preview' : 'optimistic-attachment-preview')
      await click('[data-image-control="close"]')
    }
    await evaluate('window.uiScreenshotFixture.live()')
    await until('document.querySelector("[data-activity-toggle]") !== null')
    if (await evaluate('document.querySelector("[data-activity-toggle]").getAttribute("aria-expanded") === "false"')) await click('[data-activity-toggle]')
    await until('document.querySelector("[data-tool-call-id=live-capture]") !== null')
    await check('liveCaptureStaysInToolCard', await evaluate('document.querySelectorAll(".msg.assistant img").length === 0'))
    await evaluate('window.uiScreenshotFixture.deliver()')
    await until('document.querySelector(".msg.assistant img")?.naturalWidth > 0')
    await check('streamedFinalImageIsDelivered', await evaluate('document.querySelectorAll(".msg.assistant img").length === 1'))
    await evaluate('window.uiScreenshotFixture.final(true)')
    await until('window.uiScreenshotFixture.inspect().loaded')
    await check('historyReopenKeepsOneImage', await evaluate('window.uiScreenshotFixture.inspect().figures === 1'))
    await evaluate('document.getElementById("composer").focus(); window.uiScreenshotFixture.gallery()')
    await until('document.querySelector(".image-preview-stage img")?.naturalWidth > 0')
    await check('galleryAndFitControlsPresent', await evaluate('["previous","next","out","in","fit","actual","save","menu","close"].every(id => document.querySelector("[data-image-control=" + id + "]"))'))
    await capture('image-preview')
    const fitValue = await evaluate<number>('Number(document.querySelector(".image-preview-viewer").dataset.imageScale)')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
    await until('Number(document.querySelector(".image-preview-viewer").dataset.imageScale) > ' + fitValue)
    await check('platformZoomShortcutTargetsImageNotWindow', window.webContents.getZoomLevel() === 0)
    await zoomCommands.dispatch('fit')
    await until('(()=>{const stage=document.querySelector(".image-preview-stage"),img=stage.querySelector("img");return Math.abs(Number(document.querySelector(".image-preview-viewer").dataset.imageScale)-Math.min(1,stage.clientWidth/img.naturalWidth,stage.clientHeight/img.naturalHeight))<1e-8})()')
    await check('platformResetMeansFit', window.webContents.getZoomLevel() === 0)
    const initialScale = await evaluate<number>('Number(document.querySelector(".image-preview-viewer").dataset.imageScale)')
    await click('[data-image-control="in"]')
    const scale = await evaluate<number>('Number(document.querySelector(".image-preview-viewer").dataset.imageScale)')
    await check('zoomControlChangesScale', scale > initialScale)
    const stage = await evaluate<{ x: number; y: number }>('(()=>{const r=document.querySelector(".image-preview-stage").getBoundingClientRect();return {x:Math.round(r.left+r.width*.7),y:Math.round(r.top+r.height*.65)}})()')
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: stage.x, y: stage.y, deltaY: 24, deltaX: 0, modifiers: ['control'] })
    await until('Number(document.querySelector(".image-preview-viewer").dataset.imageScale) !== ' + scale)
    await check('anchoredControlWheelChangesScale', await evaluate('Number(document.querySelector(".image-preview-viewer").dataset.imageScale) !== ' + scale))
    for (let count = 0; count < 12; count++) await click('[data-image-control="in"]')
    const scrollBefore = await evaluate<string>('JSON.stringify([document.querySelector(".image-preview-stage").scrollLeft,document.querySelector(".image-preview-stage").scrollTop])')
    window.webContents.sendInputEvent({ type: 'mouseMove', x: stage.x, y: stage.y })
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: stage.x, y: stage.y, deltaY: 80, deltaX: 80, modifiers: 0 })
    await wait(250)
    await appendFile(join(evidence, 'steps.log'), 'Pan metrics: ' + await evaluate('JSON.stringify({before:' + scrollBefore + ',left:document.querySelector(".image-preview-stage").scrollLeft,top:document.querySelector(".image-preview-stage").scrollTop,width:document.querySelector(".image-preview-stage").clientWidth,height:document.querySelector(".image-preview-stage").clientHeight,scrollWidth:document.querySelector(".image-preview-stage").scrollWidth,scrollHeight:document.querySelector(".image-preview-stage").scrollHeight})') + '\n')
    await check('ordinaryWheelUsesNativePanBounds', await evaluate('JSON.stringify([document.querySelector(".image-preview-stage").scrollLeft,document.querySelector(".image-preview-stage").scrollTop]) !== ' + JSON.stringify(scrollBefore)))
    await click('[data-image-control="out"]')
    await click('[data-image-control="out"]')
    const touchScale = await evaluate<number>('Number(document.querySelector(".image-preview-viewer").dataset.imageScale)')
    const touch = async (type: string, points: Array<{ x: number; y: number; id: number }>) => {
      await window.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type, touchPoints: points })
      await wait(40)
    }
    const leftFinger = { x: stage.x - 50, y: stage.y, id: 0 }, rightFinger = { x: stage.x + 50, y: stage.y, id: 1 }
    await touch('touchStart', [leftFinger, rightFinger])
    await touch('touchMove', [{ ...leftFinger, x: stage.x - 75 }, { ...rightFinger, x: stage.x + 75 }])
    await check('touchPinchChangesScale', await evaluate('Number(document.querySelector(".image-preview-viewer").dataset.imageScale) > ' + touchScale))
    await touch('touchMove', [{ ...leftFinger, x: stage.x - 75 }])
    const beforeDrag = await evaluate<string>('JSON.stringify([document.querySelector(".image-preview-stage").scrollLeft,document.querySelector(".image-preview-stage").scrollTop])')
    await touch('touchMove', [{ ...leftFinger, x: stage.x - 120, y: stage.y - 45 }])
    await check('remainingTouchContinuesPanning', await evaluate('JSON.stringify([document.querySelector(".image-preview-stage").scrollLeft,document.querySelector(".image-preview-stage").scrollTop]) !== ' + JSON.stringify(beforeDrag)))
    await touch('touchEnd', [])
    await click('[data-image-control="fit"]')
    await check('fitResetsNativeScroll', await evaluate('document.querySelector(".image-preview-stage").scrollLeft === 0 && document.querySelector(".image-preview-stage").scrollTop === 0'))
    await evaluate('document.querySelector(".image-preview-stage").dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,key:"ArrowRight",ctrlKey:true}));document.querySelector(".image-preview-stage").dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,key:"ArrowRight",isComposing:true}))')
    await check('modifiedAndCompositionKeysKeepGalleryPosition', await evaluate('document.querySelector(".image-preview-caption").textContent.includes("1 / 2")'))
    await key('Right')
    await until('document.querySelector(".image-preview-caption").textContent.includes("2 / 2")')
    await check('keyboardNavigatesGallery', true)
    await click('[data-image-control="menu"]')
    await check('localMenuContainsFullActions', await evaluate('[...document.querySelectorAll("[data-image-action]")].map(node=>node.dataset.imageAction).join(",") === "open,add,copy,reveal,save"'))
    const focused = await evaluate<string>('document.activeElement.dataset.imageAction')
    await key('Tab')
    await check('menuTabAdvancesFocus', await evaluate('document.activeElement.dataset.imageAction !== ' + JSON.stringify(focused)))
    await capture('image-menu')
    await key('Escape')
    await check('menuEscapeKeepsViewer', await evaluate('!document.querySelector(".image-preview-menu") && !!document.querySelector(".image-lightbox")'))
    await click('[data-image-control="menu"]')
    await click('[data-image-action="copy"]')
    await check('menuSelectionRestoresViewerFocus', await evaluate('document.activeElement.dataset.imageControl === "menu"'))
    for (let count = 0; count < 100 && copied < 1; count++) await wait(20)
    await check('copyWritesNativeImage', copied === 1 && await clipboard.has('image/png'))
    await evaluate('window.uiScreenshotFixture.action("save")')
    await check('savePreservesOriginalBytesAndMime', (await readFile(saved)).equals(bytes) && requestedName.endsWith('.png'))
    await evaluate('window.uiScreenshotFixture.action("reveal")')
    await check('revealUsesOriginalScopedPath', revealed === first)
    await evaluate('window.uiScreenshotFixture.action("add")')
    await check('addImageTargetsCurrentComposerWithoutSending', attachments.length === 1 && attachments[0]!.target === 'foreign-current-chat' && Buffer.from(attachments[0]!.bytes).equals(bytes))
    await evaluate('window.uiScreenshotFixture.action("copy", true)')
    await check('remotePixelsUseNativeClipboard', copied === 2 && await clipboard.has('image/png'))
    await evaluate('window.uiScreenshotFixture.action("address", true)')
    await check('remoteAddressCopyIsAvailable', await clipboard.readText() === process.env.KLAUS_IMAGE_REMOTE)
    await key('Escape')
    await check('closeRestoresComposerFocus', await evaluate('!document.querySelector(".image-lightbox") && document.activeElement.id === "composer" && document.body.style.overflow !== "hidden"'))
    await evaluate('window.uiScreenshotFixture.broken()')
    await until('!document.querySelector(".image-preview-retry").hidden && document.querySelector(".image-preview-stage img").hidden')
    await check('failedImageKeepsRetryAndGalleryNavigation', await evaluate('!document.querySelector("[data-image-control=next]").disabled && document.querySelector("[data-image-control=save]").disabled'))
    missing = false
    await click('.image-preview-retry')
    await until('document.querySelector(".image-preview-stage img")?.naturalWidth > 0 && document.querySelector(".image-preview-status").hidden')
    await check('retryLoadsRecoveredOriginal', true)
    await key('Escape')
    await evaluate('window.uiScreenshotFixture.gallery()')
    await until('document.querySelector(".image-preview-stage img")?.naturalWidth > 0')
    await click('[data-image-control="menu"]')
    await click('[data-image-action="open"]')
    await check('menuOpenCreatesWorkspaceImageTab', await evaluate('document.querySelectorAll("#workspace-file-tabs [role=tab]").length === 1 && !document.querySelector(".image-lightbox")'))
    await until('document.activeElement.classList.contains("image-preview-stage")')
    await check('openedImageTabReceivesKeyboardFocus', true)
    await until('document.querySelector("#workspace-file-body .image-preview-stage img")?.naturalWidth > 0')
    await click('#workspace-file-body [data-image-control="menu"]')
    const menuScale = await evaluate<number>('Number(document.querySelector("#workspace-file-body .image-preview-viewer").dataset.imageScale)')
    await zoomCommands.dispatch('in')
    await check('artifactMenuRetainsImageZoomOwnership', await evaluate('!!document.querySelector(".image-preview-menu") && Number(document.querySelector("#workspace-file-body .image-preview-viewer").dataset.imageScale) > ' + menuScale) && window.webContents.getZoomLevel() === 0)
    await key('Escape')
    await click('#workspace-file-body [data-image-control="in"]')
    const tabScale = await evaluate<number>('Number(document.querySelector("#workspace-file-body .image-preview-viewer").dataset.imageScale)')
    await evaluate('window.uiScreenshotFixture.tab(true)')
    await until('document.querySelector("#workspace-file-body .image-preview-stage img")?.naturalWidth > 0')
    await evaluate('document.querySelector("#workspace-file-tabs [role=tab]").click()')
    await until('document.querySelector("#workspace-file-body .image-preview-stage img")?.naturalWidth > 0')
    await check('tabSwitchRestoresImageZoom', await evaluate('Number(document.querySelector("#workspace-file-body .image-preview-viewer").dataset.imageScale) === ' + tabScale))
    await check('imageTabsRetainSourceAndDoNotReadVirtualKeys', reads.length === 0)
    await check('imageTabsUseActualWorkspaceSurface', await evaluate('document.querySelectorAll("#workspace-file-tabs [role=tab]").length === 2 && document.getElementById("workspace-file-title").textContent.includes("Verified UI")'))
    await capture('workspace-image-tab')
    ledger = new SessionArtifactPaths({ canonicalize: realpathSync, publishedImageRoot: output })
    recordArtifactPathsFromHistory(ledger, owner, publication)
    const reloaded = once(window.webContents, 'did-finish-load'); window.webContents.reload(); await reloaded
    await until('window.uiScreenshotFixture && document.querySelector("#messages .msg.assistant img")?.naturalWidth > 0')
    await check('coldLedgerReloadRestoresShellScreenshot', await evaluate('window.uiScreenshotFixture.inspect().loaded'))
    await evaluate('window.uiScreenshotFixture.tab()')
    await until('document.querySelector("#workspace-file-body .image-preview-stage img")?.naturalWidth > 0')
    await check('restartRestoresManualArtifactZoom', await evaluate('Number(document.querySelector("#workspace-file-body .image-preview-viewer").dataset.imageScale) === ' + tabScale))
    await click('#workspace-file-body [data-image-control="fit"]')
    await check('fitClearsPersistedManualZoom', await evaluate('Object.keys(JSON.parse(localStorage.getItem("klaus.image-tab-zoom.v1") || "{}")).length === 0'))
    await evaluate('window.currentSessionId="another-container"; window.uiScreenshotFixture.tab()')
    await until('document.querySelector("#workspace-file-body .image-preview-stage img")?.naturalWidth > 0')
    await check('tabAcrossChatSwitchKeepsOriginalOwner', (await actions.read({ sessionId: owner, filePath: first })).ok === true && (await actions.read({ sessionId: 'another-container', filePath: first })).ok === false)
    await evaluate('window.uiScreenshotFixture.hideTab(); document.getElementById("artifacts-panel").hidden=true; window.uiScreenshotFixture.final(false)')
    await until('document.querySelector("#messages [data-media-figure] img")?.naturalWidth > 0')
    await evaluate('document.querySelector("#messages [data-media-figure]").dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,clientX:100,clientY:100}))')
    await check('transcriptContextMenuWorks', await evaluate('!!document.querySelector(".image-preview-menu")'))
    await evaluate('window.uiScreenshotFixture.unmount()')
    await check('unmountClosesMenuAndListeners', await evaluate('!document.querySelector(".image-preview-menu")'))
    await evaluate('window.currentSessionId="";window.promoteImageDraft=false;window.uiScreenshotFixture.gallery()')
    await until('document.querySelector(".image-preview-stage img")?.naturalWidth > 0')
    await evaluate('window.uiScreenshotFixture.action("open")')
    await check('failedDraftOpenKeepsPreviewAndReportsFailure', await evaluate('!!document.querySelector(".image-lightbox") && [...document.querySelectorAll(".toast-message")].some(message => message.textContent.includes("失败"))'))
    await evaluate('window.promoteImageDraft=true;window.deferImageDraft=true;window.imageOpenPending=window.uiScreenshotFixture.action("open");true')
    await until('typeof window.resolveImageDraft === "function"')
    await evaluate('window.uiScreenshotFixture.gallery(true)')
    await until('document.querySelector(".image-lightbox .image-preview-stage img")?.naturalWidth > 0')
    await evaluate('window.resolveImageDraft();window.imageOpenPending')
    await until('document.querySelector("#workspace-file-body .image-preview-stage img")?.naturalWidth > 0')
    await wait(80)
    await check('oldOpenCannotCloseOrStealFocusFromNewPreview', await evaluate('document.querySelector(".image-lightbox .image-preview-caption").textContent.includes("Second screenshot") && document.querySelector(".image-lightbox").contains(document.activeElement)'))
    const backgroundScale = await evaluate<number>('Number(document.querySelector("#workspace-file-body .image-preview-viewer").dataset.imageScale)')
    const foregroundScale = await evaluate<number>('Number(document.querySelector(".image-lightbox .image-preview-viewer").dataset.imageScale)')
    await zoomCommands.dispatch('in')
    await check('visibleModalOwnsZoomAboveNewArtifactViewer', await evaluate('Number(document.querySelector("#workspace-file-body .image-preview-viewer").dataset.imageScale) === ' + backgroundScale + ' && Number(document.querySelector(".image-lightbox .image-preview-viewer").dataset.imageScale) > ' + foregroundScale) && window.webContents.getZoomLevel() === 0)
    await key('Escape')
    await evaluate('window.deferImageDraft=false;window.uiScreenshotFixture.gallery();window.uiScreenshotFixture.action("open")')
    await until('!document.querySelector(".image-lightbox") && document.querySelector("#workspace-file-body .image-preview-stage img")?.naturalWidth > 0')
    await check('draftOpenPromotesAndPreservesOriginalOwner', await evaluate('window.currentSessionId === "promoted-image-draft" && document.querySelectorAll("#workspace-file-tabs [role=tab]").length === 1'))
    await evaluate('window.uiScreenshotFixture.hideTab()')
    allowed = false; media.revokeSession(owner)
    await check('revocationBlocksNativeActions', (await actions.copy({ sessionId: owner, filePath: first })).ok === false)
    await writeFile(join(evidence, 'checks.json'), JSON.stringify(checks, null, 2))
    process.stdout.write('SCREENSHOT_DELIVERY_RESULT=' + JSON.stringify(checks) + '\n')
  } catch (error) {
    await capture('failure')
    await writeFile(join(evidence, 'failure.json'), JSON.stringify({ checks, error: String(error), dom: await evaluate('document.body.innerHTML'),
      imageGeometry: await evaluate(`Array.from(document.querySelectorAll('.image-preview-stage')).map(stage => {
        const image = stage.querySelector('img'); return {
          clientWidth: stage.clientWidth, clientHeight: stage.clientHeight,
          offsetWidth: stage.offsetWidth, offsetHeight: stage.offsetHeight,
          scrollWidth: stage.scrollWidth, scrollHeight: stage.scrollHeight,
          naturalWidth: image?.naturalWidth, naturalHeight: image?.naturalHeight,
          overflow: getComputedStyle(stage).overflow,
          scale: stage.closest('.image-preview-viewer')?.dataset.imageScale
        }
      })`) }, null, 2))
    throw error
  } finally { zoomCommands.close(); window.destroy(); media.close(); protocol.unhandle('klaus-media'); await new Promise<void>(resolve => server.close(() => resolve())) }
}
app.whenReady().then(main).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1 }).finally(() => app.quit())
