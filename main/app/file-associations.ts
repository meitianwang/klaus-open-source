import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const SYSTEM_ASSOCIATED_EXTENSIONS: readonly string[] = [
  'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'wps', 'wpt', 'odt', 'rtf',
  'xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xltm', 'et', 'ett', 'ods', 'csv', 'tsv',
  'ppt', 'pptx', 'pptm', 'pot', 'potx', 'potm', 'pps', 'ppsx', 'ppsm', 'dps', 'dpt', 'odp',
  'xmind', 'pdf',
  'md', 'markdown', 'mdown', 'mkd', 'txt', 'log', 'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'conf',
  'html', 'htm', 'xhtml', 'svg', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'sh', 'sql',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'mp4', 'webm', 'mov', 'm4v', 'ogv', '3gp', 'mkv', 'avi', 'wmv', 'flv',
  'zip',
];

const MAC_LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export interface SystemFileAssociationOptions {
  packaged: boolean;
  platform: NodeJS.Platform;
  appVersion: string;
  executablePath: string;
  productName: string;
  applicationId: string;
  configRoot: string;
}

export function macBundleRootFromExecutable(executablePath: string): string | null {
  const normalized = resolve(executablePath);
  const macosDir = dirname(normalized);
  const contentsDir = dirname(macosDir);
  const bundleDir = dirname(contentsDir);
  if (basename(macosDir) === 'MacOS' && basename(contentsDir) === 'Contents' && bundleDir.endsWith('.app')) {
    return bundleDir;
  }
  return null;
}

export function buildWindowsAssociationRegistryCommands(options: {
  executablePath: string;
  productName: string;
  applicationId: string;
  extensions?: readonly string[];
}): string[][] {
  const exePath = options.executablePath;
  const exeName = basename(exePath);
  const progId = `${options.applicationId}.File`;
  const openCommand = `"${exePath}" "%1"`;
  const exts = options.extensions ?? SYSTEM_ASSOCIATED_EXTENSIONS;
  const commands: string[][] = [
    ['add', `HKCU\\Software\\Classes\\${progId}`, '/ve', '/t', 'REG_SZ', '/d', `${options.productName} Document`, '/f'],
    ['add', `HKCU\\Software\\Classes\\${progId}\\DefaultIcon`, '/ve', '/t', 'REG_SZ', '/d', `"${exePath}",0`, '/f'],
    ['add', `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', openCommand, '/f'],
    ['add', `HKCU\\Software\\Classes\\Applications\\${exeName}`, '/v', 'FriendlyAppName', '/t', 'REG_SZ', '/d', options.productName, '/f'],
    ['add', `HKCU\\Software\\Classes\\Applications\\${exeName}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', openCommand, '/f'],
    ['add', `HKCU\\Software\\Classes\\Directory\\shell\\${options.applicationId}`, '/ve', '/t', 'REG_SZ', '/d', `Open with ${options.productName}`, '/f'],
    ['add', `HKCU\\Software\\Classes\\Directory\\shell\\${options.applicationId}`, '/v', 'Icon', '/t', 'REG_SZ', '/d', `"${exePath}",0`, '/f'],
    ['add', `HKCU\\Software\\Classes\\Directory\\shell\\${options.applicationId}\\command`, '/ve', '/t', 'REG_SZ', '/d', openCommand, '/f'],
  ];
  for (const ext of exts) {
    const clean = ext.replace(/^\.+/, '').toLowerCase();
    if (!clean) continue;
    commands.push(['add', `HKCU\\Software\\Classes\\.${clean}\\OpenWithProgids`, '/v', progId, '/t', 'REG_NONE', '/f']);
    commands.push(['add', `HKCU\\Software\\Classes\\Applications\\${exeName}\\SupportedTypes`, '/v', `.${clean}`, '/t', 'REG_SZ', '/d', '', '/f']);
  }
  return commands;
}

function runExecFile(command: string, args: readonly string[], timeoutMs = 10_000): Promise<boolean> {
  return new Promise(resolvePromise => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, error => {
      resolvePromise(!error);
    });
  });
}

export async function ensureSystemFileAssociations(options: SystemFileAssociationOptions): Promise<boolean> {
  if (!options.packaged || process.env.KLAUS_TEST === '1') return false;
  const stampPath = join(options.configRoot, '.file-associations-v1.json');
  try {
    if (existsSync(stampPath)) {
      const existing = JSON.parse(readFileSync(stampPath, 'utf8')) as { version?: string; executablePath?: string; platform?: string };
      if (existing.version === options.appVersion && existing.executablePath === options.executablePath && existing.platform === options.platform) {
        return true;
      }
    }
  } catch {
    // Re-register when the stamp cannot be read.
  }

  let ok = false;
  if (options.platform === 'darwin') {
    const bundle = macBundleRootFromExecutable(options.executablePath);
    if (bundle && existsSync(MAC_LSREGISTER)) {
      ok = await runExecFile(MAC_LSREGISTER, ['-f', bundle]);
    }
  } else if (options.platform === 'win32') {
    const regExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    const commands = buildWindowsAssociationRegistryCommands({
      executablePath: options.executablePath,
      productName: options.productName,
      applicationId: options.applicationId,
    });
    ok = true;
    for (const args of commands) {
      const stepOk = await runExecFile(regExe, args, 5_000);
      if (!stepOk) ok = false;
    }
  } else {
    return false;
  }

  if (ok) {
    try {
      mkdirSync(options.configRoot, { recursive: true });
      writeFileSync(stampPath, JSON.stringify({
        version: options.appVersion,
        executablePath: options.executablePath,
        platform: options.platform,
        updatedAt: new Date().toISOString(),
      }));
    } catch {
      // Non-fatal: registration already completed.
    }
  }
  return ok;
}
