// HTML 串宿主元素：内容不变就不碰 DOM。
//
// React 19 的属性更新按引用比对，行内 dangerouslySetInnerHTML={{ __html: s }}
// 每次渲染都是一个新对象，于是不管 s 变没变都会重写一遍 innerHTML——宿主下的
// 子节点全部销毁重建。代价在流式回合里直接可见：工具行的入场动画逐 token 重放
// （看上去一直在闪），同时 DOM 上的开合类名与用户选区被一起抹掉。
//
// 这里把 { __html } 缓存成「按内容取值」的稳定引用：HTML 串没变就返回同一个
// 对象，React 的引用比对判定无变化，DOM 原样保留。
import { createElement, useRef } from 'react'
import type { ComponentPropsWithRef } from 'react'

type HostTag = 'div' | 'span' | 'button' | 'pre'

type RawHtmlProps<T extends HostTag> = { tag?: T; html: string }
  & Omit<ComponentPropsWithRef<T>, 'children' | 'dangerouslySetInnerHTML'>

export function RawHtml<T extends HostTag = 'div'>({ tag, html, ...rest }: RawHtmlProps<T>) {
  const cached = useRef<{ __html: string } | null>(null)
  if (!cached.current || cached.current.__html !== html) cached.current = { __html: html }
  return createElement(tag || 'div', { ...(rest as Record<string, unknown>), dangerouslySetInnerHTML: cached.current })
}
