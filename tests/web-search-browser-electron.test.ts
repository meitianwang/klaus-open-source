// Compile with npm --prefix apps/desktop run build, then launch with:
// KLAUS_ENGINE_BINARY=/absolute/path/klaus-agent-stdio node apps/desktop/dist/tests/web-search-browser-electron.test.js
// Add KLAUS_SEARCH_BROWSER_LIVE=1 to use the actual Bing site instead of fixture HTML.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const { assertElectronGuiAvailable, spawnElectronGui } = require('../../scripts/electron-test-preflight.cjs') as typeof import('../scripts/electron-test-preflight.cjs');

assertElectronGuiAvailable();
const executable = require('electron') as string;
const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary || !existsSync(binary)) throw new Error('KLAUS_ENGINE_BINARY must name the real engine binary to validate.');
const live = process.env.KLAUS_SEARCH_BROWSER_LIVE === '1';
const directory = resolve(process.env.KLAUS_SEARCH_BROWSER_LOG_DIR || join(__dirname, '../search-browser-logs', new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(directory, { recursive: true });
rmSync(join(directory, 'result.json'), { force: true });
const profile = mkdtempSync(join(directory, 'profile-'));
const fixture = join(__dirname, 'web-search-browser-fixture.js'), output = join(directory, 'run.log');
const env: NodeJS.ProcessEnv = { ...process.env, KLAUS_ENGINE_BINARY: resolve(binary), KLAUS_SEARCH_BROWSER_PROFILE: profile, KLAUS_SEARCH_BROWSER_LOG_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
appendFileSync(output, `$ ${executable} ${fixture}\nKLAUS_ENGINE_BINARY=${resolve(binary)}\nMODE=${live ? 'live' : 'deterministic'}\n`);
const child = spawnElectronGui(executable, [fixture], { env, cwd: dirname(fixture), stdio: ['ignore', 'pipe', 'pipe'] });
const record = (chunk: Buffer): void => { appendFileSync(output, chunk); process.stdout.write(chunk); };
child.stdout.on('data', record); child.stderr.on('data', record);
let forced: ReturnType<typeof setTimeout> | undefined;
const timer = setTimeout(() => {
  appendFileSync(output, 'Fixture exceeded 150 seconds; requesting shutdown.\n');
  child.kill('SIGTERM'); forced = setTimeout(() => child.kill('SIGKILL'), 10_000);
}, 150_000);
child.once('error', error => { appendFileSync(output, String(error) + '\n'); process.stderr.write(String(error) + '\n'); });
child.once('close', (code, signal) => {
  clearTimeout(timer); if (forced) clearTimeout(forced);
  rmSync(profile, { recursive: true, force: true });
  let complete = false;
  try {
    const report = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')) as { passed?: number; failed?: number; suite?: string };
    complete = report.suite === (live ? 'web-search-browser-live' : 'web-search-browser-electron') && report.failed === 0 && report.passed === (live ? 1 : 5);
  } catch { /* Missing or malformed reports never count as a successful gate. */ }
  const status = code === 0 && !signal && complete ? 0 : 1;
  appendFileSync(output, `EXIT_CODE=${status}\nPROFILE_REMOVED=${!existsSync(profile)}\n`);
  process.stdout.write(`Search browser logs: ${directory}\n`);
  if (signal) process.stderr.write(`Search browser fixture terminated by ${signal}\n`);
  process.exit(status);
});
