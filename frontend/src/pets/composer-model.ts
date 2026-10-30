import type { PetComposerSubmission } from "../../../contracts/desktop-pet-composer";

export function submissionForAttempt(
  previous: PetComposerSubmission | null,
  draft: Omit<PetComposerSubmission, "submissionId">,
  createId: () => string,
): PetComposerSubmission {
  const next = {
    text: draft.text.trim(),
    attachmentIds: [...draft.attachmentIds],
    ...(draft.targetTaskId ? { targetTaskId: draft.targetTaskId } : {}),
    ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
  };
  if (
    previous &&
    previous.text === next.text &&
    previous.targetTaskId === next.targetTaskId &&
    JSON.stringify(previous.replyTo) === JSON.stringify(next.replyTo) &&
    JSON.stringify(previous.attachmentIds) ===
      JSON.stringify(next.attachmentIds)
  )
    return previous;
  return { ...next, submissionId: createId() };
}
