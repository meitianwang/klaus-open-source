import type { MenuItem, MenuItemConstructorOptions } from 'electron';
import type { NativeMenuState } from '../../contracts/native-menu-state';
import type { NativeMenuLabels } from './native-menu-labels';

interface ApplicationMenuOptions {
  name: string;
  labels: NativeMenuLabels;
  state: NativeMenuState;
  command(id: string): MenuItemConstructorOptions;
  editMenu: MenuItem | MenuItemConstructorOptions;
  update: MenuItemConstructorOptions;
  newWindow(): void;
  mini: { accelerator?: string; click(): void };
  zoom(command: 'fit' | 'in' | 'out'): void;
  findNavigation?(direction: 'next' | 'previous'): void;
  development: boolean;
  support: Record<'documentation' | 'whatsNew' | 'troubleshooting' | 'status' | 'feedback' | 'taskManager' | 'trace', () => void>;
  trace: { state: string; enabled: boolean };
}

/** Every role keeps its native behavior while labels follow the application's locale. */
export function applicationMenuTemplate(options: ApplicationMenuOptions): Array<MenuItemConstructorOptions | MenuItem> {
  const { name, labels, state, command, support } = options;
  const separator = (): MenuItemConstructorOptions => ({ type: 'separator' });
  const application = (key: keyof NativeMenuLabels['application']) => labels.application[key].replace('{appName}', name);
  const gated = (id: keyof NativeMenuState, commandId: string = id) => ({ ...command(commandId), enabled: state[id] });
  const hidden = (id: string) => ({ ...command(id), visible: false, acceleratorWorksWhenHidden: true });
  const help = (id: Exclude<keyof ApplicationMenuOptions['support'], 'trace'>) => ({ label: labels.support[id], click: support[id] });
  const traceLabels: Record<string, string> = { idle: labels.support.startTrace, starting: labels.support.startingTrace,
    recording: labels.support.stopTrace, stopping: labels.support.stoppingTrace, saving: labels.support.savingTrace };
  return [
    { label: name, submenu: [
      { role: 'about', label: application('about') }, separator(),
      command('settings'), options.update, command('logOut'), separator(),
      { role: 'hide', label: application('hide') },
      { role: 'hideOthers', label: application('hideOthers') },
      { role: 'unhide', label: application('showAll') }, separator(),
      { role: 'quit', label: application('quit') },
    ] },
    { label: labels.file, submenu: [
      { label: labels.actions.newWindow, click: options.newWindow },
      command('newChat'),
      { label: labels.actions.temporaryChat, accelerator: 'CmdOrCtrl+Shift+N', enabled: false },
      gated('newProject'), separator(), command('openFolder'), separator(),
      { role: 'close', label: labels.actions.close },
    ] },
    options.editMenu,
    { label: labels.view, submenu: [
      command('toggleSidebar'), command('toggleWorkPanel'), command('toggleOverviewPanel'), gated('terminal', 'toggleTerminal'),
      command('toggleFilesPanel'), command('toggleChangesPanel'),
      { label: labels.submenus.browser, enabled: state.browser, submenu: [
        command('newBrowserTab'), { ...command('focusBrowserAddressBar'), accelerator: undefined }, gated('reloadBrowserPage'),
      ] },
      command('toggleBrowserPanel'), separator(),
      command('findInThread'), separator(),
      gated('navigateBack'), gated('navigateForward'),
      ...(options.development ? [{ role: 'reload' as const, label: labels.actions.reload }] : []), separator(),
      command('previousThread'), command('nextThread'), separator(),
      gated('previousTab'), gated('nextTab'), separator(),
      { label: labels.zoom.in, accelerator: 'CmdOrCtrl+Plus', click: () => options.zoom('in') },
      { label: labels.zoom.out, accelerator: 'CmdOrCtrl+-', click: () => options.zoom('out') },
      { label: labels.zoom.reset, accelerator: 'CmdOrCtrl+0', click: () => options.zoom('fit') },
      separator(), { label: labels.actions.mini, ...options.mini, registerAccelerator: false },
      ...(options.development ? [{ label: labels.submenus.developer, submenu: [
        { role: 'forceReload' as const, label: labels.actions.forceReload },
        { role: 'toggleDevTools' as const, label: labels.actions.developerTools },
      ] }] : []),
      { role: 'togglefullscreen', label: labels.actions.fullscreen, visible: false, acceleratorWorksWhenHidden: true },
      hidden('renameThread'), hidden('archiveThread'), hidden('toggleThreadPin'), hidden('searchFiles'),
      hidden('openCommandMenu'),
      { ...hidden('focusBrowserAddressBar'), id: 'focusBrowserAddressBar-hidden', enabled: state.browser },
      { label: labels.actions.findNext, accelerator: 'CmdOrCtrl+G', visible: false, acceleratorWorksWhenHidden: true, click: () => options.findNavigation?.('next') },
      { label: labels.actions.findPrevious, accelerator: 'CmdOrCtrl+Shift+G', visible: false, acceleratorWorksWhenHidden: true, click: () => options.findNavigation?.('previous') },
    ] },
    { role: 'windowMenu', label: labels.window, submenu: [
      { role: 'minimize', label: labels.roles.minimize }, { role: 'zoom', label: labels.roles.zoom }, separator(),
      { role: 'front', label: labels.roles.front },
    ] },
    { role: 'help', label: labels.help, submenu: [
      help('documentation'), command('showKeyboardShortcuts'), help('whatsNew'), separator(),
      help('troubleshooting'), help('status'), help('feedback'), separator(), help('taskManager'),
      { label: traceLabels[options.trace.state] ?? labels.support.savingTrace,
        enabled: options.trace.enabled, click: support.trace },
    ] },
  ];
}
