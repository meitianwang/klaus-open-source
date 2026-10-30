#!/usr/bin/env node
// Official Chrome for Testing is a test cache, never an application resource.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' }, version: { type: 'string' }, platform: { type: 'string' } } });
const platform = values.platform ?? ({ 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'win32-x64': 'win64' })[`${process.platform}-${process.arch}`];
if (!['mac-arm64', 'mac-x64', 'win64'].includes(platform)) throw new Error('This test cache supports macOS arm64/x64 and Windows x64');
if (values.version && !/^\d+\.\d+\.\d+\.\d+$/.test(values.version)) throw new Error('Expected a complete Chrome for Testing version');
let version = values.version;
if (!version) {
  const response = await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Chrome metadata HTTP ${response.status}`);
  const selected = (await response.json()).channels.Stable;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(selected?.version)) throw new Error('The official stable Chrome release is unavailable');
  version = selected.version;
  if (selected.downloads.chrome.find(item => item.platform === platform)?.url !== `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`) throw new Error('Unexpected official Chrome download location');
}
const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`;
const root = resolve(values.out ?? `dist/tests/chrome-cache/${version}`);
mkdirSync(root, { recursive: true });
const archive = join(root, `chrome-${platform}.zip`);
const executable = join(root, `chrome-${platform}`, platform === 'win64' ? 'chrome.exe' : 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const receiptPath = join(root, `chrome-${platform}.json`);
const digest = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
function prepareSandboxPermissions() {
  if (process.platform !== 'win32' || platform !== 'win64') return;
  // Chromium's AppContainer needs read/execute access to the public runtime.
  // Scope this to the downloaded cache, never to a profile or the checkout.
  execFileSync('icacls.exe', [join(root, 'chrome-win64'), '/grant', '*S-1-15-2-1:(OI)(CI)(RX)'], { windowsHide: true });
}
if (existsSync(archive) && existsSync(executable) && existsSync(receiptPath)) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.url !== url || receipt.sha256 !== await digest(archive)) throw new Error('The existing test cache does not match its download receipt');
  prepareSandboxPermissions();
  console.log(JSON.stringify({ ...receipt, executable, cacheReused: true }));
} else {
  const downloaded = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!downloaded.ok || !downloaded.body) throw new Error(`Chrome archive HTTP ${downloaded.status}`);
  const temporary = `${archive}.downloading`;
  try {
    await pipeline(Readable.fromWeb(downloaded.body), createWriteStream(temporary, { flags: 'wx' }));
    const sha256 = await digest(temporary);
    if (process.platform === 'win32') {
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      // Expand-Archive requires a .zip extension; the download is complete now.
      const { renameSync } = await import('node:fs'); renameSync(temporary, archive);
      const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(root)} -Force`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { stdio: 'inherit', windowsHide: true });
    } else {
      const { renameSync } = await import('node:fs'); renameSync(temporary, archive);
      execFileSync('/usr/bin/ditto', ['-x', '-k', archive, root], { stdio: 'inherit' });
    }
    if (!existsSync(executable)) throw new Error('The official archive has no expected Chrome executable');
    prepareSandboxPermissions();
    const receipt = { purpose: 'Reusable official browser fixture cache; do not ship', version, platform, url, sha256 };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify({ ...receipt, executable, cacheReused: false }));
  } finally { rmSync(temporary, { force: true }); }
}
