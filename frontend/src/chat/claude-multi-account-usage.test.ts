import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { cursorErrorText } from '../app/cursor-errors'
import { I18N } from '../i18n/messages'

// The subscription usage popover shows one block per stored account when the
// login carries a queue, and falls back to the single block otherwise. These
// cases pin both shapes against the production renderer.
const source = ts.createSourceFile('chat.ts', readFileSync(new URL('./chat.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const names = ['renderUsageBarRow', 'renderUsageWindows', 'renderUsageCredits', 'renderUsageExtra', 'renderUsageProvider', 'renderUsageSnapshot', 'USAGE_MODE_PROVIDER_KEYS', 'USAGE_PRESET_MODE_NAMES']
const code = ts.transpileModule(
  names.map(name => {
    const node = source.statements.find((statement): statement is ts.FunctionDeclaration | ts.VariableStatement =>
      (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
      || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name)))
    if (!node) throw new Error(`The production usage renderer must be identifiable: ${name}`)
    return node.getText(source)
  }).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText

function usageRenderer(translate: (key: string) => string = key => key, language: 'en' | 'zh' = 'en') {
  return runInNewContext(`${code}\n({ renderUsageSnapshot })`, {
  escapeHtml: (text: string) => String(text),
  cursorErrorText,
  usageWindowLabel: (window: { label?: string; id?: string }) => window.label || window.id || 'Five hour window',
  usageFormatTime: (time?: number) => time === undefined ? '' : 'billing-cycle-reset',
  tt: translate,
  window: { currentLang: language },
}) as {
  renderUsageSnapshot(snapshot: { mode: string; provider?: Record<string, unknown> }): string
}
}

const renderer = usageRenderer()
const qwenworkErrors = JSON.parse(readFileSync(new URL('../../../contracts/vectors/qwenwork-usage-error-vectors.json', import.meta.url), 'utf8')) as {
  cases: Array<{ expected: string; translation?: string }>
}

test('QwenWork renewal failures tell users to sign in again in both languages', () => {
  for (const language of ['en', 'zh'] as const) {
    const translated = usageRenderer(key => I18N[language][key as keyof typeof I18N.en] || key, language)
    for (const row of qwenworkErrors.cases.filter(row => row.translation)) {
      const snapshot = { mode: 'qwenwork', provider: { state: 'error', error: row.expected } }
      const html = translated.renderUsageSnapshot(snapshot)
      expect(html).toContain(I18N[language][row.translation as keyof typeof I18N.en])
      expect(html).not.toContain(row.expected)
      expect(snapshot.provider.error).toBe(row.expected)
    }
  }
})
const extraUsageVectors = JSON.parse(readFileSync(new URL('../../../contracts/vectors/claude-extra-usage-vectors.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; expected?: { billing: 'extraCredits'; enabled?: boolean; monthlyLimit?: number; usedCredits?: number } }>
}

describe('subscription extra usage', () => {
  for (const language of ['en', 'zh'] as const) {
    const localized = usageRenderer(key => I18N[language][key] || key, language)
    for (const row of extraUsageVectors.cases) test(`${row.name} renders separately in ${language}`, () => {
      const html = localized.renderUsageSnapshot({ mode: 'subscription', provider: {
        state: 'ok', windows: [{ usedPercent: 42 }], ...(row.expected ? { extraUsage: row.expected } : {}),
      } })
      expect(html.match(/class="usage-bar-fill/g)?.length).toBe(1)
      expect(html).toContain(`58% ${I18N[language].usage_remaining}`)
      expect(html).not.toContain('$')
      if (!row.expected) {
        expect(html).not.toContain('class="usage-extra"')
        return
      }
      expect(html.match(/class="usage-extra"/g)?.length).toBe(1)
      expect(html).toContain(I18N[language].usage_extra_title)
      expect(html).toContain(I18N[language].usage_extra_billing)
      if (row.expected.enabled !== undefined) expect(html).toContain(I18N[language][row.expected.enabled ? 'usage_extra_enabled' : 'usage_extra_disabled'])
      else {
        expect(html).not.toContain(I18N[language].usage_extra_enabled)
        expect(html).not.toContain(I18N[language].usage_extra_disabled)
      }
      for (const [key, amount] of [['usage_extra_used', row.expected.usedCredits], ['usage_extra_monthly_limit', row.expected.monthlyLimit]] as const) {
        if (amount === undefined) expect(html).not.toContain(I18N[language][key])
        else expect(html).toContain(`${I18N[language][key]}: ${amount} ${I18N[language].usage_extra_credit_unit}`)
      }
    })
    test(`each account shows only its own extra usage in ${language}`, () => {
      const html = localized.renderUsageSnapshot({ mode: 'subscription', provider: { state: 'ok', accounts: [
        { id: 'one', label: 'One', state: 'ok', windows: [{ usedPercent: 10 }], extraUsage: { billing: 'extraCredits', usedCredits: 1.25 } },
        { id: 'two', label: 'Two', state: 'ok', windows: [{ usedPercent: 20 }], extraUsage: { billing: 'extraCredits', enabled: false, monthlyLimit: 200 } },
        { id: 'three', label: 'Three', state: 'error', error: 'Unavailable', extraUsage: { billing: 'extraCredits', usedCredits: 999 } },
      ] } })
      const blocks = html.split('class="usage-account"').slice(1)
      expect(blocks.length).toBe(3)
      expect(blocks[0]).toContain('1.25 credits')
      expect(blocks[0]).not.toContain('200 credits')
      expect(blocks[1]).toContain('200 credits')
      expect(blocks[1]).not.toContain('1.25 credits')
      expect(blocks[2]).not.toContain('class="usage-extra"')
      expect(html.match(/class="usage-bar-fill/g)?.length).toBe(2)
    })
    test(`small native credit amounts stay nonzero in ${language}`, () => {
      const html = localized.renderUsageSnapshot({ mode: 'subscription', provider: {
        state: 'ok', windows: [], extraUsage: { billing: 'extraCredits', usedCredits: 1e-22 },
      } })
      expect(html).toContain('0.0000000000000000000001 credits')
      expect(html).not.toContain('$')
      expect(html).not.toContain('usage-bar-fill')
    })
  }
})

describe('multi-account subscription usage', () => {
  test('each stored account keeps its own block and the head is marked current', () => {
    const html = renderer.renderUsageSnapshot({
      mode: 'subscription',
      provider: {
        state: 'ok',
        windows: [{ usedPercent: 100 }],
        accounts: [
          { id: 'a', label: 'first@example.test', isCurrent: true, state: 'ok', windows: [{ usedPercent: 100 }] },
          { id: 'b', label: 'second@example.test', isCurrent: false, state: 'error', error: 'Usage request timed out' },
        ],
      },
    })
    expect(html).toContain('first@example.test')
    expect(html).toContain('second@example.test')
    // One provider block per account, not one for the whole source.
    expect(html.match(/class="usage-account"/g)?.length).toBe(2)
    expect(html).toContain('usage_account_current')
    // A failing account shows its own error without blanking the queue.
    expect(html).toContain('usage_error')
    expect(html).toContain('Usage request timed out')
    // The exhausted head still renders its windows.
    expect(html).toContain('usage-bar-fill')
  })

  test('a single-account snapshot without the queue keeps the legacy single block', () => {
    const html = renderer.renderUsageSnapshot({
      mode: 'subscription',
      provider: { state: 'ok', windows: [{ usedPercent: 42 }] },
    })
    expect(html.match(/class="usage-provider"/g)?.length).toBe(1)
    expect(html).toContain('usage_provider_claude')
    expect(html).not.toContain('usage_account_current')
  })

  test('a failed head cannot hide healthy accounts or duplicate the aggregate error', () => {
    const html = renderer.renderUsageSnapshot({
      mode: 'subscription',
      provider: {
        state: 'error',
        error: 'Usage request failed (HTTP 401)',
        accounts: [
          { id: 'a', label: 'first@example.test', isCurrent: true, state: 'error', error: 'Usage request failed (HTTP 401)' },
          { id: 'b', label: 'second@example.test', isCurrent: false, state: 'ok', windows: [{ usedPercent: 42 }] },
        ],
      },
    })
    expect(html.match(/class="usage-account"/g)?.length).toBe(2)
    expect(html).toContain('first@example.test')
    expect(html).toContain('second@example.test')
    expect(html).toContain('usage_account_current')
    expect(html).toContain('58% usage_remaining')
    expect(html.match(/Usage request failed \(HTTP 401\)/g)?.length).toBe(1)
  })

  test('a failed source without account rows still shows the aggregate error', () => {
    const html = renderer.renderUsageSnapshot({
      mode: 'subscription',
      provider: { state: 'error', error: 'Usage request failed (HTTP 401)' },
    })
    expect(html).toContain('Usage request failed (HTTP 401)')
    expect(html).not.toContain('class="usage-account"')
  })

  test('an empty queue reads as signed out rather than an empty list', () => {
    const html = renderer.renderUsageSnapshot({
      mode: 'subscription',
      provider: { state: 'signed_out', accounts: [] },
    })
    expect(html).toContain('usage_signed_out')
  })
})


describe('Cursor subscription usage', () => {
  test('renders plan percentage windows as remaining allowance with billing-cycle resets', () => {
    const html = renderer.renderUsageSnapshot({ mode: 'cursor', provider: {
      state: 'ok', plan: 'Pro', windows: [
        { id: 'cursor_total', usedPercent: 42, resetsAt: 1_800_000_000_000 },
        { id: 'cursor_api', usedPercent: 95 },
      ],
    } })
    expect(html).toContain('usage_provider_cursor')
    expect(html).toContain('Pro')
    expect(html).toContain('cursor_total')
    expect(html).toContain('cursor_api')
    expect(html).toContain('58% usage_remaining')
    expect(html).toContain('5% usage_remaining')
    expect(html).toContain('billing-cycle-reset')
    expect(html).not.toContain('usage_byok_metered')
  })

  test('missing allowance windows never imply unlimited or metered token billing', () => {
    const html = renderer.renderUsageSnapshot({ mode: 'cursor', provider: { state: 'ok', quotaAvailable: false, windows: [] } })
    expect(html).toContain('usage_no_windows')
    expect(html).not.toContain('usage_unlimited')
    expect(html).not.toContain('usage_byok_metered')
    expect(html).not.toContain('usage-bar-fill')
  })

  test('signed-out and failed quota reads retain their provider and actionable state', () => {
    const signedOut = renderer.renderUsageSnapshot({ mode: 'cursor', provider: { state: 'signed_out' } })
    expect(signedOut).toContain('usage_provider_cursor')
    expect(signedOut).toContain('usage_signed_out')
    const failed = renderer.renderUsageSnapshot({ mode: 'cursor', provider: { state: 'error', error: 'Account usage request failed (HTTP 403)' } })
    expect(failed).toContain('usage_provider_cursor')
    expect(failed).toContain('usage_error')
    expect(failed).toContain('Account usage request failed (HTTP 403)')
    expect(failed).not.toContain('usage-bar-fill')
  })
})


for (const language of ['en', 'zh'] as const) {
  test(`Cursor quota errors share localized recovery copy and hide internal codes in ${language}`, () => {
    const localized = usageRenderer(key => I18N[language][key] || key)
    for (const code of ['cursor_login_expired', 'cursor_credentials_expired', 'cursor_adopted_credential_needs_reimport']) {
      const html = localized.renderUsageSnapshot({ mode: 'cursor', provider: { state: 'error', error: `Cursor usage: ${code}: token expired` } })
      expect(html).toContain(I18N[language].cursor_import_expired)
      expect(html).not.toContain(code)
    }
    const refusal = localized.renderUsageSnapshot({ mode: 'cursor', provider: { state: 'error', error: 'OpenAI HTTP 403: cursor_inference_not_enabled' } })
    expect(refusal).toContain(I18N[language].cursor_inference_not_enabled.slice(0, 100))
    expect(refusal).not.toContain('cursor_inference_not_enabled')
    expect(refusal).not.toContain(I18N[language].cursor_import_expired)
    const unknown = localized.renderUsageSnapshot({ mode: 'cursor', provider: { state: 'error', error: 'Cursor usage: cursor_internal_failure: diagnostic detail' } })
    expect(unknown).toContain(I18N[language].auth_unknown_error)
    expect(unknown).not.toContain('cursor_internal_failure')
    expect(unknown).not.toContain('diagnostic detail')
    const human = localized.renderUsageSnapshot({ mode: 'cursor', provider: { state: 'error', error: 'Usage request timed out. Please try again.' } })
    expect(human).toContain('Usage request timed out. Please try again.')
  })
}

describe('Bailian Token Plan usage', () => {
  test('an expired plan states the expiry instead of pointing at the console', () => {
    const html = renderer.renderUsageSnapshot({
      mode: 'bailian',
      provider: { state: 'ok', account: 'sk-sp-fixtu…eKey', region: 'cn', quotaAvailable: false, subscriptionState: 'expired' },
    })
    expect(html).toContain('usage_provider_bailian')
    expect(html).toContain('bailian_subscription_expired')
    expect(html).not.toContain('bailian_usage_console_hint')
    expect(html).not.toContain('usage-bar-fill')
  })

  test('a revoked key states that instead of the generic console hint', () => {
    const html = renderer.renderUsageSnapshot({
      mode: 'bailian',
      provider: { state: 'ok', quotaAvailable: false, subscriptionState: 'invalid_key' },
    })
    expect(html).toContain('bailian_key_invalid')
    expect(html).not.toContain('bailian_usage_console_hint')
  })

  test('a live plan without a measured state keeps the console hint and windows render normally', () => {
    const unmeasured = renderer.renderUsageSnapshot({
      mode: 'bailian',
      provider: { state: 'ok', quotaAvailable: false, consoleLoggedIn: true },
    })
    expect(unmeasured).toContain('bailian_usage_console_hint')
    expect(unmeasured).not.toContain('bailian_subscription_expired')

    const live = renderer.renderUsageSnapshot({
      mode: 'bailian',
      provider: { state: 'ok', quotaAvailable: false, subscriptionState: 'active', windows: [{ id: 'monthly', usedPercent: 12 }] },
    })
    expect(live).toContain('usage-bar-fill')
    expect(live).not.toContain('bailian_subscription_expired')
  })

  test('the expiry copy is localized in zh', () => {
    const localized = usageRenderer(key => I18N.zh[key] || key, 'zh')
    const html = localized.renderUsageSnapshot({
      mode: 'bailian',
      provider: { state: 'ok', quotaAvailable: false, subscriptionState: 'expired' },
    })
    expect(html).toContain(I18N.zh.bailian_subscription_expired)
    expect(html).not.toContain('bailian_usage_console_hint')
  })
})
