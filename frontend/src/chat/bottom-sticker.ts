// Main and side transcripts share this bottom-following controller.
// Upward input releases following immediately, including when the browser
// coalesces the user's movement and a follow write into one scroll event.
// Scroll direction alone is not user intent: content collapse, viewport
// resizing and scroll anchoring can also move scrollTop upward.
// Content observers cover independently rendered rows and delayed media/font
// layout. The latest button restores following after the user reads above.

// 判「还算贴着底、继续跟随」的宽容差：用户轻微挪一点不该断开跟随。
const STICKY_THRESHOLD = 48
// 判「底部压着看不见的内容、该亮浮标」的严容差。与上面共用一个数时，末尾 47px
// （半张卡片）沉在视口外却不亮浮标，用户既没被跟随也没被提示。
const FLOAT_THRESHOLD = 4

export interface BottomSticker {
  /** 滚到底。force = 用户明确要看最新（发送消息、点浮标），顺带恢复跟随态。 */
  scrollToBottom(options?: { force?: boolean; immediate?: boolean }): void
  /** 是否还在「贴着底」的宽容差内。 */
  isNearBottom(): boolean
  /** 轮次导航：钉住视口，不许粘底把用户拽回底部。 */
  lockForNavigation(): void
  /** 解锁并恢复跟随。 */
  resumeFollowing(): void
  /** 记一次真实用户滚动意图（wheel / touch / pointer / 方向键）。 */
  noteUserScrollIntent(): void
  /** 记一次「往上」的滚动手势：立即解除跟随，哪怕同帧的 scroll 事件净位移为零。 */
  noteUpwardScrollGesture(): void
  /** 重算浮标显隐。 */
  syncFloatBtn(): void
  resetForSession(distanceFromBottomPx: number): void
  restoreViewport(distanceFromBottomPx: number): boolean
  isFollowing(): boolean
}

export function createBottomSticker(options: {
  scrollEl: HTMLElement | null
  floatBtn?: HTMLElement | null
  /** 容器整体不可见时浮标必须灭（主转录在 welcome 态是 display:none）。 */
  isVisible?: () => boolean
}): BottomSticker {
  const { scrollEl, floatBtn = null, isVisible } = options
  let stick = true
  let navigationLocked = false
  let lastUserScrollIntentAt = 0
  // 方向基准从挂载时的位置起算：从 0 起算会让挂载后的第一个 scroll 事件被读成
  // 一次「向下跳」，在底部宽容差内把跟随重新粘上。
  let lastScrollTop = scrollEl ? scrollEl.scrollTop : 0
  let pendingRaf = 0
  let floatVisible: boolean | undefined
  let distanceFromBottom = 0
  let restoreAllowed = true

  // Geometry belongs to this viewport. Presentation reads its last measurement;
  // stream notifications must not flush layout just to render the latest button.
  const bottomDistance = () => {
    distanceFromBottom = scrollEl
      ? Math.max(0, scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight)
      : 0
    return distanceFromBottom
  }
  const isNearBottom = () => !scrollEl || bottomDistance() <= STICKY_THRESHOLD
  const resumeFollowing = () => { navigationLocked = false; stick = true }
  const lockForNavigation = () => { navigationLocked = true; stick = false; restoreAllowed = false }

  const syncFloatBtn = () => {
    if (!floatBtn) return
    const show = (isVisible ? isVisible() : true) && distanceFromBottom > FLOAT_THRESHOLD
    if (show === floatVisible) return
    floatVisible = show
    floatBtn.classList.toggle('visible', show)
    floatBtn.setAttribute('aria-hidden', show ? 'false' : 'true')
    floatBtn.tabIndex = show ? 0 : -1
  }

  const scrollToBottom = (opts: { force?: boolean; immediate?: boolean } = {}) => {
    if (!scrollEl) return
    const force = !!opts.force
    if (force) resumeFollowing()
    if (!force && !stick) return
    // 同帧多次调用合并成一次写入：内容观察器（尺寸 + DOM 变更两路）与渲染侧的
    // effect 很可能在同一帧各叫一次。
    if (pendingRaf) cancelAnimationFrame(pendingRaf)
    const writeBottom = () => {
      pendingRaf = 0
      if (!force && !stick) return
      scrollEl.scrollTop = scrollEl.scrollHeight
      distanceFromBottom = 0
      // 基准跟着程序滚动一起更新，scroll 回调才不会把这次写入当成用户操作。
      lastScrollTop = scrollEl.scrollTop
      if (!navigationLocked) stick = true
      syncFloatBtn()
    }
    // Initial history layout must settle before the browser paints a frame.
    // Keep the same follow/navigation checks as ordinary deferred writes.
    if (opts.immediate) writeBottom()
    else pendingRaf = requestAnimationFrame(writeBottom)
  }

  const noteUserScrollIntent = () => {
    restoreAllowed = false
    lastUserScrollIntentAt = Date.now()
    if (navigationLocked && isNearBottom()) resumeFollowing()
  }

  const noteUpwardScrollGesture = () => {
    noteUserScrollIntent()
    // 手势即意图：不等 scroll 事件。流式期间粘底写入与用户上滚同帧合并后净位移
    // 为零，scroll 回调的方向判定看不到这次上滚，只有这里能解除。
    if (!navigationLocked) stick = false
  }

  if (scrollEl) {
    if (!isVisible || isVisible()) bottomDistance()
    scrollEl.addEventListener('scroll', () => {
      const top = scrollEl.scrollTop
      // 1px 容差吃掉亚像素 / DPR 取整带来的抖动。
      const scrolledUp = top < lastScrollTop - 1
      const scrolledDown = top > lastScrollTop + 1
      lastScrollTop = top
      const distance = bottomDistance()
      const nearBottom = distance <= STICKY_THRESHOLD
      const recentUserIntent = Date.now() - lastUserScrollIntentAt < 1_000
      if (navigationLocked) {
        // 净位移为零的事件（粘底写入与用户上滚同帧合并）既不算用户滚回底部，
        // 也不该顺带解锁导航钉住。
        if (nearBottom && scrolledDown && recentUserIntent) resumeFollowing()
        else stick = false
        syncFloatBtn()
        return
      }
      // Layout changes are not reading gestures. Even after a pointer click,
      // a shorter row can clamp scrollTop upward while still exactly at the
      // bottom. Explicit upward gestures already release following above.
      // Rearming still requires downward movement; a zero-delta follow echo
      // must not undo an upward gesture in the same frame.
      if (recentUserIntent && scrolledDown && nearBottom) stick = true
      else if (recentUserIntent && scrolledUp && distance > 1) stick = false
      syncFloatBtn()
    }, { passive: true })

    for (const type of ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'pointerup'] as const) {
      scrollEl.addEventListener(type, noteUserScrollIntent, { passive: true })
    }
    // 向上的手势在输入发生的那一刻解除跟随，不等 scroll 事件（见
    // noteUpwardScrollGesture 的注释：同帧合并会让 scroll 事件净位移为零）。
    scrollEl.addEventListener('wheel', (event: WheelEvent) => {
      if (event.deltaY < 0) noteUpwardScrollGesture()
    }, { passive: true })
    let touchY: number | null = null
    scrollEl.addEventListener('touchstart', (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null
    }, { passive: true })
    scrollEl.addEventListener('touchmove', (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? null
      // 手指下移 = 内容被拉下来 = 往上看。4px 吃掉抖动。
      if (touchY != null && y != null && y > touchY + 4) noteUpwardScrollGesture()
      if (y != null) touchY = y
    }, { passive: true })
    scrollEl.addEventListener('touchend', () => { touchY = null }, { passive: true })
    let pointerY: number | null = null
    scrollEl.addEventListener('pointerdown', (event: PointerEvent) => {
      pointerY = event.clientY
    }, { passive: true })
    scrollEl.addEventListener('pointermove', (event: PointerEvent) => {
      // Hover movement is not reading intent; only an active drag counts.
      if (pointerY == null) return
      noteUserScrollIntent()
      const y = event.clientY
      // Pointer moving down = content pulled down = scrolling toward top. 4px absorbs jitter.
      if (y > pointerY + 4) noteUpwardScrollGesture()
      pointerY = y
    }, { passive: true })
    scrollEl.addEventListener('pointerup', () => { pointerY = null }, { passive: true })
    scrollEl.addEventListener('pointercancel', () => { pointerY = null }, { passive: true })
    scrollEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
        noteUserScrollIntent()
      }
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) noteUpwardScrollGesture()
    })

    observeContentGrowth(scrollEl, () => {
      if (isVisible && !isVisible()) { syncFloatBtn(); return }
      bottomDistance()
      scrollToBottom()
      syncFloatBtn()
    })

    // 窗口不可见时浏览器会把 rAF 节流到不触发（最小化、切到另一个 Space 都算），
    // 于是这段时间里长出来的内容都没有被贴底——而恢复可见后如果不再有新内容，
    // 观察器也不会再响，画面就停在旧位置。重新可见时补一次。
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (isVisible && !isVisible()) { syncFloatBtn(); return }
        bottomDistance()
        scrollToBottom()
        syncFloatBtn()
      }
    })
  }

  floatBtn?.addEventListener('click', () => { scrollToBottom({ force: true }) })

  const resetForSession = (distanceFromBottomPx: number) => {
    if (pendingRaf) cancelAnimationFrame(pendingRaf)
    pendingRaf = 0
    navigationLocked = false
    restoreAllowed = true
    lastUserScrollIntentAt = 0
    distanceFromBottom = Math.max(0, distanceFromBottomPx)
    stick = distanceFromBottomPx <= STICKY_THRESHOLD
    lastScrollTop = scrollEl?.scrollTop ?? 0
  }
  const restoreViewport = (distanceFromBottomPx: number): boolean => {
    if (!scrollEl || !restoreAllowed || navigationLocked) return false
    if (pendingRaf) cancelAnimationFrame(pendingRaf)
    pendingRaf = 0
    scrollEl.scrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight - distanceFromBottomPx)
    lastScrollTop = scrollEl.scrollTop
    bottomDistance()
    syncFloatBtn()
    return true
  }

  return { scrollToBottom, isNearBottom, lockForNavigation, resumeFollowing, noteUserScrollIntent, noteUpwardScrollGesture, syncFloatBtn,
    resetForSession, restoreViewport, isFollowing: () => stick && !navigationLocked }
}

// 内容尺寸观察：内容一变高就重新贴底，谁渲染、渲染几次都无所谓。
function observeContentGrowth(scrollEl: HTMLElement, syncBottom: () => void): void {
  let syncObservedChildren = () => {}
  const hasResizeObserver = typeof ResizeObserver === 'function'
  if (hasResizeObserver) {
    // 逐个观察直接子节点：节点内部撑高（图片解码完成、字体替换、markdown 异步高亮）
    // 不产生 DOM 变更，MutationObserver 抓不到，只有 ResizeObserver 能。
    const childSizes = new ResizeObserver(syncBottom)
    const observed = new WeakSet<Element>()
    syncObservedChildren = () => {
      for (const child of Array.from(scrollEl.children)) {
        if (observed.has(child)) continue
        observed.add(child)
        childSizes.observe(child)
      }
    }
    syncObservedChildren()
    // 视口自身变高变矮（窗口缩放、composer 多行长高挤压 flex）同样要重新贴底。
    new ResizeObserver(syncBottom).observe(scrollEl)
  }
  if (typeof MutationObserver === 'function') {
    let fallbackFrame = 0
    // Register new content with the size observer without measuring between DOM
    // mutations. Modern renderers report final sizes after layout. The fallback
    // batches older environments once per frame.
    new MutationObserver(() => {
      syncObservedChildren()
      if (!hasResizeObserver && !fallbackFrame) fallbackFrame = requestAnimationFrame(() => {
        fallbackFrame = 0
        syncBottom()
      })
    })
      .observe(scrollEl, { childList: true, subtree: true, characterData: true })
  }
}
