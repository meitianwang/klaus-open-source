// 图标 React 组件：与模板字符串同一份字形数据（src/icons registry）。
//
// 包裹元素用 display:contents（styles.css 的 .kls-icon-host 规则）——不产生
// 布局盒，svg 在 flex/grid 里表现与直插一致。需要 `父 > svg` 选择器精确匹配
// 的场合，改用 rawIconHtml 直接注入宿主元素。
import { icon, type IconOptions } from '../icons/registry'
import { RawHtml } from './RawHtml'

export function Icon({ name, size, cls }: { name: string } & IconOptions) {
  return <RawHtml tag="span" className="kls-icon-host" html={icon(name, { size, cls })} />
}

/** 需要把 svg 作为宿主元素直接子节点时用（配 RawHtml 的 html 或手写注入）。 */
export const rawIconHtml = icon
