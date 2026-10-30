export function createPreferenceSaver<T>({
  getSessionId,
  getValue,
  setValue,
  onError,
  isEqual = (left: T, right: T) => left === right,
}: {
  getSessionId: () => string | undefined
  getValue: () => T
  setValue: (value: T) => void
  onError: (error: unknown) => void
  isEqual?: (left: T, right: T) => boolean
}) {
  let revision = 0
  return {
    invalidate() { revision++ },
    async save(value: T, persist: (value: T, sessionId: string | undefined) => Promise<unknown>): Promise<void> {
      const requestRevision = ++revision
      const sessionId = getSessionId()
      const previous = getValue()
      setValue(value)
      try {
        await persist(value, sessionId)
        // A preference-save reply says nothing about a request's captured model.
      } catch (error) {
        if (revision !== requestRevision || getSessionId() !== sessionId || !isEqual(getValue(), value)) return
        setValue(previous)
        onError(error)
      }
    },
  }
}
