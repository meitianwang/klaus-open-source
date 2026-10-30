// Diff 页岛入口：不走 page-view registry——show 带 options（面板联动）、
// hide/deactivate 语义分离（会话切换只摘 active 不动面板），window 协议
// 由 store.installDiffViewProtocol 手工导出（chat.js 消费面签名不动）。
import { createRoot } from 'react-dom/client'
import { DiffPage } from './DiffPage'
import { installDiffViewProtocol } from './store'

const host = document.getElementById('diff-view-content')
if (host) {
  createRoot(host).render(<DiffPage />)
  installDiffViewProtocol()
}
