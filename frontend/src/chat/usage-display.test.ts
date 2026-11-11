import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const vectors = JSON.parse(readFileSync(new URL('../../../contracts/vectors/usage-display-vectors.json', import.meta.url), 'utf8')) as {
  cases: Array<{ usedPercent: number; remainingPercent: number; highUsage: boolean }>
}
const source = ts.createSourceFile('chat.ts', readFileSync(new URL('./chat.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const code = ts.transpileModule(
  ['renderUsageBarRow', 'renderUsageWindows', 'renderUsageCredits', 'renderAntigravityUsageWindows', 'renderAntigravityUsageCredits', 'renderTraeUsageCredits', 'usageFormatCountdown', 'usageLocalizedDuration', 'antigravityWindowLabel'].map(name => {
    const node = source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    if (!node) throw new Error(`The production usage renderer must be identifiable: ${name}`)
    return node.getText(source)
  }).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText

const renderer = runInNewContext(`${code}\n({ renderUsageBarRow, renderUsageWindows, renderUsageCredits, renderAntigravityUsageWindows, renderAntigravityUsageCredits, renderTraeUsageCredits })`, {
  escapeHtml: (text: string) => text,
  usageWindowLabel: () => 'Weekly window',
  usageFormatTime: (value?: number) => value === undefined ? '' : `date-${value}`,
  window: { currentLang: 'en' },
  tt: (key: string) => ({
    usage_used: 'used', usage_remaining: 'remaining', usage_resets: 'resets',
    usage_window_weekly_limit: 'Weekly limit', usage_window_daily_limit: 'Daily limit',
    usage_window_duration_limit: '{duration} limit', usage_resets_in: 'Resets in {duration}',
    usage_resets_lt_minute: 'Resets in <1m',
  } as Record<string, string>)[key] || key,
}) as {
  renderTraeUsageCredits(credits: { remaining?: number | string; unlimited?: boolean } | null | undefined): string
  renderUsageBarRow(label: string, value: string, usedPercent: number): string
  renderUsageWindows(data: { windows: Array<{ usedPercent?: number; remaining?: number; disabled?: boolean; description?: string }> }): string
  renderUsageCredits(label: string, credits: { usedPercent?: number; used?: number; total?: number; remaining?: number; unit?: string; pools?: Array<{ creditType?: string; creditAmount: string; minimumCreditAmountForUsage?: string }> }): string
  renderAntigravityUsageWindows(data: { windows: Array<{ id?: string; usedPercent?: number; remaining?: number | string; total?: number | string; expiresAt?: number; resetsAt?: number; unlimited?: boolean; disabled?: boolean; description?: string; groupLabel?: string; windowKind?: string; windowToken?: string }> }, showLimits?: boolean): string
  renderAntigravityUsageCredits(label: string, credits: { usedPercent?: number; used?: number | string; total?: number | string; remaining?: number | string; unit?: string; pools?: Array<{ creditType?: string; creditAmount: string; minimumCreditAmountForUsage?: string }> }, showAmounts?: boolean): string
}

function expectRemainingBar(html: string, remainingPercent: number, highUsage: boolean) {
  const fill = html.match(/<div class="usage-bar-fill([^"]*)" style="width:(\d+)%"/)
  expect(fill).not.toBeNull()
  expect(Number(fill?.[2])).toBe(remainingPercent)
  expect(fill?.[1].includes('high')).toBe(highUsage)
}

test('personal credits show only the available decimal balance in one row', () => {
  const html = renderer.renderTraeUsageCredits({ remaining: 8332.9804 })
  expect(html).toContain('8,332.98')
  expect(html).toContain('trae_usage_available')
  expect(html.match(/class="usage-row"/g)).toHaveLength(1)
  expect(html).not.toContain('usage-bar-fill')
  expect(html).not.toContain('trae_usage_limit')
  expect(html).not.toContain('expires')
  expect(renderer.renderTraeUsageCredits({ remaining: 0 })).toContain('>0<')
  expect(renderer.renderTraeUsageCredits(undefined)).toContain('usage_quota_unknown')
  expect(renderer.renderTraeUsageCredits({ remaining: '9007199254740993' })).toContain('9,007,199,254,740,993')
})

describe('quota display', () => {
  for (const { usedPercent, remainingPercent, highUsage } of vectors.cases) {
    test(`${usedPercent}% used leaves ${remainingPercent}% colored and labelled remaining`, () => {
      const window = renderer.renderUsageWindows({ windows: [{ usedPercent }] })
      expect(window).toContain(`${remainingPercent}% remaining`)
      expect(window).not.toContain('% used')
      expectRemainingBar(window, remainingPercent, highUsage)

      const credits = renderer.renderUsageCredits('credits', { usedPercent, used: usedPercent, total: 100 })
      expect(credits).toContain(`${remainingPercent} / 100`)
      expect(credits).toContain(`${remainingPercent}% remaining`)
      expect(credits).not.toContain('% used')
      expectRemainingBar(credits, remainingPercent, highUsage)
    })
  }
})


test('a remaining-only credit balance has no invented total or percentage', () => {
  const html = renderer.renderAntigravityUsageCredits('credits', { remaining: 42, unit: 'credits' })
  expect(html).toContain('42 credits remaining')
  expect(html).not.toContain(' / ')
  expect(html).not.toContain('%')
  expect(html).not.toContain('usage-bar-fill')
})

test('credit usage derives its percentage from a real total and remaining balance', () => {
  const html = renderer.renderAntigravityUsageCredits('credits', { remaining: 30, total: 100 })
  expect(html).toContain('30 / 100')
  expectRemainingBar(html, 30, false)
})

test('restricted and remaining-only windows retain their meaning without an invented percentage', () => {
  const restricted = renderer.renderAntigravityUsageWindows({ windows: [{ usedPercent: 100, disabled: true, description: 'Account restricted' }] })
  expect(restricted).toContain('Account restricted')
  expect(restricted).toContain('usage_account_restricted')
  expect(restricted).not.toContain('%')
  expect(restricted).not.toContain('usage-bar-fill')
  const remaining = renderer.renderAntigravityUsageWindows({ windows: [{ remaining: 42 }] })
  expect(remaining).toContain('42 remaining')
  expect(remaining).not.toContain('%')
  expect(remaining).not.toContain('usage-bar-fill')
})

test('separate credit pools retain exact integer balances and minimum thresholds', () => {
  const html = renderer.renderAntigravityUsageCredits('credits', { pools: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '9007199254740993', minimumCreditAmountForUsage: '100' }, { creditAmount: '42' }] })
  expect(html).toContain('9,007,199,254,740,993')
  expect(html).toContain('Google One AI')
  expect(html).toContain('100')
  expect(html).toContain('42 remaining')
  expect(html).not.toContain('%')
  expect(html).not.toContain('usage-bar-fill')
})


test('native pack limits, expiry and unlimited state never imply a consumption percentage', () => {
  const unknown = renderer.renderAntigravityUsageWindows({ windows: [{ total: '9007199254740993', expiresAt: 1800000000000 }] }, true)
  expect(unknown).toContain('9,007,199,254,740,993')
  expect(unknown).toContain('usage_expires date-1800000000000')
  expect(unknown).not.toContain('resets')
  expect(unknown).not.toContain('%')
  expect(unknown).not.toContain('usage-bar-fill')
  const unlimited = renderer.renderAntigravityUsageWindows({ windows: [{ unlimited: true, resetsAt: 1800100000000 }] }, true)
  expect(unlimited).toContain('usage_unlimited')
  expect(unlimited).toContain('resets date-1800100000000')
  expect(unlimited).not.toContain('%')
  expect(unlimited).not.toContain('usage-bar-fill')
})

test('native summary amounts preserve partial totals and exact used values without inferred balances', () => {
  const total = renderer.renderAntigravityUsageCredits('credits', { total: 8650, unit: 'credits' }, true)
  expect(total).toContain('trae_usage_limit: 8,650 credits')
  expect(total).not.toContain('remaining')
  expect(total).not.toContain('%')
  expect(total).not.toContain('usage-bar-fill')
  const used = renderer.renderAntigravityUsageCredits('credits', { used: '9007199254740993' }, true)
  expect(used).toContain('used: 9,007,199,254,740,993')
  expect(used).not.toContain('remaining')
  expect(used).not.toContain('%')
})

test('ordinary quota windows and credits keep their established missing-value formatting', () => {
  const ordinary = renderer.renderUsageWindows({ windows: [{ remaining: 42, disabled: true, description: 'restricted' }] })
  expect(ordinary).toContain('100% remaining')
  expectRemainingBar(ordinary, 100, false)
  expect(ordinary).not.toContain('restricted')
  const credits = renderer.renderUsageCredits('credits', { remaining: 42 })
  expect(credits).toContain('0 / 0')
  expect(credits).toContain('100% remaining')
  expect(renderer.renderAntigravityUsageCredits('credits', { remaining: 42 })).not.toContain('%')
})

test('shared quota pools render one header per group with a row per window', () => {
  const now = Date.now()
  const html = renderer.renderAntigravityUsageWindows({ windows: [
    { id: 'pool_weekly', groupLabel: 'Gemini Models', windowKind: 'weekly', usedPercent: 92, resetsAt: now + ((4 * 24 + 23) * 60 + 30) * 60000 },
    { id: 'pool_duration_5h', groupLabel: 'Gemini Models', windowKind: 'duration', windowToken: '5h', usedPercent: 0, resetsAt: now + 5 * 3600000 },
    { id: 'pool_weekly', groupLabel: 'Claude and GPT models', windowKind: 'weekly', usedPercent: 80, resetsAt: now + (5 * 24 + 4) * 60 * 60000 },
  ] })
  expect(html.match(/usage-group-head/g)).toHaveLength(2)
  expect(html).toContain('Gemini Models')
  expect(html).toContain('Claude and GPT models')
  expect(html).toContain('Weekly limit')
  expect(html).toContain('5h limit')
  expect(html).toContain('Resets in 4d 23h')
  expect(html).toContain('Resets in 5d 4h')
  // an untouched window reports no countdown, so only the drawn-on rows carry one
  expect(html.match(/Resets in/g)).toHaveLength(2)
  expect(html).toContain('8% remaining')
  expect(html).toContain('20% remaining')
  expect(html).toContain('usage-bar-fill high')
  expect(html).toContain('usage-bar-fill warn')
})
