// Guard: Klaus 自己的功能名在中文界面里必须是中文。
//
// 钉的是两件具体的事：
//
// 1. 技能页「内置」档的显示名走 SKILL_TEXT_I18N 的 zh 档，缺条目或 zh 名字写成
//    英文时，页面就摆着 "Canvas" 这种半中半英的卡——同一档里电脑操控、深度研究都
//    是中文，只有它漏了（canvas，2026-09-30）。内置技能一共七个，名字来自引擎的
//    builtin_skills() 与宿主 builtins.ts 的 BUNDLED_COMMANDS（loadedFrom
//    'builtin-skill'）；这里按页面实际渲染的 dirName 显式列出，不去读引擎子模块
//    ——桌面端门禁不依赖 engine 是否已检出。
//
// 2. 中文字典里 Klaus 自有功能的标签不能留英文，且中英两档的值不能写反
//    （slash_commands_category_mcp 曾把「连接器」放进 en 档、"Connectors" 放进 zh
//    档，中文界面于是显示英文）。英文档出现中文即判为写反。
//
// 第三方品牌名（GitHub / Notion / Claude / API Key 这类）本就该原样显示，所以第
// 二条只按显式清单断言，不做「zh 值必须含中文」的全体扫描——那种扫描会把占位符
// （user@host[:port]）和厂商名全判成错。
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const BUILTIN_SKILL_DIR_NAMES = [
  'canvas',
  'computer-use',
  'cron-manager',
  'deep-research',
  'klaus-docs',
  'skill-creator',
  'slash-command-creator',
]

// 中文档必须含中文的键：都是用户能看见的功能标签/徽标，不是厂商名。
const ZH_MUST_TRANSLATE = [
  'canvas_title',
  'agents_badge_worktree',
  'agents_badge_background',
  'agents_badge_maxturns',
  'cron_form_pick_date',
  'subagent_default_name',
  'pasted_text_identity',
  'image_gen_field_provider',
  'slash_commands_category_mcp',
  'browser_open_failed',
]

const hasCjk = (value: string) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(value)

function dictionary(block: 'en' | 'zh'): Map<string, string> {
  const source = readFileSync(
    new URL('../../i18n/messages.ts', import.meta.url),
    'utf8',
  )
  const start = source.indexOf(`  ${block}: {`)
  expect(start).toBeGreaterThan(-1)
  let depth = 0
  let end = start
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const entries = new Map<string, string>()
  const pattern = /([A-Za-z0-9_]+):\s*'((?:[^'\\]|\\.)*)'/g
  for (const match of source.slice(start, end).matchAll(pattern)) {
    entries.set(match[1]!, match[2]!)
  }
  return entries
}

let table: Record<string, Record<string, [string, string]>>

beforeAll(async () => {
  const g = globalThis as any
  g.window = g
  g.currentLang = 'zh'
  // 数据表在导入时挂到 window，localize 也经 window 桥读它。
  await import('../settings/market-tables')
  table = (globalThis as any).window.SKILL_TEXT_I18N
})

describe('builtin skill display names', () => {
  test('七个内置技能在中文档都有中文显示名', () => {
    const untranslated = BUILTIN_SKILL_DIR_NAMES.filter(name => {
      const zh = table[name]?.zh
      return !zh || !hasCjk(zh[0])
    })
    expect(untranslated).toEqual([])
  })

  test('中文简介同样存在，不回退成引擎的英文 description', () => {
    const missing = BUILTIN_SKILL_DIR_NAMES.filter(name => {
      const zh = table[name]?.zh
      return !zh || !hasCjk(zh[1] || '')
    })
    expect(missing).toEqual([])
  })

  test('localizeSkillName 在中文档给出中文名', async () => {
    const localize = await import('./localize')
    expect(localize.localizeSkillName({ dirName: 'canvas', name: 'canvas' })).toBe('画布')
    expect(localize.localizeSkillName({ dirName: 'computer-use', name: 'computer-use' })).toBe('电脑操控')
  })
})

describe('talking-head marketplace localization', () => {
  test('market and installed rows follow the selected interface language', async () => {
    const localize = await import('./localize')
    const row = { dirName: 'talking-head-video', name: '口播视频剪辑', description: '市场中文简介' }
    const global = globalThis as any
    try {
      global.currentLang = 'en'
      expect(localize.localizeSkillName(row)).toBe('Talking-head Video')
      expect(hasCjk(localize.localizeSkillDescription(row))).toBe(false)
      global.currentLang = 'zh'
      expect(localize.localizeSkillName(row)).toBe('口播视频剪辑')
      expect(localize.localizeSkillDescription(row)).toContain('圆形人物画中画')
    } finally {
      global.currentLang = 'zh'
    }
  })
})

describe('official plugin card names', () => {
  // 官方插件的 name 是小写 slug，没进覆盖表时卡片会摆机械大写的 slug
  // （model3d → "Model3d"），用户读不出插件是干什么的。这里钉住三个官方
  // 插件在中英两档的产品名；中文名与各自面板标题一致（3D 面板叫「3D 工作室」）。
  const OFFICIAL_PLUGINS = [
    { id: 'digram@klaus-official', name: 'digram', zh: '图表', en: 'Diagrams' },
    { id: 'model3d@klaus-official', name: 'model3d', zh: '3D 工作室', en: '3D Studio' },
    { id: 'prototype-studio@klaus-official', name: 'prototype-studio', zh: '界面原型设计', en: 'Interface Design' },
    { id: 'video-editing@klaus-official', name: 'video-editing', zh: '视频剪辑', en: 'Video Editing' },
  ]

  test('中文档给出中文产品名，不回退成 slug 的机械大写', async () => {
    const localize = await import('./localize')
    const g = globalThis as any
    g.currentLang = 'zh'
    for (const plugin of OFFICIAL_PLUGINS) {
      expect(localize.localizePluginName(plugin)).toBe(plugin.zh)
    }
  })

  test('英文档给出产品名，不摆小写 slug', async () => {
    const localize = await import('./localize')
    const g = globalThis as any
    g.currentLang = 'en'
    try {
      for (const plugin of OFFICIAL_PLUGINS) {
        expect(localize.localizePluginName(plugin)).toBe(plugin.en)
      }
    } finally {
      g.currentLang = 'zh'
    }
  })

  // 技能页「已安装/用户安装」档会列出官方插件贡献的技能条目，键是技能目录名；
  // 没进 SKILL_TEXT_I18N 时中文界面直接摆 slug（digram / model3d / prototype-studio）。
  test('官方插件贡献的技能条目在中文档也有产品名', async () => {
    const localize = await import('./localize')
    const g = globalThis as any
    g.currentLang = 'zh'
    for (const plugin of OFFICIAL_PLUGINS) {
      expect(localize.localizeSkillName({ dirName: plugin.name, name: plugin.name })).toBe(plugin.zh)
    }
  })
})

describe('ui dictionary language pairing', () => {
  test('英文档不含中文：中英值写反即失败', () => {
    const en = dictionary('en')
    const swapped = [...en].filter(([, value]) => hasCjk(value)).map(([key]) => key)
    expect(swapped).toEqual([])
  })

  test('Klaus 自有功能标签在中文档已翻译', () => {
    const zh = dictionary('zh')
    const untranslated = ZH_MUST_TRANSLATE.filter(key => !hasCjk(zh.get(key) || ''))
    expect(untranslated).toEqual([])
  })
})
