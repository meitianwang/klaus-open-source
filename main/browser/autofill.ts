import {
  BROWSER_CREDENTIAL_LIMITS,
  type BrowserAutofillAck,
  type BrowserAutofillCandidate,
  type BrowserAutofillFieldKind,
  type BrowserAutofillFillMessage,
  type BrowserAutofillFillReceipt,
  type BrowserAutofillFrame,
  type BrowserAutofillOptions,
  type BrowserAutofillProfile,
  type BrowserAutofillProfileKind,
  type BrowserAutofillSaveCandidate,
  type BrowserAutofillSaveReceipt,
  type BrowserAutofillSubmission,
} from '../../contracts/browser-credentials';
import { BrowserError } from './types';

interface FrameGeneration {
  documentId: string;
  origin: string;
  generation: number;
}

function exactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function displayReason(error: unknown): string {
  return error instanceof BrowserError ? error.code : 'invalid';
}

function normalizeFrame(frame: BrowserAutofillFrame): BrowserAutofillFrame | null {
  const origin = exactOrigin(frame.origin);
  if (!origin) return null;
  return { ...frame, origin };
}

/**
 * Coordinates credential selection and one-frame fills.
 *
 * The controller never resolves a credential for a frame whose exact origin
 * does not match the credential origin. Every await boundary is followed by a
 * document and origin check, so a chooser or decryption delay cannot land after
 * a navigation. Frames are addressed by id; a top-frame navigation invalidates
 * every pending fill.
 */
export class BrowserAutofillController {
  private readonly generations = new Map<string, FrameGeneration>();
  private readonly revocations = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<BrowserAutofillFillReceipt>>();
  private readonly knownSubmissions = new Set<string>();
  private readonly cancelledSubmissions = new Set<string>();
  private submissionGeneration = 0;
  private topLevelGeneration = 0;
  private disposed = false;

  constructor(private readonly options: BrowserAutofillOptions) {}

  noteFrame(frame: BrowserAutofillFrame): void {
    const normalized = normalizeFrame(frame);
    if (!normalized) throw new BrowserError('invalid_request', 'Autofill requires an exact HTTP(S) frame origin.');
    const current = this.generations.get(normalized.frameId);
    if (current && current.documentId === normalized.documentId && current.origin === normalized.origin) return;
    this.generations.set(normalized.frameId, {
      documentId: normalized.documentId,
      origin: normalized.origin,
      generation: (current?.generation ?? 0) + 1,
    });
  }

  noteNavigation(frameId: string, next?: BrowserAutofillFrame | null): void {
    this.revocations.set(frameId, (this.revocations.get(frameId) ?? 0) + 1);
    if (next) {
      this.noteFrame(next);
      return;
    }
    const current = this.generations.get(frameId);
    if (current) {
      this.generations.set(frameId, { ...current, generation: current.generation + 1 });
    }
  }

  noteTopLevelNavigation(): void {
    this.topLevelGeneration += 1;
    this.generations.clear();
    this.revocations.clear();
  }

  cancel(frameId: string): void {
    this.revocations.set(frameId, (this.revocations.get(frameId) ?? 0) + 1);
    const current = this.generations.get(frameId);
    if (current) this.generations.set(frameId, { ...current, generation: current.generation + 1 });
  }

  cancelAll(): void {
    this.noteTopLevelNavigation();
  }

  cancelSubmission(submissionId: string): void {
    if (submissionId) this.cancelledSubmissions.add(submissionId);
  }

  cancelAllSubmissions(): void {
    this.submissionGeneration += 1;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAllSubmissions();
    this.noteTopLevelNavigation();
  }

  async trustedInput(input: {
    frameId: string;
    kind: BrowserAutofillFieldKind;
    intentId: string;
    trusted: boolean;
  }): Promise<BrowserAutofillFillReceipt> {
    if (input.trusted !== true) return { filled: false, reason: 'untrusted' };
    if (!this.enabled()) return { filled: false, reason: 'disabled' };
    if (!input.intentId) return { filled: false, reason: 'not_found' };
    if (this.inFlight.has(input.frameId)) return { filled: false, reason: 'busy' };
    const kind = input.kind;
    if (kind === 'password' || kind === 'username') {
      return this.runExclusive(input.frameId, () => this.fillPassword(input.frameId, kind, input.intentId));
    }
    if (kind === 'address' || kind === 'contact' || kind === 'email') {
      return this.runExclusive(
        input.frameId,
        () => this.fillProfile(input.frameId, profileKindFor(kind), input.intentId),
      );
    }
    return { filled: false, reason: 'not_found' };
  }

  async selectCandidate(input: {
    frameId: string;
    candidateId: string;
    intentId: string;
    kind: 'password' | BrowserAutofillProfileKind;
  }): Promise<BrowserAutofillFillReceipt> {
    if (!this.enabled()) return { filled: false, reason: 'disabled' };
    if (!input.candidateId) return { filled: false, reason: 'not_found' };
    if (!input.intentId) return { filled: false, reason: 'not_found' };
    if (this.inFlight.has(input.frameId)) return { filled: false, reason: 'busy' };
    return this.runExclusive(input.frameId, () => this.selectCandidateExclusive(input, input.intentId));
  }

  private async selectCandidateExclusive(
    input: { frameId: string; candidateId: string; kind: 'password' | BrowserAutofillProfileKind },
    intentId: string,
  ): Promise<BrowserAutofillFillReceipt> {
    const revocationAtStart = this.revocationOf(input.frameId);
    const frame = await this.currentFrame(input.frameId);
    if (!frame) return { filled: false, reason: 'not_found' };
    const generation = this.generationOf(frame.frameId);
    const topGeneration = this.topLevelGeneration;
    const revocation = revocationAtStart;
    if (input.kind === 'password') {
      const summaries = await this.options.store.listPasswords(frame.origin);
      if (!summaries.some(item => item.id === input.candidateId)) {
        return { filled: false, reason: 'origin_mismatch' };
      }
      const secret = await this.options.store.readPassword(input.candidateId, 'display', () => true);
      if (secret === null) return { filled: false, reason: 'not_found' };
      if (!await this.stillCurrent(frame, generation, topGeneration, revocation)) {
        return { filled: false, reason: 'navigation' };
      }
      return await this.send(frame, {
        type: 'browser-autofill:fill',
        documentId: frame.documentId,
        frameId: frame.frameId,
        intentId,
        kind: 'password',
        values: { username: summaries.find(item => item.id === input.candidateId)?.username, password: secret },
      });
    }

    const profile = await this.options.store.readAutofillProfile(input.candidateId);
    if (!profile) return { filled: false, reason: 'not_found' };
    if (profile.kind !== input.kind) return { filled: false, reason: 'not_found' };
    if (!await this.stillCurrent(frame, generation, topGeneration, revocation)) {
      return { filled: false, reason: 'navigation' };
    }
    return await this.send(frame, {
      type: 'browser-autofill:fill',
      documentId: frame.documentId,
      frameId: frame.frameId,
      intentId,
      kind: profile.kind,
      values: { fields: profile.fields },
    });
  }

  async captureSave(submission: BrowserAutofillSubmission): Promise<BrowserAutofillSaveReceipt> {
    if (!this.enabled()) return { saved: false, reason: 'disabled' };
    if (!this.validSubmission(submission)) return { saved: false, reason: 'invalid' };
    if (this.knownSubmissions.has(submission.submissionId)) return { saved: false, reason: 'invalid' };
    if (this.cancelledSubmissions.has(submission.submissionId)) return { saved: false, reason: 'cancelled' };
    const generation = this.submissionGeneration;
    this.knownSubmissions.add(submission.submissionId);
    if (this.options.isSubmissionAlive && !this.options.isSubmissionAlive(submission)) {
      return { saved: false, reason: 'cancelled' };
    }
    const candidate: BrowserAutofillSaveCandidate = {
      originUrl: submission.originUrl,
      username: submission.username.trim(),
      password: submission.password,
    };
    let confirmed = false;
    try {
      confirmed = await this.options.confirmSave(candidate, { submission });
    } catch {
      confirmed = false;
    }
    if (!confirmed) return { saved: false, reason: 'cancelled' };
    if (this.disposed || !this.enabled() || generation !== this.submissionGeneration
      || this.cancelledSubmissions.has(submission.submissionId)) {
      return { saved: false, reason: this.disposed || !this.enabled() ? 'disabled' : 'cancelled' };
    }
    if (this.options.isSubmissionAlive && !this.options.isSubmissionAlive(submission)) {
      return { saved: false, reason: 'cancelled' };
    }
    try {
      const saved = await this.options.store.savePassword(candidate);
      return { saved: true, credentialId: saved.id };
    } catch (error) {
      return { saved: false, reason: displayReason(error) as BrowserAutofillSaveReceipt['reason'] };
    }
  }

  private validSubmission(submission: BrowserAutofillSubmission): boolean {
    if (!submission || typeof submission !== 'object') return false;
    if (!submission.submissionId || !submission.frameId || !submission.documentId || !submission.frameToken) return false;
    if (!Number.isSafeInteger(submission.contentsId) || submission.contentsId < 0
      || !Number.isSafeInteger(submission.processId) || submission.processId < 0
      || !Number.isSafeInteger(submission.routingId) || submission.routingId < 0
      || !Number.isSafeInteger(submission.frameTreeNodeId) || submission.frameTreeNodeId < 0
      || !Number.isSafeInteger(submission.capturedAt) || submission.capturedAt < 0) return false;
    if (typeof submission.username !== 'string' || !submission.username.trim()
      || typeof submission.password !== 'string' || !submission.password) return false;
    if (submission.username.length > BROWSER_CREDENTIAL_LIMITS.maxUsernameLength
      || submission.password.length > BROWSER_CREDENTIAL_LIMITS.maxPasswordLength) return false;
    return exactOrigin(submission.originUrl) === submission.originUrl;
  }

  private async fillPassword(
    frameId: string,
    kind: 'password' | 'username',
    intentId: string,
  ): Promise<BrowserAutofillFillReceipt> {
    const revocationAtStart = this.revocationOf(frameId);
    const frame = await this.currentFrame(frameId);
    if (!frame) return { filled: false, reason: 'not_found' };
    const generation = this.generationOf(frame.frameId);
    const topGeneration = this.topLevelGeneration;
    const revocation = revocationAtStart;
    const summaries = await this.options.store.listPasswords(frame.origin);
    if (!summaries.length) return { filled: false, reason: 'not_found' };
    const candidates: BrowserAutofillCandidate[] = summaries.map(item => ({
      id: item.id,
      kind: 'password',
      originUrl: item.originUrl,
      username: item.username,
      ...(item.label ? { label: item.label } : {}),
      preview: item.label ? `${item.username} · ${item.label}` : item.username,
    }));
    const choice = await this.options.chooseCredential(candidates, { frame, kind, intentId });
    if (!choice) return { filled: false, reason: 'cancelled' };
    const selected = candidates.find(item => item.id === choice.candidateId);
    if (!selected) return { filled: false, reason: 'not_found' };
    if (!await this.stillCurrent(frame, generation, topGeneration, revocation)) {
      return { filled: false, reason: 'navigation' };
    }
    const secret = await this.options.store.readPassword(selected.id, 'display', () => true);
    if (secret === null) return { filled: false, reason: 'not_found' };
    if (!await this.stillCurrent(frame, generation, topGeneration, revocation)) {
      return { filled: false, reason: 'navigation' };
    }
    return await this.send(frame, {
      type: 'browser-autofill:fill',
      documentId: frame.documentId,
      frameId: frame.frameId,
      intentId,
      kind: 'password',
      values: { username: selected.username, password: secret },
    });
  }

  private async fillProfile(
    frameId: string,
    kind: BrowserAutofillProfileKind,
    intentId: string,
  ): Promise<BrowserAutofillFillReceipt> {
    const revocationAtStart = this.revocationOf(frameId);
    const frame = await this.currentFrame(frameId);
    if (!frame) return { filled: false, reason: 'not_found' };
    const generation = this.generationOf(frame.frameId);
    const topGeneration = this.topLevelGeneration;
    const revocation = revocationAtStart;
    const summaries = await this.options.store.listAutofillProfiles(kind);
    if (!summaries.length) return { filled: false, reason: 'not_found' };
    const candidates: BrowserAutofillCandidate[] = summaries.map(item => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      preview: item.label,
    }));
    const choice = await this.options.chooseCredential(candidates, {
      frame,
      kind: kind === 'address' ? 'address' : 'contact',
      intentId,
    });
    if (!choice) return { filled: false, reason: 'cancelled' };
    const selected = candidates.find(item => item.id === choice.candidateId);
    if (!selected) return { filled: false, reason: 'not_found' };
    if (!await this.stillCurrent(frame, generation, topGeneration, revocation)) {
      return { filled: false, reason: 'navigation' };
    }
    const profile = await this.options.store.readAutofillProfile(selected.id);
    if (!profile || profile.kind !== kind) return { filled: false, reason: 'not_found' };
    if (!await this.stillCurrent(frame, generation, topGeneration, revocation)) {
      return { filled: false, reason: 'navigation' };
    }
    return await this.send(frame, {
      type: 'browser-autofill:fill',
      documentId: frame.documentId,
      frameId: frame.frameId,
      intentId,
      kind: profile.kind,
      values: { fields: profile.fields },
    });
  }

  private enabled(): boolean {
    if (this.disposed) return false;
    try {
      return this.options.enabled ? this.options.enabled() : true;
    } catch {
      return false;
    }
  }

  private async currentFrame(frameId: string): Promise<BrowserAutofillFrame | null> {
    if (!this.enabled() || !frameId) return null;
    const revocation = this.revocations.get(frameId) ?? 0;
    const topGeneration = this.topLevelGeneration;
    const resolved = await this.options.resolveFrame(frameId);
    if (!this.enabled() || topGeneration !== this.topLevelGeneration || revocation !== (this.revocations.get(frameId) ?? 0)) return null;
    if (!resolved) return null;
    const frame = normalizeFrame(resolved);
    if (!frame) return null;
    const known = this.generations.get(frame.frameId);
    if (known && (known.documentId !== frame.documentId || known.origin !== frame.origin)) {
      this.noteFrame(frame);
    } else if (!known) {
      this.noteFrame(frame);
    }
    return frame;
  }

  private generationOf(frameId: string): number {
    return this.generations.get(frameId)?.generation ?? 0;
  }

  private revocationOf(frameId: string): number {
    return this.revocations.get(frameId) ?? 0;
  }

  private async stillCurrent(
    frame: BrowserAutofillFrame,
    generation: number,
    topGeneration: number,
    revocation: number,
  ): Promise<boolean> {
    if (!this.enabled() || topGeneration !== this.topLevelGeneration) return false;
    if (this.revocationOf(frame.frameId) !== revocation) return false;
    if (this.generationOf(frame.frameId) !== generation) return false;
    const resolved = await this.options.resolveFrame(frame.frameId);
    if (!resolved) return false;
    const next = normalizeFrame(resolved);
    return next !== null
      && next.frameId === frame.frameId
      && next.documentId === frame.documentId
      && next.origin === frame.origin;
  }

  private async send(frame: BrowserAutofillFrame, message: BrowserAutofillFillMessage): Promise<BrowserAutofillFillReceipt> {
    if (!await this.stillCurrent(
      frame,
      this.generationOf(frame.frameId),
      this.topLevelGeneration,
      this.revocationOf(frame.frameId),
    )) {
      return { filled: false, reason: 'navigation' };
    }
    let ack: BrowserAutofillAck | undefined;
    try {
      ack = await this.withAckTimeout(this.options.sendToFrame(frame.frameId, message));
    } catch {
      return { filled: false, reason: 'timeout' };
    }
    if (!ack) return { filled: false, reason: 'timeout' };
    if (ack.documentId !== frame.documentId || ack.intentId !== message.intentId) {
      return { filled: false, reason: 'navigation' };
    }
    return ack.filled ? { filled: true } : { filled: false, reason: ack.reason === 'no_target' ? 'no_target' : 'cancelled' };
  }

  private async withAckTimeout(value: BrowserAutofillAck | Promise<BrowserAutofillAck>): Promise<BrowserAutofillAck | undefined> {
    const timeout = Math.max(1, Math.min(this.options.ackTimeoutMs ?? 1_500, 10_000));
    return new Promise(resolve => {
      let settled = false;
      const finish = (ack: BrowserAutofillAck | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ack);
      };
      const timer = setTimeout(() => finish(undefined), timeout);
      Promise.resolve(value).then(finish, () => finish(undefined));
    });
  }

  private runExclusive(
    frameId: string,
    work: () => Promise<BrowserAutofillFillReceipt>,
  ): Promise<BrowserAutofillFillReceipt> {
    const current = this.inFlight.get(frameId);
    if (current) return current;
    const promise = work().finally(() => {
      if (this.inFlight.get(frameId) === promise) this.inFlight.delete(frameId);
    });
    this.inFlight.set(frameId, promise);
    return promise;
  }
}

function profileKindFor(kind: 'address' | 'contact' | 'email'): BrowserAutofillProfileKind {
  return kind === 'contact' ? 'contact' : 'address';
}

export type { BrowserAutofillProfile };
