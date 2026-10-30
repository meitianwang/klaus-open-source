import type { QuestionAnswerMetadata } from '../../../../contracts/async-questions'
import { isInlineImage } from '../composer/attachment-policy'
import { questionAnswer, questionAnswerKey } from './question-state'

interface QuestionReplyDisplay { question: string; text: string }

// Uploaded question attachments have UUID filenames under the managed uploads
// directory. Restrict legacy marker recognition to that shape and the answer's
// trailing block so examples, quoted markers and ordinary paths remain prose.
const UPLOAD_PATH = /[/\\]uploads[/\\][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[\p{L}\p{N}_-]{1,24})?$/iu
const ATTACHMENT_LINE = /^\[Attachment: (.+)\] \(((?:\/|[A-Za-z]:[/\\]|\\\\)[^\r\n]+)\)\r?$/

/** Project saved wire references without changing the answers sent to the model. */
export function questionReplyDisplay(
  metadata: Pick<QuestionAnswerMetadata, 'questions' | 'answers'>,
  availableImages: number,
): QuestionReplyDisplay[] {
  const replies = metadata.questions.flatMap(question => {
    const answer = questionAnswer(metadata.answers, questionAnswerKey(question))
    if (answer === undefined) return []
    const lines = answer.split('\n')
    const suffix: Array<{ line: string; image: boolean }> = []
    while (lines.length) {
      const line = lines[lines.length - 1]
      const match = ATTACHMENT_LINE.exec(line)
      if (!match || !UPLOAD_PATH.test(match[2])) break
      suffix.unshift({ line, image: isInlineImage(match[1]) || isInlineImage(match[2]) })
      lines.pop()
    }
    return [{ question: question.question, answer, lines, suffix }]
  })
  // Pool conversion drops the original upload path. If any image is missing,
  // retain every image reference because the surviving images cannot be paired
  // with individual references safely.
  const allImagesBacked = availableImages >= replies.reduce((count, reply) => count + reply.suffix.filter(file => file.image).length, 0)
  return replies.map(({ question, answer, lines, suffix }) => {
    for (const reference of suffix) {
      if (!reference.image || !allImagesBacked) lines.push(reference.line)
    }
    return { question, text: suffix.length ? lines.join('\n').trimEnd() : answer }
  })
}
