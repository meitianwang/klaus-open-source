// 文件类型字形：按扩展名挑一个图标，纯映射。
//
// 单独成一个叶子模块，因为它的消费者遍布转录、概览产物区和 composer 胶囊，而它
// 原来住在 workspace-panel 里——那个模块在装载时就 getElementById 一批节点，于是
// 「想要一个文件图标」变成了「必须先有 DOM」，任何不带 DOM 的调用方一 import 就抛。
import { icon as klausIcon } from '../icons/registry'

import { fileIconName } from './file-icon-name'

export function fileIconSvg(name: string): string { return klausIcon(fileIconName(name)) }
