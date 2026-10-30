import type { GoalObjectiveInput, PreparedGoalObjective } from '../../../../contracts/planning-goals'
import type { PendingFileEntry } from '../engine-events'
import { isInlineImage } from '../composer/attachment-policy'
import { GoalSubmissionReceipts, type GoalSubmissionReceipt, type GoalSubmissionTarget } from './submission'

/** Goal resources preserve admitted image bytes and original filenames without decoding them. */
export function goalImageInputs(files: readonly PendingFileEntry[]): NonNullable<GoalObjectiveInput['images']> {
  return files.filter(file => file.kind !== 'pasted-text' && file.kind !== 'selected-text' && file.uploadPath
    && (file.kind === 'image' || file.file.type.toLowerCase().startsWith('image/') || /^data:image\//i.test(file.uploadPath) || isInlineImage(file.file.name, file.file.type)))
    .map(file => {
      const source = file.uploadPath!
      return { filename: file.file.name, ...(file.file.type ? { mimeType: file.file.type } : {}),
        ...(/^https?:\/\//i.test(source) ? { url: source } : /^data:/i.test(source) ? { dataUrl: source } : { path: source }),
      }
    })
}

export type PreparedGoalSubmission = PreparedGoalObjective & { receipt: GoalSubmissionReceipt }

/** Persist identity before materialization so a lost reply can recover the host's immutable DTO. */
export async function prepareGoalSubmission(options: {
  receipts: GoalSubmissionReceipts
  sessionId: string
  serializedIntent: string
  target: GoalSubmissionTarget
  input: Omit<GoalObjectiveInput, 'clientRequestId'>
  valid(): boolean
  prepare(input: GoalObjectiveInput): Promise<PreparedGoalObjective>
  onReceipt(receipt: GoalSubmissionReceipt): void
}): Promise<PreparedGoalSubmission | null> {
  const receipt = await options.receipts.forIntent(options.sessionId, options.serializedIntent, options.target)
  options.onReceipt(receipt)
  if (!options.valid()) return null
  const prepared = await options.prepare({ ...options.input, clientRequestId: receipt.id })
  return { ...prepared, receipt }
}
