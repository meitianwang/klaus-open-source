#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { macSigningOptions } from '../packaging/macos-signing.mjs';
import { verifyPackage } from '../packaging/verify.mjs';
import { candidateEdition, useDesktopEditionsFile } from '../packaging/desktop-edition.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { identity: { type: 'string' }, edition: { type: 'string' }, 'editions-file': { type: 'string' } } });
useDesktopEditionsFile(values['editions-file']);
if (positionals.length !== 1 || !values.identity) throw new Error('Usage: node scripts/print-mac-signing-plan.mjs <Klaus.app> --identity <Developer ID identity>');
const report = verifyPackage(positionals[0]);
const edition = candidateEdition(report, values.edition);
if (!report.target.startsWith('darwin-')) throw new Error('This signing plan is only for macOS');
const options = macSigningOptions({ app: report.bundle, arch: report.target.slice('darwin-'.length), identity: values.identity, electronVersion: report.electronVersion, edition: edition.id });
console.log(JSON.stringify({ operation: 'review-only-signing-plan', performedSigning: false, performedNotarization: false,
  application: options.app, identity: options.identity, identityValidation: options.identityValidation,
  files: [options.app, ...options.binaries].map(file => ({ file, ...options.optionsForFile(file) })),
  remaining: 'Sign a separate copy, preserve original artifact provenance, regenerate the signed file inventory, then verify signatures, notarization and the real runtime.' }, null, 2));
