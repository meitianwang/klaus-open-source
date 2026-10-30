import { posix } from 'node:path';

/** @typedef {{ type: string, fileName: string, source?: string | Uint8Array }} BundledFile */

/**
 * Every emitted font URL must resolve to a nonempty asset on the app origin.
 * @param {Record<string, BundledFile>} bundle
 * @returns {{ stylesheets: number, fonts: number }}
 */
export function assertSelfHostedFontAssets(bundle) {
  let stylesheets = 0;
  const fonts = new Set();
  for (const asset of Object.values(bundle)) {
    if (asset.type !== 'asset' || !asset.fileName.endsWith('.css') || asset.source === undefined) continue;
    stylesheets++;
    const css = typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
    for (const face of css.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
      for (const source of face[0].matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)) {
        const url = (source[1] ?? source[2] ?? source[3] ?? '').trim();
        if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) {
          throw new Error(`${asset.fileName}: font URL violates font-src 'self'`);
        }
        const path = decodeURIComponent(url.split(/[?#]/, 1)[0]);
        const fileName = posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(asset.fileName), path));
        const font = bundle[fileName];
        if (!font || font.type !== 'asset' || !font.source?.length) {
          throw new Error(`${asset.fileName}: font asset ${fileName} is missing or empty`);
        }
        fonts.add(fileName);
      }
    }
  }
  return { stylesheets, fonts: fonts.size };
}
