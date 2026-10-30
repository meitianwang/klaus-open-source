import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
;(globalThis as any).window ??= { addEventListener() {} }
const { ProposedPlanCard, ProposedPlanReview, PlanDocumentEditor } = await import('./plan-card')
const { createPlanReviewController } = await import('./plan-controller')
const plan = { id: 'visible-plan', threadId: 'thread-a', turnId: 'turn-a', revision: 1, content: '# Complete plan\n\nDetails in full.', status: 'proposed' as const }
const planning = { mode: 'plan' as const, revision: 1, plans: [plan] }
const document = { planId: plan.id, revision: 1, path: '/owned/PLAN.md', content: plan.content }
const api = {
  get: async () => ({ planning }), readDocument: async () => ({ planning, document }), saveDocument: async () => ({ planning, document }),
  accept: async () => ({ planning, accepted: true }), feedback: async () => ({ planning }), cancel: async () => ({ planning }),
}
test('the transcript preview exposes document actions and keeps the implementation decision outside the artifact', () => {
  const controller = createPlanReviewController('thread-a', plan, api, () => {})
  const html = renderToStaticMarkup(<ProposedPlanCard controller={controller} onOpen={() => {}} download={async () => {}} />)
  expect(html).toContain('data-plan-id="visible-plan"')
  expect(html).toContain('Copy plan')
  expect(html).toContain('Download PLAN.md')
  expect(html).toContain('Open plan')
  expect(html).toContain('Collapse plan')
  expect(html).toContain('class="proposed-plan-open" aria-label="Open plan"')
  expect(html).toContain('class="planning-copy-status" role="status"')
  expect(html).not.toContain('Yes, implement this plan')
  const review = renderToStaticMarkup(<ProposedPlanReview controller={controller} />)
  expect(review.match(/Yes, implement this plan/g)).toHaveLength(1)
  expect(review).toContain('Implement this plan?')
  expect(review).toContain('Skip')
  expect(html).toContain('Details in full.')
})
test('dismissed plan review keeps the document and removes implementation actions', async () => {
  const controller = createPlanReviewController('thread-a', plan, api, () => {})
  await controller.cancel()
  const html = renderToStaticMarkup(<ProposedPlanCard controller={controller} onOpen={() => {}} download={async () => {}} />)
  expect(html).toContain('Details in full.')
  expect(html).not.toContain('Yes, implement this plan')
})
test('plan editor renders the document without duplicating document controls', () => {
  const controller = createPlanReviewController('thread-a', plan, api, () => {})
  const editor = renderToStaticMarkup(<PlanDocumentEditor controller={controller} />)
  expect(editor).toContain('<h1>Complete plan</h1>')
  expect(editor).toContain('planning-document-preview')
  expect(editor).not.toContain('Edit plan')
  expect(editor).toContain('planning-document-surface')
  expect(editor).not.toContain('PLAN.md')
  expect(editor).not.toContain('>Save<')
  expect(editor).not.toContain('>Revert<')
})


test('a remounted history card retains its open authored feedback through the review controller', () => {
  const controller = createPlanReviewController('thread-a', plan, api, () => {})
  controller.setFeedbackOpen(true)
  controller.editFeedback('  Preserve my review\nSecond line  ')
  const renderCard = () => renderToStaticMarkup(<ProposedPlanReview controller={controller} />)
  expect(renderCard()).toContain('Send feedback')
  controller.sync({ ...plan })
  const historyCard = renderCard()
  expect(historyCard).toContain('Send feedback')
  expect(historyCard).toContain('Preserve my review')
  expect(controller.getSnapshot().feedbackDraft).toBe('  Preserve my review\nSecond line  ')
})


test('the default document view renders headings, emphasis and tables without exposing Markdown source', () => {
  const content = '# Readable proposal\n\n**Important** details.\n\n| Plant | Cost |\n| --- | --- |\n| Sunflower | 50 |'
  const controller = createPlanReviewController('thread-a', { ...plan, content }, api, () => {})
  const html = renderToStaticMarkup(<PlanDocumentEditor controller={controller} />)
  expect(html).toContain('<h1>Readable proposal</h1>')
  expect(html).toContain('<strong>Important</strong>')
  expect(html).toContain('<table>')
  expect(html).not.toContain('# Readable proposal')
  expect(html).not.toContain('| Plant | Cost |')
  expect(html).not.toContain('cm-content')
})

test('only pending proposals expose a separate implementation decision', async () => {
  const controller = createPlanReviewController('thread-a', plan, api, () => {})
  expect(renderToStaticMarkup(<ProposedPlanReview controller={controller} />)).toContain('Implement this plan?')
  await controller.cancel()
  expect(renderToStaticMarkup(<ProposedPlanReview controller={controller} />)).toBe('')
  expect(renderToStaticMarkup(<ProposedPlanCard controller={controller} onOpen={() => {}} download={async () => {}} />)).toContain('Details in full.')
})
