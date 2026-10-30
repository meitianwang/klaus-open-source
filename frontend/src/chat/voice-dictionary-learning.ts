interface LearningNotice {
  remove(id: string): Promise<{ ok?: boolean } | null | undefined>
  changed(): void
  notify(terms: string[], undo: () => Promise<void>): void
}

/** Undo is scoped to the newly created ids returned by this learning request. */
export function publishDictionaryAdditions(value: unknown, notice: LearningNotice): void {
  const result = value as { ok?: boolean; addedHotwords?: Array<{ id?: unknown; text?: unknown }> } | null
  if (result?.ok !== true || !Array.isArray(result.addedHotwords)) return
  const words = new Map<string, string>()
  for (const word of result.addedHotwords) if (word && typeof word.id === 'string' && word.id && typeof word.text === 'string' && word.text) words.set(word.id, word.text)
  if (!words.size) return
  notice.changed()
  notice.notify([...words.values()], async () => {
    const results = await Promise.all([...words.keys()].map(id => notice.remove(id)))
    notice.changed()
    if (results.some(result => result?.ok !== true)) throw Error('voice-dictionary-undo-failed')
  })
}
