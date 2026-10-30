// Chat 域 React 岛入口（Batch 4 绞杀起点）：chat.js 的功能域逐块迁入此目录，
// 每迁一块由此挂载并删除 chat.js 对应实现。
import { mountActionDots } from './action-dots'
import { mountAuthModePill } from './auth-pill'
import { mountCommandMenu } from './command-menu/host'
import { mountStatusBar } from './status-bar'
import { mountWelcome } from './welcome'
import './transcript'

mountAuthModePill()
mountStatusBar()
mountWelcome()
mountActionDots()
mountCommandMenu()
