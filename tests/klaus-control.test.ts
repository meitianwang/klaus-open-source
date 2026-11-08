import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerSettingsHandlers } from '../main/ipc/handlers/settings';
import { KlausControlService, registerKlausControlTools, KLAUS_CONTROL_SPECS, KLAUS_CONTROL_CHANNELS, delegationProtocolNote, productContextNote, validateAccelerator, type KlausControlDependencies, type ControlCallContext } from '../main/services/klaus-control';
import { CONTROL_EXCLUSIONS, CONTROL_SURFACES, NAV_SETTINGS_TABS, NAV_VIEWS } from '../main/services/klaus-control/catalog';
import { findHeading, manualHeadings, manualResult } from '../main/services/klaus-control/manual';
import { normalizePreference, PREFERENCES, takesEffect } from '../main/services/klaus-control/preferences';
import { boundedText, redact, REDACTED } from '../main/services/klaus-control/redaction';
import { kvGet, kvSnapshot, kvSet, isFailure } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';
import { runMediaControlPrivacyTests } from './klaus-control-media-privacy';

const h = new Harness(), services: KlausControlService[] = [];
const text = (value: Json): string => String(object((object(value).contentItems as Json[])[0]).text);
const root = join(__dirname, '../..');
function fixture(overrides: Partial<KlausControlDependencies> = {}, contextOverrides: Partial<ControlCallContext> = {}) {
  const calls: { channel: string; payload: JsonObject }[] = [], nav: Json[] = [];
  let current = true, unattended = false, browser = 'host-task';
  const context = (engineId: string, signal: AbortSignal): ControlCallContext => {
    assert.equal(engineId, 'engine-task');
    return { sessionId: 'host-task', unattended, signal, assertCurrent: () => { if (!current) throw new Error('Stale engine generation'); },
      currentBrowserSessionId: () => browser,
      dispatch: async (channel, payload) => { calls.push({ channel, payload }); return { ok: true }; }, ...contextOverrides };
  };
  const service = new KlausControlService({ context, manual: () => readFile(join(root, 'resources/manual/klaus-manual.md'), 'utf8'), storedRows: () => ({}),
    threadTool: async (name, payload, ctx) => { calls.push({ channel: name, payload }); assert.equal(ctx.sessionId, 'host-task'); return { success: true, contentItems: [{ type: 'inputText', text: 'thread fixture' }] }; },
    navigate: async value => { nav.push(value); }, preferencesChanged: () => {},
    quickInput: { shortcuts: () => [], card: () => ({ width: 560, height: 250 }), show: async () => ({ ok: true }), hide: async () => ({ ok: true }), setShortcut: async () => {} }, ...overrides });
  services.push(service);
  const run = (tool: string, input: Json, signal = new AbortController().signal) => service.execute(tool, input, 'engine-task', signal);
  return { service, run, calls, nav, query: (key: string, action: string, payload: JsonObject = {}) => run('klaus_query', { key, action, arguments: payload }),
    action: (key: string, action: string, payload: JsonObject = {}, confirm?: boolean) => run('klaus_action', { key, action, arguments: payload, ...(confirm === undefined ? {} : { confirm }) }),
    stale: () => { current = false; }, unattended: () => { unattended = true; }, browser: (id: string) => { browser = id; } };
}
// An unfinished top-level promise must not silently exit successfully.
process.exitCode = 1;
void (async () => {
  const directory = await mkdtemp(join(process.cwd(), '.control-unit-'));
  try {
    await runMediaControlPrivacyTests(h);
    await h.test('the catalog covers every committed invoke with an operation or an explicit exclusion', async () => {
      const contract = JSON.parse(await readFile(join(root, 'contracts/channel-table.json'), 'utf8'));
      const channels = new Set<string>(Object.values(contract.roles).flatMap((role: unknown) => object(role).invoke as string[]));
      // 407 = the prior 406 plus `chat:edit-message`. That channel is an in-place edit
      // of an ALREADY-SENT user message: it truncates the conversation from that
      // message and re-runs the edited text as a new turn,
      // leaving files on disk alone. Do not confuse it with `chat:edit-queued` —
      // editing a still-QUEUED message is a different operation that takes the row
      // back to the composer and restores it at its original position, which
      // `chat:client-queue-restore` covers.
      // 408 adds `composer:edit-focus`, which reports whether the focused
      // surface is a composer keeping its own undo history. The host needs that
      // to decide whether the platform's undo/redo keystroke belongs to the
      // composer instead of to Chromium's native stack; it carries no
      // conversational capability, so it is excluded from the control surfaces.
      // Bumped deliberately; adding or dropping a channel must move this number
      // on purpose, not silently.
      // 417 added the three `keymap:*` channels: the keyboard-shortcuts settings
      // page's own read/write/reset of keybindings.json. They are excluded from
      // the control surfaces (see CONTROL_EXCLUSIONS) because app-scope bindings
      // are the user's UI preference; the two os-global hotkeys stay reachable
      // through quickInput.setShortcut, which now writes through the same store.
      // 419 added `keymap:capture-begin`/`capture-end`: the bracket around one
      // recording, during which the host releases every registered global hotkey
      // so re-recording the currently-bound key reaches the capture field instead
      // of firing the hotkey. They are pure UI-session transport with no
      // capability of their own, so they are excluded too.
      // 418 replaces the six `blender:*` channels with the five `model3d:*` ones
      // when the 3D plugin was rewritten on an in-process WASM kernel. Like
      // digram's, they are the side panel's own surface: the agent drives the
      // same document through the `model3d_*` MCP tools, so none of them is a
      // second door into a control capability.
      // 430 adds the twelve `collaboration:*` channels behind the team
      // collaboration page. They are the page's own transport to the shared
      // service (projects, issues, discussions, members, invitations,
      // attachments, local Agent execution) plus its native pickers and the
      // user's own device-local folder binding. No agent tool exposes that
      // surface, so every one of them is excluded rather than exposed.
      // 431 was `artifacts:inline-visualization-url`, the composer's own endpoint
      // for the ::klaus-inline-vis iframe — added without moving this number, so it
      // is folded into the 433 below rather than documented as its own step.
      // 433 adds this session's two git channels behind the branch picker:
      // `git:uncommitted` (change count + the files a checkout would refuse) and
      // `git:commit-paths` (the "Commit & Switch Branch" step, which commits only
      // the files a switch would overwrite). Both are the composer's own branch
      // surface and stay reachable through klaus_action's git surface.
      // 437 adds three renderer-only run_preview state/reveal channels and the
      // Widget revision URL. The named host tools own both agent capabilities;
      // these IPC channels only project their results into the visible UI.
      // 438 adds `featureGates:snapshot`, the renderer's read of the
      // server-resolved feature gates. Eligibility is computed by the cloud
      // (allowlist/rollout in src/feature-gates.ts); an agent reading which
      // features its own account may see is not a capability, so it is
      // excluded like the collaboration channels it gates.
      // 439 adds `chat:edit-prepare`, the read-only half of the sent-message
      // edit: it answers with one user message's text and attachment paths so
      // the composer can refill itself for editing (the SEND stays
      // `chat:edit-message`). It mutates nothing and is a second door to no
      // capability, so it is excluded beside the channel it feeds.
      // 438 drops `worktree:merge`: the session menu no longer offers merging a
      // worktree branch back into the main checkout, so the host channel and
      // its control-surface write entry are gone. Merging a branch is plain
      // git the user runs themselves; the worktree surface keeps create,
      // status, remove and reveal.
      // This step adds `system:permissions:request`, the settings page's
      // explicit consent request: it presents the macOS system dialog, and
      // the answer is the user's decision, so it is excluded beside the
      // approval channels while the passive read stays a control read.
      // 445 adds the six `workbuddy-auth:*` channels behind the WorkBuddy
      // subscription card: status, the external-link login start/poll pair,
      // the catalog read, the local-login import and the logout. They are the
      // same shape as the `qwenwork-auth:*` six and are exposed as the
      // `workbuddyAuth` surface (56), so the agent can sign a conversation in
      // and read the credit balance the way it already can for QwenWork.
      // 446 adds `settings:mobile-bridge:rename-device`, the settings device
      // list's inline rename. It joins the existing `mobileBridge` surface
      // beside removeDevice, so no new surface key appears here.
      // 452 adds the six `kimi-auth:*` channels behind the Kimi membership card:
      // status, the device-flow login start/poll pair, the catalog read, the
      // logout, and `set-api-key` — the one the other subscription sources do not
      // have, because a console API key is the route Kimi documents for
      // third-party clients. There is no `import-local`: Kimi leaves no store this
      // app can read. They are exposed as the `kimiAuth` surface (57) so the agent
      // can connect a conversation and read its allowance the way it already can
      // for WorkBuddy.
      // 456 adds the four `bailian-auth:*` channels behind the Aliyun Bailian Token
      // Plan card: status, the catalog read, the logout, and `set-api-key`. Four
      // rather than six because Token Plan accepts a plan key and nothing else —
      // there is no device-flow start/poll pair and no local store to import — and
      // they are exposed as the `bailianAuth` surface (58).
      // 455 drops `settings:models:role`: tier picks for the custom source now
      // live in the same `model_tiers:custom` KV row every other source uses,
      // so the per-provider role write channel has no remaining caller.
      // 458 adds typed shared tier reads, catalog inspection and revision-checked writes.
      // 461 adds the three renderer-only file-search-session channels behind the
      // @-menu's persistent search (start/query/stop). They walk the tree once
      // and re-rank per keystroke instead of re-walking per keystroke; an agent
      // keeps using the one-shot `engine.fileSearch` read, so all three are
      // excluded from the control surface rather than exposed to it.
      // Async questions keep their renderer-only recovery/answer channels.
      // Codex Fast adds two composer channels; retiring on-device management
      // removes eight channels, leaving 456 registered invokes.
      // 460 adds the four `media:*` image-delivery channels (read/save/copy/
      // reveal) behind the UI-verification screenshot delivery work. They are
      // renderer-only transport for pictures the agent already produced — each
      // one re-validates its image grant, and the underlying capability stays
      // reachable as artifacts.read / artifacts.fileUrl — so all four are
      // excluded from the control surface rather than exposed to it.
      // 462 adds the global image-backend pair (settings:image-selection:get/
      // set): the control surface exposes them on the imageGen surface entry,
      // because choosing the backend that runs generate_image is a settings
      // write an agent may legitimately be asked to perform.
      // 463 adds the task-scoped browser tab picker read, exposed as
      // browser.mentionTabs without adding a new control surface.
      // Six friend-management channels stay in the owner UI; agents use the
      // named friend task tools without gaining friendship or grant mutations.
      // Nine additional owner-only task/resource/receiver controls complete the friend workflow.
      // The owner-only default friend grant adds one explicit UI channel.
      // 484 adds this session's five friend-card channels: the owner's own
      // add-me card read plus its save/share pair, and the camera lease pair
      // the scan dialog holds. All five stay in the owner UI (CONTROL_EXCLUSIONS);
      // none of them grants an agent anything over friendships or the camera.
      // 488 adds the four MiniMax M Plan channels (status, set-api-key, logout,
      // models): the plan takes a pasted subscription key, so there is no
      // start/poll pair as an OAuth source would have.
      // The three `bailian-auth:console-*` channels add the console session
      // login beside the plan key: the loopback login start, the stored-session
      // read the card polls, and its logout. They are exposed on the existing
      // `bailianAuth` surface, because the allowance they unlock is the same
      // account fact the surface already reports.
      // 494 adds the six `qoderwork-auth:*` channels behind the QoderWork
      // subscription card: status, the external-link login start/poll pair, the
      // catalog read, the local-login import and the logout. They are the same
      // shape as the `qwenwork-auth:*` six — two sibling products on one gateway
      // family, each with its own credential — and are exposed as the
      // `qoderworkAuth` surface (60) so an agent can sign a conversation in and
      // read its allowance the way it already can for the other sources.
      // The four `zhipu-auth:*` channels are exposed on a `zhipuAuth` surface
      // entry: reading the plan's status and model list, plus the confirm-gated
      // key write and logout beside it. This number tracks the derived contract,
      // which is regenerated from the bridge and the registered channels, so it
      // also moves with channels other in-flight work registers; whoever lands
      // last reconciles it against the regenerated table. 501 adds the two
      // `settings:video-selection:*` channels: the global video backend became its
      // own selection, mirroring the image one.
      // 514 adds the two friend directory-request channels
      // (`friends:resolve-access-request`, `friends:pending-access-requests`)
      // and the page-permission dialog's answer transport
      // (`browser-use:permission-answer`), all owner-UI surfaces excluded from
      // the control surface: an agent may ask for a directory but never approve
      // its own request, and a page permission is answered by the user alone.
      // 515 adds `settings:web-search-sources:get`, the web settings page's
      // login-state read for the subscription search sources (excluded: each
      // source's status is already a control read on its auth surface).
      // 519 adds the four `settings:audio-gen:*` and `settings:audio-selection:*`
      // channels: the global audio backend became its own selection and endpoint
      // config, mirroring the video one.
      // 520 adds the native multi-directory picker; 521 adds plugin updates.
      // The inventory gains one renderer-only manual child-message channel.
      // 523 adds `projects:reorder`, the sidebar's own drag-reorder transport:
      // it persists the user's hand-arranged Projects order (workspace
      // containers, friend groups and plain projects in one list). An agent has
      // no reason to rearrange the user's sidebar and the project facts stay
      // reachable through the project surface, so it is excluded
      // (CONTROL_EXCLUSIONS) rather than exposed.
      // 524 adds the public, read-only application distribution on the app surface.
      // 525 reconciles `artifacts:save-copy`, which the transcript's file-citation
      // commit registered and derived into the table without touching this
      // inventory: it is an owner-UI save dialog, so it joins CONTROL_EXCLUSIONS.
      // 526 adds `friends:ignore`, the owner's quiet set-aside for pending friend
      // task requests (one task, one friend's backlog, or the whole inbox). Like
      // its reject sibling it is an owner-UI decision excluded from the control
      // surface: an agent may never set the owner's incoming requests aside.
      // The count drops back to 525 when `artifacts:inline-visualization-url`
      // retires: the transcript's pages now travel inside projected history
      // blocks, so the renderer transport has no reader left.
      // Retiring two source channels leaves 523 invokes; website opening adds
      // target discovery and an explicit opening action. Dropping the two
      // `chat:undo-turn-files*` channels with the per-turn change card's undo
      // button takes the total back to 523: the card no longer offers a
      // workspace restore, so neither the preview read nor the destructive
      // write has a caller left. Removing the manual subagent message channel
      // drops one more invoke: the subagent detail view is read-only and the
      // parent model keeps its own agent messaging tools.
      // Workspace filtering and power lifecycle add four renderer-only invokes.
      // The existing inventory includes four owner composer suggestion channels.
      // The companion owns 58 renderer transports for its panel, request
      // answers, attachment grants and voice lifecycle without model authority.
      // Cursor adds status, concrete model discovery, local import and disconnect.
      // Browser authorization adds start, poll and cancel to the Cursor source.
      // Large pasted-text references add four owner composer transports.
      // Planning, objective preparation and structured question transports are deliberate new channels.
      // Web page reading exposes source availability independently of search.
      // Approval review adds one owner approval transport.
      // Scoped configuration adds two owner settings channels for snapshots and opening the selected file.
      // Music selection and model preferences add four independent settings channels.
      // Saved app details/removal add two invokes to the current account-source inventory.
      // Direct friend delivery adds one owner transport.
      // Failed-send retry and local assistance add two owner-only transports.
      // Auxiliary task model picks add two settings channels exposed on the
      // featureModels surface: `settings:feature-models:get/set`.
      // 706 is the inventory the committed contract already declared when this
      // count was last reconciled. Friend drafts added four owner-only transports:
      // resolving and recovering a drafted message's confirmation, the
      // per-friend confirmation preference and the request that Klaus reply to a
      // task that closed without one. Friend messages now follow the
      // conversation's permission mode, so the three confirmation transports are
      // gone again and only the reply request remains.
      // 715 adds the eight `settings:computer-history:*` channels: the local
      // environment-history settings tab's own transport (status, enable,
      // pause/resume, observation-policy edits, clear and timeline paging).
      // They are the owner settings surface for a strictly local ledger, so
      // they are excluded from the control surfaces like the computer-use
      // settings picker channels.
      // 758 reconciles with the committed contract: the inventory had already
      // grown from 707 to 750 through other surfaces' channels (browser
      // profile/runtime settings and side-chat transports) without this gate
      // being re-run; the eight computer-history channels bring it to 758.
      // 760 adds the sub-agent plaza's two channels: `agents:market` (browse what
      // the server publishes, each row carrying this machine's installed/hasUpdate
      // state) and `agents:install` (write one entry into ~/.klaus/agents/ through
      // the SAME writer as agents:definitions:save, so there is no second path into
      // an agent file). Both are exposed on the existing `agents` surface — the
      // plaza is a capability the agent may drive, not owner-only UI. There is
      // deliberately no plaza uninstall: an installed agent is an ordinary user
      // file, so removal stays `delete` and there is one trash behaviour.
      assert.equal(channels.size, 760);
      const companionChannels = [...channels].filter(channel => channel.startsWith('desktop-pet:'));
      assert.equal(companionChannels.length, 58);
      for (const channel of companionChannels) {
        assert(CONTROL_EXCLUSIONS[channel], channel);
        assert(!KLAUS_CONTROL_CHANNELS.includes(channel), channel);
      }
      for (const channel of ['composer:prediction', 'composer:prediction:source', 'composer:prediction:availability', 'composer:prediction:cancel']) {
        assert(channels.has(channel), channel);
        assert(CONTROL_EXCLUSIONS[channel], channel);
        assert(!KLAUS_CONTROL_CHANNELS.includes(channel), channel);
      }
      for (const channel of ['friends:send-message', 'friends:retry-send', 'friends:prepare-local-assist']) {
        assert(channels.has(channel), channel);
        assert(CONTROL_EXCLUSIONS[channel], channel);
        assert(!KLAUS_CONTROL_CHANNELS.includes(channel), channel);
      }
      assert(channels.has('friends:set-default-grant'));
      assert(CONTROL_EXCLUSIONS['friends:set-default-grant']);
      assert(!KLAUS_CONTROL_CHANNELS.includes('friends:set-default-grant'));
      assert(channels.has('friends:set-remark'));
      assert(CONTROL_EXCLUSIONS['friends:set-remark']);
      assert(!KLAUS_CONTROL_CHANNELS.includes('friends:set-remark'));
      assert(channels.has('friends:ignore'));
      assert(CONTROL_EXCLUSIONS['friends:ignore']);
      assert(!KLAUS_CONTROL_CHANNELS.includes('friends:ignore'));
      for (const channel of channels) assert(KLAUS_CONTROL_CHANNELS.includes(channel) || CONTROL_EXCLUSIONS[channel], channel);
      for (const channel of KLAUS_CONTROL_CHANNELS) assert(channels.has(channel), channel);
      for (const channel of Object.keys(CONTROL_EXCLUSIONS)) assert(!KLAUS_CONTROL_CHANNELS.includes(channel), channel);
      for (const channel of ['friends:list', 'friends:lookup', 'friends:request', 'friends:respond', 'friends:set-authorization', 'friends:remove']) {
        assert(channels.has(channel), channel);
        assert(CONTROL_EXCLUSIONS[channel], channel);
        assert(!KLAUS_CONTROL_CHANNELS.includes(channel), channel);
      }
      // The global image backend adds its own surface (58) beside imageGen:
      // selecting which backend runs generate_image is a distinct operation
      // from configuring the custom endpoint. The QoderWork subscription card
      // adds `qoderworkAuth` (60), Coding Plan adds `zhipuAuth` (61), and the
      // global video backend adds `videoSelection` (62) beside videoGen.
      // Volcengine Ark plan adds `arkAuth` (63) — the same channel shape: status
      // and model-list reads beside the confirm-gated key write and logout, plus
      // the console-session trio that unlocks the allowance figures. The global
      // audio backend adds `audioSelection` (64) beside `audioGen` (65), the same
      // shape as the video pair: a selection surface and an endpoint-config surface.
      // Cursor adds its account snapshot and concrete catalog surface (66).
      // Music adds independent selection and native model preference surfaces (68).
      // Each new account source owns its explicit authentication surface.
      // Auxiliary task model picks add `featureModels` (72) beside the advisor.
      assert.equal(new Set(CONTROL_SURFACES.map(surface => surface.key)).size, 72);
    });
    await h.test('model control cannot grant itself preview access or acquire the owner activity projection', async () => {
      const preview = JSON.parse(await readFile(join(root, 'contracts/vectors/artifact-preview-access-vectors.json'), 'utf8')).controlAccess;
      for (const channel of [preview.channel, 'profile:activity']) {
        assert(CONTROL_EXCLUSIONS[channel], channel);
        assert(!KLAUS_CONTROL_CHANNELS.includes(channel), channel);
      }
      const f = fixture();
      for (const action of preview.deniedActions) {
        assert.equal(object(await f.action('artifact', action, { sessionId: 'another-task', filePath: '/outside/report.md' }, true)).success, false);
        assert.equal(object(await f.query('artifact', action, { filePath: '/outside/report.md' })).success, false);
      }
      assert.equal(object(await f.query('account', 'activity')).success, false);
      for (const channel of [preview.channel, 'profile:activity']) {
        assert.equal(object(await f.run('klaus_action', { channel, arguments: { filePath: '/outside/report.md' }, confirm: true })).success, false);
      }
      assert.deepEqual(f.calls, []);
      assert.equal(object(await f.query('artifact', 'read', { filePath: '/workspace/report.md' })).success, true);
      assert.deepEqual(f.calls, [{ channel: 'artifacts:read', payload: { filePath: '/workspace/report.md', sessionId: 'host-task' } }]);
    });
    await h.test('configuration is the only settings destination for the retired sandbox surface', async () => {
      assert(NAV_SETTINGS_TABS.includes('preferences'));
      assert(!NAV_SETTINGS_TABS.includes('sandbox'));
      assert(!CONTROL_SURFACES.some(surface => surface.key === 'sandbox'));
      for (const suffix of ['check', 'cancel', 'readiness', 'setup-start', 'setup-cancel']) {
        assert(!KLAUS_CONTROL_CHANNELS.includes('settings:klaus-sandbox:' + suffix));
      }
    });
    await h.test('model control cannot acquire owned companion input, microphone, approval or attachment authority', async () => {
      const f = fixture();
      for (const action of ['set-regions', 'start-voice', 'respond-task', 'pick-attachments', 'import-url']) {
        assert.equal(object(await f.action('desktop-pet', action, { taskId: 'host-task', requestId: 'pending-owner-request', decision: 'allow' }, true)).success, false);
        assert.equal(object(await f.run('klaus_action', { channel: `desktop-pet:${action}`, arguments: {} })).success, false);
      }
      assert.equal(object(await f.query('desktop-pet', 'get-state')).success, false);
      assert.deepEqual(f.calls, []);
    });
    await h.test('model control cannot claim manual subagent restart authority', async () => {
      const f = fixture();
      const result = await f.action('agents', 'sendMessage', { sessionId: 'host-task', agentId: 'child', message: 'Continue', userInitiated: true });
      assert.equal(object(result).success, false);
      assert.deepEqual(f.calls, []);
    });
    await h.test('both tool definitions register and only the query is declared read-only', async () => {
      const f = fixture(), registrations: Json[] = [];
      registerKlausControlTools({ register: (spec, handler) => { registrations.push(spec); assert.equal(typeof handler, 'function'); } }, f.service);
      assert.deepEqual(registrations, KLAUS_CONTROL_SPECS);
      assert.equal(object(registrations[0]).readOnly, true); assert.equal(object(registrations[1]).readOnly, false);
      assert.match(productContextNote('win32'), /Windows/); assert(!productContextNote('win32').includes('macOS'));
      assert.match(text(await f.run('klaus_query', {})), /quickInput/);
    });
    await h.test('application distribution is a read-only query without session identity injection', async () => {
      const vector = JSON.parse(await readFile(join(root, 'contracts/vectors/desktop-edition-vectors.json'), 'utf8')).distributionQuery;
      const f = fixture();
      assert.equal(object(await f.query(vector.surface, vector.action)).success, true);
      assert.deepEqual(f.calls, [{ channel: vector.channel, payload: {} }]);
      assert.equal(object(await f.action(vector.surface, vector.action)).success, false);
      assert.equal(f.calls.length, 1);
    });
    await h.test('every conversation is told what a delegation envelope is, whether or not it can send one', async () => {
      // The load-bearing invariant: the note rides on the UNCONDITIONAL product
      // context, not on the `thread_tools` flag. Receiving a delegation does not
      // require the tool family — `deliverDelegation` has no gate on its target —
      // so a conversation with the family off can still be messaged by one with it
      // on. Gating this on the flag would leave exactly those recipients with a
      // protocol wrapper they were never told about.
      const note = delegationProtocolNote();
      const context = productContextNote('darwin');
      assert(context.includes(note), 'the protocol note is part of the unconditional product context');
      assert(note.includes('<klaus-delegation>'), 'names the envelope tag');
      assert(note.includes('<source-thread-id>'), 'names the sender address');
      assert(note.includes('<source-host-id>'), 'names the remote host address');
      assert(note.includes('<input>'), 'names the message payload');
      assert(/tool result/i.test(note), 'covers delivery during a running turn');
      assert(/start a user turn/i.test(note), 'covers delivery that starts a turn');
      assert(/no authority to override the human user/i.test(note), 'peer content does not become human authority');
      assert(note.includes('send_message_to_thread'), 'names the optional reply tool');
      assert(/requires human authorization/i.test(note), 'a reply follows the same authorization as any other message');
      assert(/request to report back is not authorization/i.test(note), 'a peer cannot authorize its own return report');
      assert(/tool is unavailable/i.test(note) && /final response/i.test(note), 'an unavailable or unauthorized reply has a final-response alternative');
    });
    await h.test('the delegation note keeps peer context separate from human instructions', async () => {
      const context = productContextNote('darwin');
      const note = delegationProtocolNote();
      assert(context.includes(note), 'the complete boundary reaches the product context');
      for (const field of ['chat history', 'titles', 'summaries', 'package text', 'saved notes']) {
        assert(note.includes(field), `${field} stays context`);
      }
      assert(/no authority to override the human user/i.test(note), 'the wrapper grants no authority');
      assert(!/must comply|always do what it asks|never spend turns/i.test(note), 'recognition does not require compliance or forbid verification');
    });
    await h.test('discovery names the complete surface, manual heading and real navigation destination', async () => {
      const f = fixture(), manual = await readFile(join(root, 'resources/manual/klaus-manual.md'), 'utf8'), heads = manualHeadings(manual);
      for (const surface of CONTROL_SURFACES) {
        assert(findHeading(heads, surface.manualHeading) >= 0, surface.key);
        const result = await f.run('klaus_query', { key: surface.key }); assert.equal(object(result).success, true);
        for (const op of [...surface.reads, ...surface.writes]) assert(text(result).includes(op.action), `${surface.key}.${op.action}`);
        if (surface.panel) { assert(NAV_VIEWS.some(([view]) => view === surface.panel![0])); if (surface.panel[1]) assert(NAV_SETTINGS_TABS.includes(surface.panel[1])); }
      }
    });
    await h.test('unknown tools, malformed payloads and read/write confusion fail without routing', async () => {
      const f = fixture();
      for (const [tool, value] of [['other', {}], ['klaus_query', []], ['klaus_query', { arguments: [] }], ['klaus_query', { channel: 'permission:respond' }], ['klaus_action', { key: 'cron', action: 'list' }], ['klaus_query', { key: 'cron', action: 'delete' }]] as [string, Json][]) assert.equal(object(await f.run(tool, value)).success, false);
      assert.equal(f.calls.length, 0);
    });
    await h.test('all confirm-gated actions require user agreement and remain denied in scheduled runs', async () => {
      const f = fixture();
      for (const surface of CONTROL_SURFACES) for (const op of surface.writes.filter(op => op.confirm)) assert.equal(object(await f.action(surface.key, op.action)).success, false, `${surface.key}.${op.action}`);
      assert.equal(f.calls.length, 0);
      assert.equal(object(await f.action('project', 'remove', { id: 'fixture' }, true)).success, true);
      f.calls.length = 0; f.unattended();
      for (const surface of CONTROL_SURFACES) for (const op of surface.writes.filter(op => op.confirm)) assert.equal(object(await f.action(surface.key, op.action, {}, true)).success, false);
      assert.equal(f.calls.length, 0); assert.equal(object(await f.query('cron', 'list')).success, true);
    });
    await h.test('only actions scoped to the calling task receive its host identity', async () => {
      const f = fixture(); await f.query('engine', 'contextStats'); await f.action('session', 'rename', { sessionId: 'other', title: 'renamed' }); await f.action('session', 'setWorkdir', { dir: directory });
      assert.deepEqual(f.calls, [
        { channel: 'engine:contextStats', payload: { sessionId: 'host-task' } },
        { channel: 'session:rename', payload: { sessionId: 'other', title: 'renamed' } },
        { channel: 'session:set-workdir', payload: { sessionId: 'host-task', dir: directory } },
      ]);
    });
    await h.test('workspace search scopes queries and retains result truncation metadata', async () => {
      const calls: { channel: string; payload: JsonObject }[] = [];
      const result: JsonObject = { hits: [{ rel: join(directory, 'match.ts'), name: 'match.ts', isDir: false }], truncated: true };
      const f = fixture({}, { dispatch: async (channel, payload) => { calls.push({ channel, payload }); return result; } });
      assert.deepEqual(JSON.parse(text(await f.query('workspace', 'search', { query: '  MaTcH  ' }))), result);
      assert.deepEqual(JSON.parse(text(await f.query('workspace', 'search', { sessionId: 'other-task', query: 'match' }))), result);
      assert.deepEqual(calls, [
        { channel: 'workspace:search', payload: { sessionId: 'host-task', query: '  MaTcH  ' } },
        { channel: 'workspace:search', payload: { sessionId: 'other-task', query: 'match' } },
      ]);
      assert.equal(object(await f.action('workspace', 'search', { query: 'match' })).success, false);
      assert.equal(calls.length, 2, 'a read operation must not dispatch through the action tool');
    });
    await h.test('session aliases use bounded thread tools without activating or loading UI history', async () => {
      const f = fixture(); await f.query('session', 'history', { sessionId: 'target', cursor: 'next', turnLimit: 2 }); await f.query('session', 'list', { limit: 3 }); await f.query('session', 'listArchived');
      assert.deepEqual(f.calls, [ { channel: 'read_thread', payload: { threadId: 'target', cursor: 'next', turnLimit: 2 } }, { channel: 'list_threads', payload: { limit: 3 } }, { channel: 'list_archived_threads', payload: {} } ]);
    });
    await h.test('navigation validates view and tab before sending its actual push request', async () => {
      const f = fixture();
      for (const payload of [{ view: 'terminal' }, { view: 'chat', tab: 'models' }, { view: 'settings', tab: 'shortcut' }] as JsonObject[]) assert.equal(object(await f.action('nav', 'open', payload)).success, false);
      assert.deepEqual(f.nav, []); assert.equal(object(await f.action('nav', 'open', { view: 'settings', tab: 'models' })).success, true);
      assert.deepEqual(f.nav, [{ view: 'settings', tab: 'models' }]);
      const denied = fixture({ navigate: async () => { throw new Error('Renderer delivery was not acknowledged'); } });
      assert.equal(object(await denied.action('nav', 'open', { view: 'skills' })).success, false);
    });
    await h.test('browser reads cannot mutate tabs and background callers cannot drive a different visible task', async () => {
      const f = fixture(); assert.equal(object(await f.query('browser', 'tabs', { action: 'new', url: 'https://invalid.test' })).success, false);
      assert.equal(f.calls.length, 0); await f.query('browser', 'tabs'); assert.equal(f.calls[0]!.payload.action, 'list');
      f.calls.length = 0; f.browser('another-task');
      for (const action of ['navigate', 'back', 'forward', 'reload', 'stop', 'screenshot', 'show', 'hide']) assert.equal(object(await f.action('browser', action, { url: 'about:blank' })).success, false);
      assert.equal(f.calls.length, 0); await f.query('browser', 'config'); assert.equal(f.calls[0]!.channel, 'settings:browser-use:get');
    });
    await h.test('credentials remain private across fields, holders, arguments, serialized data and URL carriers', () => {
      const result = redact({ apiKey: 'fixture-key', inputTokens: 100, token: '', config: { env: { GH_PAT: 'fixture-env' } },
        args: ['--api-key', 'fixture-arg', '--password=fixture-password', 'sk-fixture-prefix'],
        serialized: JSON.stringify({ refreshToken: 'fixture-refresh', client_identity: 'fixture-serialized-identity', code_verifier: 'fixture-pkce' }), clientIdentity: 'fixture-request-identity', requestProof: { 'x-cursor-checksum': 'fixture-request-checksum' }, url: 'https://user:fixture-pass@fixture.test/path?access_token=fixture-access&clientIdentity=fixture-url-identity&verifier=fixture-query-pkce&mode=read' });
      const text = JSON.stringify(result);
      for (const secret of ['fixture-key', 'fixture-env', 'fixture-arg', 'fixture-password', 'sk-fixture-prefix', 'fixture-refresh', 'fixture-pass', 'fixture-access', 'fixture-serialized-identity', 'fixture-request-identity', 'fixture-request-checksum', 'fixture-url-identity', 'fixture-pkce', 'fixture-query-pkce']) assert(!text.includes(secret), secret);
      assert.equal(object(result).inputTokens, 100); assert.equal(object(result).token, ''); assert(text.includes('mode=read'));
    });
    await h.test('thread aliases apply the same credential boundary to serialized history replies', async () => {
      const f = fixture({ threadTool: async () => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ title: 'fixture history', output: { apiKey: 'fixture-history-key' } }) }] }) });
      const reply = text(await f.query('session', 'history', { sessionId: 'target' }));
      assert(reply.includes('fixture history')); assert(!reply.includes('fixture-history-key')); assert(reply.includes(REDACTED));
    });
    await h.test('command text and error messages cannot expose inline authentication carriers', () => {
      for (const value of [
        'server reported Bearer fixture-bearer.value',
        'curl -H "Authorization: token fixture-header" https://fixture.test',
        'run API_KEY="fixture assignment" command',
        'upstream denied ghp_fixturetoken',
        'X-Cursor-Checksum: fixture-inline-checksum',
        'run clientIdentity=fixture-inline-identity command',
      ]) {
        const filtered = String(redact(value)); assert(filtered.includes(REDACTED));
        for (const secret of ['fixture-bearer.value', 'fixture-header', 'fixture assignment', 'ghp_fixturetoken', 'fixture-inline-checksum', 'fixture-inline-identity']) assert(!filtered.includes(secret));
      }
      assert.equal(redact('MODE=read command'), 'MODE=read command');
    });
    await h.test('secret setting requests are refused before the store is read and raw writes cannot bypass preference gates', async () => {
      const f = fixture();
      assert.equal(object(await f.query('setting', 'get', { key: 'BRAVE_API_KEY' })).success, false);
      for (const key of ['composer.permission_mode', 'composer.main_model', 'composer.thinking_level', 'global_shortcut', 'theme']) assert.equal(object(await f.action('setting', 'set', { key, value: 'anything' }, true)).success, false);
      assert.equal(f.calls.length, 0);
    });
    await h.test('valid preference changes use the real SQLite handler and notify after durable storage', async () => {
      const registry = new ChannelRegistry(), changed: string[] = [];
      registerSettingsHandlers(registry, { configRoot: directory, request: async () => { throw new Error('Unexpected engine call'); }, onSettingsChanged: key => { changed.push(key); } });
      const f = fixture({ storedRows: () => { const value = kvSnapshot(directory); if (isFailure(value)) throw new Error(value.message); return value; }, preferencesChanged: key => { assert.notEqual(kvGet(key, directory), null); } }, {
        dispatch: async (channel, payload) => registry.lookup(channel)!({ channel, role: 'main', senderId: 10, args: [payload] }),
      });
      assert.equal(object(await f.action('preference', 'set', { name: 'theme', value: 'dark' })).success, true);
      assert.equal(kvGet('theme', directory), 'dark'); assert.deepEqual(changed, ['theme']);
      assert.equal(object(await f.action('preference', 'set', { name: 'uiFontSize', value: 100 })).success, false);
      assert.equal(kvGet('appearance.ui_font_size', directory), null);
      kvSet('mobile.token', 'fixture-private-token', directory);
      const snapshot = text(await f.query('setting', 'list')); assert(!snapshot.includes('fixture-private-token')); assert(snapshot.includes(REDACTED));
    });
    await h.test('follow-up mode round-trips queue and steer while invalid values leave storage unchanged', async () => {
      const registry = new ChannelRegistry(), changed: string[] = [];
      registerSettingsHandlers(registry, { configRoot: directory, request: async () => { throw new Error('Unexpected engine call'); }, onSettingsChanged: key => { changed.push(key); } });
      const f = fixture({}, { dispatch: async (channel, payload) => registry.lookup(channel)!({ channel, role: 'main', senderId: 10, args: [payload] }) });
      const pref = PREFERENCES.find(row => row.name === 'followUpMode')!;
      assert.equal(pref.unset, 'queue', 'the existing default remains queue');
      assert.equal(kvGet('follow_up_queue_mode', directory), null);
      assert.match(text(await f.query('preference', 'get', { name: 'followUpMode' })), /queue/);
      for (const value of ['steer', 'queue']) {
        assert.equal(object(await f.action('preference', 'set', { name: 'followUpMode', value })).success, true);
        assert.equal(kvGet('follow_up_queue_mode', directory), value);
        assert.match(text(await f.query('preference', 'get', { name: 'followUpMode' })), new RegExp(value));
      }
      for (const value of ['start-or-steer', '', 'invalid', true, 1, null, {}] as Json[]) {
        assert.equal(object(await f.action('preference', 'set', { name: 'followUpMode', value })).success, false);
        assert.equal(kvGet('follow_up_queue_mode', directory), 'queue', 'invalid preference never reaches storage');
      }
      assert.deepEqual(changed, ['follow_up_queue_mode', 'follow_up_queue_mode'], 'only valid writes notify');
    });
    await h.test('retired private sandbox preferences cannot be read or changed', async () => {
      const f = fixture();
      for (const name of ['sandbox', 'sandboxNetwork', 'sandboxRequireReal', 'confineReads', 'writableRoots', 'readableRoots']) {
        assert.equal(PREFERENCES.some(pref => pref.name === name), false);
        assert.equal(object(await f.action('preference', 'set', { name, value: 'on' }, true)).success, false);
        assert.equal(object(await f.query('preference', 'get', { name })).success, false);
      }
      assert.equal(f.calls.length, 0);
      assert.equal(PREFERENCES.find(pref => pref.name === 'autoMemory')!.unset, 'off');
    });
    await h.test('the thread_tools switch defaults on, needs no agreement, and reports when it takes effect', async () => {
      const pref = PREFERENCES.find(entry => entry.name === 'threadTools');
      assert.ok(pref, 'the preference is registered');
      assert.equal(pref!.row, 'thread_tools.enabled', 'the row the host reads through threadToolsEnabled');
      // Default ON. This deliberately diverges from Codex, whose `thread_tools`
      // flag is a rollout gate read as `=== true` (absent means off): the three
      // read tools shipped here unconditionally registered, so defaulting off would
      // withdraw a released capability rather than gate a new one. Turning it OFF is
      // not a protection reduction either way — the conversation-mutating tools keep
      // their per-call approval prompt regardless of the family switch.
      assert.equal(pref!.unset, 'on');
      assert.equal(pref!.values.kind, 'switch');
      // Its effect timing differs from every `klaus.*` row: tool specs are injected
      // at session start, so an already-open conversation keeps the tools it was
      // given. The generic "next turn" wording would be false here.
      const wording = takesEffect(pref!.row);
      assert.match(wording, /New conversations/i);
      assert.match(wording, /already-open ones keep the tools/);
      assert.notEqual(wording, takesEffect('klaus.swarm'), 'deliberately not the klaus.* next-turn wording');
      assert.equal(normalizePreference(pref!, 'on'), 'on');
      assert.equal(normalizePreference(pref!, 'off'), 'off');
      assert.throws(() => normalizePreference(pref!, 'maybe'), /threadTools accepts/);

      // And it is settable through the control surface WITHOUT confirm, routing to
      // the row the host reads. This fixture's dispatch records rather than writes,
      // so the claim is about what was dispatched; the test above ('valid preference
      // changes use the real SQLite handler') covers the durable write itself.
      const f = fixture();
      assert.equal(object(await f.action('preference', 'set', { name: 'threadTools', value: 'off' })).success, true,
        'no confirm gate on a feature toggle');
      const dispatched = f.calls.find(call => call.payload.key === 'thread_tools.enabled');
      assert.ok(dispatched, 'the set routed to the row threadToolsEnabled reads');
      assert.equal(dispatched!.payload.value, 'off');
      assert.equal(dispatched!.channel, 'settings:kv:set');
    });
    await h.test('pre-authorization, allowed apps and hooks require agreement', async () => {
      const f = fixture();
      for (const [key, action] of [['permission', 'addRule'], ['permission', 'deleteRule'], ['computerUse', 'addAllowedApp'], ['hook', 'set'], ['hook', 'setProject']]) {
        assert.equal(object(await f.action(key!, action!)).success, false);
        assert.equal(object(await f.action(key!, action!, {}, true)).success, true);
      }
    });
    await h.test('soft failures never become successful action prose and external text is marked untrusted', async () => {
      const f = fixture({}, { dispatch: async () => ({ ok: false, error: 'Fixture storage failed' }) });
      assert.equal(object(await f.action('skill', 'toggle', { name: 'test', enabled: true })).success, false);
      assert.match(text(await fixture().query('plugin', 'market')), /\[untrusted content\]/);
    });
    await h.test('global accelerators reject swallowed typing keys and report actual registration failure', async () => {
      for (const value of ['K', 'Shift+K', 'CommandOrControl+', 'Alt+InventedKey']) assert.throws(() => validateAccelerator(value));
      for (const value of ['Alt+Space', 'CommandOrControl+Shift+K', 'Control+Alt+Period']) assert.doesNotThrow(() => validateAccelerator(value));
      const f = fixture(); assert.equal(object(await f.action('quickInput', 'setShortcut', { which: 'main', accelerator: 'K' })).success, false); assert.equal(f.calls.length, 0);
      assert.equal(object(await f.action('quickInput', 'setShortcut', { which: 'main', accelerator: 'default' })).success, false);
      const g = fixture({ quickInput: { shortcuts: () => [{ slot: 'main', active: 'CommandOrControl+Shift+K' }], card: () => ({}), show: async () => ({ ok: false, error: 'focus refused' }), hide: async () => ({ ok: true }), setShortcut: async () => {} } });
      assert.equal(object(await g.action('quickInput', 'setShortcut', { which: 'main', accelerator: 'default' })).success, true);
      assert.equal(object(await g.action('quickInput', 'showCard')).success, false);
    });
    await h.test('manual sections and searches stay bounded at UTF-8 boundaries', () => {
      const manual = '# Root\n## One\nhello\n### Child\nworld\n## Two\nnext';
      assert.match(text(manualResult(manual, 'section', { name: 'one' })), /Child/); assert(!text(manualResult(manual, 'section', { name: 'one' })).includes('next'));
      assert.match(text(manualResult(manual, 'search', { query: 'world' })), /Child/);
      const limited = boundedText('中'.repeat(9000)); assert(!limited.includes('\ufffd')); assert.match(limited, /truncated/);
    });
    await h.test('cancellation and close wait for the real handler, reject its late reply and block new calls', async () => {
      let finish!: () => void, started = false;
      const f = fixture({}, { dispatch: async () => { started = true; await new Promise<void>(resolve => { finish = resolve; }); return { ok: true }; } });
      const call = f.action('skill', 'toggle', { name: 'test', enabled: true }); await waitFor(() => started, 1000, 'handler start');
      let drained = false; const close = f.service.close().then(() => { drained = true; });
      await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
      finish(); assert.equal(object(await call).success, false); await close; assert.equal(drained, true);
      assert.equal(object(await f.query('app', 'capabilities')).success, false);
    });
    await h.test('generation changes during a read prevent later preference writes', async () => {
      let complete!: () => void;
      const f = fixture({ manual: async () => { await new Promise<void>(resolve => { complete = resolve; }); return '# Manual'; } });
      const call = f.query('docs', 'outline'); await waitFor(() => !!complete, 1000, 'manual start'); f.stale(); complete();
      assert.equal(object(await call).success, false); assert.equal(object(await f.action('preference', 'set', { name: 'theme', value: 'dark' })).success, false); assert.equal(f.calls.length, 0);
    });
  } finally { await Promise.all(services.map(service => service.close())); await rm(directory, { recursive: true, force: true }); }
  process.exitCode = await h.finish(join(__dirname, 'klaus-control-result.json'), 'klaus-control');
})();
