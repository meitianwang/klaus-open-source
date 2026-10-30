// 共享页头（React 包装）：复用 klsPageHeader.render 工厂产出的 HTML——
// moon 装饰/标题/副标题/topbar（刷新·搜索·创建菜单）与旧版逐字节一致，
// 事件在 effect 里挂到工厂生成的节点上。语言切换由 useT 驱动重算 HTML。
//
// 结构要点：dangerouslySetInnerHTML 的宿主隔离在 memo 子组件里，只依赖
// html 字符串——React 19 对重渲染的 dSIH 节点会整体重写 innerHTML（即使
// 值相同），宿主若随页面状态一起重渲染，工厂 DOM 会被换新、事件绑定全部
// 丢失（实测：创建菜单点击失效）。memo 切断这条重渲染链；回调经 latest-ref
// 转发，闭包永远是最新的。
import { memo, useEffect, useMemo, useRef, type RefObject } from 'react'
import { useT } from '../i18n'

export interface CreateMenuItem {
  action: string
  labelKey: string
  iconHtml?: string
}

export interface PageHeaderProps {
  titleKey: string
  action?: { id: string; labelKey: string; disabled?: boolean; onClick?: () => void }
  subtitleKey?: string
  /** 覆盖副标题（报错态用），传了则忽略 subtitleKey。 */
  subtitleHtml?: string
  /** 副标题尾部的强调短句（工厂 noteKey，MCP 页横幅用）。 */
  noteKey?: string
  refresh?: { id: string; titleKey: string; disabled?: boolean; onClick?: () => void | Promise<void> }
  search?: { id: string; placeholderKey: string; value: string; onInput?: (value: string) => void }
  create?: { btnId: string; menuId: string; disabled?: boolean; items: CreateMenuItem[]; onAction?: (action: string) => void }
  /** 非 refresh·search·create 三件套的自定义动作行（工厂 topbarHtml，事件由页面自行按 id 挂）。 */
  topbarHtml?: string
  /** 页头正文下方追加的 HTML（需要与旧版逐字节一致时使用）。 */
  bodyHtml?: string
}

const HeaderDom = memo(function HeaderDom({ html, hostRef }: {
  html: string
  hostRef: RefObject<HTMLDivElement | null>
}) {
  return <div ref={hostRef} style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: html }} />
})

export function PageHeader(props: PageHeaderProps) {
  const t = useT() // 订阅语言切换 → 重算 html
  const hostRef = useRef<HTMLDivElement>(null)
  // 最新 props 经 ref 转发给事件处理器：绑定只随 html 变化重挂，
  // 但回调必须取每次渲染的最新闭包（reload 等依赖组件 state）。
  const latest = useRef(props)
  latest.current = props
  // 搜索值由 input 自身持有（非受控）：进 html 依赖会每键重建 input 丢焦点。
  const searchValue = useRef(props.search?.value ?? '')
  // 正文行（tabs/作用域栏/分类行）同理不进 html 依赖：分类计数随搜索词每键
  // 变化，跟着重算 html 就会整块重写 innerHTML 把搜索框换成新节点，第二个
  // 字符落到已失焦的旧框上。首屏仍由工厂一次渲出（读 ref 取当前值），之后
  // 只在下面的 effect 里就地替换这几行。
  const bodyHtml = props.bodyHtml ?? ''
  const bodyRef = useRef(bodyHtml)
  bodyRef.current = bodyHtml
  const appliedBody = useRef(bodyHtml)

  const html = useMemo(() => {
    return (window as any).klsPageHeader.render({
      titleKey: props.titleKey,
      ...(props.subtitleHtml != null
        ? { subtitleHtml: props.subtitleHtml }
        : props.subtitleKey
          ? { subtitleKey: props.subtitleKey }
          : {}),
      ...(props.noteKey ? { noteKey: props.noteKey } : {}),
      ...(props.topbarHtml != null ? { topbarHtml: props.topbarHtml } : {}),
      topbar: {
        ...(props.action ? { action: { id: props.action.id, labelKey: props.action.labelKey, disabled: props.action.disabled } } : {}),
        ...(props.refresh ? { refresh: { id: props.refresh.id, titleKey: props.refresh.titleKey, disabled: props.refresh.disabled } } : {}),
        ...(props.search
          ? { search: { id: props.search.id, placeholderKey: props.search.placeholderKey, value: searchValue.current } }
          : {}),
        ...(props.create
          ? {
              create: {
                btnId: props.create.btnId,
                menuId: props.create.menuId,
                disabled: props.create.disabled,
                items: props.create.items.map((item) => ({
                  action: item.action,
                  labelKey: item.labelKey,
                  ...(item.iconHtml ? { iconHtml: item.iconHtml } : {}),
                })),
              },
            }
          : {}),
      },
      ...(bodyRef.current ? { bodyHtml: bodyRef.current } : {}),
    }) as string
    // t 进依赖：语言切换时工厂重算文案
  }, [t, props.titleKey, props.subtitleKey, props.subtitleHtml, props.noteKey, props.topbarHtml,
      props.action?.id, props.action?.labelKey, props.action?.disabled, props.refresh?.id, props.refresh?.disabled, props.search?.id, props.create?.btnId, props.create?.disabled])

  // 正文行就地替换：只动副标题之后的那几行，topbar（含正在输入的搜索框）不碰。
  // html 重算时工厂已带上当前正文行，此时 appliedBody 与之相等直接跳过。
  useEffect(() => {
    if (appliedBody.current === bodyHtml) return
    const header = hostRef.current?.querySelector('.kls-page-header')
    const anchor = header?.querySelector(':scope > .kls-subtitle') ?? header?.querySelector(':scope > .kls-title')
    if (!anchor) return
    while (anchor.nextElementSibling) anchor.nextElementSibling.remove()
    if (bodyHtml) anchor.insertAdjacentHTML('afterend', bodyHtml)
    appliedBody.current = bodyHtml
  }, [html, bodyHtml])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const disposers: (() => void)[] = []
    const refreshId = latest.current.refresh?.id
    if (refreshId) {
      const btn = host.querySelector<HTMLButtonElement>(`#${refreshId}`)
      const onClick = async () => {
        btn?.classList.add('spinning')
        try { await latest.current.refresh?.onClick?.() } finally {
          setTimeout(() => btn?.classList.remove('spinning'), 600)
        }
      }
      btn?.addEventListener('click', onClick)
      disposers.push(() => btn?.removeEventListener('click', onClick))
    }
    const searchId = latest.current.search?.id
    if (searchId) {
      const input = host.querySelector<HTMLInputElement>(`#${searchId}`)
      // 语言切换重建后回填当前搜索值
      if (input && input.value !== searchValue.current) input.value = searchValue.current
      const onInput = () => {
        searchValue.current = input?.value || ''
        latest.current.search?.onInput?.(searchValue.current)
      }
      input?.addEventListener('input', onInput)
      disposers.push(() => input?.removeEventListener('input', onInput))
    }
    const actionId = latest.current.action?.id
    if (actionId) {
      const button = host.querySelector<HTMLButtonElement>(`#${actionId}`)
      const onClick = () => latest.current.action?.onClick?.()
      button?.addEventListener('click', onClick)
      disposers.push(() => button?.removeEventListener('click', onClick))
    }
    const create = latest.current.create
    if (create) {
      // klsTopbar.bindCreateMenu 绑在工厂节点上；html 重算后节点换新，重绑即可
      ;(window as any).klsTopbar.bindCreateMenu({
        btnId: create.btnId,
        menuId: create.menuId,
        onAction: (action: string) => latest.current.create?.onAction?.(action),
      })
    }
    return () => { for (const dispose of disposers) dispose() }
  }, [html])

  useEffect(() => {
    const nextValue = props.search?.value ?? ''
    if (!props.search || nextValue === searchValue.current) return
    searchValue.current = nextValue
    const input = hostRef.current?.querySelector<HTMLInputElement>(`#${props.search.id}`)
    if (input && input.value !== nextValue) input.value = nextValue
  }, [props.search?.id, props.search?.value])

  return <HeaderDom html={html} hostRef={hostRef} />
}
