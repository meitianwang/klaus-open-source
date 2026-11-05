import { describe, expect, test } from 'bun:test'
import {
  endResources, endResourcesCoverEdits, pageIconSource, pageTitleAndIcon, stripEndResourceLinkLines, endResourceFileKind, websiteResourceLabel,
  type EndResource,
} from '../../../contracts/end-resources'
import { endResourcesForSession, publishEndResources, retireEndResources, subscribeEndResources } from './end-resources'
import vectors from '../../../contracts/vectors/end-resource-vectors.json'

describe('turn-end resource projection', () => {
  for (const vector of vectors.projection) test(vector.name, () => {
    expect(endResources({ complete: vector.complete, finalText: vector.finalText, editedPaths: vector.editedPaths, cwd: (vector as { cwd?: string }).cwd ?? null }))
      .toEqual(vector.expected as EndResource[])
  })

  test('the reply that produced three internet-link cards now produces none', () => {
    const reply = [
      '- 中文短视频口播，首选剪映数字人。据 [AI 数字人工具实测（2026）](https://lvyelab.com/articles/ai-digital-human-tools-review-2026) 的结论。',
      '- 想本地跑，[Duix-Avatar（原 HeyGem）](https://github.com/duixcom/Duix-Avatar/blob/main/README_zh.md) 是目前最完整的开源方案。',
      '- 价格来自 [VEED 的对比文](https://www.veed.io/learn/best-talking-head-video-apis)。',
    ].join('\n')
    expect(endResources({ complete: true, finalText: reply, editedPaths: [] })).toEqual([])
  })
})

describe('changed-files coverage', () => {
  for (const vector of vectors.coverage) test(vector.name, () => {
    expect(endResourcesCoverEdits(vector.resources as EndResource[], vector.editedPaths)).toBe(vector.covered)
  })
})

describe('reply lines that only repeat a card', () => {
  for (const vector of vectors.linkLines) test(vector.name, () => {
    expect(stripEndResourceLinkLines(vector.text, vector.files)).toBe(vector.expected)
  })
  test('fenced code is never pruned', () => {
    const text = '```\n[report.pdf](/work/out/report.pdf)\n```'
    expect(stripEndResourceLinkLines(text, ['/work/out/report.pdf'])).toBe(text)
  })
})

describe('page identity', () => {
  test('title and declared icon come from the markup', () => {
    expect(pageTitleAndIcon('<head><title> Team &amp; Board </title><link rel="apple-touch-icon" href="touch.png"><link rel="icon" href="fav.svg"></head>'))
      .toEqual({ title: 'Team & Board', icon: 'fav.svg' })
    expect(pageTitleAndIcon('<head><link rel="apple-touch-icon" href="touch.png"></head>')).toEqual({ title: null, icon: 'touch.png' })
    expect(pageTitleAndIcon('<p>no head</p>')).toEqual({ title: null, icon: null })
  })
  test('icons resolve next to the page and never leave it or the machine', () => {
    expect(pageIconSource('assets/fav.png?v=2', '/work/site/index.html')).toEqual({ type: 'file', path: '/work/site/assets/fav.png' })
    expect(pageIconSource('data:image/png;base64,AAAA', '/work/site/index.html')).toEqual({ type: 'url', src: 'data:image/png;base64,AAAA' })
    for (const refused of ['https://cdn.example/fav.png', '//cdn.example/fav.png', '../secret.png', '/etc/fav.png', 'fav.txt', 'data:text/html,x']) {
      expect(pageIconSource(refused, '/work/site/index.html')).toBeNull()
    }
  })
})

describe('labels', () => {
  test('file kinds name office formats and fall back to a generic file', () => {
    expect(['a.docx', 'a.xlsx', 'a.pptx', 'a.pdf', 'a.csv', 'a.tex', 'a.bin'].map(endResourceFileKind))
      .toEqual(['word', 'excel', 'powerpoint', 'pdf', 'spreadsheet', 'latex', 'file'])
  })
  test('overview labels show host and path for a URL and the name for a page', () => {
    expect(websiteResourceLabel('http://localhost:5173/')).toBe('localhost:5173')
    expect(websiteResourceLabel('http://localhost:5173/app?x=1')).toBe('localhost:5173/app?x=1')
    expect(websiteResourceLabel('/work/site/index.html')).toBe('index.html')
  })
})

describe('per-conversation publication', () => {
  test('publishes only turns with resources, notifies on change and retires per conversation', () => {
    let changes = 0
    const stop = subscribeEndResources(() => changes++)
    const turn = { turnId: 'a', resources: [{ type: 'website', target: 'http://localhost:3000/' }] as EndResource[] }
    publishEndResources('publication-a', [turn, { turnId: 'b', resources: [] }])
    publishEndResources('publication-a', [turn])
    expect(changes).toBe(1)
    expect(endResourcesForSession('publication-a')).toEqual([turn])
    expect(endResourcesForSession('publication-b')).toEqual([])
    retireEndResources('publication-a')
    expect(endResourcesForSession('publication-a')).toEqual([])
    expect(changes).toBe(2)
    stop()
  })
})
