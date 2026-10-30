// 消息选区引用浮层：
// 在 transcript 容器上监听 pointer / selection 事件，校验选区落在可引用的
// 消息文本内（.msg.assistant / .msg.user，历史层与 live 层同构类名），在选区
// 上方渲染紧凑浮动按钮：
//   「添加到会话」→ 选中文字作为引用 chip 注入对应 composer（主转录进主输入
//     框，侧任务转录进侧任务输入框）；
//   「在侧任务中提问」→ 仅主转录出现：创建（或激活）一个侧任务并把引用带过去，
//     由新建侧任务承接这句提问。
// 浮层经 portal 挂到 body（position:fixed）。拖动期间不出现，pointerup 后单帧
// 重算并以选区内点为锚点、用 translateX(clamp(...)) 做视口内水平夹取。
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n'
import { showToast } from '../../app/ui-shared'
import { Icon } from '../../components/Icon'
import styles from './transcript.module.css'

const w = () => window as any

// 可引用的消息文本元素：与 FinalAssistantBubble / live-text / user 气泡的
// 工厂类名一致。选区起止必须落在同一个此类元素内，跳出去就整体不成立。
const QUOTABLE_SELECTOR = '.msg.assistant, .msg.user'

// 引用 chip 不携带来源元数据（Klaus 引擎协议没有这个通道）：此处仅把选中
// 文本作为引用 chip 注入，出处不做装饰。
export type QuoteSurface = 'main' | 'side'

function nearestQuotable(node: Node | null, container: HTMLElement): Element | null {
  if (!node) return null
  const el = node instanceof Element ? node : node.parentElement
  const found = el?.closest(QUOTABLE_SELECTOR) as Element | null
  if (!found || !container.contains(found)) return null
  return found
}

// A triple-click (or a drag that overshoots) routinely ends the selection one
// node PAST the message it started in — the change card or the action row that
// follows the bubble sits in the same scroll column, and the browser happily
// extends across it. Strict same-message validation then rejects a selection
// the user drew on purpose (selecting the LAST paragraph of an answer always
// leaks into the card below it). When exactly one end lands outside every
// quotable message, clamp that stray end back into the message owning the
// other end instead of dropping the quote.
export type SelectionClamp = 'keep' | 'clamp-end' | 'clamp-start' | 'reject'

export function decideSelectionClamp(startQuotable: Element | null, endQuotable: Element | null): SelectionClamp {
  if (startQuotable && startQuotable === endQuotable) return 'keep'
  if (startQuotable && !endQuotable) return 'clamp-end'
  if (endQuotable && !startQuotable) return 'clamp-start'
  return 'reject'
}

function clampRangeEndToQuotable(range: Range, quotable: Element, at: 'start' | 'end', doc: Document): boolean {
  const walker = doc.createTreeWalker(quotable, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  if (texts.length === 0) return false
  if (at === 'end') range.setEnd(texts[texts.length - 1], texts[texts.length - 1].length)
  else range.setStart(texts[0], 0)
  return true
}

// 校验选区并取定位 rect：非空文本 + 起止同一条可引用消息（越界的一端按
// decideSelectionClamp 收口）。clamp 只在校验通过时改写活选区，让高亮与
// 最终引用文本一致；拖拽过程中的 selectionchange 不传 clamp，避免跟手抢夺。
function quotableSelection(container: HTMLElement | null, clamp = false): { text: string; rect: DOMRect } | null {
  if (!container) return null
  const sel = container.ownerDocument.defaultView?.getSelection?.()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const startQuotable = nearestQuotable(range.startContainer, container)
  const endQuotable = nearestQuotable(range.endContainer, container)
  const decision = clamp ? decideSelectionClamp(startQuotable, endQuotable) : startQuotable && startQuotable === endQuotable ? 'keep' : 'reject'
  if (decision === 'reject') return null
  const quoteEl = decision === 'clamp-start' ? endQuotable : startQuotable
  if (decision !== 'keep' && quoteEl && !clampRangeEndToQuotable(range, quoteEl, decision === 'clamp-end' ? 'end' : 'start', container.ownerDocument)) return null
  const text = sel.toString().trim()
  if (!text) return null
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0)
  if (rects.length === 0) return null
  return { text, rect: rects[rects.length - 1] }
}

function clearSelection(container: HTMLElement | null) {
  if (!container) return
  container.ownerDocument.defaultView?.getSelection()?.removeAllRanges()
}

export function QuoteSelectionToolbar({ container, surface }: { container: HTMLElement; surface: QuoteSurface }) {
  const t = useT()
  const [sel, setSel] = useState<{ text: string; rect: DOMRect } | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const selRef = useRef<{ text: string; rect: DOMRect } | null>(null)
  selRef.current = sel
  const pointerDownRef = useRef(false)
  const frameRef = useRef<number | null>(null)

  const hide = useCallback(() => setSel(null), [])

  // Recompute on the next frame after the selection settles. A pointer-down
  // selectionchange is part of an active drag: the overlay stays hidden until
  // pointerup, so continuing to drag keeps extending the selection.
  const schedule = useCallback(() => {
    const win = container.ownerDocument.defaultView
    if (!win) return
    if (frameRef.current != null) win.cancelAnimationFrame(frameRef.current)
    frameRef.current = win.requestAnimationFrame(() => {
      frameRef.current = null
      if (pointerDownRef.current) return
      setSel(quotableSelection(container, true))
    })
  }, [container])

  useEffect(() => {
    const doc = container.ownerDocument
    const win = doc.defaultView
    if (!win) return

    const onPointerDown = (e: PointerEvent) => {
      pointerDownRef.current = true
      // A click inside the overlay must not dismiss it before the button runs.
      if (barRef.current?.contains(e.target as Node)) return
      hide()
    }
    const onPointerUp = () => {
      pointerDownRef.current = false
      schedule()
    }
    const onPointerCancel = () => {
      pointerDownRef.current = false
      schedule()
    }
    const onSelectionChange = () => {
      if (pointerDownRef.current) return
      schedule()
    }
    // A fixed-position overlay drifts away from its anchor once the transcript
    // scrolls, so collapse it and let the user re-select.
    const onScroll = () => hide()
    const onResize = () => schedule()
    const onKeyUp = () => schedule()
    const onDblClick = () => schedule()

    doc.addEventListener('pointerdown', onPointerDown, true)
    doc.addEventListener('pointerup', onPointerUp, true)
    doc.addEventListener('pointercancel', onPointerCancel, true)
    doc.addEventListener('selectionchange', onSelectionChange)
    doc.addEventListener('keyup', onKeyUp)
    doc.addEventListener('dblclick', onDblClick)
    container.addEventListener('scroll', onScroll, true)
    win.addEventListener('resize', onResize)
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown, true)
      doc.removeEventListener('pointerup', onPointerUp, true)
      doc.removeEventListener('pointercancel', onPointerCancel, true)
      doc.removeEventListener('selectionchange', onSelectionChange)
      doc.removeEventListener('keyup', onKeyUp)
      doc.removeEventListener('dblclick', onDblClick)
      container.removeEventListener('scroll', onScroll, true)
      win.removeEventListener('resize', onResize)
      if (frameRef.current != null) win.cancelAnimationFrame(frameRef.current)
    }
  }, [container, hide, schedule])

  const commit = useCallback(() => {
    clearSelection(container)
    hide()
  }, [container, hide])

  const commitAddToChat = () => {
    const selected = selRef.current
    if (!selected) return
    if (surface === 'side') w().klausSideComposerAddSelection?.(selected.text)
    else w().klausQuoteAddToChat?.(selected.text)
    // The composer service owns the deferred focus handoff, so hiding the
    // toolbar must not clear the caret it is about to restore.
    hide()
  }

  const handleAskInSideTask = () => {
    if (!sel) return
    void (async () => {
      const ok = await w().KlausSideTasks?.askWithSelection?.(sel.text)
      if (!ok) showToast(t('side_task_empty_hint'))
    })()
    commit()
  }

  if (!sel) return null
  const win = container.ownerDocument.defaultView
  if (!win) return null
  const rect = sel.rect
  // Anchor the bar above the selection, centered on the last selected line.
  // The horizontal clamp keeps both edges inside the viewport with an 8px
  // margin while still allowing the bar to grow wider than the selection.
  const anchor = rect.left + rect.width / 2
  const minLeft = 8 - anchor
  const maxLeft = win.innerWidth - 8 - anchor
  const position = {
    left: `${anchor}px`,
    top: `${rect.top - 8}px`,
    maxWidth: `${win.innerWidth - 16}px`,
    transform: `translateX(clamp(${minLeft}px, -50%, calc(${maxLeft}px - 100%))) translateY(-100%)`,
  } as const

  return createPortal(
    <div
      ref={barRef}
      className={styles['quote-toolbar']}
      role="toolbar"
      aria-label={t('quote_selection_label') || 'Quote selection'}
      style={position}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      <button type="button" className={styles['quote-toolbar-btn']} onClick={commitAddToChat}>
        <Icon name="quoted-text" size={16} />
        {t('quote_add_to_chat') || 'Add to Chat'}
      </button>
      {surface === 'main' ? (
        <>
          <span className={styles['quote-toolbar-separator']} role="separator" aria-hidden="true" />
          <button type="button" className={styles['quote-toolbar-btn']} onClick={handleAskInSideTask}>
            <Icon name="side-task" size={16} />
            {t('quote_ask_in_side_task') || 'Ask in Side Task'}
          </button>
        </>
      ) : null}
    </div>,
    container.ownerDocument.body,
  )
}
