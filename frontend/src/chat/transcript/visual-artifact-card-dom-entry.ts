// DOM-verification entry for the visual-surface artifact cards.
//
// Built by esbuild with the css loader; the harness injects the built CSS so
// geometry assertions run against the shipped stylesheet, not a re-implementation.
//
// The subject is the card a conversation offers when a visual tool finishes, and
// the question is the one that started this: after a 3D tool built a scene, was
// there ANY way for the user to open the panel it drew into? These checks render
// the real replay component (`StaticTranscriptView`) over real tool results, then
// click each card and record which panel entry point it reached.
//
// Self-driving, like inline-visualization-dom-entry.ts: everything runs in the
// page and the verdict is written to #result, because an IIFE bundle's exports are
// not reachable from outside the page.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createElement } from 'react'
import { StaticTranscriptView } from './TranscriptView'

const host = window as any
const hostEl = document.getElementById('messages')!
const root = createRoot(hostEl)

/** Panel entry points the cards are allowed to reach, recorded per click. */
const opened: Array<{ surface: string; id?: string; sessionId?: string }> = []
host.klausOpenModel3DPanel = (id?: string, sessionId?: string) => { opened.push({ surface: 'model3d', id, sessionId }) }
host.klausOpenDigramPanel = (id?: string, sessionId?: string) => { opened.push({ surface: 'digram', id, sessionId }) }
host.currentLang = 'zh'
host.tt = (key: string) => key

const CARD = '[class*="diagram-artifact-card"]'

function toolBlock(name: string, id: string, artifact: unknown, failed = false) {
  return {
    type: 'tool_use', id, name, input: {},
    // The shape the HOST projects before replay reaches the renderer: the card is
    // a structured `artifact` field, not JSON text buried in the tool output.
    // Feeding the raw tool envelope here would test a projection the renderer
    // never sees, and would pass for the wrong reason.
    __result: {
      content: [{ type: 'text', text: JSON.stringify({ artifact }) }],
      is_error: failed,
      ...(failed ? {} : { artifact }),
    },
  }
}

function turn(blocks: unknown[], reply: string) {
  return [
    { role: 'user', uuid: 'u1', turnId: 't1', text: 'Build it.' },
    { role: 'assistant', uuid: 'a1', turnId: 't1', contentBlocks: blocks },
    { role: 'assistant', uuid: 'a2', turnId: 't1', text: reply, isFinalReply: true },
  ]
}

let mountSeq = 0
function mount(messages: unknown[]): void {
  opened.length = 0
  // A fresh key per mount: the fixture turns reuse uuids, and without it React
  // would reconcile the previous tree in place instead of rebuilding it.
  const key = `turn-${mountSeq++}`
  // Do NOT clear the container by hand: React owns those nodes, and wiping them
  // under it leaves the next render diffing against DOM that no longer exists.
  // Rendering new props replaces the tree through React instead.
  // flushSync is what makes the render land before the next assertion: React 19
  // commits its first render on a microtask, so measuring right after render()
  // would read an empty host and report a card that is actually there as missing.
  flushSync(() => {
    root.render(createElement(StaticTranscriptView as never, {
      key, msgs: messages, container: hostEl, running: false, sessionId: 'scene-owner',
    }))
  })
}

function cards(): Array<{ text: string; visible: boolean; width: number; height: number }> {
  return Array.from(document.querySelectorAll(CARD)).map(node => {
    const element = node as HTMLElement
    const box = element.getBoundingClientRect()
    return {
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      visible: element.offsetParent !== null && box.height > 0 && box.width > 0,
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
  })
}

function clickCard(index: number): void {
  const element = document.querySelectorAll(CARD)[index] as HTMLElement | undefined
  element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

const checks: Record<string, boolean> = {}

function main(): void {
  // 1. A 3D scene produces a card the user can see and click. This is the whole
  //    regression: before the fix this turn rendered no card at all.
  mount(turn([toolBlock('mcp__klaus-model3d__model3d_scene', 'c3d',
    { kind: 'model3d', id: 'm3d-bewd', title: '青眼白龙' })], '建好了。'))
  let rendered = cards()
  checks.sceneCardRenders = rendered.length === 1
  checks.sceneCardIsOnScreen = rendered.length === 1 && rendered[0]!.visible && rendered[0]!.height >= 40
  checks.sceneCardCarriesTitleAndChineseCopy = rendered.length === 1
    && rendered[0]!.text.includes('青眼白龙')
    && rendered[0]!.text.includes('3D 场景已生成')
    && rendered[0]!.text.includes('打开 3D 场景')
  clickCard(0)
  checks.sceneCardOpensThe3DPanel = opened.length === 1
    && opened[0]!.surface === 'model3d'
    && opened[0]!.id === 'm3d-bewd'
    && opened[0]!.sessionId === 'scene-owner'

  // 2. Both surfaces in one turn each get their own card, and each click reaches
  //    its own panel — the diagram must not hijack the 3D one.
  mount(turn([
    toolBlock('mcp__klaus-model3d__model3d_scene', 'c3d', { kind: 'model3d', id: 'm3d-1', title: 'Scene' }),
    toolBlock('mcp__klaus-digram__digram_open', 'cdg', { kind: 'diagram', id: 'dgm-1', title: 'Rig' }),
  ], '两件都好了。'))
  rendered = cards()
  checks.bothSurfacesCarded = rendered.length === 2
  checks.diagramCardKeepsItsOwnCopy = rendered.length === 2
    && rendered.some(card => card.text.includes('Rig') && card.text.includes('打开图表'))
    && rendered.some(card => card.text.includes('Scene') && card.text.includes('打开 3D 场景'))
  clickCard(0)
  clickCard(1)
  checks.eachCardOpensItsOwnSurface = opened.length === 2
    && new Set(opened.map(item => item.surface)).size === 2
    && opened.some(item => item.surface === 'model3d' && item.id === 'm3d-1')
    && opened.some(item => item.surface === 'digram' && item.id === 'dgm-1')

  // 3. An unknown kind and a failed call publish nothing: a card whose click opens
  //    no surface is worse than no card.
  mount(turn([toolBlock('mcp__klaus-model3d__model3d_scene', 'cv', { kind: 'video', id: 'v1', title: 'Clip' })], 'Done.'))
  checks.unknownKindRendersNoCard = cards().length === 0
  mount(turn([toolBlock('mcp__klaus-model3d__model3d_scene', 'cf', { kind: 'model3d', id: 'm3d-x' }, true)], 'Failed.'))
  checks.failedCallRendersNoCard = cards().length === 0

  // 4. The card survives the turn fold — it must sit with the deliverables, not
  //    inside the collapsed process, or the user never sees it.
  mount(turn([toolBlock('mcp__klaus-model3d__model3d_scene', 'c3d',
    { kind: 'model3d', id: 'm3d-fold', title: 'Folded' })], '收尾。'))
  const card = document.querySelector(CARD) as HTMLElement | null
  const fold = document.querySelector('[class*="turn-fold"], [class*="activity-fold"]')
  checks.cardIsNotInsideTheFold = !!card && (!fold || !fold.contains(card))

  // Leave both surfaces on screen as the state the harness captures for evidence:
  // the fold check above deliberately renders a turn with a single card, and the
  // two negative checks before it render none at all.
  mount(turn([
    toolBlock('mcp__klaus-model3d__model3d_scene', 'c3d', { kind: 'model3d', id: 'm3d-bewd', title: '青眼白龙' }),
    toolBlock('mcp__klaus-digram__digram_open', 'cdg', { kind: 'diagram', id: 'dgm-1', title: '决斗流程' }),
  ], '两件都好了。'))
  // Click both cards so the evidence shows which panel each one reaches.
  clickCard(0)
  clickCard(1)

  // Evidence panel: the cards themselves are light-on-light, so a screenshot of
  // them alone is hard to read. Writing what each card says, where it sits and
  // which panel it opened makes the capture self-describing.
  const evidence = cards().map(card => `"${card.text}" ${card.width}x${card.height}`).join(' | ')
  const banner = document.createElement('pre')
  banner.style.cssText = 'margin:0 0 16px;padding:12px;background:#111;color:#0f0;font:13px/1.6 monospace;white-space:pre-wrap'
  banner.textContent = `cards: ${evidence}\nopened: ${JSON.stringify(opened)}\nchecks: ${JSON.stringify(checks)}`
  hostEl.parentNode?.insertBefore(banner, hostEl)

  document.getElementById('result')!.textContent = JSON.stringify(checks)
}

try {
  main()
} catch (error) {
  document.getElementById('result')!.textContent = JSON.stringify({ error: String(error), checks })
}
