import { randomUUID } from 'node:crypto';
import type { DesktopRuntime } from '../main/app/runtime';
import type { Json } from '../main/ipc/contract';
import { object, type JsonObject } from '../main/services/service-types';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';

function messages(request: JsonObject): JsonObject[] {
  return Array.isArray(request.messages) ? request.messages.map(object) : [];
}
function blocks(message: JsonObject | undefined): JsonObject[] {
  return Array.isArray(message?.content) ? message.content.map(object) : [];
}
function userText(message: JsonObject | undefined): string {
  if (message?.role !== 'user') return '';
  return typeof message.content === 'string' ? message.content
    : blocks(message).filter(block => block.type === 'text').map(block => block.text).join(' ');
}

/** Match the actual turn and its tool-use ID, not readonly queries that copy its history. */
function controlExchange(requests: JsonObject[], text: string, tool: string): { request: JsonObject; result: JsonObject } {
  const request = requests.find(value => value.stream === true && userText(messages(value).at(-1)) === text);
  assert(request, 'the provider received the ordinary control turn');
  for (const candidate of requests) {
    if (candidate.stream !== true) continue;
    const history = messages(candidate), last = history.at(-1), preceding = history.at(-2);
    if (last?.role !== 'user' || preceding?.role !== 'assistant' || !history.some(message => userText(message) === text)) continue;
    const call = blocks(preceding).find(block => block.type === 'tool_use' && block.name === tool);
    if (!call || typeof call.id !== 'string') continue;
    const result = blocks(last).find(block => block.type === 'tool_result' && block.tool_use_id === call.id);
    if (result) return { request, result };
  }
  throw new Error('The provider received no matching control tool continuation');
}

export async function testControlApp(options: {
  h: Harness; desktop: DesktopRuntime; requests: JsonObject[];
  invoke(channel: string, input?: Json): Promise<unknown>;
  records(): Promise<Array<{ channel: string; value: Json }>>;
}): Promise<void> {
  const { h, desktop, invoke, records, requests } = options;
  const created: string[] = [], answered = new Set<string>();
  async function run(tool: string, input: JsonObject): Promise<{ id: string; result: JsonObject; request: JsonObject }> {
    const id = created.length < 2 ? String(object(await invoke('session:new') as Json).id) : created[1]!;
    if (created.length < 2) created.push(id);
    const nonce = randomUUID(), text = 'HOST TOOL FIXTURE ' + JSON.stringify({ tool, input, nonce });
    const completed = (await records()).filter(entry => entry.channel === 'chat:event:batch'
      && Array.isArray(entry.value) && entry.value.some(value => object(value).sessionId === id && object(value).type === 'done')).length;
    await invoke('chat:send', { sessionId: id, text });
    await waitFor(async () => {
      for (const entry of await records()) {
        if (entry.channel !== 'permission:request') continue;
        const card = object(entry.value), requestId = String(card.requestId);
        if (card.sessionId !== id || answered.has(requestId)) continue;
        answered.add(requestId); await invoke('permission:respond', { requestId, decision: 'allow' });
      }
      return (await records()).filter(entry => entry.channel === 'chat:event:batch'
        && Array.isArray(entry.value) && entry.value.some(value => object(value).sessionId === id && object(value).type === 'done')).length > completed;
    }, 20_000, `real ${tool} response`);
    const { request, result } = controlExchange(requests, text, tool);
    return { id, result, request };
  }
  try {
    await h.test('control fixture correlates ordinary requests and tool results despite copied title history', async () => {
      const text = 'HOST TOOL FIXTURE {"tool":"klaus_query","nonce":"selection-regression"}';
      const initial: JsonObject = { stream: true, messages: [{ role: 'user', content: text }], tools: [] };
      const result: JsonObject = { type: 'tool_result', tool_use_id: 'control-call', content: 'matched result' };
      const continuation: JsonObject = { stream: true, messages: [...messages(initial),
        { role: 'assistant', content: [{ type: 'tool_use', id: 'control-call', name: 'klaus_query', input: {} }] },
        { role: 'user', content: [result] }], tools: [] };
      const title: JsonObject = { ...continuation, messages: [...messages(continuation),
        { role: 'assistant', content: [{ type: 'text', text: 'Completed' }] },
        { role: 'user', content: 'Generate a title from the conversation.' }] };
      const selected = controlExchange([initial, continuation, title], text, 'klaus_query');
      assertEqual(selected.request, initial, 'catalog comes from the original turn, regardless of whether tools are present');
      assertEqual(selected.result, result, 'result is correlated by its originating tool-use ID');
      const mismatched: JsonObject = { ...continuation, messages: [...messages(continuation).slice(0, -1),
        { role: 'user', content: [{ ...result, tool_use_id: 'another-call' }] }] };
      let rejected = false;
      try { controlExchange([initial, mismatched, title], text, 'klaus_query'); } catch { rejected = true; }
      assert(rejected, 'a copied title history cannot hide a missing matching continuation');
    });
    await h.test('Klaus control reaches the product manual through a real dynamic tool call', async () => {
      const { result, request } = await run('klaus_query', { key: 'nav', action: 'targets' });
      assert(JSON.stringify(result).includes('nav.open accepts'), 'query returns the current product navigation catalog');
      assert(JSON.stringify(request.system).includes('You are the assistant built into Klaus'), 'session carries the actual host product context');
      const names = (request.tools as Json[]).map(value => object(value).name);
      for (const name of ['klaus_query', 'klaus_action', 'list_threads', 'list_archived_threads', 'read_thread']) assert(names.includes(name), `live tool list contains ${name}`);
      const manual = await run('klaus_query', { key: 'docs', action: 'outline' });
      assert(!manual.result.is_error, 'the real manual was read successfully');
      assert(JSON.stringify(manual.result).includes('Klaus'), 'manual has product content');
    });
    await h.test('a model navigation action is delivered and changes the actual main window', async () => {
      const { result } = await run('klaus_action', { key: 'nav', action: 'open', arguments: { view: 'settings', tab: 'preferences' } });
      assert(JSON.stringify(result).includes('Opened settings'), 'navigation completed its delivery acknowledgement');
      await waitFor(() => desktop.window.webContents.executeJavaScript("document.getElementById('settings-view')?.classList.contains('active') === true"), 5000, 'settings view opened');
      const back = await run('klaus_action', { key: 'nav', action: 'open', arguments: { view: 'chat' } });
      assert(JSON.stringify(back.result).includes('Opened chat'), 'chat navigation returned a successful result');
      await waitFor(() => desktop.window.webContents.executeJavaScript("document.getElementById('settings-view')?.classList.contains('active') === false"), 5000, 'chat view restored');
    });
    await h.test('a model cannot retrieve a credential setting through Klaus query', async () => {
      const { result } = await run('klaus_query', { key: 'setting', action: 'get', arguments: { key: 'api_key' } });
      assert(JSON.stringify(result).includes('Credential values are available only to the user'), 'credential access fails before dispatch');
      assertEqual(result.is_error, true, 'the actual engine marks the refusal as a tool error');
    });
    await h.test('the real read_thread tool returns the requested existing task through the engine', async () => {
      const target = created[0]!;
      const { result } = await run('read_thread', { threadId: target, turnLimit: 1 });
      assert(!result.is_error, 'the named facade read succeeded');
      assert(JSON.stringify(result).includes(target), 'the result identifies the requested existing task');
    });

    await h.test('Goal reads and user-control refusals cross the actual dynamic-tool dispatcher', async () => {
      const resultText = (result: JsonObject): string => typeof result.content === 'string' ? result.content
        : Array.isArray(result.content) ? result.content.map(object).filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('') : '';
      const readSnapshot = (result: JsonObject): JsonObject => {
        assert(!result.is_error, 'the actual dynamic Goal read succeeded');
        return object(JSON.parse(resultText(result)) as Json);
      };
      const absent = await run('klaus_query', { key: 'goal', action: 'get' });
      const absentSnapshot = object(await invoke('goal:get', { sessionId: absent.id }) as Json);
      assertEqual(absentSnapshot.goal, null, 'the owned conversation starts without a Goal');
      assertDeepEqual(readSnapshot(absent.result), absentSnapshot, 'the real control read returns the authoritative absent snapshot');
      const accepted = object(await invoke('goal:set', { sessionId: absent.id, expectedGoalId: null,
        objective: 'Keep this user-owned Goal paused while its model control access is inspected.', status: 'paused', tokenBudget: 233 }) as Json);
      assertEqual(accepted.ok, true, 'the actual user mutation was accepted');
      const snapshot = object(await invoke('goal:get', { sessionId: absent.id }) as Json);
      assertDeepEqual(accepted.goal, snapshot.goal, 'the accepted user mutation and fresh read agree on the generation');
      assertEqual(accepted.goalRevision, snapshot.goalRevision, 'the accepted revision is durable before model inspection');
      const goal = object(snapshot.goal);
      assert(typeof goal.goalId === 'string' && goal.goalId.length > 0, 'the user control created an authoritative generation');
      assertEqual(goal.threadId, absent.id, 'the generation belongs to the actual calling conversation');
      assertEqual(goal.status, 'paused', 'the fixture admits ordinary control turns without automatic Goal pursuit');
      const policy = await invoke('session:get-permission-mode', { sessionId: absent.id });
      const present = await run('klaus_query', { key: 'goal', action: 'get' });
      assertEqual(present.id, absent.id, 'the tool context retains its actual caller');
      assertDeepEqual(readSnapshot(present.result), snapshot, 'an omitted session argument resolves to the exact current Goal snapshot');
      assert(Array.isArray(present.request.tools) && present.request.tools.map(object).some(spec => spec.name === 'klaus_query'), 'the provider receives the shipped dynamic tool definition');
      for (const action of ['set', 'clear']) {
        const attempted: JsonObject = { sessionId: absent.id, expectedGoalId: goal.goalId!, expectedGoalRevision: snapshot.goalRevision!, origin: 'user' };
        if (action === 'set') Object.assign(attempted, { objective: 'This model-supplied replacement must not become user intent.', status: 'active', submit: true, clientRequestId: randomUUID() });
        const refused = await run('klaus_action', { key: 'goal', action, arguments: attempted, confirm: true });
        assertEqual(refused.id, absent.id, 'the refusal remains correlated to the calling conversation');
        assertEqual(refused.result.is_error, true, 'the actual engine receives the control refusal as a tool error');
        assert(resultText(refused.result).includes(`Unknown write action goal.${action}.`), 'the shipped catalog refuses the action before user-control dispatch');
        assertDeepEqual(object(await invoke('goal:get', { sessionId: absent.id }) as Json), snapshot, 'model confirm and origin fields cannot change the user-owned generation or accounting');
        const saved = object(await desktop.sessions.request('session/goal', { threadId: absent.id }) as Json);
        assertEqual(saved.goalRevision, snapshot.goalRevision, 'the independent named thread read retains the authoritative revision');
        assertDeepEqual(object(saved.threadGoal), goal, 'the engine retains the complete paused Goal after the refused model write');
      }
      assertDeepEqual(await invoke('session:get-permission-mode', { sessionId: absent.id }), policy, 'the real control attempts preserve the independent permission policy');
    });

    /**
     * The spec's real-UI acceptance, run in an actual Electron window against the
     * real engine. Two claims the unit and live suites can each only prove partly:
     * the mutating tool raises a real approval CARD in the transcript (the design's
     * gate, which a headless fake client cannot show), and the delivery lands in the
     * recipient as an envelope naming the sender.
     */
    await h.test('a real send_message_to_thread raises an approval card and delivers an envelope to the recipient', async () => {
      const recipient = String(object(await invoke('session:new') as Json).id);
      created.push(recipient);
      const sender = object(await invoke('session:new') as Json), senderId = String(sender.id);
      created.push(senderId);
      const nonce = randomUUID();
      const prompt = 'Real UI delegation ' + nonce;
      const seen = new Set<string>();
      let cardTool = '';
      await invoke('chat:send', { sessionId: senderId, text: 'HOST TOOL FIXTURE ' + JSON.stringify({ tool: 'send_message_to_thread', input: { threadId: recipient, prompt }, nonce }) });
      // The approval card is the gate. Answering it is what lets the turn proceed, so
      // capture the tool name the card reports before allowing it.
      await waitFor(async () => {
        for (const entry of await records()) {
          if (entry.channel !== 'permission:request') continue;
          const card = object(entry.value), requestId = String(card.requestId);
          if (card.sessionId !== senderId || seen.has(requestId)) continue;
          seen.add(requestId); cardTool = String(card.toolName);
          await invoke('permission:respond', { requestId, decision: 'allow' });
        }
        return (await records()).some(entry => entry.channel === 'chat:event:batch'
          && Array.isArray(entry.value) && entry.value.some(value => object(value).sessionId === senderId && object(value).type === 'done'));
      }, 25_000, 'the delegated send completed');
      assertEqual(cardTool, 'send_message_to_thread', 'the approval card names the mutating tool, so a human gated the write');
      // The recipient really received it, as an envelope naming the sender, so it can
      // reply. Read the recipient's own history through the engine.
      await waitFor(async () => JSON.stringify(await invoke('session:history', { sessionId: recipient })).includes(prompt), 15_000, 'the recipient persisted the delegated prompt');
      const history = JSON.stringify(await invoke('session:history', { sessionId: recipient }));
      // The envelope MUST be in stored history, not merely the prompt: the
      // `source-thread-id` it carries is the only way the recipient can reply with
      // `send_message_to_thread`. Folding it back to prose for the human happens in
      // the renderer (`delegationEnvelopeInput` + `renderDelegationLabelHtml` for a
      // delivered user message, and the tool-output fold for one drained into a tool
      // result), which their own suites pin — so the correct assertion here is the
      // opposite of "no markup in history".
      assert(history.includes('source-thread-id'), 'history carries the sender id so a reply can find its way back');
      assert(history.includes(senderId), 'the envelope names the actual sending conversation');
    });

  } finally {
    for (const id of created) await invoke('session:delete', { sessionId: id });
  }
}
