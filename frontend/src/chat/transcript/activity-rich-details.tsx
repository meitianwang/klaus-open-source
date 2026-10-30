import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { humanizeSchedule } from '../../pages/cron/data'
import { openSiteReference } from '../site-references'
import type { ActivityToolData, ActivityToolPresentation } from './activity-tool-model'
import { webActivitySources } from './activity-semantic'
import { activityScheduleCron, activityScheduleIsEmpty, activitySchedules, openActivityScheduleManagement } from './activity-schedule'
import styles from './activity-rich-details.module.css'

export function ImageActivityDetails({ tool, presentation, locale }: { tool: ActivityToolData; presentation: ActivityToolPresentation; locale: string }) {
  const sessionId = tool.sessionId ?? ''
  const images = (presentation.imagePaths ?? []).map(path => ({ path, name: path.split(/[/\\]/).at(-1) || path,
    src: (window as any).klaus?.media?.url?.(path, sessionId) || '' })).filter(image => image.src)
  if (!images.length) return <p className={styles.notice}>{locale.startsWith('zh') ? '没有可用的图片预览。可在详情中查看原始结果。' : 'No image preview is available. Inspect the original result in details.'}</p>
  return <div className={styles.images} data-viewed-images>
    {images.map(image => <button type="button" key={image.path} className={styles.image} data-media-thumb="1"
      data-media-path={image.path} data-media-session={sessionId}
      aria-label={`${locale.startsWith('zh') ? '查看图片' : 'View image'} · ${image.name}`}>
      <img src={image.src} alt={image.name} loading="lazy" />
    </button>)}
  </div>
}

export function WebActivitySources({ tool, locale }: { tool: ActivityToolData; locale: string }) {
  const sources = webActivitySources(tool.output)
  if (!sources.length) return null
  return <div className={styles.sources} data-web-sources>
    <div className={styles.caption}>{locale.startsWith('zh') ? '来源' : 'Sources'}</div>
    {sources.map(source => <button type="button" key={source.url} className={styles.source} data-source-url={source.url}
      onClick={() => { void openSiteReference(tool.sessionId ?? '', source.url) }}>
      <Icon name="tool-web" size={16} />
      <span><span className={styles.sourceTitle}>{source.title}</span><span className={styles.caption}>{new URL(source.url).hostname}</span></span>
      <Icon name="chevron-right" size={14} />
    </button>)}
  </div>
}

export function ScheduleActivityDetails({ tool, locale }: { tool: ActivityToolData; locale: string }) {
  const [unavailable, setUnavailable] = useState(false)
  const zh = locale.startsWith('zh')
  const schedules = tool.state === 'done' ? activitySchedules(tool.toolName, tool.args, tool.output) : []
  if (tool.state !== 'done') return null
  return <div className={styles.schedules} data-schedule-result>
    {schedules.map((schedule, index) => <div className={styles.schedule} key={schedule.id || index}>
      <Icon name="tool-clock" size={18} />
      <div className={styles.scheduleInfo}>
        <div className={styles.scheduleName}>{schedule.name || schedule.id || (zh ? '定时任务' : 'Scheduled task')}</div>
        {(schedule.cron || schedule.humanSchedule) ? <div className={styles.caption}>{humanizeSchedule(schedule.cron || activityScheduleCron(schedule.humanSchedule)) || schedule.humanSchedule}</div> : null}
        <div className={styles.caption}>
          {schedule.recurring !== undefined ? <span>{schedule.recurring ? zh ? '重复执行' : 'Repeats' : zh ? '仅执行一次' : 'One time'}</span> : null}
          {schedule.durable !== undefined ? <span>{schedule.durable ? zh ? '已保存' : 'Saved' : zh ? '仅当前会话' : 'This session only'}</span> : null}
        </div>
      </div>
    </div>)}
    {!schedules.length && activityScheduleIsEmpty(tool.output) ? <div className={styles.caption}>{zh ? '暂无定时任务' : 'No scheduled tasks'}</div> : null}
    <button type="button" className={styles.manage} onClick={() => setUnavailable(!openActivityScheduleManagement())}>
      {zh ? '管理定时任务' : 'Manage scheduled tasks'}<Icon name="chevron-right" size={14} />
    </button>
    {unavailable ? <p className={styles.notice} role="status">{zh ? '当前视图无法打开定时任务管理。' : 'Task management is unavailable in this view.'}</p> : null}
  </div>
}
