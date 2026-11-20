import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { renderMarkdownHtml } from './markdown'
import { createSpecDocumentPanel } from './spec-document-panel'
import {
  attachHtmlDocumentToc,
  createMarkdownToc,
  extractMarkdownHeadings,
  resolveMarkdownHeadingAnchor,
  slugifyMarkdownHeading,
} from './markdown-toc'

describe('markdown heading extraction and anchor matching', () => {
  test('extracts ATX and Setext headings, skips frontmatter and code blocks, and normalizes levels', () => {
    const source = [
      '---',
      'name: skill-fixture',
      'description: sample',
      '---',
      '',
      '## Top Section',
      '',
      'Body with **bold** text.',
      '',
      '```markdown',
      '# Heading inside fenced code',
      '## Also ignored',
      '```',
      '',
      '    # Indented code block heading',
      '',
      '### Sub **Formatted** `Code` [Link](https://example.com) ![Img](a.png)',
      '',
      'Setext Major',
      '============',
      '',
      'Setext Minor',
      '------------',
    ].join('\n')

    const headings = extractMarkdownHeadings(source)
    expect(headings.map(item => ({ id: item.id, text: item.text, depth: item.depth, level: item.level }))).toEqual([
      { id: 'top-section', text: 'Top Section', depth: 2, level: 1 },
      { id: 'sub-formatted-code-link-img', text: 'Sub Formatted Code Link Img', depth: 3, level: 2 },
      { id: 'setext-major', text: 'Setext Major', depth: 1, level: 0 },
      { id: 'setext-minor', text: 'Setext Minor', depth: 2, level: 1 },
    ])
    expect(headings[0].line).toBe(6)
    expect(source.slice(headings[0].textFrom, headings[0].textFrom + 'Top Section'.length)).toBe('Top Section')
  })

  test('supports CJK/Unicode headings, duplicate deduplication, and inline math/escapes', () => {
    const source = [
      '# Overview & API',
      '## 概述与架构',
      '## 概述与架构',
      '## Equation $x + y$ and \\*escaped\\*',
      '### ',
    ].join('\n')

    const headings = extractMarkdownHeadings(source)
    expect(headings.map(item => ({ id: item.id, text: item.text }))).toEqual([
      { id: 'overview-api', text: 'Overview & API' },
      { id: '概述与架构', text: '概述与架构' },
      { id: '概述与架构-1', text: '概述与架构' },
      { id: 'equation-x-y-and-escaped', text: 'Equation x + y and *escaped*' },
    ])

    expect(resolveMarkdownHeadingAnchor(headings, '#概述与架构-1')?.id).toBe('概述与架构-1')
    expect(resolveMarkdownHeadingAnchor(headings, encodeURI('#概述与架构'))?.id).toBe('概述与架构')
    expect(resolveMarkdownHeadingAnchor(headings, '#Overview & API')?.id).toBe('overview-api')
    expect(resolveMarkdownHeadingAnchor(headings, '#missing')).toBeNull()
    expect(slugifyMarkdownHeading('   !!!   ')).toBe('section')
  })
})

describe('createMarkdownToc and responsive/localized behavior', () => {
  test('stays hidden without headings, localizes en/zh, and toggles docked/compact modes without tooltips', () => {
    const dom = new Window()
    const win = dom.window as unknown as Window & { currentLang?: string }
    win.currentLang = 'en'
    const host = dom.document.createElement('div')
    let hostWidth = 720
    Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => hostWidth })
    dom.document.body.append(host)

    const selected: string[] = []
    const toc = createMarkdownToc({
      host: host as unknown as HTMLElement,
      onSelect: item => selected.push(item.id),
    })

    expect(toc.element.hidden).toBe(true)

    const headings = extractMarkdownHeadings('# First\n\n## Second\n')
    toc.updateHeadings(headings)
    expect(toc.element.hidden).toBe(false)
    expect(toc.element.dataset.tocMode).toBe('docked')
    expect(toc.element.querySelector('[data-toc-label]')?.textContent).toBe('Contents')
    expect(toc.element.querySelectorAll('li')).toHaveLength(2)

    win.currentLang = 'zh'
    dom.window.dispatchEvent(new dom.window.CustomEvent('klaus:lang-change'))
    expect(toc.element.querySelector('[data-toc-label]')?.textContent).toBe('目录')
    expect(toc.element.getAttribute('aria-label')).toBe('文档目录')

    // Click second heading -> activates and fires callback
    const items = toc.element.querySelectorAll<HTMLButtonElement>('ul button')
    items[1].click()
    expect(selected).toEqual(['second'])
    expect(items[1].getAttribute('aria-current')).toBe('location')
    expect(items[0].hasAttribute('aria-current')).toBe(false)

    // Collapse & expand in wide mode
    const collapseBtn = toc.element.querySelector<HTMLButtonElement>('[data-toc-action="collapse"]')!
    collapseBtn.click()
    expect(toc.element.dataset.tocMode).toBe('compact')
    expect(collapseBtn.getAttribute('aria-expanded')).toBe('false')

    const railBtn = toc.element.querySelector<HTMLButtonElement>('[data-toc-action="expand"]')!
    railBtn.click()
    expect(toc.element.dataset.tocMode).toBe('docked')
    expect(collapseBtn.getAttribute('aria-expanded')).toBe('true')

    // Narrow mode opens overlay drawer and closes on heading selection or Escape
    hostWidth = 300
    dom.window.dispatchEvent(new dom.window.Event('resize'))
    expect(toc.element.dataset.tocMode).toBe('compact')

    railBtn.click()
    expect(toc.element.dataset.tocMode).toBe('drawer')
    items[0].click()
    expect(toc.element.dataset.tocMode).toBe('compact')
    expect(selected).toEqual(['second', 'first'])

    railBtn.click()
    expect(toc.element.dataset.tocMode).toBe('drawer')
    dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(toc.element.dataset.tocMode).toBe('compact')

    // Policy check: no hover tooltip attributes and no heading/listbox roles inside TOC
    expect(toc.element.querySelectorAll('[title],[data-klaus-tip],[role="heading"],[role="listbox"],h1,h2,h3,h4,h5,h6')).toHaveLength(0)

    toc.destroy()
    dom.close()
  })
})

describe('HTML document TOC and SpecDocumentPanel integration', () => {
  test('attaches heading ids, handles internal #hash clicks, and toggles availability', () => {
    const dom = new Window()
    const host = dom.document.createElement('div')
    const scroller = dom.document.createElement('div')
    const content = dom.document.createElement('div')
    content.innerHTML = '<h1>Title</h1><p><a href="#details">Jump</a></p><h2>Details</h2>'
    scroller.append(content)
    host.append(scroller)
    dom.document.body.append(host)

    let navigated = 0
    const contentEl = content as unknown as HTMLElement
    const binding = attachHtmlDocumentToc({
      host: host as unknown as HTMLElement,
      scrollContainer: scroller as unknown as HTMLElement,
      contentContainer: contentEl,
      onNavigate: () => { navigated++ },
    })
    binding.refresh()

    expect(contentEl.querySelector('h1')?.id).toBe('title')
    expect(contentEl.querySelector('h2')?.id).toBe('details')
    expect(binding.toc.element.hidden).toBe(false)
    expect(Array.from(binding.toc.element.querySelectorAll('ul button')).map(el => el.textContent)).toEqual(['Title', 'Details'])

    const anchor = contentEl.querySelector<HTMLAnchorElement>('a[href="#details"]')!
    anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event)
    expect(navigated).toBe(1)
    expect(binding.toc.element.querySelectorAll('ul button')[1].getAttribute('aria-current')).toBe('location')

    binding.setEnabled(false)
    expect(binding.toc.element.hidden).toBe(true)

    binding.destroy()
    dom.close()
  })

  test('SpecDocumentPanel renders right-side TOC and updates across streaming content', async () => {
    const dom = new Window()
    const prevMutationObserver = globalThis.MutationObserver
    globalThis.MutationObserver = dom.window.MutationObserver as unknown as typeof MutationObserver
    try {
      const root = dom.document.createElement('section')
      dom.document.body.append(root)
      const rootEl = root as unknown as HTMLElement

      let content = '# Spec Title\n\nIntro paragraph.\n'
      const panel = createSpecDocumentPanel({
        root: rootEl,
        readSpecDoc: async () => ({ content }),
        renderMarkdown: text => renderMarkdownHtml(text),
        attachAnnotations: () => ({ count: () => 0, peek: () => [], clear: () => {}, destroy: () => {} }),
        submitAnnotations: () => true,
        openPanel: () => {},
        openDirectory: async () => {},
        translate: key => ({ spec_document_empty: 'Empty', markdown_toc_title: '目录' }[key] || key),
      })

      await panel.activate({ sessionId: 's1', path: '/spec/plan.md', content, streaming: true })
      const tocButtons = () => Array.from(rootEl.querySelectorAll<HTMLButtonElement>('[data-markdown-toc] ul button'))
      expect(tocButtons().map(btn => btn.textContent)).toEqual(['Spec Title'])

      content += '\n## Architecture\n\n### Storage\n'
      panel.onEvent({ type: 'tool_start', sessionId: 's1', toolCallId: 'tc-1', toolName: 'Write', args: { file_path: '/spec/plan.md', content } })
      expect(tocButtons().map(btn => btn.textContent)).toEqual(['Spec Title', 'Architecture', 'Storage'])
      expect(rootEl.querySelector('h2')?.id).toBe('architecture')
      expect(rootEl.querySelector('h3')?.id).toBe('storage')
      expect(rootEl.querySelectorAll('[data-markdown-toc] [title], [data-markdown-toc] [data-klaus-tip]')).toHaveLength(0)

      panel.dispose()
    } finally {
      globalThis.MutationObserver = prevMutationObserver
      dom.close()
    }
  })
})
