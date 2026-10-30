import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createSpecReviewController } from './transcript/spec-review-controller'
import { SpecDocumentModel } from './spec-document-model'

const contract = JSON.parse(readFileSync(new URL('../../../contracts/vectors/spec-review-vectors.json', import.meta.url), 'utf8'))

describe('Spec document review contract', () => {
  test('review and document panel read the same full document and retain every section after editing', async () => {
    let approved: Record<string, unknown> | undefined
    const read = async () => ({ content: contract.document, revision: 'revision-1' })
    const documents = new SpecDocumentModel({ read })
    documents.register('session', contract.path)
    await documents.refresh('session', contract.path)
    const review = createSpecReviewController({ path: contract.path, input: { plan: contract.summary } }, {
      readDocument: read,
      getGoal: async () => null,
      setGoal: async () => { throw new Error('not requested') },
      respond: async (_decision, input) => { approved = input },
      goalObjective: path => path,
    })
    await review.loadDocument()
    expect(review.getSnapshot().content).toBe(documents.get('session', contract.path)?.content)
    review.edit(review.getSnapshot().content + contract.edit)
    expect(await review.approve()).toBe(true)
    expect(approved?.plan).toBe(contract.document + contract.edit)
    expect(approved?.planRevision).toBe('revision-1')
    documents.dispose()
  })

  test('Goal creation failure cannot consume the Spec approval', async () => {
    let approvals = 0
    const review = createSpecReviewController({ path: contract.path, input: { plan: contract.summary } }, {
      readDocument: async () => ({ content: contract.document }),
      getGoal: async () => null,
      setGoal: async () => { throw new Error('Goal creation failed') },
      respond: async () => { approvals++ },
      goalObjective: path => path,
    })
    await review.loadDocument()
    review.setGoalEnabled(true)
    expect(await review.approve()).toBe(false)
    expect(approvals).toBe(0)
    expect(review.getSnapshot().content).toBe(contract.document)
    expect(review.getSnapshot().phase).toBe('pending')
  })
})
