// DOM harness entry for the Ultra pick inside the reasoning menu.
// Mounts the REAL composer model picker against a stubbed host bridge and walks
// the menu the way a user would: open panel, open the reasoning submenu, pick
// Ultra, pick a native rung, leave Ultra again. Every observation lands in
// pre#measure-result so a headless dump-dom run carries the evidence out.
// With ?shot in the URL the sequence stops with the submenu open and Ultra
// checked, for a screenshot pass.
import { mountModelSelect } from '../frontend/src/chat/composer/model-select'

const calls: Array<{ method: string; args: unknown[] }> = []
let pendingThinking: Promise<void> | undefined
let pendingUltra: Promise<void> | undefined
const record = (method: string) => (...args: unknown[]) => {
  calls.push({ method, args })
  if (method === 'setThinkingLevel' && pendingThinking) return pendingThinking
  return method === 'setUltraMode' && pendingUltra ? pendingUltra : Promise.resolve()
}
;(window as any).klaus = {
  session: {
    setMainModel: record('setMainModel'),
    setThinkingLevel: record('setThinkingLevel'),
    setUltraMode: record('setUltraMode'),
    setFastMode: record('setFastMode'),
    getPermissionMode: async () => ({ mode: 'default' }),
  },
}
;(window as any).refreshComposerPreferences = async () => {}
;(window as any).refreshSideModelButton = async () => {}

const LABELS: Record<string, string> = {
  thinking_ultra: 'Ultra',
  thinking_level_button_title: 'Reasoning effort',
  thinking_low: 'Low',
  thinking_medium: 'Medium',
  thinking_high: 'High',
  thinking_xhigh: 'Extra high',
  klaus_default: 'Default',
  model_preference_save_failed: 'Could not save the model selection.',
  loading: 'Loading',
  no_models: 'No models',
}
;(window as any).tt = (key: string) => LABELS[key] ?? key
;(window as any).currentLang = 'en'

const results: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }) }

const waitFor = (label: string, fn: () => any, ms = 6000): Promise<any> => new Promise((resolve, reject) => {
  const start = Date.now()
  const tick = () => {
    const value = fn()
    if (value) return resolve(value)
    if (Date.now() - start > ms) return reject(new Error(`timeout waiting for ${label}`))
    setTimeout(tick, 16)
  }
  tick()
})
const called = (method: string, pred: (args: unknown[]) => boolean) => calls.findIndex(c => c.method === method && pred(c.args))
const openPanel = (root: HTMLElement) => waitFor('open panel', () => {
  const panel = root.querySelector('.kls-select-panel')
  return panel && !panel.hasAttribute('hidden') ? panel : null
})
const openSubmenu = (root: HTMLElement) => waitFor('open submenu', () => {
  const submenu = root.querySelector('[role="menu"]')
  return submenu && !submenu.hasAttribute('hidden') ? submenu : null
})
const radioRows = (submenu: Element) => Array.from(submenu.querySelectorAll('[role="menuitemradio"]')) as HTMLElement[]
const rowText = (row: HTMLElement) => (row.querySelector('.kls-select-item-label')?.textContent || '').trim()

async function main() {
  const shot = location.search.includes('shot')
  const root = document.getElementById('root')!
  let sessionId = 'session-1'
  const api = mountModelSelect(root, { getSessionId: () => sessionId })!
  const items = [
    { value: 'custom:fixture', label: 'Fixture model', supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh'], defaultThinkingLevel: 'xhigh' },
  ]
  api.setItems(items, { value: 'custom:fixture', thinkingLevel: 'xhigh', ultraMode: false })

  const trigger = await waitFor('trigger', () => root.querySelector('button.kls-select-trigger')) as HTMLElement
  trigger.click()
  const panel = await openPanel(root)

  check('main panel keeps no standalone Ultra switch row',
    panel.querySelectorAll('[role="switch"]').length === 0 && !panel.querySelector('[data-ultra-row]'),
    `switches=${panel.querySelectorAll('[role="switch"]').length}`)
  const thinkingRow = panel.querySelector('button[aria-haspopup="menu"]') as HTMLElement
  check('reasoning row shows the stored native rung', Boolean(thinkingRow) && (thinkingRow.textContent || '').includes('Extra high'), thinkingRow?.textContent || '')
  thinkingRow.click()
  const submenu = await openSubmenu(root)

  const rows = radioRows(submenu)
  const ultraRow = submenu.querySelector('[data-ultra-row]') as HTMLElement
  check('Ultra is a member of the reasoning menu', Boolean(ultraRow))
  check('Ultra row closes the menu after the native rungs', rows.length > 0 && rows[rows.length - 1] === ultraRow, rows.map(rowText).join('|'))
  check('Ultra row carries no secondary copy', (ultraRow?.textContent || '').trim() === 'Ultra', ultraRow?.textContent || '')
  check('native rungs keep their own rows', rows.slice(0, -1).map(rowText).join('|') === 'Low|Medium|High|Extra high', rows.slice(0, -1).map(rowText).join('|'))
  check('stored rung checked while Ultra is off',
    ultraRow?.getAttribute('aria-checked') === 'false' && rows.find(r => rowText(r) === 'Extra high')?.getAttribute('aria-checked') === 'true')

  ultraRow.click()
  await waitFor('setUltraMode(true)', () => called('setUltraMode', args => args[0] === true) >= 0)
  await waitFor('panel closed after Ultra save', () => panel.hasAttribute('hidden'))
  check('trigger badge reports Ultra while on', (trigger.textContent || '').includes('Ultra'), trigger.textContent || '')

  trigger.click()
  const panel2 = await openPanel(root)
  const thinkingRow2 = panel2.querySelector('button[aria-haspopup="menu"]') as HTMLElement
  check('reasoning row reports Ultra while on', (thinkingRow2.textContent || '').includes('Ultra'), thinkingRow2.textContent || '')
  thinkingRow2.click()
  const submenu2 = await openSubmenu(root)
  const rows2 = radioRows(submenu2)
  const ultraRow2 = submenu2.querySelector('[data-ultra-row]') as HTMLElement
  check('Ultra takes the single check while on',
    ultraRow2?.getAttribute('aria-checked') === 'true' && rows2.slice(0, -1).every(r => r.getAttribute('aria-checked') === 'false'),
    rows2.map(r => `${rowText(r)}=${r.getAttribute('aria-checked')}`).join('|'))
  if (shot) return

  const highRow = rows2.find(r => rowText(r) === 'High')!
  highRow.click()
  const levelAt = await waitFor('setThinkingLevel(high)', () => { const i = called('setThinkingLevel', args => args[0] === 'high'); return i >= 0 ? i : null })
  check('picking a native rung exits Ultra in the same scoped request',
    JSON.stringify(calls[levelAt].args) === JSON.stringify(['high', 'session-1', { ultraMode: false }])
      && called('setUltraMode', args => args[0] === false) < 0, JSON.stringify(calls[levelAt]))
  await waitFor('panel closed after rung save', () => panel2.hasAttribute('hidden'))

  trigger.click()
  const panel3 = await openPanel(root)
  const thinkingRow3 = panel3.querySelector('button[aria-haspopup="menu"]') as HTMLElement
  check('reasoning row returns to the native rung after leaving Ultra', (thinkingRow3.textContent || '').includes('High'), thinkingRow3.textContent || '')
  thinkingRow3.click()
  const submenu3 = await openSubmenu(root)
  const rows3 = radioRows(submenu3)
  const ultraRow3 = submenu3.querySelector('[data-ultra-row]') as HTMLElement
  check('native rung takes the check back',
    ultraRow3?.getAttribute('aria-checked') === 'false' && rows3.find(r => rowText(r) === 'High')?.getAttribute('aria-checked') === 'true')

  ultraRow3.click()
  await waitFor('second setUltraMode(true)', () => calls.filter(c => c.method === 'setUltraMode' && c.args[0] === true).length === 2)
  await waitFor('panel closed after second Ultra save', () => panel3.hasAttribute('hidden'))
  trigger.click()
  const panel4 = await openPanel(root)
  const thinkingRow4 = panel4.querySelector('button[aria-haspopup="menu"]') as HTMLElement
  thinkingRow4.click()
  const submenu4 = await openSubmenu(root)
  const ultraRow4 = submenu4.querySelector('[data-ultra-row]') as HTMLElement
  ultraRow4.click()
  await waitFor('third setUltraMode(true)', () => calls.filter(c => c.method === 'setUltraMode' && c.args[0] === true).length === 3)
  await waitFor('panel closed after reselecting Ultra', () => panel4.hasAttribute('hidden'))
  check('re-picking the checked Ultra row keeps the mode', trigger.textContent?.includes('Ultra') === true
    && called('setUltraMode', args => args[0] === false) < 0)

  const pickNative = async (label: string) => {
    trigger.click()
    const currentPanel = await openPanel(root)
    ;(currentPanel.querySelector('button[aria-haspopup="menu"]') as HTMLElement).click()
    const menu = await openSubmenu(root)
    radioRows(menu).find(row => rowText(row) === label)!.click()
  }
  let rejectSave!: (error: Error) => void
  pendingThinking = new Promise<void>((_resolve, reject) => { rejectSave = reject })
  api.setItems(items, { value: 'custom:fixture', thinkingLevel: 'high', ultraMode: true })
  await waitFor('Ultra before rejected native selection', () => trigger.textContent?.includes('Ultra'))
  await pickNative('Low')
  await waitFor('optimistic native selection', () => trigger.textContent?.includes('Low') && !trigger.textContent?.includes('Ultra'))
  api.setItems(items, { value: 'custom:fixture', thinkingLevel: 'high', ultraMode: true })
  check('a stale refresh cannot split the pending native selection', trigger.textContent?.includes('Low') === true && !trigger.textContent?.includes('Ultra'), trigger.textContent || '')
  rejectSave(new Error('Native selection rejected'))
  await waitFor('paired rollback to Ultra', () => trigger.textContent?.includes('Ultra'))
  check('a rejected native selection restores Ultra', trigger.textContent?.includes('Ultra') === true, trigger.textContent || '')

  pendingThinking = new Promise<void>((_resolve, reject) => { rejectSave = reject })
  await pickNative('Medium')
  await waitFor('captured native write', () => called('setThinkingLevel', args => args[0] === 'medium' && args[1] === 'session-1') >= 0)
  sessionId = 'session-2'
  api.setItems(items, { value: 'custom:fixture', thinkingLevel: 'high', ultraMode: false })
  await waitFor('second chat selection', () => trigger.textContent?.includes('High') && !trigger.textContent?.includes('Ultra'))
  rejectSave(new Error('Previous chat save rejected'))
  await new Promise(resolve => setTimeout(resolve, 20))
  check('a late native save failure cannot change the next chat',
    trigger.textContent?.includes('High') === true && !trigger.textContent?.includes('Ultra')
      && !calls.some(call => call.method === 'setThinkingLevel' && call.args[1] === 'session-2'), trigger.textContent || '')
  pendingThinking = undefined

  api.setItems([{ value: 'custom:plain', label: 'Plain model', supportedThinkingLevels: [] }],
    { value: 'custom:plain', thinkingLevel: 'high', ultraMode: true })
  await waitFor('plain model in Ultra', () => trigger.textContent?.includes('Plain model') && trigger.textContent?.includes('Ultra'))
  trigger.click()
  const plainPanel = await openPanel(root)
  ;(plainPanel.querySelector('button[aria-haspopup="menu"]') as HTMLElement).click()
  const plainMenu = await openSubmenu(root)
  check('a model without native rungs has a local exit from Ultra',
    radioRows(plainMenu).map(rowText).join('|') === 'Default|Ultra')
  ;(plainMenu.querySelector('[data-ultra-off-row]') as HTMLElement).click()
  await waitFor('plain model leaves Ultra', () => !trigger.textContent?.includes('Ultra'))
  check('the local default exits Ultra without inventing a native effort',
    called('setUltraMode', args => args[0] === false && args[1] === 'session-2') >= 0
      && !calls.some(call => call.method === 'setThinkingLevel' && call.args[1] === 'session-2'))
  pendingUltra = new Promise<void>((_resolve, reject) => { rejectSave = reject })
  trigger.click()
  const retryPanel = await openPanel(root)
  ;(retryPanel.querySelector('button[aria-haspopup="menu"]') as HTMLElement).click()
  const retryMenu = await openSubmenu(root)
  ;(retryMenu.querySelector('[data-ultra-row]') as HTMLElement).click()
  await waitFor('optimistic Ultra selection', () => trigger.textContent?.includes('Ultra'))
  api.setItems([{ value: 'custom:plain', label: 'Plain model', supportedThinkingLevels: [] }],
    { value: 'custom:plain', thinkingLevel: 'high', ultraMode: false })
  check('a stale refresh cannot override an in-flight Ultra selection', trigger.textContent?.includes('Ultra') === true)
  rejectSave(new Error('Ultra selection rejected'))
  await waitFor('Ultra selection rollback', () => !trigger.textContent?.includes('Ultra'))
  check('a failed Ultra save restores the previous mode after a stale refresh', !trigger.textContent?.includes('Ultra'))
  pendingUltra = undefined
}

main().catch(error => {
  results.push({ name: 'sequence completed', ok: false, detail: String(error && (error as Error).stack || error) })
}).finally(() => {
  const pre = document.createElement('pre')
  pre.id = 'measure-result'
  pre.textContent = JSON.stringify(results, null, 2)
  document.body.appendChild(pre)
  document.title = 'done'
})
