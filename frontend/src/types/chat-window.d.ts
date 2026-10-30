// chat 域的 window 契约声明（classic-script 时代跨文件全局的类型化固化）。
//
// 这些属性全部由真实代码挂载：bridge/klaus-api.ts 挂 klaus；app/dialog.ts 挂
// klausDialog；各页面岛挂 show/hide 视图钩子；chat.ts 的 module-bridge 段挂
// 会话操作面。声明它们是把既有运行时契约交给 tsc 看管，不是新增全局。
// bridge 方法面此处用宽签名（bridge 自身仍以 any 描述 payload），bridge 的
// 全量类型化随其自身改造推进。
export {}

type AnyFn = (...args: any[]) => any

declare global {
  interface Window {
    // ---- bridge（bridge/klaus-api.ts expose('klaus', ...)） ----
    klaus: Record<string, any>

    // ---- app 层共享（dialog/toast/i18n/select） ----
    klausDialog: {
      alert(msg: unknown, extra?: Record<string, unknown>): Promise<void>
      confirm(opts: unknown, extra?: Record<string, unknown>): Promise<any>  // 多态：checkbox 时返回 { confirmed, checked }
      prompt?(opts: unknown): Promise<string | null>
    }
    showToast?: AnyFn
    currentLang?: string
    applyI18n?: () => void
    setLanguage?: (lang: string) => void
    getLang?: () => string
    klsSelect?: { bind: (root: HTMLElement | null, opts?: Record<string, unknown>) => import('../app/ui-select').SelectApi }
    KlausFollowUp?: Record<string, AnyFn>
    tt?: (key: string) => string

    // ---- 会话全局面（chat.ts module-bridge 挂载） ----
    currentSessionId: string | null
    getCurrentSessionId?: () => string | null
    isSessionRunning?: (sessionId?: string | null) => boolean
    switchSession?: (sessionId: string) => Promise<void> | void
    deleteSession?: AnyFn
    updateSessionInList?: AnyFn
    sessionDisplayTitle?: AnyFn
    listArchivedSessions?: AnyFn
    getKnownSessionInfo?: AnyFn
    /** 插件页装/卸/启停后调：`@` 提及候选按 installed && enabled 重算。 */
    invalidatePluginMentionCache?: () => void
    /** 设置面板改名/移除设备后调：`@` 提及的设备组立刻反映新名字/移除，不等 staleTime。 */
    invalidateDeviceMentionCache?: () => void
    klausForkSession?: AnyFn
    klausSwitchSession?: AnyFn

    // ---- 页面岛视图钩子（pages/* 挂载；possibly undefined：岛按需装配） ----
    showCronView?: () => void
    hideCronView?: () => void
    showMcpView?: () => void
    hideMcpView?: () => void
    showSkillsView?: () => void
    hideSkillsView?: () => void
    showPluginsView?: () => void
    hidePluginsView?: () => void
    showAgentsView?: () => void
    hideAgentsView?: () => void
    showChannelsView?: () => void
    hideChannelsView?: () => void
    showMemoryView?: () => void
    hideMemoryView?: () => void
    showFriendsView?: () => void
    hideFriendsView?: () => void
    showSlashCommandsView?: () => void
    hideSlashCommandsView?: () => void
    showDiffView?: AnyFn
    hideDiffView?: () => void
    isDiffViewActive?: () => boolean
    deactivateDiffView?: () => void
    reloadMcpView?: AnyFn
    openProjectMcpModal?: AnyFn
    showSettingsView?: AnyFn
    openSettings?: AnyFn

    // ---- workspace / artifacts / panel（workspace-panel.ts 与 chat.ts 挂载） ----
    hideWorkspaceMainView?: () => void
    showWorkspaceMainView?: (opts?: { openPanel?: boolean }) => void
    isWorkspaceMainViewActive?: () => boolean
    openArtifactsPanel?: (mode?: string) => void
    closeArtifactsPanel?: () => void
    syncArtifactsToggleVisibility?: () => void
    enterDiffArtifactsPanel?: AnyFn
    exitDiffArtifactsPanel?: AnyFn
    klausOpenMonitorPanel?: () => void
    klausOpenDiffPanel?: () => void
    klausCloseDiffPanel?: () => void
    klausOnArtifactsLayoutChange?: () => void
    klausActivateCanvasPanel?: AnyFn
    klausHideCanvasPanel?: () => Promise<void> | void
    klausCloseCanvasPanel?: AnyFn
    klausActiveCanvasPath?: () => string
    klausSuspendCanvasForOverlay?: () => Promise<void>
    klausResumeCanvasAfterOverlay?: () => Promise<void>
    klausActivatePrototypePanel?: AnyFn
    klausOpenPrototypePanel?: (id: string, sessionId?: string) => Promise<boolean>
    klausHidePrototypePanel?: () => Promise<void>
    klausClosePrototypePanel?: AnyFn
    klausActivePrototypeId?: () => string
    klausSuspendPrototypeForOverlay?: () => Promise<void>
    klausResumePrototypeAfterOverlay?: () => Promise<void>
    klausActivateVideoEditingPanel?: AnyFn
    klausOpenVideoEditingPanel?: (id: string, sessionId?: string) => Promise<boolean>
    klausHideVideoEditingPanel?: () => Promise<void>
    klausCloseVideoEditingPanel?: AnyFn
    klausActiveVideoEditingId?: () => string
    klausSuspendVideoEditingForOverlay?: () => Promise<void>
    klausResumeVideoEditingAfterOverlay?: () => Promise<void>
    klausActivatePptPanel?: AnyFn
    klausOpenPptPanel?: (id: string, sessionId?: string) => Promise<boolean>
    klausHidePptPanel?: () => Promise<void>
    klausClosePptPanel?: AnyFn
    klausActivePptId?: () => string
    klausSuspendPptForOverlay?: () => Promise<void>
    klausResumePptAfterOverlay?: () => Promise<void>
    KlausPanelTabs?: Record<string, AnyFn>
    KlausSideTasks?: Record<string, AnyFn>
    KlausSubagentPanel?: Record<string, AnyFn>
    KlausBackgroundProcessPanel?: Record<string, AnyFn>
    KlausTurnNavigation?: Record<string, AnyFn>
    klausSearch?: Record<string, AnyFn>
    appearanceThemeOptions?: AnyFn

    // ---- terminal / browser（模块挂载的 panel-strip 钩子） ----
    klausNewTerminal?: () => Promise<void> | void
    klausShowTerminalPanel?: () => void
    klausCloseTerminalPanel?: () => void
    showBrowserPanel?: () => Promise<void>
    hideBrowserPanel?: () => Promise<void>
    isBrowserPanelVisible?: () => boolean
    klausActiveBrowserTabId?: () => string | null
    klausOpenBrowserTab?: AnyFn
    klausNewBrowserTab?: AnyFn
    klausCloseBrowserTab?: AnyFn
    klausSuspendBrowserForOverlay?: () => Promise<void>
    klausResumeBrowserAfterOverlay?: () => Promise<void>

    // ---- composer / spec / cron / misc（chat.ts 与组件互挂） ----
    klausComposer?: Record<string, AnyFn>
    klausSlashCommandI18n?: Record<string, AnyFn>
    renderSlashPillHtml?: AnyFn
    renderWorkspaceMentionPillHtml?: AnyFn
    renderComposerReferencePillHtml?: AnyFn
    setComposerText?: AnyFn
    maybeShowExternalImportForProject?: AnyFn
    openSshConnectModal?: AnyFn
    submitSpecAnnotations?: AnyFn
    setAppearanceThemeChoice?: AnyFn
    getSessionGoalSnapshot?: AnyFn
    getSpecExecutionPath?: AnyFn
    openSpecAnnotation?: AnyFn
    openSpecPanel?: AnyFn
    klausActivateSpecPanel?: AnyFn
    klausCloseSpecPanel?: AnyFn
    klausActiveSpecPath?: AnyFn
    attachSpecAnnotating?: AnyFn
    surfaceCronRunInSidebar?: AnyFn
    refreshCronSidebar?: AnyFn
    refreshComposerPreferences?: AnyFn
    refreshSideModelButton?: AnyFn
    refreshPermissionButton?: AnyFn
    refreshSidePermissionButton?: AnyFn
    klausSideSurfaceActivate?: AnyFn
    klausSideSurfaceClear?: AnyFn
    klausSideSurfaceRemove?: AnyFn
    klausSideSurfaceSessionId?: () => string | null
    klausStopVoiceChatForSession?: (sessionId: string) => Promise<void>
    /** 选区引用浮层（transcript/quote-selection.tsx）：主转录选中 → 主 composer。 */
    klausQuoteAddToChat?: (text: string, requestOffset?: number) => void
    klausPastedTextAddToChat?: (text: string, reference?: { path?: string; preview?: string; characterCount?: number }) => void
    klausDisplayCardsAddToChat?: (selectedTextAttachments: unknown[], pastedCards: unknown[]) => void
    /**
     * Put a sent user message back into the main composer for editing. The transcript's
     * click/double-click delegate calls this; chat.ts owns the composer refill, the send
     * routing (truncate-and-rerun) and the in-flight state. `handle` addresses the target
     * by uuid, or by turn id for the optimistic bubble a stopped turn leaves behind (the
     * engine assigns the uuid and never reports it). A no-op when no main composer is
     * mounted, which is where Edit is not offered anyway.
     */
    klausEditSentMessageInComposer?: (sessionId: string, handle: { uuid: string; turnId: string }) => void
    restoreRewoundMessage?: (sessionId: string, draft: import('../chat/composer/sent-message-edit').RestoredMessageDraft) => Promise<void>
    /** 选区引用浮层：侧任务转录选中 → 侧任务 composer。 */
    klausSideComposerAddSelection?: (text: string) => void
    openImagePreview?: AnyFn
    klausOpenWorkspaceImageTab?: AnyFn
    klausOpenExternalUrl?: (url: string) => Promise<unknown>
    klausOpenBackgroundProcess?: (shellId: string, sessionId?: string) => Promise<void> | void
    klausUpdateUpgradeMenuForSubscription?: AnyFn
    loadPreferences?: () => Promise<void>
    bootstrapProfile?: () => Promise<void>
    seedIdentityKv?: AnyFn
    maybeShowExternalAgentImportOnboarding?: AnyFn
    ensureAppearancePreferences?: AnyFn
    resolveAppearanceVariant?: AnyFn
    setAppearanceCodeTheme?: (variant: unknown, paletteId: string | undefined) => Promise<unknown>
    setAppearanceFontSize?: (field: string | undefined, value: number) => Promise<unknown>
    KLAUS_APPEARANCE_FONT_FIELDS?: Record<string, { min: number; max: number }>
    untrackApprovalRequest?: AnyFn
    escapeHtml?: (str: unknown) => string
    KlausRendererProductContracts: Record<string, AnyFn>
    COMPOSER_PLUS_ICONS?: Record<string, string>
    SPEC_PANEL_ICON?: string
  }
}
