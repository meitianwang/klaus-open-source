import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { ActivityToolContent } from './activity-tool'

interface Card { node: HTMLElement; root: Root; mountedInsideChat: boolean }
let card: Card | null = null
/** Rebuilds are bounded: an unbounded loop would hide a transcript that never settles. */
const MAX_REBUILDS = 8
let rebuilds = 0

function cardElement(snapshot: any, response: any) {
  return createElement(ActivityToolContent, {
    tool: {
      toolCallId: snapshot.toolCallId, toolName: 'show_widget', sessionId: snapshot.sessionId,
      state: 'done', args: { title: snapshot.title }, output: JSON.stringify(response),
    },
    open: false, onToggle: () => {}, locale: 'en',
  })
}

function createCard(snapshot: any, response: any): Card {
  const node = document.createElement('div')
  node.dataset.widgetFullChatTest = '1'
  const root = createRoot(node)
  flushSync(() => root.render(cardElement(snapshot, response)))
  const parent = document.getElementById('messages') || document.body
  parent.appendChild(node)
  return { node, root, mountedInsideChat: parent.id === 'messages' }
}

function describe(current: Card | null) {
  return {
    mounted: !!current,
    mountedInsideChat: current?.mountedInsideChat ?? false,
    card: !!current?.node.querySelector('[data-widget-state]'),
    connected: current?.node.isConnected ?? false,
    widgetState: current?.node.querySelector('[data-widget-state]')?.getAttribute('data-widget-state') ?? null,
    frames: document.querySelectorAll('iframe').length,
    rebuilds,
  }
}

/** Mount the real Widget tool card in the shipped chat transcript surface. */
;(window as any).__widgetFullChatMount = (snapshot: any, response: any) => {
  if (!card) card = createCard(snapshot, response)
  return describe(card)
}

/**
 * Keep a card attached to the live transcript and answer what the fixture polls.
 *
 * The shipped chat rebuilds `#messages` while it settles the session it was
 * switched to, which drops the node this fixture appended. Re-appending is not
 * enough: the card requests its capability URL once, and the product deliberately
 * discards the answer when the card is detached, so a card that was detached while
 * that answer was in flight stays in its loading state forever. Detecting the
 * detachment is therefore the signal to present the tool result again — exactly
 * what a transcript card rendered from the data projection gets on its own.
 *
 * A card that stayed attached keeps its request in flight and must not be
 * restarted, or the fixture would never observe a frame.
 */
;(window as any).__widgetFullChatEnsureAttached = (snapshot: any, response: any) => {
  if (!card) { card = createCard(snapshot, response); return describe(card) }
  const parent = document.getElementById('messages') || document.body
  if (!card.node.isConnected) {
    if (rebuilds >= MAX_REBUILDS) return describe(card)
    card.root.unmount()
    rebuilds++
    card = createCard(snapshot, response)
    return describe(card)
  }
  if (card.node.parentElement !== parent) parent.appendChild(card.node)
  return describe(card)
}

/** Drop the card so the next mount presents the tool result afresh. */
;(window as any).__widgetFullChatForget = () => {
  if (!card) return
  card.root.unmount()
  card = null
  rebuilds = 0
}
