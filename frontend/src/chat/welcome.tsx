// 欢迎屏两件（迁自 index.html 静态骨架 + js/chat.js 的 greeting/chip 逻辑）：
// - WelcomeTitle：logo + 问候语（useT 语言重渲，替代旧的 data-i18n +
//   updateWelcomeGreeting 双路径更新）。
// - WelcomeChips：示例任务行；点击把同句话填进
//   composer 并触发 input（对齐 Web 端，不自动发送）。
// #welcome 容器与 #welcome-composer-slot 保持静态：display 切换点与
// composer dock（MutationObserver 驱动）都住 chat.js，随 composer 域迁移。
import styles from './chat.module.css'
import { createRoot } from 'react-dom/client'
import { useT } from '../i18n'
import { Icon } from '../components/Icon'

const w = () => window as any

const CHIP_PROMPT_KEYS = [
  'welcome_suggestion_files',
  'welcome_suggestion_code',
  'welcome_suggestion_report',
]

function WelcomeTitle() {
  const t = useT()
  return (
    <>
      <img src="logo.png" alt="" className={`${styles['welcome-logo']}`} aria-hidden="true" />
      <h1 className={`${styles['welcome-greeting']}`} id="welcome-greeting">{t('welcome_title')}</h1>
    </>
  )
}

function WelcomeChips() {
  const t = useT()
  const fillComposer = (promptKey: string) => {
    const prompt = t(promptKey)
    w().setComposerText?.(prompt)
    const inputEl = document.getElementById('input') as HTMLTextAreaElement | null
    inputEl?.dispatchEvent(new Event('input'))
    inputEl?.focus()
  }
  return (
    <>
      {CHIP_PROMPT_KEYS.map(key => (
        <button type="button" className="welcome-chip" data-chip key={key} onClick={() => fillComposer(key)}>
          <Icon name="welcome-chip" />
          <span className={`${styles['welcome-chip-title']}`}>{t(key)}</span>
        </button>
      ))}
    </>
  )
}

export function mountWelcome(): void {
  const titleHost = document.querySelector('#welcome .welcome-title')
  if (titleHost) createRoot(titleHost).render(<WelcomeTitle />)
  const chipsHost = document.querySelector('#welcome .welcome-chips')
  if (chipsHost) createRoot(chipsHost).render(<WelcomeChips />)
}
