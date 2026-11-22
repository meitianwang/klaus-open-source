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

const { foldUnits, unitsFromMessages, LiveTail } = await import('./TranscriptView')
const { collectTerminalGeneratedMediaPaths } = await import('./chat-activity')
const { ingestChatEvent, ingestLocalUserTurn, chatStreamStore, retainSessionStream, selectSessionStream } = await import('../stream-store')
import deliverableVectors from '../../../../contracts/vectors/mobile-content-rendering-vectors.json'

describe('turn-end deliverable media selection', () => {
  for (const vector of deliverableVectors.deliverableCases) {
    test(`matches shared deliverable vector: ${vector.name}`, () => {
      const msgs = [
        { id: 'u1', uuid: 'u1', role: 'user', text: 'Run task', turnId: 'turn-v' },
        {
          id: 'a1',
          uuid: 'a1',
          role: 'assistant',
          turnId: 'turn-v',
          isFinalReply: !vector.running,
          contentBlocks: [
            ...vector.blocks,
            ...(vector.finalText
              ? [{ type: 'text', text: vector.finalText, ...(vector.running ? {} : { phase: 'final_answer' }) }]
              : []),
          ],
        },
      ]
      const units = unitsFromMessages(msgs)
      const nodes = foldUnits(
        units,
        vector.running ? { turnId: 'turn-v' } : null,
        vector.running ? {} : { 'turn-v': 'completed' },
        {},
      )
      const mediaNode = nodes.find((node): node is Extract<typeof node, { kind: 'turn-media' }> => node.kind === 'turn-media')
      expect(mediaNode?.paths ?? []).toEqual(vector.media)
      const suppressed = new Set<string>()
      for (const unit of units) {
        if (unit.type === 'tools' && unit.suppressFigurePaths) {
          for (const path of unit.suppressFigurePaths) suppressed.add(path)
        }
      }
      expect(suppressed).toEqual(new Set(vector.suppressed))
    })
  }

  test('disqualifies mid-turn icon drafts when unrelated workspace reads and shell steps follow', () => {
    const msgs = [
      { id: 'u', uuid: 'u', role: 'user', text: 'Build photo plugin', turnId: 't-plugin' },
      {
        id: 'a-gen-1',
        uuid: 'a-gen-1',
        role: 'assistant',
        turnId: 't-plugin',
        contentBlocks: [{
          type: 'tool_use',
          id: 'gen-1',
          name: 'generate_image',
          input: { prompt: 'Plugin icon v1' },
          __result: {
            is_error: false,
            content: [
              { type: 'image', path: '/pool/icon-v1.jpg', sourcePath: '/ws/image-v1.jpg' },
              { type: 'text', text: 'Saved: /ws/image-v1.jpg' },
            ],
          },
        }],
      },
      {
        id: 'a-ref',
        uuid: 'a-ref',
        role: 'assistant',
        turnId: 't-plugin',
        contentBlocks: [{
          type: 'tool_use',
          id: 'read-other',
          name: 'read',
          input: { path: '/ws/other-plugin/assets/icon.png' },
          __result: {
            is_error: false,
            content: [{ type: 'image', path: '/pool/other-icon.png', sourcePath: '/ws/other-plugin/assets/icon.png' }],
          },
        }],
      },
      {
        id: 'a-gen-2',
        uuid: 'a-gen-2',
        role: 'assistant',
        turnId: 't-plugin',
        contentBlocks: [{
          type: 'tool_use',
          id: 'gen-2',
          name: 'generate_image',
          input: { prompt: 'Plugin icon v2' },
          __result: {
            is_error: false,
            content: [
              { type: 'image', path: '/pool/icon-v2.jpg', sourcePath: '/ws/image-v2.jpg' },
              { type: 'text', text: 'Saved: /ws/image-v2.jpg' },
            ],
          },
        }],
      },
      {
        id: 'a-build',
        uuid: 'a-build',
        role: 'assistant',
        turnId: 't-plugin',
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'crop-icon',
            name: 'bash',
            input: { command: 'sips -z 256 256 /ws/image-v2.jpg --out /ws/assets/icon.png' },
            __result: { is_error: false, content: [{ type: 'text', text: 'done' }] },
          },
          {
            type: 'tool_use',
            id: 'read-e2e',
            name: 'read',
            input: { path: '/ws/dist/panel-fitted.png' },
            __result: {
              is_error: false,
              content: [{ type: 'image', path: '/pool/panel-fitted.png', sourcePath: '/ws/dist/panel-fitted.png' }],
            },
          },
        ],
      },
      {
        id: 'a-final',
        uuid: 'a-final',
        role: 'assistant',
        turnId: 't-plugin',
        isFinalReply: true,
        contentBlocks: [{
          type: 'text',
          phase: 'final_answer',
          text: 'Plugin verified end-to-end:\n\n![Live panel](/ws/dist/panel-fitted.png)',
        }],
      },
    ]
    const units = unitsFromMessages(msgs)
    const nodes = foldUnits(units, null, { 't-plugin': 'completed' }, {})
    expect(nodes.find(node => node.kind === 'turn-media')).toBeUndefined()
    // The embedded panel screenshot is suppressed on its tool card, while the two
    // mid-turn icon drafts remain attached to their own folded generation rows.
    const gen1Tools = units.find(unit => unit.type === 'tools' && unit.segment?.tools?.[0]?.toolCallId === 'gen-1')
    expect(gen1Tools?.suppressFigurePaths?.has('/pool/icon-v1.jpg')).toBe(false)
    expect(gen1Tools?.suppressFigurePaths?.has('/pool/icon-v2.jpg')).toBe(false)
    expect(gen1Tools?.suppressFigurePaths?.has('/pool/panel-fitted.png')).toBe(true)
  })

  test('resolves Saved: fallback paths for source_images and self-inspection on live tool cards', () => {
    const paths = collectTerminalGeneratedMediaPaths([
      {
        toolName: 'generate_image',
        args: { prompt: 'First draft' },
        outputText: 'Saved: /ws/image-first.jpg',
        media: [{ path: '/pool/first-hash.jpg' }],
      },
      {
        toolName: 'call_mcp_tool',
        args: {
          name: 'generate_image',
          arguments: { prompt: 'Second draft', source_images: ['/ws/image-first.jpg'] },
        },
        outputText: 'Saved: /ws/image-second.jpg',
        media: [{ path: '/pool/second-hash.jpg' }],
      },
      {
        toolName: 'read',
        args: { file_path: '/ws/image-second.jpg' },
      },
    ])
    expect([...paths]).toEqual(['/pool/second-hash.jpg'])
  })

  test('live turn keeps mid-turn generated assets inside tool cards and promotes terminal generations on completion', async () => {
    const baseUnitProps = {
      sessionId: 'live-media-s1',
      streamSessionId: 'live-media-s1',
      archived: false,
      running: false,
      composerAuthored: false,
      readOnly: false,
      editTarget: null,
      isThinkingExpanded: () => false,
      onToggleThinking: () => {},
    }

    const releaseS1 = retainSessionStream('live-media-s1')
    const releaseS2 = retainSessionStream('live-media-s2')
    const originalGetInitialState = chatStreamStore.getInitialState
    const hadDocument = 'document' in globalThis
    const previousDocument = (globalThis as any).document
    chatStreamStore.getInitialState = chatStreamStore.getState
    ;(globalThis as any).document = {
      createElement: () => {
        let html = ''
        return {
          get innerHTML() { return html },
          set innerHTML(value: string) { html = value },
          querySelectorAll: () => [],
          insertAdjacentHTML: (_pos: string, fragment: string) => { html += fragment },
        }
      },
    }
    try {
      chatStreamStore.setState(prev => ({
        sessions: {
          ...prev.sessions,
          'live-media-s1': { ...selectSessionStream(prev, 'live-media-s1'), history: [] },
          'live-media-s2': { ...selectSessionStream(prev, 'live-media-s2'), history: [] },
        },
      }))
      // 1. Mid-turn generation retracts from TurnMediaBlock into its folded activity row as soon as downstream work starts.
      ingestLocalUserTurn('live-media-s1', { text: 'Build plugin icon' })
      ingestChatEvent({ type: 'tool_start', sessionId: 'live-media-s1', turnId: 'turn-mid', toolCallId: 'g-mid', toolName: 'generate_image', args: { prompt: 'Icon asset' } })
      ingestChatEvent({ type: 'tool_end', sessionId: 'live-media-s1', turnId: 'turn-mid', toolCallId: 'g-mid', content: 'Saved: /ws/icon-raw.jpg', media: [{ path: '/pool/icon-raw.jpg' }] })
      await Promise.resolve()
      const beforeDownstreamHtml = renderToStaticMarkup(<LiveTail sessionId="live-media-s1" unitProps={{ ...baseUnitProps, running: true }} />)
      expect(beforeDownstreamHtml.match(/data-media-path="\/pool\/icon-raw\.jpg"/g)).toHaveLength(1)

      ingestChatEvent({ type: 'tool_start', sessionId: 'live-media-s1', turnId: 'turn-mid', toolCallId: 'b-mid', toolName: 'bash', args: { command: 'sips -z 256 256 /ws/icon-raw.jpg --out /ws/icon.png' } })
      await Promise.resolve()
      const duringDownstreamHtml = renderToStaticMarkup(<LiveTail sessionId="live-media-s1" unitProps={{ ...baseUnitProps, running: true }} />)
      expect(duringDownstreamHtml.match(/data-media-path="\/pool\/icon-raw\.jpg"/g)).toHaveLength(1)
      // Once b-mid starts, the image retreats inside g-mid's row (before b-mid), leaving nothing after b-mid at turn end.
      expect(duringDownstreamHtml.indexOf('data-media-path="/pool/icon-raw.jpg"')).toBeLessThan(
        duringDownstreamHtml.indexOf('data-tool-call-id="b-mid"'),
      )

      ingestChatEvent({ type: 'tool_end', sessionId: 'live-media-s1', turnId: 'turn-mid', toolCallId: 'b-mid', content: 'ok' })
      ingestChatEvent({ type: 'text_delta', sessionId: 'live-media-s1', turnId: 'turn-mid', messageId: 'm-mid', phase: 'final_answer', text: 'Plugin icon updated.' })
      ingestChatEvent({ type: 'done', sessionId: 'live-media-s1', turnId: 'turn-mid', status: 'completed' })
      await Promise.resolve()
      const settledMidHtml = renderToStaticMarkup(<LiveTail sessionId="live-media-s1" unitProps={baseUnitProps} />)
      expect(settledMidHtml).toContain('data-variant="turn" data-open="false"')
      const afterMidAnswer = settledMidHtml.slice(settledMidHtml.indexOf('Plugin icon updated.'))
      expect(afterMidAnswer).not.toContain('data-media-path=')

      // 2. Direct terminal generation stays visible below the final answer in TurnMediaBlock after completion.
      const terminalProps = { ...baseUnitProps, sessionId: 'live-media-s2', streamSessionId: 'live-media-s2' }
      ingestLocalUserTurn('live-media-s2', { text: 'Draw sunset cat' })
      ingestChatEvent({ type: 'tool_start', sessionId: 'live-media-s2', turnId: 'turn-direct', toolCallId: 'g-direct', toolName: 'generate_image', args: { prompt: 'Sunset cat' } })
      ingestChatEvent({ type: 'tool_end', sessionId: 'live-media-s2', turnId: 'turn-direct', toolCallId: 'g-direct', content: 'Saved: /ws/cat.jpg', media: [{ path: '/pool/cat.jpg' }] })
      ingestChatEvent({ type: 'text_delta', sessionId: 'live-media-s2', turnId: 'turn-direct', messageId: 'm-direct', phase: 'final_answer', text: 'Here is your wallpaper.' })
      ingestChatEvent({ type: 'done', sessionId: 'live-media-s2', turnId: 'turn-direct', status: 'completed' })
      await Promise.resolve()
      const settledDirectHtml = renderToStaticMarkup(<LiveTail sessionId="live-media-s2" unitProps={terminalProps} />)
      expect(settledDirectHtml).toContain('data-variant="turn" data-open="false"')
      expect(settledDirectHtml.match(/data-media-path="\/pool\/cat\.jpg"/g)).toHaveLength(1)
      const afterDirectAnswer = settledDirectHtml.slice(settledDirectHtml.indexOf('Here is your wallpaper.'))
      expect(afterDirectAnswer).toContain('data-media-path="/pool/cat.jpg"')
    } finally {
      chatStreamStore.getInitialState = originalGetInitialState
      if (hadDocument) (globalThis as any).document = previousDocument
      else delete (globalThis as any).document
      releaseS1()
      releaseS2()
      chatStreamStore.setState(prev => {
        const next = { ...prev.sessions }
        delete next['live-media-s1']
        delete next['live-media-s2']
        return { sessions: next }
      })
    }
  })
})
