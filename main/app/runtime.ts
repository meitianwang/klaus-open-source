import { requireInterruptConfirmation } from '../sessions/turn-interrupt';
import { autoUpdater, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, protocol, safeStorage, screen, session, shell, systemPreferences, Tray, webContents, type App, type WebContents } from 'electron';
import { VoiceChatPresentationRuntime } from './voice-chat-presentation';
import { createPowerSaveRuntime } from './power-save-runtime';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { AppshotRuntime, appshotCaptureApplication, registerAppshotHandlers } from './appshot-runtime';
import { appshotContextText } from '../../contracts/appshot-context';
import type { PetAppshotContext } from '../../contracts/desktop-pet-composer';
import { PetActivityStore } from '../pets/activity-store';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { configRootFrom } from '../services/config-root';
import { currentDesktopEdition, desktopEngineEnvironment, publicDesktopDistribution } from '../services/desktop-edition';
import { ImageActions } from '../services/image-actions';
import { registerImageHandlers } from '../ipc/handlers/images';
import { SHOW_WIDGET_TOOL_SPEC, WidgetService } from '../services/widgets';
import { string } from '../services/service-types';
import { readLastTurnChanges, readLastTurnFromHistory } from '../services/last-turn-changes';
import { EngineManager } from '../engine/manager';
import { SessionService } from '../sessions/service';
import { createDesktopUpdater } from '../updater/runtime';
import type { UpdateStatus } from '../updater/service';
import { ResumeLedger } from '../sessions/resume-ledger';
import { runStartupResumeRecovery } from '../sessions/resume-recovery';
import { registerUpdaterHandlers } from '../ipc/handlers/updater';
import { RetiredPrivateSessions } from '../services/retired-private-sessions';
import { registerThreadTools, ThreadToolsService, withThreadToolsGate, type ThreadToolContext } from '../services/thread-tools';
import { RemoteThreadClient } from '../services/remote-thread-client';
import { conversationContextBlock } from '../services/conversation-mention';
import { deviceContextBlock } from '../services/device-mention';
import { ensureProfileScopedDeviceSeed, MobileSettingsStore } from '../services/mobile/settings';
import { createThreadWaitSignals } from '../services/thread-wait-signals';
import { threadToolsEnabled } from '../services/session-init';
import { WorkspaceDependenciesManager } from '../services/workspace-dependencies';
import { createWorkspaceDependencySettingsService } from '../services/workspace-dependency-settings';
import { WORKSPACE_DEPENDENCIES_ENABLED_KEY } from '../../contracts/workspace-dependency-settings';
import { registerWorkspaceDependencyTool, workspaceDependencyNote } from '../services/workspace-dependency-tools';
import { ModelFeatureSettings } from '../services/model-features';
import { MediaGenerationService, registerMediaGenerationTools } from '../services/media-generation/service';
import { createWorkbuddyMediaFacade, createQwenworkNativeMediaFacade, createAntigravityMediaFacade, createTraeMediaFacade } from '../services/media-generation/native-facade';
import { createCursorMediaFacade } from '../services/media-generation/cursor-facade';
import { createQoderMediaFacade } from '../services/media-generation/qoder-facade';
import { createMinimaxMediaFacade } from '../services/media-generation/minimax-facade';
import { createBailianMediaFacade } from '../services/media-generation/bailian-facade';
import { KLAUS_CONTROL_CHANNELS, KlausControlService, productContextNote, registerKlausControlTools } from '../services/klaus-control';
import { registerChannelHandlers } from '../ipc/handlers/channels';
import { registerWechatPairingHandlers } from '../ipc/handlers/wechat-pairing';
import { registerWhatsAppPairingHandlers } from '../ipc/handlers/whatsapp-pairing';
import { NativeWhatsAppTransport, type WhatsAppNativeFactory } from '../native/whatsapp';
import { registerDiscordAccessHandlers } from '../ipc/handlers/discord-access';
import { registerPermissionRuleHandlers } from '../ipc/handlers/permission-rules';
import { ChannelTurns } from '../services/channels/turns';
import { wechatAdapter } from '../services/channels/wechat';
import { telegramAdapter } from '../services/channels/telegram';
import { wecomAdapter } from '../services/channels/wecom';
import { qqAdapter } from '../services/channels/qq';
import { dingtalkAdapter } from '../services/channels/dingtalk';
import { feishuAdapter } from '../services/channels/feishu';
import { discordAdapter, type DiscordTransportOptions } from '../services/channels/discord';
import type { ChannelService } from '../services/channels/service';
import type { ChannelAdapterFactory, ChannelId } from '../services/channels/types';
import { combineHostCapabilities, refreshIdleHostCapabilities, type HostCapabilityBinding } from '../sessions/host-capabilities';
import { registerMcpConfigurationHandlers } from '../ipc/handlers/mcp-configuration';
import type { McpConfigurationService } from '../services/mcp/configuration';
import { registerMcpBuiltinHandlers } from '../ipc/handlers/mcp-builtins';
import { McpBuiltinService } from '../services/mcp/builtins';
import { McpDiagnosticsService } from '../services/mcp/diagnostics';
import { registerMcpDeviceHandlers } from '../ipc/handlers/mcp-device';
import { McpDeviceService, resolveMcpDeviceClientId } from '../services/mcp/device';
import { registerDreamHandlers } from '../ipc/handlers/dream';
import { DreamService } from '../services/dream';
import { MemorySnapshotService } from '../services/memory-snapshots';
import { registerUsageHandlers } from '../ipc/handlers/usage';
import { createMobileRuntime, mobileEngineOwner } from './mobile-runtime';
import { createConnectorsRuntime } from './connectors-runtime';
import { MOBILE_DISPATCH_CHANNELS, type MobileBridgeService } from '../services/mobile/service';
import { claudeUsageCacheKey, UsageService } from '../services/usage';
import { bindSessionWorkdir, readSessionModel } from '../services/session-store';
import { registerTeamCollaborationHandlers } from '../ipc/handlers/team-collaboration';
import { FeatureGatesService } from '../services/feature-gates';
import { registerFeatureGateHandlers } from '../ipc/handlers/feature-gates';
import { OnboardingGuideService } from '../services/onboarding-guide';
import { registerOnboardingGuideHandlers } from '../ipc/handlers/onboarding-guide';
import type { TeamCollaborationService } from '../services/team-collaboration';
import { bindCollaborationModel } from '../services/team-collaboration/model';
import { registerExternalAgentImportHandlers } from '../ipc/handlers/external-agent-import';
import { ExternalAgentImportService } from '../external-agent-import/service';
import { registerFeedbackHandlers } from '../ipc/handlers/feedback';
import { FeedbackService } from '../feedback/service';
import { createFeedbackWindowAdapter } from '../feedback/window';
import { HostState } from '../services/host-state';
import { ChatEventForwarder, SessionEventPump } from '../sessions/events';
import { RoleTable, type Json } from '../ipc/contract';
import { ChannelRegistry, IpcHandlerError } from '../ipc/registry';
import { IpcRouter } from '../ipc/router';
import { PushBroadcaster, RendererReadyLatch, pushEventName, pushPayload } from '../ipc/push';
import { HOST_CHANNELS, WindowRoleRegistry, WebContentsPushTransport, handleWindowOp, attributeCaller, type WindowOp } from '../ipc/binding';
import { acquireRuntimeInvoke } from '../ipc/runtime-dispatcher';
import { FriendsService, FRIEND_TOOL_SPECS, FRIEND_TASK_ONLY_TOOL_NAMES, FRIEND_OWNER_WAIT_MS, withFriendToolsGate } from '../services/friends';
import { friendSessionScope, forgetFriendSession, friendsEnabled } from '../services/friend-session-scope';
import { registerFriendsHandlers } from '../ipc/handlers/friends';
import { registerSessionHandlers } from '../ipc/handlers/sessions';
import { registerSessionQueryHandlers } from '../ipc/handlers/session-queries';
import { registerAgentTaskHandlers } from '../ipc/handlers/agent-tasks';
import { AgentTaskService } from '../services/agent-tasks';
import { registerSettingsHandlers } from '../ipc/handlers/settings';
import { registerRuntimeWindowsSandboxHandlers } from '../ipc/handlers/runtime-windows-sandbox';
import { WindowsSandboxSetup } from '../services/windows-sandbox-setup';
import { registerKeymapHandlers } from '../ipc/handlers/keymap';
import { KeymapService, keymapFilePath } from '../services/keymap-service';
import { KeybindingRegistry, platformOf, menuAccelerators, effectiveKeybindings, findHandoffCommand } from '../../contracts/keybindings';
import { SIDEBAR_PROJECT_ORDER_CHANGED_KEY } from '../../contracts/sidebar-collapse';
import { KLAUS_COMMANDS, FIND_COMMAND_ID } from '../../contracts/keybindings-commands';
import { nativeMenuLabels, nativeMenuUsesChinese } from './native-menu-labels';
import { applicationMenuTemplate } from './application-menu';
import { INITIAL_NATIVE_MENU_STATE, parseNativeMenuState, type NativeMenuState } from '../../contracts/native-menu-state';
import { DesktopMenuDiagnostics } from './menu-diagnostics';
import { NativeContentFind } from './native-content-find';
import { registerComposerHandlers } from '../ipc/handlers/composer';
import { storedPermissionMode, finishPermissionDefaultMigration } from '../services/runtime-policy';
import { WindowsRuntimePolicyProjection, isNativeLocalWindows } from '../services/windows-runtime-policy';
import { registerComposerPredictionHandlers } from '../ipc/handlers/composer-predictions';
import { ComposerPredictions, COMPOSER_PREDICTIONS_ENABLED_KEY } from '../services/composer-predictions';
import { registerAuthHandlers } from '../ipc/handlers/auth';
import { SessionConfiguration } from '../sessions/configuration';
import { AcknowledgedPush } from '../ipc/delivery';
import { RendererSubscriptions } from '../ipc/subscriptions';
import { object, payload, requiredString } from '../ipc/arguments';
import { computerUseHelperPath, engineBinDir, manualPath, pipProducerPath, recordingHelperPath, resourceRoot } from '../paths';
import { resolveFixtureEngineBinary } from '../engine/fixture-binary';
import { appUrl, serveFrontend } from './protocol';
import { createArtifactWindow, createMainWindow, createQuickInputWindow, createRecorderWindow, createPetWindow, createVoiceChatWindow } from './windows';
import { DesktopPetRuntime } from './desktop-pet';
import { DesktopPetRealtime, registerPetRealtimeHandlers } from '../pets/realtime';
import { registerVoiceChatHandlers } from '../ipc/handlers/voice-chat';
import { type PetRealtimeOptions } from '../../contracts/desktop-pet-voice';
import { petVoiceTarget, petRealtimeSourceOptions } from '../pets/realtime-source';
import { PetVoiceOwners } from '../pets/voice-owners';
import { DesktopPetActivity } from '../pets/activity';
import { RUNNING_SUMMARY_TOOL_SPEC, runningSummaryAvailable, runningSummaryContextNote, runningSummaryResult, withRunningSummaryGate } from '../pets/tools';
import { registerDesktopPetHandlers } from '../ipc/handlers/desktop-pet';
import { beginNativePetWindowDrag, observeNativePetOutsideClicks, observePetOutsideClicks } from './pet-pointer';
import { PetComposer, PetComposerPreparationError, registerPetComposerHandlers } from '../pets/composer';
import { DesktopPetResponder } from '../pets/respond';
import { BUILT_IN_PETS } from '../../contracts/desktop-pet-builtins';
import { QuickInputRuntime } from './quick-input';
import { QuickInputDelivery, type QuickInputSubmission } from './quick-input-delivery';
import { DesktopShortcuts } from './shortcuts';
import { ClipboardFiles, type FileClipboardItem } from '../services/clipboard-files';
import { SystemPermissions } from '../services/system-permissions';
import { nativeSystemPermissionProbes } from '../native/system-permissions';
import { registerAuxiliaryHandlers } from '../ipc/handlers/auxiliary';
import { DesktopLog, monitorHostResponsiveness } from './log';
import { MobileDiagnosticLog, MobileDiagnosticsSwitch } from '../services/mobile/diagnostic-log';
import { NativeNotifications, NotificationAuthorization } from './notifications';
import { DesktopNotifications, type DesktopNotice } from '../services/notifications';
import { StartupResources } from './startup-resources';
import { configureSystemTrust } from './system-trust';
import { configureSystemProxy } from './system-proxy';
import { stageLegacyUiState } from './legacy-ui-state';
import { parseDeepLink } from './deep-links';
import { isTrustedAppUrl } from './trusted-origin';
import { cameraLeaseHeld, dropCameraLease, grantCameraLease, releaseCameraLease } from './camera-lease';
import { createNativeRuntime } from './native-runtime';
import { createSshRuntime, type SshIdentity } from './ssh-runtime';
import { SshFileService } from '../services/ssh-files';
import { registerRemoteWorkspaceTools } from '../services/remote-tools';
import { createMcpRuntime } from './mcp-runtime';
import { initializeModelTierMapping } from '../services/model-tier-settings';
import { createVoiceRuntime, voiceModelAccess } from './voice-runtime';
import { createPipRuntime } from './pip-runtime';
import { createComputerUseRuntime } from './computer-use-runtime';
import { ComputerHistoryService } from '../services/computer-history/service';
import { registerComputerHistorySettingsHandlers } from '../ipc/handlers/computer-history';
import { ManagedComputerUsePolicyReader } from '../services/computer-use/managed-policy';
import { lockedScreenRefusal } from '../services/computer-use/locked-screen-gate';
import { discoverFriendApps } from '../services/friend-apps';
import type { RecordingCommand } from '../services/recording/helper';
import { PIP_PREFERENCES_KEY } from '../services/pip';
import type { VoiceOptions } from '../services/voice/service';
import { NativeSubscriptionCredentials } from '../native/credentials';
import { BrowserManager } from '../browser/manager';
import { PendingBrowserPermissions } from '../browser/permission-requests';
import { BrowserAccessController } from '../browser/access';
import { AnnotationSessionManager } from '../browser/annotation-session';
import { RunPreview, RUN_PREVIEW_TOOL_SPEC } from '../browser/run-preview';
import { SiteOpener } from '../browser/site-open';
import { BrowserMcpServer } from '../browser/mcp';
import { registerBrowserHandlers } from '../ipc/handlers/browser';
import { BrowserDataManagement } from '../browser/data-management';
import { BrowserTabMentionService } from '../browser/tab-mentions';
import { BrowserPreferences } from '../services/browser-preferences';
import { registerCronSettingsHandlers } from '../ipc/handlers/cron';
import { registerWorkspaceHandlers } from '../ipc/handlers/workspaces';
import { registerFileHandlers } from '../ipc/handlers/files';
import { registerEndResourceHandlers } from '../ipc/handlers/end-resources';
import { EndResourceOpener } from '../services/end-resource-open';
import { registerDocumentHandlers } from '../ipc/handlers/documents';
import { pathInside, WorkspaceStore } from '../services/workspaces';
import type { FileService } from '../services/files';
import { MediaFiles, MEDIA_SCHEME } from '../services/media-files';
import { createConversationMediaScope } from '../services/media-scope';
import { registerGitHandlers } from '../ipc/handlers/git';
import { registerWorktreeHandlers } from '../ipc/handlers/worktrees';
import { registerStorageHandlers } from '../ipc/handlers/storage';
import { WorktreeStorageService } from '../services/worktree-storage';
import type { StorageChatsChanged } from '../../contracts/storage-settings';
import { DeviceStorageService, type SessionStorageMeta } from '../services/device-storage';
import { CronStore } from '../services/cron-store';
import { CronRuntime } from '../services/cron-runtime';
import { CRON_TOOL_SPECS, executeCronTool } from '../services/cron-tools';
import { backfillCronAutomationSessionMetadata } from '../services/cron-metadata';
import { DynamicTools } from '../sessions/dynamic-tools';
import type { WindowsProfileResult } from './windows-profile';
import { registerFileExtensionHandlers } from '../ipc/handlers/extensions';
import { FileExtensionService } from '../services/extensions/management';
import { SkillWatcher, type SkillWatchSubscription } from '../services/extensions/skill-watcher';
import { registerSkillHandlers } from '../ipc/handlers/skills';
import { registerSkillMarketHandlers } from '../ipc/handlers/skills-market';
import { SkillMarketService, resolveSkillMarketEndpoint } from '../skills-market/service';
import { registerAgentMarketHandlers } from '../ipc/handlers/agents-market';
import { AgentMarketService } from '../agents-market/service';
import { registerPluginMarketplaceHandlers } from '../ipc/handlers/plugin-marketplaces';
import { PluginMarketplaceService } from '../services/extensions/marketplaces';
import { OfficialPluginsService } from '../services/extensions/official-plugins';
import { registerHookStyleHandlers } from '../ipc/handlers/hooks-styles';
import { HooksTrustState } from '../services/extensions/hooks-state';
import type { HookStyleService } from '../services/extensions/hooks-styles';
import { inheritedEnv } from '../engine/spawn';
import { registerPluginHandlers, registerRuntimeViewHandlers } from '../ipc/handlers/plugins';
import type { PluginProgressEvent, PluginService } from '../services/extensions/plugins';
import { requestAcknowledged } from '../engine/acknowledged';
import { AttachmentService } from '../services/attachments';
import { PastedTextService } from '../services/pasted-text';
import { registerAttachmentHandlers } from '../ipc/handlers/attachments';
import { CanvasService } from '../canvas/service';
import { PrototypeService } from '../prototype/service';
import { VideoEditingService } from '../video-editing/service';
import { PptService } from '../ppt/service';
import { ComposerEditCommands } from './composer-edit-commands';
import { createOwnedEditMenu } from './owned-edit-menu';
import { installTextContextMenu } from './text-context-menu';
import { ImageZoomCommands, type ImageZoomCommand, type ImageZoomTarget } from './image-zoom-commands';
import { CursorDiagnostics } from '../services/cursor-diagnostics';
import { SessionArtifactPaths, recordArtifactPathsFromChatEvent, recordArtifactPathsFromHistory } from '../services/artifact-paths';
import { DigramService } from '../digram/service';
import { restoreLegacyDiagramCards } from '../digram/history';
import { Model3DService } from '../model3d/service';
import { registerModel3DHandlers } from '../ipc/handlers/model3d';
import { registerCanvasHandlers } from '../ipc/handlers/canvas';
import { registerPrototypeHandlers } from '../ipc/handlers/prototype';
import { registerVideoEditingHandlers } from '../ipc/handlers/video-editing';
import { registerPptHandlers } from '../ipc/handlers/ppt';
import { registerDigramHandlers } from '../ipc/handlers/digram';
import { isFailure, kvGet, kvSet, kvSnapshot } from '../services/settings';
import { readStoredAuth } from '../services/auth';

export interface DesktopRuntime {
  window: BrowserWindow;
  registry: ChannelRegistry;
  sessions: SessionService;
  engine: EngineManager;
  deliver(senderId: number, channel: string, value: Json): Promise<void>;
  nativeCounts(): { searches: number; ptys: number };
  browser: BrowserManager;
  canvas: CanvasService;
  prototype: PrototypeService;
  videoEditing: VideoEditingService;
  ppt: PptService;
  digram: DigramService;
  model3d: Model3DService;
  show(): void;
  openMainWindow(): Promise<BrowserWindow>;
  focusedMainWindow(): BrowserWindow;
  runMainWindowCommand(commandId: string): void;
  showQuickInput(): Promise<{ ok: boolean; error?: string }>;
  openDeepLink(url: string): void;
  prepareUpdate(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Compose one application. The production entry and GUI integration tests share this. */
export async function createDesktopRuntime(app: App, options: { show?: boolean; tray?: boolean; nativeFixtureAddonPath?: string; engineFixtureBinary?: string; notificationFixture?: { show(notice: DesktopNotice): void; focused?: () => boolean }; windowsProfile?: WindowsProfileResult; sshIdentity?: SshIdentity; externalImportHome?: string; browserImportRoots?: readonly import('../../contracts/browser-import').BrowserSourceRoot[]; browserSecretCipher?: import('../../contracts/browser-credentials').BrowserSecretCipher; externalAuthHomeDir?: string; chooseWorkdir?: () => Promise<string | null>; mcpDeviceBaseUrl?: string; restartAfterWipeLocal?: () => void; chooseSessionExportPath?: (defaultPath: string) => Promise<string | undefined>; chooseSpecExportPath?: (name: string) => Promise<string | undefined>; openMcpAuthorizationUrl?: (url: string) => Promise<void>; voiceFixture?: Pick<VoiceOptions, 'speechCommand' | 'micPermission'>; recordingFixtureCommand?: RecordingCommand; readClipboardFiles?: () => Promise<readonly FileClipboardItem[]>; channelTransports?: Partial<Record<ChannelId, ChannelAdapterFactory>>; wechatPairingFetch?: typeof fetch; whatsappNativeFactory?: WhatsAppNativeFactory; discordTransport?: Omit<DiscordTransportOptions, 'access'> } = {}): Promise<DesktopRuntime> {
  const invokeLease = acquireRuntimeInvoke(ipcMain);
  const early = new StartupResources();
  early.add(() => invokeLease.dispose());
  let fullShutdown: (() => Promise<void>) | undefined;
  try {
  const served = serveFrontend();
  early.add(() => served.close());
  if (served.missing) throw new Error(`Frontend is not built: ${served.root}`);
  const edition = currentDesktopEdition();
  const configRoot = configRootFrom();
  // Isolated development launches share this machine with the installed application.
  // The machine-derived device identity would let both instances register one server
  // device row and overwrite each other's authorization token on every relay
  // registration, failing friend requests of whichever instance did not register
  // last. Seed a profile-scoped device identity before any friend or relay call
  // derives one. instance-identity.ts already rejected invalid fixture combinations
  // before this runtime was constructed, so the environment marks a validated launch.
  const profileScopedDevice = !app.isPackaged && process.env.KLAUS_TEST === '1'
    && /^ai\.klaus\.instance-fixture\.[a-zA-Z0-9_-]{1,40}$/.test(process.env.KLAUS_INSTANCE_FIXTURE_ID ?? '')
    ? ensureProfileScopedDeviceSeed(configRoot) : false;
  const engineExecutable = resolveFixtureEngineBinary({
    stagedBinary: join(engineBinDir(), process.platform === 'win32' ? 'klaus-agent-stdio.exe' : 'klaus-agent-stdio'),
    fixtureBinary: options.engineFixtureBinary, testMode: process.env.KLAUS_TEST === '1', packaged: app.isPackaged,
  });
  const nativeMenuStates = new Map<number, NativeMenuState>();
  let menusInitialized = false;
  const log = new DesktopLog(configRoot);
  early.add(() => log.close());
  const cursorLog = new DesktopLog(configRoot, 'cursor-diagnostics.log');
  const cursorDiagnostics = new CursorDiagnostics(cursorLog);
  early.add(() => cursorLog.close());
  void cursorDiagnostics.captureBuild(resourceRoot(), engineExecutable, app.getVersion());
  const stopResponsivenessMonitor = monitorHostResponsiveness(log);
  early.add(stopResponsivenessMonitor);
  try { log.write('system-trust', JSON.stringify({ additionalIssuers: configureSystemTrust() })); }
  catch { log.write('system-trust', 'System certificate lookup failed; retaining the existing certificate authorities'); }
  void configureSystemProxy(process.platform, line => log.write('system-proxy', line))
    .then(result => { if (!result.applied) log.write('system-proxy', 'no system proxy applied'); })
    .catch(error => log.write('system-proxy', error instanceof Error ? error.message : String(error)));
  const subscriptionFetch = (url: string, init: RequestInit): Promise<Response> =>
    session.defaultSession.fetch(url, { ...init, credentials: 'omit' });
  const workspaceSkillRoot = join(resourceRoot(), 'workspace-skills');
  const workspaceDependencies = new WorkspaceDependenciesManager({
    rootDir: join(configRoot, 'workspace-runtime'), resourcesDir: join(resourceRoot(), 'workspace-runtime'),
    logPath: join(configRoot, 'workspace-runtime.log'),
    fetch: (input, init) => session.defaultSession.fetch(String(input), { ...init, credentials: 'omit' }),
  });
  early.add(() => workspaceDependencies.close());
  const workspaceDependencySettings = createWorkspaceDependencySettingsService(workspaceDependencies, {
    configRoot,
    notify: () => emit('app:preferences-changed', { key: WORKSPACE_DEPENDENCIES_ENABLED_KEY }),
  });
  if (options.windowsProfile) {
    const { status, keyError, backupDirectory, warning } = options.windowsProfile;
    log.write('windows-profile', JSON.stringify({ status, keyError, backupDirectory, warning }));
  }
  const roles = RoleTable.load();
  const windows = new WindowRoleRegistry();
  const subscriptions = new RendererSubscriptions();
  early.add(() => subscriptions.close());
  const delivery = new AcknowledgedPush({
    send: (id, packet) => {
      const contents = webContents.fromId(id), role = windows.roleOf(id);
      if (!contents || contents.isDestroyed() || !role || !isTrustedAppUrl(contents.mainFrame.url)
        || !roles.mayListen(role, packet.event.slice(4))) return false;
      contents.send(HOST_CHANNELS.delivery, packet);
      return true;
    },
  });
  early.add(() => delivery.close());
  const acknowledge = (event: Electron.IpcMainEvent, raw: unknown): void => {
    const caller = attributeCaller(event, windows.resolver()), value = object(raw);
    if (caller.ok && typeof value?.deliveryId === 'string' && typeof value.ok === 'boolean') {
      delivery.acknowledge(caller.identity.senderId, value.deliveryId, value.ok);
    }
  };
  ipcMain.on(HOST_CHANNELS.deliveryAck, acknowledge);
  early.add(() => { ipcMain.removeListener(HOST_CHANNELS.deliveryAck, acknowledge); });
  const listenerState = (event: Electron.IpcMainEvent, raw: unknown): void => {
    const caller = attributeCaller(event, windows.resolver()), value = object(raw);
    if (caller.ok && typeof value?.channel === 'string' && typeof value.active === 'boolean'
      && roles.mayListen(caller.identity.role, value.channel)) subscriptions.set(caller.identity.senderId, value.channel, value.active);
  };
  ipcMain.on(HOST_CHANNELS.listenerState, listenerState);
  early.add(() => { ipcMain.removeListener(HOST_CHANNELS.listenerState, listenerState); });
  const broadcaster = new PushBroadcaster(
    new WebContentsPushTransport(id => webContents.fromId(id) ?? undefined),
    new RendererReadyLatch(), (role, channel) => roles.mayListen(role, channel),
    new Set(roles.coldStartDeferred()),
  );
  const emit = (channel: string, value: Json): void => {
    if (channel === 'app:preferences-changed') {
      const key = object(value)?.key;
      if (key === 'power' || key === 'cron' || key === 'cron.keep_awake' || typeof key === 'string' && key.startsWith('power.')) powerRuntime?.changed();
    }
    broadcaster.emit(channel, value);
    notifications?.input(channel, value);
    petActivity?.input(channel, value);
    if (mobile && channel === 'app:preferences-changed') mobile.notePreferencesChanged(string(object(value)?.key));
    if (mobile && channel === 'permission:request') {
      const owner = mobileEngineOwner(sessions); if (owner) mobile.publishPermissionRequest(object(value) ?? {}, owner);
    }
    if (mobile && channel === 'elicit:request') {
      const owner = mobileEngineOwner(sessions); if (owner) mobile.publishElicitationRequest(object(value) ?? {}, owner);
    }
    // Independent channels the chat event stream never carries; the phone needs them to show
    // goal state, background processes and the engine reconnect badge.
    if (mobile && (channel === 'goal:updated' || channel === 'background-process:changed' || channel === 'engine:status'
      || channel === 'question:requested' || channel === 'question:resolved' || channel === 'planning:updated'
      || channel === 'planning-input:requested' || channel === 'planning-input:resolved')) {
      const owner = mobileEngineOwner(sessions);
      const type = channel === 'goal:updated' ? 'goal_updated' : channel === 'background-process:changed' ? 'background_process_changed'
        : channel === 'question:requested' ? 'question_requested' : channel === 'question:resolved' ? 'question_resolved'
        : channel === 'planning:updated' ? 'planning_updated' : channel === 'planning-input:requested' ? 'planning_input_requested'
        : channel === 'planning-input:resolved' ? 'planning_input_resolved' : 'engine_status';
      if (owner) mobile.publishDesktopStateEvent(type, object(value) ?? {}, owner);
    }
  };
  let mobile: MobileBridgeService | undefined;
  let powerRuntime: ReturnType<typeof createPowerSaveRuntime> | undefined;
  const powerSuppressedConversations = new Set<string>();
  let notifications: DesktopNotifications | undefined;
  let desktopPet: DesktopPetRuntime | undefined;
  let petActivity: DesktopPetActivity | undefined;
  let petLanguage: string = edition.defaultLanguage || 'en';
  let petComposer: PetComposer | undefined;
  let petRealtime: DesktopPetRealtime | undefined;
  let chatRealtime: DesktopPetRealtime | undefined;
  let voicePresentation: VoiceChatPresentationRuntime | undefined;
  let chatVoiceOwnerId: number | undefined;
  let chatVoiceRequestId: string | undefined;
  let chatVoiceTargetSessionId: string | undefined;
  let chatVoiceReservedGeneration = 0;
  let chatVoiceBackgroundThrottling = true;
  let petForegroundApplication: string | undefined;
  let appshotRuntime: AppshotRuntime | undefined;
  const petMainConversations = new Map<number, string>();
  let petRealtimeProviderId: string | undefined;
  let notificationAuthorization: NotificationAuthorization | undefined;
  let cronRuntime: CronRuntime | undefined;
  let teamCollaboration: TeamCollaborationService | undefined;
  let featureGates: FeatureGatesService | undefined;
  let onboardingGuide: OnboardingGuideService | undefined;
  let cronMetadataBackfill: Promise<void> = Promise.resolve();
  let pip: ReturnType<typeof createPipRuntime> | undefined;
  let computerUse: Awaited<ReturnType<typeof createComputerUseRuntime>> | undefined;
  let connectors: ReturnType<typeof createConnectorsRuntime> | undefined;
  let dynamicTools: DynamicTools | undefined;
  let friends: FriendsService | undefined;
  let dream: DreamService | undefined;
  let memorySnapshots: MemorySnapshotService | undefined;
  const cronStore = new CronStore(configRoot);
  // Paths this conversation touched or the user selected, so the viewer can SHOW
  // them even when they sit outside the session's roots. Filled from the engine's
  // own events here and re-filled from a projected history on reopen; consulted
  // by the media scope and the artifact preview. See services/artifact-paths.ts.
  // The media channel re-checks scope with the REAL path, so a record must carry
  // both spellings or a file under a symlinked directory (/tmp on macOS) would be
  // admitted at grant time and refused at serve time — a blank image with no error.
  const artifactPaths = new SessionArtifactPaths({
    canonicalize: path => realpathSync(path), publishedImageRoot: join(configRoot, 'artifacts'),
  });
  const chat = new ChatEventForwarder(emit, events => {
    for (const event of events) recordArtifactPathsFromChatEvent(artifactPaths, event);
    for (const event of events) {
      const value = object(event);
      const terminal = value?.type === 'done' || value?.type === 'interrupted' || value?.type === 'api_error' && value.terminal === true;
      if (terminal && typeof value?.sessionId === 'string' && typeof value.turnId === 'string') {
        // The owner prepares live predictions even when another chat is visible.
        void composerPredictions?.predict(value.sessionId, value.turnId, 'live', sessionMainWindow(value.sessionId).webContents.id).catch(error => log.write('prediction-live', String(error)));
      }
    }
    notifications?.observeChat(events);
    petActivity?.observeChat(events);
    petComposer?.observeChat(events);
    cronRuntime?.observeChat(events);
    dream?.observeChat(events);
    if (mobile) { const owner = mobileEngineOwner(sessions); if (owner) for (const event of events) mobile.publishEngineEvent(object(event) ?? {}, owner); }
    computerUse?.observe(events);
    try { pip?.observe(events); } catch (error) { log.write('pip-events', String(error)); }
  });
  const push = (channel: string, value?: Json): void => {
    if (channel === 'chat:event' && value !== undefined) chat.enqueue([value]);
    else broadcaster.emit(channel, value);
  };
  early.add(() => chat.close());
  // Menu items live outside the status payload, so the application menu rebuilds
  // when the Check-for-Updates item changes label or enabled state. Transfer
  // progress arrives several times a second and never changes either, so only a
  // state transition rebuilds the menu; every push still reaches the renderer.
  const updaterStatusForMenu: UpdateStatus[] = [];
  let updaterMenuState = '';
  const updater = await createDesktopUpdater({ app, autoUpdater, resourcesRoot: resourceRoot(), configRoot, edition,
    emit: status => {
      updaterStatusForMenu[0] = status;
      const menuState = `${status.supported ? '1' : '0'}:${status.state}`;
      if (menuState !== updaterMenuState) { updaterMenuState = menuState; refreshMenus(); }
      push('updater:status', { ...status });
    },
    log: message => log.write('updater', message),
    prepareToQuit: () => prepareUpdate(),
    installationFailedAfterPrepare: (error, staged) => {
      log.write('updater-handoff-failed', String(error));
      dialog.showErrorBox('Klaus could not finish updating', staged
        ? 'The update is staged, but Klaus could not finish closing all work. Reopen Klaus to finish updating.'
        : 'The update could not start. Reopen Klaus and try again.');
      setImmediate(() => app.quit());
    } });
  early.add(() => updater.dispose());
  const engine = new EngineManager(app.getVersion());
  early.add(() => engine.shutdownAll());
  const skillWatches = new Map<string, SkillWatchSubscription>();
  const state = new HostState({ log: (kind, detail) => log.write(kind, detail), onDrop: id => {
    const registration = skillWatches.get(id);
    skillWatches.delete(id);
    void registration?.dispose().catch(error => log.write('skill-watch-release', String(error)));
  } });
  // Restart recovery ledger: which sessions had an unsettled turn when the app
  // last quit (update relaunch, crash, user quit). Written debounced on every
  // running-turn change and flushed during the quit drain.
  const resumeLedger = new ResumeLedger(ResumeLedger.path(configRoot), message => log.write('resume-ledger', message));
  await resumeLedger.initialize();
  state.onTurnRunningChange = () => { resumeLedger.set(state.runningSessions()); powerRuntime?.changed(); };
  early.add(() => resumeLedger.flush());
  const resourceDirs = [resourceRoot()];
  let sessions: SessionService;
  let composer: ReturnType<typeof registerComposerHandlers> | undefined;
  let composerPredictions: ComposerPredictions | undefined;
  const predictionRunningSessions = new Set<string>();
  let channels: ChannelService;
  let browserMcp: BrowserMcpServer;
  let runPreview: RunPreview | undefined;
  let digram: DigramService;
  let model3d: Model3DService;
  let prototype: PrototypeService;
  let videoEditing: VideoEditingService;
  let ppt: PptService;
  let digramEnabled = false;
  let mcp: McpConfigurationService;
  let mcpRuntime: ReturnType<typeof createMcpRuntime> | undefined;
  let agentTasks: AgentTaskService | undefined;
  let mediaGeneration: MediaGenerationService | undefined;
  let mcpRevision = 0;
  const readHostConfiguration = async (): Promise<Record<string, Json>> => {
    const values = object(object(await sessions.request('config/read', {}))?.values);
    if (!values) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned no host configuration');
    return values;
  };
  // Installed digram plugin directory, whichever record owns it: the official
  // marketplace install after migration, the bundled record on older profiles.
  let digramPluginPath: string | undefined;
  // model3d ships only through the official marketplace and is NOT default-on:
  // the user installs the plugin to get the 3D tools and panel. Unlike the
  // Blender version this replaced there is no runtime download — the WASM kernel
  // ships in the package — so enablement is the only gate.
  let model3dPluginPath: string | undefined;
  let model3dEnabled = false;
  let prototypePluginPath: string | undefined;
  let prototypeEnabled = false;
  let videoEditingPluginPath: string | undefined;
  let videoEditingEnabled = false;
  let pptPluginPath: string | undefined;
  let pptEnabled = false;
  const refreshDigramEnabled = async (snapshot?: Record<string, Json>): Promise<void> => {
    const values = snapshot ?? await readHostConfiguration();
    const plugins = object(values?.plugins) ?? {};
    const installed = object(plugins['digram@klaus-official']) ?? {};
    const legacy = object(plugins['digram@builtin']) ?? {};
    const active = Object.keys(installed).length ? installed : legacy;
    digramPluginPath = typeof active.installPath === 'string' ? active.installPath : undefined;
    digramEnabled = digramPluginPath !== undefined && active.enabled !== false;
    const model3d = object(plugins['model3d@klaus-official']) ?? {};
    model3dPluginPath = typeof model3d.installPath === 'string' ? model3d.installPath : undefined;
    model3dEnabled = model3dPluginPath !== undefined && model3d.enabled !== false;
    const prototype = object(plugins['prototype-studio@klaus-official']) ?? {};
    prototypePluginPath = typeof prototype.installPath === 'string' ? prototype.installPath : undefined;
    prototypeEnabled = prototypePluginPath !== undefined && prototype.enabled !== false
      && existsSync(join(prototypePluginPath, 'runtime', 'dist', 'runtime-manifest.json'));
    const video = object(plugins['video-editing@klaus-official']) ?? {};
    videoEditingPluginPath = typeof video.installPath === 'string' ? video.installPath : undefined;
    videoEditingEnabled = videoEditingPluginPath !== undefined && video.enabled !== false
      && existsSync(join(videoEditingPluginPath, 'runtime', 'dist', 'runtime-manifest.json'));
    const ppt = object(plugins['ppt@klaus-official']) ?? {};
    pptPluginPath = typeof ppt.installPath === 'string' ? ppt.installPath : undefined;
    pptEnabled = pptPluginPath !== undefined && ppt.enabled !== false
      && existsSync(join(pptPluginPath, 'runtime', 'runtime-manifest.json'));
  };
  let hooksStyles: HookStyleService;
  let plugins: PluginService;
  let pluginRestartRequired = false;
  const runtimePolicyProjection = new WindowsRuntimePolicyProjection({
    request: (method, params) => sessions.request(method, object(params) ?? {}),
    isNativeLocal: id => isNativeLocalWindows(process.platform, id, sessionId => workspaces.remoteBinding(sessionId)),
    log: (kind, detail) => log.write(kind, detail),
  });
  const modelSourceStatus = async (source: string) => source === 'subscription' ? account.subscriptions.claudeStatus()
    : source === 'codex' ? account.codexStatus() : request(`${source}/status`, {});
  const configuration = new SessionConfiguration({
    modelSourceStatus,
    state, configRoot, runtimePolicyProjection, request: (method, params) => sessions.request(method, params),
    publishInference: (id, origin) => sessions.publishInferenceChanges(id, origin),
    updateRuntimeConfig: (id, update) => sessions.updateRuntimeConfig(id, update),
    settleBypassedApprovals: id => sessions.settleBypassedApprovals(id),
    log: (kind, detail) => log.write(kind, detail),
    isUnattended: id => cronRuntime?.isRunSession(id) === true,
    refreshModelTiers: () => sessions.refreshModelTiers(),
  });
  let files: FileService | undefined;
  let worktreeStorage: WorktreeStorageService | undefined;
  const worktreeRestores = new Map<string, Promise<void>>();
  const storageArchived = new Set<string>();
  const emitStorageChatsChanged = (event: StorageChatsChanged): void => emit('storage:chats-changed', { kind: event.kind, sessionIds: event.sessionIds });
  function scheduleWorktreeCleanup(): void {
    if (!worktreeStorage) return;
    try { void worktreeStorage.scheduleCleanup().catch(error => log.write('worktree-storage', String(error))); }
    catch (error) { log.write('worktree-storage', String(error)); }
  }
  async function restoreStorageWorkdir(path: string): Promise<void> {
    if (!worktreeStorage) return;
    const pending = [...worktreeRestores].find(([root]) => pathInside(path, root));
    if (pending) { await pending[1]; return; }
    if (existsSync(path)) return;
    for (let candidate = resolve(path); dirname(candidate) !== candidate; candidate = dirname(candidate)) {
      if (!(await worktreeStorage.hasSnapshot(candidate))) continue;
      const existing = worktreeRestores.get(candidate);
      if (existing) { await existing; return; }
      const restoring = worktreeStorage.restore(candidate).then(() => {});
      worktreeRestores.set(candidate, restoring);
      try { await restoring; } finally { worktreeRestores.delete(candidate); }
      return;
    }
  }
  const workspaces = new WorkspaceStore({
    configRoot, push, restoreStorageWorkdir,
    isSessionKnown: id => state.liveSession(id) !== undefined,
    onSessionWorkdirChanged: id => { configuration.markChanged(id); media.revokeSession(id); mobile?.noteSessionMetadata(id); },
    pickDirectory: async () => {
      if (options.chooseWorkdir) return options.chooseWorkdir();
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    pickDirectories: async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory', 'multiSelections'] });
      return result.canceled ? [] : result.filePaths;
    },
  });
  const hooksTrust = new HooksTrustState(configRoot);
  const extensions = new FileExtensionService({
    workspaces, configRoot, hookTrust: hooksTrust, trashPath: path => shell.trashItem(path),
    bundledSkillRoots: [workspaceSkillRoot],
    pluginCommandSources: () => plugins.catalog.commandSources(),
    resolveCommandSession: async id => { await sessions.threadRow(id); return workspaces.resolveSessionDirectory(id); },
    commandPromptRows: (id, cwd) => resolve(workspaces.resolveSessionDirectory(id)) === resolve(cwd) ? mcpRuntime?.service.promptRows(id) ?? [] : [],
    prepareCommandRefresh: async () => { await sessions.client(); },
    request: (method, params) => sessions.request(method, object(params) ?? {}),
    onChanged: async kind => { configuration.markChanged(); emit('app:preferences-changed', { key: kind }); },
    diagnostic: (path, error) => log.write('extensions', `${path}: ${String(error)}`),
  });
  early.add(() => extensions.close());
  const publishSkillCatalogChange = (): void => {
    emit('skills:changed', {});
    // Session lanes can be busy; filesystem notifications must keep advancing.
    void sessions?.publishSkillChanges().catch(error => log.write('skill-catalog-publication', String(error)));
  };
  const invalidateSkillCatalog = async (): Promise<void> => {
    extensions.discovery.invalidateSkills();
    // A managed write can hold a directory mutation lease. Publication joins
    // the session lane asynchronously; turn admission also awaits this catalog.
    publishSkillCatalogChange();
  };
  const skillWatcher = new SkillWatcher({ configRoot,
    invalidate: () => extensions.discovery.invalidateSkills(),
    onChanged: publishSkillCatalogChange,
    diagnostic: (path, error) => log.write('skill-watch', `${path}: ${String(error)}`),
  });
  await skillWatcher.subscribe([]);
  early.add(() => skillWatcher.close());
  const widgets = new WidgetService(configRoot, id => workspaces.resolveSessionDirectory(id));
  const mediaScope = createConversationMediaScope({
    configRoot,
    prepareSessionMedia: id => sessions.prepareSessionMedia(id),
    resolveSessionDirectory: id => workspaces.resolveSessionDirectory(id),
    extraRoots: id => workspaces.extraRoots(id),
    producedBySession: (path, id) => artifactPaths.has(id, path),
  });
  const media = new MediaFiles(mediaScope);
  protocol.handle(MEDIA_SCHEME, request => media.respond(request));
  early.add(() => { media.close(); protocol.unhandle(MEDIA_SCHEME); });
  const attachments = new AttachmentService(workspaces);
  early.add(() => attachments.close());
  const pastedText = new PastedTextService(workspaces);
  // Finish deletions a previous run marked but did not complete.
  void pastedText.sweep();
  // Wake signals for `wait_threads`: engine activity nudges every active wait to
  // look again, and human input into the CALLER ends its own wait immediately.
  // See thread-wait-signals.ts for why these are two separate signal kinds.
  const threadWaitSignals = createThreadWaitSignals();
  // Assigned once the account service exists (it owns the official store's
  // decryption); the pump fires it when a qwenwork turn dies on auth.
  let qwenworkReadopt: (() => Promise<boolean>) | null = null;
  // The same late binding for WorkBuddy, whose only recovery is also a re-read of
  // the other client's store.
  let workbuddyReadopt: (() => Promise<boolean>) | null = null;
  let cursorReadopt: (() => Promise<boolean>) | null = null;
  const windowsSandboxSetup = new WindowsSandboxSetup({
    request: (method, params) => sessions.request(method, object(params) ?? {}),
    currentGeneration: () => { const current = sessions.engine(); return current && !current.client.isClosed() ? current.generation : undefined; },
    push: emit,
  });
  const events = new SessionEventPump({
    state, forwarder: chat, emit, configRoot,
    isPrivateThread: id => retiredPrivateSessions.isPrivateThread(id),
    isUnattended: id => cronRuntime?.isRunSession(id) === true,
    answerAttachments: groups => attachments.answerAttachments(groups),
    currentGeneration: () => sessions.engine()?.generation,
    log: (kind, detail) => log.write(kind, detail),
    onQwenWorkAuthFailed: () => qwenworkReadopt?.(),
    onWorkBuddyAuthFailed: () => workbuddyReadopt?.(),
    onCursorAuthFailed: () => cursorReadopt?.(),
    // Capability reloads defer while a turn runs; settle them when the session
    // goes idle so credentials installed mid-turn reach the live engine without
    // waiting for the next session activation.
    onTurnSettled: async rendererSessionId => {
      const bindings = state.bindings().filter(binding => binding.rendererId === rendererSessionId);
      if (!bindings.length) return;
      await refreshBoundHostCapabilities('turn-settled', bindings);
      emit('mcp:status:updated', { cwd: null });
    },
    resolveMcpElicitation: async (engineId, generation, requestId, response) => {
      const current = sessions.engine();
      if (!current || current.generation !== generation || current.client.isClosed()) throw new Error('The MCP elicitation engine connection changed');
      const terminal = object(await requestAcknowledged(current.client, 'session/resolveMcpElicitation', { sessionId: engineId, requestId, response }, 'mcpElicitationResolved'));
      if (terminal?.requestId !== requestId || terminal.action !== response.action) throw new Error('The engine did not confirm the requested MCP elicitation response');
    },
    observe: (event, generation) => { notifications?.observeEngine(event); petActivity?.observeEngine(event); petRealtime?.observeEngine(event); chatRealtime?.observeEngine(event); cronRuntime?.observeEngine(event); teamCollaboration?.observeEngine(event); dream?.observeEngine(event); memorySnapshots?.receive(event); dynamicTools?.receive(event, generation); threadWaitSignals.engineChanged(event); },
  });
  sessions = new SessionService({
    modelSourceStatus,
    manager: engine, state, configRoot, workspaces, extensions: extensions.discovery, clientVersion: app.getVersion(), runtimePolicyProjection,
    onGoalSnapshot: (id, snapshot) => events.publishGoalSnapshot(id, snapshot, true),
    adaptiveTitlesEnabled: () => featureGates?.enabled('adaptiveThreadTitles') ?? false,
    beforeUnarchive: async id => {
      const snapshot = await worktreeStorage?.snapshotForSession(id);
      if (!snapshot) return;
      await restoreStorageWorkdir(snapshot.path);
      if (!workspaces.customWorkdir(id)) {
        const row = await sessions.threadRow(id);
        const workdir = typeof row.workdir === 'string' && pathInside(row.workdir, snapshot.path) ? row.workdir : snapshot.path;
        workspaces.bindSession(id, { workdir, projectRoot: snapshot.repoRoot });
      }
    },
    onActivated: async id => {
      const catalog = state.skillCatalog(id), engineId = state.liveSession(id);
      if (!catalog || !engineId) return;
      const registration = await skillWatcher.subscribe([catalog.cwd, ...workspaces.extraRoots(id)]);
      if (state.liveSession(id) !== engineId) { await registration.dispose(); return; }
      // Close the gap between the startup scan and registration of its watches.
      extensions.discovery.invalidateSkills();
      const previous = skillWatches.get(id);
      skillWatches.set(id, registration);
      await previous?.dispose();
    },
    log: (kind, message) => log.write(kind, message),
    sessionStyles: (cwd, extraRoots, configValues) => hooksStyles.sessionExtensions(cwd, configValues, extraRoots ?? []),
    messageInput: (text, media, types) => attachments.input(text, media, types),
    mediaInputMimeTypes: sessionId => composer ? composer.mediaInputMimeTypes(sessionId) : Promise.resolve([]),
    answerAttachments: groups => attachments.answerAttachments(groups),
    deviceContext: async (addresses) => {
      const discovered = await remoteThreads?.discover(AbortSignal.timeout(10_000)).catch(() => null) ?? null;
      if (!discovered) return '';
      return deviceContextBlock(addresses, discovered);
    },
    conversationContext: async (references, currentSessionId) => conversationContextBlock(references, currentSessionId),
    friendContext: (text, metadata, sessionId) => friends ? friends.composerContext(text, metadata, sessionId) : Promise.resolve(''),
    friendDispatch: (text, metadata, sessionId) => friends ? friends.dispatchComposer(text, metadata, sessionId) : Promise.resolve(false),
    friendAccountId: () => communicationAccount()?.userId,
    browserTabContext: (references, currentSessionId) => new BrowserTabMentionService(browserMcp.manager, browserMcp.chrome).context(references, currentSessionId),
    dynamicTools: async (configValues, rendererId) => {
      const definitions = dynamicTools?.definitions() ?? [];
      // Read per session init, not once at startup, so flipping the switch takes
      // effect for the NEXT conversation without restarting the app. Already-open
      // conversations keep the specs they were given — that is what the
      // preference's own "applies the next time the feature runs" wording means,
      // and it is why ThreadToolsService ALSO guards at execution time.
      const filtered = withThreadToolsGate(definitions, threadToolsEnabled(configRoot));
      // The summary text has exactly one consumer: the pet surface on screen.
      // While that surface is hidden the tool stays out of the session, so no
      // call can be produced for a display nobody sees. Read per session init,
      // like the thread-tools gate above: opening or closing the pet takes
      // effect for the next conversation, and open ones keep their specs.
      const gated = withRunningSummaryGate(filtered, runningSummaryAvailable(desktopPet?.snapshot()));
      // Remote-workspace sessions get only the remote_* tools and local sessions
      // never see them: the same tool name must not mean two filesystems.
      const remoteScoped = rendererId ? workspaces.remoteBinding(rendererId) : null;
      const scoped = gated.filter(spec => string(object(spec)?.name).startsWith('remote_') === (remoteScoped !== null));
      // Friend conversations use the ordinary host tool catalog. Only their
      // task-only reply and access-request tools are added to it. The friends
      // feature switch withdraws the whole family from every catalog; like the
      // gates above it is read per session init, and FriendsService also guards
      // at execution time for conversations already open.
      const friendScoped = rendererId && friendSessionScope(configRoot, rendererId)
        ? scoped
        : scoped.filter(spec => !FRIEND_TASK_ONLY_TOOL_NAMES.has(string(object(spec)?.name)));
      return withFriendToolsGate(friendScoped, friendsEnabled(configRoot));
    },
    productContextNote: rendererId => [productContextNote(), runningSummaryContextNote(runningSummaryAvailable(desktopPet?.snapshot())),
      !workspaces.remoteBinding(rendererId) ? workspaceDependencyNote() : '',
    ].filter(Boolean).join('\n\n'),
    spawnOptions: () => ({
      command: engineExecutable,
      args: [], env: desktopEngineEnvironment(configRoot),
    }),
    onEvent: (event, generation) => {
      windowsSandboxSetup.receive(event, generation);
      mcpRuntime?.receive(event, generation);
      const current = sessions.engine();
      if (current && !current.client.isClosed() && current.generation === generation && composer?.receiveEngineEvent(event)) {
        setImmediate(() => { if (!closing) void configuration.refreshSubagentModelCatalog().catch(error => log.write('subagent-model-catalog', String(error))); });
      }
      if (event.type === 'streamClosed') {
        computerUse?.connectionLost();
        void connectors?.connectionLost().catch(error => log.write('connector-disconnected', String(error)));
      }
      events.receive(event, generation);
      for (const binding of state.bindings()) {
        if (state.isWorking(binding.rendererId)) {
          if (!predictionRunningSessions.has(binding.rendererId)) void composerPredictions?.invalidateSession(binding.rendererId);
          predictionRunningSessions.add(binding.rendererId);
        } else predictionRunningSessions.delete(binding.rendererId);
      }
    },
    onAttached: async () => {
      await retiredPrivateSessions.recover().catch(error => log.write('retired-private-session-recovery', String(error)));
      notifications?.resetEngine(); petActivity?.resetEngine();
      // The ONLY clear-event for the titlebar engine badge: a real, handshaken
      // engine connection is what retires a reconnecting/error state, never a
      // timer or a turn boundary.
      emit('engine:status', { status: 'ok' });
      setImmediate(scheduleWorktreeCleanup);
      if (!pluginRestartRequired) return;
      pluginRestartRequired = false;
      emit('app:preferences-changed', { key: 'plugins' });
    },
    onDisconnected: () => {
      predictionRunningSessions.clear();
      void composerPredictions?.invalidateAll();
      if (!closing) emit('engine:process-crashed', { detail: 'The engine connection closed unexpectedly. Retry to resume the conversation.' });
    },
    onInterrupted: id => { notifications?.interrupted(id); petActivity?.interrupted(id); },
    isPrivateThread: id => retiredPrivateSessions.isPrivateThread(id),
    isSessionRetirementProtected: id => (chatVoiceRequestId !== undefined && chatVoiceTargetSessionId === id) || mobile?.hasSessionInterest(id) === true,
    onThreadRow: row => {
      notifications?.remember(row); petActivity?.remember(row);
      const id = typeof row.id === 'string' ? row.id : '';
      if (id && row.archived === true && !storageArchived.has(id)) { storageArchived.add(id); setImmediate(scheduleWorktreeCleanup); }
      else if (id && row.archived === false) storageArchived.delete(id);
      if (id && row.archived === true && chatVoiceTargetSessionId === id) void stopChatVoiceSession(id).catch(error => log.write('voice-chat-archive', String(error)));
      if (id && typeof row.archived === 'boolean') {
        const previous = powerSuppressedConversations.has(id);
        if (row.archived) powerSuppressedConversations.add(id); else powerSuppressedConversations.delete(id);
        if (previous !== row.archived) powerRuntime?.changed();
      }
    },
    onInput: id => threadWaitSignals.input(id),
    pushChatEvents: list => chat.enqueue(list),
    hostCapabilitiesRevision: () => mcpRevision,
    hostCapabilities: async (id, cwd, configValues) => {
      const values = configValues ?? await readHostConfiguration();
      const declarations = await mcp.resolvedServerSet(cwd, values, workspaces.extraRoots(id));
      await refreshDigramEnabled(values);
      for (const skipped of declarations.skipped) if (skipped.reason !== 'disabled') log.write('mcp-declaration', `${skipped.scope}/${skipped.name}: ${skipped.reason}`);
      return combineHostCapabilities(declarations.servers, await Promise.all([browserMcp.hostCapabilities(id), digram.hostCapabilities(id), model3d.hostCapabilities(id), prototype.hostCapabilities(id), videoEditing.hostCapabilities(id), ppt.hostCapabilities(id), computerUse!.hostCapabilities(id), connectors!.hostCapabilities(id)]));
    },
    projectHistory: (history, id, scope) => {
      // Reopening a conversation must not blank images that rendered fine before
      // the reload: the ledger is in-memory, so refill it from the projected
      // history before anything asks the media channel for one of its paths.
      recordArtifactPathsFromHistory(artifactPaths, id, history);
      return restoreLegacyDiagramCards(friends?.projectHistory(history, id, scope) ?? history, id, digram.store);
    },
    providers: {},
    beforeRemoveWorkspace: path => quiesceResources(path),
    onWorkspaceRemoved: path => forgetDirectory(path),
    onDeleted: async (id, options) => {
      await chatRealtime?.releaseSession(id);
      await petRealtime?.releaseSession(id);
      if (!options?.preserveFriendScope) { forgetFriendSession(configRoot, id); friends?.forgetConversation(id); }
      notifications?.forget(id); petActivity?.forget(id);
      mobile?.forgetSession(id);
      dream?.forget(id); memorySnapshots?.forget(id);
      pip?.service.removeSession(id, true);
      await computerUse?.releaseSession(id);
      await connectors?.releaseSession(id);
      await mediaGeneration?.releaseSession(id);
      events.agentTasks.forget(id);
      files?.stopWatching(id); media.revokeSession(id); workspaces.forgetSession(id);
      artifactPaths.forget(id);
      digram.releaseSession(id);
      model3d.releaseSession(id);
      prototype.releaseSession(id);
      videoEditing.releaseSession(id);
      await ppt.releaseSession(id);
      runPreview?.releaseSession(id);
      widgets.releaseSession(id);
      await browserMcp.releaseSession(id);
      await agentTasks?.remove(id);
    },
    onClosed: async id => { await ppt.releaseSession(id); dream?.forget(id); memorySnapshots?.forget(id); pip?.service.removeSession(id, false); await computerUse?.releaseSession(id); await connectors?.releaseSession(id); await mediaGeneration?.releaseSession(id); events.agentTasks.forget(id); files?.stopWatching(id); media.revokeSession(id); digram.releaseSession(id); model3d.releaseSession(id); runPreview?.releaseSession(id); widgets.releaseSession(id); await browserMcp.releaseSession(id); },
    browserTurnStarted: (id, turnId) => browserMcp.chrome.turnStarted(id, turnId),
    browserTurnEnded: id => browserMcp.chrome.turnEnded(id),
    onClosing: async (id, engineId, generation) => { state.markModelChanged(id); await Promise.all([mcpRuntime?.retire(id, engineId, generation), computerUse?.releaseSession(id), connectors?.releaseSession(id), mediaGeneration?.releaseSession(id)]); },
    beginClosing: async (id, engineId, generation) => {
      await chatRealtime?.releaseSession(id);
      await composerPredictions?.invalidateSession(id);
      const release = await mcpRuntime?.beginClosing(id, engineId, generation) ?? (() => {});
      try { await Promise.all([computerUse?.releaseSession(id), connectors?.releaseSession(id), mediaGeneration?.releaseSession(id)]); return release; } catch (error) { release(); throw error; }
    },
  });
  const refreshBoundHostCapabilities = async (reason: string, bindings: HostCapabilityBinding[]): Promise<void> => {
    const outcomes = await refreshIdleHostCapabilities(
      bindings,
      id => state.isWorking(id),
      id => sessions.reloadHostCapabilities(id),
    );
    for (const outcome of outcomes) {
      if (outcome.status !== 'failed') continue;
      const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      log.write('host-capability-reload', `${reason}/${outcome.rendererId}: ${detail}`);
    }
  };
  const retiredPrivateSessions = new RetiredPrivateSessions({ configRoot, engine: () => sessions.engine() });
  dynamicTools = new DynamicTools({
    request: (method, params) => {
      const current = sessions.engine();
      if (!current || current.client.isClosed()) return Promise.reject(new Error('The engine connection closed'));
      return current.client.requestWithTimeout(method, params, 15_000);
    },
    knownSession: id => state.bindings().some(binding => binding.engineId === id),
    log: message => log.write('dynamic-tools', message),
  });
  const hostToolContext = (engineId: string, signal: AbortSignal): ThreadToolContext => {
    const owner = state.bindings().find(binding => binding.engineId === engineId && state.bindingUsable(binding));
    const endpoint = sessions.engine();
    if (!owner || !endpoint || endpoint.client.isClosed()) throw new IpcHandlerError('SESSION_UNAVAILABLE', 'The calling task is no longer active');
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      const current = sessions.engine();
      // `bindingUsable` keeps a binding that a durable settings write marked stale while
      // this turn runs: the write came from the turn's own tool call, and rebuilding the
      // binding under a running turn is exactly what `resolveLiveSession` refuses to do.
      if (closing || sessions.isSessionClosing(owner.rendererId) || !current || current.client !== endpoint.client || current.generation !== endpoint.generation || current.client.isClosed()
        || !state.bindingUsable({ rendererId: owner.rendererId, engineId })
        || retiredPrivateSessions.isPrivateThread(owner.rendererId)) throw new IpcHandlerError('SESSION_UNAVAILABLE', 'The calling task is no longer active');
    };
    assertCurrent();
    return { sessionId: owner.rendererId, signal, assertCurrent, unattended: cronRuntime?.isRunSession(owner.rendererId) ?? false };
  };
  dynamicTools.register(RUNNING_SUMMARY_TOOL_SPEC, (args, engineId, signal) => {
    const context = hostToolContext(engineId, signal);
    context.assertCurrent();
    if (!state.isWorking(context.sessionId)) throw new Error('The calling task is no longer running.');
    return runningSummaryResult(args);
  });
  dynamicTools.register(SHOW_WIDGET_TOOL_SPEC, async (args, engineId, signal, callId) => {
    const context = hostToolContext(engineId, signal);
    const result = await widgets.run(args, context.sessionId, callId);
    context.assertCurrent();
    return result;
  });
  let remoteThreads: RemoteThreadClient | undefined;
  let deviceStatusCache: { at: number; status: Record<string, string> } | null = null;
  const threadTools = new ThreadToolsService({
    sessions, isPrivateThread: id => retiredPrivateSessions.isPrivateThread(id),
    remote: {
      discover: signal => {
        if (!remoteThreads) throw new IpcHandlerError('APP_STARTING', 'Remote chat communication is starting');
        return remoteThreads.discover(signal);
      },
      request: (hostId, name, args, callerId, signal, requestId) => {
        if (!remoteThreads) throw new IpcHandlerError('APP_STARTING', 'Remote chat communication is starting');
        return remoteThreads.request(hostId, name, args, callerId, signal, requestId);
      },
    },
    projectRoots: () => {
      const roots = object(workspaces.projectsList())?.roots;
      if (!Array.isArray(roots)) return [];
      return roots.flatMap(entry => {
        const path = object(entry)?.path;
        return typeof path === 'string' && path.trim() ? [path] : [];
      });
    },
    // `worktrees` is constructed further down this function, so read it lazily:
    // the closure runs only when a fork/create actually asks for a worktree,
    // long after the temporal dead zone has passed.
    createWorktree: payload => worktrees.create(payload),
    // `list_projects` needs to say whether each saved folder is a repository, and
    // `git` is constructed below this point, so read both lazily — the closure runs
    // only when the tool is actually called. `isGitRepository` uses the same
    // `findRoot` the worktree service resolves a repository with, so a project that
    // reports "worktree-able" here is one the worktree path will also accept.
    projects: async () => {
      const roots = object(workspaces.projectsList())?.roots;
      const rows = Array.isArray(roots) ? roots : [];
      return Promise.all(rows.flatMap(entry => {
        const row = object(entry);
        const path = typeof row?.path === 'string' ? row.path : '';
        const label = row?.label;
        const count = row?.conversationCount;
        if (!path.trim()) return [];
        return [(async () => ({
          path,
          ...(typeof label === 'string' && label.trim() ? { label } : {}),
          ...(typeof count === 'number' ? { conversationCount: count } : {}),
          isGitRepository: Boolean(await git.findRoot(path)),
        }))()];
      }));
    },
    // Directory rebinding is workspace state, so it goes to the workspace store
    // rather than through the session service.
    setWorkdir: payload => workspaces.setWorkdir(payload),
    // Event-driven wakeups for `wait_threads`, wired to the same signal hub the
    // engine pump and the composer input path feed.
    wait: {
      onChange: listener => threadWaitSignals.onChange(listener),
      onInput: (threadId, listener) => threadWaitSignals.onInput(threadId, listener),
    },
    // Second gate behind the spec filter above: a conversation that already had
    // the specs when the flag was on must not execute them after the user turns
    // it off. Same settings row, read per call.
    enabled: () => threadToolsEnabled(configRoot),
    // `list_hosts` describes this computer to a model, so it reports the same
    // platform string the account device list uses and the same version the rest
    // of the app reports. Read per call: the version cannot change under a running
    // app, but a test can.
    localHostInfo: () => ({
      platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform,
      appVersion: app.getVersion(),
    }),
  });
  registerThreadTools(dynamicTools, threadTools, hostToolContext);
  for (const spec of FRIEND_TOOL_SPECS) dynamicTools.register(spec, async (args, engineId, signal, callId, turnId) => {
    if (!friends) throw new IpcHandlerError('APP_STARTING', 'Friends messaging is starting');
    const context = hostToolContext(engineId, signal);
    const identity = JSON.stringify([turnId || state.runningSubmissionId(context.sessionId) || randomUUID(), callId]);
    return friends.execute(string(spec.name), object(args) ?? {}, { ...context, toolCallId: callId }, identity);
    // A drafted message or directory request waits on the owner, who may be away;
    // the call must outlive that wait rather than end as an unanswered timeout.
  }, { timeoutMs: FRIEND_OWNER_WAIT_MS });
  registerWorkspaceDependencyTool(dynamicTools, workspaceDependencySettings, workspaceSkillRoot, (engineId, signal) => {
    const owner = hostToolContext(engineId, signal);
    return { assertCurrent: owner.assertCurrent, local: workspaces.remoteBinding(owner.sessionId) === null };
  });
  early.add(() => threadTools.close());
  for (const spec of CRON_TOOL_SPECS) dynamicTools.register(spec, args => {
    const result = executeCronTool(cronStore, String(object(spec)?.name), args);
    emit('app:preferences-changed', { key: 'cron' });
    return result;
  });
  early.add(() => dynamicTools?.close());
  cronRuntime = new CronRuntime({
    store: cronStore, newSession: options => {
      const automation = object(options.hostMetadata?.automation) ?? {};
      const model = string(automation.model), thinking = string(automation.thinking);
      return sessions.newSession({
        ...options,
        ...(typeof options.workdir === 'string' && options.workdir ? { workdir: options.workdir } : {}),
        ...(model ? { modelOverride: model } : {}),
        ...(thinking ? { thinkingOverride: thinking } : {}),
      });
    },
    send: (id, prompt, displayMetadata) => sessions.send(id, { text: prompt, ...(displayMetadata ? { displayMetadata } : {}) }, undefined, undefined, { frame: true }), interrupt: id => sessions.interrupt(id, undefined, 'system'),
    rendererId: id => state.bindings().find(binding => binding.engineId === id)?.rendererId,
    finished: id => configuration.markChanged(id),
    notifyOutcome: value => notifications?.cronOutcome(value),
    deliver: async (binding, text) => { if (!await channels.deliverToBinding(object(binding) ?? {}, text)) throw new Error('The messaging channel did not confirm scheduled delivery'); },
    push, log: message => log.write('cron', message),
  });
  early.add(() => cronRuntime?.close());
  engine.on('requestDiagnostic', record => { log.write('engine-request', JSON.stringify(record)); cursorDiagnostics.scheduler(record); });
  engine.on('cursorWireDiagnostic', record => cursorDiagnostics.record('wire', record.phase, record));
  engine.on('stderr', ({ chunk, generation }: { chunk: Buffer; generation: number }) => {
    log.write('engine-stderr', `[${generation}] ${chunk.toString('utf8')}`);
    cursorDiagnostics.stderr(chunk, generation);
  });
  // The exit code/signal is the only evidence of HOW an engine died (a binary
  // overwritten on disk presents as a signal kill); without this line the host
  // log shows the fallout but never the cause.
  engine.on('exit', ({ generation, key, code, signal }: { generation: number; key: string; code: number | null; signal: string | null }) => {
    log.write('engine-exit', `[${generation}] ${key} exited (code=${code} signal=${signal})`);
    cursorDiagnostics.exit(generation, code, signal);
  });
  const registry = new ChannelRegistry();
  const discordAccess = registerDiscordAccessHandlers(registry, { configRoot, onChanged: () => emit('app:preferences-changed', { key: 'channels' }) });
  early.add(() => discordAccess.close());
  const channelTurns = new ChannelTurns({ sessions,
    changed: row => { chat.enqueue([{ type: 'session_title_updated', sessionId: String(row.id), title: String(row.title ?? '') }]); },
  });
  early.add(() => channelTurns.close());
  const whatsappPairing = registerWhatsAppPairingHandlers(registry, {
    nativeFactory: options.whatsappNativeFactory ?? ((opts, deliver) => new NativeWhatsAppTransport({ ...opts, addonPath: native.addonPath }, deliver)),
    enable: async signal => {
      const result = await channels.connect({ id: 'whatsapp', config: {} }, signal);
      if (result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : 'WhatsApp could not start');
    },
  });
  early.add(() => whatsappPairing.close());
  channels = registerChannelHandlers(registry, { configRoot, factories: { wechat: wechatAdapter(), whatsapp: whatsappPairing.factory, telegram: telegramAdapter(), wecom: wecomAdapter(), qq: qqAdapter(), dingtalk: dingtalkAdapter(), feishu: feishuAdapter(), discord: discordAdapter({ ...options.discordTransport, access: discordAccess }), ...options.channelTransports },
    runTurn: (input, signal) => channelTurns.run(input, signal),
    beforeDisconnect: id => { if (id === 'wechat') wechatPairing.cancel(); if (id === 'whatsapp') whatsappPairing.cancel(); },
    onChanged: () => emit('app:preferences-changed', { key: 'channels' }),
    onFailure: (channelId, label, error) => { log.write('channel-failed', `${channelId}: ${error}`); push('channel:failed', { label, error }); notifications?.channelFailure(label, error); },
  });
  early.add(() => channels.close());
  const wechatPairing = registerWechatPairingHandlers(registry, { configRoot, fetch: options.wechatPairingFetch, onPaired: (_id, signal) => channels.restart('wechat', signal) });
  early.add(() => wechatPairing.close());
  const permissionRules = registerPermissionRuleHandlers(registry, {
    request: (method, params) => sessions.request(method, object(params) ?? {}),
    onChanged: async () => {
      try { await sessions.reloadPermissionRules(); }
      catch (error) { log.write('permission-rules', `Saved rules could not refresh every live conversation: ${String(error)}`); }
      emit('app:preferences-changed', { key: 'permission-rules' });
    },
  });
  early.add(() => permissionRules.close());
  registerUpdaterHandlers(registry, updater);
  registerAttachmentHandlers(registry, attachments, pastedText);
  registerFileExtensionHandlers(registry, { extensions, workspaces, configRoot, trashPath: path => shell.trashItem(path), onChanged: async () => configuration.markChanged() });
  hooksStyles = registerHookStyleHandlers(registry, {
    workspaces, hookTrust: hooksTrust, request: (method, params) => sessions.request(method, object(params) ?? {}),
    onChanged: async kind => { configuration.markChanged(); emit('app:preferences-changed', { key: kind }); },
    diagnostic: (path, error) => log.write('hooks-styles', `${path}: ${String(error)}`),
  });
  early.add(() => hooksStyles.close());
  mcp = registerMcpConfigurationHandlers(registry, {
    workspaces, request: (method, params) => sessions.request(method, object(params) ?? {}),
    resolveCwd: async id => { await sessions.threadRow(id); return workspaces.resolveSessionDirectory(id); },
    onChanged: async cwd => {
      mcpRevision++;
      const bindings = state.bindings().filter(binding => cwd === undefined || resolve(workspaces.resolveSessionDirectory(binding.rendererId)) === resolve(cwd));
      await refreshBoundHostCapabilities('mcp-configuration', bindings);
      emit('mcp:status:updated', { cwd: cwd ?? null });
    },
    diagnostic: (path, error) => log.write('mcp-configuration', `${path}: ${String(error)}`),
  });
  early.add(() => mcp.close());
  // Assigned below, once the official marketplace service exists. Plugin
  // packages are fetched on demand, and the install path needs the service that
  // can fetch them — but that service is constructed after this deps object, so
  // the hook closes over a holder rather than the instance.
  let officialPluginPackages: { ensureDownloaded: OfficialPluginsService['ensureDownloaded'] } | undefined;
  let pluginUpdateCheck: (() => Record<string, Json>) | undefined;
  const pluginDeps = {
    configRoot, seedDir: join(resourceDirs[0]!, 'plugins-seed'),
    request: (method: string, params: Json) => sessions.request(method, object(params) ?? {}),
    requestAcknowledged: async (method: string, params: Record<string, Json>, field: string) => requestAcknowledged(await sessions.client(), method, params, field),
    binding: (id: string) => {
      const engineId = state.liveSession(id);
      return engineId ? { engineId, stale: state.isStale(id) } : undefined;
    },
    resolveSession: async (id: string) => { await sessions.threadRow(id); return sessions.resolveLiveSession(id); },
    endpointRestartRequired: () => pluginRestartRequired,
    updateCheck: () => pluginUpdateCheck?.() ?? { checking: false },
    // Fetch an official plugin's package if the manifest names one that is not on
    // disk yet. Returning false leaves the install to fail with its own message
    // rather than silently staging an empty directory.
    ensurePackage: (name: string, signal: AbortSignal, onProgress?: Parameters<OfficialPluginsService['ensureDownloaded']>[2]) =>
      officialPluginPackages?.ensureDownloaded(name, signal, onProgress) ?? Promise.resolve(false),
    onProgress: (progress: PluginProgressEvent) => { push('plugins:progress', { ...progress }); },
    onChanged: async ({ mutation }: { mutation: Record<string, Json> }) => {
      if (mutation.restartRequired === true || mutation.activationScope === 'endpoint_restart') pluginRestartRequired = true;
      configuration.markChanged();
      emit('app:preferences-changed', { key: 'plugins' });
      await refreshDigramEnabled();
    },
    diagnostic: (message: string) => log.write('plugins', message),
    // One bounded record per failed plugin mutation, addressed by the failure
    // receipt so a diagnosing conversation can read exactly this failure.
    failureLog: (info: Record<string, unknown>) => {
      try {
        const dir = join(configRoot, 'plugin-failures');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const stamp = String(info.at || new Date().toISOString()).replace(/[:.]/g, '-');
        const safe = String(info.id || 'plugin').replace(/[^A-Za-z0-9.@_-]/g, '_');
        const path = join(dir, `${stamp}-${String(info.action || 'change')}-${safe}.log`);
        writeFileSync(path, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
        return path;
      } catch (error) { log.write('plugins', `plugin failure log write failed: ${String(error)}`); return undefined; }
    },
  };
  plugins = registerPluginHandlers(registry, pluginDeps);
  registerRuntimeViewHandlers(registry, { ...pluginDeps, runtime: plugins.runtime });
  early.add(() => plugins.close());
  // Constructed before the marketplace service: its refresh is wired into the
  // UI refresh button so newly published official plugins appear without a
  // restart (the marketplace refresh runs ours first, then reads the catalog).
  const officialPlugins = new OfficialPluginsService({ configRoot,
    request: (method, params) => sessions.request(method, object(params) ?? {}),
    endpoint: () => { const token = object(readStoredAuth(configRoot))?.token;
      return resolveSkillMarketEndpoint({ serverUrl: account.serverUrl, token: typeof token === 'string' ? token : undefined, environment: process.env }); },
    onChanged: async () => { pluginRestartRequired = true; configuration.markChanged(); emit('app:preferences-changed', { key: 'plugins' }); await refreshDigramEnabled(); },
    diagnostic: message => log.write('official-plugins', message),
  });
  early.add(() => officialPlugins.close());
  officialPluginPackages = officialPlugins;
  const pluginMarketplaces = new PluginMarketplaceService({ workspaces, plugins, request: pluginDeps.request, seedDir: pluginDeps.seedDir,
    klausOfficial: officialPlugins,
    shouldRefreshOfficial: async () => {
      const reply = object(await pluginDeps.request('session/installedPlugins', {})) ?? {};
      if (reply.error != null) throw reply.error;
      const ledger = object(reply.installedPlugins ?? reply) ?? {};
      return Object.keys(object(ledger.plugins) ?? {}).some(id => id.endsWith('@claude-plugins-official'));
    },
    onChanged: async () => { configuration.markChanged(); emit('app:preferences-changed', { key: 'plugins' }); },
    onCheckChanged: () => emit('app:preferences-changed', { key: 'plugins' }),
    diagnostic: message => log.write('plugin-marketplaces', message),
  });
  pluginUpdateCheck = () => pluginMarketplaces.updateCheck();
  const checkPluginUpdates = (): void => { void pluginMarketplaces.refresh({ ifStale: true }).catch(error => log.write('plugin-marketplaces', 'Background check failed: ' + String(error))); };
  registerPluginMarketplaceHandlers(registry, pluginMarketplaces);
  early.add(() => pluginMarketplaces.close());
  early.add(() => { app.removeListener('browser-window-focus', checkPluginUpdates); });
  registerSessionHandlers(registry, { sessions, state, events, configRoot,
    onAttentionResolved: (kind, value) => petActivity?.input(`${kind}:resolved`, value),
    chooseExportPath: options.chooseSessionExportPath ?? (async defaultPath => {
      const result = await dialog.showSaveDialog(window, { defaultPath, filters: [{ name: 'Text', extensions: ['txt'] }] });
      return result.canceled ? undefined : result.filePath;
    }),
  });
  const storageMetaRow = (row: Record<string, unknown>): SessionStorageMeta => ({
    id: String(row.id),
    archived: row.archived === true,
    running: sessions.isStorageBusy(String(row.id)),
    pinned: row.pinned === true || Number(row.sidebarPinnedAt) > 0,
    updatedAt: Number(row.updatedAt || row.createdAt || 0) || 0,
    workdir: typeof row.workdir === 'string' ? row.workdir : undefined,
    parentSessionId: typeof row.parentSessionId === 'string' ? row.parentSessionId : undefined,
    ephemeral: row.ephemeral === true,
    row,
  });
  const deviceStorage = new DeviceStorageService({
    configRoot,
    cachePath: join(configRoot, 'cache', 'device-storage.json'),
    sessionMeta: async (): Promise<SessionStorageMeta[]> => {
      const rows = await sessions.storageCatalog() as Array<Record<string, unknown>>;
      return rows.map(storageMetaRow);
    },
    sessionRow: async (id): Promise<SessionStorageMeta | null> => {
      const row = await sessions.storageCatalogRow(id) as Record<string, unknown> | null;
      return row ? storageMetaRow(row) : null;
    },
    beforeDelete: id => sessions.holdIdleStorageDeletion(id),
    deleteSession: id => sessions.deleteSession(id, false),
    onDeleted: sessionIds => { emitStorageChatsChanged({ kind: 'deleted', sessionIds }); scheduleWorktreeCleanup(); },
    diagnostic: (kind, detail) => log.write(kind, detail),
  });
  registerStorageHandlers(registry, deviceStorage);
  const queries = registerSessionQueryHandlers(registry, { sessions, state, configRoot, profileActivityLog: detail => log.write('profile-activity', detail) });
  agentTasks = new AgentTaskService({ configRoot, agents: id => queries.agents(id),
    presentation: id => events.agentTasks.presentation(id),
    onSnapshot: (id, tasks) => events.agentTasks.reconcile(id, tasks),
    withFiles: work => workspaces.withDirectoryOperation(async () => [join(configRoot, 'agent-tasks')], work),
  });
  registerAgentTaskHandlers(registry, agentTasks);
  early.add(() => agentTasks?.close());
  const router = new IpcRouter({ registry, roles, broadcaster, hostRoles: { mobile: MOBILE_DISPATCH_CHANNELS }, onRoute: entry => {
    // `entry.result` is `Err(CODE)` for every refused call, including handler-level
    // `IpcHandlerError`s whose `refusal` is undefined and whose elapsed time is
    // usually milliseconds. Gating on `refusal` alone made turn-control refusals
    // (`chat:continue` → TURN_IN_PROGRESS, …) invisible in this log.
    if (entry.refusal || entry.result.startsWith('Err(') || entry.elapsedMs > 1000) log.write('ipc', JSON.stringify(entry));
  } });
  const window = createMainWindow(edition.productName);
  const mainWindows = new Map<number, BrowserWindow>([[window.webContents.id, window]]);
  const composerCommandsByWindow = new Map<number, ComposerEditCommands>();
  const imageZoomByWindow = new Map<number, ImageZoomCommands>();
  const canvasByWindow = new Map<number, CanvasService>();
  const canvasOwnerByRenderer = new Map<number, number>();
  const conversationOwners = new Map<string, number>();
  let lastMainWindow = window;
  function focusedMainWindow(): BrowserWindow {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && mainWindows.get(focused.webContents.id) === focused) return focused;
    if (!lastMainWindow.isDestroyed()) return lastMainWindow;
    return window;
  }
  const sendToMainWindow = (owner: BrowserWindow, channel: string, value?: Json): void => {
    if (owner.isDestroyed() || owner.webContents.isDestroyed() || !roles.mayListen('main', channel)) return;
    owner.webContents.send(pushEventName(channel), pushPayload(value));
  };
  const deliverToFocusedMain = async (channel: string, value: Json, signal?: AbortSignal): Promise<void> => {
    const owner = focusedMainWindow(), targetId = owner.webContents.id;
    if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus();
    await subscriptions.wait(targetId, channel, signal);
    signal?.throwIfAborted(); await delivery.deliver(targetId, channel, value, signal);
  };
  const sessionMainWindow = (id: string): BrowserWindow => mainWindows.get(conversationOwners.get(id) ?? -1) ?? focusedMainWindow();
  function runMainWindowCommand(commandId: string): void {
    void deliverToFocusedMain('keymap:run-command', { commandId })
      .catch(error => log.write('menu-command', `${commandId}: ${String(error)}`));
  }

  early.add(() => { if (!window.isDestroyed()) window.destroy(); });
  const textContextMenusByWindow = new Map<number, () => void>();
  early.add(() => { for (const close of textContextMenusByWindow.values()) close(); textContextMenusByWindow.clear(); });
  // The composer keeps its own undo history because the app rewrites its value
  // programmatically, which Chromium's native undo stack cannot see. Routing the
  // platform's undo/redo into it requires the host, which is the only side that
  // can suppress the keystroke before the menu accelerator answers it. Scoped to
  // the main window's own contents: the embedded browser and the canvas are
  // separate WebContentsViews and keep their native editing behaviour.
  const createComposerCommands = (owner: BrowserWindow): ComposerEditCommands => {
    const commands = new ComposerEditCommands({
      onBeforeInput: listener => {
        owner.webContents.on('before-input-event', listener);
        return () => { if (!owner.isDestroyed()) owner.webContents.removeListener('before-input-event', listener); };
      },
      evaluate: script => owner.isDestroyed() || owner.webContents.isDestroyed() ? Promise.resolve(null) : owner.webContents.executeJavaScript(script, true),
      undo: () => { if (!owner.isDestroyed()) owner.webContents.undo(); },
      redo: () => { if (!owner.isDestroyed()) owner.webContents.redo(); },
    }, { platform: process.platform, log: message => log.write('composer-edit', message) });
    commands.start(); composerCommandsByWindow.set(owner.webContents.id, commands); return commands;
  };
  const composerEditCommands = createComposerCommands(window);
  function mainWindowEditCommands(owner: BrowserWindow): ComposerEditCommands {
    const commands = composerCommandsByWindow.get(owner.webContents.id);
    if (!commands) throw new IpcHandlerError('WINDOW_CLOSED', 'The composer window is unavailable');
    return commands;
  }
  early.add(() => { for (const commands of composerCommandsByWindow.values()) commands.close(); });
  const imageZoomTarget = (contents: WebContents): ImageZoomTarget => ({
    evaluate: script => contents.isDestroyed() ? Promise.resolve(null) : contents.executeJavaScript(script, true),
    nativeZoom: command => {
      if (!contents.isDestroyed()) contents.setZoomLevel(command === 'fit' ? 0 : contents.getZoomLevel() + (command === 'in' ? .5 : -.5));
    },
  });
  const createImageZoomCommands = (owner: BrowserWindow): ImageZoomCommands => {
    const commands = new ImageZoomCommands({
      ...imageZoomTarget(owner.webContents),
      onBeforeInput: listener => {
        owner.webContents.on('before-input-event', listener);
        return () => { if (!owner.isDestroyed()) owner.webContents.removeListener('before-input-event', listener); };
      },
    }, process.platform, message => log.write('image-zoom', message));
    commands.start(); imageZoomByWindow.set(owner.webContents.id, commands); return commands;
  };
  createImageZoomCommands(window);
  const dispatchImageMenuZoom = (command: ImageZoomCommand) => {
    const contents = webContents.getFocusedWebContents() || focusedMainWindow().webContents;
    const commands = imageZoomByWindow.get(focusedMainWindow().webContents.id);
    if (contents && commands) void commands.dispatch(command, imageZoomTarget(contents));
  };
  early.add(() => { for (const commands of imageZoomByWindow.values()) commands.close(); });
  const createCanvas = (owner: BrowserWindow): CanvasService => {
    const ownerId = owner.webContents.id;
    const service = new CanvasService({
      configRoot, resourcesRoot: resourceDirs[0]!, window: owner, emit: (channel, value) => sendToMainWindow(owner, channel, value),
      registerRenderer: (id, role) => { windows.register(id, role); canvasOwnerByRenderer.set(id, ownerId); },
      unregisterRenderer: id => { subscriptions.clearOwner(id); windows.unregister(id); canvasOwnerByRenderer.delete(id); },
      theme: () => { const value = kvGet('theme', configRoot); return value === 'light' || value === 'dark' ? value : 'system'; },
      locale: () => { const value = kvGet('language', configRoot); return typeof value === 'string' && value ? value : app.getLocale(); },
    });
    service.provision(); canvasByWindow.set(ownerId, service); return service;
  };
  const canvas = createCanvas(window);
  early.add(async () => { await Promise.all([...canvasByWindow.values()].map(service => service.dispose())); });
  registerCanvasHandlers(registry, { service: canvas, serviceFor: context => {
    const owner = context.role === 'canvas' ? canvasOwnerByRenderer.get(context.senderId) : context.senderId;
    const service = owner === undefined ? undefined : canvasByWindow.get(owner);
    if (!service) throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'This window does not own a Canvas surface');
    return service;
  } });
  prototype = new PrototypeService({
    configRoot, window, emit, enabled: () => prototypeEnabled, pluginRoot: () => prototypePluginPath,
    language: () => { const value = kvGet('language', configRoot); return typeof value === 'string' && value ? value : edition.defaultLanguage || app.getLocale(); },
    readLegacy: path => canvas.documents.get(path),
    registerRenderer: (id, role) => windows.register(id, role),
    unregisterRenderer: id => { subscriptions.clearOwner(id); windows.unregister(id); },
    log: (event, data) => log.write(event, JSON.stringify(data)),
  });
  early.add(() => prototype.dispose());
  registerPrototypeHandlers(registry, { service: prototype });
  videoEditing = new VideoEditingService({
    configRoot, window, emit, enabled: () => videoEditingEnabled, pluginRoot: () => videoEditingPluginPath,
    registerRenderer: (id, role) => windows.register(id, role),
    unregisterRenderer: id => { subscriptions.clearOwner(id); windows.unregister(id); },
    log: (event, data) => log.write(event, JSON.stringify(data)),
  });
  early.add(() => videoEditing.dispose());
  registerVideoEditingHandlers(registry, { service: videoEditing });
  ppt = new PptService({
    configRoot, window, enabled: () => pptEnabled, pluginRoot: () => pptPluginPath,
    language: () => { const value = kvGet('language', configRoot); return typeof value === 'string' && value ? value : edition.defaultLanguage || app.getLocale(); },
    windowForOwner: id => sessionMainWindow(id), windowForSender: id => mainWindows.get(id),
    emit: (channel, payload, windowId) => { const target = mainWindows.get(windowId ?? window.webContents.id); if (target && !target.isDestroyed()) sendToMainWindow(target, channel, payload); },
    readRoots: id => [workspaces.resolveSessionDirectory(id), ...workspaces.extraRoots(id), join(configRoot, 'uploads')],
    registerRenderer: (id, role) => windows.register(id, role),
    unregisterRenderer: id => { subscriptions.clearOwner(id); windows.unregister(id); },
    log: (event, data) => log.write(event, JSON.stringify(data)),
  });
  early.add(() => ppt.dispose());
  registerPptHandlers(registry, { service: ppt });
  const publishAuthoringActivity = () => ppt.setAuthoringActivity(state.runningSessions());
  const onTurnRunning = state.onTurnRunningChange;
  state.onTurnRunningChange = () => { onTurnRunning?.(); publishAuthoringActivity(); };
  publishAuthoringActivity();
  dynamicTools.register(canvas.toolSpec(), (args, engineId) => {
    const id = state.bindings().find(binding => binding.engineId === engineId)?.rendererId;
    if (!id) throw new IpcHandlerError('SESSION_UNAVAILABLE', 'The Canvas task is no longer active');
    return canvasByWindow.get(sessionMainWindow(id).webContents.id)!.executeCheck(id, object(args) ?? {});
  });
  dynamicTools.register(canvas.documentToolSpec(), (args, engineId) => {
    const id = state.bindings().find(binding => binding.engineId === engineId)?.rendererId;
    if (!id) throw new IpcHandlerError('SESSION_UNAVAILABLE', 'The Canvas task is no longer active');
    return canvas.executeDocument(object(args) ?? {});
  });
  digram = new DigramService({
    configRoot, pluginRoot: () => digramPluginPath, windowId: window.webContents.id, ownsWindow: id => mainWindows.has(id), emit: (channel, value) => {
      if (channel === 'digram:render-request') sendToMainWindow(focusedMainWindow(), channel, value);
      else emit(channel, value);
    }, enabled: () => digramEnabled,
    chooseExportPath: async ({ defaultPath, format }) => {
      const result = await dialog.showSaveDialog(window, { defaultPath,
        filters: [{ name: format.toUpperCase(), extensions: format === 'jpg' ? ['jpg', 'jpeg'] : [format] }] });
      return result.canceled ? undefined : result.filePath;
    },
  });
  early.add(() => digram.shutdown());
  registerDigramHandlers(registry, { service: digram });
  // The 3D surface: one document per task backed by an in-process WASM kernel.
  // No child process and no runtime download, so constructing this is cheap and
  // safe to do unconditionally; the kernel loads lazily on first evaluation.
  model3d = new Model3DService({
    configRoot, windowId: window.webContents.id, ownsWindow: id => mainWindows.has(id),
    workspaces, emit: (channel, value) => {
      if (channel === 'model3d:render-request') sendToMainWindow(sessionMainWindow(string(object(value)?.sessionId)), channel, value);
      else emit(channel, value);
    }, enabled: () => model3dEnabled,
  });
  early.add(() => model3d.shutdown());
  registerModel3DHandlers(registry, { service: model3d });
  let browserRuntimeAvailable = true;
  const browserPreferences = new BrowserPreferences({
    configRoot, request: (method, params) => sessions.request(method, object(params) ?? {}),
    resourceDirs,
    setPluginEnabled: async enabled => plugins.toggle({ id: 'browser@builtin', enabled }),
    changed: action => {
      configuration.markChanged();
      if (['set-origin-policy', 'remove-origin-policy', 'set-approval-mode', 'add-origin', 'remove-origin', 'set-enabled', 'set-site-permission'].includes(action ?? '')) {
        browserAccess.invalidate();
        browserPermissions.clear();
        browser.refreshPermissions();
      }
      emit('settings:browser-use:changed', browserSnapshot());
      browser.publish();
    },
  });
  const browserSnapshot = (): Json => ({ ...browserPreferences.get(), browserAvailable: browserRuntimeAvailable });
  const withBrowserAvailability = (result: Json): Json => {
    const value = object(result);
    if (!value) return result;
    const settings = object(value.settings) ?? {};
    return Object.keys(settings).length
      ? { ...value, settings: { ...settings, browserAvailable: browserRuntimeAvailable } }
      : value;
  };
  // Browser pages ask for permissions through the product window's own dialog
  // rather than an operating-system box: park the question, push it to the
  // renderer and wait for its answer channel.
  const browserPermissions = new PendingBrowserPermissions(undefined, requestId => emit('browser-use:permission-cancelled', { requestId }));
  early.add(() => browserPermissions.clear());
  const browserAccess = new BrowserAccessController({
    access: (url, resource) => browserPreferences.access(url, resource),
    request: async (sessionId, origin, resource, signal) => {
      const { requestId, answered } = browserPermissions.request({ sessionId, origin, pageUrl: origin, permission: `browser:${resource}` });
      const cancelled = (): void => { browserPermissions.answer(requestId, false); };
      signal?.addEventListener('abort', cancelled, { once: true });
      sendToMainWindow(sessionMainWindow(sessionId), 'browser-use:permission-request', { requestId, sessionId, origin, pageUrl: origin, permission: `browser:${resource}` });
      try { if (signal?.aborted) cancelled(); return await answered; }
      finally { signal?.removeEventListener('abort', cancelled); }
    },
  });
  const browser: BrowserManager = new BrowserManager({
    window, configRoot, managedWindows: true,
    emit: (channel, value) => sendToMainWindow(mainWindows.get(browser.windowId) ?? window, channel, value),
    enabled: () => browserPreferences.enabled(),
    available: () => browserRuntimeAvailable,
    navigationAllowed: url => browserPreferences.allowsNavigation(url),
    authorize: (sessionId, url, resource, signal) => browserAccess.authorize(sessionId, url, resource, signal),
    sitePermission: (origin, permission) => browserPreferences.sitePermission(origin, permission),
    sitePermissionDenials: permission => browserPreferences.permissionDenialOrigins(permission),
    downloadDirectory: () => String(browserPreferences.get().downloadDirectory ?? app.getPath('downloads')),
    promptForUserDownloads: () => browserPreferences.get().promptForDownloads === true,
    chooseDownloadPath: async request => {
      const result = await dialog.showSaveDialog(focusedMainWindow(), { defaultPath: request.defaultPath });
      return result.canceled ? undefined : result.filePath;
    },
    requestPermission: async request => {
      const { requestId, answered } = browserPermissions.request(request);
      sendToMainWindow(mainWindows.get(browser.windowId) ?? window, 'browser-use:permission-request', { requestId, ...request });
      return answered;
    },
  });
  early.add(() => { browserRuntimeAvailable = false; browser.dispose(); });
  if (app.isPackaged && options.browserSecretCipher) throw new Error('A packaged application cannot use fixture credential encryption.');
  const browserData = new BrowserDataManagement({ manager: browser, configRoot, resourceDirs, packaged: app.isPackaged, sourceRoots: options.browserImportRoots, fixtureCipher: options.browserSecretCipher,
    windowForOwner: id => mainWindows.get(id),
    emit: (id, snapshot) => { const owner = mainWindows.get(id); if (owner) sendToMainWindow(owner, 'settings:browser-use:import-progress', snapshot as unknown as Json); },
    chinese: () => nativeMenuUsesChinese(kvGet('language', configRoot), edition.defaultLanguage, app.getLocale()),
  });
  early.add(() => browserData.close());
  await browserData.start();
  const annotationStaging = new Map<string, string>();
  const browserAnnotations = new AnnotationSessionManager({ browser, persistence: {
    save: async input => {
      const stored = object(await attachments.upload({ name: 'browser-annotation.png', type: input.mimeType, buffer: input.bytes.toString('base64') }));
      const path = string(stored?.path);
      if (!path) throw new Error('The browser annotation attachment could not be saved.');
      annotationStaging.set(input.snapshotId, path);
      // Drafts can precede a saved conversation. Their preview contains only
      // the screenshot already captured for this owning renderer.
      return { path, name: 'browser-annotation.png', mimeType: input.mimeType, size: input.bytes.length,
        width: input.width, height: input.height, previewUrl: `data:image/png;base64,${input.bytes.toString('base64')}` };
    },
    commit: async input => { annotationStaging.delete(input.snapshotId); },
    discard: async (id, path) => {
      const staged = annotationStaging.get(id);
      if (!staged || path && path !== staged) return;
      annotationStaging.delete(id);
      await rm(staged, { force: true });
    },
  } });
  early.add(() => browserAnnotations.dispose());
  const nativeContentFind = new NativeContentFind({
    onClose: ownerId => { const owner = mainWindows.get(ownerId); if (owner) sendToMainWindow(owner, 'keymap:run-command', { commandId: 'closeContentFind' }); },
    target: ownerId => {
    if (!mainWindows.has(ownerId) || browser.windowId !== ownerId) return null;
    try { return browser.page(browser.conversationId).view.webContents; }
    catch { return null; }
  } });
  early.add(() => nativeContentFind.close());
  runPreview = new RunPreview(browser, (sessionId, toolCallId) => emit('run-preview:changed', { sessionId, toolCallId }));
  dynamicTools.register(RUN_PREVIEW_TOOL_SPEC, (args, engineId, signal, callId) => {
    const context = hostToolContext(engineId, signal);
    return runPreview.start(args, context.sessionId, callId, context.assertCurrent);
  });
  browserMcp = new BrowserMcpServer(browser, {
    releaseAccess: id => browserAccess.release(id),
    chromeEnabled: () => browserPreferences.get().chromeEnabled === true,
    chromeExtensionRoot: join(resourceDirs[0]!, 'plugins-builtin', 'browser', 'chrome-extension'),
    // The managed-policy install points Chrome at this HTTPS update manifest;
    // the CRX beside it is published by scripts/package-chrome-extension.mjs.
    chromePolicyUpdateManifestUrl: process.env.KLAUS_CHROME_EXT_MANIFEST ?? edition.serverUrl + '/ext/update_manifest.xml',
    buildStamp: app.getVersion(),
    reportDiagnostic: message => log.write('chrome', message),
    beginOperation: id => pip?.service.beginOperation(id),
    observeResult: (id, lease, result) => { if (typeof lease === 'number') pip?.service.browserResult(id, lease, result); },
  });
  // A refreshed deploy copy lets a running unpacked extension take over the
  // new build at its next idle moment, without any user action.
  void browserMcp.chrome.syncDeployedExtension().catch(() => {});
  early.add(() => browserMcp.shutdown());
  registerBrowserHandlers(registry, {
    selectWindow: context => {
      const owner = mainWindows.get(context.senderId);
      if (context.role !== 'main' || !owner || owner.isDestroyed()) throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'This window does not own a browser surface');
      const fields = object(context.args[0]) ?? {};
      if (context.channel === 'browser-use:set-conversation' && typeof fields.conversationId === 'string') conversationOwners.set(fields.conversationId, context.senderId);
      const passive = browser.passiveWindowRequest(owner, context.channel, fields);
      if (passive !== undefined) return passive;
      browser.adoptWindow(owner); return undefined;
    },
    manager: browser, data: browserData, annotations: browserAnnotations, preview: runPreview, sites: new SiteOpener(configRoot, browser), chrome: browserMcp.chrome, permissions: browserPermissions, getSettings: () => browserSnapshot(),
    setEnabled: async enabled => withBrowserAvailability(await browserPreferences.setEnabled(enabled)),
    mutateSettings: async (action, value) => withBrowserAvailability(await browserPreferences.mutate(action, value)),
    chooseDownloadDirectory: async () => {
      const result = await dialog.showOpenDialog(focusedMainWindow(), { properties: ['openDirectory', 'createDirectory'],
        defaultPath: String(browserPreferences.get().downloadDirectory ?? app.getPath('downloads')) });
      if (result.canceled || !result.filePaths[0]) return { ok: true, cancelled: true };
      return withBrowserAvailability(await browserPreferences.mutate('set-preferences', { downloadDirectory: result.filePaths[0] }));
    },
  });
  const native = createNativeRuntime(window, registry, {
    configRoot, packaged: app.isPackaged, fixtureAddonPath: options.nativeFixtureAddonPath,
    sessionWorkdir: id => workspaces.remoteBinding(id) ? workspaces.resolveSessionDirectory(id) : null,
    deliver: (id, channel, value) => delivery.deliver(id, channel, value),
    log: (kind, detail) => log.write(kind, detail),
    searchRoots: async id => ({ root: await workspaces.sessionDirectory(id), extraRoots: workspaces.extraRoots(id) }),
  });
  early.add(() => native.shutdown());
  const ssh = createSshRuntime(window, registry, {
    addonPath: native.addonPath, identity: options.sshIdentity,
    deliver: (id, channel, value) => delivery.deliver(id, channel, value),
    log: (kind, message) => log.write(kind, message),
  });
  early.add(() => ssh.shutdown());
  const sshFiles = new SshFileService({ pool: ssh.pool, log: message => log.write('ssh-files', message) });
  const sshOwnerOf = (id: string): number | null => workspaces.remoteBinding(id) ? sessionMainWindow(id).webContents.id : null;
  registerRemoteWorkspaceTools(dynamicTools, { sshFiles, binding: id => {
    const workdir = workspaces.remoteBinding(id);
    return workdir ? { workdir, senderId: sessionMainWindow(id).webContents.id } : null;
  } });
  const credentials = new NativeSubscriptionCredentials({ configRoot, userHome: options.externalAuthHomeDir ?? homedir(), addon: native.addon,
    ...(process.platform === 'win32' ? {
      windowsSafeStorage: safeStorage, windowsKeyError: options.windowsProfile?.keyError,
      windowsLegacyPlaintextProof: options.windowsProfile?.legacyPlaintextProof,
      windowsLegacyMigrationJournal: options.windowsProfile?.legacyMigrationJournal,
      windowsLegacyPlaintextCleanupSha256: options.windowsProfile?.legacyPlaintextCleanupSha256,
    } : {}),
  });
  early.add(() => credentials.close(2500));
  mcpRuntime = createMcpRuntime(window, registry, {
    configRoot, sessions, state, workspaces, configuration: mcp, credentials,
    openExternal: options.openMcpAuthorizationUrl ?? (url => shell.openExternal(url)),
    emit, log: (kind, message) => log.write(kind, message),
  });
  early.add(() => mcpRuntime?.close());
  connectors = createConnectorsRuntime(registry, { configRoot, userHome: options.externalAuthHomeDir ?? homedir(),
    permissionRules: () => permissionRules.snapshot(), runtimeActive: () => mcpRuntime!.service.hasLiveSession(), runtimeStatus: () => mcpRuntime!.service.status(),
    currentTurn: id => state.runningTurnId(id), directory: id => sessions.directory(id),
    guardInteraction: async (_id, signal) => {
      signal.throwIfAborted(); const status = computerUse?.recording.status();
      if (status?.recording === true || status?.state === 'approving' || status?.state === 'starting') throw new Error('App interactions are paused while the user records a demonstration');
    },
    onElicitationCancelled: (sessionId, requestId) => events.cancelHostQuestion(sessionId, requestId),
    onChanged: async () => {
      mcpRevision++;
      await refreshBoundHostCapabilities('connectors', state.bindings());
      emit('app:preferences-changed', { key: 'connectors' }); emit('mcp:status:updated', { cwd: null });
    },
    log: (kind, detail) => log.write(kind, detail),
  });
  early.add(() => connectors?.shutdown());
  const senderId = window.webContents.id;
  windows.register(senderId, 'main');
  broadcaster.addTarget({ id: senderId, role: 'main' });
  const previews = new Set<BrowserWindow>();
  const closePreviews = (): void => { for (const preview of previews) if (!preview.isDestroyed()) preview.destroy(); };
  early.add(closePreviews);
  const openPreviewWindow = async (options: { kind: string; filePath: string; sessionId?: string; displayName?: string }): Promise<void> => {
    const preview = createArtifactWindow(edition.productName), id = preview.webContents.id;
    previews.add(preview); windows.register(id, 'artifact'); broadcaster.addTarget({ id, role: 'artifact' });
    preview.on('closed', () => { previews.delete(preview); subscriptions.clearOwner(id); windows.unregister(id); broadcaster.removeTarget(id); delivery.closeOwner(id); });
    preview.on('resize', () => { if (!preview.webContents.isDestroyed()) preview.webContents.send(HOST_CHANNELS.resized); });
    const query = Object.fromEntries(Object.entries(options).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    try { await preview.loadURL(appUrl('artifact.html') + '?' + new URLSearchParams(query)); preview.show(); }
    catch (error) { if (!preview.isDestroyed()) preview.destroy(); throw error; }
  };
  const documents = registerDocumentHandlers(registry, {
    configRoot, withFiles: (paths, work) => workspaces.withDirectoryOperation(async () => paths, work),
    openPath: async path => { const error = await shell.openPath(path); if (error) throw new Error(error); },
    openMemoryWindow: filePath => openPreviewWindow({ kind: 'memory', filePath }),
    chooseSpecExportPath: options.chooseSpecExportPath ?? (async name => {
      const result = await dialog.showSaveDialog(window, { defaultPath: name, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      return result.canceled ? undefined : result.filePath;
    }),
  });
  early.add(() => documents.close());
  const skills = registerSkillHandlers(registry, {
    workspaces, request: (method, params) => sessions.request(method, object(params) ?? {}), openPreviewWindow,
    environment: async () => Object.fromEntries(inheritedEnv({ ...process.env, KLAUS_CONFIG_DIR: configRoot })),
    bundledSkills: () => extensions.discovery.bundledSkills(),
    onChanged: async () => { await invalidateSkillCatalog(); emit('app:preferences-changed', { key: 'skills' }); },
  });
  early.add(() => skills.close());
  const skillMarket = new SkillMarketService({ skills,
    endpoint: () => { const token = object(readStoredAuth(configRoot))?.token;
      return resolveSkillMarketEndpoint({ serverUrl: account.serverUrl, token: typeof token === 'string' ? token : undefined, environment: process.env }); },
    onChanged: async () => { await invalidateSkillCatalog(); emit('app:preferences-changed', { key: 'skills' }); },
    onProgress: progress => { push('skills:progress', { ...progress }); },
  });
  registerSkillMarketHandlers(registry, skillMarket);
  early.add(() => skillMarket.close());
  // The sub-agent plaza. Install delegates to the existing agent-file writer, so
  // a plaza install and a hand-authored agent share one validation, one atomic
  // write and one live-session invalidation path.
  const agentMarket = new AgentMarketService({ configRoot,
    saveAgent: payload => extensions.agentsSave(payload),
    endpoint: () => { const token = object(readStoredAuth(configRoot))?.token;
      const baseUrl = account.serverUrl.replace(/\/+$/, '');
      return baseUrl ? { baseUrl, ...(typeof token === 'string' && token ? { token } : {}) } : undefined; },
    onProgress: progress => { push('agents:progress', { ...progress }); },
  });
  registerAgentMarketHandlers(registry, agentMarket);
  early.add(() => agentMarket.close());
  const mcpBuiltins = new McpBuiltinService({ configRoot, mcp,
    endpoint: () => { const token = object(readStoredAuth(configRoot))?.token;
      return resolveSkillMarketEndpoint({ serverUrl: account.serverUrl, token: typeof token === 'string' ? token : undefined, environment: process.env }); },
    deviceClientId: (id, catalog) => resolveMcpDeviceClientId(configRoot, id, catalog),
    log: message => log.write('mcp-catalog', message),
  });
  const mcpDiagnostics = new McpDiagnosticsService({ configRoot, mcp });
  registerMcpBuiltinHandlers(registry, mcpBuiltins, mcpDiagnostics);
  early.add(() => mcpBuiltins.close());
  early.add(() => mcpDiagnostics.close());
  const mcpDevice = new McpDeviceService({ configRoot, baseURL: options.mcpDeviceBaseUrl,
    catalog: () => mcpBuiltins.catalog(), install: (payload, signal) => mcpBuiltins.install(payload, signal),
  });
  registerMcpDeviceHandlers(registry, mcpDevice);
  early.add(() => mcpDevice.close());
  const externalImport = new ExternalAgentImportService({ home: options.externalImportHome ?? homedir(), appData: process.env.APPDATA,
    workspaces, request: (method, params) => sessions.request(method, object(params) ?? {}), skills, hooks: hooksStyles, mcp, plugins,
    onChanged: async () => { configuration.markChanged(); await sessions.reloadPermissionRules(); emit('app:preferences-changed', { key: 'external-agent-import' }); },
  });
  registerExternalAgentImportHandlers(registry, externalImport);
  early.add(async () => {
    const results = await Promise.allSettled([externalImport.close(), skills.close(), plugins.close(), skillMarket.close(), pluginMarketplaces.close(), officialPlugins.close()]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'External import startup resources did not finish closing');
  });
  registerWorkspaceHandlers(registry, { workspaces, configRoot, push, onSessionWorkdirChanged: () => {},
    // The dragged Projects-section order lives in the workspace store, not in a
    // settings:kv row, so nothing else broadcasts it. Other windows have to hear
    // about a reorder or they keep the arrangement they painted before the drag.
    onProjectOrderChanged: () => emit('app:preferences-changed', { key: SIDEBAR_PROJECT_ORDER_CHANGED_KEY }),
    onDeleteWorkspaceSessions: async ids => {
      for (const id of ids) {
        // The bindings are already gone in the same transaction; a transcript
        // that is missing on disk must not fail the group deletion.
        try { await sessions.deleteSession(id); } catch { /* already gone */ }
      }
    },
    pickDirectory: async () => null, pickDirectories: async () => [] });
  files = registerFileHandlers(registry, {
    workspaces, push,
    openPath: async path => { const error = await shell.openPath(path); if (error) throw new Error(error); },
    revealPath: path => shell.showItemInFolder(path), trashPath: path => shell.trashItem(path),
    requestSession: id => sessions.fileChanges(id),
    toFileUrl: (path, id) => media.grant(path, id),
    toHtmlPreviewUrl: (path, id, scopeRoot) => media.grantHtmlPreview(path, id, scopeRoot),
    toWidgetUrl: (path, id, scopeRoot) => media.grantWidgetSnapshot(path, id, scopeRoot),
    widgetSnapshot: (id, widgetId, revision, path) => widgets.snapshotPath(id, widgetId, revision, path),
    mediaScope,
    producedBySession: (path, id) => artifactPaths.has(id, path),
    authorizePreviewPath: (path, id) => artifactPaths.record(id, path, true),
    sshFiles, sshOwner: sshOwnerOf,
    log: message => log.write('files', message),
    openPreviewWindow,
    saveCopyDialog: async (senderId, defaultName) => {
      const contents = webContents.fromId(senderId);
      const owner = (contents && BrowserWindow.fromWebContents(contents)) ?? window;
      const result = await dialog.showSaveDialog(owner, { defaultPath: defaultName });
      return result.canceled || !result.filePath ? undefined : result.filePath;
    },
  });
  early.add(() => files?.close());
  const endResourceFiles = files;
  registerEndResourceHandlers(registry, new EndResourceOpener({
    checkedPreviewPath: (sessionId, filePath) => endResourceFiles.previewFilePath(sessionId, filePath),
    openPath: async path => { const error = await shell.openPath(path); if (error) throw new Error(error); },
    revealPath: path => shell.showItemInFolder(path),
    openExternal: url => shell.openExternal(url),
    downloadsDirectory: () => app.getPath('downloads'),
    fileIcon: async path => { const image = await app.getFileIcon(path, { size: 'normal' }); return image.isEmpty() ? undefined : image.toDataURL(); },
    selfBundleId: edition.application,
  }));
  const git = registerGitHandlers(registry, {
    workspaces, push,
    readLastTurn: async (id, turnId) => {
      const cwd = await workspaces.sessionDirectory(id), liveSessionId = state.liveSession(id);
      if (!liveSessionId) return readLastTurnFromHistory(id, cwd, (method, params) => sessions.request(method, params), turnId);
      return readLastTurnChanges(id, cwd, (method, params) => sessions.request(method,
        method === 'session/fileChanges' ? { ...params, sessionId: liveSessionId } : params), turnId);
    },
    openPath: async path => { const error = await shell.openPath(path); if (error) throw new Error(error); },
    revealPath: path => shell.showItemInFolder(path), sideQuestion: (id, question) => sessions.sideQuestion(id, question),
  });
  early.add(() => git.close());
  async function quiesceResources(path: string): Promise<() => void> {
      const releases: Array<() => void> = [];
      const release = (): void => { for (const unlock of releases.splice(0).reverse()) unlock(); };
      try {
        releases.push(await sessions.quiesceDirectory(path));
        releases.push(await files!.quiesceDirectory(path));
        releases.push(await media.quiesceDirectory(path));
        releases.push(await native.quiesceDirectory(path));
        return release;
      } catch (error) { release(); throw error; }
  }
  async function forgetDirectory(path: string): Promise<void> {
      for (const id of await workspaces.detachDirectory(path)) {
        files!.stopWatching(id); media.revokeSession(id); digram.releaseSession(id); model3d.releaseSession(id); await browserMcp.releaseSession(id);
      }
  }
  worktreeStorage = new WorktreeStorageService({
    configRoot, git, workspaces, packaged: app.isPackaged,
    sessionRows: async () => (await sessions.storageCatalog()).filter(row => object(row)?.archived !== true)
      .map(row => ({ ...object(row)!, isWorking: sessions.isStorageBusy(String(object(row)?.id ?? '')) })),
    archiveSession: async id => {
      const result = await sessions.setArchived(id, true);
      if (object(result)?.ok === true) emitStorageChatsChanged({ kind: 'archived', sessionIds: [id] });
      return result;
    },
    beforeRemove: async path => {
      const idle: Array<() => void> = [];
      try {
        for (const id of workspaces.sessionsInDirectory(path)) {
          const hold = await sessions.holdIdleStorageDeletion(id);
          if (!hold) throw new IpcHandlerError('WORKTREE_IN_USE', 'A conversation in this worktree is running');
          idle.push(hold);
        }
        const release = await quiesceResources(path);
        return () => { try { release(); } finally { for (const hold of idle.reverse()) hold(); } };
      } catch (error) { for (const hold of idle.reverse()) hold(); throw error; }
    },
    onRemoved: async path => {
      // Archived chats retain their directory and project bindings for snapshot restoration.
      for (const id of workspaces.sessionsInDirectory(path)) {
        files!.stopWatching(id); media.revokeSession(id); digram.releaseSession(id); model3d.releaseSession(id); await browserMcp.releaseSession(id);
      }
      emit('app:preferences-changed', { key: 'worktrees' });
    },
    log: message => log.write('worktree-storage', message),
  });
  early.add(() => worktreeStorage?.close());
  const worktrees = registerWorktreeHandlers(registry, {
    git, workspaces, storage: worktreeStorage, beforeRemove: quiesceResources, onRemoved: forgetDirectory,
    openPath: async path => { const error = await shell.openPath(path); if (error) throw new Error(error); },
  });
  early.add(() => worktrees.close());
  setImmediate(scheduleWorktreeCleanup);
  let closing = false;
  let preparingUpdate = false;
  let restarting = false;
  registry.register('system:restart-app', async () => {
    if (closing) throw new IpcHandlerError('APP_CLOSING', 'The application is shutting down');
    if (!restarting) {
      restarting = true;
      // Relaunch happens after the current process exits. The normal before-quit
      // handler drains host mutations, native resources and the single engine.
      // Keep the recovery ledger intact so the next process can continue any
      // turns this shutdown interrupts.
      await resumeLedger.freeze();
      app.relaunch({ args: process.argv.slice(1).filter(argument => !argument.startsWith(edition.protocol + ':')) });
      setImmediate(() => app.quit());
    }
    return { ok: true };
  }, 'application-lifecycle');
  let shutdownPromise: Promise<void> | undefined;
  let drainPromise: Promise<void> | undefined;
  let tray: Tray | undefined;
  let loginBounds: Electron.Rectangle | undefined;
  let shortcuts: DesktopShortcuts | undefined;
  const request = (method: string, params: Json): Promise<Json> => cursorDiagnostics.request(method, () => sessions.request(method, object(params) ?? {}));
  dream = new DreamService({ configRoot, request,
    generation: () => sessions.engine()?.generation,
    subject: id => {
      const current = sessions.engine(), binding = state.bindings().find(row => row.rendererId === id);
      return current && !current.client.isClosed() && binding ? { ...binding, generation: current.generation, busy: state.isWorking(id) } : undefined;
    },
    startDream: async (subject, submissionId) => {
      const current = sessions.engine();
      if (!current || current.client.isClosed() || current.generation !== subject.generation || state.liveSession(subject.rendererId) !== subject.engineId) throw new Error('The dream conversation owner changed');
      return await requestAcknowledged(current.client, 'session/dreamNow', { sessionId: subject.engineId, submissionId }, 'dream') as Json;
    },
    onChanged: () => { configuration.markChanged(); emit('app:preferences-changed', { key: 'dream' }); },
    push: snapshot => push('dream:event', snapshot), log: message => log.write('memory-maintenance', message),
  });
  registerDreamHandlers(registry, dream);
  early.add(() => dream?.close());
  memorySnapshots = new MemorySnapshotService({
    generation: () => sessions.engine()?.generation,
    rendererId: id => state.bindings().find(row => row.engineId === id)?.rendererId ?? '',
    present: async (prompt, signal, snapshotOwner) => {
      const targetId = sessionMainWindow(snapshotOwner.rendererId).webContents.id;
      await subscriptions.wait(targetId, 'memory:snapshot:prompt', signal);
      await delivery.deliver(targetId, 'memory:snapshot:prompt', prompt, signal); return true;
    },
    resolve: async (owner, requestId, resolution) => {
      const current = sessions.engine();
      if (!current || current.client.isClosed() || current.generation !== owner.generation || state.liveSession(owner.rendererId) !== owner.engineId) throw new Error('The memory snapshot conversation owner changed');
      const method = 'decision' in resolution ? 'session/resolveAgentMemorySnapshotDecision' : 'session/settleAgentMemorySnapshotUnavailable';
      const audit = object(await requestAcknowledged(current.client, method, { sessionId: owner.engineId, requestId, ...resolution }, 'agentMemorySnapshotDecision'));
      if (object(audit?.request)?.requestId !== requestId || typeof audit?.status !== 'string' || audit.status === 'requested') throw new Error('The engine did not confirm the memory snapshot response');
    },
    log: message => log.write('memory-snapshot', message),
  });
  registry.register('memory-snapshot:respond', context => memorySnapshots!.respond(object(context.args[0]) ?? {}), 'memory-snapshot');
  early.add(() => memorySnapshots?.close());
  const mobileDiagnostics = new MobileDiagnosticsSwitch(() => engineSettings.row('klaus.providerTrace'), () => {
    mobile?.resetDiagnostics(); mobileDiagnosticLog.reset();
  });
  const mobileDiagnosticLog = new MobileDiagnosticLog(configRoot, mobileDiagnostics.enabled);
  early.add(async () => { await mobileDiagnosticLog.close(); mobileDiagnostics.close(); });
  registerRuntimeWindowsSandboxHandlers(registry, windowsSandboxSetup);
  const engineSettings = registerSettingsHandlers(registry, {
    configRoot, request,
    workspaceDependencies: workspaceDependencySettings,
    openConfig: async path => { const error = await shell.openPath(path); if (error) throw new Error(error); },
    log: (kind, detail) => log.write(kind, detail),
    sourceStatus: modelSourceStatus,
    onSettingsChanged: async (key, scope) => {
      if (key === COMPOSER_PREDICTIONS_ENABLED_KEY) await composerPredictions?.invalidateAll();
      await configuration.settingsChanged(key, scope);
      if (key === 'language') {
        const language = kvGet('language', configRoot);
        if (isFailure(language)) throw new IpcHandlerError(language.code, language.message);
        petLanguage = language || edition.defaultLanguage || 'en';
        await desktopPet?.updateSettings({ language: petLanguage.startsWith('zh') ? 'zh' : 'en' });
        petActivity?.refresh();
        prototype.refreshLanguage();
        ppt.refreshLanguage();
      }
      if (key === 'desktop_pet.realtime_provider') {
        const value = kvGet(key, configRoot);
        petRealtimeProviderId = !isFailure(value) && typeof value === 'string' && value ? value : undefined;
      }
      if (key === 'desktop_pet.realtime_provider' || key.startsWith('desktop_pet.realtime_voice.') || key === 'modelProviders' || key === 'auth_mode' || key === 'composer.main_model') await Promise.allSettled([petRealtime?.refreshAvailability(), chatRealtime?.refreshAvailability()]);
      if (key === 'klaus.providerTrace') await mobileDiagnostics.refresh();
      emit('app:preferences-changed', { key });
      if (key === 'language') refreshMenus();
      if (key === 'notification.desktop') void notificationAuthorization?.ensure();
      // The two system-hotkey KV rows (`global_shortcut`, `quick_input_shortcut`)
      // no longer drive anything here. They moved into keybindings.json, and
      // `DesktopShortcuts` now reads its accelerators from the KeymapService, so
      // re-applying on a KV write would read the keymap and silently ignore the
      // value just written — a write that appears to succeed and does nothing.
      // The live path is `keymap:set`, which validates, writes, and re-applies the
      // hotkeys in one step; the agent path (`quickInput.setShortcut`) goes
      // through it and still verifies the OS registration took.
    },
  });
  // Migrate before the first consumer, not from the startup-cleanup stack.
  const legacyPermissionDefault = storedPermissionMode(configRoot);
  await engineSettings.migratePermissionDefault(legacyPermissionDefault);
  finishPermissionDefaultMigration(configRoot, legacyPermissionDefault);
  await initializeModelTierMapping(engineSettings, configRoot);
  await mobileDiagnostics.refresh();
  const voice = createVoiceRuntime(window, registry, {
    configRoot, models: voiceModelAccess(engineSettings, request, configRoot, () => sessions.engine(), source => source === 'codex' ? account.codexStatus() : account.subscriptions.claudeStatus(),
      () => setting('language') || edition.defaultLanguage || app.getLocale()), fixture: options.voiceFixture,
    cameraLeaseHeld: senderId => cameraLeaseHeld(webContents.fromId(senderId) ?? null),
    retainOnHide: id => chatVoiceOwnerId === id,
    realtimeReserved: () => chatVoiceRequestId !== undefined,
    deliver: (id, channel, payload) => {
      return delivery.deliver(id, channel, payload);
    },
    log: (kind, message) => log.write(kind, message),
  });
  early.add(async () => { if (!(await voice.shutdown()).complete) throw new Error('Voice startup resources did not finish closing'); });
  const petVoiceOwners = new PetVoiceOwners({
    visible: id => desktopPet?.ownsWebContents(id) === true && desktopPet.snapshot().visible,
    attach: id => voice.attachOwner(id), detach: id => voice.detachOwner(id),
    stop: async id => { await petRealtime?.release(id); },
  });
  const petVoiceReleases = petVoiceOwners.releases;
  const attachPetVoice = (id: number): Promise<void> => petVoiceOwners.attach(id);
  const releasePetVoice = (id: number): void => { void petVoiceOwners.release(id).catch(error => log.write('pet-voice-cleanup', String(error))); };
  const composerService = registerComposerHandlers(registry, {
    configRoot, request, engineSettings, push: emit, runtimePolicyProjection,
    sessionCwd: id => sessions.directory(id),
    beforeSessionModelChange: id => sessions.prepareModelChange(id),
    onSessionConfigChanged: async change => {
      await configuration.composerChanged(change);
      void petRealtime?.refreshAvailability().catch(error => log.write('pet-realtime-availability', String(error)));
      void chatRealtime?.refreshAvailability().catch(error => log.write('voice-chat-availability', String(error)));
    },
  });
  composer = composerService;
  let invalidateClaudeUsage = (): void => {};
  const account = registerAuthHandlers(registry, {
    homeDir: options.externalAuthHomeDir,
    configRoot, request, push: emit, appVersion: app.getVersion(),
    subscriptionCredentials: credentials, subscriptionFetch,
    beforeWipeLocal: async () => {
      if (closing || preparingUpdate || restarting) throw new IpcHandlerError('APP_CLOSING', 'The application is already shutting down');
      await drainForQuit();
    },
    afterWipeLocal: options.restartAfterWipeLocal ?? (() => {
      app.relaunch({ args: process.argv.slice(1).filter(argument => !argument.startsWith(edition.protocol + ':')) });
      restarting = true; setImmediate(() => app.quit());
    }),
    openExternal: url => shell.openExternal(url),
    onAuthChanged: async change => {
      invalidateClaudeUsage();
      // Authentication callbacks may still own the credential write queue.
      // Invalidate immediately and drain without waiting on that same queue.
      void composerPredictions?.invalidateAll().catch(error => log.write('prediction-auth-cleanup', String(error)));
      teamCollaboration?.refreshAccount();
      // The server resolves gates per user, so a login/logout changes answers.
      void featureGates?.accountChanged();
      // The guide rides the same payload: a sign-out must not leave the
      // previous account's introduction on screen.
      void onboardingGuide?.accountChanged();
      // A sign-out removes the credential live sessions were using; their
      // background re-preparation then fails by design and must not surface
      // as a model error the user caused.
      const signedOut = change?.signedOut === true;
      await configuration.markInferenceChanged(undefined, signedOut ? 'signed-out' : undefined);
      setImmediate(() => { if (!closing) void configuration.refreshSubagentModelCatalog().catch(error => log.write('subagent-model-catalog', String(error))); });
      if (!closing) try { await mobile?.refreshAccount(); } catch (error) { log.write('mobile-account', String(error)); }
      setImmediate(() => { if (!closing) { void petRealtime?.refreshAvailability().catch(error => log.write('pet-realtime-availability', String(error))); void chatRealtime?.refreshAvailability().catch(error => log.write('voice-chat-availability', String(error))); } });
    },
    log: (kind, detail) => {
      log.write(kind, detail);
      if (kind === 'cursor-diagnostic') {
        try { const value = JSON.parse(detail); cursorDiagnostics.record('host_auth', value.phase, value.fields); }
        catch { /* Only structured account diagnostics enter the shareable file. */ }
      }
    },
    loginWindow: active => {
      if (window.isDestroyed()) throw new IpcHandlerError('WINDOW_CLOSED', 'The application window is closed');
      if (active) {
        loginBounds ??= window.getBounds();
        window.setResizable(false);
        window.setSize(900, 600);
        window.center();
      } else {
        window.setResizable(true);
        if (loginBounds) { window.setBounds(loginBounds); loginBounds = undefined; }
      }
    },
  });
  early.add(() => account.close());
  composerPredictions = new ComposerPredictions({
    // Only a covered subscription reads remote configuration; every other account
    // runs the prompt this app ships, so neither dependency gates the feature.
    configRoot, fetch: (input, init) => subscriptionFetch(String(input), init ?? {}),
    supported: async () => (await sessions.client()).capabilities?.composerPredictions === true,
    codexAccessToken: async () => await account.subscriptions.codexAccessToken() ?? null,
    context: (id, signal) => sessions.predictionContext(id, signal),
    run: (id, sourceTurnId, prompt, effort, signal) => sessions.predictMessage(id, sourceTurnId, prompt, effort, signal),
  });
  registerComposerPredictionHandlers(registry, composerPredictions);
  early.add(() => composerPredictions?.close());
  // Server-controlled feature gates. Created before the surfaces they gate so
  // every consumer reads a live service; the boot snapshot comes from the
  // local cache and the network refresh follows on the service's own timer.
  featureGates = new FeatureGatesService({
    configRoot,
    clientConfig: () => account.clientConfig(),
    accountId: () => {
      const user = object(object(readStoredAuth(configRoot))?.user);
      return typeof user?.id === 'string' ? user.id : null;
    },
    push: features => emit('feature-gates:updated', { features }),
    onChanged: () => teamCollaboration?.refreshGate(),
    log: message => log.write('feature-gates', message),
  });
  early.add(() => { featureGates?.close(); });
  registerFeatureGateHandlers(registry, featureGates);
  featureGates.start();
  // The post-upgrade guide rides the same control-plane payload as the gates,
  // but is fail-closed without a disk cache: a withdrawn guide must not replay
  // from a stale file after the server pulled it.
  onboardingGuide = new OnboardingGuideService({
    clientConfig: () => account.clientConfig(),
    accountId: () => {
      const user = object(object(readStoredAuth(configRoot))?.user);
      return typeof user?.id === 'string' ? user.id : null;
    },
    push: config => emit('onboarding-guide:updated', { config: config as unknown as Json }),
    log: message => log.write('onboarding-guide', message),
  });
  early.add(() => { onboardingGuide?.close(); });
  registerOnboardingGuideHandlers(registry, onboardingGuide);
  onboardingGuide.start();
  teamCollaboration = registerTeamCollaborationHandlers(registry, {
    configRoot, serverUrl: account.serverUrl, sessions,
    // Fail-closed: until the server resolves the gate for this account, the
    // collaboration surface stays dark (see services/feature-gates.ts).
    gateEnabled: () => featureGates?.enabled('teamCollaboration') ?? false,
    saveFile: async (name, bytes, assertCurrent) => {
      const result = await dialog.showSaveDialog(window, { defaultPath: name });
      assertCurrent();
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, bytes, { mode: 0o600 });
      return true;
    },
    account: () => {
      const stored = object(readStoredAuth(configRoot)), user = object(stored?.user);
      return typeof user?.id === 'string' && typeof stored?.token === 'string' && stored.token
        ? { id: user.id, token: stored.token } : null;
    },
    authorizationExpired: () => account.authorizationExpired(),
    push, log: message => log.write('team-collaboration', message),
    rendererId: engineId => state.bindings().find(binding => binding.engineId === engineId)?.rendererId,
    bindSessionDirectory: (sessionId, directory) => {
      bindSessionWorkdir(sessionId, directory, configRoot);
      configuration.markChanged(sessionId);
    },
    modelOptions: source => composerService.options(source),
    agentDefinitions: () => extensions.discovery.agents(),
    configureSessionModel: (sessionId, model) => {
      bindCollaborationModel(configRoot, sessionId, model);
      configuration.markChanged(sessionId);
    },
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  });
  early.add(() => teamCollaboration?.close());
  teamCollaboration.start();
  qwenworkReadopt = () => account.subscriptions.qwenworkReadopt();
  workbuddyReadopt = () => account.subscriptions.workbuddyReadopt();
  cursorReadopt = () => account.subscriptions.cursorReadopt();
  mediaGeneration = new MediaGenerationService({
    features: new ModelFeatureSettings(configRoot), workspaces,
    subscriptions: account.subscriptions, qoder: createQoderMediaFacade(() => sessions.engine()),
    qwenwork: createQwenworkNativeMediaFacade(() => sessions.engine()),
    cursor: createCursorMediaFacade(() => sessions.engine()),
    workbuddy: createWorkbuddyMediaFacade(() => sessions.engine()),
    antigravity: createAntigravityMediaFacade(() => sessions.engine()),
    trae: createTraeMediaFacade(() => sessions.engine()),
    minimax: createMinimaxMediaFacade(() => sessions.engine()),
    bailian: createBailianMediaFacade(() => sessions.engine()),
  });
  early.add(() => mediaGeneration?.close());
  registerMediaGenerationTools(dynamicTools, mediaGeneration, (_name, engineId, signal) => {
    const context = hostToolContext(engineId, signal);
    const provider = state.sessionProvider(context.sessionId);
    const source = provider?.source;
    if (!source) throw new IpcHandlerError('SESSION_UNAVAILABLE', 'The calling conversation has no active model source');
    // Media tools run on their own global backend selection, so the
    // conversation's language source supplies optional model attribution. Losing
    // the conversation cancels generation through the context's assertCurrent.
    return { ...context, source, ...(source === 'cursor' ? { modelSelection: provider!.selection } : {}) };
  });
  const usage = new UsageService({
    authMode: sessionId => readSessionModel(sessionId || '', configRoot).source,
    claudeCacheKey: async () => claudeUsageCacheKey(await account.subscriptions.claudeAccounts()),
    fetch: subscriptionFetch,
    models: async signal => {
      signal?.throwIfAborted(); const client = await sessions.client(), rows = await engineSettings.listModels();
      const configured: Json[] = [];
      for (const raw of rows) {
        signal?.throwIfAborted(); if (client.isClosed() || sessions.engine()?.client !== client) throw new Error('The usage engine connection changed');
        const row = object(raw) ?? {}, credential = object(await client.requestWithTimeout('model/credential/read', { id: row.id! }, 15_000));
        if (!credential || credential.error != null || (credential.apiKey != null && typeof credential.apiKey !== 'string')) throw new Error('The engine returned an invalid model credential state');
        configured.push({ name: row.name ?? null, provider: row.provider ?? null, model: row.model ?? null, hasCredential: typeof credential.apiKey === 'string' && !!credential.apiKey.trim() });
      }
      signal?.throwIfAborted(); if (client.isClosed() || sessions.engine()?.client !== client) throw new Error('The usage engine connection changed'); return configured;
    },
    onRenewal: url => {
      log.write('bailian-console-renewal', JSON.stringify({ outcome: 'opening' }));
      void shell.openExternal(url).catch(error => log.write('bailian-console-renewal', JSON.stringify({ outcome: 'failed', error: String(error) })));
    },
    codexAccessToken: signal => account.subscriptions.codexAccessToken(signal),
    qwenworkRecover: () => account.subscriptions.qwenworkReadopt(),
    request: async (method, params, signal) => {
      signal?.throwIfAborted(); const client = await sessions.client(); signal?.throwIfAborted();
      // An allowance read can include a rejected request, renewal and one retry;
      // let the engine return its renewal error before the host deadline wins.
      const value = await client.requestWithTimeout(method, params, method === 'qwenwork/usage' ? 50_000 : 15_000); signal?.throwIfAborted();
      if (client.isClosed() || sessions.engine()?.client !== client) throw new Error('The usage engine connection changed'); return value;
    },
  });
  invalidateClaudeUsage = () => usage.invalidateClaude();
  registerUsageHandlers(registry, usage);
  early.add(() => usage.close());
  const feedback = new FeedbackService({ workspaces, appVersion: app.getVersion(), serverUrl: account.serverUrl,
    token: () => { const token = object(readStoredAuth(configRoot))?.token; return typeof token === 'string' ? token : undefined; },
    ...createFeedbackWindowAdapter(id => windows.roleOf(id) === 'main' ? mainWindows.get(id) : undefined),
  });
  registerFeedbackHandlers(registry, feedback);
  early.add(() => feedback.close());
  const communicationAccount = () => {
    const auth = object(readStoredAuth(configRoot)), userId = object(auth?.user)?.id;
    return typeof auth?.token === 'string' && auth.token && typeof userId === 'string' && userId ? { token: auth.token, userId } : undefined;
  };
  const communicationAuthorizationExpired = () => { void account.authorizationExpired().catch(error => log.write('mobile-account-revoked', String(error))); };
  const communicationSettings = new MobileSettingsStore(configRoot, account.serverUrl, process.env, edition.mobilePort);
  friends = new FriendsService({ configRoot, serverURL: account.serverUrl, protocol: edition.protocol, account: communicationAccount, sessions,
    pushMessage: (sessionId, message) => chat.enqueue([{type:'user_message',sessionId,message}]),
    appendDisplayMessage: (sessionId, messageId, text, metadata) => sessions.appendDisplayMessage(sessionId, messageId, text, metadata),
    enabled: () => communicationSettings.read().enabled, authorizationExpired: communicationAuthorizationExpired,
    log: (kind, detail) => log.write(kind, detail),
    language: () => { const value = kvGet('language', configRoot); return typeof value === 'string' && value ? value : edition.defaultLanguage || app.getLocale(); },
    ensureTransport: () => mobile ? mobile.ensureFriendTransport() : Promise.reject(new Error('The desktop transport is starting; retry shortly')),
    apps: async () => {
      const [choices, client] = await Promise.all([discoverFriendApps(computerUse?.ownerAppsAvailable().available ?? false), sessions.client()]);
      return { ...choices, taskCommands: client.capabilities?.taskCommands === true };
    },
    changed: () => { emit('app:preferences-changed', { key: 'friends' }); emit('friends:changed', null); },
    emit: (channel, payload) => emit(channel, payload),
    // A busy paired conversation runs an approved task as its next turn; the
    // turn-end signal wakes that wait.
    onTurnSettled: listener => threadWaitSignals.onChange(listener),
    // An approval may choose another location for a conversation the pair
    // already uses; the binding changes before the engine session is rebuilt.
    relocateSession: async (threadId, location) => {
      workspaces.bindSession(threadId, { workdir: location.localWorkdir ?? location.workdir ?? undefined, workspaceId: location.workspaceId, projectRoot: location.projectRoot });
      configuration.markChanged(threadId); media.revokeSession(threadId); mobile?.noteSessionMetadata(threadId);
    },
    notifyAccess: (sender, path, taskId) => notifications?.friendAccessRequest(sender, path, taskId),
    pendingTask: (sender, prompt, taskId) => notifications?.friendRequest(sender, prompt, taskId),
    friendMessage: info => notifications?.friendMessage(info),
    executionTargets: () => {
      const projects = object(workspaces.projectsList());
      const registry = object(workspaces.list());
      return {
        projects: (Array.isArray(projects?.roots) ? projects!.roots : []).flatMap(raw => {
          const row = object(raw), root = typeof row?.path === 'string' ? row.path : '';
          if (!root) return [];
          const label = typeof row?.label === 'string' && row.label.trim() ? row.label.trim() : basename(root);
          return [{ root, name: label }];
        }),
        workspaces: (Array.isArray(registry?.workspaces) ? registry!.workspaces : []).flatMap(raw => {
          const row = object(raw), id = typeof row?.id === 'string' ? row.id : '';
          if (!id || !Array.isArray(row?.roots)) return [];
          return [{ id, name: typeof row?.name === 'string' ? row.name : '', roots: row.roots.filter((root): root is string => typeof root === 'string') }];
        }),
      };
    },
  });
  registerFriendsHandlers(registry, friends);
  early.add(() => friends?.close());
  remoteThreads = new RemoteThreadClient({ configRoot, serverURL: account.serverUrl, account: communicationAccount,
    enabled: () => threadToolsEnabled(configRoot) && communicationSettings.read().enabled,
    authorizationExpired: communicationAuthorizationExpired,
  });
  early.add(() => remoteThreads?.close());
  mobile = createMobileRuntime({ registry, router, sessions, threadTools,
    connectionChanged: () => powerRuntime?.changed(),
    friendMessage: (message, signal) => friends!.receive(message, signal), media, files, digram, configRoot, relayURL: account.serverUrl,
    hostname: profileScopedDevice ? `${hostname()} (dev preview)` : undefined,
    friendRevoked: friendshipId => friends!.revokeIncoming(friendshipId),
    friendDisconnected: () => friends!.transportDisconnected(),
    friendConnected: () => { void friends!.reconcileAuthorization().catch(error => log.write('friends-reconcile', String(error))); },
    diagnosticsEnabled: mobileDiagnostics.enabled,
    log: (event, fields) => {
      if (event === 'load_diagnostic') mobileDiagnosticLog.write(fields);
      else log.write('mobile', JSON.stringify({ event, ...fields }));
    },
    isClosing: () => closing,
    authorizationExpired: communicationAuthorizationExpired,
    account: communicationAccount,
    deviceStatus: async () => {
      // The settings device list polls every five seconds and this adds a
      // second cloud read per poll, so reachability is cached briefly; a
      // rename or removal still lands on the next poll after the TTL.
      const now = Date.now();
      if (deviceStatusCache && now - deviceStatusCache.at < 10_000) return deviceStatusCache.status;
      const rows = await remoteThreads?.discover(AbortSignal.timeout(10_000)).catch(() => null) ?? { hosts: [] };
      const status: Record<string, string> = {};
      for (const host of rows.hosts) status[host.id] = host.status;
      deviceStatusCache = { at: now, status };
      return status;
    },
  });
  early.add(() => mobile?.close());
  powerRuntime = createPowerSaveRuntime(registry, {
    configRoot,
    context: () => ({ localExecutionAllowed: true,
      hasActiveLocalConversation: state.runningSessions().some(id => sessions.isCatalogVisible(id) && !powerSuppressedConversations.has(id))
        || events.agentTasks.activeConversations().some(({ parentId, id }) => sessions.isCatalogVisible(parentId)
          && sessions.isCatalogVisible(id) && !powerSuppressedConversations.has(id)),
      remoteControlEnabled: mobile?.remoteControlKeepsAwake() ?? false,
      realtimeVoicePhase: ((phase) => phase === 'connecting' ? 'starting' : phase ?? 'inactive')(chatRealtime?.snapshot().phase) }),
    emit, log: message => log.write('power-save', message),
  });
  early.add(() => powerRuntime?.close());
  events.agentTasks.onChanged = () => powerRuntime?.changed();
  registerCronSettingsHandlers(registry, {
    configRoot, store: cronStore, runtime: cronRuntime, powerSettings: powerRuntime.settings,
    onChanged: () => { powerRuntime?.changed(); emit('app:preferences-changed', { key: 'cron' }); },
  });
  const show = (): void => {
    const owner = focusedMainWindow();
    if (owner.isDestroyed()) return;
    if (owner.isMinimized()) owner.restore();
    owner.show(); owner.focus();
  };
  const setting = (key: string): string | undefined => {
    const value = kvGet(key, configRoot);
    if (isFailure(value)) throw new IpcHandlerError(value.code, value.message);
    return value ?? undefined;
  };
  const notificationNavigation = new AbortController();
  const nativeNotifications = new NativeNotifications({ log: message => log.write('notification', message),
    open: async target => {
      if (closing) return;
      show();
      if (!target) return;
      const channel = target.kind === 'friend-task' ? 'deep-link:friend-task' : 'deep-link:open-session';
      const payload: Json = target.kind === 'friend-task' ? { taskId: target.taskId } : { sessionId: target.sessionId };
      await deliverToFocusedMain(channel, payload, notificationNavigation.signal);
    },
  });
  notificationAuthorization = new NotificationAuthorization({
    enabled: () => setting('notification.desktop') !== 'off',
    request: async () => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return 'unavailable';
      return String(await window.webContents.executeJavaScript(`(() => {
        if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return 'unavailable';
        if (Notification.permission !== 'default') return Notification.permission;
        return Notification.requestPermission();
      })()`, true));
    },
    log: message => log.write('notification', message),
  });
  notifications = new DesktopNotifications({
    focused: options.notificationFixture?.focused ?? (() => [...mainWindows.values()].some(owner => !owner.isDestroyed() && owner.isFocused())), setting,
    rendererId: id => state.bindings().find(row => row.engineId === id)?.rendererId,
    isBackground: id => cronRuntime?.isRunSession(id) ?? false,
    isPrivate: id => retiredPrivateSessions.isPrivateThread(id),
    pendingPresentation: (id, terminalId) => sessions.hasPendingNotificationWork(id, terminalId, events.agentTasks.activeConversations()),
    show: options.notificationFixture?.show ?? (notice => nativeNotifications.show(notice)),
    sound: kind => emit('notify:sound', kind), log: message => log.write('notification', message),
    broadcast: (channel, payload) => emit(channel, payload),
    mobileOutcome: (sessionId, turnId, failed) => mobile?.publishTaskNotice(sessionId, turnId, failed),
  });
  const closeNotifications = (): void => { notificationNavigation.abort(); notificationAuthorization!.close(); notifications!.close(); nativeNotifications.close(); };
  early.add(closeNotifications);
  pip = createPipRuntime(window, registry, {
    addonPath: native.addonPath, helperPath: pipProducerPath() ?? '',
    diagnosticPath: join(configRoot, 'computer-use-pip-crash.log'), subscriptions,
    readPreferences: () => setting(PIP_PREFERENCES_KEY) ?? null,
    writePreferences: raw => { const result = kvSet(PIP_PREFERENCES_KEY, raw, configRoot);
      if (isFailure(result)) throw new IpcHandlerError(result.code, result.message); },
    language: () => setting('language') || app.getLocale().split('-')[0] || 'en',
    deliver: (id, channel, value, signal) => delivery.deliver(id, channel, value as unknown as Json, signal),
    focusBrowser: async (target, signal) => {
      const targetFields = object(target)!;
      const id = requiredString(targetFields, 'sessionId'), browserId = requiredString(targetFields, 'browserId');
      if (target.backend === 'iab') {
        await deliverToFocusedMain('deep-link:open-session', { sessionId: id }, signal);
        signal.throwIfAborted();
        if (browser.conversationId !== id) throw new Error('The selected conversation changed before focusing its browser');
      }
      for (const [name, fields] of [['tabs', { action: 'select' }], ['visibility', { action: 'set', visible: true }]] as const) {
        signal.throwIfAborted();
        const result = await browserMcp.operations.execute(id, name, { ...fields, browserId, tabId: target.tabId });
        signal.throwIfAborted();
        if (result.isError === true) throw new Error(`The browser could not ${name === 'tabs' ? 'select the saved tab' : 'show the saved tab'}`);
      }
    },
    log: (kind, message) => log.write(kind, message),
  });
  early.add(async () => { if (!(await pip!.shutdown()).complete) throw new Error('Picture-in-Picture startup resources did not finish closing'); });
  const computerHelper = computerUseHelperPath(), recordingHelper = recordingHelperPath();
  computerUse = await createComputerUseRuntime(registry, { configRoot,
    // Only a phone-started turn is gated: a locally started session keeps working
    // the same way whether or not the screen happens to be locked.
    computerUseRefusal: sessionId => lockedScreenRefusal({
      locked: powerMonitor.getSystemIdleState(1) === 'locked',
      allowed: mobile?.allowLockedComputerUse() ?? false,
      remoteOrigin: mobile?.isRemoteOriginSession(sessionId) ?? false,
    }),
    taskScope: id => {
      const scope = friendSessionScope(configRoot, id);
      if (!scope) return undefined;
      return { active: scope.active === true && scope.accountId === communicationAccount()?.userId && scope.grant?.computerUse === true,
        apps: scope.grant?.computerUse ? scope.grant.apps : [] };
    },
    command: computerHelper ? { executable: computerHelper, env: { ...process.env, KLAUS_COMPUTER_USE_KEYCHAIN_SERVICE: edition.keychainService } } : undefined,
    recordingCommand: options.recordingFixtureCommand ?? (recordingHelper ? { executable: recordingHelper } : undefined),
    currentTurn: id => state.runningTurnId(id), pip: () => pip?.service,
    onElicitationCancelled: (sessionId, requestId) => events.cancelHostQuestion(sessionId, requestId),
    enabledChanged: async signal => {
      mcpRevision++;
      await refreshBoundHostCapabilities('computer-use', state.bindings());
      signal.throwIfAborted(); emit('app:preferences-changed', { key: 'computer_use.enabled' });
    },
    createRecorderWindow: () => createRecorderWindow(setting('language') || edition.defaultLanguage || app.getLocale()),
    language: () => setting('language') || edition.defaultLanguage || app.getLocale(),
    registerRecorderOwner: owner => { const id = owner.webContents.id; windows.register(id, 'recorder'); broadcaster.addTarget({ id, role: 'recorder' }); },
    unregisterRecorderOwner: id => { subscriptions.clearOwner(id); delivery.closeOwner(id); windows.unregister(id); broadcaster.removeTarget(id); },
    recordingEnded: async value => {
      const targetId = sessionMainWindow(value.sessionId).webContents.id;
      await subscriptions.wait(targetId, 'computer-use:record:ended');
      await delivery.deliver(targetId, 'computer-use:record:ended', { ...value });
    },
    log: (kind, message) => log.write(kind, message),
  });
  early.add(async () => { if (!(await computerUse!.shutdown()).complete) throw new Error('Computer Use startup resources did not finish closing'); });
  // Local environment-history observation: macOS-only, admin-manageable, and
  // strictly local (a bounded timeline under the config root, never uploaded).
  const computerHistoryManaged = new ManagedComputerUsePolicyReader();
  const computerHistory = new ComputerHistoryService({ configRoot,
    command: computerHelper ? { executable: computerHelper } : undefined,
    managedPolicy: () => computerHistoryManaged.read(),
    log: message => log.write('computer-history', message) });
  registerComputerHistorySettingsHandlers(registry, computerHistory);
  computerHistory.autostart();
  early.add(async () => { if (!(await computerHistory.shutdown()).complete) throw new Error('Computer History startup resources did not finish closing'); });
  const quickDeliveryTargets = new Map<string, number>();
  const quickDelivery = new QuickInputDelivery({
    ready: async (signal, value) => {
      const owner = mainWindows.get(quickDeliveryTargets.get(value.submissionId) ?? -1);
      if (!owner || owner.isDestroyed()) throw new IpcHandlerError('WINDOW_CLOSED', 'The quick input destination closed');
      if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus();
      await subscriptions.wait(owner.webContents.id, 'quick-input:submit', signal);
    },
    deliver: value => delivery.deliver(quickDeliveryTargets.get(value.submissionId)!, 'quick-input:submit', { ...value }),
  });
  early.add(() => quickDelivery.close());
  const submitQuickToMain = (value: QuickInputSubmission, signal: AbortSignal): Promise<void> => {
    if (!quickDeliveryTargets.has(value.submissionId)) quickDeliveryTargets.set(value.submissionId, focusedMainWindow().webContents.id);
    return quickDelivery.submit(value, signal).finally(() => quickDeliveryTargets.delete(value.submissionId));
  };
  const quickInput = new QuickInputRuntime({
    createWindow: createQuickInputWindow, pageUrl: appUrl('quick-input.html'),
    workArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    language: () => setting('language') || edition.defaultLanguage || app.getLocale().split('-')[0],
    registerOwner: owner => {
      const id = owner.webContents.id; windows.register(id, 'quick-input'); broadcaster.addTarget({ id, role: 'quick-input' });
    },
    unregisterOwner: id => { subscriptions.clearOwner(id); delivery.closeOwner(id); windows.unregister(id); broadcaster.removeTarget(id); },
    invalidateDelivery: id => { subscriptions.clearOwner(id); delivery.closeOwner(id, 'Quick input renderer changed'); },
    attachVoiceOwner: voice.attachOwner, detachVoiceOwner: voice.detachOwner,
    deliverFocus: async (id, value) => { await subscriptions.wait(id, 'quick-input:focus'); await delivery.deliver(id, 'quick-input:focus', value); },
    submitToMain: submitQuickToMain,
    log: message => log.write('quick-input', message),
  });
  early.add(async () => { if (!(await quickInput.shutdown()).complete) throw new Error('Quick input startup resources did not finish closing'); });
  const clipboardFiles = new ClipboardFiles({ read: options.readClipboardFiles ?? (() => clipboard.read()) });
  early.add(() => clipboardFiles.close());
  registerAuxiliaryHandlers(registry, { quickInput, clipboard: clipboardFiles, textClipboard: clipboard,
    permissions: new SystemPermissions({ preferences: systemPreferences, openExternal: url => shell.openExternal(url),
      ...nativeSystemPermissionProbes(native.addon) }),
  });
  registerImageHandlers(registry, new ImageActions({
    media,
    saveDialog: async name => {
      const result = await dialog.showSaveDialog(window, { defaultPath: name });
      return result.canceled ? undefined : result.filePath;
    },
    copyImage: async bytes => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('Could not decode the image for clipboard copy');
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
    },
    reveal: path => shell.showItemInFolder(path),
    diagnostic: detail => log.write('image-load', JSON.stringify(detail)),
  }));
  const showQuickInput = (): Promise<{ok:boolean;error?:string}> => quickInput.show();
  const openQuickInput = (): void => {
    void showQuickInput().then(result => {
      if (!result.ok) return dialog.showMessageBox({ type:'error', title:'Klaus Quick Input', message:result.error || 'Quick input could not open' });
      return undefined;
    }).catch(error => log.write('quick-input', String(error)));
  };
  // Keymap: the single store for every command binding, including the two
  // os-global system hotkeys. The keymap is a single store
  // and every write re-applies global hotkeys + menu + renderer; Klaus does
  // the same trio in `onKeymapChanged`. The registry is built once from the
  // command table; capabilities are the always-present desktop surfaces.
  const keymapRegistry = new KeybindingRegistry(KLAUS_COMMANDS, {
    platform: platformOf(process.platform),
    capabilities: new Set(['browser', 'dictation', 'terminal', 'voice', 'worktree']),
    // FIND_COMMAND_ID is null because navigation keys stay surface-owned; the option
    // is omitted entirely rather than passed as null — same guard the renderer's
    // state module uses.
    ...(FIND_COMMAND_ID == null ? {} : { findCommandId: FIND_COMMAND_ID }),
  });
  const keymap = new KeymapService({
    registry: keymapRegistry,
    keymapPath: keymapFilePath(configRoot),
    log: message => log.write('keymap', message),
    onKeymapChanged: () => {
      shortcuts?.apply('main');
      shortcuts?.apply('quickInput');
      shortcuts?.apply('desktopPet');
      shortcuts?.apply('voiceChat');
      void desktopPet?.updateSettings({ shortcut: keymap.globalSlotValue('toggleDesktopPet') }).catch(error => log.write('desktop-pet', String(error)));
      refreshMenus();
      push('keymap:changed');
    },
  });
  keymap.loadSync();
  // Carry a pre-existing custom system-hotkey choice from the legacy KV rows into
  // keybindings.json on first run, so upgrading does not silently reset it.
  void keymap.migrateLegacyGlobalShortcuts(key => setting(key) ?? null)
    .then(migrated => { if (migrated) { shortcuts?.apply('main'); shortcuts?.apply('quickInput'); } })
    .catch(error => log.write('keymap', String(error)));
  const keymapCaptures = registerKeymapHandlers(registry, {
    keymap,
    // A capture must see the raw key, so every registered global
    // hotkey is released for the duration of the recording.
    suppressGlobals: () => shortcuts?.suppress() ?? (() => {}),
  });
  // The host owns the capture lifetime, so a window that disappears mid-recording
  // cannot leave the system hotkeys unregistered for good. These are the four
  // events the capture lifetime listens for: blur, destroyed, renderer
  // gone, and a main-frame navigation that is not same-document.
  window.on('blur', () => keymapCaptures.endCaptures());
  window.once('closed', () => keymapCaptures.endCaptures());
  window.webContents.once('destroyed', () => keymapCaptures.endCaptures());
  window.webContents.on('render-process-gone', () => keymapCaptures.endCaptures());
  window.webContents.on('did-start-navigation', event => {
    if (event.isMainFrame && !event.isSameDocument) keymapCaptures.endCaptures();
  });
  // The two os-global slots read their accelerator from the keymap now, so
  // keybindings.json — not the `SHORTCUTS` constant — is the single source.
  const readShortcutSlot = (row: string): string | undefined =>
    row === 'global_shortcut' ? keymap.globalSlotValue('summonMainWindow')
      : row === 'quick_input_shortcut' ? keymap.globalSlotValue('openQuickInput')
        : row === 'desktop_pet_shortcut' ? keymap.globalSlotValue('toggleDesktopPet')
        : row === 'voice_chat_shortcut' ? keymap.globalSlotValue('toggleVoiceChat')
        : setting(row);
  shortcuts = new DesktopShortcuts({ shortcuts: globalShortcut, read: readShortcutSlot,
    toggleMain: () => { const owner = focusedMainWindow(); if (owner.isVisible() && owner.isFocused()) owner.hide(); else show(); },
    toggleQuickInput: async () => { const result = await quickInput.toggle(); if (!result.ok) throw new Error(result.error); },
    toggleDesktopPet: async () => { await desktopPet?.toggleFromShortcut(); },
    toggleVoiceChat: async () => {
      if (powerMonitor.getSystemIdleState(1) === 'locked') return;
      const owner = chatVoiceOwnerId === undefined ? focusedMainWindow() : mainWindows.get(chatVoiceOwnerId);
      if (owner && !owner.isDestroyed()) sendToMainWindow(owner, 'voice:chat:toggle', { action: chatVoiceOwnerId === undefined ? 'start' : 'stop' });
    },
    log: message => log.write('shortcut', message),
  });
  early.add(() => shortcuts?.close());
  early.add(() => keymap.close());
  shortcuts.start();
  petLanguage = setting('language') || edition.defaultLanguage || 'en';
  petRealtimeProviderId = setting('desktop_pet.realtime_provider') || undefined;
  const petActivityStore = new PetActivityStore(join(configRoot, 'pet-activity.json'), { onError: error => log.write('pet-activity-store', String(error)) });
  let petActivityHydrated = false;
  petActivity = new DesktopPetActivity({
    rendererId: id => state.bindings().find(binding => binding.engineId === id)?.rendererId,
    isPrivate: id => retiredPrivateSessions.isPrivateThread(id),
    language: () => petLanguage,
    changed: tasks => {
      desktopPet?.setTasks(tasks);
      if (petActivityHydrated) petActivityStore.save(petActivity!.persistenceSnapshot());
    },
  });
  desktopPet = new DesktopPetRuntime({
    createWindow: () => {
      const owner = createPetWindow();
      if (process.platform === 'darwin' && native.addon.configurePetPanel && !native.addon.configurePetPanel(owner.getNativeWindowHandle())) { owner.destroy(); throw new Error('Could not configure the companion panel'); }
      return owner;
    },
    focusWindow: (owner, active) => {
      if (process.platform !== 'darwin' || !native.addon.focusPetPanel) return false;
      owner.setFocusable(active); native.addon.configurePetPanel?.(owner.getNativeWindowHandle());
      return native.addon.focusPetPanel(owner.getNativeWindowHandle(), active);
    },
    activateApplication: () => app.focus({ steal: true }),
    pageUrl: appUrl('pet.html'), dataDirectory: configRoot,
    voice: {
      state: async id => {
        const ownerId = id ?? BrowserWindow.getAllWindows().find(owner => desktopPet!.ownsWebContents(owner.webContents.id))?.webContents.id;
        return ownerId === undefined ? petRealtime!.snapshot() : petRealtime!.state(ownerId);
      },
      start: async () => { throw new Error('Start the live audio connection from the companion voice panel.'); },
      stop: id => petRealtime!.action(id, 'stop'),
      microphone: (id, muted) => petRealtime!.action(id, 'microphone', muted), speaker: (id, muted) => petRealtime!.action(id, 'speaker', muted),
    },
    visibilityChanged: (id, visible) => { if (visible) void attachPetVoice(id).catch(error => log.write('pet-voice-owner', String(error))); else releasePetVoice(id); },
    builtIns: BUILT_IN_PETS.map(pet => ({ ...pet, spritesheetUrl: appUrl(pet.spritesheetUrl.replace(/^\//, '')) })),
    broadcast: snapshot => { broadcaster.emit('desktop-pet:state', snapshot as unknown as Json); },
    emit: (channel, payload) => broadcaster.emit(channel, payload as Json),
    openMain: async () => {
      await deliverToFocusedMain('app:navigate', { view: 'chat', focusComposer: true }, notificationNavigation.signal);
    },
    openSettings: async () => {
      await deliverToFocusedMain('app:navigate', { view: 'settings', tab: 'pets' }, notificationNavigation.signal);
    },
    openTask: async id => {
      await deliverToFocusedMain('deep-link:open-session', { sessionId: id }, notificationNavigation.signal);
    },
    submit: text => submitQuickToMain({ text, submissionId: randomUUID() }, notificationNavigation.signal),
    createPet: async directory => {
      const packageDirectory = resourceDirs.map(root => join(root, 'plugins-builtin', 'desktop-pet')).find(path => existsSync(join(path, 'plugin.json')));
      if (!packageDirectory) throw new Error('The desktop pet creation workflow is missing from this installation.');
      await plugins.ensureBundled('desktop-pet', packageDirectory);
      const text = directory
        ? `Use the installed create-desktop-pet skill to upgrade the desktop pet in ${directory} to sprite version 2. Keep its character and existing animations, add sixteen look directions, and validate the sprite manifest and image before finishing.`
        : 'Use the installed create-desktop-pet skill to help me create a custom desktop pet. First ask what character I want, then generate and validate a transparent animated sprite sheet. Use a 1536 by 2288 PNG or WebP image with an 8 by 11 grid of 192 by 208 cells. Rows 0 through 8 are idle, run right, run left, wave, jump, failure, waiting, running, and review; rows 9 and 10 hold sixteen look directions at 22.5 degree intervals. Save the image and pet.json with displayName, description, spriteVersionNumber: 2, and spritesheetPath in a new directory under ' + join(configRoot, 'pets') + '. Refresh the pet catalog when finished.';
      await deliverToFocusedMain('desktop-pet:draft', { text }, notificationNavigation.signal);
    },
    pickFile: async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Pet sprite sheets', extensions: ['png', 'webp'] }] });
      return result.canceled ? undefined : result.filePaths[0];
    },
    openDirectory: async directory => { const error = await shell.openPath(directory); if (error) throw new Error(error); },
    acknowledgeTask: id => petActivity?.acknowledge(id), dismissTask: id => petActivity?.dismiss(id),
    ownsConversation: id => petComposer?.isSelectedConversation(id) === true,
    isSessionReserved: () => petRealtime?.reserved() === true,
    captureActiveApplication: () => {
      const token = native.addon.captureActiveApplication?.();
      petForegroundApplication = typeof token === 'string' && token ? token : String(process.pid);
      return typeof token === 'string' && token ? token : undefined;
    },
    restoreActiveApplication: token => native.addon.restoreActiveApplication?.(token) === true,
    ...(process.platform === 'darwin' && native.addon.beginPetWindowDrag && native.addon.stopPetWindowDrag ? {
      startNativeDrag: (owner: BrowserWindow, point: Electron.Point, listener: (event: { windowX: number; windowY: number; ended: boolean; altKey: boolean }) => void, originBounds: Electron.Rectangle) => beginNativePetWindowDrag(
        { beginPetWindowDrag: native.addon.beginPetWindowDrag!, stopPetWindowDrag: native.addon.stopPetWindowDrag! }, owner.getNativeWindowHandle(), point, listener, message => log.write('pet-pointer', message), originBounds),
    } : {}),
    respondTask: (id, requestId, response) => petResponder.respond(id, requestId, response),
    readShortcut: () => keymap.globalSlotValue('toggleDesktopPet'),
    writeShortcut: async value => {
      if (keymap.globalSlotValue('toggleDesktopPet') === value) return;
      await keymap.update('toggleDesktopPet', value ? { type: 'set', accelerator: value } : { type: 'clear' });
      const registration = shortcuts?.state('desktopPet');
      if (registration?.error) throw new Error(registration.error);
    },
    ...(process.platform === 'darwin' && native.addon.observePetOutsideClicks && native.addon.stopPetOutsideClicks ? { observeOutsideClicks: (listener: (point: Electron.Point) => void, owner: BrowserWindow) => observeNativePetOutsideClicks(
      { observePetOutsideClicks: native.addon.observePetOutsideClicks!, stopPetOutsideClicks: native.addon.stopPetOutsideClicks! }, owner.getNativeWindowHandle(), () => screen.getCursorScreenPoint(), listener, message => log.write('pet-pointer', message),
      native.addon.petWindowNumber ? windowNumber => BrowserWindow.getAllWindows().some(candidate => !candidate.isDestroyed() && native.addon.petWindowNumber!(candidate.getNativeWindowHandle()) === windowNumber) : undefined,
    ) } : (process.platform === 'darwin' || process.platform === 'win32') && native.addon.pointerButtons ? { observeOutsideClicks: (listener: (point: Electron.Point) => void) => observePetOutsideClicks(
      () => native.addon.pointerButtons!(), () => screen.getCursorScreenPoint(), listener, message => log.write('pet-pointer', message),
    ) } : {}),
    registerOwner: owner => {
      const id = owner.webContents.id; windows.register(id, 'pet'); broadcaster.addTarget({ id, role: 'pet' });
      owner.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) { petComposer?.revokeAttachments(id); releasePetVoice(id); } });
    },
    unregisterOwner: id => { subscriptions.clearOwner(id); delivery.closeOwner(id); windows.unregister(id); broadcaster.removeTarget(id); petComposer?.release(id); releasePetVoice(id); },
    log: message => log.write('desktop-pet', message),
  });
  registerDesktopPetHandlers(registry, desktopPet);
  const petResponder = new DesktopPetResponder({ state, events, sessions, activity: petActivity,
    openUrl: url => shell.openExternal(url),
    rememberComputerUseApp: app => computerUse!.policy.addAllowedApp({ app }),
    resolveAttachments: async groups => {
      const selected = await petComposer!.resolveAttachments(groups), uploaded: Record<string, Json> = {};
      for (const [question, files] of Object.entries(selected)) {
        const rows: Json[] = [];
        for (const raw of Array.isArray(files) ? files : []) {
          const file = object(raw)!;
          if (!/^image\/(?:png|jpeg|gif|webp)$/.test(string(file.type))) throw new Error('This question accepts image attachments only');
          const result = object(await attachments.uploadPath({ path: file.path! }));
          if (!result || result.ok === false || typeof result.path !== 'string') throw new Error(string(result?.error, 'The question attachment could not be uploaded'));
          rows.push({ ...result, name: file.name!, type: file.type! });
        }
        uploaded[question] = rows;
      }
      await petComposer!.resolveAttachments(groups);
      return uploaded;
    },
    resolved: (channel, payload) => {
      if (channel === 'question:resolved') emit(channel, payload);
      else chat.enqueue([{ type: channel === 'permission:resolved' ? 'permission_cancelled' : 'elicit_cancelled', ...payload, reason: 'resolved' }]);
    },
  });
  petComposer = new PetComposer({
    owns: id => desktopPet!.ownsWebContents(id), visible: () => desktopPet!.snapshot().visible, root: configRoot,
    pickFiles: async id => desktopPet!.withInteraction(id, async () => {
      const contents = webContents.fromId(id), owner = contents && BrowserWindow.fromWebContents(contents);
      if (!owner) throw new Error('The companion window is unavailable');
      const result = await dialog.showOpenDialog(owner, { title: 'Attach files', properties: ['openFile', 'multiSelections'] });
      return result.canceled ? [] : result.filePaths;
    }),
    screenshots: async id => desktopPet!.withInteraction(id, async () => {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
      const available = sources.filter(source => !source.thumbnail.isEmpty());
      if (!available.length) throw new Error('Allow Screen Recording in system settings to attach a window or screen');
      return available.map(source => ({ id: source.id, name: source.name, previewUrl: source.thumbnail.toDataURL() }));
    }),
    capture: async (sourceId, id) => desktopPet!.withInteraction(id, async () => {
      if (sourceId.startsWith('window:')) return computerUse!.captureAppshot(sourceId, notificationNavigation.signal, undefined, appshotRuntime?.snapshot().settings.soundEnabled ?? true);
      const sources = await desktopCapturer.getSources({ types: [sourceId.startsWith('screen:') ? 'screen' : 'window'], thumbnailSize: { width: 3840, height: 2160 }, fetchWindowIcons: false });
      const source = sources.find(source => source.id === sourceId);
      if (!source || source.thumbnail.isEmpty()) throw new Error('This screenshot source is no longer available');
      return { data: source.thumbnail.toPNG(), context: { capturedAt: Date.now(), windowTitle: source.name, accessibilityUnavailableReason: 'A display capture has no single application context.' } };
    }),
    captureForeground: async id => desktopPet!.withInteraction(id, () => computerUse!.captureAppshot(undefined, notificationNavigation.signal, petForegroundApplication, appshotRuntime?.snapshot().settings.soundEnabled ?? true)),
    captureEvent: (id, event) => { if (desktopPet!.ownsWebContents(id)) broadcaster.emit('desktop-pet:capture-event', event as unknown as Json); },
    submit: async value => {
      let id: string;
      const files: Array<{ path: string; name: string; mimeType: string; context?: PetAppshotContext }> = [];
      try {
        if (value.targetTaskId && !sessions.isCatalogVisible(value.targetTaskId)) throw new Error('The selected conversation is unavailable.');
        for (const file of value.files) {
          const uploaded = object(await attachments.uploadPath({ path: file.path }));
          if (!uploaded || uploaded.ok === false || typeof uploaded.path !== 'string') throw new Error(string(uploaded?.error, 'The selected file could not be uploaded'));
          files.push({ path: uploaded.path, name: file.name, mimeType: file.mimeType, ...(file.context ? { context: file.context } : {}) });
        }
        id = value.targetTaskId ?? string(object(await sessions.newSession())?.id);
        if (!id) throw new Error('The new conversation has no identity');
      } catch (error) { throw new PetComposerPreparationError(error instanceof Error ? error.message : String(error)); }
      if (!value.targetTaskId) petActivity!.remember({ id, title: value.text.trim() || files[0]?.name || (petLanguage === 'zh' ? '新对话' : 'New conversation') });
      petComposer!.beginConversation(value.ownerId, id, '');
      const inline = files.filter(file => /^(?:image\/(?:png|jpeg|gif|webp)|application\/pdf)$/.test(file.mimeType));
      const references = files.filter(file => !inline.includes(file));
      const text = value.text + (value.replyTo ? '\n\nReplying to ' + value.replyTo.role + ':\n' + value.replyTo.text : '')
        + files.filter(file => file.context).map(file => '\n\n' + appshotContextText(file.context!)).join('')
        + (references.length ? '\n\nAttached:\n' + references.map(file => '- ' + file.path).join('\n') : '');
      const payload = { text, media: inline, displayMetadata: { displayText: value.text, attachments: files, ...(value.replyTo ? { replyTo: value.replyTo } : {}) } } as unknown as Record<string, Json>;
      if (state.isWorking(id)) {
        const reply = object(await sessions.followUp(id, { ...payload, expectedTurnId: state.runningSubmissionId(id) ?? null }));
        if (reply?.ok === false) throw new Error(string(reply.error, 'The message could not be delivered'));
      } else await sessions.send(id, payload);
      return { sessionId: id, ...(state.runningTurnId(id) ? { turnId: state.runningTurnId(id) } : {}) };
    },
    conversation: {
      history: id => sessions.followHistory(id),
      stop: async id => { requireInterruptConfirmation(await sessions.interrupt(id, state.runningTurnId(id))); },
      currentTurn: id => state.runningTurnId(id),
      changed: (id, snapshot) => {
        if (desktopPet!.ownsWebContents(id)) broadcaster.emit('desktop-pet:conversation', snapshot as unknown as Json);
      },
    },
  });
  const pendingMainCaptures = new Map<string, { ownerId: number; accept(accepted: boolean, error?: string): void }>();
  registry.register('desktop-pet:ack-main-capture', context => {
    if (!mainWindows.has(context.senderId) || context.role !== 'main') throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Application capture belongs to the main window');
    const value = object(context.args[0]), id = string(value?.captureId), receipt = pendingMainCaptures.get(id);
    if (!receipt || receipt.ownerId !== context.senderId || typeof value?.accepted !== 'boolean') throw new IpcHandlerError('UNKNOWN_REQUEST', 'The application capture receipt expired');
    receipt.accept(value.accepted, typeof value.error === 'string' ? value.error : undefined); return null;
  }, 'appshot');
  appshotRuntime = new AppshotRuntime({
    filename: join(configRoot, 'appshot-settings.json'),
    observe: (shortcut: string | null, callback: () => void) => {
      if (!shortcut) return;
      if (shortcut === 'DoubleCommand' || shortcut === 'DoubleAlt' || shortcut === 'DoubleOption' || shortcut === 'DoubleShift') {
        if (!native.addon.observeAppshotShortcut || !native.addon.stopAppshotShortcut) return;
        const token = native.addon.observeAppshotShortcut(shortcut, callback);
        if (token) return () => native.addon.stopAppshotShortcut!(token);
        return undefined;
      }
      if (!globalShortcut.register(shortcut, callback)) throw new Error('The application capture shortcut is already in use.');
      return () => globalShortcut.unregister(shortcut);
    },
    capture: async (settings, signal) => {
      const owner = BrowserWindow.getAllWindows().find(item => desktopPet!.ownsWebContents(item.webContents.id));
      const token = appshotCaptureApplication({ ownedWindowFocused: BrowserWindow.getFocusedWindow() != null, companionFocused: owner?.isFocused() === true, previousApplication: petForegroundApplication, captureExternalApplication: () => native.addon.captureActiveApplication?.() ?? undefined });
      const mini = settings.alwaysSendToMini || !focusedMainWindow().isFocused();
      const captured = await computerUse!.captureAppshot(undefined, signal, token, settings.soundEnabled); signal.throwIfAborted();
      if (mini) {
        await desktopPet!.show();
        const deadline = Date.now() + 10_000;
        let target: BrowserWindow | undefined;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          target = BrowserWindow.getAllWindows().find(item => desktopPet!.ownsWebContents(item.webContents.id) && item.isVisible());
          if (target) break;
          await delay(20, undefined, { signal });
        }
        if (!target) throw new Error('The companion did not become ready for application capture.');
        await subscriptions.wait(target.webContents.id, 'desktop-pet:capture-event', signal); signal.throwIfAborted();
        if (settings.destination === 'new-chat') await petComposer!.selectConversation(target.webContents.id, null);
        else if (settings.destination === 'last-chat' && !petComposer!.conversationState(target.webContents.id).sessionId) {
          const rows = await sessions.listSessions(), id = string(object(rows[0])?.id);
          if (id) await petComposer!.selectConversation(target.webContents.id, id);
        }
        await petComposer!.adoptCaptured(target.webContents.id, captured); signal.throwIfAborted();
        await desktopPet!.focusInput();
      } else {
        const captureId = randomUUID(), directory = join(configRoot, 'uploads', 'appshots'); await mkdir(directory, { recursive: true }); signal.throwIfAborted();
        const path = join(directory, captureId + '.png'); await writeFile(path, captured.data, { flag: 'wx', mode: 0o600 });
        const uploaded = object(await attachments.uploadPath({ path })); signal.throwIfAborted();
        if (!uploaded || uploaded.ok === false || typeof uploaded.path !== 'string') throw new Error(string(uploaded?.error, 'The application screenshot could not be attached.'));
        if (uploaded.path !== path) await rm(path, { force: true });
        const targetId = focusedMainWindow().webContents.id;
        await subscriptions.wait(targetId, 'desktop-pet:appshot-main-capture', signal); signal.throwIfAborted();
        let accept!: (accepted: boolean, error?: string) => void;
        const received = new Promise<void>((resolve, reject) => {
          accept = (accepted, error) => accepted ? resolve() : reject(new Error(error || 'The conversation could not receive the application screenshot.'));
        });
        const timeout = setTimeout(() => accept(false, 'The conversation did not acknowledge the application screenshot.'), 15_000);
        const cancelled = (): void => accept(false, 'Application capture was cancelled.');
        signal.addEventListener('abort', cancelled, { once: true }); pendingMainCaptures.set(captureId, { ownerId: targetId, accept });
        try {
          await Promise.all([received, delivery.deliver(targetId, 'desktop-pet:appshot-main-capture', {
            captureId, threadTarget: settings.destination,
            attachment: { path: uploaded.path, name: 'Screenshot.png', mimeType: 'image/png', size: captured.data.byteLength, previewUrl: `data:image/png;base64,${Buffer.from(captured.data).toString('base64')}`, context: captured.context },
          } as unknown as Json, signal)]);
          signal.throwIfAborted(); show();
        } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancelled); pendingMainCaptures.delete(captureId); }
      }
    },
    failed: message => { broadcaster.emit('desktop-pet:capture-event', { type: 'failed', captureId: randomUUID(), message }); },
    log: message => log.write('appshot', message),
  });
  registerAppshotHandlers(registry, appshotRuntime);
  early.add(() => appshotRuntime?.close());
  /** Per-subscription voice preference; the historical Codex key keeps its name. */
  const petRealtimeVoicePreference = (options: PetRealtimeOptions): string | undefined => {
    const suffix = options.sourceId.startsWith('subscription:') ? options.sourceId.slice('subscription:'.length) : '';
    const saved = suffix ? setting(`desktop_pet.realtime_voice.${suffix}`) : undefined;
    return typeof saved === 'string' && saved && options.voices.includes(saved) ? saved : options.defaultVoice;
  };
  const petRealtimeOptions = (sourceId?: string, sessionId?: string): Promise<PetRealtimeOptions> => petRealtimeSourceOptions({
    log: error => log.write('pet-realtime-source', String(error)),
    capabilities: async selected => {
      const mode = selected.startsWith('subscription:') ? selected.slice('subscription:'.length) : '';
      const value = object(await sessions.request('session/realtimeCapabilities', mode ? { authMode: mode } : { modelProviderId: selected }));
      return { available: value?.available === true,
        ...(typeof value?.reason === 'string' ? { reason: value.reason } : {}),
        ...(['v1', 'frameless', 'public', 'qoder'].includes(string(value?.protocol)) ? { protocol: value!.protocol as PetRealtimeOptions['protocol'] } : {}),
        ...(['engine', 'peer'].includes(string(value?.transcriptSource)) ? { transcriptSource: value!.transcriptSource as PetRealtimeOptions['transcriptSource'] } : {}),
        voices: Array.isArray(value?.voices) ? value.voices.filter((voice): voice is string => typeof voice === 'string') : [],
        ...(typeof value?.defaultVoice === 'string' ? { defaultVoice: value.defaultVoice } : {}),
        ...(typeof value?.model === 'string' ? { model: value.model } : {}),
      };
    },
  }, sourceId ?? petRealtimeProviderId, sessionId);
  registry.register('desktop-pet:set-main-conversation', async context => {
    if (context.role !== 'main' || !mainWindows.has(context.senderId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Conversation context belongs to a registered main window');
    const value = object(context.args[0])?.sessionId;
    if (value !== null && (typeof value !== 'string' || !value || value.length > 512 || !sessions.isCatalogVisible(value))) throw new IpcHandlerError('BAD_REQUEST', 'Invalid visible conversation');
    if (typeof value === 'string') petMainConversations.set(context.senderId, value);
    else petMainConversations.delete(context.senderId);
    await petRealtime?.refreshAvailability(); return null;
  }, 'desktop-pet-realtime');
  registry.register('desktop-pet:realtime-options', async context => {
    const payload = object(context.args[0]), sourceId = payload?.sourceId, sessionId = payload?.sessionId;
    if (sourceId !== undefined && (typeof sourceId !== 'string' || !sourceId || sourceId.length > 512)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid realtime source');
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid realtime conversation');
    return await petRealtimeOptions(sourceId as string | undefined, sessionId as string | undefined) as unknown as Json;
  }, 'desktop-pet-realtime');
  petRealtime = new DesktopPetRealtime({
    owns: id => desktopPet!.ownsWebContents(id), visible: () => desktopPet!.snapshot().visible,
    beforeStart: () => { if (chatVoiceRequestId !== undefined || chatRealtime?.reserved()) throw new IpcHandlerError('VOICE_BUSY', 'A voice chat is already active'); },
    availability: async (ownerId, id) => {
      const targetSessionId = petVoiceTarget(id, petComposer?.conversationState(ownerId).sessionId, petMainConversations.get(focusedMainWindow().webContents.id));
      const options = await petRealtimeOptions(petRealtimeProviderId ?? '', targetSessionId);
      if (options.available) await attachPetVoice(ownerId);
      const voice = petRealtimeVoicePreference(options);
      return { ...options, ...(voice ? { voice } : {}) };
    },
    prepare: async (ownerId, targetSessionId, signal, availability) => {
      signal.throwIfAborted();
      targetSessionId ??= availability.targetSessionId;
      if (targetSessionId && !sessions.isCatalogVisible(targetSessionId)) throw new Error('The selected conversation is unavailable.');
      const id = targetSessionId || string(object(await sessions.newSession())?.id);
      if (!id) throw new Error('The realtime conversation could not be created.');
      await sessions.followHistory(id); signal.throwIfAborted();
      const engineId = state.liveSession(id);
      if (!engineId) throw new Error('The realtime conversation is not active.');
      if (!targetSessionId || petComposer!.conversationState(ownerId).sessionId) petComposer!.beginConversation(ownerId, id, '');
      return { sessionId: id, engineId,
        ...((availability.sourceId ?? '').startsWith('subscription:') ? { authMode: (availability.sourceId ?? '').slice('subscription:'.length) } : { modelProviderId: availability.sourceId }),
        protocol: availability.protocol, transcriptSource: availability.transcriptSource, voice: availability.voice };
    },
    request: async (method, params, signal) => {
      signal?.throwIfAborted(); const client = await sessions.client(); signal?.throwIfAborted();
      const value = await client.requestWithTimeout(method, params, 45_000, signal ? { signal } : undefined);
      signal?.throwIfAborted(); return value as Json;
    },
    emit: (id, event) => { if (desktopPet!.ownsWebContents(id)) broadcaster.emit('desktop-pet:voice-event', event as unknown as Json); },
    log: message => log.write('pet-realtime', message),
  });
  registerPetRealtimeHandlers(registry, petRealtime);
  early.add(() => petRealtime?.close());
  const ownsVoiceChat = (id: number): boolean => { const owner = mainWindows.get(id); return !!owner && !owner.isDestroyed() && !owner.webContents.isDestroyed(); };
  chatRealtime = new DesktopPetRealtime({
    owns: ownsVoiceChat,
    visible: ownsVoiceChat,
    resumeOnStopFailure: true,
    beforeStart: () => { if (petRealtime?.reserved()) throw new IpcHandlerError('VOICE_BUSY', 'Another voice conversation is already active'); },
    availability: async (ownerId, id) => {
      const targetSessionId = id ?? petMainConversations.get(ownerId);
      if (targetSessionId && !sessions.isCatalogVisible(targetSessionId)) throw new IpcHandlerError('BAD_REQUEST', 'The selected voice conversation is unavailable');
      const options = await petRealtimeOptions(petRealtimeProviderId ?? '', targetSessionId);
      const voice = petRealtimeVoicePreference(options);
      return { ...options, ...(voice ? { voice } : {}) };
    },
    prepare: async (_ownerId, targetSessionId, signal, availability) => {
      signal.throwIfAborted();
      targetSessionId ??= availability.targetSessionId;
      if (targetSessionId && !sessions.isCatalogVisible(targetSessionId)) throw new Error('The selected voice conversation is unavailable');
      const id = targetSessionId || string(object(await sessions.newSession())?.id);
      if (!id) throw new Error('The voice conversation could not be created');
      await sessions.followHistory(id); signal.throwIfAborted();
      const engineId = state.liveSession(id);
      if (!engineId) throw new Error('The voice conversation is not active');
      return { sessionId: id, engineId,
        ...((availability.sourceId ?? '').startsWith('subscription:') ? { authMode: (availability.sourceId ?? '').slice('subscription:'.length) } : { modelProviderId: availability.sourceId }),
        protocol: availability.protocol, transcriptSource: availability.transcriptSource, voice: availability.voice };
    },
    request: async (method, params, signal) => {
      signal?.throwIfAborted(); const client = await sessions.client(); signal?.throwIfAborted();
      const value = await client.requestWithTimeout(method, params, 45_000, signal ? { signal } : undefined);
      signal?.throwIfAborted(); return value as Json;
    },
    emit: (id, event) => {
      if (event.type === 'audio') { const owner = mainWindows.get(id); if (owner) sendToMainWindow(owner, 'voice:chat:event', event as unknown as Json); return; }
      if (chatVoiceRequestId && id === chatVoiceOwnerId && event.state.generation < chatVoiceReservedGeneration) return;
      const owner = mainWindows.get(id); if (owner) sendToMainWindow(owner, 'voice:chat:event', event as unknown as Json);
      if (id === chatVoiceOwnerId) voicePresentation?.update(id, event.state.phase === 'connecting' ? { ...event.state, sessionId: chatVoiceTargetSessionId } : event.state);
      if (event.state.phase === 'inactive' && chatVoiceOwnerId === id) releaseChatVoiceLease(id); powerRuntime?.changed();
    },
    log: message => log.write('voice-chat', message),
  });
  voicePresentation = new VoiceChatPresentationRuntime({
    createWindow: () => {
      const owner = createVoiceChatWindow();
      if (process.platform === 'darwin' && native.addon.configurePetPanel && !native.addon.configurePetPanel(owner.getNativeWindowHandle())) { owner.destroy(); throw new Error('Could not configure the voice panel'); }
      return owner;
    },
    register: owner => { const id = owner.webContents.id; windows.register(id, 'voice-chat'); broadcaster.addTarget({ id, role: 'voice-chat' }); },
    unregister: id => { subscriptions.clearOwner(id); delivery.closeOwner(id); windows.unregister(id); broadcaster.removeTarget(id); },
    pageUrl: () => appUrl('voice-chat.html'),
    workArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    send: (owner, value) => { if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) broadcaster.emit('voice:overlay:event', value as unknown as Json); },
    ownerEligible: id => ownsVoiceChat(id) && mainWindows.get(id)!.isVisible() && mainWindows.get(id)!.isFocused(),
    preferences: () => {
      return { language: setting('language') === 'zh' ? 'zh' : 'en', dark: setting('theme') === 'dark' || setting('theme') !== 'light' && nativeTheme.shouldUseDarkColors };
    },
    position: () => { try { const saved = JSON.parse(setting('voice_chat.overlay_position') || 'null'); return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : undefined; } catch { return undefined; } },
    savePosition: value => { kvSet('voice_chat.overlay_position', JSON.stringify(value), configRoot); },
    action: async (id, action, muted) => {
      if (action === 'stop') { const owner = mainWindows.get(id); if (owner) sendToMainWindow(owner, 'voice:chat:toggle', { action: 'stop' }); }
      const value = await chatRealtime!.action(id, action, muted);
      if (action === 'stop' && value.phase === 'inactive') releaseChatVoiceLease(id);
      return value;
    },
    open: async (id, sessionId) => { const owner = mainWindows.get(id); if (!owner || owner.isDestroyed()) return; if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus(); sendToMainWindow(owner, 'deep-link:open-session', { sessionId }); },
    log: message => log.write('voice-chat-presentation', message),
  });
  function releaseChatVoiceLease(id: number, requestId?: string): void {
    if (chatVoiceOwnerId !== id || requestId !== undefined && chatVoiceRequestId !== requestId) return;
    const owner = mainWindows.get(id), sessionId = chatVoiceTargetSessionId;
    chatVoiceOwnerId = undefined; chatVoiceRequestId = undefined; chatVoiceTargetSessionId = undefined;
    if (sessionId) sessions.sessionInterestChanged(sessionId);
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) {
      owner.webContents.setBackgroundThrottling(chatVoiceBackgroundThrottling);
      if (!owner.isVisible()) void voice.detachOwner(id).catch(error => log.write('voice-chat-owner', String(error)));
    }
  }
  async function stopChatVoiceSession(sessionId: string): Promise<void> {
    if (chatVoiceTargetSessionId !== sessionId) return;
    const id = chatVoiceOwnerId, owner = id === undefined ? undefined : mainWindows.get(id);
    if (owner) sendToMainWindow(owner, 'voice:chat:toggle', { action: 'stop' });
    await chatRealtime?.releaseSession(sessionId);
    if (id !== undefined && !chatRealtime?.reserved()) { releaseChatVoiceLease(id); voicePresentation?.releaseOwner(id); }
  }
  registerVoiceChatHandlers(registry, chatRealtime, ownsVoiceChat, voicePresentation, {
    reserve: async (id, requestId, sessionId) => {
      if (chatVoiceRequestId && (chatVoiceOwnerId !== id || chatVoiceRequestId !== requestId) || petRealtime?.reserved() || voice.service.busy()) throw new IpcHandlerError('VOICE_BUSY', 'Another voice operation is already active');
      if (!sessionId || !sessions.isCatalogVisible(sessionId)) throw new IpcHandlerError('BAD_REQUEST', 'The voice conversation is unavailable');
      const owner = mainWindows.get(id)!;
      if (!chatVoiceRequestId) chatVoiceBackgroundThrottling = owner.webContents.getBackgroundThrottling();
      chatVoiceOwnerId = id; chatVoiceRequestId = requestId; chatVoiceTargetSessionId = sessionId; chatVoiceReservedGeneration = chatRealtime!.snapshot().generation + 1; owner.webContents.setBackgroundThrottling(false);
      sessions.sessionInterestChanged(sessionId);
      try { await voice.attachOwner(id); } catch (error) { releaseChatVoiceLease(id, requestId); throw error; }
      if (chatVoiceOwnerId !== id || chatVoiceRequestId !== requestId) throw new IpcHandlerError('VOICE_EXPIRED', 'The voice reservation changed');
      voicePresentation!.update(id, { ...chatRealtime!.snapshot(), sessionId, phase: 'connecting', generation: chatRealtime!.snapshot().generation + 1 });
    },
    assert: (id, requestId, required = false) => { if (required && chatVoiceRequestId === undefined || chatVoiceRequestId !== undefined && (id !== chatVoiceOwnerId || requestId !== chatVoiceRequestId)) throw new IpcHandlerError('VOICE_EXPIRED', 'The voice reservation changed'); },
    end: (id, requestId) => { if (chatVoiceRequestId === requestId) releaseChatVoiceLease(id); },
  });
  early.add(() => chatRealtime?.close());
  early.add(() => voicePresentation?.close());
  const stopVoiceOnLock = (): void => { if (chatVoiceOwnerId !== undefined) { const owner = mainWindows.get(chatVoiceOwnerId); if (owner) sendToMainWindow(owner, 'voice:chat:toggle', { action: 'stop' }); void chatRealtime?.release(chatVoiceOwnerId).catch(error => log.write('voice-chat-lock', String(error))); } };
  powerMonitor.on('lock-screen', stopVoiceOnLock);
  early.add(() => { powerMonitor.removeListener('lock-screen', stopVoiceOnLock); });
  early.add(async () => { await Promise.allSettled([...petVoiceReleases]); });
  registerPetComposerHandlers(registry, petComposer);
  early.add(() => petComposer?.close());
  early.add(() => desktopPet?.shutdown());
  early.add(() => petActivity?.close());
  protocol.handle('klaus-pet', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'local' || request.method !== 'GET') return new Response('forbidden', { status: 403 });
      const asset = await desktopPet!.asset(decodeURIComponent(url.pathname.slice(1)));
      return new Response(Buffer.from(asset.bytes), { headers: { 'Content-Type': asset.mime, 'Cache-Control': 'private, max-age=86400' } });
    } catch { return new Response('not found', { status: 404 }); }
  });
  early.add(() => protocol.unhandle('klaus-pet'));
  await desktopPet.initialize();
  await desktopPet.updateSettings({ language: setting('language') === 'zh' ? 'zh' : 'en' });
  const retainedPetActivity = await petActivityStore.load();
  await sessions.listSessions();
  petActivity.reconcile(retainedPetActivity.filter(record => sessions.isCatalogVisible(record.id)));
  petActivityHydrated = true;
  petActivityStore.save(petActivity.persistenceSnapshot());
  early.add(() => petActivityStore.flush());
  desktopPet.setTasks(petActivity.snapshot());
  const controlChannels = new Set(KLAUS_CONTROL_CHANNELS);
  const control = new KlausControlService({
    context: (engineId, signal) => {
      const context = hostToolContext(engineId, signal);
      return { ...context, currentBrowserSessionId: () => browser.conversationId,
        dispatch: async (channel, payload) => {
          context.assertCurrent();
          if (!controlChannels.has(channel) || !roles.mayInvoke('main', channel)) throw new IpcHandlerError('FORBIDDEN', 'This application action is unavailable to model tools');
          const owner = sessionMainWindow(context.sessionId);
          if (owner.isDestroyed()) throw new IpcHandlerError('WINDOW_CLOSED', 'The main application window is unavailable');
          const handler = registry.lookup(channel);
          if (!handler) throw new IpcHandlerError('CHANNEL_UNAVAILABLE', 'This application action has no handler');
          // The update owner starts verification after this tool can finish;
          // its prepareToQuit callback will drain all dynamic/control work.
          const result = channel === 'updater:install' ? updater.requestInstall(context.signal)
            : await handler({ role: 'main', senderId: owner.webContents.id, channel, args: [payload], signal: context.signal, assertCurrent: context.assertCurrent });
          context.assertCurrent(); return result;
        } };
    },
    manual: () => readFile(manualPath(), 'utf8'),
    storedRows: () => { const rows = kvSnapshot(configRoot); if (isFailure(rows)) throw new IpcHandlerError(rows.code, rows.message); return rows; },
    threadTool: (name, payload, context) => threadTools.execute(name, payload, context),
    navigate: async (payload, context) => {
      context.assertCurrent();
      await deliverToFocusedMain('app:navigate', payload, context.signal);
      context.assertCurrent();
    },
    preferencesChanged: async (key, context) => {
      context.assertCurrent(); await configuration.settingsChanged(key); emit('app:preferences-changed', { key });
      if (key === 'language') refreshMenus();
    },
    quickInput: {
      shortcuts: () => ['main', 'quickInput'].map(slot => ({ ...shortcuts!.state(slot as 'main' | 'quickInput') })),
      card: () => quickInput.snapshot(),
      show: async context => { context.assertCurrent(); return await quickInput.show(); },
      hide: async context => { context.assertCurrent(); return await quickInput.hide(); },
      setShortcut: async (which, value) => {
        const commandId = which === 'main' ? 'summonMainWindow' : 'openQuickInput';
        if (value === 'off') await keymap.update(commandId, { type: 'clear' });
        else if (value === 'default') await keymap.update(commandId, { type: 'reset' });
        else await keymap.update(commandId, { type: 'set', accelerator: value });
      },
    },
  });
  registerKlausControlTools(dynamicTools, control);
  early.add(() => control.close());
  const windowOp = (id: number, op: WindowOp): Json => {
    const contents = webContents.fromId(id);
    const owner = contents ? BrowserWindow.fromWebContents(contents) : null;
    if (!owner || !windows.roleOf(id)) throw new IpcHandlerError('WINDOW_CLOSED', 'The window is no longer available');
    const role = windows.roleOf(id);
    if (role !== 'main' && role !== 'artifact' && !(role === 'recorder' && op.op === 'close')) {
      throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'This window cannot perform that operation');
    }
    if (role === 'main' && owner !== window && op.op === 'close') { owner.close(); return null; }
    const result = handleWindowOp(op, windows.roleOf(id)!, owner);
    if (!result.ok) throw new IpcHandlerError('WINDOW_OPERATION_FAILED', result.error);
    return result.value;
  };
  const binding = { route: async (...args: Parameters<IpcRouter['route']>) => {
    const result = await router.route(...args);
    if (result.ok && args[0].role === 'main' && args[1] !== 'session:delete') mobile?.noteRendererSession(args[2] ?? [], args[1]);
    if (result.ok && args[0].role === 'main') mobile?.noteRendererResponse(args[1], args[2] ?? []);
    return result;
  }, roleOf: windows.resolver(), windowOp };
  invokeLease.bind(binding);
  const attachMainWindow = (owner: BrowserWindow, primary = false): void => {
    owner.webContents.on('console-message', (_event, _level, message) => {
      if (isTrustedAppUrl(owner.webContents.mainFrame.url)) cursorDiagnostics.renderer(message);
    });
    const id = owner.webContents.id;
    mainWindows.set(id, owner); windows.register(id, 'main'); broadcaster.addTarget({ id, role: 'main' });
    const closeTextContextMenu = installTextContextMenu(owner, template => Menu.buildFromTemplate(template), {
      copyLink: async (url, title) => { await clipboard.write([new ClipboardItem({ 'text/plain': url, 'electron application/bookmark': { title, url } })]); },
      search: async text => { const url = new URL('https://www.google.com/search'); url.searchParams.set('q', text); await shell.openExternal(url.toString()); },
      log: error => log.write('text-context-menu', String(error)),
    }, () => kvGet('language', configRoot) === 'zh');
    textContextMenusByWindow.set(id, closeTextContextMenu);
    if (!primary) { createComposerCommands(owner); createImageZoomCommands(owner); createCanvas(owner); native.attachWindow(owner); ssh.attachWindow(owner); voice.attachWindow(owner); pip!.attachWindow(owner); }
    owner.on('focus', () => {
      lastMainWindow = owner; browser.adoptWindow(owner); refreshMenus();
      void petRealtime?.refreshAvailability().catch(error => log.write('pet-realtime-source', String(error)));
      void chatRealtime?.refreshAvailability().catch(error => log.write('voice-chat-availability', String(error)));
    });
    owner.on('resize', () => { if (!owner.webContents.isDestroyed()) owner.webContents.send(HOST_CHANNELS.resized); });
    owner.on('close', event => {
      if (!closing && primary) { event.preventDefault(); owner.hide(); }
      else if (!closing && browser.windowId === id) browser.adoptWindow(window);
    });
    owner.webContents.once('destroyed', () => sessions.releaseViewOwner(id));
    const detachQuestions = (): void => {
      void browserAnnotations.releaseWindow(id).catch(error => log.write('browser-annotation-cleanup', String(error)));
      sessions.releaseViewOwner(id);
      void chatRealtime?.release(id).catch(error => log.write('voice-chat-cleanup', String(error)));
      releaseChatVoiceLease(id);
      voicePresentation?.releaseOwner(id);
      nativeContentFind.closeOwner(id);
      petMainConversations.delete(id);
      void petRealtime?.refreshAvailability().catch(error => log.write('pet-realtime-source', String(error)));
      void chatRealtime?.refreshAvailability().catch(error => log.write('voice-chat-availability', String(error)));
      feedback.releaseRenderer(id);
      for (const [sessionId, ownerId] of conversationOwners) if (ownerId === id) void memorySnapshots!.rendererUnavailable(sessionId).catch(error => log.write('memory-snapshot', String(error)));
      void sessions.detachQuestionOwner(id).catch(error => log.write('side-question-owner', String(error)));
      void composerPredictions?.detachOwner(id).catch(error => log.write('prediction-owner', String(error)));
      void teamCollaboration?.detachOwner(id).catch(error => log.write('collaboration-draft-owner', String(error)));
      dropCameraLease(id);
    };
    owner.on('hide', () => voicePresentation?.changed());
    owner.on('blur', () => voicePresentation?.changed());
    owner.on('focus', () => voicePresentation?.changed());
    owner.on('closed', () => {
      closeTextContextMenu(); textContextMenusByWindow.delete(id);
      detachQuestions(); subscriptions.clearOwner(id); delivery.closeOwner(id); windows.unregister(id); broadcaster.removeTarget(id);
      mainWindows.delete(id); nativeMenuStates.delete(id); browser.forgetWindow(id);
      composerCommandsByWindow.get(id)?.close(); composerCommandsByWindow.delete(id);
      imageZoomByWindow.get(id)?.close(); imageZoomByWindow.delete(id);
      const service = canvasByWindow.get(id); canvasByWindow.delete(id);
      if (service) void service.dispose().catch(error => log.write('canvas-window-close', String(error)));
      for (const [sessionId, ownerId] of conversationOwners) if (ownerId === id) conversationOwners.delete(sessionId);
      if (!closing) { lastMainWindow = window; browser.adoptWindow(focusedMainWindow()); refreshMenus(); }
    });
    owner.webContents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) { detachQuestions(); subscriptions.clearOwner(id); delivery.closeOwner(id, 'Renderer navigated'); }
    });
    owner.webContents.on('preload-error', (_event, _path, error) => log.write('preload-error', error.message));
    owner.webContents.on('render-process-gone', (_event, details) => {
      detachQuestions(); subscriptions.clearOwner(id); delivery.closeOwner(id, 'Renderer process exited');
      log.write('renderer-gone', JSON.stringify({ ...details, senderId: id }));
    });
  };
  attachMainWindow(window, true);
  async function openMainWindow(): Promise<BrowserWindow> {
    if (closing) throw new IpcHandlerError('WINDOW_CLOSED', 'The application is shutting down');
    const owner = createMainWindow(edition.productName);
    attachMainWindow(owner);
    try {
      await owner.loadURL(appUrl('index.html') + '?' + new URLSearchParams({ windowId: randomUUID() }));
      if (closing || owner.isDestroyed()) throw new IpcHandlerError('WINDOW_CLOSED', 'The application window closed while loading');
      lastMainWindow = owner; owner.show(); owner.focus(); return owner;
    } catch (error) { if (!owner.isDestroyed()) owner.destroy(); throw error; }
  }
  registry.registerAll({
    'app:content-find': async context => {
      if (context.role !== 'main' || !mainWindows.has(context.senderId)) throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'Content Find belongs to a registered main window');
      const value = payload(context);
      if (value.action === 'stop') { nativeContentFind.stop(context.senderId); return null; }
      if (browser.windowId !== context.senderId || !browser.state().visible) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'The browser search surface is unavailable');
      if (value.action !== 'find' || typeof value.query !== 'string' || value.query.length > 16384) throw new IpcHandlerError('BAD_REQUEST', 'Invalid content search');
      const options = object(value.options) ?? {};
      if (Object.keys(options).some(key => !['forward', 'findNext', 'matchCase'].includes(key) || typeof options[key] !== 'boolean')) throw new IpcHandlerError('BAD_REQUEST', 'Invalid content search options');
      return await nativeContentFind.find(context.senderId, value.query, options) as unknown as Json;
    },
    'window:setTitleBarColors': context => {
      const value = payload(context), color = requiredString(value, 'color'), symbolColor = requiredString(value, 'symbolColor');
      if (![color, symbolColor].every(item => /^#[\da-f]{6}$/i.test(item))) throw new IpcHandlerError('BAD_REQUEST', 'Expected six-digit color values');
      const contents = webContents.fromId(context.senderId), owner = contents && BrowserWindow.fromWebContents(contents);
      if (!owner) throw new IpcHandlerError('WINDOW_CLOSED', 'The window is no longer available');
      if (process.platform === 'win32') owner.setTitleBarOverlay({ color, symbolColor });
      return null;
    },
    'app:native-menu-state': context => {
      if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'Native menu state belongs to main windows');
      const value = parseNativeMenuState(payload(context));
      if (!value) throw new IpcHandlerError('BAD_REQUEST', 'Invalid native menu state');
      nativeMenuStates.set(context.senderId, value);
      if (focusedMainWindow().webContents.id === context.senderId) refreshMenus();
      return null;
    },
    'app:distribution': () => ({ ...publicDesktopDistribution(edition, account.serverUrl) }),
    'app:openExternal': async context => {
      const value = payload(context);
      const url = requiredString(value, 'url');
      const parsed = new URL(url);
      if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new IpcHandlerError('BAD_REQUEST', 'Unsupported external URL');
      await shell.openExternal(url);
      return null;
    },
    'app:setApprovalBadge': context => {
      const value = payload(context);
      const count = value.count;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new IpcHandlerError('BAD_REQUEST', 'count must be a nonnegative integer');
      app.setBadgeCount(count);
      return null;
    },
    'composer:edit-focus': context => {
      const value = payload(context);
      // Anything that is not the exact shape is read as "no composer owns the
      // focus", which leaves the keystroke with Chromium instead of swallowing it.
      const commands = composerCommandsByWindow.get(context.senderId);
      if (!commands) throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'This window does not own composer editing');
      commands.reportFocus(value);
      return null;
    },
    'app:loginItem:get': () => ({ enabled: app.getLoginItemSettings().openAtLogin }),
    'app:loginItem:set': context => {
      const value = payload(context);
      if (typeof value.enabled !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'enabled is required');
      app.setLoginItemSettings({ openAtLogin: value.enabled });
      // Settings rows treat a missing `ok` as a failed write, so the envelope
      // carries it alongside the read-back registration state.
      return { ok: true, enabled: app.getLoginItemSettings().openAtLogin };
    },
    // The friends scan dialog leases the camera for as long as it is open; the
    // voice media gate consults the lease before admitting video.
    'app:camera-lease': context => {
      if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'The camera lease belongs to the main window');
      grantCameraLease(context.senderId);
      return null;
    },
    'app:camera-lease-release': context => {
      if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'The camera lease belongs to the main window');
      releaseCameraLease(context.senderId);
      return null;
    },
  }, 'application');
  const menuChinese = () => nativeMenuUsesChinese(kvGet('language', configRoot), edition.defaultLanguage, app.getLocale());
  const menuDiagnostics = new DesktopMenuDiagnostics({
    app, configRoot, parent: () => focusedMainWindow(), chinese: menuChinese,
    status: () => ({ engineProcesses: engine.liveProcessCount(), ...native.counts() }),
    onChanged: () => refreshMenus(), log: (kind, detail) => log.write(kind, detail),
  });
  early.add(() => menuDiagnostics.close());
  function refreshMenus(): void {
    if (!menusInitialized) return;
    const chinese = menuChinese();
    const labels = chinese
      ? { newChat: '新对话', show: '显示 Klaus', quickInput: '快速输入', mini: '迷你助手', settings: '设置', quit: '退出' }
      : { newChat: 'New Chat', show: 'Show Klaus', quickInput: 'Quick Input', mini: 'Mini', settings: 'Settings', quit: 'Quit' };
    const menuLabels = nativeMenuLabels(chinese);
    // Menu accelerators are computed from the LIVE keymap on every build, never
    // cached as constants — the live keymap is read each time. A user edit,
    // a reset, or a locale change therefore shows up in the menu immediately,
    // because every one of those paths calls refreshMenus.
    const keymapState = keymap.snapshot();
    const acceleratorFor = (commandId: string): string | undefined =>
      menuAccelerators(commandId, keymapState, keymapRegistry)[0];
    // A menu item does NOT execute the action: it forwards the command id back to
    // the renderer, which dispatches through the same handler table a keybinding
    // uses (a `run-command` payload). That keeps exactly one execution path per
    // command even though two surfaces can trigger it.
    const runCommandItem = (commandId: string): Electron.MenuItemConstructorOptions => {
      // A menu command with no label is a wiring error, so it throws rather than
      // falling back to some other command's text — it throws
      // (`Electron menu command 'x' is not defined`). A silently mislabelled menu
      // item would run one action while reading as another.
      const label = menuLabels.commands[commandId];
      if (label == null) throw new Error(`Native menu command is not labelled: ${commandId}`);
      const accelerator = commandId === 'findInThread'
        ? effectiveKeybindings(commandId, keymapState, keymapRegistry).find(key => acceleratorFor(commandId) === key || findHandoffCommand(key, platformOf(process.platform)) === 'find')
        : acceleratorFor(commandId);
      return {
        id: commandId,
        label,
        ...(accelerator == null ? {} : { accelerator }),
        click: () => runMainWindowCommand(commandId),
      };
    };
    // The macOS "Check for Updates…" app-menu item: a manual check that
    // shares the single UpdateService operation, disabled with a progress
    // label while checking/downloading, and hidden when updates are
    // unsupported (dev builds, Tauri-era installs, custom data profiles).
    const buildUpdateMenuItem = (): Electron.MenuItemConstructorOptions => {
      const status = updaterStatusForMenu[0];
      if (!status?.supported) return { label: menuLabels.update.check, enabled: false, visible: false };
      // Klaus's UpdateService has no distinct installing state: a confirmed
      // install hands off and quits, so only check/download disable the item.
      const label = status.state === 'checking' ? menuLabels.update.checking
        : status.state === 'downloading' ? menuLabels.update.downloading
        : menuLabels.update.check;
      return {
        label,
        enabled: status.state !== 'checking' && status.state !== 'downloading',
        click: () => { void updater.check(); },
      };
    };
    // The default File/Edit/View/Window/Help bar only makes sense on macOS, where the
    // system menu bar lives outside the window. On Windows and Linux it renders as an
    // extra row above the sidebar that duplicates nothing the UI needs, so no
    // application menu is installed there at all.
    //
    // The command items are what make the keymap visible in the menu bar: each one
    // carries the accelerator the user currently has bound, and clicking it
    // forwards the command id instead of running the action, so the menu and the
    // keyboard share one execution path.
    if (process.platform === 'darwin') {
      const owner = focusedMainWindow();
      const helpAction = (action: 'documentation' | 'whatsNew' | 'feedback') => () => {
        const target = focusedMainWindow();
        void target.webContents.executeJavaScript(`window.klausMenuHelp?.${action}()`, true)
          .catch(error => log.write('menu-help', String(error)));
      };
      Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate({
        name: app.name, labels: menuLabels,
        state: nativeMenuStates.get(owner.webContents.id) ?? INITIAL_NATIVE_MENU_STATE,
        command: runCommandItem,
        update: buildUpdateMenuItem(),
        editMenu: createOwnedEditMenu(template => Menu.buildFromTemplate(template), owner.webContents, mainWindowEditCommands(owner), command => Menu.sendActionToFirstResponder(`${command}:`), menuLabels),
        newWindow: () => { void openMainWindow().catch(error => { log.write('new-window', String(error)); dialog.showErrorBox(menuLabels.actions.newWindow, String(error)); }); },
        mini: { accelerator: keymap.globalSlotValue('toggleDesktopPet') || undefined, click: () => { void desktopPet?.toggleFromShortcut().catch(error => log.write('desktop-pet', String(error))); } },
        zoom: dispatchImageMenuZoom,
        findNavigation: direction => {
          void focusedMainWindow().webContents.executeJavaScript(`window.klausContentFindNavigation?.(${JSON.stringify(direction)})`, true)
            .catch(error => log.write('content-find-navigation', String(error)));
        },
        development: !app.isPackaged,
        support: {
          documentation: helpAction('documentation'), whatsNew: helpAction('whatsNew'), feedback: helpAction('feedback'),
          troubleshooting: () => { void menuDiagnostics.openTroubleshooting(); }, status: () => { void menuDiagnostics.showStatus(); },
          taskManager: () => { void menuDiagnostics.showTaskManager(); }, trace: () => { void menuDiagnostics.toggleTrace(); },
        },
        trace: { state: menuDiagnostics.traceState, enabled: menuDiagnostics.traceEnabled },
      })));
    } else {
      Menu.setApplicationMenu(null);
    }
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: labels.newChat, click: () => { show(); sendToMainWindow(focusedMainWindow(), 'tray:new-chat'); } },
      { label: labels.show, click: show },
      { label: labels.quickInput, click: openQuickInput },
      { label: labels.mini, click: () => { void desktopPet?.toggleFromShortcut().catch(error => log.write('desktop-pet', String(error))); } },
      { label: labels.settings, click: () => { show(); sendToMainWindow(focusedMainWindow(), 'tray:open-settings'); } },
      { type: 'separator' }, { label: labels.quit, click: () => app.quit() },
    ]));
  }
  const iconPath = join(resourceRoot(), 'tray-icon.png');
  if (options.tray !== false && existsSync(iconPath)) {
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    early.add(() => tray?.destroy());
    tray.setToolTip(edition.productName);
    tray.on('click', show);
  }
  menusInitialized = true;
  refreshMenus();
  const drainForQuit = (): Promise<void> => drainPromise ??= (async () => {
    await prototype.prepareToClose();
    await videoEditing.prepareToClose();
    await ppt.prepareToClose();
    closing = true;
    stopResponsivenessMonitor();
    invokeLease.close();
    app.removeListener('browser-window-focus', checkPluginUpdates);
    closeNotifications();
    log.write('shutdown', 'Stopping IPC and engine ownership');
    const mobileClosing = mobile!.close();
    shortcuts?.close(); quickDelivery.close();
    petActivity?.close(); petComposer?.close();
    const petClosing = desktopPet?.shutdown();
    voicePresentation?.close();
    powerMonitor.removeListener('lock-screen', stopVoiceOnLock);
    const collaborationClosing = teamCollaboration!.close();
    const accountClosing = collaborationClosing.finally(() => usage.close()).finally(() => account.close());
    const quickClosing = quickInput.shutdown();
    const voiceClosing = Promise.allSettled([quickClosing, petRealtime?.close(), chatRealtime?.close()]).then(async () => { await Promise.allSettled([...petVoiceReleases]); return voice.shutdown(); });
    const questionsClosing = Promise.all([sessions.closeSideQuestions(), composerPredictions?.close()]);
    const mcpRuntimeClosing = mcpRuntime!.close();
    const cronClosing = cronRuntime!.close();
    const pairingClosing = Promise.all([wechatPairing.close(), whatsappPairing.close()]), channelsClosing = channels.close(), channelTurnsClosing = channelTurns.close();
    const acquisitionClosing = Promise.allSettled([skillMarket.close(), pluginMarketplaces.close(), officialPlugins.close(), externalImport.close(), skills.close(), plugins.close(), mcpDevice.close().finally(() => mcpBuiltins.close()), mcpDiagnostics.close(), feedback.close()]).then(async results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Extension acquisition did not finish closing');
    });
    worktrees.close();
    const errors: unknown[] = [];
    const ownersClosing = [
        petClosing,
        appshotRuntime?.close(),
        petActivityStore.flush(),
        mobileClosing,
        remoteThreads?.close(),
        workspaceDependencies.close(),
        control.close().finally(() => threadTools.close()),
        connectors!.shutdown(),
        Promise.allSettled([accountClosing, mcpRuntimeClosing]).then(async results => {
          const report = await credentials.close(2500);
          log.write('credential-shutdown', JSON.stringify(report));
          if (!report.complete) throw new Error('Credential operations did not finish before the shutdown deadline');
          const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
          if (errors.length) throw new AggregateError(errors, 'Account and MCP authorization shutdown failed');
        }), mediaGeneration!.close(), Promise.resolve().then(() => powerRuntime?.close()), Promise.resolve().then(() => files?.close()),
        collaborationClosing, git.close(), questionsClosing, cronClosing, dream!.close(), memorySnapshots!.close(), pairingClosing, channelsClosing, channelTurnsClosing, channelsClosing.then(() => discordAccess.close(), () => discordAccess.close()), permissionRules.close(), skillWatcher.close(), extensions.close(), acquisitionClosing, hooksStyles.close(), attachments.close(), mcp.close(), documents.close(), agentTasks.close(),
        cronMetadataBackfill,
        computerUse!.shutdown().then(async result => {
          const picture = await pip!.shutdown();
          if (!result.complete || !picture.complete) throw new Error('Computer Use and Picture-in-Picture resources did not finish before the shutdown deadline');
        }),
        // The accepted update awaits this drain. Disposing its owner here would
        // wait for the same install operation and prevent either from finishing.
        ...(preparingUpdate ? [] : [updater.dispose()]),
        ssh.shutdown().then(result => { if (!result.complete) throw new Error('SSH resources did not finish before the shutdown deadline'); }),
        clipboardFiles.close(), quickClosing.then(result => { if (!result.complete) throw new Error('Quick input resources did not finish before the shutdown deadline'); }),
        voiceClosing.then(result => { if (!result.complete) throw new Error('Voice resources did not finish before the shutdown deadline'); }),
      ];
    const ownersSettled = Promise.allSettled(ownersClosing);
    try { await dynamicTools!.close(); } catch (error) { errors.push(error); }
      // Accepted host mutations may still be awaiting engine terminal replies.
      // Keep their connection alive until every owner has drained its work.
      errors.push(...(await ownersSettled).flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      const results = await Promise.allSettled([
        sessions.shutdown(), browserMcp.shutdown(), native.shutdown(), digram.shutdown(), model3d.shutdown(),
      ]);
      errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      for (const error of errors) log.write('shutdown-error', String(error));
      const nativeResult = results[2];
      if (nativeResult?.status === 'fulfilled') {
        log.write('native-shutdown', JSON.stringify(nativeResult.value));
        if (!nativeResult.value.complete) errors.push(new Error('Native resources did not finish before the shutdown deadline'));
      }
    if (errors.length) throw new AggregateError(errors, 'Application resources did not finish closing');
  })().catch(error => {
    if (!closing) {
      prototype.abortClosePreparation();
      videoEditing.abortClosePreparation();
      drainPromise = undefined;
    }
    throw error;
  });
  const prepareUpdate = (): Promise<void> => {
    if (shutdownPromise || (closing && !preparingUpdate)) return Promise.reject(new Error('The application is already shutting down'));
    preparingUpdate = true;
    // Keep the recovery ledger intact: the drain below interrupts live turns,
    // and without freezing the ledger those sessions would be erased before the
    // next startup has a chance to continue them.
    return resumeLedger.freeze().then(() => drainForQuit());
  };
  const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
    const errors: unknown[] = [];
    try { await drainForQuit(); } catch (error) { if (!closing) { shutdownPromise = undefined; throw error; } errors.push(error); }
    const finalizers = [
        () => updater.dispose(),
        () => delivery.close(), () => ipcMain.removeListener(HOST_CHANNELS.deliveryAck, acknowledge),
        () => subscriptions.close(), () => ipcMain.removeListener(HOST_CHANNELS.listenerState, listenerState),
        () => prototype.dispose(), () => videoEditing.dispose(), () => ppt.dispose(),
        () => menuDiagnostics.close(),
        () => nativeContentFind.close(),
        () => Promise.all([...canvasByWindow.values()].map(service => service.dispose())), () => browser.dispose(), () => chat.close(), () => tray?.destroy(), closePreviews,
        () => media.close(), () => protocol.unhandle(MEDIA_SCHEME), () => protocol.unhandle('klaus-pet'),
        () => { for (const owner of mainWindows.values()) if (!owner.isDestroyed()) owner.destroy(); },
        () => served.close(), () => cursorLog.close(), () => log.close(), () => invokeLease.dispose(),
      ];
      for (const finish of finalizers) { try { await finish(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Application cleanup did not complete');
  })();
  fullShutdown = shutdown;
  await mobile.startFromSettings();
  await browserPreferences.initialize();
  // A packaged app provisions only the official plugins its build bundled. A
  // development launch may point KLAUS_OFFICIAL_PLUGINS_DIR at a marketplace
  // checkout (`<dir>/plugins/<name>`) to exercise the same offline install.
  const developmentOfficialPlugins = !app.isPackaged ? process.env.KLAUS_OFFICIAL_PLUGINS_DIR?.trim() : undefined;
  const bundledPrototype = [
    ...resourceDirs.map(directory => join(directory, 'plugins-official', 'prototype-studio')),
    ...(developmentOfficialPlugins ? [resolve(developmentOfficialPlugins, 'plugins', 'prototype-studio')] : []),
  ].find(path => existsSync(join(path, 'runtime', 'dist', 'runtime-manifest.json')));
  if (bundledPrototype) await plugins.ensureBundledOfficial('prototype-studio', bundledPrototype);
  await refreshDigramEnabled();
  // Discover catalog changes in the background while retaining cached content offline.
  pluginMarketplaces.startUpdateChecks();
  app.on('browser-window-focus', checkPluginUpdates);
  log.write('legacy-ui-state', JSON.stringify(stageLegacyUiState(configRoot, homedir(), process.platform)));
  await window.loadURL(appUrl('index.html'));
  await appshotRuntime.initialize();
  void notificationAuthorization.ensure();
  if (!options.notificationFixture) void nativeNotifications.restore();
  cronMetadataBackfill = backfillCronAutomationSessionMetadata(cronStore, sessions, message => log.write('cron', message))
    .then(() => undefined)
    .catch(error => { log.write('cron', `automation metadata backfill failed: ${String(error)}`); });
  cronRuntime.start();
  updater.start();
  // Restart recovery: a few seconds in, continue the sessions the ledger says
  // were mid-turn when the app last quit (update relaunch, crash, user quit).
  // Opening the thread resumes it; an unsettled tail turn is continued, which
  // walks the engine's durable queue — and the recovered turn rebuilds its own
  // background processes and subagents through normal tools.
  const resumeRecoveryTimer = setTimeout(() => {
    void runStartupResumeRecovery(resumeLedger, {
      history: sessionId => sessions.history(sessionId),
      continueTurn: sessionId => sessions.continueTurn(sessionId),
      isRecoverable: sessionId => !sessionId.startsWith('__') && !sessionId.startsWith('channel-'),
      log: (kind, message) => log.write(kind, message),
    }).then(resumed => { if (resumed.length) log.write('resume-recovery', `auto-continued ${resumed.length} session(s): ${resumed.join(',')}`); });
  }, 5_000);
  resumeRecoveryTimer.unref();
  early.add(() => clearTimeout(resumeRecoveryTimer));
  if (options.show !== false) show();
  void channels.startConfigured().then(results => { for (const result of results) if (result.ok !== true) log.write('channel-startup', JSON.stringify(result)); }).catch(error => log.write('channel-startup', String(error)));
  log.write('ready', JSON.stringify({ version: app.getVersion(), node: process.versions.node, electron: process.versions.electron, implementedChannels: registry.size() }));
  return {
    window, registry, sessions, engine, browser, canvas, prototype, videoEditing, ppt, digram, model3d, nativeCounts: native.counts,
    show, openMainWindow, focusedMainWindow, runMainWindowCommand, showQuickInput, deliver: (id, channel, value) => delivery.deliver(id, channel, value),
    openDeepLink: url => {
      const action = parseDeepLink(url, edition.protocol);
      if (!action) return;
      show();
      if (action.kind === 'friend') {
        // The friends page island mounts on first show; wait for it to be
        // listening before handing over the scanned-or-clicked invite.
        void deliverToFocusedMain('deep-link:friend-invite', { email: action.email }, notificationNavigation.signal)
          .catch(() => { if (!closing) log.write('deep-link', 'The friend invite link could not be delivered to the main window'); });
        return;
      }
      if (action.kind === 'open') sendToMainWindow(focusedMainWindow(), 'deep-link:open-session', { sessionId: action.sessionId });
      else if (action.kind === 'issue') {
        void deliverToFocusedMain('deep-link:open-team-issue', { projectId: action.projectId, issueId: action.issueId }, notificationNavigation.signal)
          .catch(() => { if (!closing) log.write('deep-link', 'The Issue link could not be delivered to the main window'); });
      }
      else sendToMainWindow(focusedMainWindow(), action.kind === 'new' ? 'tray:new-chat' : 'tray:open-settings');
    },
    shutdown, prepareUpdate,
  };
  } catch (error) {
    invokeLease.close();
    try { await (fullShutdown ? fullShutdown() : early.close()); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Application startup failed and cleanup was incomplete'); }
    throw error;
  }
}
