// 顶栏状态两件（stream store 的第一批真实消费者，迁自 js/chat.js）：
// - #collapse-stats：上下文折叠统计 pill（on-screen 会话最近一次
//   context_collapse_stats 的值，全局残留、切会话不清——逐字节保留旧语义）。
// - #status：引擎状态角标（error 时亮红字）。React 版顺带修正旧版
//   「事件时刻的 tt() 文案在语言切换后残留」的问题（useT 重渲）。
import { createRoot } from 'react-dom/client'
import { useT } from '../i18n'
import { useChatStream } from './stream-store'

function CollapseStatsPill() {
  const t = useT()
  const stats = useChatStream(state => state.lastOnScreenCollapse)
  if (!stats) return null
  return (
    <span id="collapse-stats" className="collapse-stats">
      {`${stats.collapsedSpans}${t('context_collapsed')}${stats.stagedSpans}${t('context_staged')}`}
    </span>
  )
}

function EngineStatusBadge() {
  const t = useT()
  const engineStatus = useChatStream(state => state.engineStatus)
  if (engineStatus === 'reconnecting') return <span id="status" className="init">{t('engine_reconnecting')}</span>
  if (engineStatus !== 'error') return <span id="status" />
  return <span id="status" className="error">{t('error')}</span>
}

export function mountStatusBar(): void {
  const collapseHost = document.getElementById('collapse-stats-host')
  if (collapseHost) createRoot(collapseHost).render(<CollapseStatsPill />)
  const statusHost = document.getElementById('status-host')
  if (statusHost) createRoot(statusHost).render(<EngineStatusBadge />)
}
