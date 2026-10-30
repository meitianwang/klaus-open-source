import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('skills page interaction contract', () => {
  const page = source('./SkillsPage.tsx')
  const modals = source('./modals.tsx')
  const styles = source('./skills.module.css')
  const marketService = source('../../../../main/skills-market/service.ts')
  const skillService = source('../../../../main/services/extensions/skills.ts')

  test('partial data failures stay visible without collapsing the whole page', () => {
    expect(source('./data.ts')).toContain('Promise.allSettled([')
    expect(page).toContain('Promise.allSettled([')
    expect(page).toContain("className={styles['sk-load-warning']}")
    expect(page).toContain('visibleLoadError')
  })

  test('remote search has one committed query, race protection and a clear-to-reset path', () => {
    const switchView = page.slice(page.indexOf('const switchView'), page.indexOf('const switchScope'))
    expect(page).toContain('searchSeqRef')
    expect(page).toContain('committedMarketQueryRef')
    expect(page).toContain("void remoteSearch('')")
    expect(page).toContain('requestSeq !== searchSeqRef.current')
    expect(page).toContain('replaceMarketInCache(page.items, null, false)')
    expect(page).toContain('skill.upstreamSlug || filterTextMatches')
    expect(page).toContain("committedMarketQueryRef.current = ''")
    expect(page).toContain('onChanged={() => { void refreshPage() }}')
    expect(switchView).toContain('searchSeqRef.current++')
    expect(switchView).toContain("committedMarketQueryRef.current = ''")
    expect(switchView).toContain("setSearch('')")
    expect(switchView).toContain('forceRefresh: hadMarketQuery || installedNeedsRefresh')
    expect(source('../../components/PageHeader.tsx')).toContain('input.value = nextValue')
  })

  test('tabs, switches and dialogs expose complete keyboard semantics', () => {
    expect(page).toContain('role="tablist"')
    expect(page).toContain('role="tab" aria-selected=')
    expect(page).toContain('tabindex="${view === tab.key ? 0 : -1}"')
    expect(page).toContain('tabindex="${activeCategory === tab.key ? 0 : -1}"')
    expect(page).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End']")
    expect(page).toContain("button.dataset[identity[0]] === identity[1]")
    expect(page).toContain('role="switch"')
    expect(modals.match(/role="dialog"/g)?.length).toBe(2)
    expect(modals.match(/aria-modal="true"/g)?.length).toBe(2)
    expect(modals).toContain("event.key !== 'Tab'")
    expect(modals).toContain('const restoreFocus = usefulPreviousFocus ? previousFocus')
    expect(modals).toContain('requestAnimationFrame(() =>')
    expect(page).toContain("setTimeout(() => document.getElementById('sk-create-btn')?.focus(), 0)")
    expect(modals).toContain("document.getElementById(returnFocusId)?.focus()")
    expect(styles).toContain('.sk-row-check:focus-visible')
  })

  test('busy states prevent duplicate mutations and cannot be dismissed mid-install', () => {
    expect(page).toContain('actionBusyRef.current.has(key)')
    expect(page).toContain('busyRef.current')
    expect(modals).toContain('if (disabledRef.current) return')
    expect(modals).toContain('disabled={busy}')
    expect(modals).toContain("aria-busy={busy ? 'true' : 'false'}")
    expect(page).toContain('result.installed')
    expect(page).toContain('result?.saved === true')
    expect(page).toContain('result?.removed !== true')
    expect(modals.match(/result\.installed/g)?.length).toBe(2)
  })

  test('platform-neutral project labels and select cleanup prevent Windows and remount drift', () => {
    expect(page).toContain('root.split(/[\\\\/]/)')
    expect(page).toContain('select?.destroy?.()')
    expect(page).toContain("reload({ scope: next, view: 'installed', maskInstalled: true })")
    expect(page).toContain("installedContextLoading && view === 'installed'")
  })

  test('upload and source controls match the capabilities the host actually enforces', () => {
    expect(modals).toContain('/\\.(?:zip|md)$/i')
    expect(modals).toContain('/\\.zip$/i.test(url.pathname)')
    expect(modals).toContain('result.needsOverwrite')
    expect(modals).toContain("{ force: true }")
    expect(modals).not.toContain('subpathRef')
    expect(modals).not.toContain('refRef')
    expect(marketService).toContain("await extractExtensionZip(archive, extracted, signal)")
    expect(marketService).toContain("payload.force !== true")
  })

  test('host boundaries reject malformed toggles and isolate invalid skill metadata', () => {
    expect(skillService).toContain("typeof payload.enabled !== 'boolean'")
    expect(skillService).toContain("dependencyStatus: parseError ? 'invalid'")
    expect(marketService).toContain("dependencyStatus: 'invalid'")
    expect(marketService).toContain("parseError = 'Skill catalog entry has no SKILL.md'")
    expect(page).toContain("skill.dependencyStatus === 'unsupported' || skill.dependencyStatus === 'invalid'")
  })
})
