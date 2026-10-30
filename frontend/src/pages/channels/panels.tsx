// Channels 页的三个复杂子面板：Discord 访问控制、微信/WhatsApp 扫码接入流。
// 迁自 js/pages/channels.js，类名/文案键逐一对应。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import styles from './channels.module.css'
import { isSavedChannelFailure } from './channel-state'

const api = () => (window as any).klaus.channels
const showToast = (msg: string) => (window as any).showToast?.(msg)

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

interface DiscordSnapshot {
  dmPolicy: string
  pending: { code: string; senderId: string }[]
  allowFrom: string[]
  groups: { channelId: string; requireMention?: boolean }[]
  ackReaction?: string
  replyToMode?: string
  textChunkLimit?: number
  mentionPatterns?: string[]
}

export function DiscordAccessPanel() {
  const t = useT()
  const [snap, setSnap] = useState<DiscordSnapshot | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState('')
  const refresh = useCallback(async () => {
    setLoadError('')
    try {
      const next = await api().discordAccess()
      if (!next || typeof next !== 'object') throw new Error(t('channels_load_failed'))
      setSnap(next)
    } catch (error) {
      setLoadError(errorMessage(error, t('channels_load_failed')))
    }
  }, [t])
  useEffect(() => { void refresh() }, [refresh])

  // 表单散值用 ref 收集（保存时一次性读取，与旧实现的「点保存才读输入框」一致）
  const allowInput = useRef<HTMLInputElement>(null)
  const groupId = useRef<HTMLInputElement>(null)
  const groupAllow = useRef<HTMLInputElement>(null)
  const groupMention = useRef<HTMLInputElement>(null)
  const ackReaction = useRef<HTMLInputElement>(null)
  const replyMode = useRef<HTMLSelectElement>(null)
  const chunkLimit = useRef<HTMLInputElement>(null)
  const mentionPatterns = useRef<HTMLTextAreaElement>(null)

  if (!snap) {
    return (
      <div id="discord-access-panel">
        {loadError ? (
          <div className="empty-text sk-empty" role="alert">
            <p>{loadError}</p>
            <button type="button" className="btn-sm" onClick={() => { void refresh() }}>{t('channels_retry')}</button>
          </div>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: (window as any).klsLoading.render() }} />
        )}
      </div>
    )
  }

  const runAction = async (key: string, action: () => Promise<any>, success: string) => {
    if (busy) return
    setBusy(key)
    try {
      const result = await action()
      requireOk(result, t('settings_ch_connect_fail'))
      showToast(success)
    } catch (error) {
      showToast(errorMessage(error, t('settings_ch_connect_fail')))
    } finally {
      await refresh()
      setBusy('')
    }
  }

  return (
    <div id="discord-access-panel">
      {loadError && (
        <div className="empty-text sk-empty" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn-sm" onClick={() => { void refresh() }}>{t('channels_retry')}</button>
        </div>
      )}
      <div className={styles['ch-guide']}>
        <div className={styles['ch-guide-title']}>{t('ch_discord_access_title')}</div>
        <div className={styles['ch-form-field']}>
          <label className="kls-field-label">{t('ch_discord_dm_policy')}</label>
          <select
            className="kls-input"
            id="discord-dm-policy"
            defaultValue={snap.dmPolicy}
            disabled={Boolean(busy)}
            onChange={e => { void runAction('dm-policy', () => api().discordSetDmPolicy(e.target.value), t('saved')) }}
          >
            <option value="pairing">{t('ch_discord_dm_pairing')}</option>
            <option value="allowlist">{t('ch_discord_dm_allowlist')}</option>
            <option value="disabled">{t('ch_discord_dm_disabled')}</option>
          </select>
        </div>

        <div className={styles['ch-guide-title']}>{t('ch_discord_pending')}</div>
        {snap.pending.length ? snap.pending.map(p => (
          <div className={styles['ch-connected-field']} data-discord-pending={p.code} key={p.code}>
            <div>
              <div className={styles['ch-connected-label']}>{t('ch_discord_pair_code')} {p.code}</div>
              <div className={styles['ch-connected-value']}>{p.senderId}</div>
            </div>
            <div className={styles['ch-form-actions']}>
              <button
                className="s-btn s-btn-primary"
                disabled={Boolean(busy)}
                onClick={() => { void runAction(`approve:${p.code}`, () => api().discordApprovePending(p.code), t('approved')) }}
              >
                {t('approve')}
              </button>
              <button
                className={`s-btn ${styles['s-btn-ghost']}`}
                disabled={Boolean(busy)}
                onClick={() => { void runAction(`deny:${p.code}`, () => api().discordDenyPending(p.code), t('denied')) }}
              >
                {t('deny')}
              </button>
            </div>
          </div>
        )) : <p className="hint-text">{t('ch_discord_no_pending')}</p>}

        <div className={styles['ch-guide-title']}>{t('ch_discord_dm_allowlist_title')}</div>
        {snap.allowFrom.length ? snap.allowFrom.map(id => (
          <div className={styles['ch-connected-field']} key={id}>
            <div className={styles['ch-connected-value']}>{id}</div>
            <button
              className={`s-btn ${styles['s-btn-ghost']}`}
              disabled={Boolean(busy)}
              onClick={() => { void runAction(`remove-user:${id}`, () => api().discordRemoveAllowFrom(id), t('removed')) }}
            >
              {t('remove')}
            </button>
          </div>
        )) : <p className="hint-text">{t('ch_discord_allow_empty')}</p>}
        <div className={styles['ch-form-actions']}>
          <input className="kls-input" id="discord-allow-input" ref={allowInput} placeholder={t('ch_discord_user_id_placeholder')} />
          <button
            className="s-btn s-btn-primary"
            id="discord-add-allow"
            disabled={Boolean(busy)}
            onClick={() => {
              const senderId = allowInput.current?.value?.trim()
              if (!senderId) return
              void runAction('add-user', () => api().discordAddAllowFrom(senderId), t('saved'))
            }}
          >
            {t('add')}
          </button>
        </div>

        <div className={styles['ch-guide-title']}>{t('ch_discord_groups_title')}</div>
        {snap.groups.length ? snap.groups.map(g => (
          <div className={styles['ch-connected-field']} key={g.channelId}>
            <div>
              <div className={styles['ch-connected-label']}>{g.channelId}</div>
              <div className={styles['ch-connected-value']}>
                {g.requireMention ? t('ch_discord_require_mention') : t('ch_discord_no_mention_required')}
              </div>
            </div>
            <button
              className={`s-btn ${styles['s-btn-ghost']}`}
              disabled={Boolean(busy)}
              onClick={() => { void runAction(`remove-group:${g.channelId}`, () => api().discordRemoveGroup(g.channelId), t('removed')) }}
            >
              {t('remove')}
            </button>
          </div>
        )) : <p className="hint-text">{t('ch_discord_groups_empty')}</p>}
        <div className={styles['ch-form-field']}>
          <input className="kls-input" id="discord-group-id" ref={groupId} placeholder={t('ch_discord_channel_id_placeholder')} />
        </div>
        <div className={styles['ch-form-field']}>
          <input className="kls-input" id="discord-group-allow" ref={groupAllow} placeholder={t('ch_discord_group_allow_placeholder')} />
        </div>
        <label className={styles['ch-checkbox-row']}>
          <input type="checkbox" id="discord-group-mention" ref={groupMention} defaultChecked />
          <span>{t('ch_discord_require_mention')}</span>
        </label>
        <div className={styles['ch-form-actions']}>
          <button
            className="s-btn s-btn-primary"
            id="discord-add-group"
            disabled={Boolean(busy)}
            onClick={() => {
              const channelId = groupId.current?.value?.trim()
              if (!channelId) return
              const allowFrom = (groupAllow.current?.value || '')
                .split(',')
                .map(value => value.trim())
                .filter(Boolean)
              void runAction('add-group', () => api().discordUpsertGroup({
                channelId,
                requireMention: groupMention.current?.checked !== false,
                allowFrom,
              }), t('saved'))
            }}
          >
            {t('ch_discord_add_group')}
          </button>
        </div>

        <div className={styles['ch-guide-title']}>{t('ch_discord_delivery_title')}</div>
        <div className={styles['ch-form-field']}>
          <label className="kls-field-label">{t('ch_discord_ack_reaction')}</label>
          <input className="kls-input" id="discord-ack-reaction" ref={ackReaction} defaultValue={snap.ackReaction || ''} placeholder="emoji" />
        </div>
        <div className={styles['ch-form-field']}>
          <label className="kls-field-label">{t('ch_discord_reply_mode')}</label>
          <select className="kls-input" id="discord-reply-mode" ref={replyMode} defaultValue={snap.replyToMode || 'first'}>
            <option value="first">first</option>
            <option value="all">all</option>
            <option value="off">off</option>
          </select>
        </div>
        <div className={styles['ch-form-field']}>
          <label className="kls-field-label">{t('ch_discord_chunk_limit')}</label>
          <input className="kls-input" id="discord-chunk-limit" ref={chunkLimit} type="number" min={1} max={2000} defaultValue={String(snap.textChunkLimit || 2000)} />
        </div>
        <div className={styles['ch-form-field']}>
          <label className="kls-field-label">{t('ch_discord_mention_patterns')}</label>
          <textarea className="kls-input" id="discord-mention-patterns" ref={mentionPatterns} rows={3} defaultValue={(snap.mentionPatterns || []).join('\n')} />
        </div>
        <div className={styles['ch-form-actions']}>
          <button
            className="s-btn s-btn-primary"
            id="discord-save-delivery"
            disabled={Boolean(busy)}
            onClick={() => {
              void runAction('save-delivery', () => api().discordUpdateDelivery({
                ackReaction: ackReaction.current?.value || '',
                replyToMode: replyMode.current?.value || 'first',
                textChunkLimit: chunkLimit.current?.value || '2000',
                mentionPatterns: mentionPatterns.current?.value || '',
              }), t('saved'))
            }}
          >
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- 微信扫码接入流 ---
export function WechatFlow({ configured, state, onClose, onChanged }: {
  configured: boolean
  state: { credentials?: Record<string, string> } | null
  onClose: () => void
  onChanged: () => void
}) {
  const t = useT()
  const [qrSrc, setQrSrc] = useState('')
  const [status, setStatus] = useState(() => t('ch_wechat_loading'))

  useEffect(() => {
    if (configured) return
    let timer: ReturnType<typeof setInterval> | null = null
    let alive = true
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    void api().wechatQrStart()
      .then((result: any) => {
        if (!alive) return
        requireOk(result, t('settings_ch_connect_fail'))
        setQrSrc(result.qrcodeDataUrl)
        setStatus(t('ch_wechat_waiting'))
        timer = setInterval(async () => {
          try {
            const r = await api().wechatQrPoll()
            if (!alive) return
            if (isSavedChannelFailure(r)) {
              stop()
              showToast(r.error || t('settings_ch_connect_fail'))
              onClose()
              onChanged()
              return
            }
            requireOk(r, t('settings_ch_connect_fail'))
            if (r.status === 'scaned') setStatus(t('ch_wechat_scanned'))
            else if (r.status === 'confirmed') {
              stop()
              showToast(t('settings_ch_connect_ok'))
              onClose()
              onChanged()
            } else if (r.status === 'expired') {
              stop()
              setStatus(t('ch_wechat_expired'))
            }
          } catch (error) {
            stop()
            if (alive) setStatus(errorMessage(error, t('settings_ch_connect_fail')))
          }
        }, 3000)
      })
      .catch((error: unknown) => {
        if (alive) setStatus(errorMessage(error, t('settings_ch_connect_fail')))
      })
    return () => { alive = false; stop() }
    // eslint 缺席：依赖刻意只在挂载时启动一次轮询
  }, [configured])

  if (configured) {
    return (
      <div className={styles['ch-connected']}>
        <div className={styles['ch-connected-field']}>
          <div>
            <div className={styles['ch-connected-label']}>Account ID</div>
            <div className={styles['ch-connected-value']}>{state?.credentials?.account_id || '-'}</div>
          </div>
          <button
            className={`s-btn ${styles['s-btn-danger']}`}
            onClick={async () => {
              if (!(await (window as any).klausDialog.confirm({ message: t('settings_confirm_delete'), danger: true }))) return
              try {
                const result = await api().disconnect('wechat')
                requireOk(result, t('settings_ch_connect_fail'))
                showToast(t('settings_ch_disconnected'))
                onClose()
                onChanged()
              } catch (error) {
                showToast(errorMessage(error, t('settings_ch_connect_fail')))
              }
            }}
          >
            {t('ch_disconnect')}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className={styles['ch-qr-wrap']}>
      <div className={styles['ch-qr-hint']}>{t('ch_wechat_scan_hint')}</div>
      <img id="ch-wx-qr-img" className={styles['ch-qr-img']} alt="QR Code" src={qrSrc || undefined} />
      <div id="ch-wx-qr-status" className={styles['ch-qr-status']}>{status}</div>
    </div>
  )
}

// --- WhatsApp 扫码接入流 ---
export function WhatsappFlow({ configured, onClose, onChanged }: {
  configured: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const t = useT()
  const [qrSrc, setQrSrc] = useState('')
  const [status, setStatus] = useState(() => t('ch_whatsapp_loading'))

  useEffect(() => {
    if (configured) return
    let timer: ReturnType<typeof setInterval> | null = null
    let alive = true
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const updateQr = (r: any): boolean => {
      if (!alive) return true
      if (r.status === 'connected') {
        stop()
        showToast(t('settings_ch_connect_ok'))
        onClose()
        onChanged()
        return true
      }
      if (r.status === 'qr' && r.qrcodeDataUrl) {
        setQrSrc(r.qrcodeDataUrl)
        setStatus(t('ch_whatsapp_waiting'))
      } else {
        setStatus(t('ch_whatsapp_loading'))
      }
      return false
    }
    void api().whatsappStart()
      .then((r: any) => {
        if (!alive) return
        requireOk(r, t('settings_ch_connect_fail'))
        if (updateQr(r)) return
        timer = setInterval(async () => {
          try {
            const next = await api().whatsappPoll()
            if (!alive) return
            requireOk(next, t('settings_ch_connect_fail'))
            updateQr(next)
          } catch (error) {
            stop()
            if (alive) setStatus(errorMessage(error, t('settings_ch_connect_fail')))
          }
        }, 3000)
      })
      .catch((error: unknown) => {
        if (alive) setStatus(errorMessage(error, t('settings_ch_connect_fail')))
      })
    return () => { alive = false; stop() }
  }, [configured])

  if (configured) {
    return (
      <div className={styles['ch-connected']}>
        <div className={styles['ch-connected-field']}>
          <div className={styles['ch-connected-label']}>{t('ch_connected')}</div>
          <button
            className={`s-btn ${styles['s-btn-danger']}`}
            onClick={async () => {
              if (!(await (window as any).klausDialog.confirm({ message: t('settings_confirm_delete'), danger: true }))) return
              try {
                const result = await api().disconnect('whatsapp')
                requireOk(result, t('settings_ch_connect_fail'))
                showToast(t('settings_ch_disconnected'))
                onClose()
                onChanged()
              } catch (error) {
                showToast(errorMessage(error, t('settings_ch_connect_fail')))
              }
            }}
          >
            {t('ch_disconnect')}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className={styles['ch-qr-wrap']}>
      <div className={styles['ch-qr-hint']}>{t('ch_whatsapp_scan_hint')}</div>
      <img id="ch-wa-qr-img" className={styles['ch-qr-img']} alt="QR Code" src={qrSrc || undefined} style={qrSrc ? undefined : { display: 'none' }} />
      <div id="ch-wa-qr-status" className={styles['ch-qr-status']}>{status}</div>
    </div>
  )
}
