// KlausIcons 全局装配：window 暴露。
//
// src/chat/chat.ts 数据面经 window.KlausIcons 消费（随未来拆域收敛）；组件直接
// import 本模块。RAW 字形注册由 registry 自身保证（registry import raw-glyphs），
// 这里无需再挂副作用 import。
import { icon, strokeGlyph24, fillGlyph24, fillGlyph24Sized } from './registry'
import { contextPieSvg } from './dynamic'

export { icon, strokeGlyph24, fillGlyph24, fillGlyph24Sized, contextPieSvg }

declare global {
  interface Window {
    KlausIcons: {
      icon: typeof icon
      strokeGlyph24: typeof strokeGlyph24
      fillGlyph24: typeof fillGlyph24
      fillGlyph24Sized: typeof fillGlyph24Sized
      contextPieSvg: typeof contextPieSvg
    }
  }
}

window.KlausIcons = { icon, strokeGlyph24, fillGlyph24, fillGlyph24Sized, contextPieSvg }
