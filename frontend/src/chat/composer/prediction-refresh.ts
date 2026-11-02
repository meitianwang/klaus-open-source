import type { PredictionSession } from './predictions';

interface StreamRegistry {
  engineStatus: string;
  sessions: Record<string, { running: boolean } | undefined>;
}

interface RegistrySubscription {
  subscribe(listener: (state: StreamRegistry, previous: StreamRegistry) => void): () => void;
}

/** Stream content and unrelated sessions do not invalidate prediction inputs. */
export function subscribePredictionRefresh(store: RegistrySubscription, deps: {
  currentSessionId(): string | null | undefined;
  session(): PredictionSession | null;
  invalidate(sessionId: string): void;
  refresh(): unknown;
}): () => void {
  let previousSource = deps.session(), queued = false, disposed = false;
  const unsubscribe = store.subscribe((state, previous) => {
    for (const [id, stream] of Object.entries(state.sessions)) {
      if (stream?.running && !previous.sessions[id]?.running) deps.invalidate(id);
    }
    const id = deps.currentSessionId() || '';
    const current = state.sessions[id], before = previous.sessions[id];
    if (state.engineStatus === previous.engineStatus
      && (current === before || current?.running && before?.running)) return;
    const source = deps.session();
    if (source?.sessionId === previousSource?.sessionId && Object.is(source?.sourceRevision, previousSource?.sourceRevision)) return;
    previousSource = source;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) void deps.refresh();
    });
  });
  return () => { disposed = true; unsubscribe(); };
}
