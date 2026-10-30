// 标注模式的纯逻辑门禁。
//
// DOM 拾取（elementFromPoint / meaningfulTarget）要真浏览器才能验，那部分走浏览器
// 验证；这里钉的是**发出去的那段文字长什么样**——它是标注唯一的产物，写错了就等于
// 把用户指的东西送错。
import { describe, expect, test } from 'bun:test'

import { annotationMessage } from './annotate'

const PATH = '/Users/x/.klaus/canvas/canvases/latency-report.canvas.tsx'

describe('annotationMessage', () => {
  test('用户的话在最前面，引文在后', () => {
    const text = annotationMessage(
      { text: 'p95 290ms', section: 'Where the time went', note: '这个数是哪来的？' },
      PATH,
    )
    const noteAt = text.indexOf('这个数是哪来的？')
    const quoteAt = text.indexOf('> p95 290ms')
    expect(noteAt).toBeGreaterThanOrEqual(0)
    expect(quoteAt).toBeGreaterThan(noteAt)
  })

  test('引文用 blockquote，模型才能分清谁说的', () => {
    const text = annotationMessage({ text: 'p95 290ms', note: 'why' }, PATH)
    expect(text).toContain('> p95 290ms')
  })

  test('有小节名就带上 —— 一份报告里四张延迟表，「290ms」是歧义的', () => {
    const withSection = annotationMessage(
      { text: '290', section: 'Where the time went', note: 'why' },
      PATH,
    )
    expect(withSection).toContain('under "Where the time went"')
    const withoutSection = annotationMessage({ text: '290', note: 'why' }, PATH)
    expect(withoutSection).not.toContain('under')
    // 没有小节时也要说清是哪个 canvas。
    expect(withoutSection).toContain('latency-report.canvas.tsx')
  })

  test('文件名给人看，绝对路径给下一轮编辑用', () => {
    const text = annotationMessage({ text: 'x', note: 'why' }, PATH)
    // 正文里出现短名，末尾出现完整路径。
    expect(text).toContain('latency-report.canvas.tsx')
    expect(text.trimEnd().endsWith(PATH)).toBe(true)
  })

  test('没有目录的裸文件名不会崩', () => {
    const text = annotationMessage({ text: 'x', note: 'why' }, 'report.canvas.tsx')
    expect(text).toContain('report.canvas.tsx')
  })
})
