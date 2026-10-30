import { approvalReviewDenials, approveDeniedReview, replaceApprovalReviewHistory, approvalReviewPending, deniedApprovalReview } from '../approval-review-state'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import vector from '../../../../contracts/vectors/approval-review.json'
import { approvalReview, approvalReviewActionSummary, approvalReviewEvent } from '../../../../contracts/approval-review'
import { ApprovalReviewCard } from './approval-review'
import { withApprovalReviewShortcut, approvalReviewShortcutRange } from '../composer/approval-review-shortcut'
const hydrateApprovalReviewDenials = (sessionId: string, events: Record<string, unknown>[]) => replaceApprovalReviewHistory(sessionId, events.flatMap(event => {
  const review = approvalReview(event)
  return review ? [{event,review}] : []
}))
let previousWindow: unknown
let stream: typeof import('../stream-store')
let ActivityToolContent: typeof import('./activity-tool')['ActivityToolContent']
beforeAll(async () => {
  previousWindow = (globalThis as any).window
  ;(globalThis as any).window = { currentLang: 'en', addEventListener() {}, klaus: { session: { history: async () => ({ messages: [] }) } } }
  stream = await import('../stream-store')
  ;({ ActivityToolContent } = await import('./activity-tool'))
})
afterAll(() => { (globalThis as any).window = previousWindow })
test('all supported review actions retain their concrete payload and UI summary', () => {
  for (const action of vector.actions) {
    const review = approvalReview({ ...vector.denied, action })!
    expect(review).toBeDefined()
    expect(approvalReviewActionSummary(review.action).length).toBeGreaterThan(0)
    expect(review.reviewId).toBe('review-shell')
    expect(review.targetItemId).toBe('tool-shell')
  }
})
test('all lifecycle statuses remain distinct without offering human fallback buttons', () => {
  for (const status of vector.statuses) {
    const review = approvalReview({ ...vector.denied, status })!
    const html = renderToStaticMarkup(<ApprovalReviewCard review={review} />)
    expect(html).toContain(`data-review-status="${review.status}"`)
    expect(html).toContain('data-review-id="review-shell"')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('title=')
    expect(html).toContain(status === 'denied' ? 'Requires explicit authorization because this action is considered high risk' : 'The requested destination was not authorized.')
  }
})
test('denial selection retains the full original event and the newest ten unique denied actions', () => {
  const events = Array.from({ length: 12 }, (_, index) => ({ ...vector.denied, id: `review-${index}` }))
  hydrateApprovalReviewDenials('review-recent-window', [{ ...vector.denied, status: 'timed_out' }, events[0], ...events])
  const rows = approvalReviewDenials('review-recent-window')
  expect(rows).toHaveLength(10)
  expect(rows.map(row => row.review.reviewId)).toEqual(events.slice(0, 10).map(row => row.id))
  expect(rows[0].event).toBe(events[0])
})
test('parallel reviews update by review identity without reopening terminal status or crossing turns', () => {
  const sessionId = 'review-lifecycle'
  const send = (review: Record<string, unknown>) => stream.ingestChatEvent({ type: 'approval_review', sessionId, review })
  send({ ...vector.denied, status: 'in_progress' })
  send({ ...vector.denied, id: 'second', targetItemId: 'second-tool', status: 'in_progress' })
  send(vector.denied)
  send({ ...vector.denied, status: 'in_progress' })
  send({ ...vector.denied, turnId: 'foreign-turn', status: 'approved' })
  const units = stream.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-approval-review')
  expect(units).toHaveLength(2)
  expect(units[0]).toMatchObject({ turnId: 'turn-one', review: { status: 'denied', targetItemId: 'tool-shell' } })
  expect(units[1]).toMatchObject({ review: { status: 'inProgress', reviewId: 'second' } })
  expect(stream.getSessionStream('other-review-session').liveUnits).toHaveLength(0)
})
test('review shortcut is a local action and consumes only its own token', () => {
  expect(withApprovalReviewShortcut([], 'Review', false)).toEqual([])
  expect(withApprovalReviewShortcut([], 'Review', true)[0]).toMatchObject({ name: 'autoreview', type: 'action' })
  expect(approvalReviewShortcutRange(' /autoreview keep this draft')).toEqual({ start: 1, end: 12 })
  expect(approvalReviewShortcutRange('/autoreviewer')).toBeNull()
})

test('a richer raw denied event survives a subsequent product duplicate and foreign identities cannot replace it', () => {
  const sessionId = 'review-raw-attribution'
  const raw = { ...vector.denied, pluginId: 'package-tool', scriptPath: 'scripts/action.sh', reviewReason: 'authorization_changed' }
  const review = approvalReview(raw)!
  stream.ingestChatEvent({ type: 'approval_review', sessionId, review, rawReview: raw })
  const product = { ...review }; delete product.pluginId; delete product.scriptPath; delete product.reviewReason
  stream.ingestChatEvent({ type: 'approval_review', sessionId, review: product })
  stream.ingestChatEvent({ type: 'approval_review', sessionId, review: { ...product, turnId: 'foreign-turn' } })
  stream.ingestChatEvent({ type: 'approval_review', sessionId, review: { ...product, targetItemId: 'foreign-target' } })
  expect(approvalReviewDenials(sessionId)[0].event).toEqual(raw)
  expect(approvalReviewDenials(sessionId)[0].event).toHaveProperty('pluginId', 'package-tool')
  expect(approvalReviewDenials(sessionId)[0].review.turnId).toBe('turn-one')
})
test('one pending authorization blocks duplicate selection, failure retains the row and success consumes only that row', async () => {
  const sessionId = 'review-explicit-authorization'
  hydrateApprovalReviewDenials(sessionId, [vector.denied, { ...vector.denied, id: 'another-review', targetItemId: 'another-tool' }])
  const row = approvalReviewDenials(sessionId)[0]
  let release!: () => void
  const calls: Record<string, unknown>[] = []
  const selected = approveDeniedReview(sessionId, row, async event => { calls.push(event); await new Promise<void>(resolve => { release = resolve }) })
  expect(approvalReviewPending(sessionId)).toBe(row.review.reviewId)
  expect(await approveDeniedReview(sessionId, row, async () => { throw Error('duplicate') })).toBe(false)
  release(); expect(await selected).toBe(true)
  expect(calls).toEqual([vector.denied])
  expect(approvalReviewDenials(sessionId).map(row => row.review.reviewId)).toEqual(['another-review'])
  const remaining = approvalReviewDenials(sessionId)[0]
  let failed = false
  try { await approveDeniedReview(sessionId, remaining, async () => { throw Error('not admitted') }) } catch (error) { failed = error instanceof Error && error.message === 'not admitted' }
  expect(failed).toBe(true)
  expect(approvalReviewPending(sessionId)).toBeNull()
  expect(approvalReviewDenials(sessionId)[0]).toBe(remaining)
  hydrateApprovalReviewDenials(sessionId, [vector.denied])
  expect(approvalReviewDenials(sessionId).some(row => row.review.reviewId === 'review-shell')).toBe(false)
})

test('a completed review replay updates its history-owned card without appending a duplicate live card', () => {
  const sessionId = 'review-history-replay'
  const review = approvalReview(vector.denied)!
  stream.chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: { ...stream.getSessionStream(sessionId),
    history: [{ uuid: 'saved-review', kind: 'approval-review', turnId: review.turnId, approvalReview: review }], liveUnits: [] } } }))
  stream.ingestChatEvent({ type: 'approval_review', sessionId, review, rawReview: vector.denied })
  stream.ingestChatEvent({ type: 'approval_review', sessionId, review })
  stream.ingestChatEvent({ type: 'approval_review', sessionId, review: { ...review, turnId: 'foreign-turn' } })
  stream.ingestChatEvent({ type: 'approval_review', sessionId, review: { ...review, targetItemId: 'foreign-target' } })
  expect(stream.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-approval-review')).toHaveLength(0)
  expect(stream.getSessionStream(sessionId).history?.filter(row => row.kind === 'approval-review')).toHaveLength(1)
  expect(approvalReviewDenials(sessionId)[0].event).toEqual(vector.denied)
})

test('consuming the newest denial reveals the next older action within the ten-row window', async () => {
  const sessionId = 'review-eleven-denials'
  const events = Array.from({ length: 11 }, (_, index) => ({ ...vector.denied, id: `window-${index}`, startedAtMs: 1000 - index }))
  hydrateApprovalReviewDenials(sessionId, events)
  expect(approvalReviewDenials(sessionId).map(row => row.review.reviewId)).toEqual(events.slice(0, 10).map(row => row.id))
  await approveDeniedReview(sessionId, approvalReviewDenials(sessionId)[0], async () => ({}))
  expect(approvalReviewDenials(sessionId).map(row => row.review.reviewId)).toEqual(events.slice(1).map(row => row.id))
})
test('strict review notices use the per-turn source interval and unrelated warnings do not claim an interruption', () => {
  const sessionId = 'review-strict-notices'
  for (const [turnId, startedAtMs] of [['first', 1000], ['first', 10999], ['first', 11000], ['second', 1200]] as const) stream.ingestChatEvent({ type: 'approval_review_strict_required', sessionId, turnId, startedAtMs })
  stream.ingestChatEvent({ type: 'approval_review_warning', sessionId, message: 'An unrelated review warning' })
  stream.ingestChatEvent({ type: 'approval_review_warning', sessionId, kind: 'tooManyDenials', message: 'The turn stopped' })
  const units = stream.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-approval-review-notice')
  expect(units).toHaveLength(4)
  expect(units.filter(unit => unit.kind === 'strictReviewRequired').map(unit => unit.turnId)).toEqual(['first', 'first', 'second'])
  expect(units.filter(unit => unit.kind === 'tooManyDenials')).toHaveLength(1)
})
test('history handoff preserves a completed lifecycle received during an older pending history read', () => {
  const final = approvalReview(vector.denied)!
  const pending = { ...final, status: 'inProgress' as const, completedAtMs: undefined }
  const live = { type: 'live-approval-review' as const, key: `review:${final.reviewId}`, turnId: final.turnId, review: final }
  const result = stream.mergeApprovalReviewHistoryUnits([{ kind: 'approval-review', approvalReview: pending }], [live])
  expect(result.history[0].approvalReview.status).toBe('denied')
  expect(result.history[0].rawReview.status).toBe('denied')
  expect(result.liveUnits).toHaveLength(0)
})

test('an older inline denial remains authorizable outside the slash-menu window', async () => {
  const sessionId = 'review-inline-older'
  const events = Array.from({ length: 11 }, (_, index) => ({ ...vector.denied, id: `inline-${index}`, startedAtMs: 1000 - index }))
  hydrateApprovalReviewDenials(sessionId, events)
  expect(approvalReviewDenials(sessionId).some(row => row.review.reviewId === 'inline-10')).toBe(false)
  const older = deniedApprovalReview(sessionId, 'inline-10')!
  expect(older.event).toBe(events[10])
  await approveDeniedReview(sessionId, older, async event => { expect(event).toBe(events[10]); return {} })
  expect(deniedApprovalReview(sessionId, 'inline-10')).toBeUndefined()
  expect(await approveDeniedReview(sessionId, older, async () => { throw Error('duplicate') })).toBe(false)
})
test('product network protocol labels reconstruct the raw action codec', () => {
  for (const [product, raw] of [['socks5Tcp', 'socks5_tcp'], ['socks5Udp', 'socks5_udp']]) {
    const review = approvalReview({ ...vector.denied, action: { type: 'networkAccess', target: 'example.test:443', host: 'example.test', protocol: product, port: 443 } })!
    expect(approvalReviewEvent(review).action).toMatchObject({ type: 'network_access', protocol: raw })
  }
})

test('a declined command exposes its review rationale and shared authorization while read-only cards remain informational', () => {
  const sessionId = 'review-command-card'
  hydrateApprovalReviewDenials(sessionId, [vector.denied])
  const tool = {sessionId,toolCallId:'tool-shell',toolName:'exec_command',args:{cmd:'cp report.txt /outside/report.txt'},state:'error' as const,
    output:'Permission denied',approvalReviews:[approvalReview(vector.denied)!]}
  const editable = renderToStaticMarkup(<ActivityToolContent tool={tool} open onToggle={() => {}} locale="en-US" />)
  expect(editable).toContain('Command declined')
  expect(editable).toContain('Why it was denied')
  expect(editable).toContain('The requested destination was not authorized.')
  expect(editable).toContain('data-review-approve="review-shell"')
  const readOnly = renderToStaticMarkup(<ActivityToolContent tool={tool} open onToggle={() => {}} locale="en-US" readOnly />)
  expect(readOnly).toContain('Why it was denied')
  expect(readOnly).not.toContain('data-review-approve=')
})

test('product-only denial constructs the stored typed event and submits that same event unchanged', async () => {
  const sessionId = 'review-product-only'
  const review = approvalReview(vector.denied)!
  stream.ingestChatEvent({type:'approval_review',sessionId,review})
  const row = approvalReviewDenials(sessionId)[0]
  const expected = {id:review.reviewId,targetItemId:review.targetItemId,turnId:review.turnId,status:'denied',riskLevel:review.riskLevel,
    userAuthorization:review.userAuthorization,rationale:review.rationale,decisionSource:review.decisionSource ?? null,action:vector.denied.action}
  expect(row.event).toEqual(expected)
  expect(row.event).not.toHaveProperty('startedAtMs')
  expect(row.event).not.toHaveProperty('pluginId')
  await approveDeniedReview(sessionId,row,async event => { expect(event).toBe(row.event); return {} })
})
test('replacing or clearing loaded transcript history removes departed denial candidates', () => {
  const sessionId = 'review-canonical-history'
  for (const id of ['kept','reverted']) stream.ingestChatEvent({type:'approval_review',sessionId,review:{...vector.denied,id}})
  expect(approvalReviewDenials(sessionId).map(row=>row.review.reviewId)).toEqual(['reverted','kept'])
  const kept = approvalReview({...vector.denied,id:'kept'})!
  stream.chatStreamStore.setState(state=>({sessions:{...state.sessions,[sessionId]:{...stream.getSessionStream(sessionId),
    history:[{kind:'approval-review',approvalReview:kept,rawReview:{...vector.denied,id:'kept'},rawReviewAuthoritative:true}],liveUnits:[]}}}))
  expect(approvalReviewDenials(sessionId).map(row=>row.review.reviewId)).toEqual(['kept'])
  stream.chatStreamStore.setState(state=>({sessions:{...state.sessions,[sessionId]:{...stream.getSessionStream(sessionId),history:[],liveUnits:[]}}}))
  expect(approvalReviewDenials(sessionId)).toHaveLength(0)
})
test('a non-command tool review does not gain an inline authorization control', () => {
  const sessionId = 'review-mcp-details'
  hydrateApprovalReviewDenials(sessionId,[vector.denied])
  const tool = {sessionId,toolCallId:'tool-shell',toolName:'mcp__example__send',args:{},state:'error' as const,output:'Declined',approvalReviews:[approvalReview(vector.denied)!]}
  expect(renderToStaticMarkup(<ActivityToolContent tool={tool} open onToggle={()=>{}} locale="en-US" />)).not.toContain('data-review-approve=')
})
