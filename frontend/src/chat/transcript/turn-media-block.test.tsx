// 回合末尾出图区块的渲染契约。
//
// 这个区块存在的理由就是可见性：图原先挂在工具卡上，而工具卡随回合折叠消失，
// 于是「生成成功但界面看不到」。所以这里钉住的不只是「渲染出 img」，而是
// 出图不依赖任何折叠状态、且 src 按图所属会话取（渲染别的会话的转录时，
// 拿当前会话的作用域会 403）。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

const urlCalls: Array<{ path: string; sessionId?: string }> = []
;(globalThis as any).window = {
  addEventListener: () => {},
  klaus: {
    media: {
      url: (path: string, sessionId?: string) => {
        urlCalls.push({ path, sessionId })
        return `klaus-media://localhost/${Buffer.from(path).toString('base64url')}${sessionId ? `?s=${sessionId}` : ''}`
      },
    },
  },
}

const { TurnMediaBlock } = await import('./TranscriptView')
// CSS Modules 在 bun test 里导入成样式表字符串而非类名映射，所以渲染出的 HTML
// 里类名解析不到。样式规则改为直接查样式表文件（与 transcript-card-alignment
// 等测试同一做法），渲染这里只钉结构与 src。
const stylesheet = readFileSync(new URL('./transcript.module.css', import.meta.url), 'utf8')

describe('回合末尾出图区块', () => {
  test('每张图都渲染成可点击的 img，不需要任何展开状态', () => {
    urlCalls.length = 0
    const html = renderToStaticMarkup(
      <TurnMediaBlock paths={['/ws/a.png', '/ws/b.png']} sessionId="session-1" />,
    )
    expect(html.match(/<img /g)).toHaveLength(2)
    // 点击放大绑在这个 button 上（makeTranscriptClickHandler 委派 media-figure）。
    expect(html.match(/type="button"/g)).toHaveLength(2)
    expect(html).toContain('alt="a.png"')
    expect(html).toContain('aria-label="a.png"')
    expect(html).toContain('loading="lazy"')
    expect(urlCalls).toEqual([
      { path: '/ws/a.png', sessionId: 'session-1' },
      { path: '/ws/b.png', sessionId: 'session-1' },
    ])
  })

  test('出图区块用的类名在样式表里确实存在', () => {
    expect(stylesheet).toContain('.media-figures')
    expect(stylesheet).toContain('.media-figure')
  })

  test('出图区块跟正文列同一套列约束：居中、限宽 720', () => {
    // 这个区块是正文列（.msg-group，max-width 720 + margin auto）的兄弟节点。
    // 少了列约束它就会贴住容器左缘，而正文是居中的——图出来但不跟文字对齐。
    // 回合末尾的图表卡、改动卡都带同一条约束，图块必须跟着。
    const rule = stylesheet.slice(stylesheet.indexOf('.turn-media {'))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain('max-width: 720px;')
    expect(body).toContain('margin: 4px auto;')
    // 容器本身不能带 padding/border，否则图的内缘会缩进，与正文左缘错开。
    expect(body).not.toContain('padding:')
    expect(body).not.toContain('border:')
  })

  test('src 带图所属会话的作用域，不是当前屏幕上的会话', () => {
    urlCalls.length = 0
    const html = renderToStaticMarkup(<TurnMediaBlock paths={['/ws/a.png']} sessionId="other-session" />)
    expect(html).toContain('?s=other-session')
  })

  test('没有图时不渲染任何容器，回合末尾不留空块', () => {
    expect(renderToStaticMarkup(<TurnMediaBlock paths={[]} sessionId="s" />)).toBe('')
  })

  test('取不到 URL 的图被跳过，不出裂图', () => {
    const previous = (globalThis as any).window.klaus.media.url
    ;(globalThis as any).window.klaus.media.url = () => ''
    try {
      expect(renderToStaticMarkup(<TurnMediaBlock paths={['/ws/a.png']} sessionId="s" />)).toBe('')
    } finally {
      ;(globalThis as any).window.klaus.media.url = previous
    }
  })
})
