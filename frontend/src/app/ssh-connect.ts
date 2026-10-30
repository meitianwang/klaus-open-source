// Klaus Desktop — "Connect SSH" modal for the project picker.
//
// The flow: pick/enter a host → connect (password
// and passphrase prompts bridged from ssh via SSH_ASKPASS into an in-modal
// dialog) → browse remote directories → bind the chosen directory as an
// ssh:// remote project. All ssh work happens in the main process
// (window.klaus.ssh); this file is pure UI. Resolves { workdir, label } or
// null on cancel.
//（迁自 js/ssh-connect.js，逻辑原样。）
import { icon } from '../icons/registry'
import { statusDotHtml } from '../components/StatusDot'

const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c])
const tt = (k: string): string => ((window as any).tt ? (window as any).tt(k) : k)

// Path-fill glyphs (fill:currentColor, hollow silhouettes) — matches the
// sidebar icon technique; stroke sketches read too thin next to them.
const ICONS = {
  server: icon('server'),
  folder: icon('folder'),
  chevron: icon('chevron'),
  up: icon('up'),
  home: icon('home'),
  lock: icon('lock'),
}

;(window as any).openSshConnectModal = function openSshConnectModal(): Promise<{ workdir: string; label: string } | null> {
  const api = (window as any).klaus?.ssh
  if (!api) return Promise.resolve(null)

  return new Promise((resolve) => {
    let settled = false
    let target = ''       // validated user@host[:port] once connected
    let remoteHome = ''   // $HOME reported by the connect probe
    let currentPath = ''  // remote path shown in the browser step
    let browseSeq = 0     // stale async guard for directory listings
    let unsubscribeAskpass: (() => void) | null = null
    let pendingAskpassId: string | null = null

    const overlay = document.createElement('div')
    overlay.className = 'kls-modal-overlay'
    overlay.innerHTML = `
      <div class="kls-modal ssh-modal">
        <div class="ssh-head">
          <span class="ssh-head-badge" aria-hidden="true">${ICONS.server}</span>
          <div class="ssh-head-text">
            <h3 class="ssh-head-title">${esc(tt('ssh_modal_title'))}</h3>
            <p class="ssh-head-subtitle" id="ssh-subtitle">${esc(tt('ssh_modal_subtitle'))}</p>
          </div>
          <button class="kls-modal-close" data-close aria-label="close">
            ${icon('close', { size: 18 })}
          </button>
        </div>
        <div class="ssh-body" id="ssh-body"></div>
        <div class="ssh-askpass-layer" id="ssh-askpass" hidden></div>
      </div>`
    document.body.appendChild(overlay)

    const body = overlay.querySelector<HTMLElement>('#ssh-body')!
    const subtitle = overlay.querySelector<HTMLElement>('#ssh-subtitle')!
    const askpassLayer = overlay.querySelector<HTMLElement>('#ssh-askpass')!

    const close = (result: { workdir: string; label: string } | null) => {
      if (settled) return
      settled = true
      answerAskpass(null)
      unsubscribeAskpass?.()
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(result)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      // Esc closes the password layer first, then the modal.
      if (!askpassLayer.hidden) answerAskpass(null)
      else close(null)
    }
    document.addEventListener('keydown', onKey, true)
    overlay.querySelector('[data-close]')!.addEventListener('click', () => close(null))
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null) })

    // --- Password bridge (SSH_ASKPASS → in-modal dialog) --------------------
    function answerAskpass(password: string | null) {
      if (!pendingAskpassId) return
      const id = pendingAskpassId
      pendingAskpassId = null
      askpassLayer.hidden = true
      askpassLayer.innerHTML = ''
      api.answerAskpass(id, password).catch(() => {})
    }

    function showAskpass({ requestId, prompt, echo }: { requestId: string; prompt?: string; echo?: boolean }) {
      // A newer prompt supersedes an unanswered one (cancel the old attempt).
      if (pendingAskpassId) answerAskpass(null)
      pendingAskpassId = requestId
      askpassLayer.hidden = false
      askpassLayer.innerHTML = `
        <div class="ssh-askpass-card" role="dialog" aria-modal="true" aria-label="${esc(tt('ssh_askpass_title'))}">
          <div class="ssh-askpass-head">
            <span class="ssh-askpass-icon" aria-hidden="true">${ICONS.lock}</span>
            <div class="ssh-askpass-titles">
              <div class="ssh-askpass-title">${esc(tt('ssh_askpass_title'))}</div>
              <div class="ssh-askpass-msg">${esc(tt(echo ? 'ssh_challenge_msg' : 'ssh_askpass_msg'))}</div>
            </div>
          </div>
          <div class="ssh-detail-block">${esc(prompt || '')}</div>
          <input type="${echo ? 'text' : 'password'}" class="ssh-input ssh-askpass-input" placeholder="${esc(tt(echo ? 'ssh_challenge_placeholder' : 'ssh_askpass_placeholder'))}" autocomplete="off">
          <div class="ssh-foot">
            <button type="button" class="ssh-btn" data-ap-cancel>${esc(tt('cancel'))}</button>
            <button type="button" class="ssh-btn ssh-btn-primary" data-ap-ok>${esc(tt('ssh_askpass_ok'))}</button>
          </div>
        </div>`
      const input = askpassLayer.querySelector<HTMLInputElement>('.ssh-askpass-input')!
      const submit = () => answerAskpass(input.value)
      askpassLayer.querySelector('[data-ap-ok]')!.addEventListener('click', submit)
      askpassLayer.querySelector('[data-ap-cancel]')!.addEventListener('click', () => answerAskpass(null))
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit() }
      })
      setTimeout(() => input.focus(), 0)
    }
    unsubscribeAskpass = api.onAskpass?.((payload: any) => { if (!settled) showAskpass(payload) }) || null

    // --- Shared error block (human line + de-emphasized raw detail) --------
    function errorBlockHtml(titleKey: string, msgKey: string) {
      return `
        <div class="ssh-error" id="ssh-error" hidden>
          <div class="ssh-error-title">${esc(tt(titleKey))}</div>
          <div class="ssh-error-msg">${esc(tt(msgKey))}</div>
          <div class="ssh-detail-block" id="ssh-error-detail"></div>
        </div>`
    }
    function showError(detail: unknown) {
      const el = body.querySelector<HTMLElement>('#ssh-error')
      if (!el) return
      el.hidden = false
      const detailEl = el.querySelector<HTMLElement>('#ssh-error-detail')!
      detailEl.textContent = String(detail || '').trim()
      detailEl.hidden = !detailEl.textContent
    }
    function hideError() {
      const el = body.querySelector<HTMLElement>('#ssh-error')
      if (el) el.hidden = true
    }

    // --- Step 1: pick host + connect ---------------------------------------
    function renderConnectStep() {
      subtitle.textContent = tt('ssh_modal_subtitle')
      body.innerHTML = `
        <div class="ssh-step">
          <label class="ssh-field-label" for="ssh-target">${esc(tt('ssh_target_label'))}</label>
          <div class="ssh-input-wrap">
            <span class="ssh-input-icon" aria-hidden="true">${ICONS.server}</span>
            <input class="ssh-input ssh-input-mono" id="ssh-target" placeholder="${esc(tt('ssh_target_placeholder'))}" autocomplete="off" spellcheck="false">
          </div>
          <div class="ssh-field-hint">${esc(tt('ssh_target_hint'))}</div>
          <div class="ssh-hosts" id="ssh-hosts-field" hidden>
            <div class="ssh-section-label">${esc(tt('ssh_config_hosts'))}</div>
            <div class="ssh-host-list" id="ssh-hosts" role="listbox"></div>
          </div>
          ${errorBlockHtml('ssh_connect_failed', 'ssh_connect_failed_msg')}
          <div class="ssh-foot">
            <button type="button" class="ssh-btn ssh-btn-primary" id="ssh-connect">${esc(tt('ssh_connect'))}</button>
          </div>
        </div>`

      const input = body.querySelector<HTMLInputElement>('#ssh-target')!
      const connectBtn = body.querySelector<HTMLButtonElement>('#ssh-connect')!
      if (target) input.value = target

      // ~/.ssh/config aliases as one-click candidates (same source the
      // Qoder Quest window reads for its host list).
      api.listHosts().then(({ hosts }: { hosts?: string[] }) => {
        if (settled || !Array.isArray(hosts) || hosts.length === 0) return
        const field = body.querySelector<HTMLElement>('#ssh-hosts-field')
        const list = body.querySelector<HTMLElement>('#ssh-hosts')
        if (!field || !list) return
        field.hidden = false
        list.innerHTML = hosts.map(h => `
          <button type="button" class="ssh-row" role="option" data-host="${esc(h)}">
            <span class="ssh-row-icon" aria-hidden="true">${ICONS.server}</span>
            <span class="ssh-row-label">${esc(h)}</span>
            <span class="ssh-row-chevron" aria-hidden="true">${ICONS.chevron}</span>
          </button>`).join('')
        list.querySelectorAll('[data-host]').forEach(item => {
          item.addEventListener('click', () => {
            input.value = item.getAttribute('data-host') || ''
            connect()
          })
        })
      }).catch(() => {})

      const setBusy = (busy: boolean) => {
        connectBtn.disabled = busy
        connectBtn.innerHTML = busy
          ? `<span class="ssh-spinner" aria-hidden="true"></span>${esc(tt('ssh_connecting'))}`
          : esc(tt('ssh_connect'))
        body.querySelectorAll<HTMLButtonElement>('.ssh-row').forEach(row => { row.disabled = busy })
      }

      const connect = async () => {
        const value = input.value.trim()
        if (!value) { input.focus(); return }
        hideError()
        setBusy(true)
        try {
          const res = await api.test(value)
          if (settled) return
          if (!res?.ok) {
            showError(res?.error)
            setBusy(false)
            return
          }
          target = value
          remoteHome = res.home || '/'
          currentPath = remoteHome
          renderBrowseStep()
        } catch (err: any) {
          if (settled) return
          showError(err?.message || err)
          setBusy(false)
        }
      }

      connectBtn.addEventListener('click', connect)
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connect() } })
      setTimeout(() => input.focus(), 0)
    }

    // --- Step 2: browse remote directories ---------------------------------
    function renderBrowseStep() {
      subtitle.textContent = tt('ssh_pick_dir_subtitle')
      body.innerHTML = `
        <div class="ssh-step">
          <div class="ssh-conn-chip">
            ${statusDotHtml('ok')}
            <span class="ssh-conn-target">${esc(target)}</span>
            <span class="ssh-conn-state">${esc(tt('ssh_connected'))}</span>
          </div>
          <div class="ssh-crumbs" id="ssh-crumbs"></div>
          <div class="ssh-dir-list" id="ssh-dirs" role="listbox"></div>
          ${errorBlockHtml('ssh_browse_failed', 'ssh_browse_failed_msg')}
          <div class="ssh-foot ssh-foot-split">
            <button type="button" class="ssh-btn" id="ssh-back">${esc(tt('ssh_back'))}</button>
            <button type="button" class="ssh-btn ssh-btn-primary" id="ssh-use-dir">${esc(tt('ssh_use_this_dir'))}</button>
          </div>
        </div>`

      body.querySelector('#ssh-back')!.addEventListener('click', () => renderConnectStep())
      body.querySelector('#ssh-use-dir')!.addEventListener('click', async () => {
        const btn = body.querySelector<HTMLButtonElement>('#ssh-use-dir')!
        btn.disabled = true
        hideError()
        try {
          const res = await api.makeWorkdir(target, currentPath)
          if (settled) return
          if (res?.workdir) close({ workdir: res.workdir, label: res.label || '' })
          else { showError(res?.error || 'invalid directory'); btn.disabled = false }
        } catch (err: any) {
          if (settled) return
          showError(err?.message || String(err))
          btn.disabled = false
        }
      })
      loadDirs(currentPath)
    }

    function renderCrumbs(path: string) {
      const crumbsEl = body.querySelector<HTMLElement>('#ssh-crumbs')
      if (!crumbsEl) return
      const parts = path.split('/').filter(Boolean)
      let html = `
        <button type="button" class="ssh-crumb ssh-crumb-icon" data-crumb="${esc(remoteHome || '/')}" title="${esc(tt('ssh_home'))}" aria-label="${esc(tt('ssh_home'))}">${ICONS.home}</button>
        <button type="button" class="ssh-crumb" data-crumb="/">/</button>`
      let acc = ''
      for (const part of parts) {
        acc += `/${part}`
        html += `
          <span class="ssh-crumb-sep" aria-hidden="true">${ICONS.chevron}</span>
          <button type="button" class="ssh-crumb" data-crumb="${esc(acc)}">${esc(part)}</button>`
      }
      crumbsEl.innerHTML = html
      crumbsEl.querySelectorAll('[data-crumb]').forEach(item => {
        item.addEventListener('click', () => loadDirs(item.getAttribute('data-crumb') || '/'))
      })
      crumbsEl.scrollLeft = crumbsEl.scrollWidth
    }

    function skeletonHtml() {
      return Array.from({ length: 6 }, () => `
        <div class="ssh-skeleton-row" aria-hidden="true">
          <span class="ssh-skeleton-icon"></span>
          <span class="ssh-skeleton-bar"></span>
        </div>`).join('')
    }

    async function loadDirs(path: string) {
      const seq = ++browseSeq
      const listEl = body.querySelector<HTMLElement>('#ssh-dirs')
      if (!listEl) return
      renderCrumbs(path)
      listEl.innerHTML = skeletonHtml()
      hideError()
      try {
        const res = await api.listDirs(target, path)
        if (settled || seq !== browseSeq) return
        if (!res?.ok) {
          listEl.innerHTML = ''
          showError(res?.error)
          return
        }
        currentPath = res.path || path
        renderCrumbs(currentPath)
        const atRoot = currentPath === '/'
        const upRow = atRoot ? '' : `
          <button type="button" class="ssh-row ssh-row-up" role="option" data-dir="..">
            <span class="ssh-row-icon" aria-hidden="true">${ICONS.up}</span>
            <span class="ssh-row-label">..</span>
          </button>`
        const rows = ((res.dirs || []) as string[]).map(name => `
          <button type="button" class="ssh-row" role="option" data-dir="${esc(name)}">
            <span class="ssh-row-icon" aria-hidden="true">${ICONS.folder}</span>
            <span class="ssh-row-label">${esc(name)}</span>
            <span class="ssh-row-chevron" aria-hidden="true">${ICONS.chevron}</span>
          </button>`).join('')
        listEl.innerHTML = rows
          ? upRow + rows
          : upRow + `
            <div class="ssh-empty">
              <span class="ssh-empty-icon" aria-hidden="true">${ICONS.folder}</span>
              <span>${esc(tt('ssh_dir_empty'))}</span>
            </div>`
        listEl.querySelectorAll('[data-dir]').forEach(item => {
          item.addEventListener('click', () => {
            const name = item.getAttribute('data-dir')
            const base = currentPath.replace(/\/+$/, '')
            const next = name === '..'
              ? (base.slice(0, base.lastIndexOf('/')) || '/')
              : `${base}/${name}`
            loadDirs(next)
          })
        })
      } catch (err: any) {
        if (settled || seq !== browseSeq) return
        listEl.innerHTML = ''
        showError(err?.message || String(err))
      }
    }

    renderConnectStep()
  })
}

export {}
