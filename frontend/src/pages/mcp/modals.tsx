// 连接器页弹窗族：条目类弹窗（市场四态、已装服务详情、项目服务详情、内置连接器
// 组、电脑操控）全部长在同一张外壳 `EntryModal` 上——点开任何条目弹出来的都是同
// 一张卡，只有内容区按条目类型不同。表单类（手动添加、JSON 导入）不套那张卡。
import { useEffect, useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useT, t as tGlobal } from '../../i18n'
import { icon, strokeGlyph24 } from '../../icons/registry'
import { rawIconHtml } from '../../components/Icon'
import { MCP_GENERIC_SERVER_ICON } from '../../components/McpEntry'
import { StatusDot } from '../../components/StatusDot'
import { escHtml } from '../../components/mcpDetailShell'
import {
  UV_INSTALL_COMMAND, authorizeMcpServer, classifyMcpFailure, computeMarketEntryState, connectorIcon,
  ensureConnectorEnablePreflight, forgetPendingConnectorEnable, mcpAuthOk, mcpAuthStatus, mcpLocalizedText,
  mcpServerTargetString, mcpStatusDot, probeMarketStatus, reloadMcpView, showToast, startMcpDiagnoseChat,
} from './data'
import type { ConnectorItem, ConnectorTool, McpBuiltinEntry, McpServer, McpStatus } from './data'
import type { ProjectMcpServer } from './project-status'
import { EntryAction, EntryMetaGrid, EntryModal, EntryPoints, EntryToolsList } from './entry-modal'
import type { EntryModalState } from './entry-modal'
import { buildMcpServerConfig, formatMcpCommandLine } from './server-form'
import styles from './mcp.module.css'
import { readClipboardText, writeClipboardText } from '../../clipboard'

const w = () => window as any

function actionError(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || '').trim()
    if (message) return message
  }
  return typeof error === 'string' && error.trim() ? error : fallback
}

function requireActionOk(result: any, fallback: string, allowVoid = false): void {
  if (allowVoid && result == null) return
  if (result?.ok !== true) throw new Error(result?.error || fallback)
}

function useFormDialog(onClose: () => void, initialFocus: RefObject<HTMLElement | null>) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    initialFocus.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hidden && element.getClientRects().length > 0)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [])
  return dialogRef
}

// ==================== 失败告警块 ====================

/** 失败告警块（React 版，条目详情/市场弹窗共用）：状态词 + 归类后的人话结论，
 * 不摆原始技术串（那是诊断证据包的事）；uvx 类服务可选内联 uv 安装指引。 */
function McpErrorBlock({ error, showUvHint }: { error: unknown; showUvHint: boolean }) {
  const t = useT()
  return (
    <div className="mcp-detail-error">
      <div className="mcp-detail-error-title">{t('mcp_detail_error_title')}</div>
      <div className="mcp-detail-error-text">{t(classifyMcpFailure(error))}</div>
      {showUvHint && (
        <div className={styles['mcp-error-uv-hint']}>
          {t('mcp_uv_missing_line')}
          <div className={styles['mcp-uv-cmd-row']}>
            <code className={styles['mcp-uv-cmd']}>{UV_INSTALL_COMMAND}</code>
            <button
              className="btn-xs"
              onClick={(e) => {
                e.stopPropagation()
                writeClipboardText(UV_INSTALL_COMMAND).then(() => showToast(t('mcp_uv_cmd_copied'))).catch(() => showToast(t('copy_failed')))
              }}
            >{t('mcp_uv_copy_cmd')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== DOM 壳详情弹窗 ====================

export interface ServerDetailContext {
  server: McpServer
  status?: McpStatus
  statusReady: boolean
  catalog: McpBuiltinEntry | null
  uvMissing: boolean
  servers: McpServer[]
}

/**
 * server 详情弹窗（点已安装的服务卡弹出）。外壳与市场/能力弹窗同一张（EntryModal），
 * 内容区是这个条目自己的事实：出错了的告警块、Type/Target、工具明细（含每
 * 个工具的三档控件）；授权/重试/诊断/重置 按需才出现在底部。
 *
 * 这里以前是一张 480px 的单砖 DOM 字符串弹窗（openMcpDetailShell），同一页里点
 * 市场条目与点已安装条目会弹出两种不同形状的东西。
 */
export function McpServerDetailModal({ ctx, onClose }: { ctx: ServerDetailContext; onClose: () => void }) {
  const t = useT()
  const { server, status, catalog } = ctx
  const catalogText = catalog ? mcpLocalizedText(catalog) : null
  const cfg = server.config || {}
  const type = cfg.type || 'stdio'
  const detail = type === 'stdio'
    ? formatMcpCommandLine(cfg.command || '', cfg.args || [])
    : cfg.url || ''
  const disabled = !server.enabled
  const toolCount = status?.toolCount ?? 0
  const hasError = !disabled && (status?.status === 'failed' || !!status?.error)
  const connected = !disabled && status?.status === 'connected'
  const checking = !disabled && !ctx.statusReady
  const isOauth = type === 'sse' || type === 'http'
  const klausNeedsAuth = !!status?.klausNeedsAuth
  const uvFailed = !!catalog?.needsUv && ctx.uvMissing && status?.status === 'failed'
  const [busy, setBusy] = useState(false)

  const closeAndReload = () => { onClose(); reloadMcpView() }

  // 本页只列用户自建/市场装的 server，per-tool 开关写进这条 server 自己的
  // disabledTools；插件贡献的 MCP 不在本页出现，启停归插件页。
  const toolToggleServer = server.name
  const state: EntryModalState = disabled ? 'off' : hasError ? 'failed' : connected ? 'on' : 'checking'
  const title = disabled
    ? t('mcp_state_off_title').replace('{name}', catalogText?.name || server.name)
    : hasError
      ? t('mcp_state_failed_title').replace('{name}', catalogText?.name || server.name)
      : connected
        ? t('mcp_state_on_title').replace('{name}', catalogText?.name || server.name)
        : checking
          ? t('mcp_state_checking_title').replace('{name}', catalogText?.name || server.name)
          : catalogText?.name || server.name

  return (
    <EntryModal
      entryIconHtml={connectorIcon(server.name) || strokeGlyph24(catalog?.iconSvg || MCP_GENERIC_SERVER_ICON, 24)}
      state={state}
      title={title}
      {...(catalogText?.desc ? { desc: catalogText.desc } : {})}
      onClose={onClose}
      closeDisabled={busy}
      actions={
        <>
          {klausNeedsAuth ? (
            <EntryAction disabled={busy} onClick={async () => {
              setBusy(true)
              try {
                const st = await authorizeMcpServer(server.name)
                if (st === null) return
                if (mcpAuthOk(st)) {
                  const result = await w().klaus.mcp.toggle(server.name, true)
                  requireActionOk(result, t('settings_failed'))
                }
                closeAndReload()
              } catch (error) {
                showToast(actionError(error, t('settings_failed')))
              } finally {
                setBusy(false)
              }
            }}>{t('mcp_authorize')}</EntryAction>
          ) : null}
          {hasError ? (
            <>
              <EntryAction disabled={busy} onClick={async () => {
                setBusy(true)
                try {
                  const result = await w().klaus.mcp.reconnect()
                  requireActionOk(result, t('settings_failed'), true)
                  closeAndReload()
                } catch (error) {
                  showToast(actionError(error, t('settings_failed')))
                } finally {
                  setBusy(false)
                }
              }}>{t('mcp_retry')}</EntryAction>
              <EntryAction kind="secondary" disabled={busy} onClick={() => {
                void startMcpDiagnoseChat(catalogText?.name || server.name, server.name, status?.error, {
                  targetString: mcpServerTargetString(ctx.servers, server.name),
                  closeModals: onClose,
                })
              }}>{t('mcp_diagnose')}</EntryAction>
            </>
          ) : null}
          {isOauth && !klausNeedsAuth ? (
            <EntryAction kind="secondary" disabled={busy} onClick={async () => {
              if (!(await w().klausDialog.confirm(t('mcp_reset_confirm')))) return
              setBusy(true)
              try {
                const result = await w().klaus.mcp.revokeAuth(server.name)
                requireActionOk(result, t('settings_failed'))
                showToast(t('mcp_reset_done'))
                closeAndReload()
              } catch (error) {
                showToast(actionError(error, t('settings_failed')))
              } finally {
                setBusy(false)
              }
            }}>{t('mcp_reset')}</EntryAction>
          ) : null}
        </>
      }
    >
      {hasError ? (
        <div className={styles['mcp-state-error']}>
          <McpErrorBlock error={status?.error} showUvHint={uvFailed} />
        </div>
      ) : null}
      <EntryMetaGrid rows={[
        { label: 'Type', value: type.toUpperCase() },
        { label: 'Target', value: detail, mono: true },
      ]} />
      {state === 'checking' ? (
        <div className={styles['mcp-state-status']} role="status">{checking ? t('mcp_connecting') : t('mcp_status_unavailable')}</div>
      ) : hasError ? null : (
        <EntryToolsList
          {...(status?.tools ? { tools: status.tools } : {})}
          toolCount={toolCount}
          {...(toolToggleServer ? { toggleServer: toolToggleServer } : {})}
          onChanged={closeAndReload}
        />
      )}
    </EntryModal>
  )
}

/** Project declarations have no borrowed global runtime status. */
export function McpProjectDetailModal({ server, onClose }: { server: ProjectMcpServer; onClose: () => void }) {
  const t = useT()
  const scope = server.scope === 'local' ? t('mcp_scope_local') : t('mcp_scope_project')
  const transport = String(server.transport || 'stdio').toUpperCase()
  const enabled = server.enabled !== false
  return (
    <EntryModal
      entryIconHtml={strokeGlyph24(MCP_GENERIC_SERVER_ICON, 24)}
      state={enabled ? 'checking' : 'off'}
      title={server.name}
      desc={`${scope} · ${transport}`}
      onClose={onClose}
    >
      <EntryMetaGrid rows={[
        { label: t('mcp_field_scope'), value: scope },
        { label: t('mcp_field_type'), value: transport },
      ]} />
      <div className={styles['mcp-state-status']} role="status">{enabled ? t('mcp_project_declared_status') : t('disabled')}</div>
    </EntryModal>
  )
}

// ==================== 手动添加/编辑表单弹窗 ====================

export function McpEditModal({ existing, onClose }: {
  existing: McpServer | null
  onClose: () => void
}) {
  const t = useT()
  const isEdit = !!existing
  const cfg = existing?.config || {}
  const initialType = cfg.type || 'stdio'
  const cmdStr = initialType === 'stdio'
    ? formatMcpCommandLine(cfg.command || '', cfg.args || [])
    : ''
  const [type, setType] = useState(initialType)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [envRows, setEnvRows] = useState<Array<{ k: string; v: string }>>(
    () => Object.entries(cfg.env || {}).map(([k, v]) => ({ k, v: String(v) })),
  )
  const typeHostRef = useRef<HTMLDivElement>(null)
  const typeSelRef = useRef<any>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const cmdRef = useRef<HTMLTextAreaElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const timeoutRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const errorId = useId()
  const dialogRef = useFormDialog(() => { if (!busy) onClose() }, nameRef)

  useEffect(() => {
    if (!typeHostRef.current) return
    typeSelRef.current = w().klsSelect.bind(typeHostRef.current, {
      items: [
        { value: 'stdio', label: 'STDIO' },
        { value: 'sse',   label: 'SSE' },
        { value: 'http',  label: 'HTTP' },
      ],
      value: type,
      disabled: isEdit || busy,
      onChange: (v: string) => setType(v),
    })
    return () => { typeSelRef.current?.destroy?.() }
  }, [busy, isEdit, type])

  const pasteEnv = async () => {
    try {
      const text = await readClipboardText()
      const parsed: Array<{ k: string; v: string }> = []
      text.trim().split('\n').forEach(line => {
        const eq = line.indexOf('=')
        if (eq > 0) parsed.push({ k: line.slice(0, eq).trim(), v: line.slice(eq + 1).trim() })
      })
      if (parsed.length) setEnvRows(rows => [...rows, ...parsed])
    } catch {
      showToast(t('clipboard_read_failed'))
    }
  }

  const submit = async () => {
    if (busy) return
    setError('')
    const name = nameRef.current?.value.trim() || ''
    if (!name) {
      const message = t('settings_mcp_name_required')
      setError(message); showToast(message); nameRef.current?.focus(); return
    }
    const ty = typeSelRef.current?.getValue?.() || type
    const built = buildMcpServerConfig(cfg as Record<string, unknown>, {
      type: ty,
      commandLine: cmdRef.current?.value || '',
      url: urlRef.current?.value || '',
      env: envRows.map(row => ({ key: row.k, value: row.v })),
      timeout: timeoutRef.current?.value || '',
      alwaysLoad: !!(document.getElementById('mcpm-always-load') as HTMLInputElement | null)?.checked,
    })
    if (!built.ok) {
      const message = t(built.field === 'command' ? 'mcp_field_command_required' : 'mcp_field_url_required')
      setError(message); showToast(message); (built.field === 'command' ? cmdRef.current : urlRef.current)?.focus(); return
    }
    const newCfg = built.config

    setBusy(true)
    try {
      const result = isEdit
        ? await w().klaus.mcp.update(name, newCfg)
        : await w().klaus.mcp.create({ name, ...newCfg })
      if (result?.ok !== true) throw new Error(result?.error || t('settings_failed'))
      showToast(t('settings_saved') || 'Saved')
      onClose()
      reloadMcpView()
    } catch (cause) {
      const message = actionError(cause, t('settings_failed'))
      setError(message)
      showToast(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kls-modal-overlay" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div
        ref={dialogRef}
        className={`kls-modal ${styles['mcp-form-modal']}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(error ? { 'aria-describedby': errorId } : {})}
      >
        <div className="kls-modal-head">
          <div>
            <h3 className="kls-modal-title" id={titleId}>{isEdit ? t('mcp_edit_title') : t('mcp_add_modal_title')}</h3>
            {isEdit ? null : <p className="kls-modal-subtitle">{t('mcp_add_modal_subtitle')}</p>}
          </div>
          <button
            className="kls-modal-close" aria-label={t('cancel')} onClick={onClose} disabled={busy}
            dangerouslySetInnerHTML={{ __html: rawIconHtml('close', { size: 18 }) }}
          />
        </div>
        <div className="kls-modal-body">
          <div className="kls-field">
            <label className="kls-field-label">{t('mcp_field_type')}</label>
            <div id="mcpm-type" className="kls-select kls-select-block" ref={typeHostRef} />
          </div>
          <div className="kls-field">
            <label className="kls-field-label">{t('mcp_field_name')} <span className="kls-required">*</span></label>
            <input className="kls-input" id="mcpm-name" placeholder={t('mcp_field_name_placeholder')} defaultValue={existing?.name || ''} readOnly={isEdit} disabled={busy} ref={nameRef} />
          </div>
          <div className="kls-field" id="mcpm-cmd-wrap" hidden={type !== 'stdio'}>
            <label className="kls-field-label">{t('mcp_field_command')} <span className="kls-required">*</span></label>
            <textarea className="kls-input kls-input-area" id="mcpm-cmd" rows={2} placeholder="npx -y @modelcontextprotocol/server-filesystem" defaultValue={cmdStr} disabled={busy} ref={cmdRef} />
            <div className="kls-field-hint">{t('mcp_field_command_hint')}</div>
          </div>
          <div className="kls-field" id="mcpm-url-wrap" hidden={type === 'stdio'}>
            <label className="kls-field-label">{t('mcp_field_url')} <span className="kls-required">*</span></label>
            <input className="kls-input" id="mcpm-url" placeholder="https://..." defaultValue={cfg.url || ''} disabled={busy} ref={urlRef} />
          </div>
          <div className="kls-field">
            <label className="kls-field-label kls-field-label-row">
              <span>{t('mcp_field_env')} <span className="kls-field-optional">{t('mcp_field_env_optional')}</span></span>
              <button type="button" className="kls-field-inline-btn" id="mcpm-env-paste" disabled={busy} onClick={() => { void pasteEnv() }}>{t('mcp_field_env_paste')}</button>
            </label>
            <div id="mcpm-env-rows">
              {envRows.map((row, i) => (
                <div className="mcp-env-row" key={i}>
                  <input className="kls-input" placeholder="KEY" value={row.k} data-ek disabled={busy} onChange={e => setEnvRows(rows => rows.map((r, j) => j === i ? { ...r, k: e.target.value } : r))} />
                  <input className="kls-input" placeholder="value" value={row.v} data-ev disabled={busy} onChange={e => setEnvRows(rows => rows.map((r, j) => j === i ? { ...r, v: e.target.value } : r))} />
                  <button
                    type="button" className="mcp-env-del" aria-label={t('remove')}
                    disabled={busy}
                    onClick={() => setEnvRows(rows => rows.filter((_, j) => j !== i))}
                    dangerouslySetInnerHTML={{ __html: rawIconHtml('close', { size: 14 }) }}
                  />
                </div>
              ))}
            </div>
            <button type="button" className="kls-field-add-btn" id="mcpm-env-add" disabled={busy} onClick={() => setEnvRows(rows => [...rows, { k: '', v: '' }])}>{t('mcp_field_env_add')}</button>
          </div>
          <div className="kls-field">
            <label className="kls-field-label">{t('mcp_field_timeout')} <span className="kls-field-optional">{t('mcp_field_timeout_optional')}</span></label>
            <input className="kls-input" id="mcpm-timeout" type="number" placeholder="60" defaultValue={cfg.timeout ? String(cfg.timeout) : ''} disabled={busy} ref={timeoutRef} />
          </div>
          <div className="kls-field">
            <label className="kls-field-label">{t('mcp_field_always_load')} <span className="kls-field-optional">{t('mcp_field_always_load_optional')}</span></label>
            <label className="kls-checkbox"><input type="checkbox" id="mcpm-always-load" defaultChecked={cfg.alwaysLoad === true} disabled={busy} /> {t('mcp_field_always_load_hint')}</label>
          </div>
        </div>
        {error ? <div className={styles['mcp-form-error']} id={errorId} role="alert">{error}</div> : null}
        <div className="kls-modal-foot">
          <button className="kls-submit-btn" id="mcpm-submit" disabled={busy} onClick={() => { void submit() }}>{isEdit ? t('mcp_save_submit') : t('mcp_add_submit')}</button>
        </div>
      </div>
    </div>
  )
}

// ==================== JSON 导入弹窗 ====================

export function McpJsonModal({ onClose }: { onClose: () => void }) {
  const t = useT()
  const jsonRef = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleId = useId()
  const errorId = useId()
  const dialogRef = useFormDialog(() => { if (!busy) onClose() }, jsonRef)

  const submit = async () => {
    if (busy) return
    setError('')
    const raw = jsonRef.current?.value.trim() || ''
    if (!raw) {
      const message = t('mcp_import_nothing')
      setError(message); showToast(message); jsonRef.current?.focus(); return
    }
    setBusy(true)
    try {
      const result = await w().klaus.mcp.importJson(raw)
      const imported = Array.isArray(result?.imported) ? result.imported : []
      const errors = Array.isArray(result?.errors) ? result.errors.map(String).filter(Boolean) : []
      if (imported.length) {
        showToast((t('settings_mcp_imported') || 'Imported') + ': ' + imported.join(', '))
        reloadMcpView()
      }
      if (result?.ok !== true || errors.length) {
        const message = errors.join('; ') || result?.error || t('settings_mcp_import_failed')
        setError(message)
        showToast(message)
        return
      }
      onClose()
    } catch (cause) {
      const message = actionError(cause, t('settings_mcp_import_failed'))
      setError(message)
      showToast(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kls-modal-overlay" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div
        ref={dialogRef}
        className={`kls-modal ${styles['mcp-form-modal']}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(error ? { 'aria-describedby': errorId } : {})}
      >
        <div className="kls-modal-head">
          <div>
            <h3 className="kls-modal-title" id={titleId}>{t('mcp_json_modal_title')}</h3>
            <p className="kls-modal-subtitle">{t('mcp_json_modal_subtitle')}</p>
          </div>
          <button
            className="kls-modal-close" aria-label={t('cancel')} onClick={onClose} disabled={busy}
            dangerouslySetInnerHTML={{ __html: rawIconHtml('close', { size: 18 }) }}
          />
        </div>
        <div className="kls-modal-body">
          <textarea className={`kls-input ${styles['kls-input-json']}`} id="mcpm-json" rows={14} spellCheck={false} placeholder={t('mcp_json_placeholder')} disabled={busy} ref={jsonRef} />
        </div>
        {error ? <div className={styles['mcp-form-error']} id={errorId} role="alert">{error}</div> : null}
        <div className="kls-modal-foot">
          <button className="kls-submit-btn" id="mcpm-json-submit" disabled={busy} onClick={() => { void submit() }}>{t('mcp_json_submit')}</button>
        </div>
      </div>
    </div>
  )
}

// ==================== 连接器组详情弹窗 ====================

/**
 * 连接器行（renderMcpEntryRow 骨架 + renderConnectorRow 分流）：行尾控件
 * （已启用工具计数 + 开关）与展开体（读/写分组的 per-tool 复选框网格）。
 */
function ConnectorRow({ item, status, refresh }: {
  item: ConnectorItem
  status?: McpStatus
  refresh: () => Promise<void>
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  // currentLang lives in i18n.js (window global) — tool labels keep the zh/en pairs from the host
  const isZh = (typeof w().currentLang !== 'undefined' ? w().currentLang : 'en') === 'zh'
  const nameKey = `connectors_${item.id.replace(/-/g, '_')}_name`
  const descKey = `connectors_${item.id.replace(/-/g, '_')}_desc`
  const name = t(nameKey) !== nameKey
    ? t(nameKey)
    : (isZh ? item.nameZh || item.nameEn : item.nameEn || item.nameZh) || item.id
  const desc = t(descKey) !== descKey
    ? t(descKey)
    : (isZh ? item.descZh || item.descEn : item.descEn || item.descZh) || ''
  const total = item.tools.length
  const enabledCount = item.tools.filter(tool => tool.enabled).length
  const failed = !!item.enabled && (status?.status === 'failed' || !!status?.error)
  const expandable = !!item.enabled && total > 0
  // 连接器行的状态面是组弹窗自己拉回来的，开弹窗时已经就位，所以 statusReady 恒真；
  // 未启用不摆点（同全局档）。
  const dot = mcpStatusDot({ enabled: !!item.enabled, statusReady: true, ...(status ? { status } : {}) })

  const onToggle = async (enabled: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      const preflight = enabled ? await ensureConnectorEnablePreflight(item.id) : true
      if (enabled && preflight !== true) {
        if (preflight === 'enabled') {
          showToast(t('enabled'))
          reloadMcpView()
          await refresh()
        }
        return
      }
      if (!enabled) forgetPendingConnectorEnable(item.id)
      const result = await w().klaus.connectors.toggle(item.id, enabled)
      requireActionOk(result, t('settings_failed'))
      showToast(enabled ? t('enabled') : t('disabled'))
      reloadMcpView()
      await refresh()
    } catch (error) {
      showToast(actionError(error, t('settings_failed')))
    } finally {
      setBusy(false)
    }
  }

  // Three positions over two stores, same split as the MCP page: `off` is the
  // connector's own disabledTools, `ask` is a permission rule on the tool's full
  // `mcp__<server>__<tool>` name. Switching to `ask` also has to re-enable the
  // tool, or the rule would guard something that never runs.
  const onToolChange = async (tool: ConnectorTool, mode: string) => {
    if (busy) return
    setBusy(true)
    let enabledChanged = false
    const previousMode = tool.enabled === false ? 'off' : tool.approval === 'ask' ? 'ask' : 'auto'
    try {
      const result = await w().klaus.connectors.setToolEnabled(item.id, tool.name, mode !== 'off')
      requireActionOk(result, t('settings_failed'))
      enabledChanged = true
      const fullName = tool.fullName
      if (fullName) {
        const rule = mode === 'ask'
          ? await w().klaus.settings.permissions.add({ toolName: fullName, behavior: 'ask' })
          : await w().klaus.settings.permissions.delete({ toolName: fullName, behavior: 'ask' })
        requireActionOk(rule, t('settings_failed'))
      }
      await refresh()
    } catch (error) {
      if (enabledChanged) {
        await w().klaus.connectors.setToolEnabled(item.id, tool.name, previousMode !== 'off').catch(() => undefined)
      }
      showToast(actionError(error, t('settings_failed')))
      await refresh().catch((refreshError: unknown) => showToast(actionError(refreshError, t('mcp_load_failed'))))
    } finally {
      setBusy(false)
    }
  }

  const renderTool = (tool: ConnectorTool) => {
    const label = (isZh ? tool.labelZh || tool.labelEn : tool.labelEn || tool.labelZh) || tool.name
    const tip = (isZh ? tool.descZh || tool.descEn : tool.descEn || tool.descZh) || ''
    const mode = tool.enabled === false ? 'off' : tool.approval === 'ask' ? 'ask' : 'auto'
    return (
      <div className={styles['connector-tool-item']} {...(tip ? { title: tip } : {})} key={tool.name}>
        <span className={styles['connector-tool-label']}>{label}</span>
        <select
          className={`kls-select-native ${styles['connector-tool-mode']}`}
          value={mode}
          disabled={busy}
          aria-label={t('mcp_tool_approval_title')}
          onChange={(e) => { void onToolChange(tool, e.target.value) }}
        >
          <option value="auto">{t('mcp_tool_approval_auto')}</option>
          <option value="ask">{t('mcp_tool_approval_ask')}</option>
          <option value="off">{t('mcp_tool_approval_off')}</option>
        </select>
      </div>
    )
  }
  const readTools = item.tools.filter(tool => tool.readOnly)
  const writeTools = item.tools.filter(tool => !tool.readOnly)

  return (
    <div className="mcp-row" data-connector={item.id}>
      <div className={styles['mcp-row-main']}>
        {expandable ? (
          <button
            className={`${styles['mcp-expand-btn']} ${expanded ? styles['mcp-expand-open'] : ''}`}
            aria-expanded={expanded} aria-label={t(expanded ? 'mcp_collapse_tools' : 'mcp_expand_tools')}
            onClick={() => setExpanded(v => !v)}
            dangerouslySetInnerHTML={{ __html: rawIconHtml('chevron-right', { size: 12 }) }}
          />
        ) : <span className={styles['mcp-expand-placeholder']} />}
        <div className={styles['mcp-row-glyph']} dangerouslySetInnerHTML={{ __html: connectorIcon(item.id) || escHtml(item.icon) }} />
        <div className={`${styles['mcp-row-name']} ${styles['mcp-row-name-stacked']}`}>
          <div className={styles['mcp-name-row']}>
            <span className={styles['mcp-name-text']}>{name}</span>
            {dot && <StatusDot state={dot.state} label={dot.label} />}
          </div>
          <div className={styles['mcp-builtin-desc']}>{desc || '—'}</div>
        </div>
        <div className={styles['mcp-row-actions']}>
          {item.enabled && !failed ? (
            <span className={styles['mcp-tool-count']}>{t('connectors_tools_enabled_count').replace('{n}', String(enabledCount)).replace('{total}', String(total))}</span>
          ) : null}
          <label className="mcp-toggle" aria-label={item.enabled ? t('enabled') : t('disabled')}>
            <input type="checkbox" checked={!!item.enabled} disabled={busy} onChange={(e) => { void onToggle(e.target.checked) }} />
            <span className="mcp-toggle-slider" />
          </label>
        </div>
      </div>
      {expandable && (
        <div className={styles['mcp-row-expand']} hidden={!expanded}>
          <div className={styles['connector-tools']}>
            {readTools.length ? (
              <div className={styles['connector-tools-group']}>
                <div className={styles['connector-tools-heading']}>{t('connectors_group_read')}</div>
                <div className={styles['connector-tools-row']}>{readTools.map(renderTool)}</div>
              </div>
            ) : null}
            {writeTools.length ? (
              <div className={styles['connector-tools-group']}>
                <div className={styles['connector-tools-heading']}>{t('connectors_group_write')}</div>
                <div className={styles['connector-tools-row']}>{writeTools.map(renderTool)}</div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 连接器组详情弹窗（点 macOS 连接器卡弹出）：外壳同家族（hero + 标题 + 一句话），
 * 内容区是连接器行列表（开关 + 工具明细）；启用计数不单独播报，行内开关态自身
 * 已是事实清单；开关变更后弹窗内容原地刷新，并重置已经过期的展开态。
 */
export function ConnectorGroupModal({ groupId, onClose }: {
  groupId: string
  onClose: () => void
}) {
  const t = useT()
  const [rows, setRows] = useState<{ items: ConnectorItem[]; statusMap: Map<string, McpStatus>; statusUnavailable: boolean } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [refreshSeq, setRefreshSeq] = useState(0)
  const groupState: EntryModalState = loadError
    ? 'failed'
    : rows == null
      ? 'checking'
      : rows.statusUnavailable && rows.items.some(item => item.enabled)
        ? 'checking'
      : rows.items.some(item => item.enabled && (rows.statusMap.get(item.serverName || `klaus-${item.id}`)?.status === 'failed'
        || !!rows.statusMap.get(item.serverName || `klaus-${item.id}`)?.error))
        ? 'failed'
        : rows.items.some(item => item.enabled) ? 'on' : 'off'

  const refresh = async () => {
    setLoadError('')
    try {
      const [itemsResult, statusResult] = await Promise.allSettled([
        w().klaus.connectors.list(),
        w().klaus.connectors.status(),
      ])
      if (itemsResult.status !== 'fulfilled' || !Array.isArray(itemsResult.value)) throw new Error(t('mcp_load_failed'))
      const items = itemsResult.value
      const statusUnavailable = statusResult.status !== 'fulfilled' || !Array.isArray(statusResult.value)
      const statuses = statusUnavailable ? [] : statusResult.value
      const list = (items as ConnectorItem[]).filter(c => c.availableOnThisPlatform && c.group === groupId)
      setRows({ items: list, statusMap: new Map((statuses as McpStatus[]).map(s => [s.name, s])), statusUnavailable })
      setRefreshSeq(seq => seq + 1)
    } catch (error) {
      setLoadError(actionError(error, t('mcp_load_failed')))
    }
  }

  useEffect(() => { void refresh() }, [])

  return (
    <EntryModal
      entryIconHtml={connectorIcon('group:' + groupId)}
      state={groupState}
      title={groupId === 'macos' ? t('connectors_group_macos') : groupId}
      desc={t('mcp_connectors_group_desc')}
      onClose={onClose}
    >
      <div className={styles['mcp-entry-rows']} id="mcp-conn-modal-body">
        {loadError ? (
          <div className="empty-text sk-empty" role="alert">
            <p>{loadError}</p>
            <button type="button" className="btn-sm" onClick={() => { void refresh() }}>{t('mcp_retry')}</button>
          </div>
        ) : rows == null ? (
          <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
        ) : rows.items.length === 0 ? (
          <div className="empty-text sk-empty">{t('mcp_connectors_empty')}</div>
        ) : (
          <>
            {rows.statusUnavailable ? (
              <div className={styles['mcp-state-status']} role="status">{t('mcp_status_unavailable')}</div>
            ) : null}
            {/* 计数小标题 + 限高行列表：同浏览器弹窗「N 个浏览器扩展实例」那块的格式，
                卡高不随行数长，多出来的行在列表内滚。 */}
            <div className={styles['mcp-entry-rows-heading']}>
              {t('connectors_count').replace('{count}', String(rows.items.length))}
            </div>
            <div className={styles['mcp-entry-rows-list']}>
              {rows.items.map(item => (
                <ConnectorRow
                  key={`${refreshSeq}:${item.id}`}
                  item={item}
                  status={rows.statusMap.get(item.serverName || `klaus-${item.id}`)}
                  refresh={refresh}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </EntryModal>
  )
}

// ==================== 原生能力弹窗（电脑操控） ====================

// 电脑操控的安心栏三行：标题沿用共用那套（同一件事只有一种说法），描述换成桌面
// 操控自己的话。
const COMPUTER_USE_POINT_DESCS: [string, string, string] = [
  'computer_use_point_tools_desc',
  'computer_use_point_permission_desc',
  'computer_use_point_control_desc',
]

/**
 * 电脑操控启停弹窗：与市场状态弹窗同一版式（双 logo hero + 状态徽 + 标题/描述
 * + 安心栏 + 全宽按钮）。连接器只管理启停。Saved app approvals live in settings;
 * blocked apps and lock-screen preferences remain available through policy tools.
 * Recording starts from the skills page.
 * 运行策略里的审批与截图模式是产品定死的；录屏与辅助功能授权由系统在真正需要
 * 时提示。
 */
export function ComputerUseModal({ enabled: initialEnabled, onClose }: {
  enabled: boolean
  onClose: () => void
}) {
  const t = useT()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [busy, setBusy] = useState(false)
  const name = t('computer_use_title')

  const apply = async (next: boolean) => {
    setBusy(true)
    const res = await Promise.resolve(w().settingsApi?.computerUse?.setEnabled?.(next))
      .catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
    setBusy(false)
    if (!res?.ok) {
      showToast(res?.error || t('settings_failed'))
      return
    }
    setEnabled(next)
    showToast(next ? t('enabled') : t('mcp_disconnected_toast'))
  }

  const state = enabled ? 'on' : 'off'
  return (
    <EntryModal
      entryIconHtml={connectorIcon('computerUse') || rawIconHtml('browser-use-logo-5')}
      state={state}
      title={(enabled ? t('mcp_state_on_title') : t('mcp_state_enable_cta')).replace('{name}', name)}
      desc={t('computer_use_desc')}
      onClose={onClose}
      closeDisabled={busy}
      actions={enabled
        ? <EntryAction kind="danger" disabled={busy} onClick={() => { void apply(false) }}>{t('mcp_market_disconnect')}</EntryAction>
        : <EntryAction disabled={busy} onClick={() => { void apply(true) }}>{t('mcp_state_enable_cta').replace('{name}', name)}</EntryAction>}
    >
      <EntryPoints descKeys={COMPUTER_USE_POINT_DESCS} />
    </EntryModal>
  )
}

// ==================== 市场四态状态弹窗 ====================

type MarketModalView =
  | { mode: 'state'; state: 'install' | 'off' | 'on' | 'failed'; error?: string }
  | { mode: 'device-waiting'; grant: { userCode: string; verificationUri: string } }
  | { mode: 'client-id' }

/**
 * 市场条目统一状态弹窗（卡体/行尾图标点击弹出）：四态同一张弹窗原地切换——
 * install 安装（含 env 采集）→ off 启用（OAuth 授权挂在这一步）→ 探连结果
 * 分流 on（断开）/ failed（告警块内复制/uv 指引 + 断开/重试）；所有动作都在
 * 弹窗内，列表行只担状态展示。版式：双 logo hero（Klaus 砖 + 中缝状态徽 +
 * server 砖）+ 标题/描述 + 安心栏（失败态换错误块）+ 全宽按钮组。
 */
export function McpMarketStateModal({ entry, initialStatus, onClose }: {
  entry: McpBuiltinEntry
  initialStatus?: McpStatus
  onClose: () => void
}) {
  const t = useT()
  const text = mcpLocalizedText(entry)
  // client_id 保存后就地改 ready 再重走授权。
  const entryRef = useRef(entry)
  const [view, setView] = useState<MarketModalView>(() => ({
    mode: 'state',
    state: computeMarketEntryState(entry, initialStatus),
    ...(initialStatus?.error ? { error: initialStatus.error } : {}),
  }))
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState<'' | 'enable' | 'retry'>('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const deviceFlowActiveRef = useRef(false)
  useEffect(() => () => {
    mountedRef.current = false
    if (deviceFlowActiveRef.current) {
      deviceFlowActiveRef.current = false
      void w().klaus.mcp.deviceCancel?.(entryRef.current.id).catch(() => undefined)
    }
  }, [])

  // uvx 类服务：懒探 uv 是否缺失，失败态告警块据此内联安装指引（不自动安装）。
  const uvMissingRef = useRef(false)
  useEffect(() => {
    if (entry.needsUv && w().klaus?.mcp?.uvCheck) {
      w().klaus.mcp.uvCheck().then((res: any) => { uvMissingRef.current = !res?.available }).catch(() => {})
    }
  }, [])

  const render = (state: 'install' | 'off' | 'on' | 'failed', error?: string) => {
    if (!mountedRef.current) return
    setBusy(false)
    setConnecting('')
    setView({ mode: 'state', state, ...(error ? { error } : {}) })
  }

  const failAction = (error: unknown) => {
    if (!mountedRef.current) return
    setBusy(false)
    setConnecting('')
    showToast(actionError(error, t('settings_failed')))
  }

  // 收集凭据输入：全空返 null（沿用已存），有值返 env 对象（重灌配置）。
  const collectEnv = (): Record<string, string> | null => {
    const env: Record<string, string> = {}
    let hasValue = false
    bodyRef.current?.querySelectorAll<HTMLInputElement>('[data-envkey]').forEach(el => {
      env[el.dataset.envkey || ''] = el.value
      if (el.value.trim()) hasValue = true
    })
    return hasValue ? env : null
  }

  // 设备授权：未配 client_id 先引导填；拿到 user_code 就地切等码视图并开浏览器，
  // 主进程后台轮询到 token 即落盘 + 启用，回流后探连定态。
  const onDeviceAuth = async () => {
    setBusy(true)
    const started = await w().klaus.mcp.deviceStart?.(entryRef.current.id).catch(() => null)
    if (started?.error === 'no_client_id') { setBusy(false); setView({ mode: 'client-id' }); return }
    if (!started?.ok) {
      setBusy(false)
      showToast(t('mcp_device_start_failed'))
      return
    }
    setBusy(false)
    setView({ mode: 'device-waiting', grant: started })
    deviceFlowActiveRef.current = true
    void Promise.resolve(w().klaus.app?.openExternal?.(started.verificationUri))
      .catch((error: unknown) => showToast(actionError(error, t('external_open_failed'))))
    const done = await w().klaus.mcp.deviceWait?.(entryRef.current.id).catch(() => null)
    deviceFlowActiveRef.current = false
    if (!mountedRef.current) return
    if (!done?.ok) {
      showToast(done?.error === 'denied' ? t('mcp_device_denied')
        : done?.error === 'expired' ? t('mcp_device_expired')
          : done?.error === 'cancelled' ? t('cancel') : t('mcp_device_start_failed'))
      render('off')
      reloadMcpView()
      return
    }
    showToast(t('mcp_authorize_done'))
    try {
      entryRef.current = { ...entryRef.current, installed: true, enabled: true }
      const probed = await probeMarketStatus(entryRef.current.id)
      reloadMcpView()
      if (!probed) render(computeMarketEntryState(entryRef.current))
      else if (probed.status === 'failed' || probed.error) render('failed', probed.error)
      else render('on')
    } catch (error) {
      const message = actionError(error, t('mcp_load_failed'))
      showToast(message)
      render('failed', message)
    }
  }

  const onDeviceCancel = async () => {
    if (busy) return
    setBusy(true)
    try {
      deviceFlowActiveRef.current = false
      const result = await w().klaus.mcp.deviceCancel?.(entryRef.current.id)
      requireActionOk(result, t('settings_failed'))
      render(computeMarketEntryState(entryRef.current, initialStatus), initialStatus?.error)
    } catch (error) {
      failAction(error)
    }
  }

  const onClientIdSave = async () => {
    const input = bodyRef.current?.querySelector<HTMLInputElement>('[data-client-id-input]')
    const value = input?.value?.trim() || ''
    if (!value) {
      showToast(t('mcp_device_clientid_required'))
      input?.focus()
      return
    }
    setBusy(true)
    try {
      const result = await w().klaus.mcp.deviceClientId?.(entryRef.current.id, value)
      requireActionOk(result, t('settings_failed'))
      entryRef.current = { ...entryRef.current, deviceAuth: { ...(entryRef.current.deviceAuth || {}), ready: true } }
      setBusy(false)
      // A saved public client id immediately continues into device authorization.
      void onDeviceAuth()
    } catch (error) {
      failAction(error)
    }
  }

  const onInstall = async () => {
    setBusy(true)
    const env: Record<string, string> = {}
    bodyRef.current?.querySelectorAll<HTMLInputElement>('[data-envkey]').forEach(el => { env[el.dataset.envkey || ''] = el.value })
    try {
      const result = await w().klaus.mcp.builtinInstall(entryRef.current.id, env)
      requireActionOk(result, t('settings_failed'))
      // Installing a catalog entry persists it as enabled. Reflect the host
      // contract immediately, then replace the optimistic state with a probe.
      entryRef.current = { ...entryRef.current, installed: true, enabled: true }
      const probed = await probeMarketStatus(entryRef.current.id)
      reloadMcpView()
      const state = computeMarketEntryState(entryRef.current, probed || undefined)
      render(state === 'install' ? 'on' : state, probed?.error)
    } catch (error) {
      failAction(error)
    }
  }

  const onEnable = async () => {
    setBusy(true)
    setConnecting('enable')
    try {
      // Fresh credentials are installed before enablement; an empty form keeps
      // the stored values.
      const envUpdate = collectEnv()
      if (envUpdate) {
        const installed = await w().klaus.mcp.builtinInstall(entryRef.current.id, envUpdate)
        requireActionOk(installed, t('settings_failed'))
      }
      const toggled = await w().klaus.mcp.toggle(entryRef.current.id, true)
      requireActionOk(toggled, t('settings_failed'))
      entryRef.current = { ...entryRef.current, installed: true, enabled: true }
      if (entryRef.current.auth === 'oauth' && typeof w().klaus.mcp.klausAuthenticate === 'function') {
        const st = await authorizeMcpServer(entryRef.current.id, { quietFailure: true })
        if (st === null) { render('off'); return }
        if (!mcpAuthOk(st)) {
          reloadMcpView()
          if (mcpAuthStatus(st) === 'failed') render('failed', typeof st === 'string' ? undefined : st?.error)
          else render('off')
          return
        }
      }
      const probed = await probeMarketStatus(entryRef.current.id)
      reloadMcpView()
      if (!probed) render(computeMarketEntryState(entryRef.current))
      else if (probed.status === 'failed' || probed.error) render('failed', probed.error)
      else render('on')
    } catch (error) {
      failAction(error)
    }
  }

  const onDisconnect = async () => {
    setBusy(true)
    try {
      // Disconnect disables the entry while retaining its configuration and authorization.
      const result = await w().klaus.mcp.toggle(entryRef.current.id, false)
      requireActionOk(result, t('settings_failed'))
      entryRef.current = { ...entryRef.current, enabled: false }
      showToast(t('mcp_disconnected_toast'))
      reloadMcpView()
      render('off')
    } catch (error) {
      failAction(error)
    }
  }

  const onRetry = async () => {
    setBusy(true)
    setConnecting('retry')
    try {
      const envUpdate = collectEnv()
      if (envUpdate) {
        const installed = await w().klaus.mcp.builtinInstall(entryRef.current.id, envUpdate)
        requireActionOk(installed, t('settings_failed'))
      }
      const reconnected = await w().klaus.mcp.reconnect()
      requireActionOk(reconnected, t('settings_failed'), true)
      const probed = await probeMarketStatus(entryRef.current.id)
      reloadMcpView()
      if (!probed) render(computeMarketEntryState(entryRef.current))
      else if (probed.status === 'failed' || probed.error) render('failed', probed.error)
      else render('on')
    } catch (error) {
      failAction(error)
    }
  }

  // 三种视图（状态 / 等设备码 / 填 client_id）共用同一张外壳，只换状态徽、标题、
  // 正文与动作。
  const view3 = (() => {
    if (view.mode === 'device-waiting') {
      // 等码视图：大字 user_code + 复制，告知已开浏览器去哪里输码，并给取消。
      return {
        state: 'off' as EntryModalState,
        title: t('mcp_device_waiting_title'),
        desc: t('mcp_device_waiting_desc').replace('{uri}', view.grant.verificationUri),
        children: (
          <div className={styles['mcp-device-code-row']}>
            <code className={styles['mcp-device-code']}>{view.grant.userCode}</code>
            <button className="btn-xs" onClick={() => { writeClipboardText(view.grant.userCode).then(() => showToast(t('copied'))).catch(() => showToast(t('copy_failed'))) }}>{t('copy')}</button>
          </div>
        ),
        actions: <EntryAction kind="secondary" disabled={busy} onClick={() => { void onDeviceCancel() }}>{t('cancel')}</EntryAction>,
      }
    }
    if (view.mode === 'client-id') {
      // client_id 引导视图：设备流需要一个预注册的 public client_id（不是密钥），
      // 未配时给说明 + 注册链接 + 输入框，一次配好长期复用。
      return {
        state: 'install' as EntryModalState,
        title: t('mcp_device_clientid_title'),
        desc: t('mcp_device_clientid_desc'),
        children: (
          <div className={styles['mcp-state-env']}>
            <div className="kls-field">
              <label className="kls-field-label">Client ID</label>
              <input className="kls-input" type="text" data-client-id-input placeholder="Iv1.xxxxxxxxxxxx" />
            </div>
            <a className={styles['mcp-device-register-link']} href={entryRef.current.deviceAuth?.registerUrl || ''} target="_blank" rel="noreferrer">{t('mcp_device_clientid_register')}</a>
          </div>
        ),
        actions: (
          <>
            <EntryAction disabled={busy} onClick={() => { void onClientIdSave() }}>{t('mcp_device_clientid_save')}</EntryAction>
            <EntryAction kind="secondary" disabled={busy} onClick={() => { void onDeviceCancel() }}>{t('cancel')}</EntryAction>
          </>
        ),
      }
    }

    const { state, error } = view
    const title = state === 'install' ? t('mcp_state_install_title').replace('{name}', text.name)
      : state === 'off' ? t('mcp_state_off_title').replace('{name}', text.name)
        : state === 'failed' ? t('mcp_state_failed_title').replace('{name}', text.name)
          : t('mcp_state_on_title').replace('{name}', text.name)
    // 凭据采集：安装态必填；已安装的 apikey 服务在待启用/失败态也出示（留空沿用、
    // 填写覆盖）——PAT 填错/过期时不用卸载重装就能换凭据。
    // 支持设备授权的条目（GitHub）：手填降为备选，折叠在「或手动填入令牌」下。
    const canDeviceAuth = !!entryRef.current.deviceAuth && (state === 'install' || state === 'off' || state === 'failed')
    const showEnv = (entry.envKeys || []).length > 0
      && (state === 'install' || state === 'off' || state === 'failed')
    const envFields = (entry.envKeys || []).map(k => (
      <div className="kls-field" key={k.key}>
        <label className="kls-field-label">{k.label}</label>
        <input className="kls-input" type={k.secret ? 'password' : 'text'} data-envkey={k.key} placeholder={k.key} />
      </div>
    ))
    const envBlock = !showEnv
      ? null
      : canDeviceAuth
        ? (
          <details className={`${styles['mcp-state-env']} ${styles['mcp-state-env-fold']}`}>
            <summary>{t('mcp_device_manual_token')}</summary>
            {state !== 'install' ? <div className={styles['mcp-state-env-hint']}>{t('mcp_env_update_hint')}</div> : null}
            {envFields}
          </details>
        )
        : (
          <div className={styles['mcp-state-env']}>
            {state !== 'install' ? <div className={styles['mcp-state-env-hint']}>{t('mcp_env_update_hint')}</div> : null}
            {envFields}
          </div>
        )
    const middle = state === 'failed'
      ? <div className={styles['mcp-state-error']}><McpErrorBlock error={error} showUvHint={!!entry.needsUv && uvMissingRef.current} /></div>
      : <EntryPoints descKeys={['mcp_enable_point1_desc', 'mcp_enable_point2_desc', 'mcp_enable_point3_desc']} />
    const deviceAuthAction = canDeviceAuth
      ? <EntryAction disabled={busy} onClick={() => { void onDeviceAuth() }}>{t('mcp_device_auth_cta').replace('{name}', text.name)}</EntryAction>
      : null
    const actions = state === 'install'
      ? (
        <>
          {deviceAuthAction}
          <EntryAction kind={canDeviceAuth ? 'secondary' : 'primary'} disabled={busy} onClick={() => { void onInstall() }}>
            {t('mcp_state_install_cta').replace('{name}', text.name)}
          </EntryAction>
        </>
      )
      : state === 'off'
        ? (
          <>
            {deviceAuthAction}
            <EntryAction kind={canDeviceAuth ? 'secondary' : 'primary'} disabled={busy} onClick={() => { void onEnable() }}>
              {connecting === 'enable' ? t('mcp_state_connecting') : t('mcp_state_enable_cta').replace('{name}', text.name)}
            </EntryAction>
          </>
        )
        : state === 'on'
          ? <EntryAction kind="danger" disabled={busy} onClick={() => { void onDisconnect() }}>{t('mcp_market_disconnect')}</EntryAction>
          : (
            <>
              <EntryAction kind="danger" disabled={busy} onClick={() => { void onDisconnect() }}>{t('mcp_market_disconnect')}</EntryAction>
              {canDeviceAuth && <EntryAction kind="secondary" disabled={busy} onClick={() => { void onDeviceAuth() }}>{t('mcp_device_reauth_cta')}</EntryAction>}
              <EntryAction kind="secondary" disabled={busy} onClick={() => { void onRetry() }}>
                {connecting === 'retry' ? t('mcp_state_connecting') : t('mcp_retry')}
              </EntryAction>
              <EntryAction disabled={busy} onClick={() => {
                void startMcpDiagnoseChat(text.name, entryRef.current.id, error, { closeModals: onClose })
              }}>{t('mcp_diagnose')}</EntryAction>
            </>
          )
    // OAuth 服务在安装/待启用态告知浏览器授权步骤（旧安装弹窗「需要授权」横幅的继任）。
    const oauthHint = entry.auth === 'oauth' && (state === 'install' || state === 'off')
      ? <div className={styles['mcp-state-oauth-hint']}>{t('mcp_state_oauth_hint')}</div>
      : null
    return {
      state: state as EntryModalState,
      title,
      desc: text.desc,
      children: state === 'failed' ? <>{middle}{envBlock}</> : <>{envBlock}{middle}</>,
      actions,
      footer: oauthHint,
    }
  })()

  return (
    <EntryModal
      entryIconHtml={connectorIcon(entry.id) || strokeGlyph24(entry.iconSvg || MCP_GENERIC_SERVER_ICON, 24)}
      state={view3.state}
      title={view3.title}
      desc={view3.desc}
      actions={view3.actions}
      {...(view3.footer ? { footer: view3.footer } : {})}
      onClose={onClose}
      closeDisabled={busy}
      bodyRef={bodyRef}
    >
      {view3.children}
    </EntryModal>
  )
}
