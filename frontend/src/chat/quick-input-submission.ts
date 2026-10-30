interface Receipt { text: string; settled: boolean; done: Promise<void> }

/** Register the receipt before entering a new conversation, including failed attempts. */
export function createQuickInputConsumer(send: (text: string) => Promise<void>) {
  const receipts = new Map<string, Receipt>()
  return (value: { text?: string; submissionId?: string } = {}): Promise<void> => {
    const text = typeof value.text === 'string' ? value.text.trim() : ''
    if (!text || text.length > 8000) return Promise.reject(new Error('Invalid quick input text'))
    const id = value.submissionId ?? crypto.randomUUID()
    if (typeof id !== 'string' || !id || id.length > 128) return Promise.reject(new Error('Invalid quick input identity'))
    const previous = receipts.get(id)
    if (previous) return previous.text === text ? previous.done : Promise.reject(new Error('Quick input identity conflicts with its text'))
    if (receipts.size >= 256) {
      const settled = [...receipts].find(([, receipt]) => receipt.settled)
      if (settled) receipts.delete(settled[0])
      else return Promise.reject(new Error('Too many quick input submissions are waiting'))
    }
    const receipt: Receipt = { text, settled: false, done: Promise.resolve() }
    receipts.set(id, receipt)
    receipt.done = Promise.resolve().then(() => send(text)).finally(() => { receipt.settled = true })
    return receipt.done
  }
}
