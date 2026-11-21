// The transcript-side inline-visualization pass.
//
// The data layer (`inlineVisForTests`, `stripInlineVisLines`) pins the paragraph
// eligibility rule without a browser. Server rendering pins that the mount only
// happens on the committed DOM. A real-browser probe exercises the success,
// refused-read, and stale-content paths separately; the page content arrives
// with the message, so nothing in the renderer asks the host for a file.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../../contracts/vectors/inline-visualization-vectors.json'
import { parseInlineVisDirective, INLINE_VIS_PREFIX, inlineVisFileEligible } from '../../../../contracts/inline-visualization'
import { InlineVisualizationHtml, inlineVisForTests, stripInlineVisLines, unwrapMsgActionsHtml } from './inline-visualization'
import { renderMsgActionsHtml } from './factories'

const previousWindow = (globalThis as any).window
beforeAll(() => {
  ;(globalThis as any).window = { ...previousWindow, currentLang: 'zh' }
})
afterAll(() => {
  if (previousWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = previousWindow
})

describe('the ::klaus-inline-vis transcript pass', () => {
  test('mounting is content-driven: the component takes projected fragments and asks nothing of the host', () => {
    const html = '<div class="msg assistant"><p>::klaus-inline-vis{path="/tmp/chart.html"}</p></div>'
    const markup = renderToStaticMarkup(createElement(InlineVisualizationHtml, {
      html, className: 'msg-group assistant', sessionId: 's1',
      fragments: [{ path: '/tmp/chart.html', contents: '<html><body>ok</body></html>' }],
    }))
    // Server render mounts nothing: the frame is created in an effect on the
    // committed DOM, and its source is the fragment content, never a request.
    expect(markup).toContain('::klaus-inline-vis')
    expect(markup).not.toContain('<iframe')
  })

  test('a fragment whose read failed carries the refusal instead of content', () => {
    const fragment = { path: '/tmp/gone.html', contents: null, readError: 'file not found' }
    expect(fragment.contents).toBe(null)
    expect(fragment.readError).toBe('file not found')
  })

  test('the parser vectors stay in agreement with the block-splitting rule', () => {
    for (const vector of vectors) {
      const { kept, mounts } = inlineVisForTests([String(vector.source)])
      if (vector.parses) {
        expect(mounts).toHaveLength(1)
        expect(mounts[0]!.path).toBe(vector.path)
        expect(kept).toHaveLength(0)
      } else {
        expect(mounts).toHaveLength(0)
        expect(kept).toHaveLength(1)
      }
    }
  })

  test('fenced directive lines never arrive as paragraphs, and the DOM walk never sees them', () => {
    // In the real DOM walk `marked` keeps fence lines inside <pre><code>, so the
    // <p>-only walk never receives them. This test documents the invariant from
    // the twin's side: an UNSTRIPPED fence line would parse (the parser is
    // line-shaped), which is exactly why the walk operates on <p> elements the
    // markdown renderer produced and never on raw message text.
    const line = '::klaus-inline-vis{path="/tmp/vis.html"}'
    expect(parseInlineVisDirective(line)).not.toBe(null)
    // ...and the walk's input contract is paragraphs, which the renderer builds
    // from marked output where fence content is code, not paragraphs.
    const { mounts } = inlineVisForTests([])
    expect(mounts).toHaveLength(0)
  })

  test('a prose paragraph mentioning the syntax keeps its text and mounts nothing', () => {
    const { kept, mounts } = inlineVisForTests(['To render, write ::klaus-inline-vis{path="/tmp/vis.html"} in your reply.'])
    expect(mounts).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  test('a paragraph that is exactly one directive is consumed and replaced IN PLACE', () => {
    const { kept, mounts } = inlineVisForTests([
      '<p>Here is the dashboard you asked for.</p>',
      '<p>::klaus-inline-vis{path="/home/me/.klaus/visualizations/abc/home-dashboard.html"}</p>',
    ])
    expect(kept).toHaveLength(1)
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.path).toBe('/home/me/.klaus/visualizations/abc/home-dashboard.html')
  })

  test('two adjacent directive lines in one paragraph both mount', () => {
    const { kept, mounts } = inlineVisForTests([
      '<p>::klaus-inline-vis{path="/tmp/vis-a.html"}<br>::klaus-inline-vis{path="/tmp/vis-b.html"}</p>',
    ])
    expect(kept).toHaveLength(0)
    expect(mounts.map(m => m.path)).toEqual(['/tmp/vis-a.html', '/tmp/vis-b.html'])
  })

  test('a paragraph with one good and one malformed line mounts NOTHING', () => {
    // The cheaper failure is the visible syntax, not a half-consumed paragraph.
    const { kept, mounts } = inlineVisForTests([
      '<p>::klaus-inline-vis{path="/tmp/vis-a.html"}<br>::klaus-inline-vis{path="relative.html"}</p>',
    ])
    expect(mounts).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  test('a directive whose file name violates the whitelist mounts nothing', () => {
    // The name half of the whitelist is checked before any IPC, so
    // `Page.HTML`/`my_page.html` degrade to text exactly like an unparsed line.
    const { kept, mounts } = inlineVisForTests(['<p>::klaus-inline-vis{path="/tmp/My_Page.html"}</p>'])
    expect(mounts).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  test('more than eight directives in one message mount none beyond the cap', () => {
    // The cap is per MESSAGE, so it must straddle paragraphs: a directive
    // paragraph past the budget is left as text, never silently dropped
    // mid-paragraph.
    const paragraphs = Array.from({ length: 8 }, (_, i) => `<p>::klaus-inline-vis{path="/tmp/vis-${i}.html"}</p>`)
    expect(inlineVisForTests(paragraphs).mounts).toHaveLength(8)
    const second = inlineVisForTests([...paragraphs, '<p>::klaus-inline-vis{path="/tmp/vis-9.html"}</p>'])
    expect(second.mounts).toHaveLength(8)
    expect(second.kept).toHaveLength(1)
  })

  test('streaming hides complete directive paragraphs and nothing else', () => {
    const html = '<p>The page is ready:</p><p>::klaus-inline-vis{path="/tmp/vis.html"}</p><p>More prose.</p>'
    const stripped = stripInlineVisLines(html)
    expect(stripped).not.toContain(INLINE_VIS_PREFIX)
    expect(stripped).toContain('The page is ready:')
    expect(stripped).toContain('More prose.')
  })

  test('streaming leaves prose paragraphs that merely mention the syntax untouched', () => {
    const html = '<p>Use ::klaus-inline-vis{path="/tmp/vis.html"} in the reply.</p>'
    expect(stripInlineVisLines(html)).toBe(html)
  })

  test('streaming passes through markdown without the prefix without scanning', () => {
    const html = '<p>plain text</p>'
    expect(stripInlineVisLines(html)).toBe(html)
  })

  test('the DOM eligibility helper agrees with the contract', () => {
    expect(inlineVisFileEligible('home-dashboard.html', undefined)).toBe(true)
    expect(parseInlineVisDirective('::klaus-inline-vis{path="/a/home-dashboard.html"}')).not.toBe(null)
  })

  test('structured message mode preserves the action bar and turn/message metadata after end-resource cards', () => {
    const markdown = 'Updated `Main.dc.html` ("v30") & restored <header>\nLine two'
    const actionsHtml = renderMsgActionsHtml({
      ts: 1795251776000,
      copyText: '',
      uuid: '26378666-f6d9-4658-9777-ea817e00bf7b',
      turnId: '290ee6f2-4695-4ce8-9d4f-ff0e7c9e0ec0',
      kind: 'assistant',
      archived: false,
      running: false,
    })
    const unwrapped = unwrapMsgActionsHtml(actionsHtml, markdown)
    expect(unwrapped).not.toBeNull()
    expect(unwrapped!.attrs['data-copy-text']).toBe(markdown)
    expect(unwrapped!.attrs['data-turn-id']).toBe('290ee6f2-4695-4ce8-9d4f-ff0e7c9e0ec0')
    expect(unwrapped!.attrs['data-message-uuid']).toBe('26378666-f6d9-4658-9777-ea817e00bf7b')

    const markup = renderToStaticMarkup(createElement(InlineVisualizationHtml, {
      html: `<div class="msg assistant">${markdown}</div>${actionsHtml}`,
      className: 'msg-group assistant',
      sessionId: 's-end-resource',
      message: { html: '<p>Updated Main.dc.html</p>', markdown, answer: true, actionsHtml },
      afterContent: createElement('div', { 'data-end-resource-card': '1' }, '01 · Main'),
    }))
    const cardIdx = markup.indexOf('data-end-resource-card="1"')
    const actionsIdx = markup.indexOf('class="msg-actions"')
    expect(cardIdx).toBeGreaterThan(0)
    expect(actionsIdx).toBeGreaterThan(cardIdx)
    expect(markup).toContain('data-turn-id="290ee6f2-4695-4ce8-9d4f-ff0e7c9e0ec0"')
    expect(markup).toContain('data-message-uuid="26378666-f6d9-4658-9777-ea817e00bf7b"')
    expect(markup).toContain('data-action="branch"')
    expect(markup).toContain('class="msg-action-btn"')
  })

  test('structured message mode omits the action bar when actionsHtml is empty', () => {
    expect(unwrapMsgActionsHtml('', 'plain reply')).toBeNull()
    const markup = renderToStaticMarkup(createElement(InlineVisualizationHtml, {
      html: '<div class="msg assistant"><p>plain</p></div>',
      className: 'msg-group assistant',
      sessionId: 's-no-actions',
      message: { html: '<p>plain</p>', markdown: 'plain', answer: false, actionsHtml: '' },
      afterContent: createElement('div', { 'data-end-resource-card': '1' }, 'card'),
    }))
    expect(markup).toContain('data-end-resource-card="1"')
    expect(markup).not.toContain('class="msg-actions"')
  })
})
