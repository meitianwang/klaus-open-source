#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { publishRelease, SshReleaseStore } from '../packaging/release-publish.mjs';
import { DEFAULT_DESKTOP_EDITION, useDesktopEditionsFile } from '../packaging/desktop-edition.mjs';

const { values } = parseArgs({ options: { edition: { type: 'string', default: DEFAULT_DESKTOP_EDITION }, 'editions-file': { type: 'string' }, 'ssh-host': { type: 'string' }, 'verify-only': { type: 'boolean' }, directory: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) console.log('node scripts/publish-electron-release.mjs --directory <signed release directory> --ssh-host <SSH target> [--edition <id> (default domestic; additional editions come from --editions-file / KLAUS_DESKTOP_EDITIONS_FILE)] [--verify-only]\nPublication and verification require an explicit --ssh-host or KLAUS_SSH_HOST for every edition. Only invoke publication after an explicit release task. --verify-only reads the remote release and never writes, uploads or restarts.');
else {
  try {
    useDesktopEditionsFile(values['editions-file']);
    if (!values['verify-only'] && !values.directory && !process.env.KLAUS_RELEASE_DIR) throw new Error('Select the exact signed release directory with --directory or KLAUS_RELEASE_DIR');
    const remote = new SshReleaseStore({ edition: values.edition, host: values['ssh-host'] ?? process.env.KLAUS_SSH_HOST, directory: process.env.KLAUS_REMOTE_RELEASE_DIR, environmentFile: process.env.KLAUS_REMOTE_ENV_FILE, service: process.env.KLAUS_REMOTE_SERVICE });
    const result = await publishRelease({ localDirectory: values.directory || process.env.KLAUS_RELEASE_DIR ? resolve(values.directory ?? process.env.KLAUS_RELEASE_DIR) : undefined,
      edition: values.edition, verifyOnly: values['verify-only'], requiredTargets: process.env.KLAUS_DESKTOP_PLATFORMS?.trim().split(/\s+/), onProgress: message => console.log(`[upload] ${message}`) }, { remote });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(`[upload] ${error instanceof Error ? error.message : 'Release publication failed'}`); process.exitCode = 1; }
}
