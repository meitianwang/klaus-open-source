import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionDiscovery, hookDeclarationsFromDocument } from '../main/services/extensions/discovery';
import { HooksTrustState } from '../main/services/extensions/hooks-state';
import { Harness } from './harness';

const h = new Harness();

const HOOKS_DOC = {
  PostToolUse: [
    { matcher: '*', hooks: [{ type: 'command', command: 'telemetry-hook --agent=a', timeout: 15 }] },
    { hooks: [{ type: 'command', command: 'second-hook', async: true }] },
  ],
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard-hook' }] }],
};

/** One throwaway config root per case; the hooks file and the ledger live inside it. */
async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'klaus-hooks-trust-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function rowsFor(root: string, trust: HooksTrustState, document: unknown = HOOKS_DOC) {
  const filePath = join(root, 'hooks.json');
  const declarations = hookDeclarationsFromDocument(document);
  const rows = await trust.rows('global', filePath, declarations);
  return { rows, live: new Map(rows.map(row => [row.key, row])) };
}

h.test('declarations carry their file address and converted timeout', () => {
    const declarations = hookDeclarationsFromDocument(HOOKS_DOC);
    assert.equal(declarations.length, 3);
    assert.deepEqual(declarations[0]!, { event: 'PostToolUse', groupIndex: 0, hookIndex: 0, command: 'telemetry-hook --agent=a', isAsync: false, matcher: '*', timeoutMs: 15000 });
    assert.equal(declarations[1]!.isAsync, true, 'the async flag survives');
    assert.equal(declarations[2]!.matcher, 'Bash');
  });

h.test('an untrusted hooks file injects nothing into sessions', () => withRoot(async root => {
    await writeFile(join(root, 'hooks.json'), JSON.stringify(HOOKS_DOC));
    const discovery = new ExtensionDiscovery({ configRoot: root, hookTrust: new HooksTrustState(root) });
    const init = await discovery.sessionExtensions('');
    assert.equal(init.commandHooks, undefined, 'no gate approval means no commandHooks field at all');
  }));

h.test('trust enables exactly the approved declarations, in file order', () => withRoot(async root => {
    await writeFile(join(root, 'hooks.json'), JSON.stringify(HOOKS_DOC));
    const trust = new HooksTrustState(root);
    const { rows, live } = await rowsFor(root, trust);
    assert.deepEqual(rows.map(row => row.status), ['new', 'new', 'new']);
    await trust.trust([rows[0]!.key], live);
    const init = await new ExtensionDiscovery({ configRoot: root, hookTrust: trust }).sessionExtensions('');
    assert.deepEqual(init.commandHooks, [{ event: 'PostToolUse', command: 'telemetry-hook --agent=a', matcher: '*', timeoutMs: 15000 }], 'only the trusted row is injected');
  }));

h.test('a rewritten declaration loses its approval until re-trusted', () => withRoot(async root => {
    await writeFile(join(root, 'hooks.json'), JSON.stringify(HOOKS_DOC));
    const trust = new HooksTrustState(root);
    const first = await rowsFor(root, trust);
    await trust.trust([first.rows[0]!.key], first.live);
    const rewritten = JSON.parse(JSON.stringify(HOOKS_DOC));
    rewritten.PostToolUse[0].hooks[0].command = 'telemetry-hook --agent=a --exfiltrate';
    await writeFile(join(root, 'hooks.json'), JSON.stringify(rewritten));
    const discovery = new ExtensionDiscovery({ configRoot: root, hookTrust: trust });
    assert.equal((await discovery.sessionExtensions('')).commandHooks, undefined, 'the changed hash reads as untrusted again');
    const second = await rowsFor(root, trust, rewritten);
    assert.equal(second.rows[0]!.status, 'changed', 'the settings page names the reason');
    await trust.trust([second.rows[0]!.key], second.live);
    const init = await discovery.sessionExtensions('');
    assert.equal((init.commandHooks as Array<Record<string, unknown>>)[0]!.command, 'telemetry-hook --agent=a --exfiltrate', 're-trust records the new hash');
  }));

h.test('disable keeps trust but stops injection; enable restores without re-trust', () => withRoot(async root => {
    await writeFile(join(root, 'hooks.json'), JSON.stringify(HOOKS_DOC));
    const trust = new HooksTrustState(root);
    const { rows, live } = await rowsFor(root, trust);
    await trust.trust([rows[0]!.key], live);
    await trust.setEnabled(rows[0]!.key, false, live);
    let after = await rowsFor(root, trust);
    assert.equal(after.rows[0]!.status, 'disabled');
    assert.equal((await new ExtensionDiscovery({ configRoot: root, hookTrust: trust }).sessionExtensions('')).commandHooks, undefined, 'a disabled hook is not injected');
    await trust.setEnabled(rows[0]!.key, true, after.live);
    after = await rowsFor(root, trust);
    assert.equal(after.rows[0]!.status, 'trusted', 'the stored hash survived the toggle');
  }));

h.test('trust is per file: two projects never share one decision', () => withRoot(async root => {
    await writeFile(join(root, 'hooks.json'), JSON.stringify(HOOKS_DOC));
    const trust = new HooksTrustState(root);
    const global = await rowsFor(root, trust);
    await trust.trust([global.rows[0]!.key], global.live);
    const projectRows = await trust.rows('project', '/elsewhere/.klaus/hooks.json', hookDeclarationsFromDocument(HOOKS_DOC));
    assert.equal(projectRows[0]!.status, 'new', 'same declaration, different file, no inherited trust');
    assert.notEqual(projectRows[0]!.key, global.rows[0]!.key);
  }));

h.test('the ledger survives a corrupt file by trusting nothing', () => withRoot(async root => {
    await writeFile(join(root, 'hooks.json'), JSON.stringify(HOOKS_DOC));
    await writeFile(join(root, 'hooks-state.json'), '{ not json');
    const trust = new HooksTrustState(root);
    const { rows } = await rowsFor(root, trust);
    assert.deepEqual(rows.map(row => row.status), ['new', 'new', 'new']);
  }));

h.test('prune drops rows of edited files only', () => withRoot(async root => {
    await writeFile(join(root, 'hooks.json'), JSON.stringify(HOOKS_DOC));
    const trust = new HooksTrustState(root);
    const global = await rowsFor(root, trust);
    await trust.trust(global.rows.map(row => row.key), global.live);
    const kept = await trust.rows('project', '/elsewhere/.klaus/hooks.json', hookDeclarationsFromDocument(HOOKS_DOC));
    await trust.trust([kept[0]!.key], new Map(kept.map(row => [row.key, row])));
    await trust.prune([{ scope: 'global', filePath: join(root, 'hooks.json') }], new Set([global.rows[0]!.key]));
    const ledger = JSON.parse(await readFile(join(root, 'hooks-state.json'), 'utf8')) as { entries: Record<string, unknown> };
    assert.equal(Object.keys(ledger.entries).length, 2, 'one surviving global row plus the untouched project row');
    assert.ok(ledger.entries[kept[0]!.key], 'the other file\'s row is untouched');
  }));

void h.finish(join(__dirname, 'hooks-trust-result.json'), 'hooks-trust').then(code => process.exit(code));
