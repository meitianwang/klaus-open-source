import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import contract from '../contracts/vectors/friend-reply-placement-vectors.json'
import { TranscriptView, StaticTranscriptView } from '../frontend/src/chat/transcript/TranscriptView'
import { chatStreamStore, getSessionStream } from '../frontend/src/chat/stream-store'

/** Preserve standalone friend appearance when a collaboration result joins a process disclosure. */
export async function friendReplyAppearance(host: HTMLElement, capture: (name: string) => Promise<void> = async () => {}) {
  const w = window as any
  const previous = { currentLang: w.currentLang, directory: w.getFriendDirectoryEntry, klaus: w.klaus }
  const hidden = [...host.children].map(node => ({ node: node as HTMLElement, display: (node as HTMLElement).style.display }))
  for (const { node } of hidden) node.style.display = 'none'
  const container = document.createElement('div')
  container.id = 'messages'
  container.style.cssText = 'height:900px;overflow:auto;flex:none;padding:16px;box-sizing:content-box'
  const slot = document.createElement('div')
  container.append(slot)
  host.append(container)
  const root = createRoot(slot)
  const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="28" height="28" fill="#326ce5"/><text x="14" y="20" text-anchor="middle" fill="white" font-size="18">R</text></svg>')
  w.currentLang = 'zh'
  w.getFriendDirectoryEntry = () => ({ name: 'Reviewer', avatarUrl: avatar })
  w.klaus = { media: { url: (path: string) => path }, session: { getResolvedWorkdir: async () => ({ workdir: null }) } }
  try {
    if (contract.rules.expandedAppearance !== 'same-sender-gutter-bubble-and-actions-as-standalone') throw new Error('Unexpected friend appearance contract')
    const results: Array<{ name: string; passed: boolean; evidence: unknown }> = []
    const settle = async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      await new Promise(resolve => setTimeout(resolve, 190))
    }
    const prose = '我目前在好友任务的工作目录中运行。这是一条用于核对消息布局的完整回复，包含多行文字。\n\n请保留头像、署名、气泡宽度、字号和操作按钮，任务完成后只将这条消息收进原有过程折叠。'.repeat(2)
    const reply = { role: 'user', turnId: 'delivery', uuid: 'friend-style-reply', timestamp: 1793610245154,
      text: '<friend-message>' + prose + '</friend-message>', localRender: {
        externalFriendMessage: true, replyType: 'completed', replyToRequestId: 'request-a', requestCreatedAt: 1793609939206,
        displayText: prose, sender: { friendshipId: 'friend-a', displayName: 'Reviewer', avatarUrl: avatar },
      } }
    const rows = [
      { role: 'user', turnId: 'work', uuid: 'owner', text: '请好友核对消息。', timestamp: 1793610242000 },
      { role: 'assistant', turnId: 'work', uuid: 'send', contentBlocks: [
        { type: 'tool_use', id: 'send-request', name: 'send_message_to_friend', input: { friendId: 'friend-a', intent: 'request', onReply: 'display', prompt: '请核对消息。' },
          __result: { content: [{ type: 'text', text: JSON.stringify({ accepted: true, delivered: true, requestId: 'request-a', friendId: 'friend-a' }) }] } },
      ] },
      { role: 'assistant', turnId: 'work', uuid: 'final', isFinalReply: true, contentBlocks: [
        { type: 'text', text: '已经完成本轮检查。', phase: 'final_answer' },
      ] }, reply,
    ]
    let serial = 0, id = '', surface = ''
    const mount = async (kind: string, history: any[]) => {
      surface = kind
      id = `friend-style:${++serial}`
      flushSync(() => chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [id]: {
        ...getSessionStream(id), history, historyStale: false, running: false, activeTurnId: null, liveUnits: [], tools: {},
        turnStatuses: { work: 'completed', delivery: 'completed' }, turnDurations: { work: 22000, delivery: 0 },
      } } })))
      flushSync(() => root.render(kind === 'static'
        ? <StaticTranscriptView key={id} msgs={history} container={container} running={false} sessionId={id} />
        : <TranscriptView key={id} sessionId={id} container={container} scroll={kind === 'main' ? 'main' : 'simple'} />))
      await settle()
    }
    const snapshot = () => {
      const row = slot.querySelector<HTMLElement>('[data-uuid="friend-style-reply"]')
      const bubble = row?.querySelector<HTMLElement>('[data-friend-card]')
      const column = row?.querySelector<HTMLElement>('[data-external-sender-col]')
      const image = column?.querySelector<HTMLElement>('img')
      const name = column?.lastElementChild as HTMLElement | undefined
      const rect = (node?: HTMLElement | null) => node?.getBoundingClientRect()
      const style = (node?: HTMLElement | null) => node ? getComputedStyle(node) : undefined
      const painted = (node?: HTMLElement | null) => {
        const r = rect(node)
        if (!node || !r || !r.width || !r.height || style(node)?.display === 'none') return false
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !!hit && (node === hit || node.contains(hit))
      }
      const final = [...slot.querySelectorAll<HTMLElement>('[data-md]')].find(node => node.dataset.md === '已经完成本轮检查。')
      return {
        count: slot.querySelectorAll('[data-uuid="friend-style-reply"]').length,
        visible: !!row && !row.closest('[aria-hidden="true"]') && !!rect(row)?.height,
        avatarPainted: painted(image), namePainted: painted(name), name: name?.textContent,
        avatarWidth: rect(image)?.width, avatarHeight: rect(image)?.height,
        avatarOffset: image && bubble ? rect(image)!.left - rect(bubble)!.left : null,
        nameOffset: name && bubble ? rect(name)!.left - rect(bubble)!.left : null,
        bubbleWidth: rect(bubble)?.width, bubbleHeight: rect(bubble)?.height,
        fontSize: style(bubble)?.fontSize, lineHeight: style(bubble)?.lineHeight,
        padding: style(bubble)?.padding, radius: style(bubble)?.borderRadius,
        background: style(bubble)?.backgroundColor, textColor: style(bubble)?.color,
        buttons: row?.querySelectorAll('.msg-actions button').length,
        senderColumnDisplay: style(column)?.display,
        finalVisible: !!final && !final.closest('[aria-hidden="true"]') && !!rect(final)?.height,
        beforeFinal: !!row && !!final && !!(row.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING),
        horizontalOverflow: container.scrollWidth > container.clientWidth,
        processExpanded: slot.querySelector('[data-activity-toggle="turn"]')?.getAttribute('aria-expanded'),
      }
    }
    const record = (name: string, passed: boolean, evidence: unknown) => results.push({ name, passed, evidence })
    const toggle = async () => { slot.querySelector<HTMLButtonElement>('[data-activity-toggle="turn"]')!.click(); await settle() }
    for (const width of [1100, 760]) {
      container.style.width = width + 'px'
      for (const kind of ['main', 'side', 'static']) {
        await mount(kind, [reply])
        const original = snapshot()
        record(`${width}/${kind}: original sender visibility`, width > 844 ? original.avatarPainted && original.namePainted : !original.avatarPainted && !original.namePainted, original)
        if (width === 1100 && kind === 'main') await capture('original')
        await mount(kind, rows)
        let folded = snapshot()
        record(`${width}/${kind}: completion hides only process reply`, folded.count === 0 && folded.finalVisible && folded.processExpanded === 'false', folded)
        await toggle()
        const expanded = snapshot()
        const keys = ['bubbleWidth', 'bubbleHeight', 'fontSize', 'lineHeight', 'padding', 'radius', 'background', 'textColor', 'buttons', 'avatarWidth', 'avatarHeight', 'avatarOffset', 'nameOffset', 'senderColumnDisplay'] as const
        const mismatches = keys.filter(key => expanded[key] !== original[key])
        record(`${width}/${kind}: expanded reply retains original geometry and styles`, !mismatches.length && expanded.count === 1 && expanded.beforeFinal, { original, expanded, mismatches })
        record(`${width}/${kind}: expanded sender paints exactly as before`, expanded.avatarPainted === original.avatarPainted && expanded.namePainted === original.namePainted, { original, expanded })
        record(`${width}/${kind}: no horizontal scroll`, !expanded.horizontalOverflow, expanded)
        if (width === 1100 && kind === 'main') await capture('expanded')
        await toggle(); folded = snapshot()
        record(`${width}/${kind}: collapsing removes reply and leaves final visible`, !folded.visible && folded.count === 0 && folded.finalVisible, folded)
      }
    }
    return results
  } finally {
    flushSync(() => root.unmount())
    container.remove()
    for (const { node, display } of hidden) node.style.display = display
    w.currentLang = previous.currentLang
    w.getFriendDirectoryEntry = previous.directory
    w.klaus = previous.klaus
  }
}
