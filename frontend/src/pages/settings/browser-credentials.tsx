import { useEffect, useMemo, useState } from 'react'
import type {
  BrowserAddressFields,
  BrowserAutofillProfileInput,
  BrowserAutofillProfileKind,
  BrowserAutofillProfileSummary,
  BrowserContactFields,
  BrowserCredentialsApi,
  BrowserCredentialsLabels,
  BrowserPasswordSummary,
} from '../../../../contracts/browser-credentials'
import { icon } from '../../icons/registry'
import styles from './browser-credentials.module.css'
import { logHostDiagnostic } from './settings-error-text'
import { RuntimeChoice } from './runtime-tab'

interface Props {
  api: BrowserCredentialsApi
  labels: BrowserCredentialsLabels
}

type ProfileFormKind = BrowserAutofillProfileKind

const addressDefaults: BrowserAddressFields = {
  fullName: '',
  company: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  phone: '',
  email: '',
}

const contactDefaults: BrowserContactFields = {
  name: '',
  email: '',
  phone: '',
}

const emptyPasswordForm = { originUrl: '', username: '', password: '', label: '' }

function field(
  labels: BrowserCredentialsLabels,
  key: keyof BrowserAddressFields | keyof BrowserContactFields,
): string {
  const map: Record<string, string> = {
    fullName: labels.fullNameLabel,
    company: labels.companyLabel,
    addressLine1: labels.addressLine1Label,
    addressLine2: labels.addressLine2Label,
    city: labels.cityLabel,
    state: labels.stateLabel,
    postalCode: labels.postalCodeLabel,
    country: labels.countryLabel,
    phone: labels.phoneLabel,
    email: labels.emailLabel,
    name: labels.contactNameLabel,
  }
  return map[key] ?? key
}

/** Saved passwords on their own page, grouped by origin behind a disclosure row. */
export function BrowserPasswordManager({ api, labels }: Props) {
  const [passwords, setPasswords] = useState<BrowserPasswordSummary[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null)
  const [passwordForm, setPasswordForm] = useState({ ...emptyPasswordForm })
  const [editingPasswordId, setEditingPasswordId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = async () => {
    setBusy(true)
    setError('')
    try {
      setPasswords(await api.listPasswords())
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [api])

  useEffect(() => {
    if (!revealed) return
    const timer = window.setTimeout(() => setRevealed(null), 30_000)
    return () => window.clearTimeout(timer)
  }, [revealed])

  const closeForm = () => {
    setFormOpen(false)
    setEditingPasswordId(null)
    setPasswordForm({ ...emptyPasswordForm })
  }

  const savePassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.savePassword({
        ...(editingPasswordId ? { id: editingPasswordId } : {}),
        originUrl: passwordForm.originUrl,
        username: passwordForm.username,
        password: passwordForm.password,
        ...(passwordForm.label.trim() ? { label: passwordForm.label.trim() } : {}),
      })
      closeForm()
      setRevealed(null)
      await load()
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  const editPassword = async (item: BrowserPasswordSummary) => {
    setBusy(true)
    setError('')
    try {
      const password = await api.revealPassword(item.id)
      setEditingPasswordId(item.id)
      setFormOpen(true)
      setPasswordForm({ originUrl: item.originUrl, username: item.username, password, label: item.label ?? '' })
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  const reveal = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      const value = await api.revealPassword(id)
      setRevealed({ id, value })
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  const copy = async (id: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api.copyPassword(id)
      setNotice(labels.copySucceeded)
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  const removePassword = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await api.deletePassword(id)
      if (revealed?.id === id) setRevealed(null)
      if (editingPasswordId === id) closeForm()
      await load()
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  const groups = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    const matched = term
      ? passwords.filter(item => item.originUrl.toLocaleLowerCase().includes(term) || item.username.toLocaleLowerCase().includes(term))
      : passwords
    const byOrigin = new Map<string, BrowserPasswordSummary[]>()
    for (const item of matched) {
      const list = byOrigin.get(item.originUrl)
      if (list) list.push(item)
      else byOrigin.set(item.originUrl, [item])
    }
    return [...byOrigin.entries()].map(([origin, items]) => ({ origin, items }))
  }, [passwords, search])

  return (
    <section className={styles.root}>
      {error ? <p className={styles.error} role="alert">{labels.errorLabel}: {error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      <div className={styles.toolbar}>
        <input className={styles.search} type="search" value={search} placeholder={labels.passwordSearch} aria-label={labels.passwordSearch} onChange={event => setSearch(event.target.value)} />
        <button type="button" className={styles.addBtn} disabled={busy} onClick={() => { if (formOpen || editingPasswordId) closeForm(); else setFormOpen(true) }}>{labels.passwordAdd}</button>
      </div>
      {formOpen || editingPasswordId ? (
        <form className={styles.form} onSubmit={savePassword}>
          <label>
            <span>{labels.originLabel}</span>
            <input
              required
              value={passwordForm.originUrl}
              onChange={event => setPasswordForm(current => ({ ...current, originUrl: event.target.value }))}
              placeholder="https://example.com"
            />
          </label>
          <label>
            <span>{labels.usernameLabel}</span>
            <input
              required
              value={passwordForm.username}
              onChange={event => setPasswordForm(current => ({ ...current, username: event.target.value }))}
            />
          </label>
          <label>
            <span>{labels.passwordLabel}</span>
            <input
              required
              type="password"
              value={passwordForm.password}
              onChange={event => setPasswordForm(current => ({ ...current, password: event.target.value }))}
            />
          </label>
          <label>
            <span>{labels.labelLabel}</span>
            <input
              value={passwordForm.label}
              onChange={event => setPasswordForm(current => ({ ...current, label: event.target.value }))}
            />
          </label>
          <div className={styles.actions}>
            <button type="submit" disabled={busy}>{labels.saveButton}</button>
            <button type="button" disabled={busy} onClick={closeForm}>{labels.cancelButton}</button>
          </div>
        </form>
      ) : null}
      {groups.length ? (
        <ul className={styles.list}>
          {groups.map(group => (
            <li key={group.origin} className={styles.group}>
              <button type="button" className={styles.groupRow} aria-expanded={expanded === group.origin} onClick={() => setExpanded(current => (current === group.origin ? null : group.origin))}>
                <span className={styles.groupIcon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('import-source-browser', { size: 16 }) }} />
                <span className={styles.groupOrigin}>{group.origin}</span>
                {group.items.length > 1 ? <span className={styles.groupCount}>{labels.passwordAccounts.replace('{count}', String(group.items.length))}</span> : null}
                <span className={styles.groupCaret} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('chevron-right', { size: 12 }) }} />
              </button>
              {expanded === group.origin ? (
                <ul className={styles.accounts}>
                  {group.items.map(item => (
                    <li key={item.id} className={styles.row}>
                      <div className={styles.rowMain}>
                        <strong>{item.username}{item.label ? ` · ${item.label}` : ''}</strong>
                        {revealed?.id === item.id ? <code>{revealed.value}</code> : null}
                      </div>
                      <div className={styles.actions}>
                        <button type="button" onClick={() => void editPassword(item)} disabled={busy}>{labels.editButton ?? labels.saveButton}</button>
                        <button type="button" onClick={() => void reveal(item.id)} disabled={busy}>{labels.revealButton}</button>
                        <button type="button" onClick={() => void copy(item.id)} disabled={busy}>{labels.copyButton}</button>
                        <button type="button" onClick={() => void removePassword(item.id)} disabled={busy}>{labels.deleteButton}</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className={styles.empty}>{passwords.length ? labels.passwordNoResults : labels.emptyPasswords}</p>}
    </section>
  )
}

/** Saved addresses and contact cards used by autofill, on their own page. */
export function BrowserAutofillSettings({ api, labels }: Props) {
  const [profiles, setProfiles] = useState<BrowserAutofillProfileSummary[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [profileKind, setProfileKind] = useState<ProfileFormKind>('address')
  const [profileLabel, setProfileLabel] = useState('')
  const [profileFields, setProfileFields] = useState<BrowserAddressFields | BrowserContactFields>({ ...addressDefaults })
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)

  const load = async () => {
    setBusy(true)
    setError('')
    try {
      setProfiles(await api.listAutofillProfiles())
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [api])

  const resetProfileForm = () => {
    setEditingProfileId(null)
    setProfileLabel('')
    setProfileKind('address')
    setProfileFields({ ...addressDefaults })
  }

  const updateProfileField = (key: string, value: string) => {
    setProfileFields(current => ({ ...current, [key]: value }))
  }

  const profileKeys = profileKind === 'address'
    ? ['fullName', 'company', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country', 'phone', 'email'] as const
    : ['name', 'email', 'phone'] as const

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    const input: BrowserAutofillProfileInput = {
      kind: profileKind,
      label: profileLabel,
      fields: profileFields,
    }
    try {
      if (editingProfileId) await api.updateAutofillProfile(editingProfileId, input)
      else await api.saveAutofillProfile(input)
      resetProfileForm()
      await load()
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  const editProfile = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      const profile = await api.getAutofillProfile(id)
      if (!profile) return
      setEditingProfileId(profile.id)
      setProfileKind(profile.kind)
      setProfileLabel(profile.label)
      setProfileFields({ ...(profile.kind === 'address' ? addressDefaults : contactDefaults), ...profile.fields })
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  const removeProfile = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await api.deleteAutofillProfile(id)
      if (editingProfileId === id) resetProfileForm()
      await load()
    } catch (cause) {
      logHostDiagnostic('browser-credentials', cause)
      setError(labels.operationFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.root}>
      {error ? <p className={styles.error} role="alert">{labels.errorLabel}: {error}</p> : null}
      <form className={styles.form} onSubmit={saveProfile}>
        <label>
          <span>{labels.title}</span>
          <RuntimeChoice id="browser-autofill-kind" label={labels.title} value={profileKind}
            options={[{value:'address',label:labels.addressesTitle},{value:'contact',label:labels.contactsTitle}]}
            onChange={value => {
              const next = value as ProfileFormKind
              setProfileKind(next)
              setEditingProfileId(null)
              setProfileLabel('')
              setProfileFields({ ...(next === 'address' ? addressDefaults : contactDefaults) })
            }} />
        </label>
        <label>
          <span>{labels.labelLabel}</span>
          <input required value={profileLabel} onChange={event => setProfileLabel(event.target.value)} />
        </label>
        {profileKeys.map(key => (
          <label key={key}>
            <span>{field(labels, key)}</span>
            <input
              value={String((profileFields as Record<string, string | undefined>)[key] ?? '')}
              onChange={event => updateProfileField(key, event.target.value)}
            />
          </label>
        ))}
        <div className={styles.actions}>
          <button type="submit" disabled={busy}>{labels.saveButton}</button>
          {editingProfileId ? (
            <button type="button" onClick={resetProfileForm} disabled={busy}>{labels.cancelButton}</button>
          ) : null}
        </div>
      </form>
      {profiles.length ? (
        <ul className={styles.list}>
          {profiles.map(item => (
            <li key={item.id} className={styles.row}>
              <div className={styles.rowMain}>
                <strong>{item.label}</strong>
                <span>{item.kind === 'address' ? labels.addressesTitle : labels.contactsTitle}</span>
              </div>
              <div className={styles.actions}>
                <button type="button" onClick={() => void editProfile(item.id)} disabled={busy}>{labels.editButton ?? labels.saveButton}</button>
                <button type="button" onClick={() => void removeProfile(item.id)} disabled={busy}>{labels.deleteButton}</button>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className={styles.empty}>{labels.emptyProfiles}</p>}
    </section>
  )
}
