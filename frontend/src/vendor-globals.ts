// vendor 全局垫片（主窗口）：marked / hljs / katex 由 npm 依赖提供，UI 脚本仍按
// classic-script 时代的 window 全局消费。在原 <script> 位挂同名全局，
// 行为与 vendor/*.min.js 一致。
//
// highlight.js 用 lib/common（与原 min 构建同为常用语言子集，避免全量语言
// 拖慢首帧解析）；katex 的 CSS 走 npm 包自带（含字体），见 index.html。
import './vendor-globals-markdown'
import katex from 'katex'
// katex 样式（含 @font-face，字体由 Vite 从 npm 包里拉进产物）；原 vendor/katex.min.css + vendor/fonts。
import 'katex/dist/katex.min.css'

// 运行时挂 katex 默认导出（render/renderToString/…），与旧 UMD 全局一致。
// katex 的 d.ts 自带 `export as namespace katex` 全局声明，再往 Window 上合并
// 同名属性会撞型，所以这里直接断言赋值，不声明 Window 成员。
;(window as any).katex = katex
