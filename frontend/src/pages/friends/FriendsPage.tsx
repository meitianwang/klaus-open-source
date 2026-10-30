import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FriendAppsSnapshot, FriendCard, FriendGrantTemplate, FriendProfile, FriendSummary, FriendsSnapshot, FriendsRuntimeSnapshot, FriendTaskGrant } from '../../../../shared/friends'
import { PageHeader } from '../../components/PageHeader'
import { Icon } from '../../components/Icon'
import { intlLocale, useT } from '../../i18n'
import { invalidateFriendMentions } from '../../chat/composer/mention-queries'
import { FriendAvatar, FriendsDialog } from './FriendsDialog'
import { GrantEditor, ReceiveChoiceRow, receiveChoice } from './GrantEditor'
import { friendDisplayName } from './display-name'
import { composeFriendTask } from './compose'
import { createFriendsPageController, failureText, grantSubmission } from './data'
import { FRIEND_INVITE_EVENT, takeQueuedFriendInvite } from './invite'
import { decodeImageFile, decodeVideoFrame } from './qr-scan'
import { writeClipboardText } from '../../clipboard'
import { PrefToggleRow } from '../settings/kv'
import styles from './friends.module.css'

export const FRIENDS_PAGE_VISIBLE_EVENT = 'klaus:friends-page-visible'

export function friendSharedRoot(root: string | null | undefined, friendId: string): string | null {
  if (!root || !/^[A-Za-z0-9_-]{1,128}$/.test(friendId)) return null
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${friendId}`
}
export function relativeFriendTime(timestamp: number, locale = intlLocale(), now = Date.now()): string {
  const seconds = Math.min(0, Math.round((timestamp - now) / 1000))
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (seconds > -60) return formatter.format(seconds, 'second')
  if (seconds > -3600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (seconds > -86400) return formatter.format(Math.round(seconds / 3600), 'hour')
  return formatter.format(Math.round(seconds / 86400), 'day')
}
function AddFriendDialog({ onClose, onAdded, runtime, onPickDirectory, initialEmail }: { onClose: () => void; onAdded: () => void; runtime: FriendsRuntimeSnapshot | null; onPickDirectory: () => Promise<string | null>; initialEmail?: string }) {
  const t = useT(), [email, setEmail] = useState(initialEmail ?? ''), [profile, setProfile] = useState<FriendProfile | null>(null)
  const [allowed, setAllowed] = useState(true), [pending, setPending] = useState(false), [sending, setSending] = useState(false)
  const [lookedUp, setLookedUp] = useState(false), [error, setError] = useState('')
  const [apps, setApps] = useState<FriendAppsSnapshot | null>(null), [grant, setGrant] = useState<FriendTaskGrant | null>(null)
  const generation = useRef(0), mounted = useRef(true), submitting = useRef(false)
  const deviceId = runtime?.currentDeviceId ?? null
  const device = runtime?.receiver?.devices.find(row => row.id === deviceId) ?? null
  useEffect(() => () => { mounted.current = false; ++generation.current }, [])
  useEffect(() => {
    // A scanned code arrives already resolved to one email; look it up once so
    // the owner sees the account behind the code before sending anything.
    if (initialEmail) void find()
    // Runs once on mount: the scanned email arrives with the dialog.
  }, [])
  useEffect(() => {
    if (!deviceId || !runtime) return
    setGrant(value => value && value.deviceId === deviceId ? value : { ...runtime.defaultGrant, deviceId, remember: false })
    setAllowed(runtime.defaultGrant.policy !== 'reject')
    let disposed = false
    void window.klaus.friends.apps({ deviceId }).then((snapshot: FriendAppsSnapshot) => { if (!disposed) setApps(snapshot) }).catch(() => { if (!disposed) setApps({ available: false, apps: [] }) })
    return () => { disposed = true }
    // The baseline is read once per receiving computer; later runtime refreshes must
    // not clobber what the owner is editing.
  }, [deviceId])
  const find = async () => {
    if (submitting.current) return
    const normalized = email.trim().toLowerCase(), current = ++generation.current
    setPending(true); setError(''); setProfile(null); setLookedUp(false)
    try {
      const result = await window.klaus.friends.lookup(normalized)
      if (mounted.current && current === generation.current) { setProfile(result.profile); setLookedUp(true) }
    } catch (failure) { if (mounted.current && current === generation.current) setError(failureText(failure)) }
    finally { if (mounted.current && current === generation.current) setPending(false) }
  }
  const staged = allowed && grant && apps && device ? (() => {
    try { return { grant: grantSubmission({ ...grant, remember: false }, device, deviceId, apps), error: '' } }
    catch (failure) { return { grant: null, error: failureText(failure) } }
  })() : { grant: null, error: '' }
  const send = async () => {
    if (submitting.current || !profile || profile.email !== email.trim().toLowerCase()) return
    submitting.current = true; setSending(true); setError('')
    try {
      await window.klaus.friends.request({ email: profile.email, allowIncomingAgentTasks: allowed, ...(staged.grant ? { grant: staged.grant } : {}) })
      if (mounted.current) onAdded()
    }
    catch (failure) { if (mounted.current) setError(failureText(failure)) }
    finally { submitting.current = false; if (mounted.current) setSending(false) }
  }
  return <FriendsDialog wide title={t('friends_add')} subtitle={t('friends_email_hint')} onClose={onClose} closeDisabled={sending} footer={<>
    <button className="kls-btn kls-btn-secondary" disabled={sending} onClick={onClose}>{t('friends_cancel')}</button>
    <button className="kls-btn kls-btn-primary" disabled={pending || sending || !profile || profile.email !== email.trim().toLowerCase() || !!staged.error} onClick={() => void send()}>{t(sending ? 'friends_sending' : 'friends_send_request')}</button>
  </>}>
    <form onSubmit={event => { event.preventDefault(); void find() }} className={styles.lookupForm}>
      <label htmlFor="friends-email">{t('friends_email')}</label><div className={styles.lookupFields}><input id="friends-email" data-initial-focus disabled={sending} type="email" autoComplete="off" required value={email} placeholder={t('friends_email_placeholder')} onChange={event => { ++generation.current; setEmail(event.target.value); setProfile(null); setLookedUp(false); setError(''); setPending(false) }} /><button className="kls-btn kls-btn-secondary" type="submit" disabled={pending || sending || !email.trim()}>{t(pending ? 'friends_searching' : 'friends_lookup')}</button></div>
    </form>
    {profile && <div className={styles.profileResult}><FriendAvatar large name={friendDisplayName(profile)} url={profile.avatarUrl} /><div><strong>{friendDisplayName(profile)}</strong><p>{profile.email}</p></div><span className={styles.accountBadge}>{t('friends_klaus_account')}</span></div>}
    {lookedUp && !profile && <p className={styles.formError}>{t('friends_account_not_found')}</p>}
    <div className={styles.settingsSection}><h3>{t('friends_permission_single')}</h3>
      <p className={styles.muted}>{t('friends_add_grant_hint')}</p>
      {grant && apps && device ? <GrantEditor receiving={allowed} onReceivingChange={setAllowed} draft={grant} apps={apps} disabled={sending} targets={runtime?.executionTargets} onPickDirectory={onPickDirectory} onChange={next => setGrant(value => value ? next(value) : value)} /> : <p className={styles.muted}>{t('friends_apps_loading')}</p>}
      {staged.error && <p className={styles.formError} role="alert">{t(staged.error) === staged.error ? staged.error : t(staged.error)}</p>}
    </div>
    {error && <p className={styles.formError} role="alert">{error}</p>}
  </FriendsDialog>
}

/** The owner's scannable add-me card. The code itself is rendered by the host
 *  (friends:my-card returns a finished PNG data URL); this dialog only shows it
 *  and carries the two outward actions: save the PNG to disk, or copy a plain
 *  text card (name, email, payload) for pasting into a chat. */
export function MyQrDialog({ onClose, onSelfInvite }: { onClose: () => void; onSelfInvite: (email: string) => void }) {
  const t = useT()
  const [card, setCard] = useState<FriendCard | null>(null), [error, setError] = useState('')
  const [saving, setSaving] = useState(false), [sharing, setSharing] = useState(false), [notice, setNotice] = useState('')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!card) return
    try { await writeClipboardText(card.payload); setCopied(true); setTimeout(() => { if (mounted.current) setCopied(false) }, 2000) }
    catch (failure) { setError(failureText(failure)) }
  }
  const mounted = useRef(true), generation = useRef(0)
  useEffect(() => {
    mounted.current = true
    const current = ++generation.current
    window.klaus.friends.myCard()
      .then((result: FriendCard) => { if (mounted.current && current === generation.current) setCard(result) })
      .catch((failure: unknown) => { if (mounted.current && current === generation.current) setError(failureText(failure)) })
    return () => { mounted.current = false; ++generation.current }
  }, [])
  const save = async () => {
    setSaving(true); setNotice(''); setError('')
    try { const result = await window.klaus.friends.saveQrCard(); if (mounted.current && result.saved) setNotice(t('friends_my_qr_saved')) }
    catch (failure) { if (mounted.current) setError(failureText(failure)) }
    finally { if (mounted.current) setSaving(false) }
  }
  const share = async () => {
    setSharing(true); setNotice(''); setError('')
    try { await window.klaus.friends.shareQrCard(); if (mounted.current) setNotice(t('friends_my_qr_shared')) }
    catch (failure) { if (mounted.current) setError(failureText(failure)) }
    finally { if (mounted.current) setSharing(false) }
  }
  return <FriendsDialog title={t('friends_my_qr_title')} subtitle={t('friends_my_qr_hint')} onClose={onClose} footer={<>
    <button className="kls-btn kls-btn-secondary" disabled={saving || sharing} onClick={onClose}>{t('friends_done')}</button>
    <button className="kls-btn kls-btn-secondary" disabled={!card?.signedIn || saving || sharing} onClick={() => void share()}>{t('friends_my_qr_share')}</button>
    <button className="kls-btn kls-btn-primary" disabled={!card?.signedIn || saving || sharing} onClick={() => void save()}>{t(saving ? 'friends_saving' : 'friends_my_qr_save')}</button>
  </>}>
    {!card && !error && <p className={styles.muted} role="status">{t('friends_my_qr_loading')}</p>}
    {card && !card.signedIn && <p className={styles.formError} role="alert">{t('friends_my_qr_unsigned')}</p>}
    {card?.signedIn && <div className={styles.qrCard}>
      <div className={styles.qrIdentity}><FriendAvatar large name={card.displayName} url={card.avatarUrl} /><div><strong>{card.displayName || t('friends_no_nickname')}</strong><p>{card.email}</p></div></div>
      <img className={styles.qrImage} src={card.qrDataUrl} alt={t('friends_my_qr_title')} />
      <div className={styles.inviteRow}>
        <span className={styles.inviteLabel}>{t('friends_my_qr_link')}</span>
        <a className={styles.inviteLink} href={card.payload} onClick={event => { event.preventDefault(); onSelfInvite(card.email) }}>{card.payload}</a>
        <button className="kls-btn kls-btn-secondary" onClick={() => void copy()}>{t(copied ? 'friends_my_qr_link_copied' : 'friends_my_qr_link_copy')}</button>
      </div>
      <p className={styles.muted}>{t('friends_my_qr_link_hint')}</p>
    </div>}
    {notice && <p className={styles.muted} role="status">{notice}</p>}
    {error && <p className={styles.formError} role="alert">{error}</p>}
  </FriendsDialog>
}

/** Scan someone else's add-me code. Two routes into the same decoder: live
 *  camera frames (the host leases the camera for as long as this dialog is
 *  open) and a picked image file. A decoded payload hands its email to the
 *  add-friend dialog, which confirms the account before any request goes out. */
export function ScanAddDialog({ onClose, onFound }: { onClose: () => void; onFound: (email: string) => void }) {
  const t = useT()
  const [camera, setCamera] = useState<'off' | 'starting' | 'on' | 'denied'>('off')
  const [decoding, setDecoding] = useState(false), [error, setError] = useState('')
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null), timer = useRef<number | null>(null)
  const mounted = useRef(true), picked = useRef<HTMLInputElement>(null)
  const stop = () => {
    if (timer.current !== null) { clearInterval(timer.current); timer.current = null }
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null
    setCamera('off')
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; if (timer.current !== null) clearInterval(timer.current); stream.current?.getTracks().forEach(track => track.stop()) }
  }, [])
  const start = async () => {
    setError(''); setCamera('starting')
    try {
      await window.klaus.app.cameraLease()
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      if (!mounted.current) { media.getTracks().forEach(track => track.stop()); void window.klaus.app.cameraLeaseRelease(); return }
      stream.current = media
      if (video.current) { video.current.srcObject = media; await video.current.play().catch(() => {}) }
      setCamera('on')
      timer.current = window.setInterval(() => {
        const source = video.current
        if (!source || !canvas.current) return
        const email = decodeVideoFrame(source, canvas.current)
        if (email && mounted.current) { stop(); onFound(email) }
      }, 350)
    } catch {
      if (mounted.current) { setCamera('denied'); void window.klaus.app.cameraLeaseRelease().catch(() => {}) }
    }
  }
  const close = () => { stop(); void window.klaus.app.cameraLeaseRelease().catch(() => {}); onClose() }
  const pick = async (file: File | undefined) => {
    if (!file) return
    setDecoding(true); setError('')
    try {
      const email = await decodeImageFile(file)
      if (!mounted.current) return
      if (email) { stop(); onFound(email) } else setError(t('friends_scan_not_found'))
    } catch { if (mounted.current) setError(t('friends_scan_not_found')) }
    finally { if (mounted.current) setDecoding(false); if (picked.current) picked.current.value = '' }
  }
  return <FriendsDialog title={t('friends_scan_title')} subtitle={t('friends_scan_hint')} onClose={close} footer={<>
    <button className="kls-btn kls-btn-secondary" disabled={decoding} onClick={close}>{t('friends_cancel')}</button>
    <button className="kls-btn kls-btn-secondary" disabled={camera === 'starting' || decoding} onClick={() => { if (camera === 'on') { stop(); void window.klaus.app.cameraLeaseRelease().catch(() => {}) } else void start() }}>{t(camera === 'on' ? 'friends_scan_camera_stop' : 'friends_scan_camera')}</button>
    <button className="kls-btn kls-btn-primary" disabled={decoding || camera === 'starting'} onClick={() => picked.current?.click()}>{t('friends_scan_pick_image')}</button>
  </>}>
    <input ref={picked} type="file" accept="image/*" hidden onChange={event => void pick(event.target.files?.[0])} />
    <canvas ref={canvas} hidden />
    <div className={styles.scanStage}>
      {camera === 'on' || camera === 'starting'
        ? <video ref={video} className={styles.scanVideo} playsInline muted autoPlay />
        : <div className={styles.scanPlaceholder}><Icon name="scan" size={40} /></div>}
    </div>
    {camera === 'starting' && <p className={styles.muted} role="status">{t('friends_scan_camera_starting')}</p>}
    {camera === 'denied' && <p className={styles.formError} role="alert">{t('friends_scan_camera_denied')}</p>}
    {decoding && <p className={styles.muted} role="status">{t('friends_scan_decoding')}</p>}
    {error && camera !== 'denied' && <p className={styles.formError} role="alert">{error}</p>}
  </FriendsDialog>
}

export function GrantSummary({ grant }: { grant: FriendTaskGrant }) {
  const t = useT()
  return <div className={styles.scopeSummary}>
    <p>{t('friends_computer_use')}: {grant.computerUse ? grant.apps.join(', ') : t('friends_not_allowed')}</p>
    <p>{t('friends_network')}: {t(grant.network === true ? 'friends_allowed' : 'friends_not_allowed')}</p>
    {grant.directories.length ? <ul>{grant.directories.map(row => <li key={row.path}>{row.path} · {t(row.access === 'read' ? 'friends_read_only' : 'friends_read_write')}</li>)}</ul> : <p>{t('friends_no_directories')}</p>}
  </div>
}

export function FriendsPage() {
  const t = useT()
  const [controller] = useState(() => createFriendsPageController(window.klaus.friends))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [search, setSearch] = useState(''), [adding, setAdding] = useState(false), [settingsId, setSettingsId] = useState<string | null>(null)
  const [myQr, setMyQr] = useState(false)
  const [scanning, setScanning] = useState(false), [scannedEmail, setScannedEmail] = useState<string | null>(null)
  const [acceptingId, setAcceptingId] = useState<string | null>(null), [acceptChoice, setAcceptChoice] = useState<'off' | 'approve' | 'auto'>('approve')
  const [dialogError, setDialogError] = useState('')
  const visible = useRef(true), dialogGeneration = useRef(0), disposed = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const management = state.friends, runtime = state.runtime
  const friends = management?.friends ?? [], devices = runtime?.receiver?.devices ?? []
  const currentDeviceId = runtime?.currentDeviceId ?? null
  const currentDevice = devices.find(device => device.id === currentDeviceId)
  const settingsFriend = friends.find(friend => friend.id === settingsId), acceptingFriend = friends.find(friend => friend.id === acceptingId)
  const busy = !!state.busy
  const closeDialogs = () => { ++dialogGeneration.current; setAdding(false); setMyQr(false); setScanning(false); setScannedEmail(null); setSettingsId(null); setAcceptingId(null); setDialogError('') }

  useEffect(() => {
    // A clicked add-me link arrives either before this island mounts (queued)
    // or while it is up (event). Both paths open the add dialog prefilled.
    const acceptInvite = (email: string | null) => {
      if (!email) return
      setScannedEmail(email); setAdding(true)
    }
    acceptInvite(takeQueuedFriendInvite())
    const invited = (event: Event) => acceptInvite((event as CustomEvent<{ email?: string }>).detail?.email ?? null)
    window.addEventListener(FRIEND_INVITE_EVENT, invited)
    void controller.refresh()
    const show = (event: Event) => { visible.current = (event as CustomEvent).detail?.visible === true; if (visible.current) void controller.refresh() }
    const focus = () => { if (visible.current) void controller.refresh() }
    const timer = setInterval(focus, 5_000)
    window.addEventListener(FRIENDS_PAGE_VISIBLE_EVENT, show); window.addEventListener('focus', focus)
    const auth = window.klaus.on.klausAuthUpdated(() => { controller.reset(); closeDialogs(); invalidateFriendMentions(); void controller.refresh() })
    const changed = window.klaus.on.friendsChanged(() => { if (visible.current) void controller.refresh() })
    return () => { disposed.current = true; ++dialogGeneration.current; controller.dispose(); clearInterval(timer); auth(); changed(); window.removeEventListener(FRIEND_INVITE_EVENT, invited); window.removeEventListener(FRIENDS_PAGE_VISIBLE_EVENT, show); window.removeEventListener('focus', focus) }
  }, [controller])

  useEffect(() => {
    // Section headings stick just below the page header, so they need its
    // live height as their sticky offset. The header is not ours (shared
    // factory) and its height moves with topbar wrapping and language, so
    // measure instead of pinning a number in CSS.
    const host = contentRef.current
    if (!host) return
    let observer: ResizeObserver | null = null
    let observed: Element | null = null
    const apply = () => {
      // Re-query every time: the header shell rewrites its inner markup
      // whenever an action button changes state, which swaps the node a
      // stored reference (and its observer) would dangle on.
      const header = document.querySelector('.kls-page-header')
      if (!header) return
      if (header !== observed) {
        observed = header
        observer?.disconnect()
        observer = new ResizeObserver(apply)
        observer.observe(header)
      }
      host.style.setProperty('--friends-header-height', `${header.getBoundingClientRect().height}px`)
    }
    apply()
    // The header shell (a sibling of this content column under the island
    // container) is rewritten in place whenever an action button changes
    // state; watching the shared parent's subtree is how a swapped header
    // gets re-measured and re-observed.
    const mutations = new MutationObserver(apply)
    if (host.parentElement) mutations.observe(host.parentElement, { childList: true, subtree: true })
    const relanguage = () => apply()
    window.addEventListener('klaus:lang-change', relanguage)
    return () => { observer?.disconnect(); mutations.disconnect(); window.removeEventListener('klaus:lang-change', relanguage) }
  }, [])

  const manage = async (key: string, operation: () => Promise<FriendsSnapshot>) => {
    const success = await controller.mutateFriends(key, operation)
    if (success) { invalidateFriendMentions(); await controller.refresh() }
    return success
  }
  const operate = (key: string, operation: () => Promise<FriendsRuntimeSnapshot>) => controller.mutateRuntime(key, operation)
  const remove = async (friend: FriendSummary) => {
    if (friend.status === 'accepted' && !(await window.klausDialog.confirm({ title: t('friends_remove_title'), message: t('friends_remove_confirm'), confirmText: t('friends_remove'), danger: true }))) return
    if (await manage(`remove:${friend.id}`, () => window.klaus.friends.remove({ friendId: friend.id }))) setSettingsId(null)
  }
  const revoke = async (template: FriendGrantTemplate) => {
    if (!(await window.klausDialog.confirm({ title: t('friends_revoke_saved_grant'), message: t('friends_revoke_confirm'), confirmText: t('friends_revoke_saved_grant'), danger: true }))) return
    await operate(`revoke:${template.id}`, () => window.klaus.friends.revokeTemplate({ friendId: template.friendId, deviceId: template.deviceId }))
  }
  const pickDirectory = async () => {
    if (!currentDeviceId) throw new Error(t('friends_grant_local_only'))
    const picked = await window.klaus.session.pickWorkdir(); return picked?.path ?? null
  }
  const [settingsGrant, setSettingsGrant] = useState<FriendTaskGrant | null>(null)
  const [settingsApps, setSettingsApps] = useState<FriendAppsSnapshot | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsAllowed, setSettingsAllowed] = useState(true)
  // The remark draft loads once per opened friend; runtime refreshes must not
  // clobber what the owner is typing.
  const [remarkDraft, setRemarkDraft] = useState<string | null>(null)
  // Absent on the friend means confirm: only an explicit false sends without asking.
  const [confirmDraft, setConfirmDraft] = useState(true)
  useEffect(() => {
    const friend = friends.find(row => row.id === settingsId)
    setRemarkDraft(friend ? friend.remark ?? '' : null)
    setConfirmDraft(friend?.confirmAgentMessages !== false)
    const template = runtime?.templates.find(row => row.friendId === settingsId && row.deviceId === currentDeviceId)
    setSettingsAllowed(!!friend && receiveChoice(friend.allowIncomingAgentTasks, template?.grant.policy) !== 'off')
  }, [settingsId])
  useEffect(() => {
    if (!settingsId || !currentDeviceId) { setSettingsGrant(null); setSettingsApps(null); return }
    // An existing grant edits in place; a friend without one starts from the account
    // baseline so the form is never an empty "create" step.
    const existing = (runtime?.templates ?? []).find(template => template.friendId === settingsId && template.deviceId === currentDeviceId)
    const baseline = existing?.grant ?? runtime?.defaultGrant
    setSettingsGrant(value => value ?? (baseline ? { ...baseline, policy: baseline.policy === 'reject' ? 'approve' : baseline.policy, deviceId: currentDeviceId, remember: true } : null))
    setSettingsApps(value => value ?? null)
    if (!settingsApps) void window.klaus.friends.apps({ deviceId: currentDeviceId }).then((snapshot: FriendAppsSnapshot) => setSettingsApps(snapshot)).catch(() => setSettingsApps({ available: false, apps: [] }))
    // The draft loads once per opened friend; runtime refreshes must not clobber edits.
  }, [settingsId, currentDeviceId])
  const settingsStaged = settingsGrant && settingsApps && currentDevice ? (() => {
    try { return { grant: grantSubmission({ ...settingsGrant, remember: true }, currentDevice, currentDeviceId, settingsApps), error: '' } }
    catch (failure) { return { grant: null, error: failureText(failure) } }
  })() : { grant: null, error: '' }
  const settingsGrantError = settingsStaged.error
  // One dialog, one save: the footer button persists both the private remark
  // and the remembered authorization so the two cannot drift apart. With
  // receiving off there is no authorization to store, so an edited remark alone
  // still enables the button.
  const remarkChanged = !!settingsFriend && remarkDraft !== null && remarkDraft.trim() !== (settingsFriend.remark ?? '')
  const receivingChanged = !!settingsFriend && settingsAllowed !== settingsFriend.allowIncomingAgentTasks
  const confirmChanged = !!settingsFriend && confirmDraft !== (settingsFriend.confirmAgentMessages !== false)
  const grantReady = !!settingsStaged.grant && settingsAllowed
  const saveSettings = async () => {
    if (!settingsFriend || settingsSaving || settingsAllowed && !grantReady || !(remarkChanged || receivingChanged || confirmChanged || grantReady)) return
    const friend = settingsFriend
    const remark = remarkDraft === null ? null : remarkDraft.trim()
    if (!settingsAllowed && friend.allowIncomingAgentTasks) {
      const count = runtime?.tasks.filter(task => task.friendId === friend.id && ['pending', 'starting', 'running'].includes(task.status)).length ?? 0
      if (count && !await window.klausDialog.confirm({ title: t('friends_disable_receiving_title'), message: t('friends_disable_receiving_confirm').replace('{count}', String(count)), confirmText: t('friends_save'), danger: true })) return
    }
    setSettingsSaving(true); setDialogError('')
    try {
      if (receivingChanged) {
        const ok = await manage(`permission:${friend.id}`, () => window.klaus.friends.setAuthorization({ friendId: friend.id, allowed: settingsAllowed }))
        if (!ok) throw new Error(controller.getSnapshot().actionError || t('friends_action_error'))
      }
      if (grantReady) {
        const grant = settingsStaged.grant!
        const saved = await operate(`template:${friend.id}`, () => window.klaus.friends.saveTemplate({ friendId: friend.id, deviceId: currentDeviceId!, grant }))
        if (!saved) throw new Error(controller.getSnapshot().actionError || t('friends_action_error'))
      }
      if (remark !== null && remark !== (friend.remark ?? '')) {
        const ok = await manage(`remark:${friend.id}`, () => window.klaus.friends.setRemark({ friendId: friend.id, remark }))
        if (!ok) throw new Error(controller.getSnapshot().actionError || t('friends_action_error'))
      }
      if (confirmChanged) {
        const ok = await manage(`agent-confirmation:${friend.id}`, () => window.klaus.friends.setAgentConfirmation({ friendId: friend.id, confirm: confirmDraft }))
        if (!ok) throw new Error(controller.getSnapshot().actionError || t('friends_action_error'))
      }
      setSettingsId(null)
    } catch (failure) { setDialogError(failureText(failure)) }
    finally { setSettingsSaving(false) }
  }
  const query = search.trim().toLowerCase()
  const filtered = friends.filter(friend => friendDisplayName(friend).toLowerCase().includes(query) || friend.displayName.toLowerCase().includes(query))
  const accepted = filtered.filter(friend => friend.status === 'accepted'), requests = filtered.filter(friend => friend.status !== 'accepted')
  const row = (friend: FriendSummary) => {
    const name = friendDisplayName(friend)
    const policy = runtime?.templates.find(row => row.friendId === friend.id && row.deviceId === currentDeviceId)?.grant.policy
    const choice = receiveChoice(friend.allowIncomingAgentTasks, policy)
    return <article className={styles.row} key={friend.id} data-friend-id={friend.id}>
      <FriendAvatar name={name} url={friend.avatarUrl} /><div className={styles.details}>
        <div className={styles.name}>{name}</div>
        <div className={styles.status}>{friend.status === 'accepted' ? <><span className={`${styles.dot} ${friend.online ? styles.online : ''}`} />{t(friend.online ? 'friends_online' : 'friends_offline')} · {t(friend.peerAllowsAgentTasks ? 'friends_peer_receiving' : 'friends_peer_not_receiving')} · {t(`friends_your_policy_${choice}`)}</> : t(friend.status === 'pending-incoming' ? 'friends_pending_incoming' : 'friends_pending_outgoing')}</div>
      </div><div className={styles.actions}>
        {friend.status === 'pending-incoming' ? <><button className="kls-btn kls-btn-primary" disabled={busy} onClick={() => { setAcceptingId(friend.id); setAcceptChoice(receiveChoice(true, runtime?.defaultGrant.policy)) }}>{t('friends_accept')}</button><button className="kls-btn kls-btn-secondary" disabled={busy} onClick={() => void manage(`decline:${friend.id}`, () => window.klaus.friends.respond({ friendId: friend.id, accept: false, allowIncomingAgentTasks: false }))}>{t('friends_decline')}</button></>
          : friend.status === 'pending-outgoing' ? <button className="kls-btn kls-btn-secondary" disabled={busy} onClick={() => void remove(friend)}>{t('friends_cancel_request')}</button>
          : <><button className={`kls-btn ${friend.peerAllowsAgentTasks ? 'kls-btn-primary' : 'kls-btn-secondary'}`} disabled={!friend.peerAllowsAgentTasks} onClick={() => composeFriendTask(friend.id, name)}>{t('friends_send_task')}</button><button className="kls-btn kls-btn-secondary" onClick={() => { setDialogError(''); setSettingsId(friend.id) }}>{t('friends_settings')}</button></>}
      </div>
    </article>
  }
  return <>
    <PageHeader titleKey="friends" subtitleKey="friends_subtitle" refresh={{ id: 'friends-refresh', titleKey: 'friends_refresh', disabled: state.loading || busy, onClick: controller.refresh }} search={{ id: 'friends-search', placeholderKey: 'friends_search', value: search, onInput: setSearch }} create={{
      btnId: 'friends-add', menuId: 'friends-add-menu', disabled: !management?.signedIn || busy,
      items: [
        { action: 'add', labelKey: 'friends_menu_add', iconHtml: (window as any).klsTopbar?.icons?.['user-plus'] },
        { action: 'my-qr', labelKey: 'friends_menu_my_qr', iconHtml: (window as any).klsTopbar?.icons?.qr },
        { action: 'scan', labelKey: 'friends_menu_scan', iconHtml: (window as any).klsTopbar?.icons?.scan },
      ],
      onAction: action => {
        if (action === 'add') setAdding(true)
        else if (action === 'my-qr') { setDialogError(''); setMyQr(true) }
        else if (action === 'scan') { setDialogError(''); setScanning(true) }
      },
    }} />
    <div className={styles.content} ref={contentRef}>
      {[state.friendsError, state.runtimeError, state.actionError, dialogError].filter(Boolean).map((error, index) => <div className={styles.error} key={`${index}:${error}`} role="alert"><span>{error}</span><button className="kls-btn kls-btn-secondary" disabled={busy} onClick={() => { setDialogError(''); controller.clearActionError(); void controller.refresh() }}>{t('friends_retry')}</button></div>)}
      {state.loading && !management && <p className={styles.empty} role="status">{t('friends_loading')}</p>}
      {management && !management.signedIn && <div className={styles.empty}><Icon name="sb-nav-friends" size={28} /><p>{t('friends_sign_in')}</p><button className="kls-btn kls-btn-primary" onClick={() => document.getElementById('menu-login')?.click()}>{t('friends_sign_in_action')}</button></div>}
      {(management?.signedIn || runtime?.signedIn) && <>
        {requests.length > 0 && <section className={styles.section}><h2 className={styles.stickyHeading}>{t('friends_requests')} <span>{requests.length}</span></h2>{requests.map(row)}</section>}
            {management && <section className={styles.section}><h2 className={styles.stickyHeading}>{t('friends_list')} <span>{accepted.length}</span></h2>{accepted.length ? accepted.map(row) : <p className={styles.empty}>{t(search.trim() ? 'friends_no_results' : 'friends_empty')}</p>}</section>}
            {(!management || state.friendsError) && !!runtime?.templates.length && <section className={styles.section}><h2 className={styles.stickyHeading}>{t('friends_saved_authorizations')}</h2>{runtime.templates.map(template => <div className={styles.templateCard} key={template.id}>
              <strong>{friends.find(friend => friend.id === template.friendId)?.displayName || runtime.tasks.find(task => task.friendId === template.friendId)?.senderDisplayName || t('friends')}</strong>
              <GrantSummary grant={template.grant} /><button className="kls-btn kls-btn-secondary" disabled={busy || template.deviceId !== currentDeviceId} onClick={() => void revoke(template)}>{t('friends_revoke_saved_grant')}</button>
            </div>)}</section>}
      </>}
    </div>
    {adding && <AddFriendDialog runtime={runtime} onPickDirectory={pickDirectory} initialEmail={scannedEmail ?? undefined} onClose={() => { setAdding(false); setScannedEmail(null) }} onAdded={() => { setAdding(false); setScannedEmail(null); invalidateFriendMentions(); void controller.refresh() }} />}
    {myQr && <MyQrDialog onClose={() => setMyQr(false)} onSelfInvite={email => { setMyQr(false); setScannedEmail(email); setAdding(true) }} />}
    {scanning && <ScanAddDialog onClose={() => setScanning(false)} onFound={email => { setScanning(false); setScannedEmail(email); setAdding(true) }} />}
    {acceptingFriend && <FriendsDialog title={`${t('friends_accept')} · ${friendDisplayName(acceptingFriend)}`} closeDisabled={busy} onClose={() => setAcceptingId(null)} footer={<><button className="kls-btn kls-btn-secondary" disabled={busy} onClick={() => setAcceptingId(null)}>{t('friends_cancel')}</button><button className="kls-btn kls-btn-primary" disabled={busy} onClick={() => void (async () => {
      const friend = acceptingFriend
      if (friend.status !== 'accepted' && !await manage(`accept:${friend.id}`, () => window.klaus.friends.respond({ friendId: friend.id, accept: true, allowIncomingAgentTasks: acceptChoice !== 'off' }))) return
      if (acceptChoice !== 'off' && runtime && currentDeviceId && acceptChoice !== (runtime.defaultGrant.policy ?? 'approve')) {
        if (!await operate(`template:${friend.id}`, () => window.klaus.friends.saveTemplate({ friendId: friend.id, deviceId: currentDeviceId, grant: { ...runtime.defaultGrant, deviceId: currentDeviceId, policy: acceptChoice, remember: true } }))) return
      }
      setAcceptingId(null)
    })()}>{t('friends_accept')}</button></>}><div className={styles.profileResult}><FriendAvatar large name={friendDisplayName(acceptingFriend)} url={acceptingFriend.avatarUrl} /><div><strong>{friendDisplayName(acceptingFriend)}</strong>{'email' in acceptingFriend && typeof acceptingFriend.email === 'string' && <p>{acceptingFriend.email}</p>}</div><span className={styles.accountBadge}>{t('friends_klaus_account')}</span></div><ReceiveChoiceRow value={acceptChoice} disabled={busy} onChange={setAcceptChoice} />{state.actionError && <p className={styles.formError} role="alert">{state.actionError}</p>}</FriendsDialog>}
    {settingsFriend && <FriendsDialog wide title={`${friendDisplayName(settingsFriend)} · ${t('friends_settings')}`} closeDisabled={busy || settingsSaving} onClose={() => setSettingsId(null)} footer={<>
      <button className="kls-btn kls-btn-secondary" disabled={busy || settingsSaving} onClick={() => setSettingsId(null)}>{t('friends_cancel')}</button>
      <button className="kls-btn kls-btn-primary" disabled={busy || settingsSaving || settingsAllowed && !grantReady || !(remarkChanged || receivingChanged || confirmChanged || grantReady)} onClick={() => void saveSettings()}>{t(settingsSaving ? 'friends_saving' : 'friends_save')}</button>
    </>}>
      <div className={styles.profileResult}><FriendAvatar large name={friendDisplayName(settingsFriend)} url={settingsFriend.avatarUrl} /><strong>{friendDisplayName(settingsFriend)}</strong></div>
      <div className={styles.settingsSection}><h3>{t('friends_remark')}</h3>
        <div className={styles.lookupFields}><input id="friends-remark" aria-label={t('friends_remark')} disabled={busy || settingsSaving} maxLength={200} value={remarkDraft ?? ''} placeholder={t('friends_remark_placeholder')} onChange={event => setRemarkDraft(event.target.value)} /></div>
        <p className={styles.muted}>{t('friends_remark_hint')}</p>
      </div>
      <div className={styles.settingsSection} data-friend-agent-confirmation><h3>{t('friends_section_agent_messages')}</h3>
        <PrefToggleRow id="friends-confirm-agent-messages" label={t('friends_confirm_agent_messages')} desc={t('friends_confirm_agent_messages_hint')}
          checked={confirmDraft} disabled={busy || settingsSaving} onChange={setConfirmDraft} />
      </div>
      <div className={styles.settingsSection}><h3>{t('friends_permission_single')}</h3>
        {settingsGrant && settingsApps ? <GrantEditor receiving={settingsAllowed} onReceivingChange={setSettingsAllowed} draft={settingsGrant} apps={settingsApps} disabled={busy || settingsSaving} sharedRoot={friendSharedRoot(runtime?.friendFilesRoot, settingsFriend.id)} targets={runtime?.executionTargets} onPickDirectory={pickDirectory} onChange={next => setSettingsGrant(value => value ? next(value) : value)} /> : <p className={styles.muted}>{t('friends_apps_loading')}</p>}
        {settingsAllowed && settingsGrantError && <p className={styles.formError} role="alert">{settingsGrantError}</p>}
      </div>
      <div className={`${styles.settingsSection} ${styles.dangerSection}`}><h3>{t('friends_relationship')}</h3><p>{t('friends_delete_explanation')}</p><button className="kls-btn kls-btn-ghost" disabled={busy || settingsSaving} onClick={() => void remove(settingsFriend)}>{t('friends_remove')}</button></div>
      {(state.actionError || dialogError) && <p className={styles.formError} role="alert">{state.actionError || dialogError}</p>}
    </FriendsDialog>}
  </>
}
