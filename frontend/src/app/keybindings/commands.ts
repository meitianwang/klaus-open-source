// Every renderer command shares one action across shortcuts, the command menu,
// and native menus. Surface-specific handlers take precedence over these fallback
// handlers. An absent action returns false so unavailable commands stay inactive.

import { registerFallbackCommandHandler } from './dispatcher';
import { refreshKeybindingRuntime } from './runtime';
import { registry } from './state';

function actions(): Record<string, ((arg?: any) => void) | undefined> {
  return (window as any).klausKeybindingActions ?? {};
}

/** Call an action by name if the shell exposes it; report whether it ran. */
function runAction(name: string, arg?: unknown): boolean {
  const action = actions()[name];
  if (typeof action !== 'function') return false;
  try {
    action(arg);
    return true;
  } catch {
    return false;
  }
}

const SIMPLE_COMMANDS = [
  'newProject', 'navigateBack', 'navigateForward', 'previousTab', 'nextTab',
  'findInThread', 'closeContentFind',
  'newBrowserTab', 'focusBrowserAddressBar', 'reloadBrowserPage',
  'newChat', 'openFolder', 'renameThread', 'archiveThread', 'toggleThreadPin',
  'forkThread', 'previousThread', 'nextThread', 'nextThreadNeedingAttention', 'openCommandMenu', 'searchFiles',
  'toggleSidebar', 'toggleWorkPanel', 'toggleTerminal', 'toggleFilesPanel',
  'toggleChangesPanel', 'toggleOverviewPanel', 'toggleBrowserPanel',
  'settings', 'keyboardShortcuts', 'openSkills', 'openSlashCommands', 'openAgents',
  'openMcp', 'openPlugins', 'openChannels', 'openCron', 'openMemory',
  'showKeyboardShortcuts', 'logOut',
] as const;

/**
 * Install every fallback handler. Called once during app boot, after the chat
 * shell has populated `window.klausKeybindingActions`. Idempotent.
 */
let installed = false;
export function installCommandHandlers(): void {
  if (installed) return;
  installed = true;

  for (const commandId of SIMPLE_COMMANDS) {
    // Only register commands the registry actually knows, so a typo here fails
    // the duplicate-id check rather than silently binding nothing.
    if (!registry.has(commandId)) continue;
    registerFallbackCommandHandler(commandId, () => runAction(commandId));
  }

  // ⌘1–9 select a chat by its sidebar position.
  for (let index = 1; index <= 9; index += 1) {
    const commandId = `thread${index}`;
    if (!registry.has(commandId)) continue;
    registerFallbackCommandHandler(commandId, () => runAction('sessionAt', index - 1));
  }

  // Composer voice toggle is owned by voice.ts; it registers its own handler
  // there (see mountComposerVoiceCommand), so it is intentionally absent here.

  // The keymap runtime gates dispatch on "has a handler"; now that every command
  // has one, rebuild so the listeners attach.
  refreshKeybindingRuntime();
}
