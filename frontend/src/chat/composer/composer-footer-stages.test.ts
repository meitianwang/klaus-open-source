import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Pins the composer footer's layout and narrow-width progression: the footer
// row is its own inline-size container, left controls stay in DOM order
// (plus -> auth pill -> model picker -> permission picker) while the right
// cluster (context pie -> voice -> send) docks via auto margin, and each
// collapse stage hides one tier of labels while the model name only truncates.
const indexHtml = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../../css/styles.css', import.meta.url), 'utf8')
const composerModule = readFileSync(new URL('./composer.module.css', import.meta.url), 'utf8')

function block(css: string, header: string): string {
  const start = css.indexOf(header)
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  let i = css.indexOf('{', start)
  const from = i
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return css.slice(from, i + 1)
}

const PERMISSIONS = ':is(#permission-select, #side-permission-select, #left-side-permission-select)'
const MODELS = ':is(#main-model-select, #side-model-select, #left-side-model-select)'

describe('composer footer narrow-width progression', () => {
  test('the footer row is an inline-size container keeping left controls in DOM order and docking the right cluster', () => {
    const row = block(styles, '.input-row {')
    expect(row).toContain('container: composer-footer / inline-size')

    const rowStart = indexHtml.indexOf('<div class="input-row">')
    const rowEnd = indexHtml.indexOf('</div>\n        </div>', rowStart)
    const inputRowMarkup = indexHtml.slice(rowStart, rowEnd)
    const plusIdx = inputRowMarkup.indexOf('id="composer-plus-btn"')
    const authIdx = inputRowMarkup.indexOf('id="auth-mode-pill-host"')
    const modelIdx = inputRowMarkup.indexOf('id="main-model-select"')
    const permIdx = inputRowMarkup.indexOf('id="permission-select"')
    const ctxIdx = inputRowMarkup.indexOf('id="ctx-usage-chip"')
    const voiceIdx = inputRowMarkup.indexOf('id="voice-input-btn"')
    const sendIdx = inputRowMarkup.indexOf('id="send"')
    expect(plusIdx).toBeGreaterThanOrEqual(0)
    expect(plusIdx).toBeLessThan(authIdx)
    expect(authIdx).toBeLessThan(modelIdx)
    expect(modelIdx).toBeLessThan(permIdx)
    expect(permIdx).toBeLessThan(ctxIdx)
    expect(ctxIdx).toBeLessThan(voiceIdx)
    expect(voiceIdx).toBeLessThan(sendIdx)

    expect(block(styles, '.input-row #ctx-usage-chip {')).toContain('margin-left: auto')
    expect(block(styles, '.input-row #ctx-usage-chip[hidden] + #voice-input-btn,')).toContain('margin-left: auto')
    expect(styles).not.toContain('.input-row #auth-mode-pill { order:')
    expect(styles).not.toContain(`.input-row ${PERMISSIONS} { order:`)
    expect(styles).not.toContain(`.input-row ${MODELS} { order:`)
  })

  test('stage 480px drops the permission label and caret but keeps the model label', () => {
    const stage = block(styles, '@container composer-footer (max-width: 480px)')
    expect(stage).toContain(`${PERMISSIONS} :is(.kls-select-text, .kls-select-caret)`)
    expect(stage).toContain('display: none')
    expect(stage).not.toContain('#main-model-select .kls-select-text')
    expect(stage).not.toContain('main-model-trigger')
  })

  test('stage 475px drops the reasoning label while the model name only truncates', () => {
    const stage = block(composerModule, '@container composer-footer (max-width: 475px)')
    expect(stage).toContain('.main-model-trigger-thinking')
    expect(stage).toContain('display: none')
  })

  test('stage 420px drops the model caret and stage 300px drops the permission trigger', () => {
    const caret = block(styles, '@container composer-footer (max-width: 420px)')
    expect(caret).toContain(`${MODELS} .kls-select-caret`)
    expect(caret).toContain('display: none')
    const gone = block(styles, '@container composer-footer (max-width: 300px)')
    expect(gone).toContain(`${PERMISSIONS} {`)
    expect(gone).toContain('display: none')
  })

  test('model label text truncates elastically instead of a fixed cap', () => {
    const family = block(styles, ':is(#main-model-select, :is(#side-model-select, #left-side-model-select), #friend-intent-select, :is(#side-friend-intent-select, #left-side-friend-intent-select)) .kls-select-text {')
    expect(family).toContain('min-width: 0')
    expect(family).not.toContain('max-width')

    const trigger = block(composerModule, ':is(:global(#main-model-select), :global(#side-model-select)) .main-model-trigger-text {')
    expect(trigger).toContain('min-width: 0')
    expect(trigger).not.toContain('max-width')

    const modelName = block(composerModule, ':is(:global(#main-model-select), :global(#side-model-select)) .main-model-trigger-model,\n:is(:global(#main-model-select), :global(#side-model-select)) .main-model-trigger-thinking {')
    expect(modelName).toContain('text-overflow: ellipsis')
  })
})
