import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Computer Use Windows x64 helper on Windows x64');
const directory = dirname(fileURLToPath(import.meta.url)), repo = resolve(directory, '../..');
const output = resolve(process.argv[2] ?? join(directory, '../artifacts/computer-use/win32-x64'));
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(output, '.build-')), source = join(directory, 'windows-helper.cpp');
const applicationManifest = join(directory, 'windows-helper.manifest');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = () => sha(Buffer.concat([readFileSync(source), readFileSync(applicationManifest), readFileSync(fileURLToPath(import.meta.url))]));
const sourceSha256 = fingerprint();
try {
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const tools = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
  if (!tools || /[\r\n"%]/.test(tools)) throw new Error('The installed Visual C++ toolchain path is invalid');
  const environmentScript = join(temporary, 'environment.cmd');
  writeFileSync(environmentScript, `@echo off\r\ncall "${join(tools, 'Common7/Tools/VsDevCmd.bat')}" -no_logo -arch=x64 -host_arch=x64 >nul\r\nif errorlevel 1 exit /b 1\r\nset\r\n`);
  const environment = execFileSync('cmd.exe', ['/d', '/c', environmentScript], { encoding: 'utf8' });
  const env = { ...process.env };
  for (const line of environment.split(/\r?\n/)) { const offset = line.indexOf('='); if (offset > 0) env[line.slice(0, offset)] = line.slice(offset + 1); }
  const target = join(temporary, 'klaus-computer-use-helper.exe');
  const compilerPath = join(env.VCToolsInstallDir, 'bin/Hostx64/x64/cl.exe');
  const compiler = `MSVC toolset ${env.VCToolsVersion}; Windows SDK ${env.WindowsSDKVersion}; cl.exe SHA-256 ${sha(readFileSync(compilerPath))}`;
  env.VSLANG = '1033';
  execFileSync('cl.exe', ['/nologo', '/std:c++20', '/EHsc', '/utf-8', '/O2', '/MT', '/W4', '/WX', '/permissive-', '/guard:cf',
    '/D_WIN32_WINNT=0x0A00', '/DWINVER=0x0A00', '/DNDEBUG', source, `/Fo${join(temporary, 'helper.obj')}`, `/Fe${target}`,
    '/link', '/INCREMENTAL:NO', '/DYNAMICBASE', '/NXCOMPAT', '/CETCOMPAT', '/SUBSYSTEM:CONSOLE', '/MANIFEST:NO',
    'windowsapp.lib', 'user32.lib', 'gdi32.lib', 'ole32.lib', 'oleaut32.lib', 'uuid.lib', 'dwmapi.lib', 'd3d11.lib', 'dxgi.lib',
    'windowscodecs.lib', 'shell32.lib', 'wtsapi32.lib', 'advapi32.lib', 'crypt32.lib', 'uiautomationcore.lib'], { env, cwd: temporary, stdio: 'inherit' });
  const embeddedManifest = join(temporary, 'helper.manifest');
  execFileSync('mt.exe', ['-nologo', '-manifest', applicationManifest, `-outputresource:${target};#1`], { env, stdio: 'inherit' });
  execFileSync('mt.exe', ['-nologo', `-inputresource:${target};#1`, `-out:${embeddedManifest}`], { env, stdio: 'inherit' });
  execFileSync('mt.exe', ['-nologo', '-manifest', embeddedManifest, '-validate_manifest'], { env, stdio: 'inherit' });
  const manifestText = readFileSync(embeddedManifest, 'utf8');
  if (!/<requestedExecutionLevel\b[^>]*\blevel=['"]asInvoker['"][^>]*\buiAccess=['"]false['"]/.test(manifestText)) throw new Error('The helper must use ordinary asInvoker privileges without UIAccess');
  if (fingerprint() !== sourceSha256) throw new Error('Windows Computer Use source changed during compilation');
  const binary = join(output, 'klaus-computer-use-helper.exe'); renameSync(target, binary);
  const manifest = { platform: process.platform, arch: process.arch,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceSha256, compiler: compiler.trim(), sha256: sha(readFileSync(binary)) };
  writeFileSync(binary + '.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(`computer-use-helper: ${binary}\nsha256=${manifest.sha256}\nsourceSha256=${sourceSha256}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
