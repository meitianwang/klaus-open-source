// Klaus 桌面端图标单一来源。
//
// 所有 UI 字形数据住在这里；js/ 与后续组件一律经 KlausIcons 取图标，
// 禁止再写内联 <svg>。查找顺序：
//   - LIBRARY（library.ts）：统一图标库，主库 @phosphor-icons/core，phosphor 缺
//     字形时取 lucide-static；UI chrome 字形的第一来源，新图标一律从这里进，
//     不再手绘。
//   - RAW（raw-glyphs.ts）：仅剩品牌标、多元素动画字形、两个库都无等价物的
//     个别字形。
//
// 程序化绘图（上下文饼图等参数化生成器）在 dynamic.ts，不属于字形数据。
import { LIBRARY } from './library'
// raw-glyphs 是纯数据模块（同 library）：合并随本模块求值完成，任何
// icon() 调用点 RAW 表必已就绪，与 chunk 切分和 import 顺序无关。
import { RAW_GLYPHS } from './raw-glyphs'

// 例外字形表（键：域-用途）。值必须是完整 <svg …>…</svg>。
export const RAW: Record<string, string> = { ...RAW_GLYPHS }

export interface IconOptions {
  /** 渲染尺寸（px）。RAW 字形自带尺寸时不传即保持原样。 */
  size?: number
  /** 附加 class。 */
  cls?: string
}

export function icon(name: string, opts: IconOptions = {}): string {
  const lib = LIBRARY[name]
  if (lib) return applyShellOpts(lib, opts)
  const raw = RAW[name]
  if (raw) return applyShellOpts(raw, opts)
  throw new Error(`KlausIcons: unknown icon "${name}"`)
}

// 原样字形（LIBRARY/RAW）的调用时 shell 覆盖：追加 class / 替换显式尺寸。
function applyShellOpts(svg: string, opts: IconOptions): string {
  let out = svg
  if (opts.cls) {
    out = out.includes('class="')
      ? out.replace('class="', `class="${opts.cls} `)
      : out.replace('<svg', `<svg class="${opts.cls}"`)
  }
  if (Number.isFinite(opts.size)) {
    out = out
      .replace(/\swidth="[^"]*"/, '')
      .replace(/\sheight="[^"]*"/, '')
      .replace('<svg', `<svg width="${opts.size}" height="${opts.size}"`)
  }
  return out
}

// —— 壳工厂：把「数据态的 path body」（MCP 商店目录 iconSvg、技能/插件图标库）
// 包进统一的 svg 壳。body 是数据不是字形库条目，所以走工厂而非 RAW 表。壳属性
// 与收编前各调用点逐字一致。

/** 24 网格描边壳（MCP 市场/已装列表的服务图标）。 */
export function strokeGlyph24(body: string, size: number): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

/** 24 网格填充壳（技能库字形，无显式尺寸，由 CSS 控）。 */
export function fillGlyph24(body: string): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor">${body}</svg>`
}

/** 24 网格填充壳，带显式尺寸（插件/快捷命令图标）。 */
export function fillGlyph24Sized(body: string, size: number): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${body}</svg>`
}
