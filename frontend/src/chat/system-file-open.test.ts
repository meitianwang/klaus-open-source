import { describe, expect, test } from 'bun:test'
import { isAnchorBoxVisibleInViewport } from '../app/feature-onboarding/tour'
import { hasCollapsedInlineSize } from './transcript/virtual-turn-list'
import {
  fileBelongsToSession,
  handleSystemOpenFiles,
  pathWithinDirectory,
  shouldWidenPanelForOpenedFiles,
} from './system-file-open'

describe('VirtualTurnList collapsed inline width guard', () => {
  test('treats zero-width maximized chat column as collapsed while keeping normal and zero-zero synthetic boxes distinct', () => {
    const hidden = { getClientRects: () => [] } as unknown as HTMLElement
    const zeroWidthMaximized = {
      getClientRects: () => [{ width: 0, height: 652, top: 0, left: 0, right: 0, bottom: 652 }],
    } as unknown as HTMLElement
    const visible = {
      getClientRects: () => [{ width: 520, height: 652, top: 0, left: 300, right: 820, bottom: 652 }],
    } as unknown as HTMLElement
    const syntheticZero = {
      getClientRects: () => [{ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }],
    } as unknown as HTMLElement

    expect(hasCollapsedInlineSize(null)).toBe(true)
    expect(hasCollapsedInlineSize(hidden)).toBe(true)
    expect(hasCollapsedInlineSize(zeroWidthMaximized)).toBe(true)
    expect(hasCollapsedInlineSize(visible)).toBe(false)
    expect(hasCollapsedInlineSize(syntheticZero)).toBe(false)
  })
})

describe('FeatureTour viewport visibility guard', () => {
  test('rejects off-screen anchors while the right panel is sliding into the viewport', () => {
    expect(isAnchorBoxVisibleInViewport({ left: 1327.5, top: 88, width: 220, height: 640 }, 1180, 820)).toBe(false)
    expect(isAnchorBoxVisibleInViewport({ left: -240, top: 88, width: 220, height: 640 }, 1180, 820)).toBe(false)
    expect(isAnchorBoxVisibleInViewport({ left: 940, top: 88, width: 0, height: 640 }, 1180, 820)).toBe(false)
    expect(isAnchorBoxVisibleInViewport({ left: 940, top: 88, width: 220, height: 640 }, 1180, 820)).toBe(true)
    expect(isAnchorBoxVisibleInViewport({ left: 1327.5, top: 88, width: 220, height: 640 }, 0, 0)).toBe(true)
  })
})

describe('System file open session preservation', () => {
  test('matches files belonging to the active conversation across workspace roots, artifacts, resources, citations, and visualizations', () => {
    expect(pathWithinDirectory('/tmp/demo', '/tmp/demo/index.html')).toBe(true)
    expect(pathWithinDirectory('/tmp/demo', '/tmp/demo-other/index.html')).toBe(false)

    expect(fileBelongsToSession({
      sessionId: 'chat-1',
      filePath: '/tmp/demo/project/Main.dc.html',
      roots: ['/tmp/demo'],
    })).toBe(true)

    expect(fileBelongsToSession({
      sessionId: 'chat-1',
      filePath: '/tmp/output/landing.html',
      hasEndResource: true,
    })).toBe(true)

    expect(fileBelongsToSession({
      sessionId: 'chat-1',
      filePath: '/tmp/profile/.klaus/visualizations/chat-1/chart.html',
    })).toBe(true)

    expect(fileBelongsToSession({
      sessionId: 'chat-1',
      filePath: '/tmp/downloads/unrelated.html',
      roots: ['/tmp/demo'],
    })).toBe(false)
  })

  test('reuses active conversation without resetting chat or widening panel when opening session-owned HTML', async () => {
    let activeId: string | null = 'session-active'
    let newChats = 0
    let widened = 0
    const attached: string[][] = []
    const opened: string[] = []

    await handleSystemOpenFiles({ files: ['/workspace/app/index.html'] }, {
      currentSessionId: () => activeId,
      inChatView: () => true,
      findSession: () => ({ archived: false, sshHostId: null }),
      sessionWorkdir: () => '/workspace/app',
      workspaceRootFor: () => '/workspace/app',
      hasOpenWorkspaceTabs: () => false,
      sessionHasArtifactPath: () => false,
      endResourcesForSession: () => [],
      draftProjectWorkdir: () => null,
      newProjectlessChat: () => { newChats++; activeId = null },
      ensureSession: async () => activeId ?? 'session-new',
      attachFiles: files => attached.push([...files]),
      widenOfficePanel: () => { widened++ },
      openFile: path => opened.push(path),
    })

    expect(newChats).toBe(0)
    expect(activeId).toBe('session-active')
    expect(attached).toEqual([])
    expect(widened).toBe(0)
    expect(opened).toEqual(['/workspace/app/index.html'])
  })

  test('widens panel only for office documents and keeps normal split width for standalone HTML files', async () => {
    expect(shouldWidenPanelForOpenedFiles(['/tmp/report.html'])).toBe(false)
    expect(shouldWidenPanelForOpenedFiles(['/tmp/sheet.xlsx'])).toBe(true)

    let activeId: string | null = 'session-active'
    let newChats = 0
    let widened = 0
    const attached: string[][] = []
    const opened: string[] = []

    await handleSystemOpenFiles({ files: ['/external/standalone.html'] }, {
      currentSessionId: () => activeId,
      inChatView: () => true,
      findSession: () => ({ archived: false, sshHostId: null }),
      sessionWorkdir: () => '/workspace/app',
      workspaceRootFor: () => '/workspace/app',
      hasOpenWorkspaceTabs: () => false,
      sessionHasArtifactPath: () => false,
      endResourcesForSession: () => [],
      draftProjectWorkdir: () => null,
      newProjectlessChat: () => { newChats++; activeId = null },
      ensureSession: async () => { activeId = 'session-external'; return activeId },
      attachFiles: files => attached.push([...files]),
      widenOfficePanel: () => { widened++ },
      openFile: path => opened.push(path),
    })

    expect(newChats).toBe(1)
    expect(activeId).toBe('session-external')
    expect(attached).toEqual([['/external/standalone.html']])
    expect(widened).toBe(0)
    expect(opened).toEqual(['/external/standalone.html'])
  })
})
