// 静态骨架图标挂载：把 HTML 里的 <span data-kls-icon="名字"> 槽位替换为
// KlausIcons 注册表字形。
//
// index.html/artifact.html 是静态骨架，不能 import 模块——骨架里只写槽位，
// 字形数据统一住 library.ts（@phosphor-icons/core）。入口模块（main.ts /
// artifact-main.ts）在启动序列早段 import 本模块即完成替换；此时 #app 仍是
// visibility:hidden（登录屏 display:none），不存在旧字形闪烁窗口。
//
// 槽位以 outerHTML 原位替换成 <svg>：DOM 里不留 wrapper，`按钮 svg` 一类
// 既有 CSS 选择器（尺寸/显隐切换）不需要任何改动。class/尺寸由 library
// 条目烤入。
import { icon } from './registry'

export function mountStaticIcons(root: ParentNode = document): void {
  for (const slot of Array.from(root.querySelectorAll('[data-kls-icon]'))) {
    const name = (slot as HTMLElement).dataset.klsIcon
    if (!name) continue
    slot.outerHTML = icon(name)
  }
}

mountStaticIcons()
