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
import styles from './browser-credentials.module.css'
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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

export function BrowserCredentialsSettings({ api, labels }: Props) {
  const [passwords, setPasswords] = useState<BrowserPasswordSummary[]>([])
  const [profiles, setProfiles] = useState<BrowserAutofillProfileSummary[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null)
  const [passwordForm, setPasswordForm] = useState({ originUrl: '', username: '', password: '', label: '' })
  const [editingPasswordId, setEditingPasswordId] = useState<string | null>(null)
  const [profileKind, setProfileKind] = useState<ProfileFormKind>('address')
  const [profileLabel, setProfileLabel] = useState('')
  const [profileFields, setProfileFields] = useState<BrowserAddressFields | BrowserContactFields>({ ...addressDefaults })
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)

  const load = async () => {
    setBusy(true)
    setError('')
    try {
      const [nextPasswords, nextProfiles] = await Promise.all([
        api.listPasswords(),
        api.listAutofillProfiles(),
      ])
      setPasswords(nextPasswords)
      setProfiles(nextProfiles)
    } catch (cause) {
      setError(messageOf(cause))
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

  const profileFieldsForKind = useMemo(
    () => profileKind === 'address' ? addressDefaults : contactDefaults,
    [profileKind],
  )

  const resetProfileForm = () => {
    setEditingProfileId(null)
    setProfileLabel('')
    setProfileKind('address')
    setProfileFields({ ...addressDefaults })
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
      setPasswordForm({ originUrl: '', username: '', password: '', label: '' })
      setEditingPasswordId(null)
      setRevealed(null)
      await load()
    } catch (cause) {
      setError(messageOf(cause))
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
      setPasswordForm({originUrl:item.originUrl,username:item.username,password,label:item.label ?? ''})
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(false) }
  }

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
      setError(messageOf(cause))
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
      setError(messageOf(cause))
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
      setError(messageOf(cause))
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
      setError(messageOf(cause))
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
      await load()
    } catch (cause) {
      setError(messageOf(cause))
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
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const updateProfileField = (key: string, value: string) => {
    setProfileFields(current => ({ ...current, [key]: value }))
  }

  const profileKeys = profileKind === 'address'
    ? ['fullName', 'company', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country', 'phone', 'email'] as const
    : ['name', 'email', 'phone'] as const

  return (
    <section className={styles.root}>
      <header className={styles.header}>
        <h2>{labels.title}</h2>
        <p>{labels.description}</p>
      </header>

      {error ? <p className={styles.error} role="alert">{labels.errorLabel}: {error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

      <div className={styles.section}>
        <h3>{labels.passwordsTitle}</h3>
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
          <button type="submit" disabled={busy}>{labels.saveButton}</button>
          {editingPasswordId && <button type="button" disabled={busy} onClick={() => {setEditingPasswordId(null);setPasswordForm({originUrl:'',username:'',password:'',label:''})}}>{labels.cancelButton}</button>}
        </form>

        {passwords.length ? (
          <ul className={styles.list}>
            {passwords.map(item => (
              <li key={item.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <strong>{item.originUrl}</strong>
                  <span>{item.username}{item.label ? ` · ${item.label}` : ''}</span>
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
        ) : <p className={styles.empty}>{labels.emptyPasswords}</p>}
      </div>

      <div className={styles.section}>
        <h3>{profileKind === 'address' ? labels.addressesTitle : labels.contactsTitle}</h3>
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
      </div>
    </section>
  )
}
