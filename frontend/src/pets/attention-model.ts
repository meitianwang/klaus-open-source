import type {
  PetAttention,
  PetAttentionResponse,
  PetFormValue,
  PetQuestionAttention,
} from "../../../contracts/desktop-pet-attention";

export function questionResponse(
  attention: PetQuestionAttention,
  answers: Record<string, string>,
  attachments: Record<string, string[]> = {},
): PetAttentionResponse {
  const selectedAttachments = attention.attachmentsSupported
    ? Object.fromEntries(
        attention.questions.flatMap((question) => {
          const ids = attachments[question.question];
          return ids?.length ? [[question.question, [...ids]]] : [];
        }),
      )
    : {};
  if (
    attention.responseMode === "values" &&
    !Object.keys(selectedAttachments).length
  )
    return {
      kind: "accept",
      values: attention.questions.map(
        (question) => answers[question.question] || "",
      ),
    };
  return {
    kind: "answers",
    answers,
    ...(Object.keys(selectedAttachments).length
      ? { attachments: selectedAttachments }
      : {}),
  };
}
export function canSubmitQuestion(
  attention: PetQuestionAttention,
  answers: Record<string, string>,
  attachments: Record<string, string[]> = {},
): boolean {
  return attention.questions.every(
    (question) =>
      Boolean(answers[question.question]?.trim()) ||
      Boolean(
        attention.attachmentsSupported &&
        attachments[question.question]?.length,
      ),
  );
}
export function initialFormValues(
  attention: Extract<PetAttention, { kind: "mcp-form" }>,
): Record<string, PetFormValue> {
  return Object.fromEntries(
    Object.entries(attention.schema.properties).flatMap(([key, field]) => {
      const value =
        field.default ??
        (field.type === "boolean"
          ? false
          : field.type === "array"
            ? []
            : undefined);
      return value === undefined
        ? []
        : [[key, Array.isArray(value) ? [...value] : value]];
    }),
  );
}
