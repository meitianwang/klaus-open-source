// This function is serialized into the shell's main world. Keep it self-contained.
export function installPresentationHost(): void {
  const page = globalThis as unknown as {
    location: { protocol: string; host: string; pathname: string; origin: string };
    document: { querySelectorAll(selector: string): Iterable<{ contentWindow: unknown; src: string }> };
    addEventListener(name: string, callback: (event: { origin: string; source: unknown; data: { __frame_chrome_report?: boolean; snapshot?: unknown; __klausPptChatResult?: boolean; id?: string; result?: unknown } }) => void): void;
    postMessage(value: unknown, origin: string): void;
    __klausPresentationReport?: unknown;
  };
  const id = page.location.pathname.split('/').at(-1);
  const origin = `${page.location.protocol}//${id}.ppt-content`;
  const pending = new Map<string, { resolve(value: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  Object.defineProperty(page, 'klausPresentationChrome', { value: Object.freeze({ roomSendTarget: () => 'pane' }), configurable: false, writable: false });
  Object.defineProperty(page, 'klausPresentationChatRequest', { configurable: false, writable: false, value: (payload: unknown) => new Promise(resolve => {
    const requestId = `presentation-chat-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(requestId); resolve({ ok: false, error: 'The presentation chat did not answer.' }); }, 65_000);
    pending.set(requestId, { resolve, timer });
    page.postMessage({ __klausPptChat: true, id: requestId, payload }, page.location.origin);
  }) });
  page.addEventListener('message', event => {
    if (event.source === page && event.origin === page.location.origin && event.data?.__klausPptChatResult === true && typeof event.data.id === 'string') {
      const request = pending.get(event.data.id);
      if (request) { pending.delete(event.data.id); clearTimeout(request.timer); request.resolve(event.data.result); }
      return;
    }
    if (event.origin !== origin || ![...page.document.querySelectorAll('iframe')].some(frame => frame.contentWindow === event.source && frame.src.startsWith(origin + '/'))) return;
    if (event.data?.__frame_chrome_report === true) page.__klausPresentationReport = event.data.snapshot ?? null;
  });
}
