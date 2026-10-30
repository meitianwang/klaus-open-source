// Feature-discovery copy (upgrade card and walkthroughs).
//
// Kept in its own module and spread into I18N rather than written into
// messages.ts inline: that dictionary is edited by many features at once, and a
// block of ~40 keys sitting at the end of it is a merge magnet. Every key here
// exists in both languages, which the registry test asserts.
//
// Voice: these strings explain a control the user has not found yet. They say
// what the thing does and where it is, in one sentence. They do not congratulate
// the user on discovering it and do not describe the feature as new for longer
// than the release that shipped it.

export const featureOnboardingEn = {
  // --- upgrade card ---
  onb_card_eyebrow: 'New in this release',
  onb_card_eyebrow_version: 'New in {version}',
  onb_card_title: 'What changed',
  onb_card_dismiss: 'Got it',

  // --- walkthrough chrome ---
  onb_tour_step: 'Step {i} of {n}',
  onb_tour_prev: 'Back',
  onb_tour_next: 'Next',
  onb_tour_done: 'Done',
  onb_tour_skip: 'Skip',

  // --- Files panel ---
  onb_workspace_title: 'Files panel',
  onb_workspace_body: 'Browse, preview and open the files in this project. The panel keeps its own tabs, so a file stays open while the conversation moves on.',
  onb_tour_ws_tree_title: 'The file tree',
  onb_tour_ws_tree_body: 'Every folder in the project, local or over SSH. Type to filter by name, use the arrow keys to move, and F2 to rename.',
  onb_tour_ws_preview_title: 'Quick preview',
  onb_tour_ws_preview_body: 'One click previews a file without opening a tab. Double-click pins it, and Markdown, images and PDFs render here.',

  // --- release 0.5 ---
  onb_pets_title: 'Desktop companions',
  onb_pets_body: 'Nine characters that sit on your desktop, show task progress, let you read replies and answer approvals, and take voice input. Configure them in Settings → Pets.',
  onb_file_tree_title: 'Upgraded file tree',
  onb_file_tree_body: 'Filter by name, navigate with the keyboard and rename in place, for local and remote projects alike. Click to preview, double-click to pin a tab, and drag the edge to resize.',
  onb_queue_title: 'Queued messages',
  onb_queue_body: 'Read a queued message in full, drag to reorder, send it now, or move it into a side conversation. Edits keep their images, files and quotes.',
  onb_prediction_title: 'Message prediction',
  onb_prediction_body: 'With a model that supports it, the input box suggests your next message and Tab accepts it. Turn it off in Settings → Preferences.',
  onb_pdf_title: 'PDF skill',
  onb_pdf_body: 'Extract text, inspect pages and build documents, then split, merge or rotate them. The environment it needs is prepared on first use.',
  onb_skills_reload_title: 'Skills update live',
  onb_skills_reload_body: 'Installing, editing or removing a skill takes effect in the current conversation and menu right away, with no restart.',
  onb_hooks_title: 'Hooks manager',
  onb_hooks_body: 'Hooks grouped by user, plugin and project, with their events and commands in one place. Settings → Hooks.',
  onb_power_save_title: 'Keep-awake settings',
  onb_power_save_body: 'Keep the machine awake while a task runs in Settings → Preferences, and while plugged in with remote access enabled in Settings → Remote Control.',

  // --- release 0.6 ---
  onb_prototype_title: 'Prototype design panel',
  onb_prototype_body: 'Interface prototypes generated in chat open in a full editor tab in the right panel. You and the agent edit the same design, with versions, branches, undo/redo and exports, and the design survives app restarts.',
  onb_runtime_config_title: 'Configuration in Preferences',
  onb_runtime_config_body: 'Settings → Preferences → Configuration sets the approval policy, sandbox, network access and reply style for new chats, globally or per project. Auto-review status and rejection reasons appear in chat, with a one-time retry for recently rejected actions.',
  onb_profile_title: 'Profile page',
  onb_profile_body: 'Click your avatar in the sidebar for real usage stats — total tokens, peak usage, longest task and streaks — plus a token activity chart in daily, weekly and cumulative views. Edit your name and avatar there too.',
  onb_multi_window_title: 'Multiple windows and Find',
  onb_multi_window_body: 'Open additional main windows from the menu, each keeping its own drafts and panel layout. Find covers chat, files, changes and browser pages, with match counts, case sensitivity and next/previous navigation.',
  onb_workbuddy_title: 'WorkBuddy editions',
  onb_workbuddy_body: 'The WorkBuddy card under Settings → Model Sources signs in to the domestic or international edition, and can reuse a WorkBuddy sign-in already on this machine. Web sign-in and local import both follow the selected edition.',
  onb_media_events_title: 'Media generation progress',
  onb_media_events_body: 'Image, video, audio and music generation each show a status row in chat with its own icon, from awaiting approval to success, failure or stop. Several generations in one message are grouped together.',
  onb_talking_head_title: 'Talking-head video skill',
  onb_talking_head_body: 'New in the skill marketplace: cut talking-head footage into a video with subtitles, b-roll and a circular picture-in-picture, starting from an existing video, audio plus photos, a script or just an idea. Delivers an editable project and an MP4.',
  onb_pets_voice_title: 'Pet voice upgrades',
  onb_pets_voice_body: "A pet's live voice follows the conversation selected in the main window, and the pet input box gains a dictation mic using your configured voice input source — transcripts land in the draft for editing before sending.",
  onb_settings_search_title: 'Settings search',
  onb_settings_search_body: 'A search box at the top of the settings sidebar jumps to any settings page by name. Switching pages keeps loaded content, autosave stays silent, and voice and music defaults are configured separately.',
} as const

export const featureOnboardingZh = {
  onb_card_eyebrow: '本次更新',
  onb_card_eyebrow_version: '{version} 更新',
  onb_card_title: '有哪些变化',
  onb_card_dismiss: '知道了',

  onb_tour_step: '第 {i} 步，共 {n} 步',
  onb_tour_prev: '上一步',
  onb_tour_next: '下一步',
  onb_tour_done: '完成',
  onb_tour_skip: '跳过',

  onb_workspace_title: '文件面板',
  onb_workspace_body: '浏览、预览和打开这个项目里的文件。面板有自己的标签页，对话往前走时文件也不会被关掉。',
  onb_tour_ws_tree_title: '文件树',
  onb_tour_ws_tree_body: '项目里的全部文件夹，本地和 SSH 远程都可以。输入名称即可筛选，方向键移动，F2 重命名。',
  onb_tour_ws_preview_title: '快速预览',
  onb_tour_ws_preview_body: '单击就能预览文件，不占用标签页；双击固定为标签。Markdown、图片和 PDF 都在这里直接渲染。',

  onb_pets_title: '桌面伙伴',
  onb_pets_body: '九款角色待在桌面上，可以看到任务进度、阅读回复、处理审批与提问，也能语音对话。在设置 → 桌宠里配置。',
  onb_file_tree_title: '文件树升级',
  onb_file_tree_body: '支持按名称筛选、键盘导航和就地重命名，本地与远程项目都可以。单击预览，双击固定标签，拖动边缘调整宽度。',
  onb_queue_title: '排队消息',
  onb_queue_body: '排队消息可以看完整原文、拖动排序、立即发送，或转到侧对话继续。编辑会保留图片、文件与引用。',
  onb_prediction_title: '消息预测',
  onb_prediction_body: '使用支持的模型时，输入框会预测下一条消息，按 Tab 接受。可以在设置 → 偏好设置里关闭。',
  onb_pdf_title: 'PDF 技能',
  onb_pdf_body: '提取文本、查看页面、生成文档，并做拆分、合并和旋转。首次使用时会自动准备所需环境。',
  onb_skills_reload_title: '技能变更即时生效',
  onb_skills_reload_body: '安装、修改或删除技能后，当前会话与技能菜单立刻使用最新内容，不需要重启应用。',
  onb_hooks_title: '钩子管理',
  onb_hooks_body: '钩子按用户、插件和项目分组，事件与命令集中在一处查看和管理。设置 → 钩子。',
  onb_power_save_title: '防休眠设置',
  onb_power_save_body: '任务执行期间保持电脑唤醒在设置 → 偏好设置；接通电源并开启远程访问时保持唤醒在设置 → 远程控制。',

  onb_prototype_title: '界面原型设计面板',
  onb_prototype_body: '聊天里生成的界面原型会在右侧面板的「原型」标签打开完整编辑器：你和智能体编辑同一份设计，支持版本、分支、撤销重做与导出，关闭应用后设计也不会丢失。',
  onb_runtime_config_title: '偏好设置中的配置',
  onb_runtime_config_body: '设置 → 偏好设置 → 配置：为新聊天统一设置批准策略、沙盒、联网与回复风格，支持全局与项目两个范围。自动审批的审核状态与被拒原因在聊天里可见，可对最近被拒的操作批准一次重试。',
  onb_profile_title: '个人资料页',
  onb_profile_body: '点击侧栏头像打开个人资料页，查看累计 Token 数、使用峰值、最长任务与连续天数等真实统计，以及每天 / 每周 / 累计三种视图的 Token 活动图；头像与名称也能在这里编辑。',
  onb_multi_window_title: '多窗口与查找',
  onb_multi_window_body: '通过菜单「新建窗口」打开多个独立主窗口，各自保留草稿与面板布局；「查找」覆盖聊天、文件、更改和浏览器页面，支持匹配计数、大小写与前后导航。',
  onb_workbuddy_title: 'WorkBuddy 双版本登录',
  onb_workbuddy_body: '设置 → 模型来源里的 WorkBuddy 账户卡支持国内版与国际版登录，还可一键复用本机已登录的凭证；网页登录和本机导入都跟随所选版本。',
  onb_media_events_title: '媒体生成进度展示',
  onb_media_events_body: '生成图片、视频、音频和音乐时，聊天里显示带专属图标的状态行，从等待批准到成功、失败或停止一目了然；一条消息里的多次生成会合并为一组。',
  onb_talking_head_title: '口播视频剪辑技能',
  onb_talking_head_body: '技能市场新技能「口播视频剪辑」：把口播素材剪成带字幕、讲解画面和圆形画中画的视频，可从已有视频、音频加照片、文稿或一个想法开始，交付可编辑工程文件与 MP4。',
  onb_pets_voice_title: '桌宠语音升级',
  onb_pets_voice_body: '桌宠的实时语音自动跟随主窗口当前选中的会话；输入框新增听写麦克风，复用你配置的语音输入来源，识别结果先写入草稿，改好再发送。',
  onb_settings_search_title: '设置页搜索',
  onb_settings_search_body: '设置侧栏顶部新增「搜索设置」框，按名称直达任意设置页；切换页面保留已加载内容，自动保存静默完成，语音与音乐的默认模型和偏好分开独立配置。',
} as const
