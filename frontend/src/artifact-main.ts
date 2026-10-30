// Artifact 预览窗（artifact.html）的唯一 JS 入口。
//
// 迁移自 artifact.html 的 6 个保序 <script>，顺序照搬旧 build 产物：
// bridge 最先（旧 build 把 api-shim 注入为首个 script），vendor 垫片紧随，
// artifact.js 收尾。katex 不进这个窗口（与旧 script 清单一致）。
import '../bridge/artifact-api'
import { installTabFocusPolicy } from './app/tab-focus-policy'
import './vendor-globals-markdown'
import './icons/static-mount'
import './app/code-token-themes'
import './app/i18n'
import './app/artifact-markdown'
import './app/artifact-window'

installTabFocusPolicy()
