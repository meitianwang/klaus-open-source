//
//  dev-macos-launcher.mjs
//
//  macOS-only development launcher.  It builds a small Objective-C helper that
//  uses NSWorkspace to start a new instance of an immutable .app bundle, then
//  monitors the exact NSRunningApplication until it exits.
//
//  Exported API:
//    async function launchMacDevelopmentApp({ executable, appDirectory, env, logDirectory })
//      -> Node ChildProcess
//
//  The helper is cached under appDirectory/dist/dev-launcher-cache/<sourceSHA>-<arch>/launcher
//  and reused across launches until main.m changes.
//

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import preflight from './electron-test-preflight.cjs';

const { assertElectronGuiAvailable } = preflight;

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_ENVIRONMENT_KEY_BYTES = 256;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_ARGUMENT_COUNT = 64;

/**
 * Validate and return a realpath for an absolute path that points to an
 * existing filesystem entry.
 */
function resolveExistingPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (!isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${label} must not contain embedded NUL`);
  }
  const absolute = resolve(value);
  if (absolute.length > 4096) {
    throw new TypeError(`${label} exceeds path length limit`);
  }
  if (!existsSync(absolute)) {
    throw new Error(`${label} does not exist: ${absolute}`);
  }
  try {
    return realpathSync(absolute);
  } catch (error) {
    throw new Error(`Could not resolve ${label}: ${error.message}`);
  }
}

/**
 * Resolve an absolute directory path, creating it if necessary.
 */
function resolveAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (!isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${label} must not contain embedded NUL`);
  }
  const absolute = resolve(value);
  if (absolute.length > 4096) {
    throw new TypeError(`${label} exceeds path length limit`);
  }
  mkdirSync(absolute, { recursive: true });
  try {
    return realpathSync(absolute);
  } catch (error) {
    throw new Error(`Could not resolve ${label}: ${error.message}`);
  }
}

function assertAbsoluteString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${label} must not contain embedded NUL`);
  }
}

/**
 * Derive the .app bundle URL from the executable path.  The executable is
 * expected to live at .../Foo.app/Contents/MacOS/Foo.
 */
function resolveAppBundleFromExecutable(executablePath) {
  let current = executablePath;
  while (current !== '/' && current.length > 0) {
    if (current.endsWith('.app')) {
      const bundlePath = current;
      const infoPlist = join(bundlePath, 'Contents', 'Info.plist');
      if (!existsSync(infoPlist)) {
        throw new Error(`Bundle does not contain Contents/Info.plist: ${bundlePath}`);
      }
      const macOSDir = join(bundlePath, 'Contents', 'MacOS');
      if (!existsSync(macOSDir) || !statSync(macOSDir).isDirectory()) {
        throw new Error(`Bundle does not contain Contents/MacOS: ${bundlePath}`);
      }
      const macOSPrefix = macOSDir + '/';
      if (!executablePath.startsWith(macOSPrefix)) {
        throw new Error(`Executable ${executablePath} is not inside Contents/MacOS of ${bundlePath}`);
      }
      return bundlePath;
    }
    current = resolve(current, '..');
  }
  throw new Error(`Could not locate a .app bundle ancestor for executable: ${executablePath}`);
}

function validateEnvironment(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env must be a plain object mapping strings to strings');
  }
  const result = Object.create(null);
  for (const [key, value] of Object.entries(env)) {
    assertAbsoluteString(key, 'env key');
    if (key.length > MAX_ENVIRONMENT_KEY_BYTES) {
      throw new TypeError(`env key exceeds ${MAX_ENVIRONMENT_KEY_BYTES} bytes: ${key}`);
    }
    if (!/^[\x21-\x7E]+$/.test(key) || key.includes('=')) {
      throw new TypeError(`env key contains invalid characters: ${key}`);
    }
    if (typeof value !== 'string') {
      throw new TypeError(`env value for ${key} must be a string`);
    }
    if (value.length > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new TypeError(`env value for ${key} exceeds ${MAX_ENVIRONMENT_VALUE_BYTES} bytes`);
    }
    if (value.includes('\0')) {
      throw new TypeError(`env value for ${key} contains embedded NUL`);
    }
    result[key] = value;
  }
  return result;
}

function validateArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length === 0) {
    throw new TypeError('arguments must be a non-empty array');
  }
  if (arguments_.length > MAX_ARGUMENT_COUNT) {
    throw new TypeError(`arguments exceeds ${MAX_ARGUMENT_COUNT} entries`);
  }
  for (const arg of arguments_) {
    assertAbsoluteString(arg, 'argument');
    if (arg.length > MAX_ARGUMENT_BYTES) {
      throw new TypeError(`argument exceeds ${MAX_ARGUMENT_BYTES} bytes`);
    }
    if (!arg.startsWith('/')) {
      throw new TypeError(`argument must be an absolute path: ${arg}`);
    }
  }
  return arguments_;
}

function ensureHelper(sourcePath, cacheDirectory) {
  const source = readFileSync(sourcePath);
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const archDirectory = join(cacheDirectory, `${digest}-${process.arch}`);
  const launcher = join(archDirectory, 'launcher');

  if (existsSync(launcher)) {
    try {
      const stats = statSync(launcher);
      if (stats.isFile()) {
        return launcher;
      }
    } catch {
      // Rebuild if the cache entry is unreadable.
    }
  }

  mkdirSync(archDirectory, { recursive: true });
  const tempLauncher = `${launcher}.${process.pid}.tmp`;

  const compile = spawnSync(
    '/usr/bin/xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-framework', 'AppKit',
      '-framework', 'Foundation',
      sourcePath,
      '-o', tempLauncher,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 60_000,
    },
  );

  if (compile.error || compile.status !== 0) {
    try { unlinkSync(tempLauncher); } catch {}
    const detail = compile.stderr?.trim() || compile.signal || 'unknown error';
    throw new Error(`Failed to compile dev-launcher helper: ${detail}`);
  }

  renameSync(tempLauncher, launcher);
  return launcher;
}

/**
 * Launch a macOS .app bundle for development.
 *
 * @param {object} options
 * @param {string} options.executable      Absolute path to the .app executable.
 * @param {string} options.appDirectory    Absolute path passed as the app argument.
 * @param {Record<string,string>} options.env  Environment for the new app instance.
 * @param {string} options.logDirectory    Absolute directory for helper diagnostics.
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export async function launchMacDevelopmentApp({ executable, appDirectory, env, logDirectory }) {
  if (process.platform !== 'darwin') {
    const error = new Error('launchMacDevelopmentApp is only available on macOS');
    error.code = 'KLAUS_MACOS_DEV_LAUNCHER_UNAVAILABLE';
    throw error;
  }

  const resolvedExecutable = resolveExistingPath(executable, 'executable');
  const resolvedAppDirectory = resolveExistingPath(appDirectory, 'appDirectory');
  const resolvedLogDirectory = resolveAbsoluteDirectory(logDirectory, 'logDirectory');

  if (!statSync(resolvedAppDirectory).isDirectory()) {
    throw new Error(`appDirectory is not a directory: ${resolvedAppDirectory}`);
  }

  const validatedEnv = validateEnvironment(env);
  // ELECTRON_RUN_AS_NODE must never reach the launched app.
  delete validatedEnv.ELECTRON_RUN_AS_NODE;

  const bundlePath = resolveAppBundleFromExecutable(resolvedExecutable);
  const arguments_ = validateArguments([resolvedAppDirectory]);

  const payload = {
    bundlePath,
    arguments: arguments_,
    environment: validatedEnv,
    logDirectory: resolvedLogDirectory,
  };
  const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  if (payloadBuffer.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Launch payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }

  // GUI access must be verified before we ask the system to launch an app.
  assertElectronGuiAvailable();

  const appDirectoryReal = resolvedAppDirectory;
  const cacheDirectory = join(appDirectoryReal, 'dist', 'dev-launcher-cache');
  const sourcePath = fileURLToPath(new URL('../native/dev-launcher/main.m', import.meta.url));
  const launcher = ensureHelper(sourcePath, cacheDirectory);

  const helperEnv = { ...process.env };
  delete helperEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(launcher, [], {
    env: helperEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Pipe errors must not crash the parent; the helper exit event signals failure.
  child.stdin.on('error', () => {});

  const write = () => {
    try {
      child.stdin.end(payloadBuffer);
    } catch {
      // If the helper process died immediately, the caller will observe exit.
    }
  };

  // Use setImmediate so callers can attach listeners before the pipe is written.
  setImmediate(write);

  return child;
}

export default { launchMacDevelopmentApp };
