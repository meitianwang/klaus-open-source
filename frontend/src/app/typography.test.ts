import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { appearanceTypographyProperties, DEFAULT_CODE_FONT_SIZE, DEFAULT_UI_FONT_SIZE, UI_TEXT_SIZES } from './typography'

const css = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8')

describe('desktop typography', () => {
  test('default text roles match the stylesheet before preferences load', () => {
    const properties = appearanceTypographyProperties(DEFAULT_UI_FONT_SIZE, DEFAULT_CODE_FONT_SIZE)
    for (const [role, size] of Object.entries(UI_TEXT_SIZES)) {
      expect(css).toContain(`--text-${role}: ${size}px;`)
      expect(properties[`--text-${role}`]).toBe(`${size}px`)
    }
    expect(properties['--text-body']).toBe('14px')
    expect(properties['--code-font-size']).toBe('13px')
  })

  test('UI preference scales every role while retaining an explicit code size', () => {
    const large = appearanceTypographyProperties(16, 12)
    const small = appearanceTypographyProperties(11, 18)
    expect(large['--text-body']).toBe('16px')
    expect(large['--text-display']).toBe('32px')
    expect(large['--code-font-size']).toBe('12px')
    expect(small['--text-body']).toBe('11px')
    expect(small['--text-display']).toBe('22px')
    expect(small['--code-font-size']).toBe('18px')
    for (const value of Object.values(large)) expect(value).toMatch(/^\d+(\.\d+)?px$/)
  })

  test('compact connector rows keep whole-pixel line boxes at common UI sizes', () => {
    for (const [uiSize, nameHeight, descriptionHeight] of [
      [11, 15, 13], [12, 16, 14], [14, 19, 16], [16, 22, 19],
    ] as const) {
      const properties = appearanceTypographyProperties(uiSize, 13)
      expect(properties['--leading-mcp-entry-name']).toBe(`${nameHeight}px`)
      expect(properties['--leading-mcp-entry-desc']).toBe(`${descriptionHeight}px`)
    }
  })

  test('settings text roles preserve a whole-pixel vertical rhythm at every UI size', () => {
    for (const [uiSize, title, subtitle, section, description, caption] of [
      [11, 18, 15, 13, 14, 13], [12, 20, 16, 15, 15, 14],
      [13, 22, 18, 16, 16, 15], [14, 23, 19, 17, 18, 16],
      [15, 25, 20, 18, 19, 17], [16, 27, 22, 20, 20, 19],
    ] as const) {
      const properties = appearanceTypographyProperties(uiSize, 13)
      for (const [role, height] of Object.entries({ title, subtitle, section, description, caption })) {
        expect(properties[`--leading-settings-${role}`]).toBe(`${height}px`)
        if (uiSize === DEFAULT_UI_FONT_SIZE) expect(css).toContain(`--leading-settings-${role}: ${height}px;`)
      }
    }
  })

  test('connector page navigation has explicit scalable line boxes', () => {
    for (const [size, title, subtitle, tab, scope] of [
      [11, 23, 17, 15, 13], [12, 25, 19, 16, 15], [13, 27, 20, 17, 16],
      [14, 30, 22, 18, 17], [15, 32, 24, 21, 18], [16, 34, 25, 22, 18],
    ] as const) {
      const properties = appearanceTypographyProperties(size, 13)
      for (const [role, height] of Object.entries({ title, subtitle, tab, scope })) {
        expect(properties[`--leading-page-${role}`]).toBe(`${height}px`)
        if (size === DEFAULT_UI_FONT_SIZE) expect(css).toContain(`--leading-page-${role}: ${height}px;`)
      }
    }
  })

  test('smaller catalog category labels retain their own line boxes', () => {
    for (const [size, height] of [[11, 12], [12, 13], [13, 15], [14, 16], [15, 16], [16, 17]]) {
      expect(appearanceTypographyProperties(size, 13)['--leading-page-category']).toBe(`${height}px`)
    }
    expect(css).toContain('--leading-page-category: 16px;')
    expect(css).toContain('#skills-view .sk-category-tabs .qc-scope-tab { line-height: var(--leading-page-category); }')
    expect(css).toContain('#skills-view .kls-market-desc { line-height: var(--leading-settings-subtitle); }')
    expect(css).toContain('#skills-view .sk-empty { line-height: var(--leading-settings-description); }')
  })

  test('command and agent navigation retain distinct text roles', () => {
    expect(css).toContain('#agents-view .qc-scope-tab { line-height: var(--leading-page-category); }')
    expect(css).toContain('#slash-commands-view .qc-scope-tab { line-height: var(--leading-page-scope); }')
    const agents = readFileSync(new URL('../pages/agents/agents.module.css', import.meta.url), 'utf8')
    const commands = readFileSync(new URL('../pages/slash-commands/slash-commands.module.css', import.meta.url), 'utf8')
    for (const module of [agents, commands]) {
      expect(module).toContain('line-height: var(--leading-mcp-entry-name);')
      expect(module).toContain('line-height: var(--leading-settings-subtitle);')
    }
    expect(agents).toContain('line-height: var(--leading-mcp-entry-desc);')
  })

  test('channel, scheduled-task, and memory pages keep native text boxes aligned', () => {
    for (const view of ['channels', 'cron', 'memory']) {
      expect(css).toContain(`#${view}-view .kls-subtitle {`)
    }
    expect(css).toContain('#cron-view .sk-tab {')
    expect(css.match(/#(?:cron|memory)-view \.kls-select-text \{/g)).toHaveLength(2)

    const channels = readFileSync(new URL('../pages/channels/channels.module.css', import.meta.url), 'utf8')
    expect(channels.match(/line-height: var\(--leading-settings-subtitle\);/g)?.length).toBeGreaterThanOrEqual(4)
    expect(channels).toContain('line-height: var(--leading-composer-control);')
    expect(channels).toContain('width: 270px;')
    expect(channels).toContain('max-width: 100%;')

    const cron = readFileSync(new URL('../pages/cron/cron.module.css', import.meta.url), 'utf8')
    expect(cron.match(/line-height: var\(--leading-settings-subtitle\);/g)?.length).toBeGreaterThanOrEqual(3)
    expect(cron.match(/line-height: var\(--leading-composer-control\);/g)?.length).toBeGreaterThanOrEqual(5)
    expect(cron).toContain('.cron-modal :global(.kls-select-text)')

    const memory = readFileSync(new URL('../pages/memory/memory.module.css', import.meta.url), 'utf8')
    expect(memory.match(/line-height: var\(--leading-settings-subtitle\);/g)?.length).toBeGreaterThanOrEqual(9)
  })

  test('profile settings keep the compact account identity geometry', () => {
    const settings = readFileSync(new URL('../pages/settings/settings.module.css', import.meta.url), 'utf8')
    const avatarStart = settings.indexOf('.profile-account-avatar {')
    const avatarEnd = settings.indexOf('}', avatarStart)
    const avatar = settings.slice(avatarStart, avatarEnd)
    expect(avatar).toContain('width: 28px;')
    expect(avatar).toContain('height: 28px;')
    expect(avatar).toContain('font-size: var(--text-small);')
    expect(settings).toContain('line-height: var(--leading-composer-control);')
  })

  test('settings navigation uses the same whole-pixel label boxes as its sections', () => {
    const settings = readFileSync(new URL('../pages/settings/settings.module.css', import.meta.url), 'utf8')
    for (const selector of ['.settings-back {', '.settings-nav-item {']) {
      const start = settings.indexOf(selector)
      const end = settings.indexOf('}', start)
      expect(settings.slice(start, end)).toContain('line-height: var(--leading-settings-section);')
    }
    expect(settings).toContain('line-height: var(--leading-settings-subtitle);')
    const systemAuthorizationTitleStart = settings.indexOf('.sys-auth-row-title {')
    const systemAuthorizationTitleEnd = settings.indexOf('}', systemAuthorizationTitleStart)
    expect(settings.slice(systemAuthorizationTitleStart, systemAuthorizationTitleEnd)).toContain(
      'line-height: var(--leading-settings-subtitle);',
    )
    const hooks = readFileSync(new URL('../pages/settings/hooks-settings.module.css', import.meta.url), 'utf8')
    const hookHeadingStart = hooks.indexOf('.event-heading h3, .event-heading > div > div {')
    const hookHeadingEnd = hooks.indexOf('}', hookHeadingStart)
    const hookHeading = hooks.slice(hookHeadingStart, hookHeadingEnd)
    expect(hookHeading).toContain('font-size: var(--text-body);')
    expect(hookHeading).toContain('font-weight: var(--weight-medium);')
    expect(hookHeading).toContain('line-height: var(--leading-normal);')
    const cardHeaderStart = css.indexOf('.card-header {')
    const cardHeaderEnd = css.indexOf('}', cardHeaderStart)
    expect(css.slice(cardHeaderStart, cardHeaderEnd)).toContain('line-height: var(--leading-settings-subtitle);')
    expect(css).toContain('#settings-view .form-row label { line-height: var(--leading-settings-subtitle); }')
    expect(css).toContain('#settings-view .kls-select-text { line-height: var(--leading-composer-control); }')
    expect(css).toContain('line-height: var(--leading-settings-description);')
    const decorativeBadgeStart = css.indexOf('.s-badge {')
    const decorativeBadgeEnd = css.indexOf('}', decorativeBadgeStart)
    expect(css.slice(decorativeBadgeStart, decorativeBadgeEnd)).toContain('line-height: 1.4;')
  })

  test('chat messages use scalable whole-pixel line boxes without changing other prose', () => {
    for (const [size, height] of [[11, 17], [12, 19], [13, 21], [14, 22], [15, 24], [16, 26]]) {
      expect(appearanceTypographyProperties(size, 13)['--leading-chat-message']).toBe(`${height}px`)
    }
    expect(css).toContain('--leading-chat-message: 22px;')
    expect(css).toContain('.msg { font-size: var(--text-body); line-height: var(--leading-chat-message); }')
    expect(css).toContain('--leading-prose: 1.625;')
  })

  test('composer controls and compact tool output avoid fractional line boxes', () => {
    for (const [size, height] of [[11, 12], [12, 13], [13, 15], [14, 16], [15, 17], [16, 18]]) {
      expect(appearanceTypographyProperties(size, 13)['--leading-composer-control']).toBe(`${height}px`)
    }
    expect(appearanceTypographyProperties(14, 12)['--leading-code-compact']).toBe('18px')
    expect(appearanceTypographyProperties(14, 13)['--leading-code-compact']).toBe('19px')
    expect(appearanceTypographyProperties(14, 18)['--leading-code-compact']).toBe('27px')
    expect(appearanceTypographyProperties(14, 13)['--leading-permission-text']).toBe('19px')
    expect(css).toContain('--leading-composer-control: 16px;')
    expect(css).toContain('--leading-code-compact: 19px;')
    expect(css).toContain('line-height: var(--leading-composer-control);')
    const activity = readFileSync(new URL('../chat/transcript/activity-tool.module.css', import.meta.url), 'utf8')
    expect(activity.match(/line-height: var\(--leading-code-compact\);/g)).toHaveLength(2)
    const transcript = readFileSync(new URL('../chat/transcript/transcript.module.css', import.meta.url), 'utf8')
    // The permission message and target set the role; the text of a friend
    // message awaiting approval reuses it for the same dense decision text.
    expect(transcript.match(/line-height: var\(--leading-permission-text\);/g)).toHaveLength(3)
    const disclosure = readFileSync(new URL('../chat/transcript/activity-disclosure.module.css', import.meta.url), 'utf8')
    // Transcript cards span the column; the old narrower centered permission
    // override must not come back.
    expect(disclosure).not.toContain('.permission-card')
    const globalStyles = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8')
    const permission = globalStyles.slice(globalStyles.indexOf('.permission-card {'))
    expect(permission.slice(0, permission.indexOf('}'))).toContain('width: 100%;')
  })
})
