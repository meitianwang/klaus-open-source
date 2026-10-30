#!/usr/bin/env node
// Layout-only compatibility helper. publish-electron-release performs trust verification.
import { readFile, writeFile } from 'node:fs/promises';
import { bytesProof, indexEntries, mergeReleaseIndexes, parseRemoteIndex, receiptName } from '../packaging/release-index.mjs';
import { fileProof } from '../packaging/release-io.mjs';
import { parseArgs } from 'node:util';
import { DEFAULT_DESKTOP_EDITION, desktopEdition, indexEdition, useDesktopEditionsFile } from '../packaging/desktop-edition.mjs';

try {
  const { values, positionals } = parseArgs({ options: { edition: { type: 'string', default: DEFAULT_DESKTOP_EDITION }, 'editions-file': { type: 'string' } }, allowPositionals: true });
  useDesktopEditionsFile(values['editions-file']);
  const edition = desktopEdition(values.edition);
  const [command, ...args] = positionals;
  if (command === 'inspect' && args[0]) console.log(JSON.stringify(await fileProof(args[0])));
  else if (command === 'plan' && args.length === 5) {
    const [localFile, remoteFile, output, entriesFile, required] = args;
    const local = JSON.parse(await readFile(localFile, 'utf8')), remote = parseRemoteIndex(await readFile(remoteFile));
    if (indexEdition(local).id !== edition.id || (remote && indexEdition(remote).id !== edition.id)) throw new Error('Release planning desktop edition mismatch');
    const manifest = mergeReleaseIndexes(local, remote, required.trim() ? required.trim().split(/\s+/) : []);
    const localEntries = new Set(indexEntries(local).map(({ channel, target }) => `${channel}/${target}`)), entries = [];
    for (const { channel, target, entry } of indexEntries(manifest)) {
      const source = localEntries.has(`${channel}/${target}`) ? 'local' : 'remote', receipt = receiptName(channel, target, entry.version, edition.id);
      const update = target.startsWith('darwin-') ? `${edition.artifactPrefix}-${entry.version}-${target}.zip` : entry.download.file;
      for (const file of new Set([entry.envelopeFile, receipt, `${receipt}.sig`, update, `${update}.sig`, entry.download.file, `${entry.download.file}.sig`])) entries.push([source, file, file, 'electron', '-'].join('\t'));
    }
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(output, bytes); await writeFile(entriesFile, `${entries.join('\n')}\n`);
    console.log(JSON.stringify({ ...bytesProof('manifest.json', bytes), plannedFiles: entries.length, signaturesVerified: false, published: false }));
  } else throw new Error('Usage: plan-electron-release.mjs inspect <file> | plan <local.json> <remote.json> <output.json> <entries.tsv> <required targets>');
} catch (error) { console.error(`[release-plan] ${error instanceof Error ? error.message : 'Planning failed'}`); process.exitCode = 1; }
