type Clock = () => number
type Delay = (milliseconds: number) => Promise<void>

const defaultDelay: Delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export async function finishAfterMinimumDuration<T>(
  operation: () => Promise<T>,
  minimumMilliseconds: number,
  clock: Clock = Date.now,
  delay: Delay = defaultDelay,
): Promise<T> {
  const startedAt = clock()
  try {
    return await operation()
  } finally {
    const remaining = minimumMilliseconds - (clock() - startedAt)
    if (remaining > 0) await delay(remaining)
  }
}
