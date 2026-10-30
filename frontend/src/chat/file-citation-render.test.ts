// 正文 markdown 对本地文件引用与可播放媒体的渲染分派：链接变文件引用 chip、
// 图语法指向音频/视频变播放卡壳、指向图片仍是图。渲染管线本身不挂 DOM，
// 这里只断言它产出的 HTML 形状——挂载行为由 headless Chrome 夹具验证。
import { describe, expect, test } from 'bun:test'

const urlCalls: Array<{ path: string; sessionId?: string }> = []
;(globalThis as any).window = {
  addEventListener: () => {},
  currentLang: 'en',
  klaus: {
    media: {
      url: (path: string, sessionId?: string) => {
        urlCalls.push({ path, sessionId })
        return `klaus-media://localhost/${Buffer.from(path).toString('base64url')}`
      },
    },
  },
}

const { renderMarkdownHtml } = await import('./markdown')

describe('local file citations', () => {
  test('a local link renders an accessible file reference with a decorative type icon', () => {
    const html = renderMarkdownHtml('Wrote [report.md](/abs/report.md) for you.', 's1')
    expect(html).toContain('class="md-file-citation"')
    expect(html).toContain('data-file-path="/abs/report.md"')
    expect(html).toContain('aria-label="report.md"')
    expect(html).toContain('<span class="md-file-citation-icon" aria-hidden="true"><svg')
    expect(html).toContain('<span class="md-file-citation-label">report.md</span>')
    expect(html).not.toContain('<a href="/abs/report.md"')
  })
  test('a location suffix lands on the chip and in its data attributes', () => {
    const html = renderMarkdownHtml('[app.ts](/abs/app.ts#L12C3)', 's1')
    expect(html).toContain('data-file-line="12"')
    expect(html).toContain('data-file-column="3"')
    expect(html).toContain('aria-label="app.ts:12"')
    expect(html).toContain('<span class="md-file-citation-line">:12</span>')
  })
  test('an ordinary URL stays an external anchor', () => {
    const html = renderMarkdownHtml('[docs](https://example.com/a)', 's1')
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener">')
    expect(html).not.toContain('md-file-citation')
  })
  test('decorative icons keep copied text clean and reflect the destination type', () => {
    const markdown = renderMarkdownHtml('[notes](/abs/report.md)', 's1')
    const source = renderMarkdownHtml('[notes](/abs/app.ts)', 's1')
    expect(markdown.replace(/<[^>]*>/g, '').trim()).toBe('notes')
    expect(source.replace(/<[^>]*>/g, '').trim()).toBe('notes')
    const icon = (html: string) => /<span class="md-file-citation-icon"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1]
    expect(icon(markdown)).toContain('<svg')
    expect(icon(source)).not.toBe(icon(markdown))
  })
  test('link and directive references share identical labels and icon markup', () => {
    const link = renderMarkdownHtml('[Draft](/abs/report.md#L3C2)', 's1')
    const directive = renderMarkdownHtml(':klaus-file-cite[Draft]{path="/abs/report.md#L3C2"}', 's1')
    expect(directive).toBe(link)
  })
})

describe('playable media cited with the image syntax', () => {
  test('audio renders a player shell carrying the capability URL', () => {
    const html = renderMarkdownHtml('![greeting](/abs/greeting.mp3)', 's1')
    expect(html).toContain('class="md-media-player"')
    expect(html).toContain('data-media-kind="audio"')
    expect(html).toContain('data-media-path="/abs/greeting.mp3"')
    expect(html).toContain('data-media-src="klaus-media://localhost/')
    expect(html).not.toContain('<img')
    expect(urlCalls.some(call => call.path === '/abs/greeting.mp3')).toBe(true)
  })
  test('video renders a player shell of its own kind', () => {
    const html = renderMarkdownHtml('![clip](/abs/clip.mp4)', 's1')
    expect(html).toContain('data-media-kind="video"')
    expect(html).not.toContain('<img')
  })
  test('images keep the existing figure shape', () => {
    const html = renderMarkdownHtml('![shot](/abs/shot.png)', 's1')
    expect(html).toContain('md-media-figure')
    expect(html).toContain('<img')
    expect(html).not.toContain('md-media-player')
  })
})

describe('the explicit file-cite directive', () => {
  test('a directive renders the same chip a link would', () => {
    const html = renderMarkdownHtml('Draft ready: :klaus-file-cite[Draft]{path="/abs/notes.md"} end.', 's1')
    expect(html).toContain('class="md-file-citation"')
    expect(html).toContain('data-file-path="/abs/notes.md"')
    expect(html).toContain('<span class="md-file-citation-label">Draft</span></button>')
    expect(html).not.toContain(':klaus-file-cite')
  })
  test('a location suffix on the directive path carries the line', () => {
    const html = renderMarkdownHtml(':klaus-file-cite{path="/abs/app.ts#L7"}', 's1')
    expect(html).toContain('data-file-line="7"')
  })
  test('code fences and inline code keep the directive as text', () => {
    const fenced = renderMarkdownHtml('```\n:klaus-file-cite{path="/abs/notes.md"}\n```', 's1')
    expect(fenced).not.toContain('md-file-citation')
    expect(fenced).toContain(':klaus-file-cite')
    const inline = renderMarkdownHtml('write `:klaus-file-cite{path="/abs/notes.md"}` literally', 's1')
    expect(inline).not.toContain('md-file-citation')
  })
  test('an unparsable directive stays visible text', () => {
    const html = renderMarkdownHtml(':klaus-file-cite{purpose="output"}', 's1')
    expect(html).not.toContain('md-file-citation')
    expect(html).toContain(':klaus-file-cite')
  })
})
