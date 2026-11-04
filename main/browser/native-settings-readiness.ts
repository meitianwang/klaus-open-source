import type { NativeManagerSurface } from '../../contracts/browser-settings';
import type { BrowserCdp } from './page-operations';
import { BrowserError } from './types';

const contentTags: Record<NativeManagerSurface, string[]> = {
  passwords: ['passwords-section'],
  autofill: ['settings-autofill-section'],
  extensions: ['extensions-item-list'],
  siteSettings: ['settings-site-settings-page'],
};

/** The document load event precedes the native settings' lazy component mount. */
export async function waitForNativeSettings(
  cdp: BrowserCdp,
  surface: NativeManagerSurface,
  active: () => boolean,
): Promise<void> {
  const tags = JSON.stringify(contentTags[surface]);
  const script = `(() => {
    const tags = new Set(${tags});
    const find = root => {
      for (const element of root.querySelectorAll('*')) {
        if (tags.has(element.localName) && element.shadowRoot?.childElementCount) {
          const candidates = [element, ...element.shadowRoot.querySelectorAll('*')];
          if (candidates.some(candidate => {
            const rect = candidate.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
          })) return true;
        }
        if (element.shadowRoot && find(element.shadowRoot)) return true;
      }
      return false;
    };
    return find(document);
  })()`;
  const deadline = Date.now() + 30_000;
  while (active()) {
    if (await cdp.evaluate(script) === true) return;
    if (Date.now() >= deadline) throw new BrowserError('timeout', 'The native browser settings did not finish rendering.');
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  throw new BrowserError('cancelled', 'The browser management request was superseded.');
}
