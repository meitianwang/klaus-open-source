import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export type McpOAuthCode = { kind: 'code'; code: string; state: string } | { kind: 'decline'; reason: string };
export function safeAuthorizationUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('Unsafe OAuth URL');
  return url;
}
export function safeLoopbackRedirect(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || Number(url.port) <= 0 || url.username || url.password || url.hash || url.search) throw new Error('Unsafe OAuth redirect');
  return url;
}

/** One bounded listener; every non-code outcome has an explicit decline reason. */
export async function captureMcpOAuthCode(authorizationUrl: string, redirectUri: string, signal: AbortSignal, openExternal: (url: string) => Promise<void>, timeoutMs = 300_000): Promise<McpOAuthCode> {
  let authorization: URL, redirect: URL;
  try { authorization = safeAuthorizationUrl(authorizationUrl); redirect = safeLoopbackRedirect(redirectUri); }
  catch { return { kind: 'decline', reason: 'rust_mcp_oauth_redirect_invalid' }; }
  const expected = authorization.searchParams.get('state');
  if (!expected || authorization.searchParams.getAll('state').length !== 1) return { kind: 'decline', reason: 'rust_mcp_oauth_state_missing' };
  if (signal.aborted) return { kind: 'decline', reason: 'rust_mcp_oauth_cancelled' };
  const listener = createServer({ maxHeaderSize: 8192 });
  let settle!: (result: McpOAuthCode) => void;
  const finished = new Promise<McpOAuthCode>(resolve => { settle = resolve; });
  const decline = (reason: string): void => settle({ kind: 'decline', reason });
  const cancel = (): void => decline('rust_mcp_oauth_cancelled');
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => decline('rust_mcp_oauth_timeout'), timeoutMs);
  listener.headersTimeout = Math.min(timeoutMs, 10_000); listener.requestTimeout = Math.min(timeoutMs, 10_000);
  listener.on('request', (request, response) => {
    const reply = (status: number, text: string): void => { response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }); response.end(text); };
    let callback: URL; try { callback = new URL(request.url ?? '/', redirect); } catch { reply(404, 'Not found'); return; }
    if (request.method !== 'GET' || callback.pathname !== redirect.pathname) { reply(404, 'Not found'); return; }
    const state = callback.searchParams.get('state') ?? '', actualBytes = Buffer.from(state), expectedBytes = Buffer.from(expected);
    if (callback.searchParams.getAll('state').length !== 1 || actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      reply(400, 'OAuth state mismatch'); decline('rust_mcp_oauth_state_mismatch'); return;
    }
    const code = callback.searchParams.get('code');
    if (!code || callback.searchParams.getAll('code').length !== 1 || callback.searchParams.has('error')) {
      reply(400, 'OAuth authorization code missing'); decline(callback.searchParams.has('error') ? 'rust_mcp_oauth_declined' : 'rust_mcp_oauth_code_missing'); return;
    }
    reply(200, 'Authorization completed. You can close this window.'); settle({ kind: 'code', code, state });
  });
  try {
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(Number(redirect.port), '127.0.0.1', () => { listener.off('error', reject); resolve(); }); });
    listener.on('error', () => decline('rust_mcp_oauth_listener_failed'));
    if (signal.aborted) cancel();
    else void Promise.resolve().then(() => openExternal(authorizationUrl)).catch(() => decline('rust_mcp_oauth_browser_open_failed'));
    return await finished;
  } catch { return { kind: 'decline', reason: 'rust_mcp_oauth_listener_failed' }; }
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancel);
    await new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
  }
}
