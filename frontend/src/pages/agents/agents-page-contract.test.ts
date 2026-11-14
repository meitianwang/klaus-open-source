import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/**
 * 子智能体广场的页面契约。
 *
 * 这里钉的是三类静默失败：CSS Modules 的类名按文件哈希，引用一个样式表里没有的
 * 键会得到 undefined 并渲染成无样式（单测里 module 导入是字符串，测不出来）；
 * 市场档卡片必须复用共享组件而不是各自起骨架；以及广场只开「浏览 + 安装」两个
 * 通道，删除仍走既有的智能体文件路径，不长出第二种回收站行为。
 */
describe('agents page plaza contract', () => {
  const page = source('./AgentsPage.tsx')
  const styles = source('./agents.module.css')
  const cssModule = source('./agents.module.css')
  const marketComponent = source('../../components/Market.tsx')
  const bridge = source('../../../bridge/klaus-api.ts')
  const service = source('../../../../main/agents-market/service.ts')
  const handlers = source('../../../../main/ipc/handlers/agents-market.ts')

  test('every CSS Module key the page references actually exists in its stylesheet', () => {
    const referenced = [...page.matchAll(/styles\['([^']+)'\]/g)].map(match => match[1])
    expect(referenced.length).toBeGreaterThan(0)
    const defined = new Set([...cssModule.matchAll(/^\.([A-Za-z0-9_-]+)\s*[{,:]/gm)].map(match => match[1]))
    const missing = [...new Set(referenced)].filter(name => !defined.has(name))
    // 一个缺失的键不会报错，只会让那张卡片悄悄变成无样式，所以按名字全量核对。
    expect(missing).toEqual([])
    expect(styles).toContain('.sk-load-warning')
    expect(styles).toContain('.sk-row-cmd')
  })

  test('the plaza renders through the shared market component, not a bespoke card skeleton', () => {
    expect(page).toContain("import { MarketCard, MarketGrid } from '../../components/Market'")
    expect(page).toContain('<MarketGrid empty={visibleMarket.length === 0}')
    expect(page).toContain('<MarketCard')
    expect(marketComponent).toContain('export function MarketCard')
    expect(marketComponent).toContain('export function MarketGrid')
  })

  test('the plaza is a second view of the same page and both views stay reachable', () => {
    expect(page).toContain("useState<'market' | 'installed'>('market')")
    expect(page).toContain('data-agent-view-tab')
    expect(page).toContain("t('agents_tab_market')")
    expect(page).toContain("t('agents_tab_installed')")
    // 已安装档的分类 tabs 不能因为广场的存在而消失。
    expect(page).toContain("view === 'installed' ? `<div class=\"sk-category-tabs\"")
  })

  test('the plaza opens market, install and cancel channels while leaving removal to the agent file path', () => {
    expect(handlers).toContain("['agents:market', 'agents:install', 'agents:cancel']")
    expect(bridge).toContain("call('agents:market', opts)")
    expect(bridge).toContain("call('agents:install', { slug, version })")
    expect(bridge).toContain("call('agents:cancel', { slug })")
    expect(page).toContain('w().klaus.agents.market()')
    expect(page).toContain('w().klaus.agents.install(item.slug')
    expect(page).toContain('ExtensionTransferBanner')
    expect(page).toContain('agentAcquisitionStore')
    // 广场不新增删除通道：装完就是普通用户智能体文件。
    expect(page).not.toContain('agents:uninstall')
    expect(handlers).not.toContain('uninstall')
  })

  test('install goes through the existing agent writer instead of a second write path', () => {
    expect(service).toContain('saveAgent')
    expect(service).toContain('frontmatter(content)')
    const runtime = source('../../../../main/app/runtime.ts')
    expect(runtime).toContain('saveAgent: payload => extensions.agentsSave(payload)')
  })

  test('a market fetch failure stays visible instead of rendering an empty plaza as truth', () => {
    expect(page).toContain('marketError')
    expect(page).toContain("className={styles['sk-load-warning']}")
    expect(page).toContain("t('auth_status_retry')")
    expect(service).toContain('isRemote: false, error: errorMessage(error)')
  })

  test('an installed agent is only offered as an update when a newer version is published', () => {
    expect(service).toContain('hasUpdate: installed.includes(slug)')
    expect(page).toContain('item.hasUpdate ? t(\'agents_market_update\') : t(\'agents_market_install\')')
    expect(page).toContain("item.installed && !item.hasUpdate")
  })

  test('an installed plaza card is manageable instead of a dead badge', () => {
    // 已安装态必须给得起管理动作：卡体点击就是打开对话框的入口，控件保留更新
    // 与卸载；编辑钮不再单独存在，整卡即编辑入口，已安装档同构。
    expect(page).toContain('onOpen={item.installed ? () => { void openEdit(item.slug) } : undefined}')
    expect(page).not.toContain("t('agents_edit')")
    expect(page).toContain('onDelete={id => { void onDelete(id) }}')
    expect(page).toContain("t('agents_market_uninstall')")
    // 卸载仍走已安装档的同一条路径：回收站删除，不新增通道。
    expect(page).toContain('w().klaus.agents.definitions.delete(editableId)')
    expect(page).toContain('w().klaus.agents.definitions.read(editableId)')
    // 删掉之后广场卡片要回到「安装」态，不能两边状态各说各话。
    expect(page).toContain('void loadMarket()')
    // 内置等没有用户文件的角色从列表行以只读态打开同一个对话框，只看不改。
    expect(page).toContain('readOnly: true')
    expect(page).toContain('void openAgent(agent)')
  })
})
