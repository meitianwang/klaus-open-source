// 弹窗传送门：React 弹窗一律挂到 document.body（与旧版 appendChild 同位）。
//
// 直接把 kls-modal-overlay / *-modal 渲染成页面 section 的直接子节点会踩中
// styles.css 的环境页图层规则（.sk-section > * / .mcp-section > * … 设
// position: relative，特异度压过弹窗自身的 position: fixed），遮罩被夹进
// 内容流。所有全屏弹窗必须经此组件出正文树。
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

export function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}
