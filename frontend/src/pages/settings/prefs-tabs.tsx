// Preferences / 权限规则两 tab（迁自 js/settings.js 的 loadPreferencesTab /
// loadPermissionRulesTab 及 pref* helpers）。类名与旧版逐一对应。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT, t as tGlobal } from '../../i18n'
import { PrefToggleRow, SettingsPage, kvSet, useSettingsDraftSync } from './kv'
import styles from './settings.module.css'
import type { PowerSaveSnapshot } from '../../../../contracts/power-save'
import { useSettingsSnapshot } from './settings-snapshot'
import { FeatureModelRow, useFeatureModelSettings } from './feature-models'
import { PREDICTION_FEATURE_MODEL_ROW, TITLE_FEATURE_MODEL_ROW } from './feature-models-state'
import { RuntimeSettingsTab } from './runtime-tab'

const w = () => window as any

// ==================== Preferences ====================
// 回复风格（output style）从输入框「+」菜单迁到偏好设置：全局用户级配置，写 userSettings.outputStyle。

interface OutputStyle {
  id: string
  name?: string
  source?: string
  description?: string
  isDefault?: boolean
}

function prefFallbackOutputStyles(defaultStyle = 'default'): OutputStyle[] {
  return [
    { id: defaultStyle, name: defaultStyle, source: 'built-in', isDefault: true },
    { id: 'Learning', name: 'Learning', source: 'built-in' },
    { id: 'Explanatory', name: 'Explanatory', source: 'built-in' },
  ]
}

function prefOutputStyleDisplayName(style: OutputStyle | undefined, defaultStyle: string): string {
  const id = String(style?.id || '')
  if (id === defaultStyle || style?.isDefault) return tGlobal('output_style_normal')
  if (id === 'Learning') return tGlobal('output_style_learning')
  if (id === 'Explanatory') return tGlobal('output_style_explanatory')
  return String(style?.name || id || tGlobal('composer_use_style'))
}

function prefOutputStyleDescription(style: OutputStyle | undefined): string {
  if (style?.isDefault) return tGlobal('output_style_normal_desc')
  if (style?.id === 'Learning') return tGlobal('output_style_learning_desc')
  if (style?.id === 'Explanatory') return tGlobal('output_style_explanatory_desc')
  const source = String(style?.source || '')
  const desc = String(style?.description || '').trim()
  if (desc) return desc
  if (source === 'plugin') return tGlobal('output_style_plugin_desc')
  if (source === 'projectSettings') return tGlobal('output_style_project_desc')
  if (source === 'userSettings') return tGlobal('output_style_user_desc')
  return tGlobal('composer_use_style_desc')
}

function prefSortOutputStyles(styles: OutputStyle[], defaultStyle: string): OutputStyle[] {
  const rank = (style: OutputStyle) => {
    if (style?.id === defaultStyle || style?.isDefault) return 0
    if (style?.id === 'Learning') return 1
    if (style?.id === 'Explanatory') return 2
    if (style?.source === 'built-in') return 3
    if (style?.source === 'plugin') return 4
    return 5
  }
  return [...(styles || [])].sort((a, b) => {
    const delta = rank(a) - rank(b)
    if (delta !== 0) return delta
    return prefOutputStyleDisplayName(a, defaultStyle).localeCompare(prefOutputStyleDisplayName(b, defaultStyle), undefined, { sensitivity: 'base' })
  })
}

interface PrefsData {
  predictions: boolean
  keepAwake: boolean
  platform: string
  loginItem: boolean
  notifyDesktop: boolean
  notifySound: boolean
  notifyFriendToast: boolean
  followUpMode: string
  outputStyles: OutputStyle[]
  defaultOutputStyle: string
  currentOutputStyle: string
  wsExcludes: string
}

export function PreferencesTab() {
  const t = useT()
  const [data, setData, beginRead] = useSettingsSnapshot<PrefsData | null>('preferences:data', null)
  const featureModels = useFeatureModelSettings()
  const [loadError, setLoadError] = useState('')
  const [reloadSequence, setReloadSequence] = useState(0)
  const [busyKey, setBusyKey] = useState('')
  const [busyStyles, setBusyStyles] = useState(false)
  const [predictionReason, setPredictionReason] = useState('')
  const wsAreaRef = useRef<HTMLTextAreaElement>(null)
  useSettingsDraftSync(data?.wsExcludes ?? '', wsAreaRef)
  const powerRef = useRef<PowerSaveSnapshot | null>(null)

  useEffect(() => w().klaus.powerSave.subscribe((snapshot: PowerSaveSnapshot) => {
    if (powerRef.current && snapshot.revision < powerRef.current.revision) return
    powerRef.current = snapshot
    setData(prev => prev && { ...prev, keepAwake: snapshot.preferences.preventSleepWhileRunning, platform: snapshot.platform })
  }), [])

  useEffect(() => {
    let cancelled = false
    const publish = beginRead()
    void (async () => {
      try {
        const settingsApi = w().settingsApi
        const followUpModeHelper = w().KlausFollowUp
        const [keepAwakeConfig, loginItemConfig, notifyDesktopRaw, notifySoundRaw, notifyFriendToastRaw, followUpRaw, outputStyleData, excludes, predictionsRaw] = await Promise.all([
          w().klaus.powerSave.snapshot(),
          w().klaus.app.loginItem.get(),
          settingsApi.kv.get('notification.desktop'),
          settingsApi.kv.get('notification.sound'),
          settingsApi.kv.get('notification.friendToast'),
          settingsApi.kv.get(followUpModeHelper?.FOLLOW_UP_QUEUE_MODE_KEY || 'follow_up_queue_mode'),
          settingsApi.outputStyles?.list ? settingsApi.outputStyles.list() : Promise.resolve(null),
          w().klaus.workspace.getExcludes(),
          settingsApi.kv.get('composer_predictions_enabled'),
        ])
        const failed = [keepAwakeConfig, loginItemConfig, outputStyleData, excludes]
          .find((value: any) => value?.ok === false || value?.error)
        if (failed) throw new Error(failed.error || t('preferences_load_failed'))
        const defaultOutputStyle = outputStyleData?.defaultStyle || 'default'
        const currentOutputStyle = outputStyleData?.current || defaultOutputStyle
        const outputStyles = prefSortOutputStyles(
          Array.isArray(outputStyleData?.styles) && outputStyleData.styles.length > 0
            ? outputStyleData.styles
            : prefFallbackOutputStyles(defaultOutputStyle),
          defaultOutputStyle,
        )
        if (!outputStyles.some(style => style.id === currentOutputStyle)) {
          outputStyles.push({ id: currentOutputStyle, name: currentOutputStyle })
        }
        if (cancelled) return
        if (!powerRef.current || keepAwakeConfig.revision >= powerRef.current.revision) powerRef.current = keepAwakeConfig
        const power = powerRef.current!
        setLoadError('')
        publish({
          predictions: predictionsRaw !== 'off',
          keepAwake: power.preferences.preventSleepWhileRunning,
          platform: power.platform,
          loginItem: loginItemConfig?.enabled === true,
          notifyDesktop: notifyDesktopRaw !== 'off',
          notifySound: notifySoundRaw !== 'off',
          notifyFriendToast: notifyFriendToastRaw !== 'off',
          followUpMode: followUpModeHelper?.normalizeMode(followUpRaw) || 'queue',
          outputStyles,
          defaultOutputStyle,
          currentOutputStyle,
          wsExcludes: ((excludes?.patterns || []) as string[]).join('\n'),
        })
      } catch (error: any) {
        if (!cancelled) setLoadError(error?.message || t('preferences_load_failed'))
      }
    })()
    return () => { cancelled = true }
  }, [reloadSequence, t, beginRead])

  useEffect(() => {
    let current = true
    void w().klaus.composerPredictions.availability().then((reply: any) => {
      if (current) setPredictionReason(reply.available || reply.reason === 'disabled' ? '' : reply.reason || 'unavailable')
    }).catch(() => { if (current) setPredictionReason('unavailable') })
    const off = w().klaus.on.appPreferencesChanged?.(({ key }: { key: string }) => {
      if (key === 'composer_predictions_enabled') setReloadSequence(value => value + 1)
    })
    return () => { current = false; off?.() }
  }, [reloadSequence])


  if (!data) {
    return (
      <SettingsPage title={t('preferences')} subtitle={t('preferences_desc')}>
        {loadError ? (
          <div className="empty-text sk-empty" role="alert">
            <p>{loadError}</p>
            <button type="button" className="btn-sm" onClick={() => { setLoadError(''); setReloadSequence(value => value + 1) }}>{t('auth_status_retry')}</button>
          </div>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
        )}
      </SettingsPage>
    )
  }
  const settingsApi = w().settingsApi
  const findOutputStyle = (id: string) => data.outputStyles.find(style => style.id === id)

  const toggleRow = (id: string, label: string, desc: string, checked: boolean, onChange: (checked: boolean) => void) => (
    <PrefToggleRow id={id} label={label} desc={desc} checked={checked} disabled={Boolean(busyKey)} onChange={onChange} />
  )

  return (
    <SettingsPage title={t('preferences')} subtitle={t('preferences_desc')}>
      {loadError && <div className="empty-text sk-empty" role="alert"><p>{loadError}</p><button type="button" className="btn-sm" onClick={() => { setLoadError(''); setReloadSequence(value => value + 1) }}>{t('auth_status_retry')}</button></div>}
      <div className="settings-section">
        <div className="settings-section-title">{t('pref_section_editor')}</div>
        <div className={styles['pref-card']}>
          {toggleRow('pref-predictions', t('pref_show_predictions'), t('pref_show_predictions_desc'), data.predictions, async checked => {
            if (busyKey) return
            const previous = data.predictions
            setBusyKey('predictions')
            setData(prev => prev && { ...prev, predictions: checked })
            try {
              if (!(await kvSet('composer_predictions_enabled', checked ? 'on' : 'off'))) setData(prev => prev && { ...prev, predictions: previous })
            } finally { setBusyKey('') }
          })}
          {predictionReason && <p className={styles['prediction-notice']} role="status">{t(`composer_prediction_${['engine_unavailable', 'configuration_unavailable', 'configuration_disabled'].includes(predictionReason) ? predictionReason : 'unavailable'}`)}</p>}
          <FeatureModelRow row={PREDICTION_FEATURE_MODEL_ROW} model={featureModels} />
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">{t('pref_section_conversation')}</div>
        <div className={styles['pref-card']}>
          <div className="pref-row">
            <div className={styles['pref-row-text']}>
              <div className={styles['pref-row-label']} id="follow-up-mode-label">{t('follow_up_behavior')}</div>
              <div className={styles['pref-row-desc']} id="follow-up-mode-desc">{t('follow_up_behavior_desc')}</div>
            </div>
            <div
              className={`${styles['appearance-segmented']} ${styles['follow-up-mode-segment']}`} id="follow-up-mode-choice"
              role="group" aria-labelledby="follow-up-mode-label" aria-describedby="follow-up-mode-desc"
            >
              {(['queue', 'steer'] as const).map(mode => (
                <button
                  type="button" data-follow-up-mode={mode} key={mode}
                  className={data.followUpMode === mode ? 'active' : ''}
                  aria-pressed={data.followUpMode === mode}
                  disabled={Boolean(busyKey)}
                  onClick={async () => {
                    const helper = w().KlausFollowUp
                    const normalized = helper?.normalizeMode(mode) || 'queue'
                    const previous = data.followUpMode
                    setBusyKey('follow-up')
                    setData(prev => prev && { ...prev, followUpMode: normalized })
                    try {
                      const saved = await kvSet(helper?.FOLLOW_UP_QUEUE_MODE_KEY || 'follow_up_queue_mode', normalized)
                      if (!saved) setData(prev => prev && { ...prev, followUpMode: previous })
                      else window.dispatchEvent(new CustomEvent('klaus-follow-up-mode-changed', { detail: { mode: normalized } }))
                    } finally {
                      setBusyKey('')
                    }
                  }}
                >{t(mode === 'queue' ? 'follow_up_queue' : 'follow_up_steer')}</button>
              ))}
            </div>
          </div>
          <div className="pref-row">
            <div className={styles['pref-row-text']}>
              <div className={styles['pref-row-label']} id="pref-output-style-label">{t('composer_use_style')}</div>
              <div className={styles['pref-row-desc']} id="pref-output-style-desc">{prefOutputStyleDescription(findOutputStyle(data.currentOutputStyle))}</div>
            </div>
            <div
              className={`${styles['appearance-segmented']} ${styles['output-style-segment']}`} id="pref-output-style"
              role="group" aria-labelledby="pref-output-style-label" aria-describedby="pref-output-style-desc"
            >
              {data.outputStyles.map(style => (
                <button
                  type="button" data-output-style={style.id} key={style.id}
                  className={style.id === data.currentOutputStyle ? 'active' : ''}
                  aria-pressed={style.id === data.currentOutputStyle}
                  disabled={busyStyles}
                  onClick={async () => {
                    if (style.id === data.currentOutputStyle) return
                    const previous = data.currentOutputStyle
                    setData(prev => prev && { ...prev, currentOutputStyle: style.id })
                    setBusyStyles(true)
                    const res = await settingsApi.outputStyles.set(style.id).catch((err: unknown) => ({ ok: false, error: String(err) }))
                    setBusyStyles(false)
                    if (!res?.ok) {
                      setData(prev => prev && { ...prev, currentOutputStyle: previous })
                      w().showToast(t('output_style_set_failed'))
                      return
                    }
                  }}
                >{prefOutputStyleDisplayName(style, data.defaultOutputStyle)}</button>
              ))}
            </div>
          </div>
          <FeatureModelRow row={TITLE_FEATURE_MODEL_ROW} model={featureModels} />
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">{t('pref_section_app')}</div>
        <div className={styles['pref-card']}>
          {toggleRow('pref-login-item', t('pref_login_item'), t('pref_login_item_desc'), data.loginItem, async (checked) => {
            if (busyKey) return
            setBusyKey('login-item')
            setData(prev => prev && { ...prev, loginItem: checked })
            try {
              const res = await w().klaus.app.loginItem.set(checked)
              if (!res?.ok) throw new Error(res?.error || t('settings_failed'))
            } catch (error: any) {
              setData(prev => prev && { ...prev, loginItem: !checked })
              w().showToast(error?.message || t('settings_failed'))
            } finally {
              setBusyKey('')
            }
          })}
          {data.platform !== 'win32' && toggleRow('pref-keep-awake', t('cron_keep_awake'), t('pref_keep_awake_desc'), data.keepAwake, async (checked) => {
            if (busyKey) return
            const startingRevision = powerRef.current?.revision ?? -1
            setBusyKey('keep-awake')
            setData(prev => prev && { ...prev, keepAwake: checked })
            try {
              const res = await w().klaus.powerSave.setPreference('preventSleepWhileRunning', checked)
              if (!res?.ok) throw new Error(res?.error || t('settings_failed'))
            } catch (error: any) {
              const actual = powerRef.current && powerRef.current.revision > startingRevision ? powerRef.current.preferences.preventSleepWhileRunning : !checked
              setData(prev => prev && { ...prev, keepAwake: actual })
              w().showToast(error?.message || t('settings_failed'))
            } finally {
              setBusyKey('')
            }
          })}
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">{t('pref_section_notifications')}</div>
        <div className={styles['pref-card']}>
          {toggleRow('pref-notify-desktop', t('pref_notify_desktop'), t('pref_notify_desktop_desc'), data.notifyDesktop, async (checked) => {
            if (busyKey) return
            setBusyKey('notify-desktop')
            setData(prev => prev && { ...prev, notifyDesktop: checked })
            try {
              if (!await kvSet('notification.desktop', checked ? 'on' : 'off')) {
                setData(prev => prev && { ...prev, notifyDesktop: !checked })
              }
            } finally {
              setBusyKey('')
            }
          })}
          {toggleRow('pref-notify-sound', t('pref_notify_sound'), t('pref_notify_sound_desc'), data.notifySound, async (checked) => {
            if (busyKey) return
            setBusyKey('notify-sound')
            setData(prev => prev && { ...prev, notifySound: checked })
            try {
              if (!await kvSet('notification.sound', checked ? 'on' : 'off')) {
                setData(prev => prev && { ...prev, notifySound: !checked })
              }
            } finally {
              setBusyKey('')
            }
          })}
          {toggleRow('pref-notify-friend-toast', t('pref_notify_friend_toast'), t('pref_notify_friend_toast_desc'), data.notifyFriendToast, async (checked) => {
            if (busyKey) return
            setBusyKey('notify-friend-toast')
            setData(prev => prev && { ...prev, notifyFriendToast: checked })
            try {
              if (!await kvSet('notification.friendToast', checked ? 'on' : 'off')) {
                setData(prev => prev && { ...prev, notifyFriendToast: !checked })
              }
            } finally {
              setBusyKey('')
            }
          })}
        </div>
      </div>
      <div className="settings-section">
        <div className={styles['settings-section-heading']}>
          <div className={styles['settings-section-title-info-row']}>
            <div className="settings-section-title" id="workspace-excludes-title">{t('settings_workspace')}</div>
            <span
              id="workspace-excludes-desc"
              className={styles['section-info-icon']}
              data-klaus-tip={t('workspace_excludes_desc')}
              aria-label={t('workspace_excludes_desc')}
              dangerouslySetInnerHTML={{ __html: w().KlausIcons?.icon ? w().KlausIcons.icon('settings-section-info', { size: 15 }) : '' }}
            />
          </div>
        </div>
        <div className="settings-card">
          <textarea
            id="ws-excludes" rows={10} className={styles['workspace-excludes-textarea']}
            placeholder={t('workspace_excludes_placeholder')} defaultValue={data.wsExcludes} ref={wsAreaRef}
            aria-labelledby="workspace-excludes-title" aria-describedby="workspace-excludes-desc"
          />
          <div className={styles['settings-inline-actions']}>
            <button
              className="btn-sm btn-primary" id="ws-excludes-save"
              disabled={Boolean(busyKey)}
              onClick={async () => {
                const raw = wsAreaRef.current?.value || ''
                const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0)
                const previous = data.wsExcludes
                setData(current => current && { ...current, wsExcludes: lines.join('\n') })
                setBusyKey('workspace-excludes')
                try {
                  const res = await w().klaus.workspace.setExcludes(lines)
                  if (!res?.ok) throw new Error(res?.error || t('settings_failed'))
                  w().showToast(t('workspace_excludes_saved'))
                } catch (error: any) {
                  setData(current => current && { ...current, wsExcludes: previous })
                  w().showToast(error?.message || t('settings_failed'))
                } finally {
                  setBusyKey('')
                }
              }}
            >{t('workspace_excludes_save')}</button>
          </div>
        </div>
      </div>
      <div className="settings-section"><RuntimeSettingsTab embedded /></div>
    </SettingsPage>
  )
}

// ==================== 权限规则 ====================

interface PermRule {
  toolName: string
  ruleContent?: string
  source: string
}

interface PermRuleLists {
  allow: PermRule[]
  deny: PermRule[]
  ask: PermRule[]
}

export function PermissionRulesTab() {
  const t = useT()
  const [lists, , beginRead] = useSettingsSnapshot<PermRuleLists | null>('permissions:lists', null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toolRef = useRef<HTMLInputElement>(null)
  const argRef = useRef<HTMLInputElement>(null)
  const behaviorRef = useRef<HTMLSelectElement>(null)

  const refresh = useCallback(async () => {
    const publish = beginRead()
    setError(null)
    try {
      const res = await w().settingsApi.permissions.list()
      if (!res?.ok) throw new Error(res?.error || t('settings_section_load_failed'))
      publish({ allow: res.allow || [], deny: res.deny || [], ask: res.ask || [] })
    } catch (error: any) {
      setError(error?.message || t('settings_section_load_failed'))
    }
  }, [t, beginRead])

  useEffect(() => { void refresh() }, [refresh])

  const addRule = async () => {
    if (busy) return
    const toolName = toolRef.current?.value.trim()
    const ruleContent = argRef.current?.value.trim()
    const behavior = behaviorRef.current?.value
    if (!toolName) { w().showToast(t('perm_rules_tool_required')); return }
    setBusy(true)
    try {
      const res = await w().settingsApi.permissions.add({
        toolName,
        ruleContent: ruleContent || undefined,
        behavior,
        source: 'userSettings',
      })
      if (!res?.ok) throw new Error(res?.error || t('perm_rules_add_failed'))
      if (toolRef.current) toolRef.current.value = ''
      if (argRef.current) argRef.current.value = ''
      w().showToast(t('settings_saved'))
      await refresh()
    } catch (error: any) {
      w().showToast(error?.message || t('perm_rules_add_failed'))
    } finally {
      setBusy(false)
    }
  }

  const deleteRule = async (rule: PermRule, behavior: string) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await w().settingsApi.permissions.delete({
        toolName: rule.toolName,
        ruleContent: rule.ruleContent || undefined,
        behavior,
        source: rule.source,
      })
      if (!res?.ok) throw new Error(res?.error || t('perm_rules_delete_failed'))
      w().showToast(t('settings_saved'))
      await refresh()
    } catch (error: any) {
      w().showToast(error?.message || t('perm_rules_delete_failed'))
    } finally {
      setBusy(false)
    }
  }

  const section = (titleKey: string, arr: PermRule[], behavior: string) => (
    <div className="settings-section" key={behavior}>
      <div className="settings-section-title">{t(titleKey)}</div>
      <div className={styles['pref-card']}>
        {arr.length ? arr.map((r, i) => {
          const label = r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName
          const editable = r.source === 'userSettings'
          return (
            <div className="pref-row" key={`${behavior}:${r.toolName}:${r.ruleContent || ''}:${i}`}>
              <div className={styles['pref-row-text']}>
                <div className={styles['pref-row-label']}><code>{label}</code></div>
                <div className={styles['pref-row-desc']}>{r.source}</div>
              </div>
              {editable
                ? <button type="button" className="btn-sm btn-danger perm-rule-del" disabled={busy} onClick={() => { void deleteRule(r, behavior) }}>{t('perm_rules_delete')}</button>
                : <span className={styles['pref-row-desc']}>{r.source}</span>}
            </div>
          )
        }) : <div className="pref-row"><div className={styles['pref-row-desc']}>{t('perm_rules_empty')}</div></div>}
      </div>
    </div>
  )

  return (
    <SettingsPage title={t('perm_rules_tab')} subtitle={t('perm_rules_desc')}>
      <div className={styles['pref-card']} id="perm-rules-root">
        <div className="pref-row">
          <div className={styles['pref-row-text']}>
            <div className={styles['pref-row-label']} id="perm-rules-add-label">{t('perm_rules_add_title')}</div>
            <div className={styles['pref-row-desc']} id="perm-rules-add-desc">{t('perm_rules_add_desc')}</div>
          </div>
        </div>
        <div className="pref-row" style={{ gap: '8px', flexWrap: 'wrap' }}>
          <input
            type="text" id="perm-rule-tool" className={styles['settings-field-input']} placeholder={t('perm_rules_tool_ph')}
            aria-label={t('perm_rules_tool_ph')} style={{ flex: 1, minWidth: '120px' }} ref={toolRef}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addRule() } }}
          />
          <input
            type="text" id="perm-rule-arg" className={styles['settings-field-input']} placeholder={t('perm_rules_arg_ph')}
            aria-label={t('perm_rules_arg_ph')} style={{ flex: 1, minWidth: '120px' }} ref={argRef}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addRule() } }}
          />
          <select id="perm-rule-behavior" className={styles['settings-field-input']} aria-label={t('perm_rules_behavior')} style={{ minWidth: '96px' }} ref={behaviorRef}>
            <option value="allow">{t('perm_rules_allow')}</option>
            <option value="deny">{t('perm_rules_deny')}</option>
            <option value="ask">{t('perm_rules_ask')}</option>
          </select>
          <button type="button" id="perm-rule-add-btn" className="btn-sm btn-primary" disabled={busy} onClick={() => { void addRule() }}>{t('perm_rules_add_btn')}</button>
        </div>
      </div>
      <div id="perm-rules-lists" className={styles['settings-page-body']}>
        {error != null && <div className="pref-row" role="alert"><div className={styles['pref-row-desc']}>{error}</div><button type="button" className="btn-sm" onClick={() => { void refresh() }}>{t('auth_status_retry')}</button></div>}
        {!lists && error == null ? <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} /> : null}
        {lists && (
          <>
            {section('perm_rules_allow_list', lists.allow, 'allow')}
            {section('perm_rules_deny_list', lists.deny, 'deny')}
            {section('perm_rules_ask_list', lists.ask, 'ask')}
          </>
        )}
      </div>
    </SettingsPage>
  )
}
