import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ActivityToolData } from './activity-tool-model'
import { parseWidgetSnapshot, validateWidgetMessage } from './activity-widget-model'
import styles from './activity-tool.module.css'

interface WidgetApi {
  artifacts?: { widgetUrl?: (sessionId: string, widgetId: string, revision: number, path: string) => Promise<{ ok?: boolean; url?: string; currentRevision?: number; error?: string }> }
}
interface WidgetHandler { (request: { sessionId: string; toolCallId: string; widgetId: string; revision: number; path: string; title: string; text: string; submit: boolean }): Promise<boolean> }
const api = () => (window as unknown as { klaus?: WidgetApi }).klaus
const currentSession = () => (window as unknown as { currentSessionId?: string }).currentSessionId
const handler = () => (window as unknown as { klausHandleWidgetInteraction?: WidgetHandler }).klausHandleWidgetInteraction

function toolTitle(args: unknown): string {
  let value = args
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return '' } }
  return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { title?: unknown }).title === 'string'
    ? String((value as { title: string }).title).slice(0, 128) : ''
}

export function WidgetTool({ tool, fallback, locale }: { tool: ActivityToolData; fallback: ReactNode; locale: string }) {
  const sessionId = tool.sessionId || ''
  const toolCallId = tool.toolCallId
  const snapshot = tool.state === 'done' ? parseWidgetSnapshot(tool.output, sessionId, toolCallId) : null
  const container = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const inFlight = useRef(false)
  const acceptedMessages = useRef(0)
  const [url, setUrl] = useState('')
  const [currentRevision, setCurrentRevision] = useState(0)
  const [error, setError] = useState('')
  const [interaction, setInteraction] = useState('')
  const zh = locale.startsWith('zh')

  useEffect(() => {
    let active = true
    acceptedMessages.current = 0
    setUrl('')
    setCurrentRevision(0)
    setError('')
    if (snapshot) {
      const request = api()?.artifacts?.widgetUrl?.(sessionId, snapshot.widgetId, snapshot.revision, snapshot.path)
      if (!request) setError(zh ? 'Widget 服务不可用' : 'Widget service is unavailable')
      else void request.then(result => {
          if (!active || !container.current?.isConnected || currentSession() !== sessionId) return
          if (result.ok && result.url?.startsWith('klaus-media://widget/') && Number.isSafeInteger(result.currentRevision)) {
            setCurrentRevision(result.currentRevision!)
            setUrl(result.url)
          }
          else setError(result.error || (zh ? 'Widget 无法加载' : 'Widget could not be loaded'))
        })
        .catch(cause => { if (active && container.current?.isConnected && currentSession() === sessionId) setError(cause instanceof Error ? cause.message : String(cause)) })
    }
    return () => { active = false }
  }, [sessionId, snapshot?.path, snapshot?.widgetId, snapshot?.revision, snapshot?.nonce, zh])

  useEffect(() => {
    if (!snapshot || !url) return
    const receive = (event: MessageEvent) => {
      if (currentSession() !== sessionId || currentRevision !== snapshot.revision || inFlight.current) return
      if (acceptedMessages.current >= 32) {
        setError(zh ? 'Widget 交互次数已达上限' : 'Widget interaction limit reached')
        return
      }
      const request = validateWidgetMessage(event, frame.current?.contentWindow ?? null, snapshot)
      const deliver = handler()
      if (!request || !deliver) return
      acceptedMessages.current++
      inFlight.current = true
      void deliver({ sessionId, toolCallId, widgetId: snapshot.widgetId, revision: snapshot.revision, path: snapshot.path,
        title: snapshot.title, text: request.text, submit: request.submit })
        .then(accepted => setInteraction(accepted ? request.submit ? (zh ? '已提交到聊天' : 'Sent to chat') : (zh ? '已加入草稿' : 'Added to draft')
          : (zh ? '未发送；请检查草稿' : 'Not sent; check the draft')))
        .catch(() => setInteraction(zh ? '未发送' : 'Not sent'))
        .finally(() => { inFlight.current = false })
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [sessionId, toolCallId, snapshot?.path, snapshot?.nonce, currentRevision, url, zh])

  if (tool.state === 'error' || tool.state === 'interrupted' || tool.state === 'awaiting-approval') return <>{fallback}</>
  const title = snapshot?.title || toolTitle(tool.args) || (zh ? '交互式 Widget' : 'Interactive widget')
  return <div ref={container} className={styles.widgetCard} data-widget-state={tool.state === 'running' ? 'pending' : !snapshot || error ? 'error' : url ? 'ready' : 'loading'} data-tool-call-id={toolCallId}>
    <div className={styles.widgetHeading}><span>{title}</span><span>{zh ? '交互式 Widget' : 'Interactive widget'}</span></div>
    {tool.state === 'running' ? <p>{zh ? '正在生成 Widget' : 'Generating widget'}</p>
      : !snapshot ? <p role="alert">{zh ? 'Widget 结果不可用' : 'Widget result is unavailable'}</p>
        : <>{error ? <p role="alert">{error}</p> : null}
          {url ? <iframe ref={frame} src={url} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" title={`${zh ? 'Widget' : 'Widget'}: ${title}`} /> : null}
          {url && currentRevision !== snapshot.revision ? <p>{zh ? '这是旧修订，交互已停用' : 'This older revision is read-only'}</p> : null}
          {interaction ? <p role="status">{interaction}</p> : null}</>}
    <details><summary>{zh ? '工具详情' : 'Tool details'}</summary><pre>{tool.output?.slice(0, 8192) || ''}</pre></details>
  </div>
}
