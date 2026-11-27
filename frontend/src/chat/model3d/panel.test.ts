import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { I18N } from '../../i18n/messages'
import { semanticActivity, semanticActivityLabel } from '../transcript/activity-semantic'
import { activityToolIconName } from '../transcript/activity-tool-model'
import { skillDisplayName } from '../transcript/chat-activity'
import { invalidateSkillsDataCache } from '../../pages/skills/data'

const readFrontendFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8')

const INDEX_HTML = readFrontendFile('index.html')
const STYLES_CSS = readFrontendFile('css/styles.css')
const CJK = /[\u4e00-\u9fff]/

function model3dMarkup(): string {
  const from = INDEX_HTML.indexOf('<section id="model3d-panel"')
  const to = INDEX_HTML.indexOf('</section>', from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return INDEX_HTML.slice(from, to + '</section>'.length)
}

describe('model3d panel chrome and localization', () => {
  test('renders inline text labels and localized aria hooks on toolbar controls', () => {
    const markup = model3dMarkup()

    expect(markup).toContain('id="model3d-panel" class="model3d-panel" data-i18n-aria-label="model3d_title"')
    expect(markup).toContain('id="model3d-doc-select" class="model3d-doc-select" data-i18n-aria-label="model3d_scene_select"')

    expect(markup).toContain('id="model3d-fit" class="model3d-tool-btn model3d-tool-btn--labeled"')
    expect(markup).toContain('<span data-kls-icon="model3d-fit"></span>')
    expect(markup).toContain('<span class="model3d-tool-label" data-i18n="model3d_fit">Fit view</span>')

    expect(markup).toContain('id="model3d-grid" class="model3d-tool-btn model3d-tool-btn--labeled is-active"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('<span data-kls-icon="model3d-grid"></span>')
    expect(markup).toContain('<span class="model3d-tool-label" data-i18n="model3d_grid">Grid</span>')

    expect(I18N.en.model3d_fit).toBe('Fit view')
    expect(I18N.en.model3d_grid).toBe('Grid')
    expect(I18N.zh.model3d_fit).toBe('居中视角')
    expect(I18N.zh.model3d_grid).toBe('网格')
  })

  test('suppresses flex display rules when model3d controls or overlays carry hidden', () => {
    expect(STYLES_CSS).toMatch(/\.model3d-panel\s+\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/)
  })

  test('constrains the WebGL canvas CSS box to 100% of the viewport on HiDPI displays', () => {
    expect(STYLES_CSS).toMatch(/\.model3d-viewport\s+canvas\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s)
    const viewportSource = readFrontendFile('src/chat/model3d/viewport.ts')
    expect(viewportSource).toContain("this.renderer.domElement.style.width = '100%'")
    expect(viewportSource).toContain("this.renderer.domElement.style.height = '100%'")
  })

  test('forwards scene document id through mesh and apply bridge calls for multi-scene sessions', () => {
    const bridgeSource = readFrontendFile('bridge/klaus-api.ts')
    expect(bridgeSource).toContain("mesh: (sessionId: string, name: string, id?: string) =>")
    expect(bridgeSource).toContain("call('model3d:mesh', { sessionId, name, ...(id ? { id } : {}) })")
    expect(bridgeSource).toContain("apply: (sessionId: string, ops: unknown[], baseVersion?: number, id?: string) =>")
    expect(bridgeSource).toContain("call('model3d:apply', { sessionId, ops, baseVersion, ...(id ? { id } : {}) })")
  })

  test('ships Chinese translations for every model3d outliner, modifier, physics, animation, and light key', () => {
    const enKeys = Object.keys(I18N.en).filter(key => key.startsWith('model3d_'))
    const zhKeys = Object.keys(I18N.zh).filter(key => key.startsWith('model3d_'))
    expect(zhKeys.sort()).toEqual(enKeys.sort())

    for (const key of zhKeys) {
      const zhValue = I18N.zh[key as keyof typeof I18N.zh]
      expect(typeof zhValue).toBe('string')
      expect(CJK.test(zhValue)).toBe(true)
    }

    const modifiers = [
      'subdivide', 'mirror', 'array', 'boolean', 'solidify', 'bevel', 'decimate',
      'smooth', 'wireframe', 'triangulate', 'remesh', 'hull', 'screw', 'extrude',
    ]
    for (const mod of modifiers) {
      const key = `model3d_mod_${mod}` as keyof typeof I18N.zh
      expect(CJK.test(I18N.zh[key])).toBe(true)
    }
  })

  test('maps all 20 model3d MCP tools to localized semantic labels and the 3D glyph', () => {
    const tools: Array<[string, Record<string, unknown>, string, string]> = [
      ['model3d_scene', { action: 'new', title: '大盾守卫' }, 'Created 3D scene · 大盾守卫', '已创建 3D 场景 · 大盾守卫'],
      ['model3d_scene', { action: 'clear', title: '大盾守卫' }, 'Cleared 3D scene · 大盾守卫', '已清空 3D 场景 · 大盾守卫'],
      ['model3d_scene', { action: 'summary' }, 'Opened 3D scene', '已打开 3D 场景'],
      ['model3d_add', { kind: 'cube', name: 'Body_Torso' }, 'Added 3D object · Body_Torso', '已添加 3D 对象 · Body_Torso'],
      ['model3d_transform', { name: 'Body_Torso' }, 'Transformed 3D object · Body_Torso', '已调整 3D 变换 · Body_Torso'],
      ['model3d_modifier', { name: 'Body_Torso', type: 'subdivide' }, 'Updated 3D modifier · Body_Torso', '已更新 3D 修改器 · Body_Torso'],
      ['model3d_material', { name: 'Bronze' }, 'Updated 3D material · Bronze', '已设置 3D 材质 · Bronze'],
      ['model3d_scene_settings', { fps: 24 }, 'Updated 3D scene settings', '已更新 3D 场景设置'],
      ['model3d_render', { format: 'png' }, 'Rendered 3D scene', '已渲染 3D 场景'],
      ['model3d_animate', { name: 'Shield_Arm' }, 'Updated 3D animation · Shield_Arm', '已编辑 3D 动画 · Shield_Arm'],
      ['model3d_physics', { name: 'Cape' }, 'Ran 3D physics · Cape', '已模拟 3D 物理 · Cape'],
      ['model3d_io', { action: 'import', path: '/tmp/knight.glb' }, 'Imported 3D asset · knight.glb', '已导入 3D 模型 · knight.glb'],
      ['model3d_io', { action: 'export', path: '/tmp/knight.glb' }, 'Exported 3D asset · knight.glb', '已导出 3D 模型 · knight.glb'],
      ['model3d_document', { action: 'load', path: '/tmp/scene.model3d.json' }, 'Loaded 3D project · scene.model3d.json', '已加载 3D 工程 · scene.model3d.json'],
      ['model3d_document', { action: 'save', path: '/tmp/scene.model3d.json' }, 'Saved 3D project · scene.model3d.json', '已保存 3D 工程 · scene.model3d.json'],
      ['model3d_serialize', {}, 'Read 3D scene', '已读取 3D 场景'],
      ['model3d_mesh', { name: 'Body_Torso' }, 'Read 3D mesh · Body_Torso', '已读取 3D 网格 · Body_Torso'],
      ['model3d_inspect', { name: 'Body_Torso' }, 'Inspected 3D scene · Body_Torso', '已查看 3D 场景 · Body_Torso'],
      ['model3d_mesh_edit', { name: 'Body_Torso' }, 'Edited 3D mesh · Body_Torso', '已编辑 3D 网格 · Body_Torso'],
      ['model3d_sculpt', { name: 'Body_Torso' }, 'Sculpted 3D mesh · Body_Torso', '已雕刻 3D 模型 · Body_Torso'],
      ['model3d_uv', { name: 'Body_Torso' }, 'Unwrapped 3D UVs · Body_Torso', '已展开 3D UV · Body_Torso'],
      ['model3d_geometry', { name: 'Body_Torso' }, 'Built 3D geometry · Body_Torso', '已构建 3D 几何体 · Body_Torso'],
      ['model3d_rig', { name: 'Armature' }, 'Rigged 3D model · Armature', '已绑定 3D 骨骼 · Armature'],
      ['model3d_texture', { name: 'Armor_Albedo' }, 'Edited 3D texture · Armor_Albedo', '已编辑 3D 贴图 · Armor_Albedo'],
    ]

    for (const [tool, args, expectedEn, expectedZh] of tools) {
      const indirect = semanticActivity('call_mcp_tool', { name: `mcp__host-model3d__${tool}`, arguments: args })
      expect(indirect).not.toBeNull()
      expect(indirect!.icon).toBe('model3d')
      expect(semanticActivityLabel(indirect!, 'done', 'en')).toBe(expectedEn)
      expect(semanticActivityLabel(indirect!, 'done', 'zh')).toBe(expectedZh)
      expect(activityToolIconName('call_mcp_tool', { name: `mcp__host-model3d__${tool}`, arguments: args })).toBe('model3d')

      const direct = semanticActivity(`mcp__klaus-model3d__${tool}`, args)
      expect(direct).not.toBeNull()
      expect(semanticActivityLabel(direct!, 'done', 'zh')).toBe(expectedZh)
    }
  })

  test('resolves plugin-qualified model3d:model3d skill identifier to its localized product name without prewarmed cache', () => {
    const g = globalThis as any
    const previousWindow = Object.getOwnPropertyDescriptor(g, 'window')
    try {
      g.window = {
        currentLang: 'zh',
        SKILL_TEXT_I18N: {
          model3d: {
            en: ['3D Studio', 'Create editable 3D scenes.'],
            zh: ['3D 工作室', '创建可编辑的 3D 场景。'],
          },
        },
      }
      invalidateSkillsDataCache()
      expect(skillDisplayName('model3d:model3d')).toBe('3D 工作室')
      expect(skillDisplayName('model3d')).toBe('3D 工作室')
      g.window.currentLang = 'en'
      expect(skillDisplayName('model3d:model3d')).toBe('3D Studio')
    } finally {
      if (previousWindow) Object.defineProperty(g, 'window', previousWindow)
      else delete g.window
    }
  })

  test('collapses repeated same-turn 3D scene rebuilds with the same title into the newest panel card', async () => {
    const g = globalThis as any
    const previousWindow = g.window
    g.window = { ...previousWindow, addEventListener() {}, currentLang: 'zh' }
    try {
      const { uniqueVisualArtifacts } = await import('../transcript/TranscriptView')
      const collapsed = uniqueVisualArtifacts([
        { kind: 'model3d', id: 'm3d-draft-0', title: '大盾守卫 (Big Shield Gardna)' },
        { kind: 'model3d', id: 'm3d-draft-1', title: '大盾守卫 (Big Shield Gardna)' },
        { kind: 'model3d', id: 'm3d-draft-2', title: '大盾守卫 (Big Shield Gardna)' },
        { kind: 'model3d', id: 'm3d-final-3', title: '大盾守卫 (Big Shield Gardna)' },
      ])
      expect(collapsed).toEqual([
        { kind: 'model3d', id: 'm3d-final-3', title: '大盾守卫 (Big Shield Gardna)' },
      ])

      const distinct = uniqueVisualArtifacts([
        { kind: 'model3d', id: 'm3d-1', title: '大盾守卫' },
        { kind: 'model3d', id: 'm3d-2', title: '黑魔导' },
      ])
      expect(distinct).toHaveLength(2)
    } finally {
      g.window = previousWindow
    }
  })
})
