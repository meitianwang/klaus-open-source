import { describe, expect, test } from 'bun:test'
import { parse } from 'node-html-parser'
import type { QuestionAnswerMetadata } from '../../../../contracts/async-questions'
import vector from '../../../../contracts/vectors/question-answer-display-vectors.json'
import { initialQuestionDraft, questionAnswers, questionAttachments } from './question-state'
import { questionReplyDisplay } from './question-answer-display'

;(globalThis as any).window = { addEventListener() {}, klaus: { media: {
  url: (path: string, sessionId: string) => `klaus-media://test/${sessionId}/${encodeURIComponent(path)}`,
} } }
const { buildUserBubbleHtml } = await import('./TranscriptView')

function reply(answer: string, imageCount: number, local = false) {
  const images = Array.from({ length: imageCount }, (_, index) => ({ ...vector.image, path: `${vector.image.path}.${index}` }))
  const questionAnswer: Pick<QuestionAnswerMetadata, 'questions' | 'answers'> = {
    questions: [{ id: 'reference', question: 'Which reference?', options: [] }], answers: { reference: answer },
  }
  return { text: `Which reference?\n${answer}`, questionAnswer, contentBlocks: local ? undefined : images,
    localRender: local ? { attachments: images.map(image => ({ ...image, src: `blob:image-${image.path}` })) } : undefined }
}

describe('question reply attachment display', () => {
  for (const row of vector.cases) test(row.name, () => {
    const message = reply(row.answer, row.imageCount)
    const original = JSON.stringify(message)
    expect(questionReplyDisplay(message.questionAnswer, row.imageCount)).toEqual([
      { question: 'Which reference?', text: row.text },
    ])
    const html = buildUserBubbleHtml(message, true, 'question-owner')!.html
    expect(html.match(/<img /g) || []).toHaveLength(row.imageCount)
    expect(html).toContain('Which reference?')
    if (row.text.includes('[Attachment:')) expect(html).toContain('[Attachment:')
    else expect(html).not.toContain('[Attachment:')
    if (row.text && !row.text.includes('[Attachment:')) expect(html).toContain(row.text)
    if (!row.text) expect(parse(html).querySelector('.msg.user')!.children[0].children).toHaveLength(1)
    expect(JSON.stringify(message)).toBe(original)
  })

  test('live and saved replies render each image once with their owning session', () => {
    for (const local of [false, true]) {
      const html = buildUserBubbleHtml(reply(`Attached.\n${vector.imageReference}`, 1, local), true, 'question-owner')!.html
      expect(html.match(/<img /g)).toHaveLength(1)
      expect(html).toContain('data-media-session="question-owner"')
      expect(html).toContain('Attached.')
      expect(html).not.toContain('[Attachment:')
      expect(html).not.toContain('/fixture/uploads/')
    }
  })

  test('ordinary user messages preserve attachment-like text', () => {
    const message = reply(vector.imageReference, 1)
    const html = buildUserBubbleHtml({ text: message.text, contentBlocks: message.contentBlocks }, true, 'owner')!.html
    expect(html).toContain(vector.imageReference)
  })

  test('partially missing media preserves every image reference across stable question IDs', () => {
    const message = reply(vector.imageReference, 1)
    message.questionAnswer.questions = ['first', 'second', 'pending'].map(id => ({ id, question: 'Which reference?', options: [] }))
    message.questionAnswer.answers = { first: vector.imageReference, second: vector.imageReference }
    const html = buildUserBubbleHtml(message, true, 'owner')!.html
    expect(html.match(/<img /g)).toHaveLength(1)
    expect(html.match(/\[Attachment:/g)).toHaveLength(2)
    expect(html.match(/Which reference\?/g)).toHaveLength(2)
  })

  test('attachment-only submission still sends the original wire references and files', () => {
    const questions = [{ id: 'reference', question: 'Which reference?', options: [] }]
    const draft = initialQuestionDraft(questions)
    const file = { name: 'image.png', path: '/fixture/uploads/14c742e2-907f-4418-b468-25692e589789.png', type: 'image/png', size: 8 }
    draft.answers[0].attachments = [file]
    expect(questionAnswers(questions, draft)).toEqual({ reference: vector.imageReference })
    expect(questionAttachments(questions, draft)).toEqual({ reference: [file] })
  })
})
