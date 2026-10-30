import type { Json } from '../../ipc/contract';

export const REDACTED = '[redacted: credentials are not shown to the agent]';
export function isSecretField(name: string): boolean {
  const flat = name.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return ['env', 'environment', 'headers', 'clientidentity', 'xcursorchecksum', 'verifier', 'codeverifier'].includes(flat)
    || ['apikey', 'accesskey', 'secretkey', 'secret', 'password', 'passphrase', 'credential', 'authorization', 'privatekey', 'cookie', 'token'].some(key => flat.includes(key));
}
function looksSecret(value: string): boolean {
  return /^(?:sk[-_]|ghp_|gho_|github_pat_|xox[bp]-|Bearer\s|AKIA)/iu.test(value)
    || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(value);
}
function safeString(value: string, depth: number): string {
  if (looksSecret(value)) return REDACTED;
  if (depth < 20 && /^[\s]*[\[{]/u.test(value)) {
    try { return JSON.stringify(redact(JSON.parse(value), false, depth + 1)); } catch { /* Not a serialized object. */ }
  }
  const assignment = /^(--?[a-zA-Z][a-zA-Z0-9_-]*=)(.*)$/u.exec(value);
  if (assignment && isSecretField(assignment[1]!)) return assignment[1] + REDACTED;
  // URLs can carry a password or a bearer token without a credential-named parent.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    try {
      const url = new URL(value); let changed = false;
      if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
      for (const key of [...url.searchParams.keys()]) if (isSecretField(key)) { url.searchParams.set(key, REDACTED); changed = true; }
      if (changed) return url.toString();
    } catch { /* The ordinary result renderer can describe an invalid URL. */ }
  }
  // A server command or failure may embed a header/assignment in an ordinary string.
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, REDACTED)
    .replace(/\b(?:sk[-_]|ghp_|gho_|github_pat_|xox[bp]-)[A-Za-z0-9_-]+/gu, REDACTED)
    .replace(/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Cursor-Checksum)\s*:[^\r\n]*/giu, REDACTED)
    .replace(/(^|\s)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&]+)/gu,
      (matched, prefix: string, key: string, equal: string) => isSecretField(key) ? `${prefix}${key}${equal}${REDACTED}` : matched);
}
/** String credentials are removed; numeric usage counters and empty configuration stay readable. */
export function redact(value: Json, inherited = false, depth = 0): Json {
  if (depth > 40) return '[truncated: nested data limit]';
  if (typeof value === 'string') return value && inherited ? REDACTED : safeString(value, depth);
  if (Array.isArray(value)) {
    let previousFlag = false;
    return value.map(item => {
      const secret = inherited || previousFlag;
      previousFlag = typeof item === 'string' && /^--?[a-zA-Z]/u.test(item) && !item.includes('=') && isSecretField(item);
      return redact(item, secret, depth + 1);
    });
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child, inherited || isSecretField(key), depth + 1)]));
  return value;
}
export function boundedText(text: string, limit = 24_000): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const bytes = Buffer.from(text); let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + `\n\n… truncated (${end} of ${bytes.length} bytes shown). Narrow the request for more.`;
}
export function renderResult(channel: string, value: Json): string {
  return value === null ? `${channel}: ok (no content)` : boundedText(JSON.stringify(redact(value), null, 2));
}
