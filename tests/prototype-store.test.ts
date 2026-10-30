import { deepEqual, equal, throws } from 'node:assert/strict';
import { Harness } from './harness';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '../main/visuals/data';
import { PrototypeStore, type PrototypeProject } from '../main/prototype/store';
const h = new Harness();
// A valid empty ZIP with a comment keeps the byte snapshots distinguishable.
function archive(comment: string): Buffer {
    const label = Buffer.from(comment);
    const bytes = Buffer.alloc(22 + label.length);
    bytes.writeUInt32LE(0x06054b50, 0);
    bytes.writeUInt16LE(label.length, 20);
    label.copy(bytes, 22);
    return bytes;
}
function document(name: string, uid = 1, extra: Data = {}): Data {
    return { name, uid, data: archive(name).toString('base64'), ...extra };
}
function inStore(run: (store: PrototypeStore, root: string, warnings: string[]) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'klaus-prototype-store-'));
    const warnings: string[] = [];
    try {
        run(new PrototypeStore(root, warning => warnings.push(warning)), root, warnings);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
}
function projectPath(store: PrototypeStore, project: PrototypeProject): string {
    return join(store.root, project.id, 'project.json');
}
function savedFilePath(store: PrototypeStore, project: PrototypeProject, index = 0): string {
    return join(store.root, project.id, project.generation, project.files[index]!.file);
}
h.test('reopening preserves every native file, active document, viewport and branch', () => inStore((store, root) => {
    const project = store.open('owner', { title: 'Checkout workspace' });
    deepEqual(store.runtimeLoad(project.id, 'owner'), { id: project.id, title: project.title, version: 0, active: 0, fresh: true, files: [] });
    const firstView = { cx: -25.5, cy: 40, zoom: 0.75, vw: 1440, vh: 900 };
    const secondView = { cx: 300, cy: -60, zoom: 2, vw: 500, vh: 400, rulers: true };
    const files = [
        document('Checkout', 14, { view: firstView }),
        document('Mobile variant', 35, { view: secondView, parent: { index: 0, branch: 'mobile-v2' } }),
        document('Unrelated sketch', 62),
    ];
    const saved = store.save(project.id, 'owner', { baseVersion: 0, active: 1, files });
    const reopened = new PrototypeStore(root);
    deepEqual(reopened.open('owner', { id: project.id }), saved);
    deepEqual(reopened.runtimeLoad(project.id, 'owner'), {
        id: project.id, title: 'Checkout workspace', version: 1, fresh: false, active: 1,
        files: [
            { ...files[0], parent: null },
            files[1],
            { ...files[2], view: null, parent: null },
        ],
    });
    for (let index = 0; index < files.length; index++) {
        deepEqual(reopened.bytes(saved, index), archive(String(files[index]!.name)));
        equal(saved.files[index]!.file, `${index}.figcraft`);
    }
    deepEqual(reopened.list('owner'), [saved]);
    equal(reopened.resolveId('owner'), project.id);
}));
h.test('a stale save cannot replace the manifest or bytes published by another store', () => inStore((store, root) => {
    const project = store.open('owner', { title: 'Shared editor' });
    const otherEditor = new PrototypeStore(root);
    const stale = otherEditor.open('owner', { id: project.id });
    const current = store.save(project.id, 'owner', { baseVersion: 0, files: [document('Committed')] });
    const before = readFileSync(projectPath(store, current));
    const generations = readdirSync(join(store.root, project.id)).sort();
    throws(() => otherEditor.save(project.id, 'owner', { baseVersion: stale.version, files: [document('Stale')] }), { message: 'Design save conflict: current version 1.' });
    deepEqual(readFileSync(projectPath(store, current)), before);
    deepEqual(readdirSync(join(store.root, project.id)).sort(), generations);
    deepEqual(otherEditor.bytes(otherEditor.load(project.id, 'owner'), 0), archive('Committed'));
    const latest = otherEditor.save(project.id, 'owner', { baseVersion: current.version, files: [document('Next')] });
    equal(latest.version, 2);
    deepEqual(store.bytes(store.load(project.id, 'owner'), 0), archive('Next'));
}));
for (const baseVersion of [undefined, '1', -1, 1.5])
    h.test(`rejects an invalid base version ${String(baseVersion)} without changing a saved project`, () => inStore(store => {
        const project = store.open('owner', {});
        const saved = store.save(project.id, 'owner', { baseVersion: 0, files: [document('Original')] });
        const before = readFileSync(projectPath(store, saved));
        const fields: Data = { files: [document('Replacement')] };
        if (baseVersion !== undefined)
            fields.baseVersion = baseVersion;
        throws(() => store.save(project.id, 'owner', fields), /save conflict/);
        deepEqual(readFileSync(projectPath(store, saved)), before);
    }));
h.test('another chat cannot discover, load, reopen, resolve or save an owned project', () => inStore(store => {
    const project = store.open('owner', {});
    const saved = store.save(project.id, 'owner', { baseVersion: 0, files: [document('Private')] });
    const stranger = store.open('stranger', { title: 'Separate workspace' });
    const before = readFileSync(projectPath(store, saved));
    deepEqual(store.list('stranger').map(item => item.id), [stranger.id]);
    equal(store.resolveId('stranger'), stranger.id);
    for (const operation of [
        () => store.load(project.id, 'stranger'),
        () => store.open('stranger', { id: project.id }),
        () => store.resolveId('stranger', project.id),
        () => store.runtimeLoad(project.id, 'stranger'),
        () => store.save(project.id, 'stranger', { baseVersion: saved.version, files: [] }),
    ])
        throws(operation, { message: 'Interface design belongs to another chat.' });
    equal(store.resolveId('stranger'), stranger.id);
    deepEqual(readFileSync(projectPath(store, saved)), before);
}));
for (const [label, data] of [
    ['plain text', Buffer.from('not a native archive').toString('base64')],
    ['truncated signature', Buffer.from('PK').toString('base64')],
    ['invalid alphabet', 'UEsD@A=='],
    ['missing padding', 'UEsDBA'],
    ['excess padding', 'UEsDBA==='],
    ['embedded whitespace', 'UEsD BA=='],
    ['noncanonical padding bits', 'UEsDBB=='],
] satisfies Array<[string, string]>)
    h.test(`rejects ${label} bytes before publishing a new generation`, () => inStore(store => {
        const project = store.open('owner', {});
        const before = readFileSync(projectPath(store, project));
        const directory = join(store.root, project.id);
        const contents = readdirSync(directory);
        throws(() => store.save(project.id, 'owner', { baseVersion: 0, files: [document('Rejected', 1, { data })] }));
        deepEqual(readFileSync(projectPath(store, project)), before);
        deepEqual(readdirSync(directory), contents);
    }));
h.test('document labels and supplied file paths never choose the storage destination', () => inStore((store, root) => {
    const project = store.open('owner', {});
    const sentinel = join(root, 'outside.figcraft');
    writeFileSync(sentinel, 'untouched');
    const saved = store.save(project.id, 'owner', { baseVersion: 0, files: [
            document('../../outside.figcraft\0\n', 10, { file: sentinel }),
        ] });
    equal(saved.files[0]!.file, '0.figcraft');
    equal(saved.files[0]!.name, '../../outside.figcraft');
    deepEqual(store.bytes(saved, 0), archive('../../outside.figcraft\0\n'));
    equal(readFileSync(sentinel, 'utf8'), 'untouched');
    const manifest = JSON.parse(readFileSync(projectPath(store, saved), 'utf8'));
    manifest.files[0].file = '../../outside.figcraft';
    writeFileSync(projectPath(store, saved), JSON.stringify(manifest));
    throws(() => store.load(project.id, 'owner'), { message: 'Invalid interface design file entry.' });
}));
for (const id of ['../outside', '/tmp/project', `${randomUUID()}/..`, 'not-an-id'])
    h.test(`rejects the path-like project id ${id}`, () => inStore(store => {
        throws(() => store.load(id, 'owner'), { message: 'Invalid interface design id.' });
        throws(() => store.open('owner', { id }), { message: 'Invalid interface design id.' });
    }));
if (process.platform === 'win32')
    h.info('symlink escape cases', 'Creating filesystem symlinks requires separate privileges on Windows.');
else
    for (const boundary of ['project', 'manifest', 'generation', 'document'])
        h.test(`rejects a ${boundary} symlink escaping the owned project`, () => inStore((store, root) => {
            const project = store.open('owner', {});
            const saved = store.save(project.id, 'owner', { baseVersion: 0, files: [document('Original')] });
            const directory = join(store.root, project.id);
            const outside = join(root, 'outside');
            mkdirSync(outside);
            const manifest = readFileSync(projectPath(store, saved));
            writeFileSync(join(outside, 'project.json'), manifest);
            writeFileSync(join(outside, '0.figcraft'), archive('Outside'));
            if (boundary === 'project') {
                rmSync(directory, { recursive: true });
                symlinkSync(outside, directory, 'dir');
            }
            else if (boundary === 'manifest') {
                unlinkSync(projectPath(store, saved));
                symlinkSync(join(outside, 'project.json'), projectPath(store, saved));
            }
            else if (boundary === 'generation') {
                rmSync(join(directory, saved.generation), { recursive: true });
                symlinkSync(outside, join(directory, saved.generation), 'dir');
            }
            else {
                unlinkSync(savedFilePath(store, saved));
                symlinkSync(join(outside, '0.figcraft'), savedFilePath(store, saved));
            }
            throws(() => store.runtimeLoad(project.id, 'owner'));
            deepEqual(readFileSync(join(outside, '0.figcraft')), archive('Outside'));
        }));
h.test('refuses oversized saved bytes without reading them into the runtime', () => inStore(store => {
    const project = store.open('owner', {});
    const saved = store.save(project.id, 'owner', { baseVersion: 0, files: [document('Original')] });
    truncateSync(savedFilePath(store, saved), 64 * 1024 * 1024 + 1);
    throws(() => store.bytes(saved, 0), { message: 'Invalid saved design file.' });
    throws(() => store.runtimeLoad(project.id, 'owner'), { message: 'Invalid saved design file.' });
}));
for (const [label, changes] of [
    ['active document', { active: 2 }],
    ['missing viewport coordinates', { files: [document('Invalid', 1, { view: { zoom: 1 } })] }],
    ['nonfinite viewport coordinates', { files: [document('Invalid', 1, { view: { cx: NaN, cy: 0, zoom: 1, vw: 500, vh: 400 } })] }],
    ['negative identity', { files: [document('Invalid', -1)] }],
    ['unsafe identity', { files: [document('Invalid', Number.MAX_SAFE_INTEGER + 1)] }],
    ['self branch', { files: [document('Invalid', 1, { parent: { index: 0, branch: 'self' } })] }],
    ['missing parent document', { files: [document('Invalid', 1, { parent: { index: 2, branch: 'missing' } })] }],
    ['path-like branch', { files: [document('Parent'), document('Invalid', 2, { parent: { index: 0, branch: '../escape' } })] }],
    ['too many documents', { files: Array.from({ length: 33 }, (_, index) => document(`File ${index}`, index)) }],
] satisfies Array<[
    string,
    Data
]>)
    h.test(`invalid ${label} metadata cannot replace an existing generation`, () => inStore(store => {
        const project = store.open('owner', {});
        const saved = store.save(project.id, 'owner', { baseVersion: 0, files: [document('Original')] });
        const before = readFileSync(projectPath(store, saved));
        throws(() => store.save(project.id, 'owner', { baseVersion: saved.version, files: [document('Replacement')], ...changes }));
        deepEqual(readFileSync(projectPath(store, saved)), before);
        deepEqual(store.bytes(saved, 0), archive('Original'));
    }));
h.test('closing every document persists an empty workspace across a store restart', () => inStore((store, root) => {
    const project = store.open('owner', { title: 'Closed documents' });
    const populated = store.save(project.id, 'owner', { baseVersion: 0, active: 1, files: [document('First'), document('Second', 2)] });
    const empty = store.save(project.id, 'owner', { baseVersion: populated.version, active: 0, files: [] });
    equal(empty.version, 2);
    deepEqual(empty.files, []);
    equal(empty.active, 0);
    const reopened = new PrototypeStore(root);
    deepEqual(reopened.runtimeLoad(project.id, 'owner'), { id: project.id, title: 'Closed documents', version: 2, fresh: false, active: 0, files: [] });
    deepEqual(reopened.bytes(populated, 1), archive('Second'));
    equal(existsSync(join(store.root, empty.id, empty.generation, 'snapshot.json')), true);
    throws(() => reopened.save(project.id, 'owner', { baseVersion: empty.version, active: 1, files: [] }), { message: 'Invalid active design document.' });
    deepEqual(reopened.load(project.id, 'owner'), empty);
}));
h.test('snapshot retention removes old generations while preserving the latest published bytes', () => inStore(store => {
    let project = store.open('owner', {});
    const generations: string[] = [];
    for (let version = 1; version <= 22; version++) {
        project = store.save(project.id, 'owner', { baseVersion: project.version, files: [document(`Revision ${version}`)] });
        generations.push(project.generation);
    }
    const directory = join(store.root, project.id);
    equal(existsSync(join(directory, generations[0]!)), false);
    equal(existsSync(join(directory, generations[1]!)), false);
    for (const generation of generations.slice(2))
        equal(existsSync(join(directory, generation)), true);
    deepEqual(store.runtimeLoad(project.id, 'owner'), { id: project.id, title: project.title, version: 22, fresh: false, active: 0, files: [{ name: 'Revision 22', uid: 1, view: null, parent: null, data: archive('Revision 22').toString('base64') }] });
}));
h.test('a retention failure reports a warning and still acknowledges the published save', () => inStore((store, root, warnings) => {
    const project = store.open('owner', {});
    // Inject only this instance's maintenance fault, after publication, without a global filesystem mock.
    const maintenance = store as unknown as {
        prune(directory: string, generation: string): void;
    };
    const original = maintenance.prune;
    maintenance.prune = () => { throw new Error('Retention directory is read-only'); };
    try {
        const first = store.save(project.id, 'owner', { baseVersion: 0, files: [document('Published')] });
        equal(first.version, 1);
        deepEqual(warnings, ['Retention directory is read-only']);
        deepEqual(new PrototypeStore(root).load(project.id, 'owner'), first);
        deepEqual(store.runtimeLoad(project.id, 'owner'), { id: project.id, title: project.title, version: 1, fresh: false, active: 0, files: [{ name: 'Published', uid: 1, view: null, parent: null, data: archive('Published').toString('base64') }] });
        const second = store.save(project.id, 'owner', { baseVersion: first.version, files: [document('Acknowledged')] });
        equal(second.version, 2);
        equal(warnings.length, 2);
        deepEqual(store.bytes(store.load(project.id, 'owner'), 0), archive('Acknowledged'));
        throws(() => store.save(project.id, 'owner', { baseVersion: first.version, files: [] }), { message: 'Design save conflict: current version 2.' });
    }
    finally {
        maintenance.prune = original;
    }
}));
void h.finish(join(__dirname, 'prototype-store-result.json'), 'prototype-store').then(code => { process.exitCode = code; });
