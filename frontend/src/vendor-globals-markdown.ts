// marked / hljs 的 window 垫片（主窗口与 artifact 预览窗共用）。
// katex 只有主窗口用，见 vendor-globals.ts。
import * as marked from 'marked'
import hljs from 'highlight.js/lib/common'

declare global {
  interface Window {
    marked: typeof marked
    hljs: typeof hljs
  }
}

// UI 脚本用到 marked.parse / marked.use / marked.setOptions / new marked.Renderer，
// 与旧 UMD 全局对齐的是整个命名空间而非 marked 实例。
window.marked = marked
window.hljs = hljs
