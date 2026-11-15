import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DesignStore } from '../main/design/store';
import { Harness, assert, assertEqual } from './harness';

const h = new Harness();
const logs = resolve(__dirname, '../dist/design-store-logs');
mkdirSync(logs, { recursive: true });

void (async () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-design-store-'));
  try {
    const store = new DesignStore(root);
    await h.test('DesignStore creates revisioned canvases, enforces baseVersion concurrency, and soft-deletes /_blob/ assets', () => {
      const doc = store.open('chat-owner-1', 'Brand System Canvas');
      assertEqual(doc.version, 'v1', 'initial version is v1');
      assertEqual(store.files('chat-owner-1', doc.id).length, 0, 'v1 starts empty');

      const canvasBytes = new TextEncoder().encode(JSON.stringify({ v: 3, title: 'Brand System Canvas', boards: {}, order: [] }));
      const pub = store.publish('chat-owner-1', doc.id, {
        baseVersion: 'v1',
        writes: [{ path: 'project/canvas.json', bytes: canvasBytes }],
      });
      assertEqual(pub.version, 'v2', 'publish advances to v2');

      let conflictCode = '';
      try {
        store.publish('chat-owner-1', doc.id, {
          baseVersion: 'v1',
          writes: [{ path: 'project/Main.dc.html', bytes: new TextEncoder().encode('<!doctype html>') }],
        });
      } catch (err: any) {
        conflictCode = err.code;
      }
      assertEqual(conflictCode, 'conflict', 'stale baseVersion is rejected with conflict');

      let foreignCode = '';
      try {
        store.get('chat-owner-2', doc.id);
      } catch (err: any) {
        foreignCode = err.code;
      }
      assertEqual(foreignCode, 'not_found', 'another chat cannot read the document');

      const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      const asset = store.putAsset('chat-owner-1', doc.id, pngBytes, 'image/png', 'hero.png');
      assert(/^\/_blob\/[0-9a-f]{32}$/.test(asset.url), 'asset URL starts with /_blob/<32hex>');
      assertEqual(store.assets('chat-owner-1', doc.id).length, 1, 'active asset listed');

      store.deleteAsset('chat-owner-1', doc.id, asset.id);
      assertEqual(store.assets('chat-owner-1', doc.id).length, 0, 'soft-deleted asset leaves picker');
      assertEqual(store.asset('chat-owner-1', doc.id, asset.id).bytes.byteLength, pngBytes.byteLength, 'historical artboard reference remains readable');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    process.exitCode = await h.finish(resolve(logs, 'result.json'), 'design-store');
  }
})();
