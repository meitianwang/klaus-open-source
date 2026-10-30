#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renewReleaseMetadata } from '../packaging/release-renew.mjs';
import { DEFAULT_DESKTOP_EDITION, useDesktopEditionsFile } from '../packaging/desktop-edition.mjs';

// `~/.tauri` is the load-bearing key location, not a leftover — see the note in
// release-desktop.mjs. Override with `KLAUS_UPDATE_KEY_FILE`.

const { values } = parseArgs({ options: { edition: { type: 'string', default: DEFAULT_DESKTOP_EDITION }, 'editions-file': { type: 'string' }, directory: { type: 'string' }, out: { type: 'string' }, 'lifetime-days': { type: 'string', default: '30' }, help: { type: 'boolean' } } });
if (values.help) console.log('node scripts/renew-electron-release.mjs --directory <existing signed release set> --out <fresh directory> [--edition <id> (default domestic; additional editions come from --editions-file / KLAUS_DESKTOP_EDITIONS_FILE)] [--lifetime-days 1..31]\nRenews signed update metadata only. Existing artifacts, signatures and receipts remain unchanged. This command never publishes or installs.');
else {
  try {
    useDesktopEditionsFile(values['editions-file']);
    if (!values.directory || !values.out) throw new Error('--directory and --out are required');
    const password = process.env.KLAUS_UPDATE_KEY_PASSWORD ?? '';
    delete process.env.KLAUS_UPDATE_KEY_PASSWORD;
    console.log(JSON.stringify(await renewReleaseMetadata({ edition: values.edition, directory: values.directory, out: values.out, lifetimeDays: Number(values['lifetime-days']),
      signing: { executable: process.env.KLAUS_MINISIGN ?? 'minisign', privateKeyFile: process.env.KLAUS_UPDATE_KEY_FILE ?? join(homedir(), '.tauri/klaus-updater.key'), password } })));
  } catch (error) { console.error(`[release-renew] ${error instanceof Error ? error.message : 'Metadata renewal failed'}`); process.exitCode = 1; }
}
