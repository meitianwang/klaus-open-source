// This function is serialized into the shell's main world. Keep it self-contained.
export function installPresentationHost(): void {
  const hostCaps = 'comment-summon summon-into-chat context-send vouched-send';
  const page = globalThis as unknown as {
    location: { protocol: string; host: string; pathname: string; origin: string };
    document: {
      documentElement?: { dataset: Record<string, string | undefined> } | null;
      addEventListener(name: string, callback: () => void, options?: { once?: boolean }): void;
      querySelectorAll(selector: string): Iterable<{ contentWindow: unknown; src: string }>;
    };
    addEventListener(name: string, callback: (event: {
      origin: string;
      source: unknown;
      data: {
        __frame_chrome_report?: boolean;
        snapshot?: unknown;
        __klausPptChatResult?: boolean;
        id?: string | number;
        result?: unknown;
        __frame_chrome_state?: boolean;
        state?: string;
        uuid?: string;
        thread?: string | null;
        commentId?: string;
        comment?: string;
        anchor?: unknown;
        source?: string;
      };
    }) => void): void;
    postMessage(value: unknown, origin: string): void;
    __klausPresentationReport?: unknown;
  };
  const applyHostCaps = () => {
    if (page.document.documentElement && !page.document.documentElement.dataset.hostcaps) {
      page.document.documentElement.dataset.hostcaps = hostCaps;
    }
  };
  applyHostCaps();
  page.document.addEventListener('DOMContentLoaded', applyHostCaps, { once: true });
  const id = page.location.pathname.split('/').at(-1);
  const origin = `${page.location.protocol}//${id}.ppt-content`;
  const pending = new Map<string, { resolve(value: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  const sendChatRequest = (payload: unknown): Promise<unknown> => new Promise(resolve => {
    const requestId = `presentation-chat-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(requestId); resolve({ ok: false, error: 'The presentation chat did not answer.' }); }, 65_000);
    pending.set(requestId, { resolve, timer });
    page.postMessage({ __klausPptChat: true, id: requestId, payload }, page.location.origin);
  });
  Object.defineProperty(page, 'klausPresentationChrome', { value: Object.freeze({ roomSendTarget: () => 'pane' }), configurable: false, writable: false });
  Object.defineProperty(page, 'klausPresentationChatRequest', { configurable: false, writable: false, value: sendChatRequest });
  page.addEventListener('message', event => {
    if (event.source === page && event.origin === page.location.origin && event.data?.__klausPptChatResult === true && typeof event.data.id === 'string') {
      const request = pending.get(event.data.id);
      if (request) { pending.delete(event.data.id); clearTimeout(request.timer); request.resolve(event.data.result); }
      return;
    }
    if (event.source === page && event.origin === page.location.origin && event.data?.__frame_chrome_state === true && event.data.state === 'comment_summon' && typeof event.data.uuid === 'string') {
      const handoffId = typeof event.data.id === 'number' && Number.isInteger(event.data.id) && event.data.id >= 0 ? event.data.id : undefined;
      const summonUuid = event.data.uuid;
      void sendChatRequest({
        uuid: summonUuid,
        deliver: 'send',
        senderActivated: true,
        data: {
          kind: 'comment_summon',
          ...(handoffId !== undefined ? { handoffId } : {}),
          threadId: typeof event.data.thread === 'string' ? event.data.thread : null,
          ...(typeof event.data.commentId === 'string' ? { commentId: event.data.commentId } : {}),
          comment: typeof event.data.comment === 'string' ? event.data.comment : '',
          ...(event.data.anchor && typeof event.data.anchor === 'object' ? { anchor: event.data.anchor } : {}),
          ...(typeof event.data.source === 'string' ? { source: event.data.source } : {}),
        },
      }).then(outcome => {
        if (handoffId === undefined) return;
        const ok = Boolean(outcome && typeof outcome === 'object' && (outcome as { ok?: unknown }).ok === true);
        page.postMessage(
          ok
            ? { __frame_chrome: true, cmd: 'comment_summon_result', id: handoffId, uuid: summonUuid, ok: true }
            : { __frame_chrome: true, cmd: 'comment_summon_result', id: handoffId, uuid: summonUuid, ok: false, reason: 'send_rejected' },
          page.location.origin,
        );
      });
      return;
    }
    if (event.origin !== origin || ![...page.document.querySelectorAll('iframe')].some(frame => frame.contentWindow === event.source && frame.src.startsWith(origin + '/'))) return;
    if (event.data?.__frame_chrome_report === true) page.__klausPresentationReport = event.data.snapshot ?? null;
  });
}
