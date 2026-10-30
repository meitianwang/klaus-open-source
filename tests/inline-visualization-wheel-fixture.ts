import { app, BrowserWindow } from 'electron'

app.setPath('userData', process.env.KLAUS_INLINE_VIS_PROFILE!)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type Snapshot = { top: number; following: boolean; guest: { root: number; nested: number; nestedLeft: number }; point: { x: number; y: number } }
async function main() {
  const window = new BrowserWindow({ show: true, width: 900, height: 740, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  const checks: Record<string, boolean> = {}
  const measurements: Record<string, unknown> = {}
  const run = (expression: string): Promise<Snapshot> => window.webContents.executeJavaScript(`window.inlineVisWheelFixture.${expression}`)
  const wheel = async (deltaY: number, deltaX = 0) => {
    const { point } = await run('read()')
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY: -deltaY })
    await wait(180)
    return run('read()')
  }
  try {
    window.webContents.debugger.attach('1.3')
    await window.loadFile(process.env.KLAUS_INLINE_VIS_HTML!)
    const before = await run('mount()')
    const up = await wheel(160)
    const afterFollow = await run('follow()')
    checks.inlineWheelScrollsTranscript = up.top < before.top - 100
    checks.upwardWheelReleasesFollowing = !up.following
    checks.followWriteKeepsReadingPosition = Math.abs(afterFollow.top - up.top) <= 1
    measurements.inline = { before, up, afterFollow }
    const down = await wheel(-80)
    checks.downwardWheelScrollsTranscript = down.top > afterFollow.top + 40
    measurements.down = down

    const nativeStart = await run("mount('native')")
    const native = await wheel(120)
    checks.nativeChainingDoesNotDoubleScroll = Math.abs(nativeStart.top - native.top - 120) <= 1 && !native.following
    measurements.native = { nativeStart, native }

    const nestedStart = await run("mount('nested')")
    await run("position('nested', 300)")
    const nested = await wheel(80)
    checks.nestedPanelKeepsItsScroll = nested.guest.nested < 250 && Math.abs(nested.top - nestedStart.top) <= 1
    await run("position('nested', 0)")
    const nestedBoundary = await wheel(120)
    checks.nestedBoundaryReturnsToTranscript = nestedBoundary.top < nested.top - 80 && !nestedBoundary.following
    measurements.nested = { nestedStart, nested, nestedBoundary }

    const horizontalStart = await run("mount('horizontal')")
    const horizontal = await wheel(4, 100)
    checks.horizontalPanelKeepsHorizontalGestures = Math.abs(horizontal.top - horizontalStart.top) <= 1 && horizontal.guest.nestedLeft > 80
    const diagonal = await wheel(120, 12)
    checks.diagonalUpwardWheelEscapesHorizontalPanel = diagonal.top < horizontal.top - 80 && !diagonal.following
    measurements.horizontal = { horizontalStart, horizontal, diagonal }

    const cappedStart = await run("mount('capped')")
    await run("position('root', 600)")
    const capped = await wheel(100)
    checks.cappedPageKeepsItsScroll = capped.guest.root < 550 && Math.abs(capped.top - cappedStart.top) <= 1
    await run("position('root', 0)")
    const cappedBoundary = await wheel(120)
    checks.cappedBoundaryReturnsToTranscript = cappedBoundary.top < capped.top - 80 && !cappedBoundary.following
    measurements.capped = { cappedStart, capped, cappedBoundary }

    const expandedStart = await run("mount('plain', true)")
    await run("position('root', 400)")
    const expanded = await wheel(100)
    checks.expandedPageDoesNotScrollBackground = Math.abs(expanded.top - expandedStart.top) <= 1 && expanded.guest.root < 350
    await run("position('root', 0)")
    const expandedBoundary = await wheel(120)
    checks.expandedBoundaryDoesNotScrollBackground = Math.abs(expandedBoundary.top - expandedStart.top) <= 1 && expandedBoundary.following
    const collapsedStart = await run('collapse()')
    const collapsed = await wheel(120)
    checks.collapseRestoresTranscriptScrolling = collapsed.top < collapsedStart.top - 80 && !collapsed.following
    measurements.expanded = { expandedStart, expanded, expandedBoundary, collapsedStart, collapsed }
    process.stdout.write(`INLINE_VIS_WHEEL_RESULT=${JSON.stringify({ checks, measurements })}\n`)
    if (Object.values(checks).some(value => !value)) process.exitCode = 1
  } finally { window.destroy() }
}
app.whenReady().then(main).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 }).finally(() => app.quit())
