import type { VoiceChatSnapshot } from '../voice-chat-controller';
import type { VoiceChatViewDependencies } from './view';

type Dependencies = Pick<VoiceChatViewDependencies, 'currentSession' | 'inChat' | 'hasDraft' | 'canStart' | 'sendButton' | 'taskStatus'>;

/** Only presentation changes can invalidate the voice controls. */
export function voiceChatPresentation(snapshot: VoiceChatSnapshot, deps: Dependencies, supported: boolean) {
  const sessionId = deps.currentSession();
  const matching = snapshot.open && (snapshot.targetSessionId ?? null) === sessionId && deps.inChat();
  const hasDraft = deps.hasDraft();
  const occupied = deps.sendButton.classList.contains('busy') || deps.sendButton.classList.contains('continue');
  const launch = !snapshot.open && supported && !hasDraft && !occupied && deps.canStart();
  const showingControls = matching && snapshot.phase !== 'error';
  const taskStatus = matching && deps.taskStatus ? deps.taskStatus() : null;
  return { matching, hasDraft, launch, showingControls, taskStatus,
    key: JSON.stringify([sessionId, matching, hasDraft, launch, showingControls, taskStatus]) };
}
