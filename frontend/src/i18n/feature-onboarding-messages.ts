// Feature-discovery copy (post-upgrade guide and walkthroughs).
//
// Kept in its own module and spread into I18N rather than written into
// messages.ts inline: that dictionary is edited by many features at once, and a
// block of ~40 keys sitting at the end of it is a merge magnet. Every key here
// exists in both languages, which the registry test asserts.
//
// Voice: the guide introduces what the release changed and where it lives, one
// page per theme. Pages say what the thing does and where to find it; they do
// not congratulate the user and do not call a feature new for longer than the
// release that shipped it. Walkthrough strings explain a control the user has
// not found yet, in one sentence.

export const featureOnboardingEn = {
  // --- post-upgrade guide: page 1 (overview) ---
  onb_g1_eyebrow: 'New in 0.7',
  onb_g1_title_1: 'Long tasks answer',
  onb_g1_title_2: 'while they still run',
  onb_g1_emphasis: 'while they still run',
  onb_g1_desc: 'A long task now shows the reply it has already written, live in the conversation, instead of waiting for one final block. If the stream drops, it resumes from the break — what was generated stays.',

  // --- page 2 (collaboration) ---
  onb_g2_eyebrow: 'Sub-agent square',
  onb_g2_title_1: 'Browse official sub-agents',
  onb_g2_title_2: 'and delegate in one click',
  onb_g2_emphasis: 'delegate in one click',
  onb_g2_desc: 'The Agents page gained a sub-agent square: official sub-agents ship with the release, install in one click, and can be delegated inside a task. Their progress and result come back to the conversation that asked.',

  // --- page 3 (cocreation) ---
  onb_g3_eyebrow: 'Interface prototypes',
  onb_g3_title_1: 'You and the agent edit',
  onb_g3_title_2: 'the same design',
  onb_g3_emphasis: 'the same design',
  onb_g3_desc: 'A prototype generated in chat opens as a full editor tab in the right panel, with versions, branches, undo and exports. Both sides edit one file, and it survives an app restart.',

  // --- page 4 (automation) ---
  onb_g4_eyebrow: 'Layout and windows',
  onb_g4_title_1: 'Drag the sidebar to width;',
  onb_g4_title_2: 'the chat keeps its room',
  onb_g4_emphasis: 'keeps its room',
  onb_g4_desc: 'The left sidebar drags to any width and double-click resets it; the work panel scales with the window. With both open the conversation keeps a readable column, and a narrowing window folds panels instead of squeezing the chat.',

  // --- guide chrome ---
  onb_guide_dialog_title: "What's new in this release",
  onb_guide_next: 'Next',
  onb_guide_previous: 'Previous',
  onb_guide_skip: 'Skip',
  onb_guide_choose_reading: 'Choose how you read',
  onb_guide_start: 'Start using Klaus',
  onb_guide_comfortable: 'Comfortable',
  onb_guide_efficient: 'Compact',
  onb_guide_comfortable_hint: 'Default column and rhythm, easy on long reads',
  onb_guide_efficient_hint: 'Wider conversation column, more of a reply per screen',
  onb_guide_start_title: 'Start using Klaus',
  onb_guide_reading_desc_comfortable: 'Comfortable keeps the shipped column width and spacing.',
  onb_guide_reading_desc_efficient: 'Compact widens the conversation column and tightens its vertical rhythm.',
  onb_guide_page_announce: '{i} of {n}: {label}',
  onb_guide_play: 'Play the page animation',
  onb_guide_pause: 'Pause the page animation',

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
} as const

export const featureOnboardingZh = {
  onb_g1_eyebrow: '0.7 全新上线',
  onb_g1_title_1: '长任务的阶段性答复',
  onb_g1_title_2: '执行中途就能读',
  onb_g1_emphasis: '执行中途就能读',
  onb_g1_desc: '长任务执行时，模型已经写出的内容会实时显示在会话里，不必等整段最终回复；流式回复遇到网络故障时从断点继续，已生成的部分不再重来。',

  onb_g2_eyebrow: '子智能体广场',
  onb_g2_title_1: '浏览官方子智能体',
  onb_g2_title_2: '一键安装即可委派',
  onb_g2_emphasis: '一键安装即可委派',
  onb_g2_desc: '智能体页新增「子智能体广场」标签，官方子智能体随版本上架，一键安装后即可在任务中委派使用，进度与结果回到发起的会话。',

  onb_g3_eyebrow: '界面原型',
  onb_g3_title_1: '和智能体编辑',
  onb_g3_title_2: '同一份设计',
  onb_g3_emphasis: '同一份设计',
  onb_g3_desc: '聊天里生成的界面原型会在右侧面板打开完整编辑器，版本、分支、撤销重做与导出齐备；你和智能体改的是同一份文件，关闭应用后也不会丢失。',

  onb_g4_eyebrow: '布局与窗口',
  onb_g4_title_1: '侧栏宽度随手拖',
  onb_g4_title_2: '对话区不再被挤窄',
  onb_g4_emphasis: '不再被挤窄',
  onb_g4_desc: '左侧栏可拖拽调宽、双击复位，右侧工作面板随窗口等比缩放；双栏同开时主会话保持可读宽度，窗口变窄自动收敛面板，而不是挤压对话。',

  onb_guide_dialog_title: '本次更新',
  onb_guide_next: '下一页',
  onb_guide_previous: '上一页',
  onb_guide_skip: '跳过',
  onb_guide_choose_reading: '选择阅读方式',
  onb_guide_start: '开始使用',
  onb_guide_comfortable: '舒适',
  onb_guide_efficient: '高效',
  onb_guide_comfortable_hint: '默认列宽与行距，长文阅读轻松',
  onb_guide_efficient_hint: '更宽的对话列，一屏看到更多回复',
  onb_guide_start_title: '开始使用 Klaus',
  onb_guide_reading_desc_comfortable: '舒适模式保持默认的列宽与行距。',
  onb_guide_reading_desc_efficient: '高效模式加宽对话列并收紧行距。',
  onb_guide_page_announce: '第 {i} 页，共 {n} 页：{label}',
  onb_guide_play: '播放本页动画',
  onb_guide_pause: '暂停本页动画',

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
} as const
