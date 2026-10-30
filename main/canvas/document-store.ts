import { existsSync, lstatSync } from 'node:fs';

import { readBounded, record, scopedPath, writeAtomic, type Data } from '../visuals/data';
import type { Json } from '../ipc/contract';

const DOCUMENT_LIMIT = 2 * 1024 * 1024;
const ARCHIVE_LIMIT = 12 * 1024 * 1024;
const HISTORY_LIMIT = 20;

type Revision = { version: number; document: Json; savedAt: string };
type StoredDocument = { version: number; document: Json; history: Revision[] };

export class CanvasDocumentStore {
  constructor(private readonly root: string, private readonly canvasPath: (input: unknown) => string) {}

  private path(input: unknown): string {
    const canvas = this.canvasPath(input);
    return scopedPath(this.root, canvas.replace(/\.canvas\.tsx$/, '.canvas.document.json'), '.canvas.document.json', false);
  }

  private load(input: unknown): StoredDocument | undefined {
    const path = this.path(input);
    if (!existsSync(path)) return undefined;
    if (!lstatSync(path).isFile()) throw new Error('Canvas document is not a regular file.');
    const value = record(JSON.parse(readBounded(path, ARCHIVE_LIMIT)));
    if (!Number.isSafeInteger(value.version) || Number(value.version) < 1 || !Array.isArray(value.history) || !('document' in value)) throw new Error('Canvas document is invalid.');
    return value as StoredDocument;
  }

  get(input: unknown): Data {
    const state = this.load(input);
    return { version: state?.version ?? 0, document: state?.document ?? null };
  }

  history(input: unknown): Data {
    const state = this.load(input);
    return { version: state?.version ?? 0, revisions: (state?.history ?? []).map(({ version, savedAt }) => ({ version, savedAt })) };
  }

  apply(input: unknown, expectedVersion: unknown, document: unknown): Data {
    const current = this.load(input);
    const version = current?.version ?? 0;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== version) throw new Error(`Canvas document version conflict: current version is ${version}. Read it again before editing.`);
    if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('Canvas document must be an object.');
    const encoded = JSON.stringify(document);
    if (!encoded || Buffer.byteLength(encoded) > DOCUMENT_LIMIT) throw new Error('Canvas document exceeds 2 MiB.');
    const history = current ? [...current.history, { version, document: current.document, savedAt: new Date().toISOString() }] : [];
    while (history.length > HISTORY_LIMIT || Buffer.byteLength(JSON.stringify(history)) > ARCHIVE_LIMIT - DOCUMENT_LIMIT) history.shift();
    const next: StoredDocument = { version: version + 1, document: JSON.parse(encoded) as Json, history };
    writeAtomic(this.path(input), next);
    return { version: next.version, document: next.document };
  }

  restore(input: unknown, expectedVersion: unknown, revision: unknown): Data {
    const state = this.load(input);
    if (!state) throw new Error('Canvas document does not exist.');
    if (!Number.isSafeInteger(revision)) throw new Error('Revision must be an integer.');
    const snapshot = state.history.find(item => item.version === revision);
    if (!snapshot) throw new Error('Requested Canvas document revision is not available.');
    return this.apply(input, expectedVersion, snapshot.document);
  }
}
