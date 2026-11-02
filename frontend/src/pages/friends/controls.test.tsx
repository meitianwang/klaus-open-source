import { beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18N } from '../../i18n/messages'

const installWindow = () => { (globalThis as any).window = { currentLang: 'zh', tt: (key: string) => I18N.zh[key] ?? key, addEventListener: () => {}, removeEventListener: () => {} } }
installWindow()
const { GrantSummary, MyQrDialog, relativeFriendTime, friendSharedRoot } = await import('./FriendsPage')
const { GrantEditor, ReceiveChoiceRow, receiveChoice } = await import('./GrantEditor')
const { FriendAvatar } = await import('./FriendsDialog')
beforeEach(installWindow)

describe('live authorization controls communicate the enforced boundary', () => {
  test('avatars use the first letter and the generic icon for missing or punctuation-only names', () => {
    expect(renderToStaticMarkup(<FriendAvatar name="Klaus" url={null} />)).toContain('<span>K</span>')
    expect(renderToStaticMarkup(<FriendAvatar name="(Alice)" url={null} />)).toContain('<span>A</span>')
    expect(renderToStaticMarkup(<FriendAvatar name={I18N.zh.friends_no_nickname} url={null} />)).toContain('<svg')
    expect(renderToStaticMarkup(<FriendAvatar name="!!!" url={null} />)).toContain('<svg')
    expect(renderToStaticMarkup(<FriendAvatar name="" url={null} />)).toContain('<svg')
  })
  test('one receive choice maps legacy rejection and does not render an extra checkbox', () => {
    expect(receiveChoice(true, 'reject')).toBe('off')
    expect(receiveChoice(false, 'auto')).toBe('off')
    expect(receiveChoice(true, 'approve')).toBe('approve')
    expect(receiveChoice(true, 'auto')).toBe('auto')
    const markup = renderToStaticMarkup(<ReceiveChoiceRow value="approve" onChange={() => {}} />)
    expect(markup).toContain('接收任务')
    expect(markup).not.toContain('type="checkbox"')
  })
  test('task rows expose relative time and safe per-friend roots', () => {
    expect(relativeFriendTime(0, 'zh-CN', 180000)).toBe('3分钟前')
    expect(friendSharedRoot('/tmp/friends/', 'friend-a')).toBe('/tmp/friends/friend-a')
    expect(friendSharedRoot('C:\\Users\\me\\friends', 'friend-a')).toBe('C:\\Users\\me\\friends\\friend-a')
    expect(friendSharedRoot('/tmp/friends', '../escape')).toBeNull()
  })
  test('the stored grant summary preserves per-directory access and Computer Use scope', () => {
    const markup = renderToStaticMarkup(<GrantSummary grant={{ deviceId: 'desktop-a', mode: 'manual', computerUse: false, apps: [], directories: [{ path: '/notes', access: 'read' }, { path: '/output', access: 'write' }], remember: true }} />)
    expect(markup).toContain('/notes')
    expect(markup).toContain('只读')
    expect(markup).toContain('/output')
    expect(markup).toContain('可编辑')
    expect(markup).toContain('未允许')
    expect(markup).not.toContain('执行方式')
  })
  test('the grant editor shows the product shared space as a fixed read-write row', () => {
    const markup = renderToStaticMarkup(<GrantEditor draft={{ deviceId: 'desktop-a', mode: 'manual', computerUse: false, apps: [], directories: [], remember: false }} apps={{ available: true, apps: [] }} disabled={false} sharedRoot="/tmp/klaus-friends" onPickDirectory={async () => null} onChange={() => {}} />)
    expect(markup).toContain('好友共享空间')
    expect(markup).toContain('/tmp/klaus-friends')
    expect(markup).toContain('可编辑')
  })
  test('the grant editor keeps the review usable while the installed-application list loads', () => {
    const draft = { deviceId: 'desktop-a', mode: 'manual' as const, computerUse: true, network: false, apps: [], directories: [], remember: false }
    const loading = renderToStaticMarkup(<GrantEditor draft={draft} apps={null} disabled={false} sharedRoot={null} onPickDirectory={async () => null} onChange={() => {}} />)
    expect(loading).toContain('正在加载这台电脑上的应用…')
    expect(loading).toContain(I18N.zh.friends_apps_loading)
    expect(loading).not.toContain(I18N.zh.friends_apps_unavailable)
    const loaded = renderToStaticMarkup(<GrantEditor draft={draft} apps={{ available: true, apps: [{ id: 'bundle:notes', name: 'Notes' }] }} disabled={false} sharedRoot={null} onPickDirectory={async () => null} onChange={() => {}} />)
    expect(loaded).not.toContain('正在加载这台电脑上的应用…')
    expect(loaded).toContain('Notes')
    // The dialog shell renders through a portal, so its immediate-open footer
    // state is pinned by the headless-Chrome harness instead of static markup.
  })
  test('the scan route wording exists in both languages', () => {
    expect(I18N.zh.friends_menu_scan).toBe('扫码添加')
    expect(I18N.en.friends_menu_scan).toBe('Scan to add')
    expect(I18N.zh.friends_scan_camera_denied).toContain('摄像头')
    expect(I18N.en.friends_scan_not_found).toContain('No Klaus friend code')
  })
  test('the my-QR menu and dialog wording exist in both languages', () => {
    // The dialog itself renders through a portal, so its DOM is pinned by the
    // headless-Chrome harness instead of static markup.
    expect(I18N.zh.friends_menu_my_qr).toBe('我的二维码')
    expect(I18N.en.friends_menu_my_qr).toBe('My QR code')
    expect(I18N.zh.friends_my_qr_save).toBe('保存我的二维码')
    expect(I18N.en.friends_my_qr_save).toBe('Save my QR code')
    expect(I18N.zh.friends_my_qr_share).toBe('分享我的二维码名片')
    expect(I18N.en.friends_my_qr_share).toBe('Share my QR card')
    expect(typeof MyQrDialog).toBe('function')
  })
  test('the friend remark wording exists in both languages', () => {
    expect(I18N.zh.friends_remark).toBe('备注')
    expect(I18N.en.friends_remark).toBe('Remark')
    expect(I18N.zh.friends_remark_hint).toContain('本电脑')
    expect(I18N.en.friends_remark_hint).toContain('this computer')
    expect(I18N.zh.friends_remark_placeholder).toBe('添加备注')
    expect(I18N.en.friends_remark_placeholder).toBe('Add a private note')
  })
  test('the in-conversation approval card wording exists in both languages', () => {
    expect(I18N.zh.friend_approval_title).toContain('在这个新会话中处理')
    expect(I18N.en.friend_approval_title).toContain('in this new conversation')
    expect(I18N.zh.friend_approval_allow).toBe('允许此会话')
    expect(I18N.en.friend_approval_allow).toBe('Allow this conversation')
    expect(I18N.zh.friend_approval_reject).toBe('拒绝')
    expect(I18N.en.friend_approval_scope).toBe('View permission scope')
    expect(I18N.zh.friend_approval_scope).toBe('查看授权范围')
    expect(I18N.zh.friend_approval_hint).toContain('批准一次')
    expect(I18N.en.friend_approval_hint).toContain('Approve once')
    expect(I18N.zh.friends_policy_approve).toBe('每个新会话询问一次')
    expect(I18N.en.friends_policy_approve).toBe('Ask once per conversation')
    expect(I18N.zh.friends_your_policy_approve).toContain('每个新会话')
    expect(I18N.en.friends_your_policy_approve).toContain('once per conversation')
    expect(I18N.zh.friends_receive_choice_hint).toContain('新会话首次')
    expect(I18N.en.friends_receive_choice_hint).toContain('new conversation asks once')
    for (const key of ['friend_approval_rejected', 'friend_approval_cancelled', 'friend_approval_ignored'] as const) {
      expect(I18N.zh[key].length).toBeGreaterThan(0)
      expect(I18N.en[key].length).toBeGreaterThan(0)
    }
  })
  test('revoke wording explains that saved authorization stops while conversations remain', () => {
    expect(I18N.zh.friends_revoke_confirm).toContain('停止')
  })
})
