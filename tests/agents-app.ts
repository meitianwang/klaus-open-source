import { shell } from 'electron';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopRuntime } from '../main/app/runtime';
import type { Json } from '../main/ipc/contract';
import { object } from '../main/services/service-types';
import { Harness, assert, assertEqual, waitFor } from './harness';

interface AgentRow {
  agentType?: string;
  source?: string;
  tools?: string[];
  isolation?: string;
  maxTurns?: number;
  background?: boolean;
}

export async function testAgentsApp(
  h: Harness,
  desktop: DesktopRuntime,
  invoke: (channel: string, payload?: Json) => Promise<unknown>,
  root: string,
): Promise<void> {
  await h.test('the Agents page completes its isolated create, edit, use, search and delete lifecycle', async () => {
    const name = 'gui-agent-contract';
    const agentPath = join(root, 'agents', `${name}.md`);
    const trashRoot = join(root, 'agents-test-trash');
    const trashedPath = join(trashRoot, `${name}.md`);
    const evaluate = <T = unknown>(expression: string): Promise<T> =>
      desktop.window.webContents.executeJavaScript(expression) as Promise<T>;
    const shellWithTrash = shell as typeof shell & { trashItem: (path: string) => Promise<void> };
    const originalTrashItem = shellWithTrash.trashItem;
    let trashOverridden = false;

    const row = async (): Promise<AgentRow | undefined> => {
      const result = object(await invoke('agents:definitions:list'));
      return (result.agents as AgentRow[]).find(agent => agent.agentType === name);
    };
    const content = async (): Promise<string> => String(object(await invoke('agents:definitions:read', { id: name })).content || '');
    const openEdit = async (): Promise<void> => {
      await evaluate(`(() => {
        const card = document.querySelector('[data-agent-name="${name}"]');
        const label = window.tt('agents_edit');
        const button = Array.from(card.querySelectorAll('button')).find(item => item.textContent.trim() === label);
        button.click();
      })()`);
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('agent-create-name'))"), 5_000, 'Agent edit form opened');
    };

    rmSync(agentPath, { force: true });
    rmSync(trashRoot, { recursive: true, force: true });
    try {
      await waitFor(() => evaluate<boolean>(`document.getElementById('boot-screen')?.dataset.hidden === '1'
        && typeof window.showAgentsView === 'function'`), 30_000, 'application navigation initialized');
      await evaluate("document.getElementById('btn-agents').click(); true");
      await waitFor(() => evaluate<boolean>(`document.getElementById('agents-view')?.classList.contains('active') === true
        && Boolean(document.querySelector('[data-agent-name="Explore"]'))`), 10_000, 'Agents page loaded its built-in cards');
      const surface = await evaluate(`(() => ({
        header: ['agents-refresh', 'agent-search-input', 'agents-new-btn'].every(id => Boolean(document.getElementById(id))),
        tabs: document.querySelectorAll('#agents-view [data-agent-category-tab]').length,
        builtins: ['general-purpose', 'Explore', 'Plan', 'researcher'].every(name => Boolean(document.querySelector('[data-agent-name="' + name + '"]'))),
      }))()` ) as { header: boolean; tabs: number; builtins: boolean };
      assert(surface.header, 'refresh, search and add controls render together');
      assert(surface.tabs >= 2, 'the All and built-in category tabs render');
      assert(surface.builtins, 'all built-in Agent cards render');

      await evaluate(`(() => {
        document.getElementById('agents-new-btn').click();
        document.querySelector('#agents-create-menu [data-action="manual"]').click();
      })()`);
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('agent-create-name'))"), 5_000, 'manual Agent form opened');
      await waitFor(() => evaluate<boolean>("document.activeElement === document.getElementById('agent-create-name')"), 5_000, 'Agent name field focused');
      const defaults = await evaluate(`(() => ({
        tools: document.getElementById('agent-create-tools').value,
        model: document.getElementById('agent-create-model').value,
        isolation: document.getElementById('agent-create-isolation').value,
        focused: document.activeElement === document.getElementById('agent-create-name'),
      }))()` ) as { tools: string; model: string; isolation: string; focused: boolean };
      assertEqual(defaults.tools, 'all', 'new Agents default to all tools');
      assertEqual(defaults.model, 'inherit', 'new Agents inherit the model');
      assertEqual(defaults.isolation, 'none', 'new Agents do not invent worktree isolation');
      assert(defaults.focused, 'the create form focuses its required name field');

      await evaluate(`(() => {
        const set = (id, value) => {
          const field = document.getElementById(id);
          field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('agent-create-name', '${name}');
        set('agent-create-description', 'GUI Agent initial description');
        set('agent-create-prompt', 'Perform the isolated GUI Agent fixture.');
        document.getElementById('agent-create-isolation').value = 'worktree';
        set('agent-create-maxturns', '7');
        document.getElementById('agent-create-background').checked = true;
        document.getElementById('agent-create-submit').click();
      })()`);
      await waitFor(() => evaluate<boolean>(`!document.getElementById('agent-create-name')
        && Boolean(document.querySelector('[data-agent-name="${name}"]'))`), 10_000, 'created Agent appeared on the page');
      const created = await row();
      assert(created, 'created Agent is present in the host roster');
      assertEqual(Object.hasOwn(created, 'tools'), false, 'All tools is represented by inherited tool access');
      assertEqual(created.isolation, 'worktree', 'worktree isolation reaches the host roster');
      assertEqual(created.maxTurns, 7, 'max turns reaches the host roster');
      assertEqual(created.background, true, 'background execution reaches the host roster');
      assert((await content()).includes('tools: "*"'), 'the All tools form writes its explicit compatible marker');
      const createdCard = await evaluate(`(() => {
        const card = document.querySelector('[data-agent-name="${name}"]');
        return { category: card.dataset.agentCategory, text: card.textContent };
      })()` ) as { category: string; text: string };
      assertEqual(createdCard.category, 'user', 'created Agent is classified as user-owned');
      assert(createdCard.text.includes(await evaluate<string>("window.tt('agents_tools_all')")), 'card displays All tools');
      assert(createdCard.text.includes(await evaluate<string>("window.tt('agents_badge_worktree')")), 'card displays worktree isolation');

      await openEdit();
      const allEdit = await evaluate(`(() => ({
        readOnly: document.getElementById('agent-create-name').readOnly,
        tools: document.getElementById('agent-create-tools').value,
        isolation: document.getElementById('agent-create-isolation').value,
        maxTurns: document.getElementById('agent-create-maxturns').value,
        background: document.getElementById('agent-create-background').checked,
      }))()` ) as { readOnly: boolean; tools: string; isolation: string; maxTurns: string; background: boolean };
      assert(allEdit.readOnly, 'editing cannot rename the backing Agent file');
      assertEqual(allEdit.tools, 'all', 'All tools backfills into the edit form');
      assertEqual(allEdit.isolation, 'worktree', 'worktree isolation backfills into the edit form');
      assertEqual(allEdit.maxTurns, '7', 'max turns backfills into the edit form');
      assertEqual(allEdit.background, true, 'background execution backfills into the edit form');
      await evaluate(`(() => {
        document.getElementById('agent-create-tools').value = 'none';
        document.getElementById('agent-create-submit').click();
      })()`);
      await waitFor(async () => {
        const current = await row();
        return Array.isArray(current?.tools) && current.tools.length === 0;
      }, 10_000, 'No tools policy persisted');
      assert((await content()).includes('tools: []'), 'No tools writes an explicit empty allowlist');
      await waitFor(() => evaluate<boolean>(`document.querySelector('[data-agent-name="${name}"]')?.textContent.includes(window.tt('agents_tools_none'))`), 5_000, 'No tools label rendered');

      await openEdit();
      assertEqual(await evaluate<string>("document.getElementById('agent-create-tools').value"), 'none', 'No tools backfills into the edit form');
      await evaluate(`(() => {
        const set = (id, value) => {
          const field = document.getElementById(id);
          field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        };
        document.getElementById('agent-create-tools').value = 'read';
        document.getElementById('agent-create-isolation').value = 'none';
        set('agent-create-description', 'GUI Agent updated description');
        set('agent-create-prompt', 'Perform the updated isolated GUI Agent fixture.');
        set('agent-create-maxturns', '3');
        document.getElementById('agent-create-background').checked = false;
        document.getElementById('agent-create-submit').click();
      })()`);
      await waitFor(async () => JSON.stringify((await row())?.tools) === JSON.stringify(['Read', 'Glob', 'Grep']), 10_000, 'Read-only tools persisted');
      const updated = await row();
      assertEqual(updated?.maxTurns, 3, 'edited max turns reaches the host roster');
      assertEqual(Object.hasOwn(updated || {}, 'isolation'), false, 'cleared isolation is absent from the roster');
      assertEqual(Object.hasOwn(updated || {}, 'background'), false, 'cleared background mode is absent from the roster');
      const updatedContent = await content();
      assert(updatedContent.includes('tools:\n  - Read\n  - Glob\n  - Grep'), 'Read-only writes all three compatible labels');
      assert(!updatedContent.includes('isolation:') && !updatedContent.includes('background:'), 'cleared execution options leave no stale frontmatter');

      await evaluate(`(() => {
        const search = document.getElementById('agent-search-input');
        search.value = '${name}';
        search.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(() => evaluate<boolean>(`document.querySelectorAll('#agents-results [data-agent-name]').length === 1
        && Boolean(document.querySelector('[data-agent-name="${name}"]'))`), 5_000, 'Agent search filters the real cards');
      await evaluate(`(() => {
        const search = document.getElementById('agent-search-input');
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-agent-category-tab="user"]').click();
      })()`);
      await waitFor(() => evaluate<boolean>(`Boolean(document.querySelector('[data-agent-name="${name}"]'))
        && !document.querySelector('[data-agent-name="Explore"]')`), 5_000, 'user category isolates editable Agents');
      await evaluate("document.querySelector('[data-agent-category-tab=\"all\"]').click(); true");

      await evaluate(`(() => {
        const card = document.querySelector('[data-agent-name="${name}"]');
        const label = window.tt('agents_use');
        Array.from(card.querySelectorAll('button')).find(item => item.textContent.trim() === label).click();
      })()`);
      await waitFor(() => evaluate<boolean>(`document.getElementById('input').value === '@agent-${name} '
        && document.activeElement === document.getElementById('input')`), 10_000, 'Use action filled and focused the composer');

      await evaluate("document.getElementById('btn-agents').click(); true");
      await waitFor(() => evaluate<boolean>(`Boolean(document.querySelector('[data-agent-name="${name}"]'))`), 5_000, 'Agents page reopened');
      await evaluate(`(() => {
        document.getElementById('agents-new-btn').click();
        document.querySelector('#agents-create-menu [data-action="via-klaus"]').click();
      })()`);
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#composer-slash-mirror:not(.hidden) .composer-slash-mirror-token'))"), 10_000, 'Klaus Agent Creator command token appeared');
      const creatorDraft = await evaluate(`(() => ({
        label: document.querySelector('#composer-slash-mirror .composer-slash-mirror-token .slash-token-label').textContent,
        text: document.getElementById('input').value.trim(),
        seed: window.tt('agents_via_klaus_draft'),
        focused: document.activeElement === document.getElementById('input'),
      }))()` ) as { label: string; text: string; seed: string; focused: boolean };
      assertEqual(creatorDraft.label, await evaluate<string>("window.tt('agents_creator_command_label')"), 'Agent Creator command token keeps its localized identity');
      assertEqual(creatorDraft.text, creatorDraft.seed, 'Agent Creator keeps the editable seed text after its token');
      assert(creatorDraft.focused, 'Agent Creator returns focus to the editable draft');
      await evaluate("window.klausComposer.setText(''); true");

      mkdirSync(trashRoot, { recursive: true });
      shellWithTrash.trashItem = async path => {
        assertEqual(path, agentPath, 'delete sends only the isolated Agent file to trash');
        renameSync(path, trashedPath);
      };
      trashOverridden = true;
      await evaluate("document.getElementById('btn-agents').click(); true");
      await waitFor(() => evaluate<boolean>(`Boolean(document.querySelector('[data-agent-name="${name}"]'))`), 5_000, 'editable Agent is visible before deletion');
      await evaluate(`(() => {
        const card = document.querySelector('[data-agent-name="${name}"]');
        const label = window.tt('delete_title');
        Array.from(card.querySelectorAll('button')).find(item => item.textContent.trim() === label).click();
      })()`);
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('.klaus-dialog-confirm.klaus-dialog-danger'))"), 5_000, 'destructive confirmation opened');
      await evaluate("document.querySelector('.klaus-dialog-confirm').click(); true");
      await waitFor(() => evaluate<boolean>(`!document.querySelector('[data-agent-name="${name}"]')`), 10_000, 'deleted Agent left the page');
      assertEqual(await row(), undefined, 'deleted Agent left the host roster');
      assert(!existsSync(agentPath) && existsSync(trashedPath), 'delete used the isolated recoverable trash fixture');
    } finally {
      if (trashOverridden) shellWithTrash.trashItem = originalTrashItem;
      rmSync(agentPath, { force: true });
      rmSync(trashRoot, { recursive: true, force: true });
      await evaluate(`(() => {
        document.querySelector('.klaus-dialog-cancel')?.click();
        document.querySelector('.agent-create-modal .kls-modal-close')?.click();
        window.klausComposer?.setText?.('');
        return true;
      })()`).catch(() => undefined);
    }
  });
}
