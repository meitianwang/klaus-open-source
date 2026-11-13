import { expect, test } from 'bun:test'
import { createSidePaneComposerFixture } from './test-support/side-pane-composer-fixture'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('side admission publishes its identity and snapshot before model preparation, independently of the next draft', async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('pending-owner', 'right')
    const ready = deferred<boolean>()
    f.context.ensureComposerModelConfigured = () => ready.promise
    f.setText('right', 'Submitted question')
    f.window.klausSideComposerAddSelection('Quoted context', 'right')
    const submitted = f.controls.get(f.input('right')).snapshotDocument()
    f.button('right').click()
    expect(f.calls.submissions).toEqual([])
    expect(f.calls.admissions).toHaveLength(1)
    const pending = [...f.pendingSubmissions.values()][0]
    expect(pending.phase).toBe('preparing')
    expect(pending.uuid).toBe(pending.payload.clientMessageId)
    expect(f.calls.admissions[0].payload.uuid).toBe(pending.uuid)
    expect(pending.payload.composerDocument).toEqual(submitted)
    expect(pending.files.some((file: any) => file.text === 'Quoted context')).toBe(true)
    expect(f.input('right').value).toBe('')
    expect(f.button('right').getAttribute('aria-label')).toBe('submit_tooltip_stop')
    expect(f.button('right').classList.contains('busy')).toBe(true)
    f.setText('right', 'Independent next draft')
    ready.resolve(true)
    await f.settle()
    expect(f.calls.submissions).toHaveLength(1)
    expect(f.calls.submissions[0].payload.clientMessageId).toBe(pending.uuid)
    expect(f.calls.submissions[0].payload.composerDocument).toEqual(submitted)
    expect(f.input('right').value).toBe('Independent next draft')
    expect(pending.phase).toBe('accepted')
  } finally { await f.destroy() }
})

test('Stop cancels the exact preparation and releases admission immediately without late draft or send effects', async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('cancel-owner', 'right')
    const first = deferred<boolean>(), second = deferred<boolean>()
    let reads = 0
    f.context.ensureComposerModelConfigured = () => ++reads === 1 ? first.promise : second.promise
    f.setText('right', 'Cancelled snapshot')
    f.button('right').click()
    const cancelled = [...f.pendingSubmissions.values()][0]
    f.setText('right', 'Replacement snapshot')
    f.button('right').click()
    expect(cancelled.cancelled).toBe(true)
    expect(f.context.preparingSubmissions.has('cancel-owner')).toBe(false)
    expect(f.input('right').value).toBe('Replacement snapshot')
    f.button('right').click()
    expect(reads).toBe(2)
    const replacement = [...f.pendingSubmissions.values()].find(record => record !== cancelled)!
    expect(replacement.uuid).not.toBe(cancelled.uuid)
    first.resolve(true)
    await f.settle()
    expect(f.calls.submissions).toEqual([])
    expect(f.context.preparingSubmissions.has('cancel-owner')).toBe(true)
    second.resolve(true)
    await f.settle()
    expect(f.calls.submissions.map(call => call.payload.text)).toEqual(['Replacement snapshot'])
    expect(f.calls.submissions[0].payload.clientMessageId).toBe(replacement.uuid)
    expect(f.unsent.has('cancel-owner')).toBe(false)
  } finally { await f.destroy() }
})

test('failed readiness retains a retryable submitted snapshot without overwriting newly authored content', async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('failure-owner', 'left')
    const ready = deferred<boolean>()
    f.context.ensureComposerModelConfigured = () => ready.promise
    f.setText('left', 'Retained unsent input')
    f.button('left').click()
    const pending = [...f.pendingSubmissions.values()][0]
    f.setText('left', 'New input')
    ready.resolve(false)
    await f.settle()
    expect(f.calls.submissions).toEqual([])
    expect(f.input('left').value).toBe('New input')
    expect(f.unsent.get('failure-owner').payload.clientMessageId).toBe(pending.uuid)
    expect(f.unsent.get('failure-owner').draft.text).toBe('Retained unsent input')
    expect(f.recoveries.get(pending.uuid).action).toBe('retry')
    f.recoveries.get(pending.uuid).run()
    await f.settle()
    expect(f.calls.submissions[0].payload.clientMessageId).toBe(pending.uuid)
    expect(f.input('left').value).toBe('New input')
  } finally { await f.destroy() }
})

test('workdir preparation is covered by the same pending owner and cannot send after cancellation', async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('workdir-owner', 'right')
    const workdir = deferred<string>()
    f.context.isWorktreeSessionWorkdir = () => true
    f.context.refreshWorktreeAvailability = () => workdir.promise
    f.setText('right', 'Workdir-bound input')
    f.button('right').click()
    await f.settle()
    expect(f.calls.admissions).toHaveLength(1)
    expect(f.calls.submissions).toEqual([])
    f.button('right').click()
    f.setText('right', 'New workdir draft')
    workdir.resolve('available')
    await f.settle()
    expect(f.calls.submissions).toEqual([])
    expect(f.input('right').value).toBe('New workdir draft')
  } finally { await f.destroy() }
})

test('a retained background preparation sends only its original session and leaves the visible editor untouched', async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('background-owner', 'right')
    const ready = deferred<boolean>()
    f.context.ensureComposerModelConfigured = () => ready.promise
    f.setText('right', 'Background input')
    f.button('right').click()
    const input = f.input('right')
    await f.window.klausSideSurfaceActivate('foreground-owner', 'right')
    f.setText('right', 'Foreground draft')
    ready.resolve(true)
    await f.settle()
    expect(f.calls.submissions.map(call => call.id)).toEqual(['background-owner'])
    expect(f.input('right').value).toBe('Foreground draft')
    await f.window.klausSideSurfaceActivate('background-owner', 'right')
    expect(f.input('right')).toBe(input)
    expect(input.value).toBe('')
  } finally { await f.destroy() }
})

test('uncertain admission retains its original identity without retrying or restoring over the new draft', async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('unknown-owner', 'right')
    let sends = 0
    f.context.submitTurnPayload = async () => { sends++; throw Error('Acknowledgement was lost') }
    f.setText('right', 'Uncertain input')
    f.button('right').click()
    const pending = [...f.pendingSubmissions.values()][0]
    f.setText('right', 'New input')
    await f.settle()
    expect(pending.phase).toBe('unconfirmed')
    expect(f.streamFor('unknown-owner').liveUnits.filter((unit: any) => unit.type === 'live-user')).toHaveLength(1)
    expect(f.recoveries.get(pending.uuid).action).toBe('dismiss')
    expect(f.unsent.has('unknown-owner')).toBe(false)
    expect(f.input('right').value).toBe('New input')
    f.recoveries.get(pending.uuid).run()
    expect(f.pendingSubmissions.has(pending.id)).toBe(false)
    expect(f.recoveries.has(pending.uuid)).toBe(false)
    expect(f.unsent.has('unknown-owner')).toBe(false)
    expect(sends).toBe(1)
    expect(f.input('right').value).toBe('New input')
  } finally { await f.destroy() }
})

test('upload waiting retains the live draft and only creates admission after the attachment is ready', async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('upload-owner', 'left')
    let checks = 0
    f.context.ensureComposerModelConfigured = async () => { checks++; return true }
    f.setText('left', 'Input with file')
    f.addFile('left', 'evidence.txt')
    f.button('left').click()
    await f.settle()
    expect(f.calls.admissions).toEqual([])
    expect(checks).toBe(0)
    expect(f.input('left').value).toBe('Input with file')
    expect(f.button('left').getAttribute('aria-label')).toBe('submit_tooltip_waiting_upload')
    f.uploads.get('evidence.txt')!.resolve({ path: '/uploads/evidence.txt', name: 'evidence.txt', type: 'text/plain' })
    await f.settle()
    expect(f.calls.admissions).toHaveLength(1)
    expect(f.calls.submissions).toHaveLength(1)
    expect(f.calls.submissions[0].payload.clientMessageId).toBe(f.calls.admissions[0].payload.uuid)
    expect(f.calls.submissions[0].payload.files[0].uploadPath).toBe('/uploads/evidence.txt')
  } finally { await f.destroy() }
})

test('Stop during dispatch waits for the captured admission and cannot stop a replacement turn', async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('dispatch-owner', 'right')
    const ack = deferred<string | null>()
    f.context.submitTurnPayload = () => ack.promise
    f.setText('right', 'Dispatched input')
    f.button('right').click()
    await f.settle()
    const pending = [...f.pendingSubmissions.values()][0]
    expect(pending.phase).toBe('submitting')
    f.setText('right', 'Independent new input')
    f.button('right').click()
    expect(pending.cancelled).toBe(true)
    expect(f.calls.stops).toEqual([])
    ack.resolve(null)
    await f.settle()
    expect(f.calls.stops).toEqual([])
    f.setRuntime('dispatch-owner', {
      running: true, activeTurnId: 'replacement', turnStatuses: { original: 'completed' },
      liveUnits: [{ type: 'live-user', turnId: 'original', msg: { role: 'user', uuid: pending.uuid } }],
    })
    f.vmApi.reconcileCancelledComposerAdmissions()
    expect(f.calls.stops).toEqual([])
    expect(f.context.cancelledComposerAdmissions.size).toBe(0)
    expect(f.input('right').value).toBe('Independent new input')
  } finally { await f.destroy() }
})

test('a cancelled dispatch stops once its own named turn is observed, not an unnamed session', async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('late-owner', 'left')
    const ack = deferred<string | null>()
    f.context.submitTurnPayload = () => ack.promise
    f.setText('left', 'Late named admission')
    f.button('left').click()
    await f.settle()
    const pending = [...f.pendingSubmissions.values()][0]
    f.button('left').click()
    ack.resolve(null)
    await f.settle()
    expect(f.calls.stops).toEqual([])
    f.setRuntime('late-owner', {
      running: true, activeTurnId: 'original',
      liveUnits: [{ type: 'live-user', turnId: 'original', msg: { role: 'user', uuid: pending.uuid } }],
    })
    f.vmApi.reconcileCancelledComposerAdmissions()
    f.vmApi.reconcileCancelledComposerAdmissions()
    expect(f.calls.stops).toEqual(['late-owner'])
    expect(f.calls.stopOwners).toEqual([{ id: 'late-owner', turnId: 'original' }])
  } finally { await f.destroy() }
})
