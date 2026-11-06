import { extractFile, listPackage, statFile } from '@electron/asar';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, posix, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import plist from 'plist';
import { computerUseArtifactName, engineArtifactRecords, inventory, readJson, requireTarget, sha256, specification, validateComputerUse, validateEngine, validatePip, validateRecording, validateSpeech } from './resources.mjs';
import { officialPluginRequiredFiles, parseOfficialPluginRecords } from './official-plugins.mjs';
import { POLICY_NOTICE_CATALOG, POLICY_NOTICE_DIRECTORY } from '../engine/scripts/policy-notices.mjs';
import { DEFAULT_DESKTOP_EDITION, desktopEdition, packagedDesktopEditionDocument, validateDesktopEditionDocuments } from './desktop-edition.mjs';

/**
 * The package's own definitions decide its identity, so a package built for an
 * edition defined outside the repository verifies without that definitions file.
 */
export function packagedEdition(bundle) {
  const root = resolve(bundle), mac = root.endsWith('.app');
  const archive = join(root, mac ? 'Contents/Resources' : 'resources', 'app.asar');
  const pkg = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  const id = pkg.klausDesktopEdition ?? DEFAULT_DESKTOP_EDITION;
  if (pkg.klausDesktopEdition === undefined) return desktopEdition(id);
  let packaged;
  try { packaged = validateDesktopEditionDocuments([JSON.parse(extractFile(archive, 'contracts/desktop-editions.json').toString('utf8'))]); }
  catch (error) { throw new Error(`Packaged desktop edition definitions are invalid: ${error.message}`); }
  if (!packaged[id]) throw new Error('Packaged desktop edition is not defined by the package');
  return packaged[id];
}

/**
 * A package carries the public editions plus its own. A non-public edition's
 * definition comes from the package; when this verification also loaded that
 * edition from a definitions file, the two must be identical.
 */
function expectedPackagedDefinitions(packaged, id) {
  const committed = readJson(new URL('../contracts/desktop-editions.json', import.meta.url));
  if (Object.hasOwn(committed.editions, id)) return packagedDesktopEditionDocument(id);
  const own = packaged.editions?.[id];
  let supplied;
  try { supplied = desktopEdition(id); } catch { supplied = undefined; }
  if (supplied && !isDeepStrictEqual({ ...supplied }, own)) throw new Error('Packaged desktop edition differs from the supplied definition');
  return { schemaVersion: 1, editions: { ...committed.editions, [id]: own } };
}

export function packageLocations(bundle, id) {
  const root = resolve(bundle);
  const mac = root.endsWith('.app');
  const archive = join(root, mac ? 'Contents/Resources' : 'resources', 'app.asar');
  const edition = id === undefined && existsSync(archive) ? packagedEdition(root) : desktopEdition(id);
  return { bundle: root, resources: join(root, mac ? 'Contents/Resources' : 'resources'), executable: join(root, mac ? `Contents/MacOS/${edition.executableName}` : `${edition.executableName}.exe`) };
}

export function verifyMacPackageIdentity(text, edition) {
  const info = plist.parse(text);
  if (info.CFBundleIdentifier !== edition.application || info.CFBundleExecutable !== edition.executableName
    || !info.CFBundleURLTypes?.some(value => value.CFBundleURLSchemes?.includes(edition.protocol))) throw new Error('Packaged macOS edition identity mismatch');
}

function relativeRequires(source, filename) {
  const result = [];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
      && /^\.{1,2}\//.test(node.arguments[0].text)) result.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

/** Every emitted relative dependency must be present in the exact application archive. */
export function verifyRuntimeModuleClosure(files, read) {
  const entries = new Set(files);
  for (const importer of files.filter(file => file.startsWith('dist/') && file.endsWith('.js'))) {
    const source = read(importer).toString('utf8');
    for (const request of relativeRequires(source, importer)) {
      const base = posix.normalize(posix.join(posix.dirname(importer), request));
      const candidates = [base, `${base}.js`, `${base}.json`, `${base}.node`, `${base}/index.js`, `${base}/index.json`, `${base}/index.node`];
      if (!candidates.some(candidate => entries.has(candidate))) throw new Error(`Packaged runtime dependency is missing: ${importer} -> ${request}`);
    }
  }
}

/** Mac-only resources are checked separately so a Windows bundle cannot carry them. */
export function verifyPipResource(resources, manifest) {
  const target = requireTarget(manifest.platform, manifest.arch), root = join(resources, 'pip');
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (manifest.platform !== 'darwin') {
    if (Object.hasOwn(manifest, 'pip') || rootStat) throw new Error('The macOS PiP producer leaked into a Windows package');
    return undefined;
  }
  if (!rootStat?.isDirectory() || readdirSync(root).join(',') !== target) throw new Error('Unexpected PiP producer target');
  const directory = join(root, target);
  if (!lstatSync(directory).isDirectory()) throw new Error('PiP producer target must be a regular directory');
  const pip = validatePip(directory, { platform: manifest.platform, arch: manifest.arch });
  if (!isDeepStrictEqual(pip, manifest.pip) || readdirSync(directory).sort().join(',') !== 'klaus-pip-producer,klaus-pip-producer.json') throw new Error('Packaged PiP producer differs from its resource identity');
  return pip;
}

export function verifyComputerUseResource(resources, manifest) {
  const target = requireTarget(manifest.platform, manifest.arch), root = join(resources, 'computer-use');
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || readdirSync(root).join(',') !== target) throw new Error('Unexpected Computer Use helper target');
  const directory = join(root, target);
  if (!lstatSync(directory).isDirectory()) throw new Error('Computer Use helper target must be a regular directory');
  const computerUse = validateComputerUse(directory, { platform: manifest.platform, arch: manifest.arch });
  const filename = computerUseArtifactName(manifest.platform);
  if (!isDeepStrictEqual(computerUse, manifest.computerUse) || readdirSync(directory).sort().join(',') !== [filename, filename + '.json'].sort().join(',')) throw new Error('Packaged Computer Use helper differs from its resource identity');
  return computerUse;
}

/** Validate the actual package, not a staging directory that could hide a copy error. */
export function verifyPackage(bundle) {
  const manifest = readJson(join(packageLocations(bundle, DEFAULT_DESKTOP_EDITION).resources, 'desktop-resources.json'));
  const edition = packagedEdition(bundle);
  const locations = packageLocations(bundle, edition.id);
  const target = requireTarget(manifest.platform, manifest.arch);
  if (manifest.layoutVersion !== 1 || manifest.application !== edition.productName || manifest.buildKind !== 'local-unsigned'
    || (manifest.edition ?? DEFAULT_DESKTOP_EDITION) !== edition.id || (manifest.applicationId ?? desktopEdition().application) !== edition.application) throw new Error('Unknown desktop resource manifest');
  if (!existsSync(locations.executable)) throw new Error('Packaged application executable is missing');
  const archive = join(locations.resources, 'app.asar');
  const files = listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
  const actualAppFiles = files.filter(file => !statFile(archive, normalize(file)).files);
  for (const file of specification.requiredAppFiles) if (!files.includes(file)) throw new Error(`Packaged app entry is missing: ${file}`);
  const officialPlugins = parseOfficialPluginRecords(manifest.officialPlugins);
  for (const file of [...specification.requiredResourceFiles, ...officialPlugins.flatMap(officialPluginRequiredFiles)]) if (!existsSync(join(locations.resources, file))) throw new Error(`Packaged resource is missing: ${file}`);
  const bundledOfficial = existsSync(join(locations.resources, 'plugins-official')) ? readdirSync(join(locations.resources, 'plugins-official')).sort() : [];
  if (bundledOfficial.join(',') !== officialPlugins.map(plugin => plugin.name).sort().join(',')) throw new Error('Packaged official plugins differ from the resource manifest');
  if (files.some(file => /(?:^|\/)(?:tests|target|frontend|frontend-dist|native|electron|tauri)(?:\/|$)/.test(file) && file !== 'dist/main/native' && !file.startsWith('dist/main/native/'))) throw new Error('A source, test, duplicate runtime or native artifact leaked into app.asar');
  if (files.some(file => file.endsWith('.map'))) throw new Error('Development source maps leaked into app.asar');
  if (existsSync(join(locations.resources, 'app')) || existsSync(join(locations.resources, 'app.asar.unpacked'))) throw new Error('Unexpected secondary application payload');
  verifyRuntimeModuleClosure(actualAppFiles, file => extractFile(archive, normalize(file)));
  const pkg = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (pkg.version !== manifest.version || pkg.name !== 'klaus-desktop' || pkg.klausDesktopLayoutVersion !== 1 || pkg.main !== 'dist/main/index.js' || pkg.devDependencies) throw new Error('Packaged application metadata mismatch');
  if (pkg.klausDesktopEdition !== undefined) {
    const packaged = JSON.parse(extractFile(archive, 'contracts/desktop-editions.json').toString('utf8'));
    const expected = expectedPackagedDefinitions(packaged, edition.id);
    if (pkg.productName !== edition.productName || !isDeepStrictEqual(packaged, expected)) throw new Error('Packaged desktop edition definitions differ from the canonical identity');
  }
  if (manifest.platform === 'darwin' && pkg.klausDesktopEdition !== undefined) {
    const info = readFileSync(join(locations.bundle, 'Contents/Info.plist'), 'utf8');
    verifyMacPackageIdentity(info, edition);
  }
  // The inventory is portable JSON, while @electron/asar accepts host paths.
  if (actualAppFiles.length !== manifest.appFiles.length || new Set(manifest.appFiles.map(file => file.path)).size !== actualAppFiles.length) throw new Error('Packaged application file count differs from the manifest');
  for (const file of manifest.appFiles) {
    const bytes = extractFile(archive, normalize(file.path));
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Packaged application hash mismatch: ${file.path}`);
  }
  const actualResourceFiles = [];
  for (const name of ['frontend', 'manual', 'bin', 'native', 'computer-use', ...specification.sharedRoots, ...specification.generatedRoots, ...(officialPlugins.length ? specification.optionalGeneratedRoots : []), ...(manifest.platform === 'darwin' ? ['app-icon.icns', 'speech', 'recording', 'pip'] : [])]) {
    const root = join(locations.resources, name), stat = statSync(root);
    if (stat.isDirectory()) actualResourceFiles.push(...inventory(root).map(file => ({ ...file, path: `${name}/${file.path}` })));
    else actualResourceFiles.push({ path: name, size: stat.size, sha256: sha256(readFileSync(root)) });
  }
  const expected = new Map(manifest.resourceFiles.map(file => [file.path, file]));
  if (expected.size !== actualResourceFiles.length) throw new Error('Packaged resource file count differs from the manifest');
  for (const file of actualResourceFiles) {
    const wanted = expected.get(file.path);
    if (!wanted || wanted.size !== file.size || wanted.sha256 !== file.sha256) throw new Error(`Packaged resource hash mismatch: ${file.path}`);
  }
  if (readdirSync(join(locations.resources, 'bin')).join(',') !== target) throw new Error('More than one engine target was bundled');
  const engineDirectory = join(locations.resources, 'bin', target);
  const engine = validateEngine(engineDirectory, { platform: manifest.platform, arch: manifest.arch, engineCommit: manifest.engine.engineCommit });
  if (!isDeepStrictEqual(engine, manifest.engine)) throw new Error('Packaged engine manifest differs from the resource identity');
  const artifacts = engineArtifactRecords(engine, manifest);
  if (readdirSync(engineDirectory).sort().join(',') !== [...artifacts.map(artifact => artifact.file), 'manifest.json', POLICY_NOTICE_CATALOG, POLICY_NOTICE_DIRECTORY].sort().join(',')) throw new Error('Unexpected packaged engine payload');
  for (const artifact of artifacts) if (expected.get(`bin/${target}/${artifact.file}`)?.sha256 !== artifact.sha256) throw new Error(`Packaged engine identity mismatch: ${artifact.role}`);
  const engineArtifact = artifacts.find(artifact => artifact.role === 'engine');
  const enginePath = `bin/${target}/${engineArtifact.file}`;
  const nativePath = `native/klaus-native-${target}.node`;
  if (expected.get(nativePath)?.sha256 !== manifest.native.sha256 || manifest.native.credentialFixtures !== false || manifest.native.whatsappFixtures === true || manifest.native.sourceTreeDirty !== false) throw new Error('Packaged native identity mismatch');
  let speech;
  if (manifest.platform === 'darwin') {
    const speechRoot = join(locations.resources, 'speech');
    if (readdirSync(speechRoot).join(',') !== target) throw new Error('Unexpected speech helper target');
    const directory = join(speechRoot, target);
    speech = validateSpeech(directory, { platform: manifest.platform, arch: manifest.arch });
    if (!isDeepStrictEqual(speech, manifest.speech) || readdirSync(directory).sort().join(',') !== 'klaus-speech-helper,klaus-speech-helper.json') throw new Error('Packaged speech helper differs from its resource identity');
  } else if (manifest.speech || existsSync(join(locations.resources, 'speech'))) throw new Error('The macOS speech helper leaked into a Windows package');
  let recording;
  if (manifest.platform === 'darwin') {
    const recordingRoot = join(locations.resources, 'recording');
    if (readdirSync(recordingRoot).join(',') !== target) throw new Error('Unexpected recording helper target');
    const directory = join(recordingRoot, target);
    recording = validateRecording(directory, { platform: manifest.platform, arch: manifest.arch });
    if (!isDeepStrictEqual(recording, manifest.recording) || readdirSync(directory).sort().join(',') !== 'klaus-recording-helper,klaus-recording-helper.json') throw new Error('Packaged recording helper differs from its resource identity');
  } else if (manifest.recording || existsSync(join(locations.resources, 'recording'))) throw new Error('The macOS recording helper leaked into a Windows package');
  const pip = verifyPipResource(locations.resources, manifest);
  const computerUse = verifyComputerUseResource(locations.resources, manifest);
  return { ...locations, edition: edition.id, application: edition.application, version: manifest.version, target, electronVersion: manifest.electronVersion, buildKind: manifest.buildKind,
    clientCommit: manifest.clientCommit, clientTreeDirty: manifest.clientTreeDirty, recordedEngineCommit: manifest.recordedEngineCommit,
    engineCommit: engine.engineCommit, engineSha256: engineArtifact.sha256, engineArtifacts: artifacts, nativeSourceCommit: manifest.native.sourceCommit,
    nativeSha256: manifest.native.sha256, appFiles: manifest.appFiles.length, resourceFiles: actualResourceFiles.length,
    appAsarBytes: statSync(archive).size, engineBytes: expected.get(enginePath).size, nativeBytes: expected.get(nativePath).size,
    ...(speech ? { speechSourceCommit: speech.sourceCommit, speechSha256: speech.sha256 } : {}),
    ...(recording ? { recordingSourceCommit: recording.sourceCommit, recordingSha256: recording.sha256 } : {}),
    ...(pip ? { pipSourceCommit: pip.sourceCommit, pipSha256: pip.sha256 } : {}),
    ...(computerUse ? { computerUseSourceCommit: computerUse.sourceCommit, computerUseSha256: computerUse.sha256 } : {}),
    resourceBytes: actualResourceFiles.reduce((size, file) => size + file.size, 0), verified: true };
}
