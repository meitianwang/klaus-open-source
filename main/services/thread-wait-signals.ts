import type { ClientEvent } from '../engine/protocol';

/**
 * The wake-signal hub behind `wait_threads`.
 *
 * The wait coordinator is event-driven with a fallback tick, and this hub is what
 * supplies the events. Without it a wait would have to poll every target for up to
 * two minutes; with it, the engine's own notifications decide when to look again.
 *
 * Two independent signal kinds, because they mean different things:
 * - `onChange`: something in the ENGINE may have changed a target's state. Fires on
 *   turn terminals and on reverse requests — an approval or elicitation is exactly
 *   what makes a target "needs attention", and it arrives as a reverse request.
 * - `onInput`: a person typed into ONE conversation. Scoped per conversation because
 *   only the waiting conversation's own new input should end its wait; someone typing
 *   into an unrelated chat is not a reason to wake.
 *
 * Listeners are copied before being invoked, so a listener that unsubscribes during
 * its own notification (the common case: the coordinator settles and tears down)
 * cannot skip a sibling or leave the set mutated mid-iteration.
 */
export interface ThreadWaitSignals {
  /** Feed an engine event; relevant ones notify every change listener. */
  engineChanged(event: ClientEvent): void;
  /** A human message was accepted into `rendererId`. */
  input(rendererId: string): void;
  /** Subscribe to engine activity. Returns an unsubscribe. */
  onChange(listener: () => void): () => void;
  /** Subscribe to human input in one conversation. Returns an unsubscribe. */
  onInput(rendererId: string, listener: () => void): () => void;
  /** Diagnostics: live listener counts, so a leak is observable in tests. */
  listenerCounts(): { change: number; input: number };
}

/**
 * Engine events that can move a target toward "complete or needs attention".
 *
 * `reverseRequest` matters most: a target parked on an approval is the actionable
 * case the whole tool exists to surface, and nothing else announces it.
 * `thread/status/changed` is listed for forward compatibility — the engine does not
 * emit it today, so waits currently rely on turn terminals, reverse requests and the
 * fallback tick. Keeping the name here is what makes a future engine addition take
 * effect without a host change.
 */
const RELEVANT_PRODUCT_EVENTS = ['turn/failed', 'thread/status/changed'] as const;

function isRelevant(event: ClientEvent): boolean {
  if (event.type === 'turnCompleted' || event.type === 'threadDeleted' || event.type === 'reverseRequest') return true;
  return event.type === 'productEvent' && (RELEVANT_PRODUCT_EVENTS as readonly string[]).includes(event.method);
}

export function createThreadWaitSignals(): ThreadWaitSignals {
  const changeListeners = new Set<() => void>();
  const inputListeners = new Map<string, Set<() => void>>();
  return {
    engineChanged(event: ClientEvent): void {
      if (!isRelevant(event) || changeListeners.size === 0) return;
      for (const listener of [...changeListeners]) listener();
    },
    input(rendererId: string): void {
      const listeners = inputListeners.get(rendererId);
      if (!listeners?.size) return;
      for (const listener of [...listeners]) listener();
    },
    onChange(listener: () => void): () => void {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },
    onInput(rendererId: string, listener: () => void): () => void {
      const existing = inputListeners.get(rendererId);
      const listeners = existing ?? new Set<() => void>();
      if (!existing) inputListeners.set(rendererId, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        // Drop the bucket entirely once empty: waits come and go constantly, and
        // keeping an empty set per conversation would grow without bound.
        if (listeners.size === 0 && inputListeners.get(rendererId) === listeners) inputListeners.delete(rendererId);
      };
    },
    listenerCounts(): { change: number; input: number } {
      let input = 0;
      for (const listeners of inputListeners.values()) input += listeners.size;
      return { change: changeListeners.size, input };
    },
  };
}
