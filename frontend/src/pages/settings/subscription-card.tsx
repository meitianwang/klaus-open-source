// Each subscription source has one account card for its engine-owned credentials.
import { useEffect, useRef, useState } from 'react'
import { useT, t as tGlobal } from '../../i18n'
import { cursorErrorText } from '../../app/cursor-errors'
import { knownTraeAuthErrorText } from '../../app/trae-errors'
import { knownKiroAuthErrorText } from '../../app/kiro-errors'
import { knownAntigravityErrorText } from '../../app/antigravity-errors'
import { activateModelSource, KlsSelect } from './model-shared'
import styles from './settings.module.css'
import { settingsErrorText } from './settings-error-text'

const w = () => window as any

// Credential state survives remounts of this card. A host settings write —
// including the source activation the login flow itself performs — remounts the
// whole settings tab, and a card that drops to its skeleton on every remount
// reads as the page flashing. The caches seed the first paint after a remount;
// the status reads below still refresh them on every mount and reload signal,
// so a cached row never outlives the next read.
const subscriptionStatusCache = new Map<string, any>()
const consoleSessionCache = new Map<string, { loggedIn: boolean }>()

export interface SubscriptionLoginOptions { activateModel?: boolean; workbuddyRegion?: 'cn' | 'intl' }

export interface SubscriptionSource {
  mode: string
  idPrefix: string
  label: string
  api: () => any
  accountFallback: string
  notLoggedIn: string
  loginLabel: string
  importLabel?: string
  logoutLabel: string
  loginOpening: string
  importConfirm?: string
  importing?: string
  importSuccess?: string
  importFailedPrefix?: string
  confirmLogout: string
  deviceExpired?: string
  login: (source: SubscriptionSource, setStatus: (text: string) => void, reload: () => void, options?: SubscriptionLoginOptions) => Promise<void>
  deviceHint?: (flow: any) => string
  /**
   * A source whose documented third-party credential is a pasted API key rather
   * than an account login. Present only for Kimi: it renders a key field with a
   * link to the console that mints one, and keeps `login` (the device flow) as a
   * secondary path beside it. Every other source authenticates by account only.
   */
  apiKey?: {
    labelKey: string
    placeholderKey: string
    saveKey: string
    savingKey: string
    savedKey: string
    failedPrefixKey: string
    consoleLabelKey: string
    consoleUrl: string
    /**
     * A source whose credential console differs per site. Coding Plan is sold by two
     * platforms with separate accounts, so the page that mints a key is a different
     * site on each — pointing an international subscriber at the domestic console
     * sends them somewhere their key does not exist.
     *
     * `consoleUrl` is the fallback for a site this map does not name, and remains
     * the whole story for a source with one console.
     */
    consoleUrlBySite?: Record<string, string>
    /**
     * How the caller states WHICH host the key belongs to. A key is bound to the
     * site that issued it, so getting this wrong is a 401 with no explanation.
     *
     * `freeText` renders a base-URL field the user fills in (Kimi, which has a
     * domestic and an overseas coding gateway). `select` renders a fixed set of
     * sites to pick from (Token Plan, which serves exactly one region per site — a
     * free-text host there would only let someone invent one).
     *
     * Absent means the credential needs no host choice at all.
     */
    host?:
      | { kind: 'freeText'; baseLabelKey: string; basePlaceholder: string }
      | { kind: 'select'; labelKey: string; options: Array<{ value: string; labelKey: string }> }
    /**
     * The alternative login offered beside the key field, for a service that has
     * one. Token Plan has none — a plan key is the only credential it accepts — so
     * this is absent and the card shows the key field alone rather than a login
     * button that cannot work.
     */
    device?: { labelKey: string; riskKey: string }
  }
  /**
   * A second, optional credential that unlocks allowance figures the plan key
   * cannot read: a console session obtained through the service's published
   * browser loopback flow. Present only for Bailian Token Plan, whose quota
   * gateway answers to a console session token and to nothing else. The card
   * renders it as a sign-in row under the connected state; without it the
   * usage popover keeps pointing at the console.
   */
  consoleSession?: {
    loginLabelKey: string
    logoutLabelKey: string
    connectedKey: string
    hintKey: string
    openingKey: string
    waitingKey: string
    doneKey: string
    failedPrefixKey: string
    confirmLogoutKey: string
  }
}

export const SUBSCRIPTION_SOURCES: Record<string, SubscriptionSource> = {
  kiro: {
    mode: 'kiro',
    idPrefix: 'kiro-auth',
    label: 'auth_kiro',
    api: () => w().klaus.kiroAuth,
    accountFallback: 'kiro_account_fallback',
    notLoggedIn: 'kiro_not_logged_in',
    loginLabel: 'kiro_login',
    importLabel: 'kiro_reuse_login',
    logoutLabel: 'kiro_disconnect',
    loginOpening: 'kiro_login_opening',
    importConfirm: 'kiro_import_confirm',
    importing: 'kiro_importing',
    importSuccess: 'kiro_import_success',
    importFailedPrefix: 'kiro_import_failed_prefix',
    confirmLogout: 'kiro_confirm_logout',
    deviceExpired: 'kiro_browser_login_expired',
    login: loginThroughDeviceFlow,
  },
  trae: {
    mode: 'trae',
    idPrefix: 'trae-auth',
    label: 'auth_trae',
    api: () => w().klaus.traeAuth,
    accountFallback: 'trae_account_fallback',
    notLoggedIn: 'trae_not_logged_in',
    loginLabel: 'trae_login',
    importLabel: 'trae_reuse_login',
    logoutLabel: 'trae_disconnect',
    loginOpening: 'trae_login_opening',
    importConfirm: 'trae_import_confirm',
    importing: 'trae_importing',
    importSuccess: 'trae_import_success',
    importFailedPrefix: 'trae_import_failed_prefix',
    confirmLogout: 'trae_confirm_logout',
    deviceExpired: 'trae_browser_login_expired',
    login: loginThroughDeviceFlow,
  },
  antigravity: {
    mode: 'antigravity',
    idPrefix: 'antigravity-auth',
    label: 'auth_antigravity',
    api: () => w().klaus.antigravityAuth,
    accountFallback: 'antigravity_account_fallback',
    notLoggedIn: 'antigravity_not_logged_in',
    loginLabel: 'antigravity_login',
    importLabel: 'antigravity_reuse_login',
    logoutLabel: 'antigravity_disconnect',
    loginOpening: 'antigravity_login_opening',
    importConfirm: 'antigravity_import_confirm',
    importing: 'antigravity_importing',
    importSuccess: 'antigravity_import_success',
    importFailedPrefix: 'antigravity_import_failed_prefix',
    confirmLogout: 'antigravity_confirm_logout',
    deviceExpired: 'antigravity_browser_login_expired',
    login: loginThroughDeviceFlow,
  },
  subscription: {
    mode: 'subscription',
    idPrefix: 'auth',
    label: 'auth_subscription',
    api: () => w().klaus.auth,
    accountFallback: 'sub_account_fallback',
    notLoggedIn: 'sub_card_not_logged_in',
    loginLabel: 'sub_login_btn',
    importLabel: 'sub_import_btn',
    logoutLabel: 'sub_logout',
    loginOpening: 'sub_auth_opening',
    importConfirm: 'sub_import_confirm',
    importing: 'sub_importing',
    importSuccess: 'sub_import_success',
    importFailedPrefix: 'sub_import_failed_prefix',
    confirmLogout: 'sub_confirm_logout',
    // 宿主自己跑完整个回环授权，一次调用就有结果。
    login: loginThroughHost,
  },
  codex: {
    mode: 'codex',
    idPrefix: 'codex-auth',
    label: 'auth_codex',
    api: () => w().klaus.codexAuth,
    accountFallback: 'codex_account_fallback',
    notLoggedIn: 'codex_card_not_logged_in',
    loginLabel: 'codex_login_btn',
    importLabel: 'codex_import_btn',
    logoutLabel: 'codex_logout',
    loginOpening: 'codex_auth_opening',
    importConfirm: 'codex_import_confirm',
    importing: 'codex_importing',
    importSuccess: 'codex_import_success',
    importFailedPrefix: 'codex_import_failed_prefix',
    confirmLogout: 'codex_confirm_logout',
    deviceExpired: 'codex_auth_expired',
    // 浏览器里要对着验证码确认，所以码得显示出来。
    login: loginThroughDeviceFlow,
    deviceHint: (flow: any) => `${tGlobal('codex_auth_code')} ${flow.userCode}`,
  },
  cursor: {
    mode: 'cursor',
    idPrefix: 'cursor-auth',
    label: 'auth_cursor',
    api: () => w().klaus.cursorAuth,
    accountFallback: 'cursor_account_fallback',
    notLoggedIn: 'cursor_card_not_logged_in',
    loginLabel: 'cursor_login_btn',
    importLabel: 'cursor_import_btn',
    logoutLabel: 'cursor_logout',
    loginOpening: 'cursor_auth_opening',
    importConfirm: 'cursor_import_confirm',
    importing: 'cursor_importing',
    importSuccess: 'cursor_import_success',
    importFailedPrefix: 'cursor_import_failed_prefix',
    confirmLogout: 'cursor_confirm_logout',
    deviceExpired: 'cursor_auth_expired',
    login: loginThroughDeviceFlow,
  },
  qoder: {
    mode: 'qoder',
    idPrefix: 'qoder-auth',
    label: 'auth_qoder',
    api: () => w().klaus.qoderAuth,
    accountFallback: 'qoder_account_fallback',
    notLoggedIn: 'qoder_card_not_logged_in',
    loginLabel: 'qoder_login_btn',
    importLabel: 'qoder_import_btn',
    logoutLabel: 'qoder_logout',
    loginOpening: 'qoder_auth_opening',
    importConfirm: 'qoder_import_confirm',
    importing: 'qoder_importing',
    importSuccess: 'qoder_import_success',
    importFailedPrefix: 'qoder_import_failed_prefix',
    confirmLogout: 'qoder_confirm_logout',
    deviceExpired: 'qoder_auth_expired',
    // 授权页由宿主直接打开，页面上选账号即可，没有验证码要念。
    login: loginThroughDeviceFlow,
  },
  qwenwork: {
    mode: 'qwenwork',
    idPrefix: 'qwenwork-auth',
    label: 'auth_qwenwork',
    api: () => w().klaus.qwenworkAuth,
    accountFallback: 'qwenwork_account_fallback',
    notLoggedIn: 'qwenwork_card_not_logged_in',
    loginLabel: 'qwenwork_login_btn',
    importLabel: 'qwenwork_import_btn',
    logoutLabel: 'qwenwork_logout',
    loginOpening: 'qwenwork_auth_opening',
    importConfirm: 'qwenwork_import_confirm',
    importing: 'qwenwork_importing',
    importSuccess: 'qwenwork_import_success',
    importFailedPrefix: 'qwenwork_import_failed_prefix',
    confirmLogout: 'qwenwork_confirm_logout',
    deviceExpired: 'qwenwork_auth_expired',
    login: loginThroughDeviceFlow,
  },
  qoderwork: {
    mode: 'qoderwork',
    idPrefix: 'qoderwork-auth',
    label: 'auth_qoderwork',
    api: () => w().klaus.qoderworkAuth,
    accountFallback: 'qoderwork_account_fallback',
    notLoggedIn: 'qoderwork_card_not_logged_in',
    loginLabel: 'qoderwork_login_btn',
    importLabel: 'qoderwork_import_btn',
    logoutLabel: 'qoderwork_logout',
    loginOpening: 'qoderwork_auth_opening',
    importConfirm: 'qoderwork_import_confirm',
    importing: 'qoderwork_importing',
    importSuccess: 'qoderwork_import_success',
    importFailedPrefix: 'qoderwork_import_failed_prefix',
    confirmLogout: 'qoderwork_confirm_logout',
    deviceExpired: 'qoderwork_auth_expired',
    login: loginThroughDeviceFlow,
  },
  workbuddy: {
    mode: 'workbuddy',
    idPrefix: 'workbuddy-auth',
    label: 'auth_workbuddy',
    api: () => w().klaus.workbuddyAuth,
    accountFallback: 'workbuddy_account_fallback',
    notLoggedIn: 'workbuddy_card_not_logged_in',
    loginLabel: 'workbuddy_login_btn',
    importLabel: 'workbuddy_import_btn',
    logoutLabel: 'workbuddy_logout',
    loginOpening: 'workbuddy_auth_opening',
    importConfirm: 'workbuddy_import_confirm',
    importing: 'workbuddy_importing',
    importSuccess: 'workbuddy_import_success',
    importFailedPrefix: 'workbuddy_import_failed_prefix',
    confirmLogout: 'workbuddy_confirm_logout',
    deviceExpired: 'workbuddy_auth_expired',
    // The gateway answers with a browser page and a flow handle; there is no code
    // for the user to read out, so this is the same shape as QwenWork.
    login: loginThroughDeviceFlow,
  },
  kimi: {
    mode: 'kimi',
    idPrefix: 'kimi-auth',
    label: 'auth_kimi',
    api: () => w().klaus.kimiAuth,
    accountFallback: 'kimi_account_fallback',
    notLoggedIn: 'kimi_card_not_logged_in',
    loginLabel: 'kimi_login_btn',
    logoutLabel: 'kimi_logout',
    loginOpening: 'kimi_auth_opening',
    confirmLogout: 'kimi_confirm_logout',
    deviceExpired: 'kimi_auth_expired',
    // Kimi's verification page arrives prefilled with the user code, so there is
    // nothing to read out.
    login: loginThroughDeviceFlow,
    apiKey: {
      labelKey: 'kimi_apikey_label',
      placeholderKey: 'kimi_apikey_placeholder',
      saveKey: 'kimi_apikey_save',
      savingKey: 'kimi_apikey_saving',
      savedKey: 'kimi_apikey_saved',
      failedPrefixKey: 'kimi_apikey_failed_prefix',
      consoleLabelKey: 'kimi_apikey_console',
      consoleUrl: 'https://www.kimi.com/code/console',
      host: {
        kind: 'freeText',
        baseLabelKey: 'kimi_apikey_base_label',
        basePlaceholder: 'https://api.kimi.com/coding',
      },
      device: { labelKey: 'kimi_login_btn', riskKey: 'kimi_login_risk' },
    },
  },
  bailian: {
    mode: 'bailian',
    idPrefix: 'bailian-auth',
    // The source label names the plan, not the vendor: "Bailian" alone is
    // ambiguous with the Coding Plan preset in the custom-model form, and these are
    // two separate products whose keys are not interchangeable.
    label: 'auth_bailian',
    api: () => w().klaus.bailianAuth,
    accountFallback: 'bailian_account_fallback',
    notLoggedIn: 'bailian_card_not_logged_in',
    // There is no login to open, so this label is never rendered: the card shows the
    // key field alone because Token Plan accepts no other credential. It stays
    // because the shared source shape requires one.
    loginLabel: 'bailian_apikey_save',
    logoutLabel: 'bailian_logout',
    loginOpening: 'bailian_apikey_saving',
    confirmLogout: 'bailian_confirm_logout',
    // Never invoked: with no `device` block the card renders no login button.
    login: async () => {},
    apiKey: {
      labelKey: 'bailian_apikey_label',
      placeholderKey: 'bailian_apikey_placeholder',
      saveKey: 'bailian_apikey_save',
      savingKey: 'bailian_apikey_saving',
      savedKey: 'bailian_apikey_saved',
      failedPrefixKey: 'bailian_apikey_failed_prefix',
      consoleLabelKey: 'bailian_apikey_console',
      consoleUrl: 'https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan',
      // Token Plan serves exactly one region per site and a key is bound to the
      // site that issued it, so this is a choice between two sites rather than a
      // host to type: a free-text field would only let someone invent one and get a
      // 401 with no explanation.
      host: {
        kind: 'select',
        labelKey: 'bailian_region_label',
        options: [
          { value: 'cn', labelKey: 'bailian_region_cn' },
          { value: 'intl', labelKey: 'bailian_region_intl' },
        ],
      },
    },
    // The allowance the console renders is not readable with the plan key, but
    // the service publishes a browser loopback login whose session token reads
    // it. This row is that login; without it the usage popover keeps pointing
    // at the console.
    consoleSession: {
      loginLabelKey: 'bailian_console_login',
      logoutLabelKey: 'bailian_console_logout',
      connectedKey: 'bailian_console_connected',
      hintKey: 'bailian_console_hint',
      openingKey: 'bailian_console_opening',
      waitingKey: 'bailian_console_waiting',
      doneKey: 'bailian_console_done',
      failedPrefixKey: 'bailian_console_failed_prefix',
      confirmLogoutKey: 'bailian_console_confirm_logout',
    },
  },
  minimax: {
    mode: 'minimax',
    idPrefix: 'minimax-auth',
    // The source label names the plan rather than the vendor, because the vendor
    // also sells a pay-as-you-go API whose keys are not interchangeable with these.
    label: 'auth_minimax',
    api: () => w().klaus.minimaxAuth,
    accountFallback: 'minimax_account_fallback',
    notLoggedIn: 'minimax_card_not_logged_in',
    // There is no login to open, so this label is never rendered: the card shows the
    // key field alone because the plan accepts no other credential. It stays because
    // the shared source shape requires one.
    loginLabel: 'minimax_apikey_save',
    logoutLabel: 'minimax_logout',
    loginOpening: 'minimax_apikey_saving',
    confirmLogout: 'minimax_confirm_logout',
    // Never invoked: with no `device` block the card renders no login button.
    login: async () => {},
    apiKey: {
      labelKey: 'minimax_apikey_label',
      placeholderKey: 'minimax_apikey_placeholder',
      saveKey: 'minimax_apikey_save',
      savingKey: 'minimax_apikey_saving',
      savedKey: 'minimax_apikey_saved',
      failedPrefixKey: 'minimax_apikey_failed_prefix',
      consoleLabelKey: 'minimax_apikey_console',
      consoleUrl: 'https://platform.minimax.cn/console/plan',
      // Both sites mint the same `sk-cp-` key shape and do not share keys, so the
      // region is not recoverable from the key. The first option is empty and means
      // "let the engine detect it": a caller who does not know which site issued
      // their key gets a working connection instead of a 401 that blames the key.
      // Picking a site explicitly skips the probe against the other one.
      host: {
        kind: 'select',
        labelKey: 'minimax_region_label',
        options: [
          { value: '', labelKey: 'minimax_region_auto' },
          { value: 'cn', labelKey: 'minimax_region_cn' },
          { value: 'global', labelKey: 'minimax_region_global' },
        ],
      },
    },
  },
  zhipu: {
    mode: 'zhipu',
    idPrefix: 'zhipu-auth',
    // The label names the plan, not the vendor, for the same reason the Bailian one
    // does: this is the credit-metered Coding Plan, not the platform's pay-as-you-go
    // API, and the two take different keys against different allowances.
    label: 'auth_zhipu',
    api: () => w().klaus.zhipuAuth,
    accountFallback: 'zhipu_account_fallback',
    notLoggedIn: 'zhipu_card_not_logged_in',
    // There is no login to open, so this label is never rendered: the card shows the
    // key field alone because Coding Plan accepts no other credential. It stays
    // because the shared source shape requires one.
    loginLabel: 'zhipu_apikey_save',
    logoutLabel: 'zhipu_logout',
    loginOpening: 'zhipu_apikey_saving',
    confirmLogout: 'zhipu_confirm_logout',
    // Never invoked: with no `device` block the card renders no login button.
    login: async () => {},
    apiKey: {
      labelKey: 'zhipu_apikey_label',
      placeholderKey: 'zhipu_apikey_placeholder',
      saveKey: 'zhipu_apikey_save',
      savingKey: 'zhipu_apikey_saving',
      savedKey: 'zhipu_apikey_saved',
      failedPrefixKey: 'zhipu_apikey_failed_prefix',
      consoleLabelKey: 'zhipu_apikey_console',
      consoleUrl: 'https://bigmodel.cn/coding-plan/personal/overview',
      // The two sites keep separate accounts, so each has its own key page. A
      // subscriber pointed at the other one lands somewhere their key does not
      // exist, with nothing on the page to explain why.
      consoleUrlBySite: {
        cn: 'https://bigmodel.cn/coding-plan/personal/overview',
        intl: 'https://z.ai/manage-apikey/apikey-list',
      },
      // Coding Plan is served by two sites and a key is bound to the one that
      // issued it, so this is a choice between two sites rather than a host to
      // type: a free-text field would only let someone invent one and get a 401
      // with no explanation.
      host: {
        kind: 'select',
        labelKey: 'zhipu_region_label',
        options: [
          { value: 'cn', labelKey: 'zhipu_region_cn' },
          { value: 'intl', labelKey: 'zhipu_region_intl' },
        ],
      },
    },
  },
  ark: {
    mode: 'ark',
    idPrefix: 'ark-auth',
    // The label names the plan rather than the vendor, for the same reason the other
    // plan cards do: this is the credit-metered Coding Plan, not the platform's
    // pay-as-you-go API, and the two take different keys against different
    // allowances.
    label: 'auth_ark',
    api: () => w().klaus.arkAuth,
    accountFallback: 'ark_account_fallback',
    notLoggedIn: 'ark_card_not_logged_in',
    // There is no login to open, so this label is never rendered: the card shows the
    // key field alone because Coding Plan accepts no other credential. It stays
    // because the shared source shape requires one.
    loginLabel: 'ark_apikey_save',
    logoutLabel: 'ark_logout',
    loginOpening: 'ark_apikey_saving',
    confirmLogout: 'ark_confirm_logout',
    // Never invoked: with no `device` block the card renders no login button.
    login: async () => {},
    apiKey: {
      labelKey: 'ark_apikey_label',
      placeholderKey: 'ark_apikey_placeholder',
      saveKey: 'ark_apikey_save',
      savingKey: 'ark_apikey_saving',
      savedKey: 'ark_apikey_saved',
      failedPrefixKey: 'ark_apikey_failed_prefix',
      consoleLabelKey: 'ark_apikey_console',
      consoleUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey',
      // No `host` block: the plan is published at one region and its key page, plan
      // page and every documented base URL all point there, so unlike the two-site
      // plans there is nothing to pick and nothing to detect. A one-option dropdown
      // would be a control with exactly one setting.
    },
    // The allowance the plan meters is not readable with the plan key (measured: the
    // gateway answers every candidate usage route with 404, and the service's own
    // CLI refuses the key on its usage command). This row is the console session
    // login that unlocks those figures; without it the usage popover keeps pointing
    // at the console.
    consoleSession: {
      loginLabelKey: 'ark_console_login',
      logoutLabelKey: 'ark_console_logout',
      connectedKey: 'ark_console_connected',
      hintKey: 'ark_console_hint',
      openingKey: 'ark_console_opening',
      waitingKey: 'ark_console_waiting',
      doneKey: 'ark_console_done',
      failedPrefixKey: 'ark_console_failed_prefix',
      confirmLogoutKey: 'ark_console_confirm_logout',
    },
  },
}

// Translate stable host error codes here instead of exposing internal identifiers.
// Provider-specific codes for the same condition share the same user-facing text.
const AUTH_ERROR_KEYS: Record<string, string> = {
  antigravity_local_not_found: 'antigravity_local_not_found',
  antigravity_local_unreadable: 'antigravity_local_unreadable',
  antigravity_auth_method_unsupported: 'antigravity_auth_method_unsupported',
  antigravity_login_expired: 'antigravity_login_expired',
  antigravity_refresh_unavailable: 'antigravity_refresh_unavailable',
  antigravity_login_invalid_flow: 'antigravity_browser_login_expired',
  antigravity_login_cancelled: 'antigravity_login_cancelled',
  antigravity_login_denied: 'antigravity_login_denied',
  antigravity_login_callback_invalid: 'antigravity_login_invalid_response',
  antigravity_login_network_error: 'antigravity_login_network_error',
  antigravity_login_invalid_response: 'antigravity_login_invalid_response',
  antigravity_login_failed: 'antigravity_login_failed',
  antigravity_login_store_failed: 'auth_err_store_write',
  antigravity_login_random_failed: 'antigravity_login_unavailable',
  antigravity_login_callback_unavailable: 'antigravity_login_unavailable',
  antigravity_login_credential_changed: 'antigravity_login_credential_changed',
  antigravity_login_endpoint_invalid: 'antigravity_login_unavailable',
  antigravity_login_unconfigured: 'antigravity_login_unconfigured',
  antigravity_login_url_invalid: 'antigravity_login_browser_failed',
  antigravity_login_browser_failed: 'antigravity_login_browser_failed',
  claude_cli_credentials_not_found: 'auth_err_local_not_found',
  codex_cli_auth_not_found: 'auth_err_local_not_found',
  // Qoder gets its own wording: two independent stores are consulted (the IDE's
  // and the CLI's), so "no credential" has to say both were checked — users who
  // are signed into the IDE otherwise read this as the check being broken.
  qoder_client_credentials_not_found: 'auth_err_qoder_not_found',
  qoder_ide_state_not_found: 'auth_err_qoder_not_found',
  qoder_ide_not_signed_in: 'auth_err_ide_not_signed_in',
  qoder_ide_secret_unreadable: 'auth_err_ide_unreadable',
  qoder_ide_keychain_denied: 'auth_err_ide_keychain',
  qoder_ide_platform_unsupported: 'auth_err_ide_unsupported',
  qwenwork_client_credentials_not_found: 'auth_err_qwenwork_not_found',
  qwenwork_local_not_signed_in: 'auth_err_qwenwork_not_signed_in',
  qwenwork_local_secret_unreadable: 'auth_err_qwenwork_unreadable',
  qwenwork_local_state_unreadable: 'auth_err_qwenwork_unreadable',
  qwenwork_local_keychain_denied: 'auth_err_qwenwork_keychain',
  qwenwork_local_platform_unsupported: 'auth_err_qwenwork_unsupported',
  qwenwork_local_machine_id_missing: 'auth_err_qwenwork_machine_id',
  qwenwork_local_pat_requires_sign_in: 'auth_err_qwenwork_pat',
  qoderwork_client_credentials_not_found: 'auth_err_qoderwork_not_found',
  qoderwork_local_credentials_unavailable: 'auth_err_qoderwork_not_found',
  qoderwork_local_not_signed_in: 'auth_err_qoderwork_not_signed_in',
  qoderwork_local_secret_unreadable: 'auth_err_qoderwork_unreadable',
  qoderwork_local_state_unreadable: 'auth_err_qoderwork_unreadable',
  qoderwork_local_keychain_denied: 'auth_err_qoderwork_keychain',
  qoderwork_local_platform_unsupported: 'auth_err_qoderwork_unsupported',
  qoderwork_local_machine_id_missing: 'auth_err_qoderwork_machine_id',
  qoderwork_login_expired: 'auth_err_qoderwork_login_expired',
  // WorkBuddy has no keychain entry and no plaintext CLI cache: its one store is
  // encrypted under a key inside its own binary, so "not found" here means the app
  // is not installed, and the runtime codes say the delegated decryption failed.
  workbuddy_local_credentials_unavailable: 'auth_err_workbuddy_not_found',
  workbuddy_local_runtime_missing: 'auth_err_workbuddy_not_found',
  workbuddy_local_not_signed_in: 'auth_err_workbuddy_not_signed_in',
  workbuddy_local_secret_unreadable: 'auth_err_workbuddy_unreadable',
  workbuddy_local_state_unreadable: 'auth_err_workbuddy_unreadable',
  workbuddy_local_runtime_failed: 'auth_err_workbuddy_unreadable',
  workbuddy_local_runtime_incompatible: 'auth_err_workbuddy_unsupported',
  workbuddy_local_platform_unsupported: 'auth_err_workbuddy_unsupported',
  // An imported login cannot be renewed by Klaus (see the engine's refusal), so
  // the only way back is to copy the live token again.
  workbuddy_adopted_credential_needs_reimport: 'auth_err_workbuddy_needs_reimport',
  workbuddy_ip_limited: 'auth_err_workbuddy_ip_limited',
  // Kimi: the codes a credential or a device flow can answer with. The catalog's
  // signed-out and plan-too-low messages are prose by design — that path renders
  // its message directly instead of mapping it — so only these are listed.
  kimi_credential_rejected: 'auth_err_kimi_credential_rejected',
  kimi_api_key_empty: 'auth_err_kimi_api_key_empty',
  kimi_login_expired: 'auth_err_kimi_login_expired',
  kimi_local_credentials_unavailable: 'auth_err_kimi_not_found',
  kimi_login_expired_token: 'auth_err_kimi_login_expired',
  kimi_login_access_denied: 'auth_err_kimi_login_denied',
  // Bailian Token Plan. `bailian_key_not_a_plan_key` is the one that matters most:
  // Coding Plan and Token Plan keys look alike (`sk-` vs `sk-sp-`) and are not
  // interchangeable, so naming the mistake beats a generic "rejected".
  bailian_key_rejected: 'auth_err_bailian_key_rejected',
  bailian_key_not_a_plan_key: 'auth_err_bailian_not_a_plan_key',
  bailian_api_key_empty: 'auth_err_bailian_api_key_empty',
  // Only reachable from a caller that spells a site the picker does not offer, so
  // it names the mistake rather than reporting a generic failure.
  bailian_region_unknown: 'auth_err_bailian_region_unknown',
  // MiniMax M Plan. `minimax_key_not_a_subscription_key` is the one that matters
  // most: subscription keys (`sk-cp-`) and pay-as-you-go keys (`sk-api-`) look alike
  // and spend different balances, so naming the mistake beats a generic "rejected".
  minimax_key_rejected: 'auth_err_minimax_key_rejected',
  minimax_key_not_a_subscription_key: 'auth_err_minimax_not_a_subscription_key',
  minimax_api_key_empty: 'auth_err_minimax_api_key_empty',
  minimax_region_unknown: 'auth_err_minimax_region_unknown',
  // Zhipu Coding Plan. There is no "wrong key shape" code beside these: the plan
  // publishes no key grammar, so the only verdict on a key is the service's own,
  // which arrives as `zhipu_key_rejected`. A key minted on the other site fails
  // here too, and the wording says so, because the two sites look like one product.
  zhipu_key_rejected: 'auth_err_zhipu_key_rejected',
  zhipu_api_key_empty: 'auth_err_zhipu_api_key_empty',
  zhipu_region_unknown: 'auth_err_zhipu_region_unknown',
  // Volcengine Ark Coding Plan. There is no "wrong key shape" code beside these: the
  // plan publishes no key grammar, so the only verdict on a key is the service's own,
  // which arrives as `ark_key_rejected` on a real 401.
  ark_key_rejected: 'auth_err_ark_key_rejected',
  ark_api_key_empty: 'auth_err_ark_api_key_empty',
  ark_region_unknown: 'auth_err_ark_region_unknown',
  claude_cli_credentials_invalid: 'auth_err_local_invalid',
  codex_cli_auth_invalid: 'auth_err_local_invalid',
  qoder_client_credentials_invalid: 'auth_err_local_invalid',
  qwenwork_client_credentials_invalid: 'auth_err_local_invalid',
  qoderwork_client_credentials_invalid: 'auth_err_local_invalid',
  workbuddy_client_credentials_invalid: 'auth_err_local_invalid',
  claude_cli_credentials_have_no_token: 'auth_err_local_no_token',
  codex_cli_auth_has_no_tokens: 'auth_err_local_no_token',
  qoder_client_credentials_have_no_token: 'auth_err_local_no_token',
  qwenwork_client_credentials_have_no_token: 'auth_err_local_no_token',
  qoderwork_client_credentials_have_no_token: 'auth_err_local_no_token',
  workbuddy_client_credentials_have_no_token: 'auth_err_local_no_token',
  credential_store_write_failed: 'auth_err_store_write',
  credential_store_delete_failed: 'auth_err_store_delete',
}

// The host wraps engine verdicts in transport noise before the renderer sees
// them ("channel 'session:set-main-model' failed: app-server rpc error -32000:
// <code>"); the trailing stable code is the part the tables below understand,
// so peel the wrapper before falling back to the generic failure sentence.
function embeddedAuthCode(raw: string): string | undefined {
  const match = /(?:app-server rpc error -?\d+:\s*|failed:\s*)([a-z][a-z0-9_]*_[a-z0-9_]+)\s*$/u.exec(raw)
  return match ? match[1] : undefined
}

function authCodeText(mode: string, code: string, name: string): string | undefined {
  if (mode === 'kiro') {
    const known = knownKiroAuthErrorText(code, tGlobal)
    if (known) return known
  }
  if (mode === 'trae') {
    const known = knownTraeAuthErrorText(code, tGlobal)
    if (known) return known
  }
  if (mode === 'cursor') {
    const message = cursorErrorText(code, tGlobal)
    if (message !== code) return message
  }
  const antigravity = knownAntigravityErrorText(code, tGlobal)
  if (antigravity) return antigravity
  const key = AUTH_ERROR_KEYS[code]
  if (key) return tGlobal(key).replace(/\{name\}/g, name)
  return undefined
}

/** Stable host/service codes become user-facing sentences; the mode only names the source for {name} copy. */
export function authErrorTextForMode(mode: string, error: unknown): string {
  const raw = typeof error === 'string' ? error.trim() : ''
  if (!raw) return tGlobal('auth_unknown_error')
  const name = tGlobal(SUBSCRIPTION_SOURCES[mode]?.label ?? `auth_${mode}`)
  // A seats/license refusal carries the gateway's own sentence after the code, so
  // it is matched by prefix and the server's wording is kept: "retry" would be the
  // wrong advice for a seat limit, and the reason is only known server-side.
  const license = /^workbuddy_license_rejected:\d+:(.*)$/u.exec(raw)
  if (license) return `${tGlobal('auth_err_workbuddy_license')} ${license[1]}`.trim()
  const direct = authCodeText(mode, raw, name)
  if (direct) return direct
  const embedded = embeddedAuthCode(raw)
  if (embedded) {
    const mapped = authCodeText(mode, embedded, name)
    if (mapped) return mapped
  }
  // A snake_case string absent from the tables is a host-internal code a user
  // cannot read, so report a generic failure and keep the code in the console
  // for diagnosis. Spaced and punctuated text is already written for humans
  // (HTTP failures and the like), so it passes through untouched.
  if (/^[a-z0-9_]+$/.test(raw)) {
    console.warn('[Settings] unmapped auth error code:', raw)
    return tGlobal('auth_unknown_error')
  }
  return raw
}

export function authErrorText(source: SubscriptionSource, error: unknown): string {
  return authErrorTextForMode(source.mode, error)
}

export async function readSubscriptionStatus(source: SubscriptionSource): Promise<any> {
  const statusCall = source.api()?.status?.()
  if (!statusCall) return { loggedIn: false }
  try {
    return (await statusCall) || { unavailable: true }
  } catch (error) {
    console.warn('[Settings] subscription status unavailable:', error)
    return { unavailable: true }
  }
}

function noteCursorSettings(mode: string, phase: string, status: any = {}): void {
  if (mode !== 'cursor') return
  try { console.info('[CursorUiDiagnostic] ' + JSON.stringify({ phase, fields: {
    loggedIn: status.loggedIn === true, hasAccount: typeof status.account === 'string' && !!status.account,
    needsLogin: status.needsLogin === true, needsReimport: status.needsReimport === true,
  } })) } catch { /* Diagnostics cannot interrupt account updates. */ }
}

/** Account-only surfaces refresh credentials without changing conversation preferences. */
export async function activateSubscriptionMode(mode: string, reload: () => void, sessionId: string | null | undefined = w().currentSessionId, options: SubscriptionLoginOptions = {}, account?: string | null): Promise<void> {
  // The source activation write remounts the settings tab; seed the cache with
  // the state this success establishes so the remounted card does not paint
  // the pre-login row (or a skeleton) while the confirming read is in flight.
  const status = { ...(subscriptionStatusCache.get(mode) || {}), loggedIn: true }
  if (account !== undefined) status.account = account
  if (mode === 'workbuddy' && options.workbuddyRegion) status.region = options.workbuddyRegion
  delete status.needsReimport
  delete status.needsLogin
  delete status.error
  subscriptionStatusCache.set(mode, status)
  noteCursorSettings(mode, 'login_cache_published', status)
  // The credential is already saved. Publish that state before model resolution,
  // which can fail independently or take longer than the account operation.
  reload()
  if (options.activateModel !== false) {
    noteCursorSettings(mode, 'model_activation_begin', status)
    await activateModelSource(mode, sessionId)
    noteCursorSettings(mode, 'model_activation_complete', status)
  }
  else window.dispatchEvent(new Event('klaus:auth-mode-changed'))
}

async function completeSubscriptionLogin(source: SubscriptionSource, result: any, setStatus: (text: string) => void, reload: () => void, sessionId: string | null | undefined, options: SubscriptionLoginOptions): Promise<void> {
  try {
    await activateSubscriptionMode(source.mode, reload, sessionId, options, typeof result?.account === 'string' ? result.account : null)
  } catch (error: any) {
    noteCursorSettings(source.mode, 'model_activation_failed', result)
    setStatus(tGlobal('auth_switch_failed_prefix') + authErrorText(source, error?.message || String(error)))
  }
}

export async function importLocalSubscription(source: SubscriptionSource, setStatus: (text: string) => void, reload: () => void, options: SubscriptionLoginOptions = {}): Promise<void> {
  if (!source.importLabel || !source.importConfirm || !source.importing || !source.importSuccess || !source.importFailedPrefix) {
    throw new Error('This source does not support local account import')
  }
  if (!(await w().klausDialog.confirm({
    message: source.mode === 'workbuddy' && options.workbuddyRegion
      ? tGlobal('workbuddy_import_confirm_edition').replace('{edition}', tGlobal(`workbuddy_region_${options.workbuddyRegion}`))
      : tGlobal(source.importConfirm),
    confirmText: tGlobal(source.importLabel),
  }))) return
  if (source.mode === 'antigravity' || source.mode === 'trae' || source.mode === 'kiro') await cancelAntigravityBrowserLogin(source.mode)
  setStatus(tGlobal(source.importing))
  const result = source.mode === 'workbuddy'
    ? await source.api().importLocal(options.workbuddyRegion)
    : await source.api().importLocal()
  if (result?.ok !== true) {
    setStatus(tGlobal(source.importFailedPrefix) + authErrorText(source, result?.error))
    return
  }
  setStatus(result.updatedExisting ? tGlobal('sub_account_updated') : tGlobal(source.importSuccess))
  await completeSubscriptionLogin(source, result, setStatus, reload, undefined, options)
}

export async function loginThroughHost(source: SubscriptionSource, setStatus: (text: string) => void, reload: () => void, options: SubscriptionLoginOptions = {}): Promise<void> {
  setStatus(tGlobal(source.loginOpening))
  const res = await source.api().login()
  if (res?.ok) {
    // Re-logging an account already in the queue refreshes its credential
    // instead of stacking a second row; say which happened.
    if (res.updatedExisting) setStatus(tGlobal('sub_account_updated'))
    await completeSubscriptionLogin(source, res, setStatus, reload, undefined, options)
    return
  }
  setStatus(tGlobal('auth_login_failed_prefix') + authErrorText(source, res?.error))
}

const activeCursorLogins = new Map<string, { flowId?: string; cancelled: boolean }>()

export async function cancelCursorLogin(): Promise<void> {
  const pending = activeCursorLogins.get('cursor')
  if (!pending) return
  pending.cancelled = true
  if (pending.flowId) await SUBSCRIPTION_SOURCES.cursor.api().cancel(pending.flowId)
}

export async function loginThroughDeviceFlow(source: SubscriptionSource, setStatus: (text: string) => void, reload: () => void, options: SubscriptionLoginOptions = {}): Promise<void> {
  if (source.mode === 'antigravity' || source.mode === 'trae' || source.mode === 'kiro') return loginThroughAntigravityFlow(source, setStatus, reload, options)
  const sessionId = w().currentSessionId ?? null
  const pending = { flowId: undefined as string | undefined, cancelled: false }
  if (source.mode === 'cursor') activeCursorLogins.set('cursor', pending)
  const isCurrent = () => source.mode !== 'cursor' || (!pending.cancelled && activeCursorLogins.get('cursor') === pending)
  try {
    setStatus(tGlobal(source.loginOpening))
    const flow = source.mode === 'workbuddy'
      ? await source.api().start(options.workbuddyRegion)
      : await source.api().start()
    pending.flowId = flow?.flowId
    if (!isCurrent()) {
      if (pending.flowId && source.mode === 'cursor') await source.api().cancel(pending.flowId)
      return
    }
    if (!flow?.ok) {
      setStatus(tGlobal('auth_login_failed_prefix') + authErrorText(source, flow?.error))
      return
    }
    if (source.deviceHint) setStatus(source.deviceHint(flow))
    await pollDeviceFlow(source, flow, setStatus, reload, { ...options, isCurrent, sessionId })
  } finally {
    if (activeCursorLogins.get('cursor') === pending) activeCursorLogins.delete('cursor')
  }
}


interface PendingBrowserLogin { flowId?: string; cancelled: boolean }
const activeAntigravityLogins = new Map<string, PendingBrowserLogin>()

async function cancelAntigravityBrowserLogin(mode: string): Promise<void> {
  const pending = activeAntigravityLogins.get(mode)
  if (!pending) return
  pending.cancelled = true
  activeAntigravityLogins.delete(mode)
  if (pending.flowId) await SUBSCRIPTION_SOURCES[mode].api().cancel(pending.flowId)
}

export async function cancelAntigravityLogin(): Promise<void> {
  await cancelAntigravityBrowserLogin('antigravity')
}

export async function cancelTraeLogin(): Promise<void> {
  await cancelAntigravityBrowserLogin('trae')
}

export async function cancelKiroLogin(): Promise<void> {
  await cancelAntigravityBrowserLogin('kiro')
}

async function loginThroughAntigravityFlow(source: SubscriptionSource, setStatus: (text: string) => void, reload: () => void, options: SubscriptionLoginOptions = {}): Promise<void> {
  const sessionId = w().currentSessionId ?? null
  const pending: PendingBrowserLogin = { cancelled: false }
  const cancellable = source.mode === 'antigravity' || source.mode === 'trae' || source.mode === 'kiro'
  if (cancellable) {
    const previous = activeAntigravityLogins.get(source.mode)
    if (previous) {
      previous.cancelled = true
      if (previous.flowId) void source.api().cancel(previous.flowId).catch((error: unknown) => console.warn('[Settings] superseded login cancellation failed:', error))
    }
    activeAntigravityLogins.set(source.mode, pending)
  }
  const isCurrent = () => !cancellable || (!pending.cancelled && activeAntigravityLogins.get(source.mode) === pending)
  const complete = () => {
    if (activeAntigravityLogins.get(source.mode) === pending) activeAntigravityLogins.delete(source.mode)
  }
  try {
    setStatus(tGlobal(source.loginOpening))
    const flow = source.mode === 'workbuddy'
      ? await source.api().start(options.workbuddyRegion)
      : await source.api().start()
    pending.flowId = flow?.flowId
    if (!isCurrent()) {
      if (pending.flowId && cancellable) await source.api().cancel(pending.flowId)
      return
    }
    if (!flow?.ok) {
      setStatus(tGlobal('auth_login_failed_prefix') + authErrorText(source, flow?.error))
      return
    }
    if (source.deviceHint) setStatus(source.deviceHint(flow))
    await pollDeviceFlow(source, flow, setStatus, reload, { ...options, isCurrent, sessionId, onCompleted: complete })
  } finally {
    if (activeAntigravityLogins.get(source.mode) === pending) {
      activeAntigravityLogins.delete(source.mode)
      if (cancellable && pending.flowId) await source.api().cancel(pending.flowId)
    }
  }
}

export async function pollDeviceFlow(source: SubscriptionSource, flow: any, setStatus: (text: string) => void, reload: () => void, options: {
  isCurrent?: () => boolean; sessionId?: string | null; activateModel?: boolean; onCompleted?: () => void
} = {}): Promise<void> {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const isCurrent = options.isCurrent || (() => true)
  const intervalMs = Math.max(1, flow.interval || 5) * 1000
  while (Date.now() < flow.expiresAt && isCurrent()) {
    await wait(intervalMs)
    if (!isCurrent()) return
    const res = await source.api().poll(flow.deviceCode || flow.flowId)
    if (!isCurrent()) return
    if (res?.ok) {
      // Source activation can remount this card; the committed flow must no longer
      // belong to its unmount cancellation handler.
      options.onCompleted?.()
      setStatus(tGlobal('auth_please_resend'))
      await completeSubscriptionLogin(source, res, setStatus, reload, options.sessionId, options)
      return
    }
    if (res?.pending) continue
    setStatus(tGlobal('auth_login_failed_prefix') + authErrorText(source, res?.error))
    return
  }
  if (isCurrent()) setStatus(tGlobal(source.deviceExpired!))
}

export function SubscriptionCardBody({ mode, reloadSeq, reload, activateModelOnLogin = true }: { mode: string; reloadSeq: number; reload: () => void; activateModelOnLogin?: boolean }) {
  const t = useT()
  const source = SUBSCRIPTION_SOURCES[mode]
  // Seeded from the cross-remount cache: a remount paints the last known
  // credential state instead of a skeleton, and the read below confirms it.
  const [status, setStatus] = useState<any>(() => subscriptionStatusCache.get(mode) ?? null)
  const [statusMsg, setStatusMsg] = useState('')
  const [logoutError, setLogoutError] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const authActionBusyRef = useRef(false)
  const [importBusy, setImportBusy] = useState(false)
  // Declared unconditionally, ahead of the loading early-return below, so the hook
  // order does not depend on whether a status read has landed.
  const [apiKey, setApiKey] = useState('')
  // The host choice: a base URL for a `freeText` host, a site code for a `select`
  // one. A select defaults to its first option rather than empty, because an unset
  // site would silently mean "whichever the engine happens to pick" while the field
  // showed a value.
  const [hostValue, setHostValue] = useState(
    () => SUBSCRIPTION_SOURCES[mode]?.apiKey?.host?.kind === 'select'
      ? SUBSCRIPTION_SOURCES[mode].apiKey!.host.options[0].value
      : '',
  )
  const [savingKey, setSavingKey] = useState(false)
  // The optional console session beside the plan key: it is what unlocks the
  // allowance figures, so the card shows its own connected state and sign-in row.
  const [consoleState, setConsoleState] = useState<{ loggedIn: boolean } | null>(() => consoleSessionCache.get(mode) ?? null)
  const [consoleBusy, setConsoleBusy] = useState(false)
  // Which console page mints this source's key. Two sites means two pages, so the
  // link follows the site the user picked; a source with one console (or a site the
  // map does not name) falls back to its single URL.
  const consoleUrl = source.apiKey?.consoleUrlBySite?.[hostValue] || source.apiKey?.consoleUrl || ''

  useEffect(() => {
    let cancelled = false
    setLogoutError('')
    const cached = subscriptionStatusCache.get(mode)
    if (cached) setStatus(cached)
    noteCursorSettings(mode, 'status_read_begin', cached)
    void readSubscriptionStatus(source).then(next => {
      if (cancelled) return
      subscriptionStatusCache.set(mode, next)
      setStatus(next)
      noteCursorSettings(mode, 'status_applied', next)
    })
    return () => { cancelled = true }
  }, [mode, reloadSeq])

  useEffect(() => {
    if (!source.consoleSession) return
    let cancelled = false
    const read = () => {
      const call = source.api()?.consoleStatus?.()
      if (!call) return
      void call.then((next: any) => {
        if (cancelled) return
        const state = { loggedIn: next?.loggedIn === true }
        consoleSessionCache.set(mode, state)
        setConsoleState(state)
      }).catch(() => {})
    }
    read()
    return () => { cancelled = true }
  }, [mode, reloadSeq])

  useEffect(() => () => {
    // Cursor authorization belongs to the account flow and survives card refresh.
    // The explicit cancel action still cancels its pending browser authorization.
    if (mode === 'antigravity' || mode === 'trae' || mode === 'kiro') {
      void cancelAntigravityBrowserLogin(mode).catch(error => console.warn('[Settings] browser login cancellation failed:', error))
    }
  }, [mode])

  if (!status) return <Loading />

  const prefix = source.idPrefix
  const signedIn = status.loggedIn && !(['antigravity', 'trae', 'kiro'].includes(mode) && status.needsLogin === true)

  const onLogin = async (workbuddyRegion?: 'cn' | 'intl') => {
    if (authActionBusyRef.current) return
    authActionBusyRef.current = true
    setLogoutError('')
    setLoginBusy(true)
    try {
      await source.login(source, setStatusMsg, reload, {
        activateModel: activateModelOnLogin,
        ...(mode === 'workbuddy' ? { workbuddyRegion } : {}),
      })
    } catch (err: any) {
      setStatusMsg(t('auth_login_failed_prefix') + authErrorText(source, err?.message || String(err)))
    } finally { authActionBusyRef.current = false; setLoginBusy(false) }
  }

  const onImport = async (workbuddyRegion?: 'cn' | 'intl') => {
    if (authActionBusyRef.current) return
    authActionBusyRef.current = true
    setLogoutError('')
    setImportBusy(true)
    try {
      await importLocalSubscription(source, setStatusMsg, reload, {
        activateModel: activateModelOnLogin,
        ...(mode === 'workbuddy' ? { workbuddyRegion } : {}),
      })
    } catch (error: any) {
      setStatusMsg(t(source.importFailedPrefix!) + authErrorText(source, error?.message || String(error)))
    } finally {
      authActionBusyRef.current = false
      setImportBusy(false)
    }
  }

  const onLogout = async () => {
    if (!(await w().klausDialog.confirm(t(source.confirmLogout)))) return
    setLogoutError('')
    try {
      const result = await source.api().logout()
      if (result?.ok !== true) throw new Error(result?.error || '')
      // The auth-mode write remounts the settings tab; seed the signed-out
      // state so the remounted card does not paint the old logged-in row.
      subscriptionStatusCache.set(mode, { loggedIn: false })
      window.dispatchEvent(new Event('klaus:auth-mode-changed'))
      reload()
    } catch (error: any) {
      const message = authErrorText(source, error?.message)
      setLogoutError(message === t('auth_unknown_error') ? t('profile_logout_failed') : message)
    }
  }

  const accounts: Array<{ id: string; email: string; displayName: string; isCurrent: boolean }> =
    source.mode === 'subscription' && Array.isArray(status.accounts) ? status.accounts : []

  const onRemoveAccount = async (accountId: string) => {
    if (!(await w().klausDialog.confirm(t('sub_account_remove_confirm')))) return
    try {
      const result = await source.api().logout(accountId)
      if (result?.ok !== true) throw new Error(authErrorText(source, result?.error))
      reload()
    } catch (error: any) {
      setStatusMsg(settingsErrorText('profile-logout', error, 'profile_logout_failed'))
    }
  }

  const onSaveApiKey = async () => {
    const spec = source.apiKey
    if (!spec) return
    const key = apiKey.trim()
    if (!key) { setStatusMsg(t(spec.failedPrefixKey) + t(spec.placeholderKey)); return }
    setSavingKey(true)
    setStatusMsg(t(spec.savingKey))
    try {
      // The second argument means "which host" for both shapes: a base URL Kimi
      // accepts verbatim, or a site code Token Plan maps onto its one region.
      // Empty is omitted rather than sent, so the engine keeps whatever the stored
      // credential already belongs to instead of moving it.
      const host = hostValue.trim()
      const result = await source.api().setApiKey(key, host || undefined)
      if (result?.ok !== true && result?.loggedIn !== true) {
        setStatusMsg(t(spec.failedPrefixKey) + authErrorText(source, result?.error))
        return
      }
      // The key is stored; never keep it in the field or echo it back.
      setApiKey('')
      setStatusMsg(t(spec.savedKey))
      await activateSubscriptionMode(source.mode, reload, undefined, { activateModel: activateModelOnLogin })
    } catch (err: any) {
      setStatusMsg(t(spec.failedPrefixKey) + (err?.message || String(err)))
    } finally {
      setSavingKey(false)
    }
  }

  const onConsoleLogin = async () => {
    const spec = source.consoleSession
    if (!spec) return
    setConsoleBusy(true)
    setStatusMsg(t(spec.openingKey))
    try {
      await source.api().consoleLogin()
      // The browser round trip runs on the user's clock: poll the stored-session
      // state until it lands or the engine's login window closes.
      setStatusMsg(t(spec.waitingKey))
      const deadline = Date.now() + 300_000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        const next = await source.api().consoleStatus()
        if (next?.loggedIn === true) {
          const state = { loggedIn: true }
          consoleSessionCache.set(mode, state)
          setConsoleState(state)
          setStatusMsg(t(spec.doneKey))
          reload()
          return
        }
      }
      setStatusMsg(t(spec.failedPrefixKey) + t(spec.waitingKey))
    } catch (err: any) {
      setStatusMsg(t(spec.failedPrefixKey) + (err?.message || String(err)))
    } finally {
      setConsoleBusy(false)
    }
  }

  const onConsoleLogout = async () => {
    const spec = source.consoleSession
    if (!spec) return
    if (!(await w().klausDialog.confirm(t(spec.confirmLogoutKey)))) return
    try {
      await source.api().consoleLogout()
      const state = { loggedIn: false }
      consoleSessionCache.set(mode, state)
      setConsoleState(state)
      reload()
    } catch (err: any) {
      setStatusMsg(err?.message || String(err))
    }
  }

  // The row under the key block. It is `null` for a signed-out key-only source with
  // no login to offer (Token Plan), where rendering an empty `card-actions` div would
  // leave a band of stray spacing under the key field.
  const actions = status.unavailable
    ? <button className="btn-sm" onClick={reload}>{t('auth_status_retry')}</button>
    : accounts.length > 0
      // Queued sources can add or refresh another account.
      ? <>
          <button className="btn-xs btn-danger" id={`${prefix}-logout-btn`} onClick={() => { void onLogout() }}>{t(source.logoutLabel)}</button>
          {' '}
          <button className="btn-sm" id={`${prefix}-login-btn`} disabled={loginBusy || importBusy} onClick={() => { void onLogin() }}>{t(source.loginLabel)}</button>
          {' '}
          {source.importLabel ? <button className="btn-sm" id={`${prefix}-import-btn`} disabled={importBusy || loginBusy} onClick={() => { void onImport() }}>{t(source.importLabel)}</button> : null}
        </>
      : signedIn
      ? <button className="btn-xs btn-danger" id={`${prefix}-logout-btn`} disabled={loginBusy} onClick={() => { void onLogout() }}>{t(source.logoutLabel)}</button>
      : source.apiKey
        // A source with a key field but no `device` block (Token Plan) shows the key
        // entry alone: there is no login it could offer. A source WITH one (Kimi)
        // keeps the login as the alternative beside the documented route, stating the
        // risk that route carries.
        ? source.apiKey.device
          ? <>
              <button className="btn-sm" id={`${prefix}-login-btn`} disabled={loginBusy || importBusy} onClick={() => { void onLogin() }}>{t(source.apiKey.device.labelKey)}</button>
              <span className={styles['api-key-device-risk']}>{t(source.apiKey.device.riskKey)}</span>
            </>
          : null
        : mode === 'workbuddy' ? <>
            {(['cn', 'intl'] as const).map(region => <button key={`login-${region}`} className="btn-sm btn-primary"
              id={`${prefix}-login-${region}-btn`} disabled={loginBusy || importBusy}
              onClick={() => { void onLogin(region) }}>{t(`workbuddy_login_${region}_btn`)}</button>)}
            {(['cn', 'intl'] as const).map(region => <button key={`import-${region}`} className="btn-sm"
              id={`${prefix}-import-${region}-btn`} disabled={loginBusy || importBusy}
              onClick={() => { void onImport(region) }}>{t(`workbuddy_import_${region}_btn`)}</button>)}
          </> : <>
            <button className="btn-sm btn-primary" id={`${prefix}-login-btn`} disabled={loginBusy || importBusy} onClick={() => { void onLogin() }}>{t(source.loginLabel)}</button>
            {' '}
            {source.importLabel ? <button className="btn-sm" id={`${prefix}-import-btn`} disabled={importBusy || loginBusy} onClick={() => { void onImport() }}>{t(source.importLabel)}</button> : null}
          </>

  return (
    <div className="settings-card" id={`${prefix}-card`}>
      <div className="card-header">
        {status.unavailable
          ? <strong>{t('auth_status_unavailable')}</strong>
          : signedIn
          ? accounts.length > 1
            // The queue below already names every account, head included;
            // repeating the head email up here would show one address twice,
            // so a queued login headlines its account count instead.
            ? <><strong>{t('sub_accounts_count').replace('{count}', String(accounts.length))}</strong><span className="badge">{t('auth_logged_in')}</span></>
            : <><strong>{status.account || t(source.accountFallback)}</strong><span className="badge">{t('auth_logged_in')}</span></>
          : <strong>{t(source.notLoggedIn)}</strong>}
        {mode === 'workbuddy' && status.loggedIn && (status.region === 'cn' || status.region === 'intl')
          ? <span className="badge">{t(`workbuddy_region_${status.region}`)}</span> : null}
        {mode === 'bailian' && signedIn && status.subscriptionState === 'expired'
          ? <span className="badge">{t('bailian_subscription_expired_badge')}</span> : null}
      </div>
      {mode === 'antigravity' && status.needsLogin === true ? <p role="alert" className="card-meta">{t('antigravity_login_expired')}</p> : null}
      {mode === 'trae' && status.needsLogin === true ? <p role="alert" className="card-meta">{t('trae_login_expired')}</p> : null}
      {mode === 'bailian' && signedIn && status.subscriptionState === 'expired'
        ? <p role="alert" className="card-meta">{t('bailian_subscription_expired')}</p> : null}
      {mode === 'bailian' && signedIn && status.subscriptionState === 'invalid_key'
        ? <p role="alert" className="card-meta">{t('bailian_key_invalid')}</p> : null}
      {accounts.length > 1 ? (
        <div className={styles['account-list']} id={`${prefix}-account-list`}>
          {accounts.map(row => (
            <div className={styles['account-row']} key={row.id} data-account-id={row.id}>
              <span className={styles['account-row-name']}>{row.email || row.displayName || t(source.accountFallback)}</span>
              {row.isCurrent ? <span className="badge">{t('sub_account_current')}</span> : null}
              <button
                className="btn-xs btn-danger"
                aria-label={t('sub_account_remove')}
                onClick={() => { void onRemoveAccount(row.id) }}
              >{t('sub_account_remove')}</button>
            </div>
          ))}
        </div>
      ) : null}
      {source.apiKey && !status.loggedIn ? (
        <div className={styles['api-key-block']} id={`${prefix}-apikey-block`}>
          <div className="form-row">
            <label htmlFor={`${prefix}-apikey-input`}>{t(source.apiKey.labelKey)}</label>
            <input
              id={`${prefix}-apikey-input`} type="password" autoComplete="off"
              data-1p-ignore data-lpignore="true"
              placeholder={t(source.apiKey.placeholderKey)}
              value={apiKey} onChange={event => setApiKey(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void onSaveApiKey() }}
            />
          </div>
          {source.apiKey.host?.kind === 'freeText' ? (
            <div className="form-row">
              <label htmlFor={`${prefix}-host-input`}>{t(source.apiKey.host.baseLabelKey)}</label>
              <input
                id={`${prefix}-host-input`} type="text" autoComplete="off"
                placeholder={source.apiKey.host.basePlaceholder}
                value={hostValue} onChange={event => setHostValue(event.target.value)}
              />
            </div>
          ) : null}
          {source.apiKey.host?.kind === 'select' ? (
            <div className="form-row">
              <label htmlFor={`${prefix}-host-select`}>{t(source.apiKey.host.labelKey)}</label>
              <KlsSelect
                id={`${prefix}-host-select`} className="kls-select kls-select-block"
                items={source.apiKey.host.options.map(option => ({ value: option.value, i18nKey: option.labelKey }))}
                value={hostValue} bindKey={`host-${mode}`}
                onChange={setHostValue}
              />
            </div>
          ) : null}
          <div className={styles['api-key-actions']}>
            <button className="btn-sm btn-primary" id={`${prefix}-apikey-save-btn`} disabled={savingKey} onClick={() => { void onSaveApiKey() }}>
              {savingKey ? t(source.apiKey.savingKey) : t(source.apiKey.saveKey)}
            </button>
            <a
              className={styles['api-key-console-link']} href={consoleUrl}
              onClick={event => { event.preventDefault(); void w().klaus.app?.openExternal?.(consoleUrl) }}
            >
              {t(source.apiKey.consoleLabelKey)}
            </a>
          </div>
        </div>
      ) : null}
      {source.consoleSession && status.loggedIn ? (
        <div className={styles['api-key-block']} id={`${prefix}-console-block`}>
          <div className={styles['api-key-actions']}>
            {consoleState?.loggedIn ? (
              <>
                <span className={styles['api-key-console-link']}>{t(source.consoleSession.connectedKey)}</span>
                <button className="btn-xs btn-danger" id={`${prefix}-console-logout-btn`} onClick={() => { void onConsoleLogout() }}>{t(source.consoleSession.logoutLabelKey)}</button>
              </>
            ) : (
              <>
                <button className="btn-sm" id={`${prefix}-console-login-btn`} disabled={consoleBusy} onClick={() => { void onConsoleLogin() }}>{t(source.consoleSession.loginLabelKey)}</button>
                <span className={styles['api-key-device-risk']}>{t(source.consoleSession.hintKey)}</span>
              </>
            )}
          </div>
        </div>
      ) : null}
      {actions ? (
        <div className="card-actions">
          {actions}
        </div>
      ) : null}
      {logoutError ? <div role="alert" className={styles['settings-status-text']}>{logoutError}</div> : null}
      {mode === 'cursor' && loginBusy ? <div className="card-actions"><button className="btn-sm" id="cursor-auth-cancel-btn" onClick={() => { void cancelCursorLogin().then(() => setStatusMsg(t('cursor_auth_cancelled'))).catch(error => setStatusMsg(authErrorText(source, error?.message || String(error)))) }}>{t('cancel')}</button></div> : null}
      {(!['antigravity', 'trae', 'kiro'].includes(mode) || !signedIn) && status.error ? <div className={styles['settings-status-text']}>{authErrorText(source, status.error)}</div>
        : mode === 'cursor' && status.needsLogin ? <div className={styles['settings-status-text']}>{t('cursor_browser_login_expired')}</div>
        : mode === 'cursor' && status.needsReimport ? <div className={styles['settings-status-text']}>{status.reason ? authErrorText(source, status.reason) : t('cursor_import_expired')}</div> : null}
      {!['antigravity', 'trae', 'kiro'].includes(mode) || !signedIn ? <div id={`${prefix}-login-status`} className={styles['settings-status-text']}>{statusMsg}</div> : null}
    </div>
  )
}

export function Loading() {
  return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
}
