// 技能品牌 logo 的防复发测试。
//
// 钉的是三件具体的事：
//
// 1. 映射表只认技能目录名（大小写不敏感），表外技能必须回空串——回空串页面才
//    走代码字形兜底；回一个不存在的 src 会画出破图条。
// 2. 映射到的每个 PNG 必须真的在 public/skill-logos/ 里。映射与资源是两次独立
//    提交都可能动的东西，只钉映射不钉文件，删图/改名后页面就是破图。
// 3. 两个渲染 helper 的 HTML 形状：市场卡版只有一张铺满槽位的 img（砖壳由
//    iconClassName 卸掉），行式版保留砖壳外廓类并叠 logo 修饰类——CSS 靠这两个
//    类把砖的描边/底色/顶部小签让位给成品方砖图。
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

const LOGO_SKILLS = [
  'canvas',
  'computer-use',
  'cron-manager',
  'deep-research',
  'frontend-design',
  'klaus-docs',
  'pdf',
  'product-feature-video',
  'skill-creator',
  'slash-command-creator',
]

let getSkillLogoSrc: (skill: any) => string
let skillLogoImgHtml: (src: string) => string
let skillLogoBrickHtml: (src: string) => string
let skillRemoteIconHtml: (src: string) => string
let skillEmojiBrickHtml: (emoji: string) => string
let getSkillBrandTile: (skill: any) => any

beforeAll(async () => {
  // localize 经 window 桥读 settings 数据表，导入前先把桥立起来（同 plugin-market-terms.test）。
  const g = globalThis as any
  g.window = g
  g.currentLang = 'zh'
  await import('../settings/market-tables')
  const mod = await import('./localize')
  getSkillLogoSrc = mod.getSkillLogoSrc
  skillLogoImgHtml = mod.skillLogoImgHtml
  skillLogoBrickHtml = mod.skillLogoBrickHtml
  skillRemoteIconHtml = mod.skillRemoteIconHtml
  skillEmojiBrickHtml = mod.skillEmojiBrickHtml
  getSkillBrandTile = mod.getSkillBrandTile
})

describe('skill brand logos', () => {
  test('curated first-party skills map to a brand tile, everything else falls back', () => {
    for (const dirName of LOGO_SKILLS) {
      expect(getSkillLogoSrc({ dirName })).toBe(`skill-logos/${dirName}.png`)
    }
    expect(getSkillLogoSrc({ dirName: 'Canvas' })).toBe('skill-logos/canvas.png')
    expect(getSkillLogoSrc({ dirName: 'pdf' })).toBe('skill-logos/pdf.png')
    expect(getSkillLogoSrc({ name: 'weather' })).toBe('')
    expect(getSkillLogoSrc(null)).toBe('')
    expect(getSkillLogoSrc(undefined)).toBe('')
  })

  test('every mapped tile exists on disk under public/skill-logos', () => {
    for (const dirName of LOGO_SKILLS) {
      const src = getSkillLogoSrc({ dirName })
      expect(src).not.toBe('')
      expect(existsSync(new URL(`../../../public/${src}`, import.meta.url))).toBe(true)
    }
  })

  test('market-card helper renders a bare tile image, row helper keeps the brick shell', () => {
    const img = skillLogoImgHtml('skill-logos/canvas.png')
    expect(img).toContain('<img')
    expect(img).toContain('src="skill-logos/canvas.png"')
    expect(img).toContain('sk-logo-img')
    expect(img).not.toContain('sk-card-icon')

    const brick = skillLogoBrickHtml('skill-logos/canvas.png')
    expect(brick).toContain('sk-card-icon')
    expect(brick).toContain('sk-card-icon-logo')
    expect(brick).toContain('src="skill-logos/canvas.png"')
    expect(brick).toContain('aria-hidden="true"')
  })

  test('server-side icon channels: catalog URL and self-declared emoji, escaped', () => {
    const remote = skillRemoteIconHtml('https://klaus-ai.cn/market/x.png?a=1&b="2"')
    expect(remote).toContain('sk-logo-img')
    expect(remote).toContain('src="https://klaus-ai.cn/market/x.png?a=1&amp;b=&quot;2&quot;"')
    const emoji = skillEmojiBrickHtml('<b>🧪</b>')
    expect(emoji).toContain('sk-card-icon-emoji')
    expect(emoji).toContain('&lt;b&gt;🧪&lt;/b&gt;')
    expect(emoji).not.toContain('<b>')
  })

  test('iconography precedence: shipped tile, then catalog icon, then emoji, then glyph fallback', () => {
    expect(getSkillBrandTile({ dirName: 'canvas' })).toEqual({ kind: 'logo', src: 'skill-logos/canvas.png' })
    expect(getSkillBrandTile({ dirName: 'canvas', icon: 'https://x/y.png', emoji: '🎨' }))
      .toEqual({ kind: 'logo', src: 'skill-logos/canvas.png' })
    expect(getSkillBrandTile({ dirName: 'weather', icon: ' https://x/y.png ' }))
      .toEqual({ kind: 'icon', src: 'https://x/y.png' })
    expect(getSkillBrandTile({ dirName: 'weather', icon: '  ', emoji: ' 🧪 ' }))
      .toEqual({ kind: 'emoji', emoji: '🧪' })
    expect(getSkillBrandTile({ dirName: 'weather' })).toBeNull()
    expect(getSkillBrandTile(null)).toBeNull()
  })
})
