// 插件市场词表命中判定的防复发测试。
//
// 钉的是一件具体的事故：图标规则与中文简介规则都用裸 substring 比词表，`built-in`
// 里的 `ui` 命中了设计档那条规则，于是内置浏览器插件在插件页上摆着一枚调色板图标、
// 简介写着「设计协作插件，用于读取设计资产……」。同一个坑还会打到任何简介里出现
// build / guide / require 的市场条目。
//
// 断言走对外的两个函数（页面真正调用的那两个），不测内部 helper：词表和规则顺序
// 也是这条行为的一部分，绕过它们等于只测了一个正则。
import { beforeAll, describe, expect, test } from 'bun:test'

const BUILTIN_BROWSER = {
  id: 'browser@builtin',
  name: 'browser',
  description:
    "Klaus built-in browser capability: drive the in-app browser or the user's Chrome "
    + '(via the Klaus Chrome extension) through the host-managed klaus-browser MCP server.',
  category: 'engineering',
  source: 'builtin',
}

let getPluginIconName: (plugin: any) => string
let localizePluginDescription: (plugin: any) => string

beforeAll(async () => {
  // 数据表模块在导入时往 window 上挂表，localize 也经 window 桥读它们。
  const g = globalThis as any
  g.window = g
  g.currentLang = 'zh'
  await import('../settings/market-tables')
  const localize = await import('./localize')
  getPluginIconName = localize.getPluginIconName
  localizePluginDescription = localize.localizePluginDescription
})

describe('plugin market term matching', () => {
  test('内置浏览器插件按浏览器归档，不再被 built-in 里的 ui 判成设计类', () => {
    expect(getPluginIconName(BUILTIN_BROWSER)).toBe('browser')
    expect(localizePluginDescription(BUILTIN_BROWSER)).toContain('浏览器')
  })

  test('短词只在词首命中：build / rapid 不再触发 ui / api 规则', () => {
    const builder = { id: 'x@m', name: 'x', description: 'Build and ship faster.', category: 'other' }
    const rapid = { id: 'y@m', name: 'y', description: 'Rapid prototyping helper.', category: 'other' }
    expect(getPluginIconName(builder)).not.toBe('palette')
    expect(getPluginIconName(rapid)).not.toBe('api')
  })

  test('真的以词首出现时照旧命中（词表本身仍然生效）', () => {
    const ui = { id: 'z@m', name: 'z', description: 'UI kit for dashboards.', category: 'other' }
    const api = { id: 'w@m', name: 'w', description: 'API client for REST endpoints.', category: 'other' }
    expect(getPluginIconName(ui)).toBe('palette')
    expect(getPluginIconName(api)).toBe('api')
  })

  test('派生形不受影响：词尾不设边界', () => {
    const logs = { id: 'l@m', name: 'l', description: 'Query logstash pipelines.', category: 'other' }
    expect(localizePluginDescription(logs)).toContain('监控')
  })

  test('first-party plugin descriptions override generic category matches', () => {
    const diagram = { id: 'digram@klaus-official', name: 'digram', description: 'Render a diagram and export it as SVG.', category: 'other' }
    const model3d = { id: 'model3d@klaus-official', name: 'model3d', description: 'Render a 3D scene.', category: 'design' }
    const prototype = { id: 'prototype-studio@klaus-official', name: 'prototype-studio', description: 'Design clickable interfaces.', category: 'design' }
    expect(localizePluginDescription(diagram)).toContain('PNG/JPG/SVG')
    expect(localizePluginDescription(model3d)).toContain('3D 视图')
    expect(localizePluginDescription(prototype)).toContain('桌面、平板和手机')
    expect(localizePluginDescription(prototype)).toContain('可视化编辑器')
    expect(localizePluginDescription(prototype)).toContain('PDF 和 FIG')
    expect(localizePluginDescription(prototype)).not.toContain('FigCraft')
    expect(localizePluginDescription(prototype)).toContain('首次使用需更新桌面端')
    expect(new Set([diagram, model3d, prototype].map(localizePluginDescription)).size).toBe(3)
    expect(localizePluginDescription({ ...diagram, id: 'digram@another-market' })).not.toContain('PNG/JPG/SVG')
  })
})
