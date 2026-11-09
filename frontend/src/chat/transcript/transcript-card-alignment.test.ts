import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import vector from '../../../../contracts/vectors/ask-user-question-vectors.json'

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

describe('transcript card alignment contract', () => {
  const transcript = readFileSync(new URL('./transcript.module.css', import.meta.url), 'utf8')
  const disclosure = readFileSync(new URL('./activity-disclosure.module.css', import.meta.url), 'utf8')
  const authCard = readFileSync(new URL('./auth-card.tsx', import.meta.url), 'utf8')

  test('resolved structured questions span the transcript column in every terminal state', () => {
    expect(vector.layout).toEqual({
      transcriptColumnMaxWidth: 720,
      resolvedCardWidth: 'full-column',
      horizontalAlignment: 'centered-within-column',
      states: ['submitted', 'skipped', 'history-replay'],
    })
    const summary = ruleBody(transcript, '.question-summary')
    expect(summary).toContain('width: 100%;')
    // 平铺路径的父容器是全宽滚动区；卡片自带 720 列约束并居中，
    // 折叠区内则由父容器限宽，两种挂载下都与左对齐正文同列。
    expect(summary).toContain('max-width: min(720px, 100%);')
    expect(summary).toContain('margin: 8px auto 10px;')
  })

  test('persistent turn sections preserve child-owned width', () => {
    const persistentChild = ruleBody(disclosure, '.persistent > *')
    expect(persistentChild).toContain('width: 100%;')
    expect(persistentChild).not.toContain('max-width:')
    expect(persistentChild).not.toContain('margin-inline:')
    // The permission override existed to re-center a narrower card; every
    // transcript card now spans the column, so no override may come back.
    expect(disclosure).not.toContain('.permission-card')
  })

  test('the permission and authentication cards span the transcript column', () => {
    const styles = readFileSync(new URL('../../../css/styles.css', import.meta.url), 'utf8')
    const permission = ruleBody(styles, '.permission-card')
    expect(permission).toContain('width: 100%;')
    // 卡片自带列约束：折叠区内由 720 父容器限宽，平铺在全宽滚动区上时靠这条对齐正文。
    expect(permission).toContain('max-width: min(720px, 100%);')
    expect(permission).toContain('margin: 12px auto;')
    expect(authCard).toContain("width: '100%'")
    expect(authCard).toContain("boxSizing: 'border-box'")
    expect(authCard).not.toContain('marginInline')
  })

  test('user bubble stack and question replies constrain width within narrow transcript columns', () => {
    const styles = readFileSync(new URL('../../../css/styles.css', import.meta.url), 'utf8')
    const userRowMain = ruleBody(transcript, '.user-row-main')
    expect(userRowMain).toContain('width: 100%;')
    expect(userRowMain).toContain('max-width: 100%;')
    expect(userRowMain).toContain('min-width: 0;')

    const stack = ruleBody(styles, '.msg-group.user .sent-user-stack')
    expect(stack).toContain('width: 100%;')
    expect(stack).toContain('max-width: 100%;')
    expect(stack).toContain('min-width: 0;')

    const bubble = ruleBody(styles, '.msg-group.user .sent-user-stack .msg.user')
    expect(bubble).toContain('max-width: min(100%, 520px);')
    expect(bubble).toContain('min-width: 0;')
    expect(bubble).toContain('overflow: hidden;')

    const reply = ruleBody(transcript, '.question-reply')
    expect(reply).toContain('min-width: 0;')
    expect(reply).toContain('max-width: 100%;')

    const titlebar = ruleBody(styles, '.titlebar-session-title')
    expect(titlebar).toContain('display: block;')
    expect(titlebar).toContain('text-overflow: ellipsis;')
  })
})
