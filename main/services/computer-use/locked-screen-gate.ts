/**
 * Decides whether Computer Use must be refused because the screen is locked.
 *
 * Only a turn that was started from the phone is affected: a person sitting at
 * the desktop can still drive apps after unlocking, and a locally started turn
 * is never gated here.
 */
export interface LockedScreenGateInput {
  /** The system reports the screen as locked right now. */
  locked: boolean;
  /** The user allowed locked-screen control in Remote Control settings. */
  allowed: boolean;
  /** The session's current turn was started from the phone. */
  remoteOrigin: boolean;
}

export const LOCKED_SCREEN_REFUSAL =
  'Computer Use is paused while the screen is locked. Enable locked-screen control in Remote Control settings to allow it.';

export function lockedScreenRefusal(input: LockedScreenGateInput): string | undefined {
  if (!input.locked || input.allowed || !input.remoteOrigin) return undefined;
  return LOCKED_SCREEN_REFUSAL;
}
