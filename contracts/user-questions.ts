/** New questions use stable IDs; historical questions retain their original key. */
export function questionAnswerKey(question: { id?: string; question: string }): string {
  return question.id ?? question.question
}

/** Keep historical prompt aliases unambiguous relative to canonical IDs. */
export function uniqueQuestionKeys(questions: Array<{ id?: string; question: string }>): boolean {
  const keys = questions.map(questionAnswerKey)
  return keys.every(key => key.trim().length > 0) && new Set(keys).size === keys.length
    && questions.every((question, index) => questions.every((other, otherIndex) => index === otherIndex
      || questionAnswerKey(question) !== other.question))
}

/** Preserve older clients only when a prompt identifies exactly one question. */
export function canonicalQuestionMap<T>(questions: Array<{ id?: string; question: string }>, values: Record<string, T>): Record<string, T> | undefined {
  if (!uniqueQuestionKeys(questions)) return undefined
  const entries: Array<[string, T]> = []
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(values)) {
    const matches = questions.filter(question => questionAnswerKey(question) === key || question.question === key)
    if (matches.length !== 1) return undefined
    const target = questionAnswerKey(matches[0]!)
    if (seen.has(target)) return undefined
    seen.add(target)
    entries.push([target, value])
  }
  return Object.fromEntries(entries)
}
