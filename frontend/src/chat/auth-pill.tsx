// The composer pill shows the active source's brand mark. The menu keeps every
// source visible; unavailable rows explain the state and open that source's
// settings rather than silently failing.
import styles from './chat.module.css'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { useT, t as tGlobal } from '../i18n'
import { rawIconHtml } from '../components/Icon'
import {
  activateModelSource,
  effectiveModelSource,
} from '../pages/settings/model-shared'
import { openModelSettings } from '../pages/settings/shell'
import { claimOverlay, overlayIdForElement, registerOverlay } from '../app/overlay-registry'
import { AuthMenuRequests, type AuthMenuState } from './auth-menu-state'

const w = () => window as any

const CHAT_AUTH_MODE_ORDER = ['subscription', 'codex', 'cursor', 'qoder', 'qwenwork', 'qoderwork', 'workbuddy', 'antigravity', 'trae', 'kiro', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark', 'custom']

// Qoder 的官方标志是白绿双色字符，单独拿出来在浅色面上会丢白色部分，
// 因此沿用官方圆角底板版本（同 kimi 先例）。codex 同为官方位图。
// 本地模型无品牌可依，自绘显示器字形（fill currentColor，与自定义的地球同风格）。
function AuthModeIcon({ mode }: { mode: string }) {
  if (mode === 'codex') {
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-codex`} aria-hidden="true"><img src="codex-logo.png" alt="" /></span>
  }
  if (mode === 'cursor') {
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-cursor`} aria-hidden="true"><img src="cursor-logo.png" alt="" /></span>
  }
  if (mode === 'qoder') {
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-qoder`} aria-hidden="true"><img src="qoder-logo.png" alt="" /></span>
  }
  if (mode === 'qwenwork') {
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-qwenwork`} aria-hidden="true"><img src="qwenwork-logo.png" alt="" /></span>
  }
  if (mode === 'qoderwork') {
    // This source's brand mark is a green rounded tile with a white mascot, a
    // different bitmap from the black tile beside it, so it gets its own asset.
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-qoderwork`} aria-hidden="true"><img src="qoderwork-logo.png" alt="" /></span>
  }
  if (mode === 'workbuddy') {
    // Same official mark the external-session importer uses: a rounded tile, so it
    // keeps its light strokes on a light surface like the other provider tiles.
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-workbuddy`} aria-hidden="true"><img src="import-workbuddy-logo.svg" alt="" /></span>
  }
  if (mode === 'antigravity') {
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-antigravity`} aria-hidden="true"><img src="antigravity-logo.svg" alt="" /></span>
  }
  if (mode === 'trae') {
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-trae`} aria-hidden="true"><img src="trae-logo.svg" alt="" /></span>
  }
  if (mode === 'kiro') {
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-kiro`} aria-hidden="true"><img src="kiro-logo.png" alt="" /></span>
  }
  if (mode === 'kimi') {
    // The official Kimi mark is likewise a rounded tile carrying light strokes, so
    // it keeps its own tile instead of borrowing a text glyph.
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-kimi`} aria-hidden="true"><img src="kimi-icon-rounded-corner.png" alt="" /></span>
  }
  if (mode === 'bailian') {
    // The vendor's own mark. It is a wordmark rather than a tile, so it sits on a
    // light surface the way the other branded entries do.
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-bailian`} aria-hidden="true"><img src="bailian-logo.svg" alt="" /></span>
  }
  if (mode === 'minimax') {
    // The vendor's own mark, on a light tile so its strokes survive a light surface
    // like the other branded entries.
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-minimax`} aria-hidden="true"><img src="minimax-logo.svg" alt="" /></span>
  }
  if (mode === 'zhipu') {
    // The platform's own tile: a rounded square carrying the white Z on a dark
    // field, with transparent corners, so it needs no clipping the way the opaque
    // bitmap plates do. It is the mark the Coding Plan console serves today.
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-zhipu`} aria-hidden="true"><img src="zhipu-logo.png" alt="" /></span>
  }
  if (mode === 'ark') {
    // Volcano Engine's own mark: a blue gradient sail on transparent corners, so
    // like the Zhipu tile it needs no clipping rule. It is the favicon the plan's
    // own console and product pages declare.
    return <span className={`${styles['auth-mode-icon']} auth-mode-icon-ark`} aria-hidden="true"><img src="ark-logo.png" alt="" /></span>
  }
  const glyph = mode === 'subscription' ? 'auth-mode' : 'auth-mode-2'
  const cls = mode === 'subscription' ? 'auth-mode-icon-claude' : 'auth-mode-icon-custom'
  return (
    <span
      className={`${styles['auth-mode-icon']} ${cls}`} aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: rawIconHtml(glyph) }}
    />
  )
}

function authModeLabel(mode: string): string {
  if (mode === 'subscription') return tGlobal('auth_subscription')
  if (mode === 'codex') return tGlobal('auth_codex')
  if (mode === 'cursor') return tGlobal('auth_cursor')
  if (mode === 'qoder') return tGlobal('auth_qoder')
  if (mode === 'qwenwork') return tGlobal('auth_qwenwork')
  if (mode === 'qoderwork') return tGlobal('auth_qoderwork')
  if (mode === 'workbuddy') return tGlobal('auth_workbuddy')
  if (mode === 'antigravity') return tGlobal('auth_antigravity')
  if (mode === 'trae') return tGlobal('auth_trae')
  if (mode === 'kiro') return tGlobal('auth_kiro')
  if (mode === 'kimi') return tGlobal('auth_kimi')
  if (mode === 'bailian') return tGlobal('auth_bailian')
  if (mode === 'minimax') return tGlobal('auth_minimax')
  if (mode === 'zhipu') return tGlobal('auth_zhipu')
  if (mode === 'ark') return tGlobal('auth_ark')
  return tGlobal('auth_custom')
}

function authModeSwitchText(mode: string): string {
  if (mode === 'subscription') return tGlobal('auth_mode_switched_sub')
  if (mode === 'codex') return tGlobal('auth_mode_switched_codex')
  if (mode === 'custom') return tGlobal('auth_mode_switched_custom')
  return tGlobal(`auth_mode_switched_${mode}`)
}

function AuthModeMenu({ anchor, state, requests, onClose }: { anchor: HTMLElement; state: AuthMenuState; requests: AuthMenuRequests; onClose: () => void }) {
  const t = useT()
  const menuRef = useRef<HTMLDivElement>(null)

  // The composer menu opens upward and follows resize/scroll. Width comes from
  // the shared select-panel styling; only viewport clamping is measured here.
  const reposition = useCallback(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = anchor.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = menu.offsetHeight || 0
    const aboveTop = rect.top - height - 8
    const top = Math.max(8, aboveTop)
    menu.style.top = `${top}px`
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
  }, [anchor])

  // 首帧就位（layoutEffect 在 paint 前跑）：旧版 appendChild 后同步定位，菜单
  // 从不以错位帧扫过鼠标（否则 tooltip.js 会被 mouseover 重新唤起气泡）。
  useLayoutEffect(() => {
    reposition()
  }, [reposition])

  useEffect(() => {
    const overlayId = overlayIdForElement(anchor, 'auth-mode-select')
    const unregisterOverlay = registerOverlay(overlayId, onClose)
    anchor.setAttribute('aria-expanded', 'true')
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node) || anchor.contains(event.target as Node)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      unregisterOverlay()
      anchor.setAttribute('aria-expanded', 'false')
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [anchor, onClose, reposition])

  const chooseMode = async (nextMode: string) => {
    if (!requests.isCurrent(state)) { onClose(); return }
    if (nextMode === state.activeMode) {
      onClose()
      return
    }
    onClose()
    try {
      await activateModelSource(nextMode, state.sessionId)
      if (state.sessionId === (w().currentSessionId ?? null)) w().showToast(authModeSwitchText(nextMode))
    } catch (err: any) {
      if (state.sessionId === (w().currentSessionId ?? null)) w().showToast(t('auth_switch_failed_prefix') + (err?.message || String(err)))
    }
  }

  return createPortal(
    <div className={`${styles['auth-mode-menu']} kls-select-panel`} role="menu" aria-label={t('auth_mode_menu_label')} ref={menuRef} style={{ top: '-9999px', left: '-9999px' }}>
      <div className={`${styles['auth-mode-menu-list']}`}>
        {CHAT_AUTH_MODE_ORDER.map(mode => {
          const active = mode === state.activeMode
          return (
            <button
              type="button" key={mode}
              className={`kls-select-item${active ? ' is-selected' : ''}`}
              role="menuitemradio" aria-checked={active ? 'true' : 'false'}
              data-auth-mode-choice={mode}
              onClick={() => { void chooseMode(mode) }}
            >
              <span className={`${styles['auth-mode-menu-icon']}`}><AuthModeIcon mode={mode} /></span>
              <span className={`${styles['auth-mode-menu-label']}`}>{authModeLabel(mode)}</span>
            </button>
          )
        })}
      </div>
      <div className={`${styles['auth-mode-menu-divider']}`} />
      <button
        type="button" className={`kls-select-item ${styles['auth-mode-menu-manage']}`} role="menuitem" data-auth-mode-manage
        onClick={() => { onClose(); openModelSettings() }}
      >
        <span
          className={`${styles['auth-mode-menu-manage-icon']}`} aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: rawIconHtml('auth-mode-menu-manage') }}
        />
        <span className={`${styles['auth-mode-menu-label']}`}>{t('model_source_manage_and_connect')}</span>
      </button>
    </div>,
    document.body,
  )
}

function AuthModePill() {
  useT() // 语言切换时重渲 title/aria
  const [mode, setMode] = useState<string | null>(null)
  const [menu, setMenu] = useState<AuthMenuState | null>(null)
  const [menuRequests] = useState(() => new AuthMenuRequests(() => w().currentSessionId ?? null))
  const pillRef = useRef<HTMLButtonElement>(null)
  const refreshRevision = useRef(0)
  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current
    const sessionId = w().currentSessionId
    try {
      const next = await effectiveModelSource(sessionId)
      if (revision === refreshRevision.current && sessionId === w().currentSessionId) setMode(next)
    } catch {
      if (revision === refreshRevision.current && sessionId === w().currentSessionId) setMode(null)
    }
  }, [])

  // Source/config changes and session switches can all change the effective
  // source shown here because a conversation keeps its own concrete model.
  useEffect(() => {
    const changed = () => {
      menuRequests.invalidate()
      setMenu(null)
      void refresh()
    }
    void refresh()
    window.addEventListener('klaus:auth-mode-changed', changed)
    window.addEventListener('klaus:models-changed', changed)
    window.addEventListener('klaus:session-change', changed)
    return () => {
      refreshRevision.current++
      menuRequests.invalidate()
      window.removeEventListener('klaus:auth-mode-changed', changed)
      window.removeEventListener('klaus:models-changed', changed)
      window.removeEventListener('klaus:session-change', changed)
    }
  }, [refresh, menuRequests])

  // 点 pill 打开快速认证模式切换菜单；只有菜单底部的「管理模型配置」进入设置页。
  // useCallback 稳引用（menu 现值经 ref 读），否则 PillButton 的 memo 短路失效。
  const menuOpenRef = useRef(menu)
  menuOpenRef.current = menu
  const onClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (menuOpenRef.current) { setMenu(null); return }
    if (mode === null) return
    if (pillRef.current) claimOverlay(overlayIdForElement(pillRef.current, 'auth-mode-select'))
    setMenu({ ...menuRequests.capture(), activeMode: mode })
  }, [menuRequests, mode])

  if (mode === null) return null

  return (
    <>
      <PillButton mode={mode} label={authModeLabel(mode)} onClick={onClick} pillRef={pillRef} />
      {menu && pillRef.current ? (
        <AuthModeMenu anchor={pillRef.current} state={menu} requests={menuRequests} onClose={() => setMenu(null)} />
      ) : null}
    </>
  )
}

// memo 短路：菜单开合（setMenu）重渲父组件时 button 子树零 DOM 操作——
// dangerouslySetInnerHTML 重设会换掉指针下的 svg，合成 mouseover 会把
// tooltip.js 的气泡重新唤起（旧版静态 DOM 从不重建，无此问题）。
const PillButton = memo(function PillButton({ mode, label, onClick, pillRef }: {
  mode: string
  label: string
  onClick: (event: React.MouseEvent) => void
  pillRef: React.RefObject<HTMLButtonElement | null>
}) {
  return (
    <button
      id="auth-mode-pill" className="auth-mode-pill" ref={pillRef}
      title={label} aria-label={label} aria-haspopup="menu"
      style={{ display: 'inline-flex' }}
      onClick={onClick}
    >
      <AuthModeIcon mode={mode} />
    </button>
  )
})

export function mountAuthModePill(): void {
  const host = document.getElementById('auth-mode-pill-host')
  if (!host) return
  createRoot(host).render(<AuthModePill />)
}
