// Follow-up 队列的纯逻辑 helpers（迁自 js/follow-up.js，UMD 壳换 ES module）。
// chat.js 经 window.KlausFollowUp 消费；follow-up.test.ts 直接 import。
export interface FollowUpItem {
  id: string
  [key: string]: unknown
}

export const FOLLOW_UP_QUEUE_MODE_KEY = 'follow_up_queue_mode'
// followUpQueueMode 未设置时取 `queue`，所以桌面端默认也是 queue：运行中追发
// 先排队，等本轮结束再跑成新 turn。
export const DEFAULT_FOLLOW_UP_QUEUE_MODE = 'queue'
export const FOLLOW_UP_QUEUE_MODES = Object.freeze(['queue', 'steer'])

export function normalizeMode(value: unknown): 'queue' | 'steer' {
  // The check must name the non-default branch: testing for `queue` would
  // swallow an explicit steer preference once queue became the default.
  return value === 'steer' ? 'steer' : DEFAULT_FOLLOW_UP_QUEUE_MODE
}

export function invertMode(mode: unknown): 'queue' | 'steer' {
  return normalizeMode(mode) === 'queue' ? 'steer' : 'queue'
}

export function resolveSubmitAction(mode: unknown, invert: boolean): 'queue' | 'steer' {
  const normalized = normalizeMode(mode)
  return invert ? invertMode(normalized) : normalized
}

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `follow-up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function addItem<T>(items: T[] | null | undefined, item: T): T[] {
  return [...(Array.isArray(items) ? items : []), item]
}

export function removeItem<T extends FollowUpItem>(items: T[] | null | undefined, id: string): T[] {
  return (Array.isArray(items) ? items : []).filter(item => item && item.id !== id)
}

export function updateItem<T extends FollowUpItem>(items: T[] | null | undefined, id: string, patch: Partial<T>): T[] {
  return (Array.isArray(items) ? items : []).map(item =>
    item && item.id === id ? { ...item, ...patch } : item,
  )
}

export function reorderItem<T extends FollowUpItem>(items: T[] | null | undefined, id: string, overId: string): T[] {
  const next = [...(Array.isArray(items) ? items : [])]
  if (!id || !overId || id === overId) return next
  const from = next.findIndex(item => item && item.id === id)
  const to = next.findIndex(item => item && item.id === overId)
  if (from < 0 || to < 0) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

const api = Object.freeze({
  FOLLOW_UP_QUEUE_MODE_KEY,
  DEFAULT_FOLLOW_UP_QUEUE_MODE,
  FOLLOW_UP_QUEUE_MODES,
  normalizeMode,
  invertMode,
  resolveSubmitAction,
  createId,
  addItem,
  removeItem,
  updateItem,
  reorderItem,
})

if (typeof window !== 'undefined') (window as any).KlausFollowUp = api
