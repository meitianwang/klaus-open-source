interface Receipt { text: string; state: 'preparing' | 'dispatched' | 'confirmed' | 'uncertain'; done: Promise<void> }
export interface QuickInputSubmission { text: string; submissionId: string }

/** A missing renderer ACK is ambiguous; resending it could create a second conversation. */
export class QuickInputDelivery {
  private readonly receipts = new Map<string, Receipt>();
  private closed = false;
  constructor(private readonly deps: {
    ready(signal: AbortSignal, value: QuickInputSubmission): Promise<void>;
    deliver(value: QuickInputSubmission): Promise<void>;
    capacity?: number;
  }) {}
  submit(value: QuickInputSubmission, signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted) return Promise.reject(new Error('quick-input-cancelled'));
    const previous = this.receipts.get(value.submissionId);
    if (previous) {
      if (previous.text !== value.text) return Promise.reject(new Error('quick-input-submission-conflict'));
      return previous.state === 'uncertain' ? Promise.reject(new Error('quick-input-submission-unconfirmed')) : previous.done;
    }
    if (this.receipts.size >= (this.deps.capacity ?? 256)) {
      const confirmed = [...this.receipts].find(([, receipt]) => receipt.state === 'confirmed');
      if (confirmed) this.receipts.delete(confirmed[0]);
      else return Promise.reject(new Error('quick-input-submission-capacity'));
    }
    const receipt: Receipt = { text: value.text, state: 'preparing', done: Promise.resolve() };
    this.receipts.set(value.submissionId, receipt);
    receipt.done = Promise.resolve().then(async () => {
      await this.deps.ready(signal, value); signal.throwIfAborted();
      if (this.closed) throw new Error('quick-input-cancelled');
      receipt.state = 'dispatched';
      await this.deps.deliver(value);
      receipt.state = 'confirmed';
    }).catch(error => {
      if (receipt.state === 'preparing') { this.receipts.delete(value.submissionId); throw error; }
      receipt.state = 'uncertain'; throw new Error('quick-input-submission-unconfirmed');
    });
    return receipt.done;
  }
  close(): void { this.closed = true; }
}
