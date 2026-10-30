import { useEffect, useId, useRef, useState } from 'react'
import { FriendsDialog } from '../friends/FriendsDialog'
import { useT } from '../../i18n'
import { profileInitials } from './activity'
import { saveIdentity, type ProfileIdentity } from './identity'
import styles from './profile.module.css'

export function ProfileEditor({ identity, onClose, onSaved }: {
  identity: ProfileIdentity; onClose: () => void; onSaved: (identity: ProfileIdentity, localOnly: boolean) => void
}) {
  const formId = useId()
  const t = useT(), [draft, setDraft] = useState(identity), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null), [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const file = useRef<HTMLInputElement>(null), drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const alive = useRef(true), generation = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current } }, [])
  const choosePhoto = async (selected?: File) => {
    if (!selected) return
    const current = ++generation.current
    if (!selected.type.startsWith('image/')) { setError(t('profile_photo_invalid')); return }
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(selected)
      })
      const image = new Image()
      image.src = url
      await image.decode()
      if (!alive.current || generation.current !== current) return
      setPhoto(image); setZoom(1); setOffset({ x: 0, y: 0 }); setError('')
    } catch { if (alive.current && generation.current === current) setError(t('avatar_upload_failed_prefix') + t('profile_photo_invalid')) }
  }
  const scale = photo ? Math.max(160 / photo.width, 160 / photo.height) * zoom : 1
  const boundOffset = (x: number, y: number, nextScale = scale) => ({
    x: Math.max(-(photo ? photo.width * nextScale - 160 : 0) / 2, Math.min((photo ? photo.width * nextScale - 160 : 0) / 2, x)),
    y: Math.max(-(photo ? photo.height * nextScale - 160 : 0) / 2, Math.min((photo ? photo.height * nextScale - 160 : 0) / 2, y)),
  })
  const save = async () => {
    if (busy || !draft.displayName.trim()) return
    setBusy(true); setError('')
    try {
      let avatar = draft.avatar
      if (photo) {
        const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256
        const context = canvas.getContext('2d')
        if (!context) throw new Error(t('profile_save_failed'))
        context.drawImage(photo, ((160 - photo.width * scale) / 2 + offset.x) * 1.6, ((160 - photo.height * scale) / 2 + offset.y) * 1.6, photo.width * scale * 1.6, photo.height * scale * 1.6)
        avatar = canvas.toDataURL('image/png')
      }
      const next = { ...draft, displayName: draft.displayName.trim(), handle: draft.handle.replace(/^@/, '').trim(), avatar }
      const result = await saveIdentity(next)
      if (alive.current) onSaved(next, result.localOnly)
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : t('profile_save_failed')) }
    finally { if (alive.current) setBusy(false) }
  }
  return <FriendsDialog title={t('profile_edit_title')} onClose={onClose} closeDisabled={busy} footer={<>
    <button type="button" className="kls-btn kls-btn-secondary" disabled={busy} onClick={onClose}>{t('cancel')}</button>
    <button type="submit" form={formId} className="kls-btn kls-btn-primary" disabled={busy || !draft.displayName.trim()}>{t(busy ? 'saving' : 'save')}</button>
  </>}>
    <form id={formId} className={styles.editor} onSubmit={event => { event.preventDefault(); void save() }}>
      <div className={styles.photoEditor}>
        <div className={`${styles.avatar} ${styles.photoPreview} ${photo ? styles.cropping : ''}`} aria-label={t('profile_photo')}
          onPointerDown={event => { if (photo && !busy) { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, left: offset.x, top: offset.y } } }}
          onPointerMove={event => { if (drag.current) setOffset(boundOffset(drag.current.left + event.clientX - drag.current.x, drag.current.top + event.clientY - drag.current.y)) }}
          onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
          {photo ? <img src={photo.src} alt="" draggable={false} style={{ width: photo.width * scale, height: photo.height * scale, maxWidth: 'none', transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)` }} /> : draft.avatar ? <img src={draft.avatar} alt="" /> : profileInitials(draft.displayName)}
        </div>
        {photo && <><p>{t('profile_photo_adjust')}</p><input type="range" min="1" max="3" step="0.01" value={zoom} aria-label={t('profile_photo_zoom')} disabled={busy} onChange={event => {
          const next = Number(event.target.value); setZoom(next)
          setOffset(boundOffset(offset.x, offset.y, Math.max(160 / photo.width, 160 / photo.height) * next))
        }} /></>}
        <div className={styles.photoActions}><button type="button" className="btn-sm" disabled={busy} onClick={() => file.current?.click()}>{t('profile_photo_change')}</button>
          {photo && <button type="button" className="btn-sm" disabled={busy} onClick={() => { ++generation.current; setPhoto(null) }}>{t('cancel')}</button>}</div>
        <input type="file" accept="image/*" ref={file} hidden onChange={event => { void choosePhoto(event.target.files?.[0]); event.target.value = '' }} />
      </div>
      <label>{t('display_name')}<input data-initial-focus name="displayName" required maxLength={64} value={draft.displayName} disabled={busy} onChange={event => setDraft({ ...draft, displayName: event.target.value })} /></label>
      <label>{t('profile_handle')}<input name="handle" maxLength={33} value={draft.handle} disabled={busy} autoCapitalize="none" autoComplete="off" placeholder="@" onChange={event => setDraft({ ...draft, handle: event.target.value })} /></label>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  </FriendsDialog>
}
