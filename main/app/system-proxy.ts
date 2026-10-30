import { session } from 'electron';

/**
 * Applies the operating system's proxy to every Electron session.
 *
 * Node's fetch (and Chromium's default network service config) does not read the
 * Windows Internet Settings proxy, so a host that requires a proxy to reach the
 * subscription backends (chatgpt.com, claude.ai) would otherwise hang on a direct
 * connection and surface as an unavailable model catalog. Routing through the system
 * proxy is what makes those backends reachable on a proxied machine, so this applies
 * it without any manual flag.
 *
 * The function is best-effort: it only touches Windows, only when a manual proxy is
 * enabled, and only sets a PAC-equivalent Chromium config derived from that proxy.
 * Failures are reported to the log so a broken proxy rule never blocks startup.
 */
export async function configureSystemProxy(
  platform: NodeJS.Platform,
  log: (line: string) => void,
): Promise<{ applied: boolean; proxy?: string }> {
  if (platform !== 'win32') return { applied: false };
  let proxyServer = '';
  try {
    // Read HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings via reg.exe
    // so no native dependency is needed. Both values live under the same key.
    const { execFile } = await import('node:child_process');
    const query = (name: string): Promise<string> => new Promise(resolve => {
      execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name],
        { windowsHide: true }, (error, stdout) => {
          if (error) return resolve('');
          const line = String(stdout).split(/\r?\n/).find(row => row.trim().startsWith(name));
          resolve(line ? line.trim().split(/\s+/).slice(2).join(' ').trim() : '');
        });
    });
    const enabled = await query('ProxyEnable');
    if (!/0x1/i.test(enabled)) return { applied: false };
    proxyServer = await query('ProxyServer');
    if (!proxyServer) return { applied: false };
  } catch (error) {
    log(`system-proxy lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return { applied: false };
  }

  // Chromium wants scheme=host:port pairs separated by ';'. The registry value may
  // already carry per-protocol entries ("http=...;https=...") or a single "host:port".
  const rules = proxyServer.includes('=')
    ? proxyServer
    : `http=${proxyServer};https=${proxyServer}`;
  try {
    await session.defaultSession.setProxy({ proxyRules: rules, proxyBypassRules: '<-loopback>' });
    log(`system-proxy applied from Windows Internet Settings (${rules})`);
    return { applied: true, proxy: rules };
  } catch (error) {
    log(`system-proxy apply failed: ${error instanceof Error ? error.message : String(error)}`);
    return { applied: false };
  }
}
