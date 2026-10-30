// Settings tab 基座（Batch 3 settings 绞杀第一单元）：
// - kv 读写 hooks（settingsApi.kv 经 window 桥）
// - pref-row 行组件族（类名/DOM 与 settings.js 的 klausXxxRow 工厂逐一对应）
// - registerSettingsTab 挂载器：loadSettingsTab 的 case 改调 window.loadXxxTab，
//   宿主每次切 tab 都被 resetSettingsContent 换新节点，挂载前 unmount 旧 root。
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { t } from '../../i18n'
import styles from './settings.module.css'

const w = () => window as any

export async function kvGet(key: string): Promise<string | undefined> {
  const value = await w().settingsApi.kv.get(key)
  return value == null ? undefined : String(value)
}

export async function kvSet(key: string, value: string): Promise<boolean> {
  try {
    const result = await w().settingsApi.kv.set(key, value)
    if (result?.ok === false || result?.error) throw new Error(result?.error || t('settings_failed'))
    return true
  } catch (error: any) {
    w().showToast(error?.message || t('settings_failed'))
    return false
  }
}

export function boolChecked(raw: string | undefined, engineDefault: boolean): boolean {
  if (raw === 'on' || raw === '1' || raw === 'true') return true
  if (raw === 'off' || raw === '0' || raw === 'false') return false
  return engineDefault
}

// ---- pref-row 行组件族 ----

export function PrefToggleRow({ id, label, desc, checked, disabled = false, onChange }: {
  id: string
  label: string
  desc?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className={`pref-row${disabled ? ' ' + styles['pref-row-disabled'] : ''}`}>
      <div className={styles['pref-row-text']}>
        <div className={styles['pref-row-label']} id={`${id}-label`}>{label}</div>
        {desc ? <div className={styles['pref-row-desc']} id={`${id}-desc`}>{desc}</div> : null}
      </div>
      <label className={`${styles['pref-switch']}${disabled ? ' ' + styles['pref-switch-disabled'] : ''}`}>
        <input
          type="checkbox" id={id} aria-labelledby={`${id}-label`} aria-describedby={desc ? `${id}-desc` : undefined}
          checked={checked} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={styles['pref-switch-track']} />
      </label>
    </div>
  )
}

export function PrefSelectRow({ id, label, desc, value, options, onChange }: {
  id: string
  label: string
  desc: string
  value: string
  options: Array<{ value: string; label: string; disabled?: boolean }>
  onChange: (value: string) => void
}) {
  return (
    <div className="pref-row">
      <div className={styles['pref-row-text']}>
        <div className={styles['pref-row-label']} id={`${id}-label`}>{label}</div>
        <div className={styles['pref-row-desc']} id={`${id}-desc`}>{desc}</div>
      </div>
      <select
        id={id} className={styles['browser-settings-select']} aria-labelledby={`${id}-label`} aria-describedby={`${id}-desc`}
        value={value} onChange={(e) => onChange(e.target.value)}
      >
        {options.map(o => <option value={o.value} disabled={o.disabled} key={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

/** Keep authoritative refreshes current without replacing an in-progress draft. */
export function useSettingsDraftSync<T extends HTMLInputElement | HTMLTextAreaElement>(value: string, ref: RefObject<T | null>) {
  const committed = useRef(value)
  useLayoutEffect(() => {
    const input = ref.current
    if (input && (input.value === committed.current || input.value === value)) input.value = value
    committed.current = value
  }, [value])
  return committed
}

/** 数字/文本行：blur 或 Enter 提交（空值 → 存空串，引擎侧视为未设走默认）。 */
function CommitInput({ id, type, width, value, placeholder, attrs, onCommit, disabled }: {
  id: string
  type: 'number' | 'text'
  width: number
  value: string
  placeholder: string
  attrs?: { min?: number; max?: number; step?: number | 'any' }
  onCommit: (value: string) => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const committedRef = useSettingsDraftSync(value, inputRef)
  return (
    <input
      ref={inputRef}
      type={type} id={id} className={styles['browser-settings-select']} style={{ width: `${width}px` }}
      min={attrs?.min} max={attrs?.max} step={attrs?.step}
      defaultValue={value} placeholder={placeholder} disabled={disabled}
      aria-labelledby={`${id}-label`} aria-describedby={`${id}-desc`}
      onInput={(e) => e.currentTarget.removeAttribute('aria-invalid')}
      onBlur={(e) => {
        const input = e.currentTarget
        if (type === 'number' && input.value.trim() && !input.checkValidity()) {
          input.setAttribute('aria-invalid', 'true')
          w().showToast(input.validationMessage || t('settings_failed'))
          return
        }
        const next = input.value.trim()
        if (next !== committedRef.current.trim()) onCommit(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          // Blur owns the commit so Enter writes each edit only once.
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

export function PrefNumberRow({ id, label, desc, value, attrs, onCommit, disabled }: {
  id: string
  label: string
  desc: string
  value: string | undefined
  attrs?: { min?: number; max?: number; step?: number | 'any'; placeholder?: string }
  onCommit: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className={`pref-row${disabled ? ' ' + styles['pref-row-disabled'] : ''}`}>
      <div className={styles['pref-row-text']}>
        <div className={styles['pref-row-label']} id={`${id}-label`}>{label}</div>
        <div className={styles['pref-row-desc']} id={`${id}-desc`}>{desc}</div>
      </div>
      <CommitInput
        id={id} type="number" width={120} value={value != null ? String(value) : ''}
        placeholder={attrs?.placeholder || ''} {...(attrs ? { attrs } : {})} onCommit={onCommit}
        {...(disabled != null ? { disabled } : {})}
      />
    </div>
  )
}

export function PrefTextRow({ id, label, desc, value, placeholder, onCommit, disabled }: {
  id: string
  label: string
  desc: string
  value: string | undefined
  placeholder?: string
  onCommit: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className={`pref-row${disabled ? ' ' + styles['pref-row-disabled'] : ''}`}>
      <div className={styles['pref-row-text']}>
        <div className={styles['pref-row-label']} id={`${id}-label`}>{label}</div>
        <div className={styles['pref-row-desc']} id={`${id}-desc`}>{desc}</div>
      </div>
      <CommitInput
        id={id} type="text" width={190} value={value ?? ''}
        placeholder={placeholder || ''} onCommit={onCommit}
        {...(disabled != null ? { disabled } : {})}
      />
    </div>
  )
}

/** 统一设置页骨架：页头（标题/副标题/右侧动作槽）+ 正文列。
    全部 tab 必须经本组件渲染：列宽/页头字级/分区节奏均由它单点持有，
    tab 内部不得再自造页头或私设 max-width——没有任何宽度特例。 */
export function SettingsPage({ title, subtitle, actions, children }: {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className={styles['settings-page']}>
      <header className={styles['settings-page-header']}>
        <div className={styles['settings-page-heading']}>
          <h1 className={styles['settings-page-title']}>{title}</h1>
          {subtitle != null && <p className={styles['settings-page-subtitle']}>{subtitle}</p>}
        </div>
        {actions != null && <div className={styles['settings-page-actions']}>{actions}</div>}
      </header>
      <div className={styles['settings-page-body']}>{children}</div>
    </section>
  )
}

// ---- tab 挂载器 ----
// resetSettingsContent 每次切 tab 都 cloneNode 换掉 #settings-content，
// 宿主永远是新节点；单例 root 记账，挂载前 unmount 上一个防泄漏。
let currentTabRoot: Root | null = null

export function mountSettingsTab(container: HTMLElement, node: React.ReactNode): void {
  unmountSettingsTab()
  currentTabRoot = createRoot(container)
  // Commit the first frame synchronously. React 19 schedules the initial
  // render in a microtask, so an asynchronous mount leaves the freshly swapped
  // (empty) container on screen for a frame; on a remount — which a host
  // settings write triggers for the open tab — that empty frame plus the
  // sections' loading skeletons read as the page flashing.
  flushSync(() => currentTabRoot?.render(node))
}

export function unmountSettingsTab(): void {
  currentTabRoot?.unmount()
  currentTabRoot = null
}
