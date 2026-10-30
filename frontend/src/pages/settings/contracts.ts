// 渲染器产品契约（迁自 js/settings.js）：任务快照仲裁、归档会话生命周期控制。
// 消费方：chat.ts 与 src/pages/settings/archived-tab.tsx（均经
// window.KlausRendererProductContracts）。|| 守卫保留：注入顺序无关（先到者定义）。
//
// The engine-queue mutation helpers that used to live here (canMutateRustQueueItem,
// queueDropDecision, the mutation ledger) are gone: the follow-up queue is now the
// host's alone, so there is exactly one source and no cross-source rules to encode.
// Engine queue concurrency is the host's problem, in main/sessions/client-queue.ts.

const rendererProductContracts = (window as any).KlausRendererProductContracts || ((() => {

  const taskSnapshotSource = (value: any) => {
    const generation = typeof value?.generation === 'string' ? value.generation : ''
    const taskListId = typeof value?.taskListId === 'string' ? value.taskListId : ''
    return generation && taskListId ? `${generation}\u0000${taskListId}` : ''
  }

  const taskSnapshotDecision = (current: any, incoming: any) => {
    const nextSource = taskSnapshotSource(incoming)
    const currentSource = taskSnapshotSource(current)
    if (!nextSource) {
      return currentSource
        ? { accept: false, reason: 'missing-authority' }
        : { accept: true }
    }
    if (!currentSource) return { accept: true }
    if (currentSource !== nextSource) return { accept: true }
    const currentRevision = Number(current?.revision)
    const incomingRevision = Number(incoming?.revision)
    if (!Number.isFinite(incomingRevision)) return { accept: false, reason: 'invalid-revision' }
    if (Number.isFinite(currentRevision) && incomingRevision < currentRevision) {
      return { accept: false, reason: 'stale-revision' }
    }
    if (
      Number.isFinite(currentRevision)
      && incomingRevision === currentRevision
      && current?.fingerprint
      && incoming?.fingerprint
      && current.fingerprint !== incoming.fingerprint
    ) {
      return { accept: false, reason: 'revision-conflict' }
    }
    if (
      Number.isFinite(currentRevision)
      && incomingRevision === currentRevision
      && Number(incoming?.loaded) < Number(current?.loaded)
    ) {
      return { accept: false, reason: 'less-complete' }
    }
    return { accept: true }
  }

  const createArchivedLifecycleController = () => {
    const pending = new Map()
    const isPending = (sessionId: any) => pending.has(sessionId)
    const run = async (sessionId: any, operation: any, invoke: any) => {
      const current = pending.get(sessionId)
      if (current) return { ok: false, code: 'lifecycle_operation_in_progress', operation: current }
      pending.set(sessionId, operation)
      try {
        return await invoke()
      } finally {
        pending.delete(sessionId)
      }
    }
    return { isPending, run }
  }

  const runArchivedDeleteAll = async (
    controller: any,
    sessions: any,
    invokeDelete: any,
    onStateChange = () => {},
  ) => {
    const results = []
    for (const session of sessions) {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (!sessionId) continue
      const operation = controller.run(sessionId, 'delete', () => invokeDelete(sessionId))
      onStateChange()
      const result = await operation
      onStateChange()
      results.push({ sessionId, result })
    }
    return results
  }

  const shouldRefreshAfterUnarchive = (result: any) => result?.ok === true || result?.code === 'session_deleted'

  return {
    taskSnapshotSource,
    taskSnapshotDecision,
    createArchivedLifecycleController,
    runArchivedDeleteAll,
    shouldRefreshAfterUnarchive,
  }
})())
;(window as any).KlausRendererProductContracts = rendererProductContracts
