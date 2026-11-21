// Shared constants and pure argument normalization for the bundled headless
// Chromium browser surface exposed through KLAUS_BROWSER_EXECUTABLE.

export const HEADLESS_BROWSER_FLAG = '--klaus-headless-browser';
export const HEADLESS_DEVTOOLS_PREFIX = 'KLAUS_OUTER_DEVTOOLS=';

const VALUE_SWITCHES = new Set(['--user-data-dir', '--remote-debugging-port']);
const IGNORED_SWITCHES = new Set(['--headless', '--remote-debugging-pipe', '--no-zygote', '--single-process']);

export interface NormalizedHeadlessArgs {
  pipeMode: boolean;
  electronArgs: string[];
  userDataDir?: string;
}

/** Whether the current Electron process was started as an isolated headless browser. */
export function headlessBrowserRequested(argv: readonly string[] = process.argv): boolean {
  return argv.includes(HEADLESS_BROWSER_FLAG);
}

/**
 * Translate standard Chromium automation arguments (Puppeteer, Remotion,
 * Playwright) into switches compatible with an isolated hidden Electron
 * browser instance.
 */
export function normalizeHeadlessBrowserArgs(rawArgs: readonly string[]): NormalizedHeadlessArgs {
  const pipeMode = rawArgs.includes('--remote-debugging-pipe');
  const electronArgs: string[] = [];
  let userDataDir: string | undefined;
  let hasDebuggingPort = false;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]!;
    if (!arg.startsWith('--')) continue;
    if (IGNORED_SWITCHES.has(arg) || arg.startsWith('--headless=')) continue;
    if (arg === HEADLESS_BROWSER_FLAG) continue;

    if (VALUE_SWITCHES.has(arg)) {
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        i += 1;
        if (arg === '--user-data-dir') userDataDir = next;
        if (arg === '--remote-debugging-port') hasDebuggingPort = true;
        electronArgs.push(`${arg}=${next}`);
      }
      continue;
    }

    if (arg.startsWith('--user-data-dir=')) {
      userDataDir = arg.slice('--user-data-dir='.length);
    } else if (arg.startsWith('--remote-debugging-port=')) {
      hasDebuggingPort = true;
    }
    electronArgs.push(arg);
  }

  if (!hasDebuggingPort) electronArgs.push('--remote-debugging-port=0');
  return { pipeMode, electronArgs, userDataDir };
}
