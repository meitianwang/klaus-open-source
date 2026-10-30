// DOM-verification entry for the create_thread TOOL ROW card.
//
// Built by esbuild with the css loader (like created-thread-dom-entry.ts); the
// built CSS is injected by the harness so geometry assertions run against the
// shipped stylesheet, not a re-implementation.
//
// The subject here is the React card, not the raw HTML builder, so this entry
// exports the REAL components: `ActivityToolContent` is the function the
// transcript calls for every tool row, and mounting it renders exactly what a
// settled `create_thread` row puts on screen — including the swap decided by
// `createdThreadCardId`.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createElement } from 'react'
import { ActivityToolContent } from './activity-tool'
import { createdThreadCardId, createdThreadIdFromToolResult } from './chat-activity'
import { renderCreatedThreadCardHtml, renderCreatedThreadListHtml } from './factories'
import { makeTranscriptClickHandler } from './TranscriptView'
import * as transcriptProjection from './TranscriptView'
import type { ActivityToolData } from './activity-tool-model'

/** The bare result object the host splits out of the `contentItems` envelope. */
export const RESULT_JSON = JSON.stringify({
  ok: true, threadId: 'thread-9', hostId: 'local', kind: 'klaus', title: null, delivered: 'started',
})

export const HOST_ENVELOPE = JSON.stringify({
  success: true, contentItems: [{ type: 'inputText', text: RESULT_JSON }],
})

/**
 * Mount one tool row into `host` through the real component.
 *
 * `flushSync` is what makes the render land before this returns: React 19's root
 * schedules its first commit on a microtask, so a caller that mounted and then
 * asserted would measure an empty host — which is precisely how the first run of
 * this harness reported every geometry case as a failure with nothing on screen.
 *
 * `open` is always false: a settled tool row renders collapsed by default, and
 * the question this harness answers is what a user sees WITHOUT expanding
 * anything.
 */
export function mountRow(host: HTMLElement, overrides: Partial<ActivityToolData> = {}): void {
  const tool: ActivityToolData = {
    toolCallId: 'call-create-1',
    toolName: 'create_thread',
    args: { prompt: 'Investigate the flaky test.' },
    state: 'done',
    output: RESULT_JSON,
    ...overrides,
  }
  const root = mountedRoots.get(host) ?? createRoot(host)
  mountedRoots.set(host, root)
  flushSync(() => {
    root.render(createElement(ActivityToolContent, {
      tool, open: false, onToggle: () => {}, locale: 'en',
    }))
  })
}

/** One root per host, so a re-mount updates instead of nesting a second tree. */
const mountedRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()

/** The real container delegate, wired to a recorder the harness can assert on. */
export function installClickHandler(host: HTMLElement, isReadOnly = false): { navigations: string[] } {
  const navigations: string[] = []
  ;(window as any).klausSwitchSession = (id: string) => { navigations.push(id) }
  const handler = makeTranscriptClickHandler(isReadOnly ? '' : 'current-session')
  host.addEventListener('click', handler)
  return { navigations }
}

/**
 * The real fold verdict for a whole turn, and the nodes it produced.
 *
 * This answers the question the task turned on — "does the fold hide the tool
 * row?" — from the pipeline itself rather than from reading the projection code:
 * `unitsFromMessages` + `foldUnits` are the two functions the transcript runs, so
 * a `create_thread` row that came out as a settled single-tool `item` is on
 * screen with nothing to expand, while one that landed in an `activity-fold`
 * `summary` group would be behind a disclosure (and would have lost its card).
 */
export function foldVerdict(messages: unknown[]): Record<string, unknown> {
  const { unitsFromMessages, foldUnits } = transcriptProjection
  const units = unitsFromMessages(messages as never[])
  const nodes = foldUnits(units, null, {}, {})
  const flatten = (list: any[], depth: number, out: any[]): void => {
    for (const node of list) {
      out.push({
        kind: node.kind,
        mode: node.mode,
        open: node.open,
        depth,
        toolNames: node.unit?.segment?.tools?.map((tool: any) => tool.toolName),
      })
      if (node.items) flatten(node.items, depth + 1, out)
    }
  }
  const flat: any[] = []
  flatten(nodes as any[], 0, flat)
  return { nodes: flat }
}

/** A settled `create_thread` turn with a final reply, in replay shape. */
export function createThreadTurn(): unknown[] {
  return [
    { role: 'user', uuid: 'u1', turnId: 't1', text: 'Create it.' },
    {
      role: 'assistant', uuid: 'a1', turnId: 't1',
      contentBlocks: [{
        type: 'tool_use', id: 'c1', name: 'create_thread',
        input: { prompt: 'Investigate the flaky test.' },
        __result: { content: [{ type: 'text', text: RESULT_JSON }], is_error: false },
      }],
    },
    { role: 'assistant', uuid: 'a2', turnId: 't1', text: 'Done.', isFinalReply: true },
  ]
}

/**
 * Mount a whole REPLAYED turn through `StaticTranscriptView` — the same component
 * a reopened conversation renders — so the tool-row card is proved to appear in
 * situ, not only when a bare row is mounted on its own.
 */
export function mountTurn(host: HTMLElement, messages: unknown[]): void {
  const StaticTranscriptView = (transcriptProjection as unknown as {
    StaticTranscriptView: (props: Record<string, unknown>) => unknown
  }).StaticTranscriptView
  const root = mountedRoots.get(host) ?? createRoot(host)
  mountedRoots.set(host, root)
  flushSync(() => {
    root.render(createElement(StaticTranscriptView as never, { msgs: messages, container: host }))
  })
}

export { createdThreadCardId, createdThreadIdFromToolResult, renderCreatedThreadCardHtml, renderCreatedThreadListHtml }
