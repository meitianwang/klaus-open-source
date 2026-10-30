// Native application-menu labels, en + zh.
//
// This is deliberately a SEPARATE resource from the renderer's i18n dictionary
// (frontend/src/i18n/messages.ts): the menu is built in the main process, which
// cannot import the Vite-bundled renderer dictionary, and it must be rebuildable
// synchronously on a locale change.
//
// Only commands that appear as native menu items need an entry. A command without
// one is not listed in the menu — it still works through its keybinding, which is
// the reason most commands have no entry here at all.

export interface NativeMenuLabels {
  file: string;
  edit: string;
  view: string;
  window: string;
  help: string;
  application: { about: string; hide: string; hideOthers: string; showAll: string; quit: string };
  roles: Record<string, string>;
  submenus: { substitutions: string; speech: string; browser: string; developer: string };
  actions: { newWindow: string; temporaryChat: string; close: string; reload: string; forceReload: string; developerTools: string; fullscreen: string; mini: string; find: string; findNext: string; findPrevious: string };
  support: { documentation: string; whatsNew: string; troubleshooting: string; status: string; feedback: string; taskManager: string; startTrace: string; startingTrace: string; stopTrace: string; stoppingTrace: string; savingTrace: string };
  commands: Record<string, string>;
  update: { check: string; checking: string; downloading: string; installing: string };
  zoom: { reset: string; in: string; out: string };
}

const EN: NativeMenuLabels = {
  file: 'File',
  edit: 'Edit',
  view: 'View',
  window: 'Window',
  help: 'Help',
  application: { about: 'About {appName}', hide: 'Hide {appName}', hideOthers: 'Hide Others', showAll: 'Show All', quit: 'Quit {appName}' },
  roles: { editmenu: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteandmatchstyle: 'Paste and Match Style', delete: 'Delete', selectall: 'Select All', showsubstitutions: 'Show Substitutions', togglesmartquotes: 'Smart Quotes', togglesmartdashes: 'Smart Dashes', toggletextreplacement: 'Text Replacement', startspeaking: 'Start Speaking', stopspeaking: 'Stop Speaking', windowmenu: 'Window', minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front' },
  submenus: { substitutions: 'Substitutions', speech: 'Speech', browser: 'Browser', developer: 'Developer' },
  actions: { newWindow: 'New Window', temporaryChat: 'New Temporary Chat', close: 'Close', reload: 'Reload Window', forceReload: 'Force Reload Window', developerTools: 'Toggle Developer Tools', fullscreen: 'Toggle Full Screen', mini: 'Mini', find: 'Find', findNext: 'Find Next', findPrevious: 'Find Previous' },
  support: { documentation: 'Documentation', whatsNew: "What's New", troubleshooting: 'Troubleshooting', status: 'System Status', feedback: 'Feedback', taskManager: 'Task Manager', startTrace: 'Start Performance Trace', startingTrace: 'Starting Performance Trace…', stopTrace: 'Stop Performance Trace…', stoppingTrace: 'Stopping Performance Trace…', savingTrace: 'Saving Performance Trace…' },
  zoom: { reset: 'Actual Size', in: 'Zoom In', out: 'Zoom Out' },
  commands: {
    findInThread: 'Find',
    newChat: 'New Chat',
    newProject: 'New Project…',
    openFolder: 'Open Folder',
    renameThread: 'Rename Chat',
    archiveThread: 'Archive Chat',
    toggleThreadPin: 'Pin/Unpin Chat',
    settings: 'Settings',
    logOut: 'Log Out',
    toggleSidebar: 'Toggle Sidebar',
    toggleWorkPanel: 'Toggle Work Panel',
    toggleOverviewPanel: 'Toggle Overview',
    toggleFilesPanel: 'Toggle Files',
    toggleChangesPanel: 'Toggle Changes',
    toggleBrowserPanel: 'Toggle Browser',
    toggleTerminal: 'Open Terminal',
    openCommandMenu: 'Open command menu',
    searchFiles: 'Search Files…',
    showKeyboardShortcuts: 'Keyboard Shortcuts',
    previousThread: 'Previous Sidebar Item',
    nextThread: 'Next Sidebar Item',
    navigateBack: 'Back',
    navigateForward: 'Forward',
    previousTab: 'Previous Tab',
    nextTab: 'Next Tab',
    newBrowserTab: 'Open Browser Tab',
    focusBrowserAddressBar: 'Focus Browser Address Bar',
    reloadBrowserPage: 'Reload Browser Page',
  },
  update: { check: 'Check for Updates…', checking: 'Checking for Updates…', downloading: 'Downloading Update…', installing: 'Installing Update…' },
};

const ZH: NativeMenuLabels = {
  file: '文件',
  edit: '编辑',
  view: '视图',
  window: '窗口',
  help: '帮助',
  application: { about: '关于 {appName}', hide: '隐藏 {appName}', hideOthers: '隐藏其他', showAll: '显示全部', quit: '退出 {appName}' },
  roles: { editmenu: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', pasteandmatchstyle: '粘贴并匹配样式', delete: '删除', selectall: '全选', showsubstitutions: '显示替换', togglesmartquotes: '智能引号', togglesmartdashes: '智能破折号', toggletextreplacement: '文本替换', startspeaking: '开始朗读', stopspeaking: '停止朗读', windowmenu: '窗口', minimize: '最小化', zoom: '缩放', front: '全部置于顶层' },
  submenus: { substitutions: '替换', speech: '语音', browser: '浏览器', developer: '开发者' },
  actions: { newWindow: '新建窗口', temporaryChat: '新建临时聊天', close: '关闭', reload: '重新加载窗口', forceReload: '强制重新加载窗口', developerTools: '切换开发者工具', fullscreen: '切换全屏', mini: '迷你助手', find: '查找', findNext: '查找下一个', findPrevious: '查找上一个' },
  support: { documentation: '文档', whatsNew: '新功能', troubleshooting: '故障排除', status: '系统状态', feedback: '反馈', taskManager: '任务管理器', startTrace: '开始性能跟踪', startingTrace: '正在开始性能跟踪…', stopTrace: '停止性能跟踪…', stoppingTrace: '正在停止性能跟踪…', savingTrace: '正在保存性能跟踪…' },
  zoom: { reset: '实际大小', in: '放大', out: '缩小' },
  commands: {
    findInThread: '查找',
    newChat: '新聊天',
    newProject: '新建项目…',
    openFolder: '打开文件夹',
    renameThread: '重命名聊天',
    archiveThread: '归档聊天',
    toggleThreadPin: '置顶/取消置顶聊天',
    settings: '设置',
    logOut: '退出登录',
    toggleSidebar: '切换侧边栏',
    toggleWorkPanel: '切换工作面板',
    toggleOverviewPanel: '切换概览',
    toggleFilesPanel: '切换文件',
    toggleChangesPanel: '切换更改',
    toggleBrowserPanel: '切换浏览器',
    toggleTerminal: '打开终端',
    openCommandMenu: '打开命令菜单',
    searchFiles: '搜索文件…',
    showKeyboardShortcuts: '键盘快捷键',
    previousThread: '上一个侧边栏项目',
    nextThread: '下一个侧边栏项目',
    navigateBack: '后退',
    navigateForward: '前进',
    previousTab: '上一个标签页',
    nextTab: '下一个标签页',
    newBrowserTab: '打开浏览器标签页',
    focusBrowserAddressBar: '聚焦浏览器地址栏',
    reloadBrowserPage: '重新加载浏览器页面',
  },
  update: { check: '检查更新…', checking: '正在检查更新…', downloading: '正在下载更新…', installing: '正在安装更新…' },
};

export function nativeMenuLabels(chinese: boolean): NativeMenuLabels {
  return chinese ? ZH : EN;
}

/** Match the renderer's saved-language, edition-default, then system-language policy. */
export function nativeMenuUsesChinese(saved: unknown, defaultLanguage: string | null | undefined, systemLocale: string): boolean {
  const locale = typeof saved === 'string' && saved ? saved : defaultLanguage || systemLocale;
  return /^zh(?:[-_]|$)/i.test(locale);
}
