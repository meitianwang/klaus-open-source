import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { intlLocale, useT } from '../../i18n'
import { ACTIVITY_WEEKS, activityCalendar, compactTokens, dailyColorScale, profileInitials, tokenLevel, weeklyBarLevel, type ActivityPeriod, type ProfileActivity } from './activity'
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

function TokenActivity({ data, headingId }: { data: ProfileActivity; headingId: string }) {
  const t = useT(), [period, setPeriod] = useState<ActivityPeriod>('daily'), [focused, setFocused] = useState(ACTIVITY_WEEKS * 7 - 1)
  const calendar = activityCalendar(data.days, new Date(), period), locale = intlLocale()
  const values = calendar.flat().map(cell => cell.tokens)
  const peak = period === 'daily' ? dailyColorScale(values) : Math.max(0, ...values)
  const dateFormat = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
  const text = (tokens: number, date: string) => t(period === 'daily' ? 'profile_activity_day' : period === 'weekly' ? 'profile_activity_week' : 'profile_activity_running')
    .replace('{tokens}', compactTokens(tokens, locale)).replace('{date}', dateFormat.format(new Date(date + 'T00:00:00Z')))
  const calendarRef = useRef<HTMLDivElement>(null)
  const latest = calendar.flat().findLastIndex(cell => !cell.future)
  const focusIndex = Math.min(focused, period === 'daily' ? latest : calendar.length - 1)
  return <section className={styles.activity} aria-labelledby={headingId}>
    <div className={styles.activityHeader}><h2 id={headingId}>{t('profile_activity')}</h2>
      <div className={styles.periods} role="group" aria-label={t('profile_activity')}>
        {(['daily', 'weekly', 'cumulative'] as const).map(value => <button key={value} type="button" aria-pressed={period === value} onClick={() => { setPeriod(value); setFocused(value === 'daily' ? latest : calendar.length - 1) }}>{t('profile_' + value)}</button>)}
      </div>
    </div>
    <div className={styles.calendarScroll}>
      <div className={styles.calendar} ref={calendarRef} role="group" aria-label={t('profile_activity')} onKeyDown={event => {
        const stride = period === 'daily' ? 7 : 1
        const delta = event.key === 'ArrowRight' ? stride : event.key === 'ArrowLeft' ? -stride : event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
        if (!delta && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        const limit = period === 'daily' ? latest : calendar.length - 1
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? limit : Math.max(0, Math.min(limit, focusIndex + delta))
        setFocused(next)
        calendarRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${next}"]`)?.focus()
      }}>
        {calendar.map((week, column) => period === 'daily' ? <div className={styles.week} key={week[0].date}>
          {week.map((cell, day) => <button type="button" key={cell.date} data-cell={column * 7 + day} data-level={tokenLevel(cell.tokens, peak)}
            className={styles.cell} disabled={cell.future} tabIndex={focusIndex === column * 7 + day ? 0 : -1}
            aria-label={text(cell.tokens, cell.date)} title={text(cell.tokens, cell.date)} onFocus={() => setFocused(column * 7 + day)} />)}
        </div> : <button type="button" className={styles.weekButton} key={week[0].date} data-cell={column} tabIndex={focusIndex === column ? 0 : -1}
          aria-label={text(week[0].tokens, week[0].date)} title={text(week[0].tokens, week[0].date)} onFocus={() => setFocused(column)}>
          {week.map((cell, row) => <span className={styles.cell} data-level={weeklyBarLevel(cell.tokens, peak, row)} key={cell.date} />)}
        </button>)}
      </div>
      <div className={styles.months} aria-hidden="true">{calendar.map((week, index) => {
        const date = new Date(week[0].date + 'T00:00:00Z')
        return <span key={index}>{date.getUTCDate() <= 7 ? new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date) : ''}</span>
      })}</div>
    </div>
    <div className={styles.legend}><span>{t('profile_less')}</span>{[0, 1, 2, 3, 4].map(level => <span className={styles.cell} data-level={level} key={level} aria-hidden="true" />)}<span>{t('profile_more')}</span></div>
    {data.totalTokens === 0 && <p className={styles.empty}>{t('profile_activity_empty')}</p>}
  </section>
}

export function ProfilePage({ embedded = false }: { embedded?: boolean }) {
  const activityHeadingId = useId()
  const t = useT()
  const [identity, setIdentity, beginIdentityRead] = useSettingsSnapshot<ProfileIdentity | null>('account:profile:identity', null)
  const [activity, , beginActivityRead] = useSettingsSnapshot<ProfileActivity | null>('account:profile:activity', null)
  const [identityError, setIdentityError] = useState(''), [activityError, setActivityError] = useState('')
  const [editing, setEditing] = useState(false), [notice, setNotice] = useState(''), [sequence, setSequence] = useState(0)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    ensureSettingsAccountListener()
    const show = (shown: boolean) => {
      setVisible(shown); if (shown) setSequence(value => value + 1); else setEditing(false)
    }
    const visibility = (event: Event) => {
      show((event as CustomEvent<{ visible: boolean }>).detail.visible)
    }
    const settings = (event: Event) => show(!(event as CustomEvent<{ open: boolean }>).detail.open && !!document.getElementById('profile-view')?.classList.contains('active'))
    // Settings owns the embedded page's lifetime; standalone view events must
    // not hide it or dismiss its editor.
    if (!embedded) {
      window.addEventListener(PROFILE_VISIBLE_EVENT, visibility)
      window.addEventListener('klaus:settings-visibility-change', settings)
    }
    const accountChanged = (event: Event) => {
      if ((event as CustomEvent<{ boundary: boolean }>).detail.boundary) { setEditing(false); setNotice('') }
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
    const publishIdentity = beginIdentityRead(), publishActivity = beginActivityRead()
    const current = () => !stale && revision === accountRevision
    setIdentityError(''); setActivityError('')
    void loadIdentity().then(data => {
      if (!current()) return null
      if (accountOwner !== null && accountOwner !== data.ownerId) {
        refreshAccount(data.ownerId)
        return null
      }
      accountOwner = data.ownerId
      publishIdentity(data)
      return data
    }).catch(error => { if (current()) setIdentityError(error instanceof Error ? error.message : t('profile_load_failed')); return null })
    void loadProfileActivity().then(data => {
      if (current()) publishActivity(data)
    }).catch(() => { if (current()) setActivityError(t('profile_activity_error')) })
    return () => { stale = true }
  }, [sequence, visible, t, beginIdentityRead, beginActivityRead])
  const locale = intlLocale()
  const days = (value: number) => t(value === 1 ? 'profile_day' : 'profile_days').replace('{count}', new Intl.NumberFormat(locale).format(value))
  const duration = (value: number) => {
    const minutes = Math.floor(value / 60_000), hours = Math.floor(minutes / 60)
    return t(hours ? 'profile_hours_minutes' : 'profile_minutes').replace('{hours}', String(hours)).replace('{minutes}', String(hours ? minutes % 60 : minutes))
  }
  const metrics = [
    ['profile_tokens_total', activity && compactTokens(activity.totalTokens, locale)],
    ['profile_tokens_peak', activity && compactTokens(activity.peakDailyTokens, locale)],
    ['profile_longest_task', activity && duration(activity.longestTaskMs)],
    ['profile_longest_streak', activity && days(activity.longestStreakDays)],
    ['profile_current_streak', activity && days(activity.currentStreakDays)],
  ]
  return <div className={styles.page} aria-label={t('profile')}>
    <div className={styles.toolbar}><button type="button" className={styles.editButton} disabled={!identity} onClick={() => { setNotice(''); setEditing(true) }}><Icon name="session-menu-rename" size={18} />{t('profile_edit')}</button></div>
    <div className={styles.content}>
      <header className={styles.identity}>
        {identityError && <div className={styles.error} role="alert">{identityError}<button type="button" className="btn-sm" onClick={() => setSequence(value => value + 1)}>{t('auth_status_retry')}</button></div>}
        {(!identityError || identity) && <>
          <div className={styles.avatar} aria-hidden="true">{identity?.avatar ? <img key={identity.avatar} src={identity.avatar} alt="" onError={event => { event.currentTarget.style.display = 'none' }} /> : null}<span>{profileInitials(identity?.displayName || '')}</span></div>
          <h1>{identity?.displayName || t('loading')}</h1>
          {identity?.handle ? <p className={styles.handle}>{'@' + identity.handle}</p> : null}
        </>}
      </header>
      <dl className={styles.metrics} aria-busy={!activity && !activityError}>{metrics.map(([key, value]) => <div key={key!}><dd>{value ?? '—'}</dd><dt>{t(key!)}</dt></div>)}</dl>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {activity && activityError && <p className={styles.error} role="alert">{activityError} <button type="button" className="btn-sm" onClick={() => setSequence(value => value + 1)}>{t('auth_status_retry')}</button></p>}
      {activity ? <TokenActivity data={activity} headingId={activityHeadingId} /> : <section className={styles.activity} aria-labelledby={activityHeadingId}>
        <h2 id={activityHeadingId}>{t('profile_activity')}</h2><p role={activityError ? 'alert' : 'status'} className={styles.empty}>{activityError || t('profile_activity_loading')}</p>
        {activityError && <button type="button" className="btn-sm" onClick={() => setSequence(value => value + 1)}>{t('auth_status_retry')}</button>}
      </section>}
    </div>
    {editing && identity && <ProfileEditor identity={identity} onClose={() => setEditing(false)} onSaved={(next, localOnly) => { setIdentity(next); setEditing(false); setNotice(localOnly ? t('profile_local_saved') : '') }} />}
  </div>
}
