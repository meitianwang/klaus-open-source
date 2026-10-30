// Channels 页（React 岛）——迁自 js/pages/channels.js，DOM 结构/类名/文案键
// 与模板字符串版逐一对应，CSS 零改动。
//
// 页面骨架仍由共享 chrome 承担：klsPageHeader.mount 渲染标题/刷新/搜索，
// page-view 注册协议提供 show/hide 与 window.showChannelsView 兼容导出；
// 岛只负责 #channels-view-content 里的内容与弹窗（portal 到 body，与旧版
// body-appended overlay 等价）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT, t } from '../../i18n'
import { DiscordAccessPanel, WechatFlow, WhatsappFlow } from './panels'
import styles from './channels.module.css'
import { writeClipboardText } from '../../clipboard'
import { isChannelConfigured, isSavedChannelFailure, type ChannelPresentationState } from './channel-state'
import { finishAfterMinimumDuration } from './refresh-timing'

interface ChannelInput { 0: string; 1: string; 2: string; 3: string; 4?: string }
interface GuideStep {
  num: string
  text: string
  link?: { href: string; label: string }
  action?: { id: string; label: string }
}
interface ChannelDef {
  id: string
  name: string
  icon: string
  desc: string
  inputs: [string, string, string, string, string?][]
  guide?: GuideStep[]
  flow?: 'wechat-qr' | 'whatsapp-qr'
}
interface ChannelState extends ChannelPresentationState {
  id: string
}

const api = () => (window as any).klaus.channels
const showToast = (msg: string) => (window as any).showToast?.(msg)
const confirmDanger = (message: string) =>
  (window as any).klausDialog.confirm({ message, danger: true })

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || '').trim()
    if (message) return message
  }
  const message = typeof error === 'string' ? error.trim() : ''
  return message || fallback
}

function requireOk(result: any, fallback: string): void {
  if (result === false || result?.ok === false) throw new Error(result?.error || fallback)
}

const FEISHU_PERMISSIONS_JSON = '{"scopes":{"tenant":["contact:contact.base:readonly","docx:document:readonly","im:chat:read","im:chat:update","im:message.group_at_msg:readonly","im:message.p2p_msg:readonly","im:message.pins:read","im:message.pins:write_only","im:message.reactions:read","im:message.reactions:write_only","im:message:readonly","im:message:recall","im:message:send_as_bot","im:message:send_multi_users","im:message:send_sys_msg","im:message:update","im:resource","application:application:self_manage","cardkit:card:write","cardkit:card:read"],"user":["contact:user.employee_id:readonly","offline_access"]}}'

function buildChannelDefs(): ChannelDef[] {
  return [
    { id: 'wechat', name: 'WeChat', icon: 'wechat-icon.png', desc: t('ch_wechat_desc'), inputs: [], flow: 'wechat-qr' },
    {
      id: 'wecom', name: 'WeCom', icon: 'wecom-icon.png', desc: t('ch_wecom_desc'),
      inputs: [['botid', 'bot_id', 'Bot ID', 'text', 'Enter Bot ID'], ['secret', 'secret', 'Secret', 'password', 'Enter Secret']],
      guide: [
        { num: '1', text: t('ch_wecom_step1'), link: { href: 'https://work.weixin.qq.com/wework_admin/frame#manageTools', label: t('ch_wecom_step1_link') } },
        { num: '2', text: t('ch_wecom_step2') },
        { num: '3', text: t('ch_wecom_step3') },
        { num: '4', text: t('ch_wecom_step4') },
      ],
    },
    {
      id: 'qq', name: 'QQ', icon: 'qq-icon.png', desc: t('ch_qq_desc'),
      inputs: [['appid', 'app_id', 'App ID', 'text', '102xxxxxx'], ['secret', 'client_secret', 'App Secret', 'password', 'Enter App Secret']],
      guide: [
        { num: '1', text: t('ch_qq_step1'), link: { href: 'https://q.qq.com/', label: t('ch_qq_step1_link') } },
        { num: '2', text: t('ch_qq_step2') },
        { num: '3', text: t('ch_qq_step3') },
      ],
    },
    {
      id: 'feishu', name: 'Feishu / Lark', icon: 'feishu.png', desc: t('ch_feishu_desc'),
      inputs: [['appid', 'app_id', 'App ID', 'text', 'cli_xxxxxxxxxxxxxxxx'], ['secret', 'app_secret', 'App Secret', 'password', 'Enter App Secret']],
      guide: [
        { num: '1', text: t('ch_feishu_step1'), link: { href: 'https://open.feishu.cn/app', label: t('ch_feishu_step1_link') } },
        { num: '2', text: t('ch_feishu_step2') },
        { num: '3', text: t('ch_feishu_step3'), action: { id: 'feishu-copy-perms', label: t('ch_feishu_copy_perms') } },
        { num: '4', text: t('ch_feishu_step4') },
      ],
    },
    {
      id: 'dingtalk', name: 'DingTalk', icon: 'dingtalk.png', desc: t('ch_dingtalk_desc'),
      inputs: [['clientid', 'client_id', 'Client ID (AppKey)', 'text', 'dingxxxxxxxx'], ['secret', 'client_secret', 'Client Secret (AppSecret)', 'password', 'Enter Client Secret']],
      guide: [
        { num: '1', text: t('ch_dingtalk_step1'), link: { href: 'https://open-dev.dingtalk.com/fe/app', label: t('ch_dingtalk_step1_link') } },
        { num: '2', text: t('ch_dingtalk_step2') },
        { num: '3', text: t('ch_dingtalk_step3') },
      ],
    },
    {
      id: 'telegram', name: 'Telegram', icon: 'telegram-icon.png', desc: t('ch_telegram_desc'),
      inputs: [['token', 'bot_token', 'Bot Token', 'password', '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11']],
      guide: [
        { num: '1', text: t('ch_telegram_step1'), link: { href: 'https://t.me/BotFather', label: t('ch_telegram_step1_link') } },
        { num: '2', text: t('ch_telegram_step2') },
        { num: '3', text: t('ch_telegram_step3') },
        { num: '4', text: t('ch_telegram_step4') },
      ],
    },
    {
      id: 'discord', name: 'Discord', icon: 'discord-icon.svg', desc: t('ch_discord_desc'),
      inputs: [['token', 'bot_token', 'Bot Token', 'password', 'MTIz...']],
      guide: [
        { num: '1', text: t('ch_discord_step1'), link: { href: 'https://discord.com/developers/applications', label: t('ch_discord_step1_link') } },
        { num: '2', text: t('ch_discord_step2') },
        { num: '3', text: t('ch_discord_step3') },
        { num: '4', text: t('ch_discord_step4') },
      ],
    },
    { id: 'whatsapp', name: 'WhatsApp', icon: 'whatsapp-icon.png', desc: t('ch_whatsapp_desc'), inputs: [], flow: 'whatsapp-qr' },
  ]
}

// ---- 搜索状态：header 输入框在岛外（共享 chrome），用模块级状态 + 触发器桥接 ----
let channelsSearch = ''
let bumpSearch: (() => void) | null = null
export function bindChannelsSearchInput(): void {
  const input = document.getElementById('channels-search') as HTMLInputElement | null
  if (!input || input.dataset.bound === '1') return
  input.dataset.bound = '1'
  input.value = channelsSearch
  input.addEventListener('input', () => {
    channelsSearch = input.value || ''
    bumpSearch?.()
  })
}

export function ChannelsPage() {
  const t = useT()
  const [channels, setChannels] = useState<ChannelState[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [modalId, setModalId] = useState<string | null>(null)
  const [, setTick] = useState(0)

  const reload = useCallback(async () => {
    setLoadError('')
    try {
      const list = await api().list()
      if (!Array.isArray(list)) throw new Error(t('channels_load_failed'))
      setChannels(list)
    } catch (error) {
      setLoadError(errorMessage(error, t('channels_load_failed')))
    }
  }, [t])

  useEffect(() => {
    reload()
    bumpSearch = () => { setTick(n => n + 1) }
    bindChannelsSearchInput()
    const refreshBtn = document.getElementById('channels-refresh')
    const onRefresh = async () => {
      refreshBtn?.classList.add('spinning')
      try { await finishAfterMinimumDuration(reload, 600) } finally { refreshBtn?.classList.remove('spinning') }
    }
    refreshBtn?.addEventListener('click', onRefresh)
    const unsubscribe = (window as any).klaus?.on?.appPreferencesChanged?.(({ key }: { key?: string }) => {
      if (key === 'channels') void reload()
    })
    return () => {
      bumpSearch = null
      refreshBtn?.removeEventListener('click', onRefresh)
      unsubscribe?.()
    }
  }, [reload])

  const filterTextMatches = (window as any).filterTextMatches as (q: string, hay: string[]) => boolean
  const defs = buildChannelDefs().filter(ch => filterTextMatches(channelsSearch, [ch.id, ch.name, ch.desc]))
  const stateMap = new Map((channels || []).map(c => [c.id, c]))

  // 冷启动壳：状态 IPC 回来前给品牌加载态，不留白屏（与旧 dataset.ready 行为一致）。
  if (channels === null && !loadError) {
    return (
      <div
        className="channels-section"
        dangerouslySetInnerHTML={{ __html: (window as any).klsLoading.render() }}
      />
    )
  }

  return (
    <div className="channels-section">
      {loadError && (
        <div className="empty-text sk-empty" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn-sm" onClick={() => { void reload() }}>{t('channels_retry')}</button>
        </div>
      )}
      {channels !== null && (defs.length ? (
        <div className={styles['ch-grid']}>
          {defs.map(ch => {
            const configured = isChannelConfigured(stateMap.get(ch.id), ch.inputs.map(input => input[1]))
            return (
              <div className={styles['ch-card']} data-ch-id={ch.id} key={ch.id}>
                <div className={styles['ch-card-head']}>
                  <div className={styles['ch-card-left']}>
                    <img src={ch.icon} alt={ch.name} width={42} height={42} className={styles['ch-card-icon']} />
                    <div className={styles['ch-card-name']}>{ch.name}</div>
                  </div>
                  <button
                    className={`${styles['ch-card-btn']} ${configured ? 'connected' : ''}`}
                    onClick={() => setModalId(ch.id)}
                  >
                    {configured ? t('ch_configured') : t('ch_setup')}
                  </button>
                </div>
                <div className={styles['ch-card-desc']}>{ch.desc || ''}</div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="empty-text sk-empty">{t('channels_search_empty')}</p>
      ))}
      {modalId && (
        <ChannelModal
          key={modalId}
          id={modalId}
          onClose={() => setModalId(null)}
          onChanged={() => { reload() }}
        />
      )}
    </div>
  )
}

function ChannelModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT()
  const [state, setState] = useState<ChannelState | null | undefined>(undefined)
  const [loadError, setLoadError] = useState('')
  const [reloadSequence, setReloadSequence] = useState(0)
  const ch = buildChannelDefs().find(c => c.id === id)

  useEffect(() => {
    let alive = true
    setLoadError('')
    void api().list()
      .then((list: ChannelState[]) => {
        if (!Array.isArray(list)) throw new Error(t('channels_load_failed'))
        if (alive) setState(list.find(c => c.id === id) ?? null)
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(errorMessage(error, t('channels_load_failed')))
      })
    return () => { alive = false }
  }, [id, reloadSequence, t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    // Keep the opening snapshot stable: WhatsApp is enabled before its QR arrives,
    // so a preference push must not replace the pairing flow while it is scanning.
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!ch) return null
  const configured = isChannelConfigured(state, ch.inputs.map(input => input[1]))
  const loadingState = state === undefined

  return createPortal(
    <div
      id="ch-modal-overlay"
      className={`${styles['ch-modal-overlay']} show`}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={styles['ch-modal']} role="dialog" aria-modal="true" aria-labelledby="ch-modal-title">
        <div className={styles['ch-modal-header']}>
          <div className={styles['ch-modal-head-left']}>
            <img id="ch-modal-icon" width={36} height={36} alt="" className={styles['ch-modal-icon']} src={ch.icon} />
            <div>
              <div className={styles['ch-modal-title']} id="ch-modal-title">{ch.name}</div>
              <div className={styles['ch-modal-desc']} id="ch-modal-desc">{ch.desc || ''}</div>
            </div>
          </div>
          <button className={styles['ch-modal-close']} id="ch-modal-close-btn" aria-label={t('close')} onClick={onClose}>&times;</button>
        </div>
        <div className={styles['ch-modal-body']} id="ch-modal-body">
          {loadError ? (
            <div className="empty-text sk-empty" role="alert">
              <p>{loadError}</p>
              <button type="button" className="btn-sm" onClick={() => setReloadSequence(value => value + 1)}>{t('channels_retry')}</button>
            </div>
          ) : loadingState ? (
            <div dangerouslySetInnerHTML={{ __html: (window as any).klsLoading.render() }} />
          ) : ch.flow === 'wechat-qr' ? (
            <WechatFlow configured={configured} state={state} onClose={onClose} onChanged={onChanged} />
          ) : ch.flow === 'whatsapp-qr' ? (
            <WhatsappFlow configured={configured} onClose={onClose} onChanged={onChanged} />
          ) : configured ? (
            <ConnectedPanel ch={ch} state={state} onClose={onClose} onChanged={onChanged} />
          ) : (
            <ConnectForm ch={ch} state={state} onClose={onClose} onChanged={onChanged} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ConnectedPanel({ ch, state, onClose, onChanged }: {
  ch: ChannelDef; state: ChannelState | null; onClose: () => void; onChanged: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  return (
    <div className={styles['ch-connected']}>
      {ch.inputs.filter(i => i[3] !== 'password').map(i => (
        <div className={styles['ch-connected-field']} key={i[1]}>
          <div className={styles['ch-connected-label']}>{i[2]}</div>
          <div className={styles['ch-connected-value']}>{state?.credentials?.[i[1]] || '-'}</div>
        </div>
      ))}
      {ch.id === 'discord' && <DiscordAccessPanel />}
      <button
        className={`s-btn ${styles['s-btn-danger']}`}
        disabled={busy}
        onClick={async () => {
          if (!(await confirmDanger(t('settings_confirm_delete')))) return
          setBusy(true)
          try {
            const result = await api().disconnect(ch.id)
            requireOk(result, t('settings_ch_connect_fail'))
            showToast(t('settings_ch_disconnected'))
            onClose()
            onChanged()
          } catch (error) {
            showToast(errorMessage(error, t('settings_ch_connect_fail')))
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('ch_disconnect')}
      </button>
    </div>
  )
}

function ConnectForm({ ch, state, onClose, onChanged }: {
  ch: ChannelDef; state: ChannelState | null; onClose: () => void; onChanged: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const valuesRef = useRef<Record<string, string>>({})

  const connect = async () => {
    const payload: Record<string, string> = {}
    for (const [key, backendKey] of ch.inputs) {
      const val = (valuesRef.current[key] ?? state?.credentials?.[backendKey] ?? '').trim()
      if (!val) { showToast(t('ch_fields_required')); return }
      payload[backendKey] = val
    }
    setBusy(true)
    try {
      const result = await api().connect(ch.id, payload)
      if (isSavedChannelFailure(result)) {
        showToast(result.error || t('settings_ch_connect_fail'))
        onClose()
        onChanged()
        return
      }
      requireOk(result, t('settings_ch_connect_fail'))
      showToast(t('settings_ch_connect_ok'))
      onClose()
      onChanged()
    } catch (error) {
      showToast(errorMessage(error, t('settings_ch_connect_fail')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {ch.guide && (
        <div className={styles['ch-guide']}>
          <div className={styles['ch-guide-title']}>{t('ch_setup_steps')}</div>
          {ch.guide.map(g => (
            <div className={styles['ch-guide-row']} key={g.num}>
              <span className={styles['ch-guide-num']}>{g.num}.</span> <span>{g.text}</span>
              {g.link && <> <a href={g.link.href} target="_blank" rel="noopener" className={styles['ch-guide-link']}>{g.link.label}</a></>}
              {g.action && (
                <>
                  {' '}
                  <button
                    className={`s-btn ${styles['s-btn-ghost']} ${styles['ch-guide-action']}`}
                    id={`ch-guide-${g.action.id}`}
                    onClick={() => {
                      void writeClipboardText(FEISHU_PERMISSIONS_JSON)
                        .then(() => showToast(t('ch_feishu_perms_copied')))
                        .catch(() => showToast(t('copy_failed')))
                    }}
                  >
                    {g.action.label}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div className={styles['ch-form']}>
        {ch.inputs.map(([key, backendKey, label, type, placeholder]) => (
          <div className={styles['ch-form-field']} key={key}>
            <label className="kls-field-label">{label} <span className={styles['ch-required']}>*</span></label>
            <input
              className="kls-input"
              id={`ch-inp-${ch.id}-${key}`}
              type={type}
              placeholder={placeholder || ''}
              defaultValue={state?.credentials?.[backendKey] || ''}
              onChange={e => { valuesRef.current[key] = e.target.value }}
            />
          </div>
        ))}
      </div>
      <div className={styles['ch-form-actions']}>
        <button className="s-btn s-btn-primary" id="ch-modal-connect" disabled={busy} onClick={connect}>
          {busy ? t('settings_ch_connecting') : t('ch_connect')}
        </button>
      </div>
    </>
  )
}
