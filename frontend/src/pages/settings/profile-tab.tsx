// Shared profile presentation synchronization for the sidebar and transcript.
import { t as tGlobal } from '../../i18n'

const w = () => window as any

// 把 dataURL 头像应用到所有头像 DOM（设置页 + 侧栏），无图时用首字母占位
export function applyAvatar(dataUrl: string | undefined, displayName: string | undefined): void {
  const initial = (displayName || 'U').charAt(0).toUpperCase()
  // The transcript's sender columns read the stored profile identity through
  // this published value: string-HTML builders cannot subscribe to the kv
  // store. The owner column and the agent column share it — the profile avatar
  // is the owner's own face, and the agent's official face is set through the
  // same profile upload.
  ;(window as any).__klausProfileAvatar = { url: dataUrl || '', name: displayName || '' }
  document.querySelectorAll('.sidebar-avatar').forEach(el => {
    const node = el as HTMLElement
    if (dataUrl) {
      node.style.backgroundImage = `url("${dataUrl}")`
      node.style.backgroundSize = 'cover'
      node.style.backgroundPosition = 'center'
      node.style.color = 'transparent'
      // 保留子元素（hidden file input），只清掉文字节点
      Array.from(node.childNodes).forEach(n => { if (n.nodeType === 3) n.remove() })
    } else {
      node.style.backgroundImage = ''
      node.style.color = ''
      Array.from(node.childNodes).forEach(n => { if (n.nodeType === 3) n.remove() })
      node.insertBefore(document.createTextNode(initial), node.firstChild)
    }
  })
}

// 启动时把保存过的 display_name / avatar 应用到侧栏
export async function bootstrapProfile(): Promise<void> {
  try {
    const name = (await w().settingsApi.kv.get('display_name')) || tGlobal('user_default_name')
    const dataUrl = await w().settingsApi.kv.get('avatar_data_url')
    // 侧栏名字（侧栏用户行只展示姓名，邮箱仅在设置-资料页可见）
    const sidebarName = document.querySelector('.sidebar-username')
    if (sidebarName) sidebarName.textContent = name
    // 侧栏头像（有图片就用图，没有就用首字母）
    applyAvatar(dataUrl, name)
  } catch {}
}

// 姓名是动态内容(不带 data-i18n,applyI18n 不再冲掉真实值);切语言后重跑一次,
// 让没存过资料的用户拿到新语言的默认文案,存过的重填同值等于无操作
window.addEventListener('klaus:lang-change', () => { void bootstrapProfile() })
