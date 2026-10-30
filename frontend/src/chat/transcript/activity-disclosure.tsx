import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { RawHtml } from '../../components/RawHtml'
import { rawIconHtml } from '../../components/Icon'
import styles from './activity-disclosure.module.css'

function preserveAnchor(element: HTMLElement): void {
  let scroll = element.parentElement
  while (scroll && !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement
  if (!scroll) return
  const container = scroll
  const top = element.getBoundingClientRect().top
  const deadline = performance.now() + 250
  const follow = () => {
    if (!element.isConnected) return
    container.scrollTop += element.getBoundingClientRect().top - top
    if (performance.now() < deadline) requestAnimationFrame(follow)
  }
  requestAnimationFrame(follow)
}

export type ActivityDisclosureSection = { key: string; persistent: boolean; content: ReactNode }

export function ActivityDisclosure({ open, onToggle, label, children, sections, headerBefore, enabled = true, variant = 'activity' }: {
  open: boolean
  onToggle: () => void
  label: ReactNode
  children?: ReactNode
  sections?: ActivityDisclosureSection[]
  headerBefore?: string
  enabled?: boolean
  variant?: 'activity' | 'turn'
}) {
  const id = useId()
  const body = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(open)
  useLayoutEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame)
    }
    setVisible(false)
    const timer = setTimeout(() => setMounted(false), variant === 'turn' ? 150 : 300)
    return () => clearTimeout(timer)
  }, [open, variant])
  const [edges, setEdges] = useState({ top: false, bottom: false })
  useLayoutEffect(() => {
    const element = body.current
    if (!element || variant !== 'activity') return
    const update = () => setEdges({ top: element.scrollTop > 1, bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1 })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    element.addEventListener('scroll', update, { passive: true })
    update()
    return () => { observer.disconnect(); element.removeEventListener('scroll', update) }
  }, [mounted, visible, children, variant])
  const header = enabled ? <>
    <button className={styles.toggle} type="button" data-activity-toggle={variant} aria-expanded={open} aria-controls={id}
      onClick={event => { preserveAnchor(event.currentTarget); onToggle() }}>
      <span className={styles.label}>{label}</span>
      <RawHtml tag="span" className={styles.chevron} html={rawIconHtml('chevron-right')} />
    </button>
    {variant === 'turn' ? <div className={styles.divider} /> : null}
  </> : null
  return <div className={styles.disclosure} data-variant={variant} data-open={open} data-enabled={enabled}>
    {headerBefore === undefined ? header : null}
    {sections ? <div id={id} className={styles.sections}>
      {sections.map(section => <Fragment key={section.key}>
        {headerBefore === section.key ? <div className={styles.sectionHeader}>{header}</div> : null}
        {section.persistent
        ? <div key="content" className={styles.persistent}>{section.content}</div>
        : <div key="content" className={styles.motion} data-visible={visible} aria-hidden={!open} inert={!open}>
          <div className={styles.clip}><div className={styles.body}>{mounted ? section.content : null}</div></div>
        </div>}
      </Fragment>)}
    </div> : <div className={styles.motion} data-visible={visible} aria-hidden={!open} inert={!open}>
      <div className={styles.clip}>
        <div id={id} ref={body} className={styles.body} data-fade-top={edges.top} data-fade-bottom={edges.bottom}>
          {mounted ? children : null}
        </div>
      </div>
    </div>}
  </div>
}
