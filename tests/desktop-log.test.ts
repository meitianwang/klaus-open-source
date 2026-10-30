import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopLog } from '../main/app/log';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';

const h = new Harness();
const filename = 'electron-host.log';
async function directory(): Promise<string> { return mkdtemp(join(tmpdir(), 'klaus-log-')); }
async function rows(root: string): Promise<Array<{ detail: string; dropped?: number }>> {
  const names = (await readdir(root)).filter(name => name === filename || name.startsWith(filename + '.previous'));
  const rank = (name: string): number => name === filename ? 0 : name === filename + '.previous' ? 1 : Number(name.split('.').at(-1));
  const contents = await Promise.all(names.sort((left, right) => rank(right) - rank(left)).map(name => readFile(join(root, name), 'utf8')));
  return contents.flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

h.test('runtime rotation keeps a bounded ordered tail without restarting the logger', async () => {
  const root = await directory();
  try {
    const log = new DesktopLog(root, filename, { maxSegmentBytes: 512, maxSegments: 4, maxBufferedBytes: 1024 * 1024 });
    const inputs = Array.from({ length: 60 }, (_, index) => String(index).padStart(3, '0') + ':' + 'x'.repeat(60));
    for (const detail of inputs) log.write('rotation', detail);
    await log.close();
    const names = await readdir(root), result = await rows(root);
    assertEqual(names.length, 4, 'only the active segment and three predecessors remain');
    for (const name of names) assert((await stat(join(root, name))).size <= 512, 'each ordinary segment obeys its byte budget');
    assert(result.length > 0 && result.length < inputs.length, 'retention keeps a finite recent tail');
    assertDeepEqual(result.map(row => row.detail), inputs.slice(-result.length), 'rotation preserves exact chronological records');
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('backpressured writes and rotations finish before close resolves', async () => {
  const root = await directory();
  try {
    const log = new DesktopLog(root, filename, { maxSegmentBytes: 256, maxSegments: 32, maxBufferedBytes: 1024 * 1024, highWaterMarkBytes: 1 });
    const inputs = Array.from({ length: 20 }, (_, index) => `record-${index}`);
    for (const detail of inputs) log.write('drain', detail);
    const closed = log.close();
    assertEqual(log.close(), closed, 'close shares one pending result');
    await closed;
    assertDeepEqual((await rows(root)).map(row => row.detail), inputs, 'all admitted writes survive backpressure and rotation');
    log.write('late', 'ignored after close');
    assertDeepEqual((await rows(root)).map(row => row.detail), inputs, 'closed logs ignore later writes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('an oversized existing active segment is retained under the legacy predecessor name', async () => {
  const root = await directory();
  try {
    const prior = 'existing diagnostic bytes\n'.repeat(20);
    await writeFile(join(root, filename), prior);
    const log = new DesktopLog(root, filename, { maxSegmentBytes: 256, maxSegments: 3 });
    log.write('new', 'current record'); await log.close();
    assertEqual(await readFile(join(root, filename + '.previous'), 'utf8'), prior, 'previous log content remains readable');
    assertEqual(JSON.parse(await readFile(join(root, filename), 'utf8')).detail, 'current record', 'new writes use the established active path');
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('buffer pressure drops excess lines and records the count on the next admitted line', async () => {
  const root = await directory();
  const log = new DesktopLog(root, filename, { maxBufferedBytes: 128, highWaterMarkBytes: 1 });
  try {
    for (let index = 0; index < 1000; index++) log.write('pressure', String(index));
    await waitFor(async () => { try { return (await readFile(join(root, filename), 'utf8')).trim().split('\n').length >= 2; } catch { return false; } }, 2000, 'initial admitted writes reach disk');
    log.write('recovered', 'after drain'); await log.close();
    const result = await rows(root);
    assert(result.length < 1000, 'backpressure does not retain the entire producer burst');
    assert(result.some(row => row.detail === 'after drain' && (row.dropped ?? 0) > 0), 'the next accepted record reports dropped lines');
  } finally { await log.close(); await rm(root, { recursive: true, force: true }); }
});

h.test('write errors cannot strand shutdown or admit later diagnostic records', async () => {
  const root = await directory();
  try {
    await mkdir(join(root, filename));
    const log = new DesktopLog(root);
    log.write('error-fixture', 'the file path is a directory');
    await Promise.race([log.close(), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Log close remained pending')), 2000).unref())]);
    log.write('late', 'ignored after failure');
    assert((await stat(join(root, filename))).isDirectory(), 'the failed log never replaces the existing directory');
  } finally { await rm(root, { recursive: true, force: true }); }
});

void h.finish(join(__dirname, 'desktop-log-result.json'), 'desktop-log').then(code => { process.exitCode = code; });
