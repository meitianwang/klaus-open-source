import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readFrontendFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8')

const INDEX_HTML = readFrontendFile('index.html')
const CHAT_TS = readFrontendFile('src/chat/chat.ts')
const ARTIFACTS_TS = readFrontendFile('src/chat/overview/artifacts.ts')
const OVERVIEW_CSS = readFrontendFile('src/chat/overview/overview.module.css')
const SUBAGENTS_TS = readFrontendFile('src/chat/overview/subagents.ts')
const ROW_TITLE_TSX = readFrontendFile('src/chat/overview/subagent-row-title.tsx')

describe('overview surface', () => {
  test('keeps primary rows without redundant counts, labels, owners, or descriptions', () => {
    expect(INDEX_HTML).not.toContain('monitor-plan-count')
    expect(INDEX_HTML).not.toContain('tasks_panel_title')
    expect(INDEX_HTML).not.toContain('overview_subagents_description')
    expect(CHAT_TS).not.toContain('task-owner')

    expect(INDEX_HTML).toContain('monitor-tasks-body')
    expect(INDEX_HTML).toContain('monitor-subagents-body')
  })

  test('keeps the Files-only layout while allowing conditional document and output groups', () => {
    expect(ARTIFACTS_TS).not.toContain('overview_artifacts_group')
    expect(ARTIFACTS_TS).not.toContain('overview_artifacts_view_all')
    expect(ARTIFACTS_TS).toContain('if (specs.length > 0)')
    expect(ARTIFACTS_TS).toContain("if (aggregate.files.length === 0 && specs.length === 0 && outputs.length === 0)")
    expect(ARTIFACTS_TS).toContain('groups.push(rows)')
    expect(INDEX_HTML).toContain('monitor-artifacts-body')
  })

  test('subagent names take the whole row width and marquee-scroll when over-long', () => {
    // The old percentage cap truncated names while the row still had room.
    expect(OVERVIEW_CSS).not.toContain('max-width: 42%')
    // The row title is the sidebar's MarqueeText, mounted per row and hovered
    // through the shared group marker.
    expect(SUBAGENTS_TS).toContain('mountSubagentRowTitle')
    expect(SUBAGENTS_TS).toContain('SUBAGENT_ROW_MARQUEE_GROUP_CLASS')
    expect(ROW_TITLE_TSX).toContain("from '../sidebar/marquee-text'")
    expect(ROW_TITLE_TSX).toContain('animateOnGroupHover')
  })
})
