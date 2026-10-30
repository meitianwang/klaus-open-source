// The composer activity row opens task progress and the active turn’s recorded changes.
import { useMemo, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import styles from './action-dots.module.css'
import { useT } from '../i18n'
import { rawIconHtml } from '../components/Icon'
import { RawHtml } from '../components/RawHtml'
import { progressRingSvg } from '../icons/dynamic'
import { useChatStream } from './stream-store'
import { artifactTurn, artifactsVersion, revealPlan, subscribeArtifacts } from './overview'
import type { ArtifactTurn } from './overview'
import { ChangesCapsule, visibleTurnChanges } from '../pages/diff/changes-summary'
import { subscribeTaskItems, taskItems, taskItemsVersion, taskProgress } from './task-state'
import type { TaskProgress } from './task-state'
import { TASK_MARK_ICON } from './task-status'

/** 当前回合那一组改动（与概览「产物」区同源）。 */
function useChangeTurn(sessionId: string | null, turnId: string | null): ArtifactTurn | null {
  const version = useSyncExternalStore(subscribeArtifacts, artifactsVersion)
  // version 是产物 store 的变更计数，重算就靠它。
  return useMemo(() => visibleTurnChanges(artifactTurn(sessionId, turnId)), [version, sessionId, turnId])
}

function ProgressSegment({ progress }: { progress: TaskProgress }) {
  const t = useT()
  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
  return (
    <span className={styles['action-dots-slot']}>
      <button
        type="button"
        className={styles['action-dots-seg']}
        title={t('action_dots_progress_title')}
        onClick={revealPlan}
      >
        <RawHtml tag="span" className="kls-icon-host" html={progressRingSvg(pct)} />
        <span className={styles['action-dots-label']}>{t('action_dots_progress')}</span>
        <span className={styles['action-dots-value']}>{`${progress.completed}/${progress.total}`}</span>
      </button>
      <span className={styles['action-dots-hover']} role="tooltip">
        {progress.entries.map((entry, index) => {
          const status = entry.status.replace('_', '-')
          return (
            <span className={`${styles['action-dots-hover-row']} ${styles[`state-${status}`]}`} key={index}>
              <RawHtml
                tag="span"
                className={styles['action-dots-hover-mark']}
                html={rawIconHtml(TASK_MARK_ICON[entry.status])}
              />
              <span className={styles['action-dots-hover-text']}>{String(entry?.step || '')}</span>
            </span>
          )
        })}
      </span>
    </span>
  )
}

function ActionDots() {
  // 会话对象整体订阅（引用稳定，patchSession 才换），进度在 memo 里派生——
  // 选择器直接返回派生对象会每帧换引用，useSyncExternalStore 会当成一直在变。
  const sessionId = useChatStream(state => state.currentSessionId)
  const session = useChatStream(state => (state.currentSessionId ? state.sessions[state.currentSessionId] : null) ?? null)
  const running = !!session?.running
  const taskVersion = useSyncExternalStore(subscribeTaskItems, taskItemsVersion)
  const progress = useMemo(() => {
    if (!running) return null
    return taskProgress(taskItems(sessionId))
  }, [running, sessionId, taskVersion])
  // 只认当前回合那一组：回合结束 activeTurnId 归零，审查段随之退场，而下一回合
  // 在真正写文件之前不会挂着上一回合的数字。
  const turn = useChangeTurn(sessionId, running ? session?.activeTurnId ?? null : null)
  // 只看有没有文件：二进制写入和拿不到基线的编辑报不出行数，再叠一道行数门槛就会
  // 把这些真发生过的修改藏掉入口。此时行数显示 –，与点开后一致。
  const hasReview = !!turn && turn.files.length > 0
  const visible = running && (!!progress || hasReview)

  if (!visible) return null
  return (
    <div className={styles['action-dots']} data-review-only={hasReview && !progress ? 'true' : undefined}>
      {progress ? <ProgressSegment progress={progress} /> : null}
      {progress && hasReview ? <span className={styles['action-dots-sep']} aria-hidden="true" /> : null}
      {hasReview && turn ? <ChangesCapsule sessionId={sessionId!} turn={turn} embedded={!!progress} /> : null}
    </div>
  )
}

export function mountActionDots(): void {
  const host = document.getElementById('action-dots-host')
  if (host) createRoot(host).render(<ActionDots />)
}
