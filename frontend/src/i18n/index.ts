// i18n 运行时（Batch 3）：语言状态 + t()。
//
// 迁移期双轨：src/app/i18n.ts 仍是语言切换的执行者（写 window.currentLang、扫
// data-i18n、广播 klaus:lang-change）；本模块监听同一事件驱动 React 侧重渲染。
// 字典单一来源在 ./messages。
import { useSyncExternalStore } from 'react'
import { I18N } from './messages'

export type Lang = 'en' | 'zh'

function currentLang(): Lang {
  const lang = (window as any).currentLang
  return lang === 'zh' ? 'zh' : 'en'
}

export function t(key: string): string {
  const lang = currentLang()
  return I18N[lang]?.[key] ?? I18N.en?.[key] ?? key
}

/** BCP 47 tag for Intl formatters (durations, numbers) that must follow the UI language. */
export function intlLocale(): string {
  return currentLang() === 'zh' ? 'zh-CN' : 'en'
}

const listeners = new Set<() => void>()
let version = 0
if (typeof window !== 'undefined') {
  window.addEventListener('klaus:lang-change', () => {
    version++
    for (const fn of listeners) fn()
  })
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** React 侧取 t()；语言切换时订阅组件自动重渲染。 */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, () => version, () => version)
  return t
}

/** Return the current UI language and subscribe to language changes. */
export function useLang(): Lang {
  useSyncExternalStore(subscribe, () => version, () => version)
  return currentLang()
}

export { I18N }
