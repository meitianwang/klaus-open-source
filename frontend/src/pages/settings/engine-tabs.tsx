// 引擎组两 tab（联网 / 梦）：kv 读 → pref-row 组 → 变更即写盘。
// 控件 id / kv 键与旧版逐一对应；页头（标题/副标题）经 SettingsPage 统一。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { PrefNumberRow, PrefTextRow, PrefToggleRow, SettingsPage, boolChecked, kvGet, kvSet } from './kv'
import styles from './settings.module.css'
import { AUTO_MEMORY_DEFAULT } from './engine-memory-defaults'
import { useSettingsSnapshot } from './settings-snapshot'
import { FeatureModelRow, useFeatureModelSettings } from './feature-models'
import { MEMORY_FEATURE_MODEL_ROW } from './feature-models-state'
import { resolveWebSearchSettings } from '../../../../contracts/web-search-settings'
import { SearchSourceRow } from './search-source-selection'
import { openModelSettings } from './shell'
export { AUTO_MEMORY_DEFAULT } from './engine-memory-defaults'

interface KvValuesState {
  values: Record<string, string | undefined> | null
  error: string
  retry: () => void
  update: (key: string, value: string | undefined) => void
}

function useKvMutations(state: KvValuesState) {
  const pendingRef = useRef(new Set<string>())
  const [pending, setPending] = useState<Set<string>>(new Set())
  const save = useCallback(async (key: string, value: string, rollback?: () => void) => {
    if (pendingRef.current.has(key)) return false
    pendingRef.current.add(key)
    setPending(new Set(pendingRef.current))
    const previous = state.values?.[key]
    state.update(key, value)
    try {
      const saved = await kvSet(key, value)
      if (!saved) { state.update(key, previous); rollback?.() }
      return saved
    } finally {
      pendingRef.current.delete(key)
      setPending(new Set(pendingRef.current))
    }
  }, [state.values, state.update])
  return { pending, save }
}

/** 并行取 kv 键组；读取失败必须显式展示，不能把失败伪装成全部未配置。 */
function useKvValues(keys: string[]): KvValuesState {
  const key = `kv:${JSON.stringify(keys)}`
  const [values, setValues, beginRead] = useSettingsSnapshot<Record<string, string | undefined> | null>(key, null)
  const [error, setError] = useState('')
  const [reloadSequence, setReloadSequence] = useState(0)
  useEffect(() => {
    let cancelled = false
    const publish = beginRead()
    setError('')
    void Promise.all(keys.map(kvGet))
      .then(results => {
        if (cancelled) return
        const map: Record<string, string | undefined> = {}
        keys.forEach((key, i) => { map[key] = results[i] })
        publish(map)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { cancelled = true }
  }, [reloadSequence, beginRead])
  const update = useCallback((key: string, value: string | undefined) => setValues(current => current && { ...current, [key]: value }), [setValues])
  return { values, error, retry: () => setReloadSequence(value => value + 1), update }
}

function KvSettingsLoading({ title, subtitle, error, retry }: {
  title: string
  subtitle: string
  error: string
  retry: () => void
}) {
  const t = useT()
  return (
    <SettingsPage title={title} subtitle={subtitle}>
      {error ? (
        <div className="empty-text sk-empty" role="alert">
          <p>{error || t('settings_section_load_failed')}</p>
          <button type="button" className="btn-sm" onClick={retry}>{t('auth_status_retry')}</button>
        </div>
      ) : <div dangerouslySetInnerHTML={{ __html: (window as any).klsLoading.render() }} />}
    </SettingsPage>
  )
}

// The host stores source and enabled intent and maps them to the engine wire mode.
export function EngineWebTab() {
  const t = useT()
  const kvState = useKvValues([
    'klaus.webSearch.enabled',
    'klaus.webSearch.mode', 'klaus.webSearch.blockedDomains',
    'klaus.webSearch.maxUses',
    'klaus.webFetch.blockedDomains',
  ])
  const mutations = useKvMutations(kvState)
  const [wsEnabled, setWsEnabled] = useState<boolean | null>(null)
  if (!kvState.values) return <KvSettingsLoading title={t('klaus_websearch_title')} subtitle={t('klaus_websearch_desc')} error={kvState.error} retry={kvState.retry} />
  const kv = kvState.values
  const storedSearch = resolveWebSearchSettings({
    enabled: kv['klaus.webSearch.enabled'],
    mode: kv['klaus.webSearch.mode'],
  })
  const enabled = wsEnabled ?? storedSearch.enabled
  return (
    <SettingsPage title={t('klaus_websearch_title')} subtitle={t('klaus_websearch_desc')}>
      {kvState.error && <div role="alert" className="empty-text sk-empty"><p>{kvState.error}</p><button type="button" className="btn-sm" onClick={kvState.retry}>{t('auth_status_retry')}</button></div>}
      <div className="settings-section">
        <div className="settings-section-title">{t('klaus_websearch_section_search')}</div>
        <div className={styles['pref-card']}>
          <PrefToggleRow
            id="klaus-ws-enabled" label={t('klaus_websearch_enabled')} desc={t('klaus_websearch_enabled_desc')}
            checked={enabled} disabled={mutations.pending.has('klaus.webSearch.enabled')}
            onChange={(checked) => {
              const previous = enabled
              setWsEnabled(checked)
              void mutations.save('klaus.webSearch.enabled', checked ? 'on' : 'off', () => setWsEnabled(previous))
            }}
          />
          <SearchSourceRow configureSource={source => openModelSettings(source)} />
          <PrefTextRow
            id="klaus-ws-blocked" label={t('klaus_websearch_blocked')} desc={t('klaus_websearch_blocked_desc')}
            value={kv['klaus.webSearch.blockedDomains']} placeholder="spam.com"
            disabled={mutations.pending.has('klaus.webSearch.blockedDomains')}
            onCommit={(v) => { void mutations.save('klaus.webSearch.blockedDomains', v) }}
          />
          <PrefNumberRow
            id="klaus-ws-maxuses" label={t('klaus_websearch_maxuses')} desc={t('klaus_websearch_maxuses_desc')}
            value={kv['klaus.webSearch.maxUses']} attrs={{ min: 1, step: 1, placeholder: t('klaus_default') }}
            disabled={mutations.pending.has('klaus.webSearch.maxUses')}
            onCommit={(v) => { void mutations.save('klaus.webSearch.maxUses', v) }}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t('klaus_websearch_section_fetch')}</div>
        <div className={styles['pref-card']}>
          <div className="pref-row">
            <div id="klaus-wf-note" className={styles['pref-row-desc']}>{t('klaus_webfetch_builtin_desc')}</div>
          </div>
          <PrefTextRow
            id="klaus-wf-blocked" label={t('klaus_webfetch_blocked')} desc={t('klaus_webfetch_blocked_desc')}
            value={kv['klaus.webFetch.blockedDomains']} placeholder="private.example"
            disabled={mutations.pending.has('klaus.webFetch.blockedDomains')}
            onCommit={(v) => { void mutations.save('klaus.webFetch.blockedDomains', v) }}
          />
        </div>
      </div>
    </SettingsPage>
  )
}

// 引擎工具页已删除。那页曾经用 7 个开关把工具族摆给用户（worktree / workflow /
// swarm / fork / shellEnv / checkpointing / lsp），但其中两个在主界面已经有
// 真正的入口（输入区的本地/Worktree 模式选择器），其余五个是用户无法判断的
// 引擎内部能力。开关本身也不是免费的：每个开启的工具族会把它的工具定义加进
// 每一次请求，全部默认开会白白撑肿工具表。所以默认值由宿主给（engine_config.rs），
// 要改的人走 ~/.klaus/settings.json 的 `engine` 块，那些字段全部可写。

// 梦设置：只暴露用户真正要决定的两件事——要不要自动记、隔多久整理一次。
// 分层指令加载/实时召回/快照同步是引擎内部策略，不摆出来让用户做无谓决定。
// 导航 id 仍为 engineMemory（不动内部标识）。
export function DreamSettingsTab() {
  const t = useT()
  const kvState = useKvValues([
    'feature:autoMemory', 'dream.enabled', 'dream.min_hours', 'dream.min_sessions',
  ])
  const mutations = useKvMutations(kvState)
  const [autoMem, setAutoMem] = useState<boolean | null>(null)
  const [dreamOn, setDreamOn] = useState<boolean | null>(null)
  const memoryModel = useFeatureModelSettings()
  if (!kvState.values) return <KvSettingsLoading title={t('klaus_dream_title')} subtitle={t('klaus_dream_desc')} error={kvState.error} retry={kvState.retry} />
  const kv = kvState.values
  // Product default is deliberately OFF. Memory extraction is opt-in and an
  // absent preference must never be presented as enabled.
  const featAuto = autoMem ?? boolChecked(kv['feature:autoMemory'], AUTO_MEMORY_DEFAULT)
  // 整理没开时两个阈值无从生效，置灰它们，别让用户以为调了有用。
  const enabled = dreamOn ?? boolChecked(kv['dream.enabled'], false)
  return (
    <SettingsPage title={t('klaus_dream_title')} subtitle={t('klaus_dream_desc')}>
      {kvState.error && <div role="alert" className="empty-text sk-empty"><p>{kvState.error}</p><button type="button" className="btn-sm" onClick={kvState.retry}>{t('auth_status_retry')}</button></div>}
      <div className={styles['pref-card']}>
      <PrefToggleRow
        id="klaus-feat-automemory" label={t('klaus_agentmem_auto')} desc={t('klaus_agentmem_auto_desc')}
        checked={featAuto} disabled={mutations.pending.has('feature:autoMemory')}
        onChange={(checked) => {
          const previous = featAuto
          setAutoMem(checked)
          void mutations.save('feature:autoMemory', checked ? 'on' : 'off', () => setAutoMem(previous))
        }}
      />
      <PrefToggleRow
        id="klaus-dream-enabled" label={t('klaus_dream_enabled')} desc={t('klaus_dream_enabled_desc')}
        checked={enabled} disabled={mutations.pending.has('dream.enabled')}
        onChange={(checked) => {
          const previous = enabled
          setDreamOn(checked)
          void mutations.save('dream.enabled', checked ? 'on' : 'off', () => setDreamOn(previous))
        }}
      />
      {/* 记忆与梦境的模型选择在同一页，和整理开关放一起。 */}
      <FeatureModelRow row={MEMORY_FEATURE_MODEL_ROW} model={memoryModel} />
      {memoryModel.loadError || memoryModel.saveError ? <p className={styles['prediction-notice']} role="alert">{memoryModel.loadError || memoryModel.saveError}</p> : null}
      {/* 两个阈值留空 = 未设，引擎用自己的默认（24 小时 / 5 个会话）。 */}
      <PrefNumberRow
        id="klaus-dream-hours" label={t('klaus_dream_hours')} desc={t('klaus_dream_hours_desc')}
        value={kv['dream.min_hours']} attrs={{ min: 0, step: 'any', placeholder: '24' }} disabled={!enabled || mutations.pending.has('dream.min_hours')}
        onCommit={(v) => { void mutations.save('dream.min_hours', v) }}
      />
      <PrefNumberRow
        id="klaus-dream-sessions" label={t('klaus_dream_sessions')} desc={t('klaus_dream_sessions_desc')}
        value={kv['dream.min_sessions']} attrs={{ min: 0, step: 1, placeholder: '5' }} disabled={!enabled || mutations.pending.has('dream.min_sessions')}
        onCommit={(v) => { void mutations.save('dream.min_sessions', v) }}
      />
      </div>
    </SettingsPage>
  )
}
