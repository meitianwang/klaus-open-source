#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSignedRelease, verifySignedRelease } from '../packaging/release.mjs';
import { desktopEdition, useDesktopEditionsFile } from '../packaging/desktop-edition.mjs';

// The `~/.tauri` directory name is LOAD-BEARING, not a leftover. The minisign keypair
// that signs update metadata lives there, and its public half is compiled into the app as
// `KLAUS_UPDATE_PUBLIC_KEY` (`main/updater/policy.ts`) — byte-identical to the server-side
// `ELECTRON_UPDATE_PUBLIC_KEY` in `src/channels/web-electron-signature.ts`. Every client
// already shipped verifies updates against that embedded key, so renaming the directory or
// rotating the key would invalidate the signature chain for installed apps. Override with
// `KLAUS_UPDATE_KEY_FILE` rather than editing this default.

const { values } = parseArgs({ options: {
  edition: { type: 'string' }, 'editions-file': { type: 'string' },
  bundle: { type: 'string' }, out: { type: 'string' }, origin: { type: 'string' }, channel: { type: 'string', default: 'stable' },
  'lifetime-days': { type: 'string', default: '30' }, 'verify-only': { type: 'boolean' }, receipt: { type: 'string' },
  'nsis-archive': { type: 'string' }, help: { type: 'boolean' },
  'notary-transport': { type: 'string', default: 'notarytool' }, 'notary-python': { type: 'string' },
} });
if (values.help) {
  console.log('Desktop edition: --edition <id>; omitted selection inherits the verified candidate (candidates without an edition are domestic). Additional editions come from --editions-file / KLAUS_DESKTOP_EDITIONS_FILE. --origin defaults to the edition server.');
  console.log('macOS notarization: --notary-transport notarytool|api (default notarytool); --notary-python <interpreter with pinned boto3> for api.');
  console.log('node scripts/release-desktop.mjs --bundle <verified native candidate> --out <fresh directory> [--edition <id>] [--editions-file <absolute path>] [--origin <HTTPS origin>] [--channel stable|preview] [--lifetime-days 1..31] [--nsis-archive <pinned toolset>]\nnode scripts/release-desktop.mjs --verify-only --bundle <signed application> --receipt <signed receipt.json> [--edition <id>] [--editions-file <absolute path>]\nSigning tools and credentials are read from the documented environment and existing credential files. Mac notarization accepts APPLE_API_* (App Store Connect API key) or APPLE_ID with APPLE_PASSWORD (app-specific password, notarytool transport only). This command never publishes or installs.');
} else {
  try {
    useDesktopEditionsFile(values['editions-file']);
    if (values.edition !== undefined) desktopEdition(values.edition);
    if (!['notarytool', 'api'].includes(values['notary-transport'])) throw new Error('--notary-transport must be notarytool or api');
    if (!values.bundle) throw new Error('--bundle is required');
    if (values['verify-only']) {
      if (!values.receipt) throw new Error('--receipt is required for signed verification');
      console.log(JSON.stringify(await verifySignedRelease({ bundle: resolve(values.bundle), receiptFile: resolve(values.receipt), edition: values.edition })));
    } else {
      if (!values.out) throw new Error('--out is required');
      let mac;
      if (process.platform === 'darwin') {
        const identity = process.env.APPLE_SIGNING_IDENTITY;
        const teamId = process.env.APPLE_TEAM_ID ?? /\(([A-Z0-9]{10})\)$/.exec(identity ?? '')?.[1];
        const appleId = process.env.APPLE_ID;
        const applePassword = process.env.APPLE_PASSWORD;
        let credentials;
        if (appleId && applePassword) {
          credentials = { appleId, applePassword, teamId };
        } else {
          let keyPath = process.env.APPLE_API_KEY_PATH;
          if (!keyPath) {
            const directory = join(homedir(), '.appstoreconnect/private_keys');
            const keys = (await readdir(directory)).filter(file => /^AuthKey_[A-Z0-9]{10}\.p8$/.test(file));
            if (keys.length !== 1) throw new Error('Select APPLE_API_KEY_PATH when the existing account has zero or multiple API keys');
            keyPath = join(directory, keys[0]);
          }
          const keyId = process.env.APPLE_API_KEY ?? /AuthKey_([A-Z0-9]{10})\.p8$/.exec(keyPath)?.[1];
          const issuer = process.env.APPLE_API_ISSUER ?? (await readFile(join(homedir(), '.appstoreconnect/issuer-id'), 'utf8')).trim();
          credentials = { keyPath: resolve(keyPath), keyId, issuer };
        }
        delete process.env.APPLE_PASSWORD;
        mac = { identity, teamId, credentials,
          notaryTransport: values['notary-transport'], notaryPython: values['notary-python'] };
      }
      const password = process.env.KLAUS_UPDATE_KEY_PASSWORD ?? '';
      delete process.env.KLAUS_UPDATE_KEY_PASSWORD;
      const result = await createSignedRelease({ bundle: values.bundle, out: values.out, origin: values.origin, edition: values.edition, channel: values.channel,
        lifetimeDays: Number(values['lifetime-days']), nsisArchive: values['nsis-archive'], mac,
        windows: { signtool: process.env.KLAUS_SIGNTOOL, certificateSha1: process.env.KLAUS_WINDOWS_CERT_SHA1, publisher: process.env.KLAUS_WINDOWS_PUBLISHER,
          timestampUrl: process.env.KLAUS_WINDOWS_TIMESTAMP_URL },
        signing: { executable: process.env.KLAUS_MINISIGN ?? 'minisign', privateKeyFile: process.env.KLAUS_UPDATE_KEY_FILE ?? join(homedir(), '.tauri/klaus-updater.key'), password },
        onProgress: stage => console.log(`[release] ${stage}`) });
      console.log(JSON.stringify({ output: result.output, receiptFile: result.receiptFile, update: result.update, download: result.download, published: false, installed: false }));
    }
  } catch (error) {
    console.error(`[release] ${error instanceof Error ? error.message : 'Release failed'}`);
    process.exitCode = 1;
    // Builder's temp-file cleanup schedules process.exit(0) on beforeExit.
    // Preserve failure at the final exit event without interrupting its cleanup.
    process.on('exit', () => { process.exitCode = 1; });
  }
}
