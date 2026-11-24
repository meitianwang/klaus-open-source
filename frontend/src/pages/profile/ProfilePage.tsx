import { type CSSProperties, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { intlLocale, useT } from '../../i18n'
import { sourceLabel } from '../settings/model-shared'
import {
  ACTIVITY_WEEKS,
  activityCalendar,
  compactTokens,
  dailyColorScale,
  profileInitials,
  tokenLevel,
  weeklyBarLevel,
  type ActivityPeriod,
  type ProfileActivity,
} from './activity'
import {
  aggregateModelUsage,
  type AggregatedUsageRow,
  type ModelBrand,
  type UsageGroupBy,
  type UsageWindow,
} from './model-usage'
import { loadIdentity, type ProfileIdentity } from './identity'
import { loadProfileActivity } from './activity-read'
import { ProfileEditor } from './ProfileEditor'
import { clearSettingsSnapshots, useSettingsSnapshot } from '../settings/settings-snapshot'
import styles from './profile.module.css'

export const PROFILE_VISIBLE_EVENT = 'klaus:profile-visible'
const ACCOUNT_REFRESH_EVENT = 'klaus:settings-account-refresh'
let accountOwner: string | null = null
let accountRevision = 0
let accountSubscription: (() => void) | null = null

function refreshAccount(owner: string | null): void {
  const boundary = owner === null || accountOwner !== owner
  accountOwner = owner
  if (boundary) {
    accountRevision++
    clearSettingsSnapshots('account:')
  }
  window.dispatchEvent(new CustomEvent(ACCOUNT_REFRESH_EVENT, { detail: { boundary } }))
}

/** Keep account invalidation alive after the page that installed it unmounts. */
export function ensureSettingsAccountListener(): void {
  if (accountSubscription || !window.klaus?.on?.klausAuthUpdated) return
  accountSubscription = window.klaus.on.klausAuthUpdated((payload: { user?: { id?: string } | null }) => {
    const user = payload?.user
    refreshAccount(user === null ? 'guest' : typeof user?.id === 'string' && user.id ? user.id : null)
  })
}

ensureSettingsAccountListener()

function formatPercent(ratio: number): string {
  if (ratio <= 0) return '0%'
  const pct = ratio * 100
  if (pct < 0.1) return '<0.1%'
  if (pct < 10) return `${pct.toFixed(1)}%`
  return `${Math.round(pct)}%`
}

function ModelBrandBadge({ brand, logo, color }: { brand: ModelBrand; logo?: string; color: string }) {
  const [broken, setBroken] = useState(false)
  if (logo && !broken) {
    return (
      <span className={styles.brandBadge} aria-hidden="true">
        <img src={logo} alt="" onError={() => setBroken(true)} />
      </span>
    )
  }
  if (brand === 'gemini') {
    return (
      <span className={styles.brandBadge} aria-hidden="true" style={{ color }}>
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C12.3 7.3 16.7 11.7 22 12C16.7 12.3 12.3 16.7 12 22C11.7 16.7 7.3 12.3 2 12C7.3 11.7 11.7 7.3 12 2Z" />
        </svg>
      </span>
    )
  }
  if (brand === 'xai') {
    return (
      <span className={styles.brandBadge} aria-hidden="true" style={{ color }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M5 19L19 5M7 5h4l6 14h-4L7 5z" />
        </svg>
      </span>
    )
  }
  if (brand === 'custom') {
    return (
      <span className={styles.brandBadge} aria-hidden="true">
        <Icon name="auth-mode-2" size={18} />
      </span>
    )
  }
  return (
    <span className={styles.brandBadge} aria-hidden="true" style={{ color }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
        <path d="M12 3L20 7.5L12 12L4 7.5L12 3Z" />
        <path d="M4 12.5L12 17L20 12.5" />
        <path d="M4 16.5L12 21L20 16.5" />
      </svg>
    </span>
  )
}

function weekdayMarkers(locale: string): [string, string, string] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' })
  // 2026-01-05 is Monday, 07 is Wednesday, 09 is Friday in UTC
  return [
    fmt.format(new Date('2026-01-05T00:00:00Z')),
    fmt.format(new Date('2026-01-07T00:00:00Z')),
    fmt.format(new Date('2026-01-09T00:00:00Z')),
  ]
}

function UsageObservatory({
  data,
  modelsHeadingId,
  activityHeadingId,
}: {
  data: ProfileActivity
  modelsHeadingId: string
  activityHeadingId: string
}) {
  const t = useT()
  const locale = intlLocale()
  const [windowRange, setWindowRange] = useState<UsageWindow>('all')
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('model')
  const [period, setPeriod] = useState<ActivityPeriod>('daily')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [focusedCell, setFocusedCell] = useState(ACTIVITY_WEEKS * 7 - 1)
  const [hoveredCell, setHoveredCell] = useState<number | null>(null)
  const calendarRef = useRef<HTMLDivElement>(null)

  const now = useMemo(() => new Date(), [data])
  const usage = useMemo(
    () =>
      aggregateModelUsage(data, now, {
        window: windowRange,
        groupBy,
        sourceLabel: src => (src === 'other' ? t('profile_model_other') : sourceLabel(src, t)),
        customModelLabel: t('profile_model_custom'),
        unattributedLabel: t('profile_model_unattributed'),
      }),
    [data, now, windowRange, groupBy, t],
  )

  const allTimeUsage = useMemo(
    () =>
      windowRange === 'all'
        ? usage
        : aggregateModelUsage(data, now, {
          window: 'all',
          groupBy,
          sourceLabel: src => (src === 'other' ? t('profile_model_other') : sourceLabel(src, t)),
          customModelLabel: t('profile_model_custom'),
          unattributedLabel: t('profile_model_unattributed'),
        }),
    [data, now, windowRange, usage, groupBy, t],
  )

  const activeSelection = selectedKey && allTimeUsage.rows.some(row => row.key === selectedKey) ? selectedKey : null
  const selectedRow: AggregatedUsageRow | undefined = activeSelection
    ? allTimeUsage.rows.find(row => row.key === activeSelection)
    : undefined

  const heatmapDays = useMemo(() => {
    if (!selectedRow) return data.days
    return [...selectedRow.days.entries()].map(([date, tokens]) => ({ date, tokens }))
  }, [data.days, selectedRow])

  const calendar = useMemo(() => activityCalendar(heatmapDays, now, period), [heatmapDays, now, period])
  const flatCells = useMemo(() => calendar.flat(), [calendar])
  const values = useMemo(() => flatCells.map(cell => cell.tokens), [flatCells])
  const peak = useMemo(
    () => (period === 'daily' ? dailyColorScale(values) : Math.max(0, ...values)),
    [period, values],
  )

  const latestDayIndex = useMemo(() => {
    const idx = flatCells.findLastIndex(cell => !cell.future)
    return idx >= 0 ? idx : Math.max(0, flatCells.length - 1)
  }, [flatCells])

  const defaultInspectIndex = useMemo(() => {
    if (period === 'daily') {
      for (let i = latestDayIndex; i >= 0; i--) {
        if (flatCells[i].tokens > 0) return i
      }
      return latestDayIndex
    }
    for (let col = calendar.length - 1; col >= 0; col--) {
      if (calendar[col][0].tokens > 0) return col
    }
    return Math.max(0, calendar.length - 1)
  }, [period, latestDayIndex, flatCells, calendar])

  const cellLimit = period === 'daily' ? latestDayIndex : calendar.length - 1
  const focusIndex = Math.max(0, Math.min(focusedCell, cellLimit))
  const inspectedIndex = hoveredCell !== null && hoveredCell <= cellLimit ? hoveredCell : focusIndex

  const inspectedRecord = useMemo(() => {
    if (period === 'daily') {
      const cell = flatCells[inspectedIndex] ?? flatCells[defaultInspectIndex]
      return cell ? { date: cell.date, tokens: cell.tokens } : null
    }
    const week = calendar[inspectedIndex] ?? calendar[defaultInspectIndex]
    return week?.[0] ? { date: week[0].date, tokens: week[0].tokens } : null
  }, [period, flatCells, calendar, inspectedIndex, defaultInspectIndex])

  const activeDayCount = useMemo(
    () => flatCells.filter(cell => !cell.future && cell.tokens > 0).length,
    [flatCells],
  )

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }),
    [locale],
  )
  const [monLabel, wedLabel, friLabel] = useMemo(() => weekdayMarkers(locale), [locale])

  const cellAnnouncement = (tokens: number, date: string) =>
    t(
      period === 'daily'
        ? 'profile_activity_day'
        : period === 'weekly'
          ? 'profile_activity_week'
          : 'profile_activity_running',
    )
      .replace('{tokens}', compactTokens(tokens, locale))
      .replace('{date}', dateFormat.format(new Date(date + 'T00:00:00Z')))

  const peakRowTokens = usage.rows[0]?.tokens ?? 0
  const visibleRows = expanded ? usage.rows : usage.rows.slice(0, 5)

  const spectrumSlices = useMemo(() => {
    const top = usage.rows.slice(0, 7)
    const restTokens = usage.rows.slice(7).reduce((sum, item) => sum + item.tokens, 0)
    const slices = top.map(row => ({
      key: row.key,
      label: row.label,
      color: row.color,
      tokens: row.tokens,
      interactive: true,
    }))
    if (restTokens > 0) {
      slices.push({
        key: '__other_slice__',
        label: t('profile_model_other'),
        color: '#94a3b8',
        tokens: restTokens,
        interactive: false,
      })
    }
    return slices
  }, [usage.rows, t])

  const heatStyle = useMemo(
    () => ({ '--heat-base': selectedRow ? selectedRow.color : '#d4633b' }) as CSSProperties,
    [selectedRow],
  )

  return (
    <>
      <section className={styles.panel} aria-labelledby={modelsHeadingId}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitleGroup}>
            <h2 id={modelsHeadingId}>{t('profile_models_title')}</h2>
            {usage.rows.length > 0 && (
              <span className={styles.countChip}>
                {t(groupBy === 'model' ? 'profile_models_count' : 'profile_sources_count').replace(
                  '{count}',
                  new Intl.NumberFormat(locale).format(usage.rows.length),
                )}
              </span>
            )}
          </div>
          <div className={styles.controlsRow}>
            <div className={styles.segmented} role="group" aria-label={t('profile_models_title')}>
              {(['model', 'source'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={groupBy === mode}
                  onClick={() => {
                    setGroupBy(mode)
                    setSelectedKey(null)
                    setExpanded(false)
                  }}
                >
                  {t(mode === 'model' ? 'profile_group_by_model' : 'profile_group_by_source')}
                </button>
              ))}
            </div>
            <div className={styles.segmented} role="group" aria-label={t('profile_window_all')}>
              {(['7d', '30d', '90d', 'all'] as const).map(range => (
                <button
                  key={range}
                  type="button"
                  aria-pressed={windowRange === range}
                  onClick={() => setWindowRange(range)}
                >
                  {t(`profile_window_${range}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {usage.rows.length > 0 ? (
          <>
            <div className={styles.spectrumTrack}>
              {spectrumSlices.map(slice => (
                <button
                  key={slice.key}
                  type="button"
                  className={styles.spectrumSlice}
                  style={{
                    flexGrow: Math.max(slice.tokens, usage.totalTokens * 0.012),
                    backgroundColor: slice.color,
                  }}
                  data-dimmed={activeSelection !== null && activeSelection !== slice.key ? 'true' : undefined}
                  aria-label={`${slice.label}: ${compactTokens(slice.tokens, locale)}`}
                  disabled={!slice.interactive}
                  onClick={() => {
                    if (slice.interactive) setSelectedKey(current => (current === slice.key ? null : slice.key))
                  }}
                />
              ))}
            </div>

            <div className={styles.modelList}>
              {visibleRows.map(row => {
                const isSelected = activeSelection === row.key
                const isDimmed = activeSelection !== null && !isSelected
                const barWidth = peakRowTokens > 0 ? Math.max(2, (row.tokens / peakRowTokens) * 100) : 0
                const hasIoBreakdown =
                  windowRange === 'all' && row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0

                return (
                  <button
                    key={row.key}
                    type="button"
                    data-model-row={row.key}
                    aria-pressed={isSelected}
                    data-dimmed={isDimmed ? 'true' : undefined}
                    className={styles.modelRow}
                    onClick={() => setSelectedKey(current => (current === row.key ? null : row.key))}
                  >
                    <ModelBrandBadge brand={row.brand} logo={row.logo} color={row.color} />
                    <div className={styles.modelBody}>
                      <div className={styles.modelTopLine}>
                        <div className={styles.modelIdentity}>
                          <span className={styles.modelName}>{row.label}</span>
                          {groupBy === 'model'
                            ? row.sources.slice(0, 2).map(src => (
                              <span key={src} className={styles.sourceTag}>
                                {sourceLabel(src, t)}
                              </span>
                            ))
                            : row.modelCount > 0 && (
                              <span className={styles.sourceTag}>
                                {t('profile_source_models_count').replace(
                                  '{count}',
                                  new Intl.NumberFormat(locale).format(row.modelCount),
                                )}
                              </span>
                            )}
                          {groupBy === 'model' && row.sources.length > 2 && (
                            <span className={styles.sourceTag}>{`+${row.sources.length - 2}`}</span>
                          )}
                        </div>
                        <div className={styles.modelNumbers}>
                          <span className={styles.modelTokens}>{compactTokens(row.tokens, locale)}</span>
                          <span className={styles.modelShare}>{formatPercent(row.share)}</span>
                        </div>
                      </div>
                      <div className={styles.modelBarTrack} aria-hidden="true">
                        <div
                          className={styles.modelBarFill}
                          style={{ width: `${barWidth}%`, backgroundColor: row.color }}
                        />
                      </div>
                      <div className={styles.modelMeta}>
                        {hasIoBreakdown
                          ? t('profile_meta_io')
                            .replace('{input}', compactTokens(row.inputTokens + row.cacheWriteTokens, locale))
                            .replace('{cache}', compactTokens(row.cacheReadTokens, locale))
                            .replace('{output}', compactTokens(row.outputTokens, locale))
                            .replace('{requests}', new Intl.NumberFormat(locale).format(row.requests))
                          : t('profile_meta_window')
                            .replace('{days}', new Intl.NumberFormat(locale).format(row.activeDays))
                            .replace('{peak}', compactTokens(row.peakDayTokens, locale))}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>

            {usage.rows.length > 5 && (
              <button
                type="button"
                className={styles.expandButton}
                onClick={() => setExpanded(value => !value)}
              >
                {expanded
                  ? t('profile_models_collapse')
                  : t('profile_models_expand').replace('{count}', new Intl.NumberFormat(locale).format(usage.rows.length))}
              </button>
            )}
          </>
        ) : (
          <p className={styles.empty}>
            {data.totalTokens === 0 ? t('profile_activity_empty') : t('profile_models_window_empty')}
          </p>
        )}
      </section>

      <section className={`${styles.panel} ${styles.heatmapSurface}`} aria-labelledby={activityHeadingId} style={heatStyle}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitleGroup}>
            <h2 id={activityHeadingId}>{t('profile_activity')}</h2>
            {period === 'daily' && activeDayCount > 0 && (
              <span className={styles.countChip}>
                {t('profile_active_days_badge').replace('{count}', new Intl.NumberFormat(locale).format(activeDayCount))}
              </span>
            )}
            {selectedRow && (
              <button
                type="button"
                className={styles.focusChip}
                onClick={() => setSelectedKey(null)}
                aria-label={`${selectedRow.label} — ${t('profile_focus_clear')}`}
              >
                <span className={styles.ioDot} style={{ backgroundColor: selectedRow.color }} aria-hidden="true" />
                <span>{selectedRow.label}</span>
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
          <div className={styles.segmented} role="group" aria-label={t('profile_activity')}>
            {(['daily', 'weekly', 'cumulative'] as const).map(value => (
              <button
                key={value}
                type="button"
                aria-pressed={period === value}
                onClick={() => {
                  setPeriod(value)
                  setFocusedCell(value === 'daily' ? latestDayIndex : calendar.length - 1)
                  setHoveredCell(null)
                }}
              >
                {t(`profile_${value}`)}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.heatmapBanner}>
          {inspectedRecord ? (
            <div className={styles.inspectorPrimary}>
              <span className={styles.inspectorDate}>
                {dateFormat.format(new Date(inspectedRecord.date + 'T00:00:00Z'))}
              </span>
              <span className={styles.inspectorTotal}>
                {`${compactTokens(inspectedRecord.tokens, locale)} Token`}
              </span>
            </div>
          ) : <span />}
          <div className={styles.intensityScale} aria-hidden="true">
            <span>{t('profile_less')}</span>
            {[0, 1, 2, 3, 4].map(level => (
              <span key={level} className={styles.scaleSwatch} data-level={level} />
            ))}
            <span>{t('profile_more')}</span>
          </div>
        </div>

        <div className={styles.heatmapWell}>
          <div className={styles.heatmapScroll}>
            <div className={styles.heatmapMatrix} data-mode={period}>
              <div className={styles.heatmapMonthsRow}>
                {period === 'daily' && <span className={styles.weekdaySpacer} aria-hidden="true" />}
                <div className={styles.heatmapMonths} aria-hidden="true">
                  {calendar.map((week, index) => {
                    const date = new Date(week[0].date + 'T00:00:00Z')
                    return (
                      <span key={index}>
                        {date.getUTCDate() <= 7
                          ? new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date)
                          : ''}
                      </span>
                    )
                  })}
                </div>
              </div>

              <div className={styles.heatmapBodyRow}>
                {period === 'daily' && (
                  <div className={styles.weekdayRail} aria-hidden="true">
                    <span />
                    <span>{monLabel}</span>
                    <span />
                    <span>{wedLabel}</span>
                    <span />
                    <span>{friLabel}</span>
                    <span />
                  </div>
                )}
                <div
                  className={styles.heatmapGrid}
                  ref={calendarRef}
                  role="group"
                  aria-label={t('profile_activity')}
                  onMouseLeave={() => setHoveredCell(null)}
                  onKeyDown={event => {
                    const stride = period === 'daily' ? 7 : 1
                    const delta =
                      event.key === 'ArrowRight'
                        ? stride
                        : event.key === 'ArrowLeft'
                          ? -stride
                          : event.key === 'ArrowDown'
                            ? 1
                            : event.key === 'ArrowUp'
                              ? -1
                              : 0
                    if (!delta && event.key !== 'Home' && event.key !== 'End') return
                    event.preventDefault()
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? cellLimit
                          : Math.max(0, Math.min(cellLimit, focusIndex + delta))
                    setFocusedCell(next)
                    calendarRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${next}"]`)?.focus()
                  }}
                >
                  {calendar.map((week, column) =>
                    period === 'daily' ? (
                      <div className={styles.heatWeek} key={week[0].date}>
                        {week.map((cell, day) => {
                          const cellIdx = column * 7 + day
                          const label = cellAnnouncement(cell.tokens, cell.date)
                          return (
                            <button
                              type="button"
                              key={cell.date}
                              data-cell={cellIdx}
                              data-level={tokenLevel(cell.tokens, peak)}
                              data-active={inspectedIndex === cellIdx ? 'true' : undefined}
                              className={styles.heatCell}
                              disabled={cell.future}
                              tabIndex={focusIndex === cellIdx ? 0 : -1}
                              aria-label={label}
                              onFocus={() => setFocusedCell(cellIdx)}
                              onMouseEnter={() => {
                                if (!cell.future) setHoveredCell(cellIdx)
                              }}
                            />
                          )
                        })}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={styles.heatWeekColumn}
                        key={week[0].date}
                        data-cell={column}
                        data-active={inspectedIndex === column ? 'true' : undefined}
                        tabIndex={focusIndex === column ? 0 : -1}
                        aria-label={cellAnnouncement(week[0].tokens, week[0].date)}
                        onFocus={() => setFocusedCell(column)}
                        onMouseEnter={() => setHoveredCell(column)}
                      >
                        {week.map((cell, row) => {
                          const filled = weeklyBarLevel(cell.tokens, peak, row) > 0
                          return (
                            <span
                              className={styles.heatCell}
                              data-level={filled ? tokenLevel(cell.tokens, peak) : 0}
                              key={cell.date}
                            />
                          )
                        })}
                      </button>
                    ),
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {data.totalTokens === 0 && <p className={styles.empty}>{t('profile_activity_empty')}</p>}
      </section>
    </>
  )
}

export function ProfilePage({ embedded = false }: { embedded?: boolean }) {
  const modelsHeadingId = useId()
  const activityHeadingId = useId()
  const t = useT()
  const [identity, setIdentity, beginIdentityRead] = useSettingsSnapshot<ProfileIdentity | null>('account:profile:identity', null)
  const [activity, , beginActivityRead] = useSettingsSnapshot<ProfileActivity | null>('account:profile:activity', null)
  const [identityError, setIdentityError] = useState('')
  const [activityError, setActivityError] = useState('')
  const [editing, setEditing] = useState(false)
  const [sequence, setSequence] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    ensureSettingsAccountListener()
    const show = (shown: boolean) => {
      setVisible(shown)
      if (shown) setSequence(value => value + 1)
      else setEditing(false)
    }
    const visibility = (event: Event) => {
      show((event as CustomEvent<{ visible: boolean }>).detail.visible)
    }
    const settings = (event: Event) =>
      show(!(event as CustomEvent<{ open: boolean }>).detail.open && !!document.getElementById('profile-view')?.classList.contains('active'))
    // Settings owns the embedded page's lifetime; standalone view events must
    // not hide it or dismiss its editor.
    if (!embedded) {
      window.addEventListener(PROFILE_VISIBLE_EVENT, visibility)
      window.addEventListener('klaus:settings-visibility-change', settings)
    }
    const accountChanged = (event: Event) => {
      if ((event as CustomEvent<{ boundary: boolean }>).detail.boundary) {
        setEditing(false)
      }
      setSequence(value => value + 1)
    }
    window.addEventListener(ACCOUNT_REFRESH_EVENT, accountChanged)
    return () => {
      window.removeEventListener(PROFILE_VISIBLE_EVENT, visibility)
      window.removeEventListener('klaus:settings-visibility-change', settings)
      window.removeEventListener(ACCOUNT_REFRESH_EVENT, accountChanged)
    }
  }, [embedded])

  useEffect(() => {
    if (!visible) return
    let stale = false
    const revision = accountRevision
    const publishIdentity = beginIdentityRead()
    const publishActivity = beginActivityRead()
    const current = () => !stale && revision === accountRevision
    setIdentityError('')
    setActivityError('')
    void loadIdentity()
      .then(data => {
        if (!current()) return null
        if (accountOwner !== null && accountOwner !== data.ownerId) {
          refreshAccount(data.ownerId)
          return null
        }
        accountOwner = data.ownerId
        publishIdentity(data)
        return data
      })
      .catch(error => {
        if (current()) setIdentityError(error instanceof Error ? error.message : t('profile_load_failed'))
        return null
      })
    void loadProfileActivity()
      .then(data => {
        if (current()) publishActivity(data)
      })
      .catch(() => {
        if (current()) setActivityError(t('profile_activity_error'))
      })
    return () => {
      stale = true
    }
  }, [sequence, visible, t, beginIdentityRead, beginActivityRead])

  const locale = intlLocale()
  const formatDays = (value: number) =>
    t(value === 1 ? 'profile_day' : 'profile_days').replace('{count}', new Intl.NumberFormat(locale).format(value))
  const formatDuration = (value: number) => {
    const minutes = Math.floor(value / 60_000)
    const hours = Math.floor(minutes / 60)
    return t(hours ? 'profile_hours_minutes' : 'profile_minutes')
      .replace('{hours}', String(hours))
      .replace('{minutes}', String(hours ? minutes % 60 : minutes))
  }

  const composition = useMemo(() => {
    if (!activity) return null
    return aggregateModelUsage(activity, new Date(), { window: 'all', groupBy: 'model' }).composition
  }, [activity])

  const secondaryMetrics: Array<[string, string | null]> = [
    ['profile_tokens_peak', activity && compactTokens(activity.peakDailyTokens, locale)],
    ['profile_longest_task', activity && formatDuration(activity.longestTaskMs)],
    ['profile_longest_streak', activity && formatDays(activity.longestStreakDays)],
    ['profile_current_streak', activity && formatDays(activity.currentStreakDays)],
  ]

  const hasComposition =
    !!composition && composition.cacheReadTokens + composition.inputTokens + composition.outputTokens > 0

  return (
    <div className={styles.page} aria-label={t('profile')}>
      <div className={styles.heroBar}>
        <header className={styles.identity}>
          {identityError && (
            <div className={styles.error} role="alert">
              {identityError}
              <button type="button" className="btn-sm" onClick={() => setSequence(value => value + 1)}>
                {t('auth_status_retry')}
              </button>
            </div>
          )}
          {(!identityError || identity) && (
            <>
              <div className={styles.avatar} aria-hidden="true">
                {identity?.avatar ? (
                  <img
                    key={identity.avatar}
                    src={identity.avatar}
                    alt=""
                    onError={event => {
                      event.currentTarget.style.display = 'none'
                    }}
                  />
                ) : null}
                <span>{profileInitials(identity?.displayName || '')}</span>
              </div>
              <div className={styles.identityBody}>
                <div className={styles.identityTitleRow}>
                  <h1>{identity?.displayName || t('loading')}</h1>
                  {activity && activity.currentStreakDays > 0 ? (
                    <span className={styles.streakPill}>
                      <span className={styles.streakDot} aria-hidden="true" />
                      {t('profile_streak_active').replace(
                        '{count}',
                        new Intl.NumberFormat(locale).format(activity.currentStreakDays),
                      )}
                    </span>
                  ) : null}
                </div>
                {identity?.handle ? <p className={styles.handle}>{'@' + identity.handle}</p> : null}
              </div>
            </>
          )}
        </header>
        <button
          type="button"
          className={styles.editButton}
          disabled={!identity}
          onClick={() => setEditing(true)}
        >
          <Icon name="session-menu-rename" size={16} />
          {t('profile_edit')}
        </button>
      </div>

      <div className={styles.content}>
        <dl className={styles.metrics} aria-busy={!activity && !activityError}>
          <div className={styles.metricHero}>
            <div className={styles.metricHeroTop}>
              <dt>{t('profile_tokens_total')}</dt>
              {composition && composition.totalRequests > 0 ? (
                <span className={styles.requestsBadge}>
                  {t('profile_requests_count').replace(
                    '{count}',
                    new Intl.NumberFormat(locale).format(composition.totalRequests),
                  )}
                </span>
              ) : null}
            </div>
            <dd>{activity ? compactTokens(activity.totalTokens, locale) : '—'}</dd>
            {hasComposition && composition ? (
              <div className={styles.ioStack}>
                <div className={styles.ioTrack} aria-hidden="true">
                  {composition.cacheShare > 0 && (
                    <span
                      className={styles.ioSegment}
                      style={{ flexGrow: composition.cacheShare, backgroundColor: '#10a37f' }}
                    />
                  )}
                  {composition.inputShare > 0 && (
                    <span
                      className={styles.ioSegment}
                      style={{ flexGrow: composition.inputShare, backgroundColor: '#3b82f6' }}
                    />
                  )}
                  {composition.outputShare > 0 && (
                    <span
                      className={styles.ioSegment}
                      style={{ flexGrow: composition.outputShare, backgroundColor: '#d97757' }}
                    />
                  )}
                </div>
                <div className={styles.ioLegend}>
                  <span>
                    <span className={styles.ioDot} style={{ backgroundColor: '#10a37f' }} aria-hidden="true" />
                    {t('profile_io_cache').replace('{percent}', formatPercent(composition.cacheShare))}
                  </span>
                  <span>
                    <span className={styles.ioDot} style={{ backgroundColor: '#3b82f6' }} aria-hidden="true" />
                    {t('profile_io_input').replace('{percent}', formatPercent(composition.inputShare))}
                  </span>
                  <span>
                    <span className={styles.ioDot} style={{ backgroundColor: '#d97757' }} aria-hidden="true" />
                    {t('profile_io_output').replace('{percent}', formatPercent(composition.outputShare))}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
          {secondaryMetrics.map(([key, value]) => (
            <div className={styles.metricCard} key={key}>
              <dt>{t(key)}</dt>
              <dd>{value ?? '—'}</dd>
            </div>
          ))}
        </dl>

        {activity && activityError && (
          <p className={styles.error} role="alert">
            {activityError}
            <button type="button" className="btn-sm" onClick={() => setSequence(value => value + 1)}>
              {t('auth_status_retry')}
            </button>
          </p>
        )}

        {activity ? (
          <UsageObservatory data={activity} modelsHeadingId={modelsHeadingId} activityHeadingId={activityHeadingId} />
        ) : (
          <section className={styles.panel} aria-labelledby={activityHeadingId}>
            <h2 id={activityHeadingId}>{t('profile_activity')}</h2>
            <p role={activityError ? 'alert' : 'status'} className={styles.empty}>
              {activityError || t('profile_activity_loading')}
            </p>
            {activityError && (
              <div>
                <button type="button" className="btn-sm" onClick={() => setSequence(value => value + 1)}>
                  {t('auth_status_retry')}
                </button>
              </div>
            )}
          </section>
        )}
      </div>

      {editing && identity && (
        <ProfileEditor
          identity={identity}
          onClose={() => setEditing(false)}
          onSaved={next => {
            setIdentity(next)
            setEditing(false)
          }}
        />
      )}
    </div>
  )
}
