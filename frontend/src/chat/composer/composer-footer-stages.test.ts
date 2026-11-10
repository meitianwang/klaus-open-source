import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Pins the composer footer's narrow-width progression: the footer row is its
// own inline-size container, controls carry explicit visual order so the
// permission picker leads and the model picker opens the docked right
// cluster, and each collapse stage hides exactly one tier of labels while
// the model name only ever truncates (never disappears).
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
  test('the footer row is an inline-size container with ordered control groups', () => {
    const row = block(styles, '.input-row {')
    expect(row).toContain('container: composer-footer / inline-size')

    expect(block(styles, '.input-row :is(#composer-plus-btn')).toContain('order: -5')
    expect(block(styles, `.input-row ${PERMISSIONS} { order:`)).toContain('order: -4')
    expect(block(styles, '.input-row #auth-mode-pill {')).toContain('order: -3')
    const model = block(styles, `.input-row ${MODELS} { order:`)
    expect(model).toContain('order: -2')
    expect(model).toContain('margin-left: auto')
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
