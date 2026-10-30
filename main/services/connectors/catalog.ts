// Display metadata only; runtime tool effects come from the serving capability.
import type { JsonObject } from "../service-types";

export interface ConnectorCatalogEntry extends JsonObject { id: string; platform: string; tools: JsonObject[] }
export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    "id": "macos-reminders",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "提醒事项",
    "nameEn": "Reminders",
    "descZh": "读取和管理你的提醒事项和任务列表",
    "descEn": "Read and manage your reminders and task lists",
    "icon": "📋",
    "tools": [
      {
        "name": "list_reminders",
        "labelZh": "列出提醒事项",
        "labelEn": "List reminders",
        "descZh": "列出指定列表的提醒事项（或所有列表）",
        "descEn": "List reminders in a list (or all lists)"
      },
      {
        "name": "search_reminders",
        "labelZh": "搜索提醒",
        "labelEn": "Search reminders",
        "descZh": "按关键字搜索提醒事项",
        "descEn": "Search reminders by keyword"
      },
      {
        "name": "list_reminder_lists",
        "labelZh": "列出提醒列表",
        "labelEn": "List reminder lists",
        "descZh": "列出所有提醒事项列表",
        "descEn": "List all reminder lists"
      },
      {
        "name": "create_reminder",
        "labelZh": "创建提醒",
        "labelEn": "Create reminder",
        "descZh": "创建新的提醒事项",
        "descEn": "Create a new reminder"
      },
      {
        "name": "update_reminder",
        "labelZh": "更新提醒",
        "labelEn": "Update reminder",
        "descZh": "修改提醒的标题、到期时间、备注或优先级",
        "descEn": "Update reminder title / due / body / priority"
      },
      {
        "name": "complete_reminder",
        "labelZh": "完成提醒",
        "labelEn": "Complete reminder",
        "descZh": "将提醒事项标记为已完成",
        "descEn": "Mark a reminder as completed"
      },
      {
        "name": "delete_reminder",
        "labelZh": "删除提醒",
        "labelEn": "Delete reminder",
        "descZh": "删除提醒事项",
        "descEn": "Delete a reminder"
      },
      {
        "name": "create_reminder_list",
        "labelZh": "创建提醒列表",
        "labelEn": "Create reminder list",
        "descZh": "创建新的提醒事项列表",
        "descEn": "Create a new reminder list"
      },
      {
        "name": "delete_reminder_list",
        "labelZh": "删除提醒列表",
        "labelEn": "Delete reminder list",
        "descZh": "删除提醒事项列表（及其中所有提醒）",
        "descEn": "Delete a reminder list (and its reminders)"
      }
    ]
  },
  {
    "id": "macos-calendar",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "日历",
    "nameEn": "Calendar",
    "descZh": "读取和管理你的日历事件",
    "descEn": "Read and manage your calendar events",
    "icon": "📅",
    "tools": [
      {
        "name": "list_events",
        "labelZh": "列出日历事件",
        "labelEn": "List events",
        "descZh": "列出指定时间段内的日历事件",
        "descEn": "List calendar events in a date range"
      },
      {
        "name": "search_events",
        "labelZh": "搜索事件",
        "labelEn": "Search events",
        "descZh": "按关键字搜索日历事件",
        "descEn": "Search calendar events by keyword"
      },
      {
        "name": "get_event",
        "labelZh": "读取事件",
        "labelEn": "Get event",
        "descZh": "获取单个事件的完整详情",
        "descEn": "Get full details of a single event"
      },
      {
        "name": "list_calendars",
        "labelZh": "列出日历",
        "labelEn": "List calendars",
        "descZh": "列出所有日历（含名称、账号）",
        "descEn": "List all calendars with account info"
      },
      {
        "name": "create_event",
        "labelZh": "创建事件",
        "labelEn": "Create event",
        "descZh": "创建新的日历事件",
        "descEn": "Create a new calendar event"
      },
      {
        "name": "update_event",
        "labelZh": "更新事件",
        "labelEn": "Update event",
        "descZh": "修改事件标题、时间、地点、备注",
        "descEn": "Update event title / time / location / notes"
      },
      {
        "name": "delete_event",
        "labelZh": "删除事件",
        "labelEn": "Delete event",
        "descZh": "删除日历事件",
        "descEn": "Delete a calendar event"
      }
    ]
  },
  {
    "id": "macos-notes",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "备忘录",
    "nameEn": "Notes",
    "descZh": "读取和创建你的备忘录",
    "descEn": "Read and create your notes",
    "icon": "📝",
    "tools": [
      {
        "name": "list_notes",
        "labelZh": "列出备忘录",
        "labelEn": "List notes",
        "descZh": "列出备忘录（可按文件夹过滤）",
        "descEn": "List notes (optionally filter by folder)"
      },
      {
        "name": "search_notes",
        "labelZh": "搜索备忘录",
        "labelEn": "Search notes",
        "descZh": "按关键字搜索备忘录",
        "descEn": "Search notes by keyword"
      },
      {
        "name": "read_note",
        "labelZh": "读取备忘录",
        "labelEn": "Read note",
        "descZh": "读取指定备忘录的内容",
        "descEn": "Read the content of a specific note"
      },
      {
        "name": "list_folders",
        "labelZh": "列出文件夹",
        "labelEn": "List folders",
        "descZh": "列出备忘录所有文件夹（含嵌套）",
        "descEn": "List all Notes folders (including nested)"
      },
      {
        "name": "list_attachments",
        "labelZh": "列出附件",
        "labelEn": "List attachments",
        "descZh": "列出指定备忘录的附件信息",
        "descEn": "List attachments of a given note"
      },
      {
        "name": "create_note",
        "labelZh": "创建备忘录",
        "labelEn": "Create note",
        "descZh": "创建新的备忘录",
        "descEn": "Create a new note"
      },
      {
        "name": "update_note",
        "labelZh": "更新备忘录",
        "labelEn": "Update note",
        "descZh": "修改备忘录的标题、正文，或移动到其他文件夹",
        "descEn": "Update note title/body, or move to another folder"
      },
      {
        "name": "append_to_note",
        "labelZh": "追加内容",
        "labelEn": "Append to note",
        "descZh": "在备忘录末尾追加内容（不覆盖正文）",
        "descEn": "Append content to an existing note"
      },
      {
        "name": "delete_note",
        "labelZh": "删除备忘录",
        "labelEn": "Delete note",
        "descZh": "删除指定的备忘录",
        "descEn": "Delete a specific note"
      },
      {
        "name": "create_folder",
        "labelZh": "创建文件夹",
        "labelEn": "Create folder",
        "descZh": "创建新的备忘录文件夹",
        "descEn": "Create a new Notes folder"
      },
      {
        "name": "rename_folder",
        "labelZh": "重命名文件夹",
        "labelEn": "Rename folder",
        "descZh": "重命名备忘录文件夹",
        "descEn": "Rename a Notes folder"
      },
      {
        "name": "delete_folder",
        "labelZh": "删除文件夹",
        "labelEn": "Delete folder",
        "descZh": "删除文件夹（及里面的所有备忘录）",
        "descEn": "Delete a folder (and all its notes)"
      },
      {
        "name": "save_attachment",
        "labelZh": "导出附件",
        "labelEn": "Save attachment",
        "descZh": "把指定备忘录的某个附件保存到本地",
        "descEn": "Save a note attachment to a local path"
      }
    ]
  },
  {
    "id": "macos-mail",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "邮件",
    "nameEn": "Mail",
    "descZh": "读取邮件和创建草稿",
    "descEn": "Read mail and create drafts",
    "icon": "✉️",
    "tools": [
      {
        "name": "list_mailboxes",
        "labelZh": "列出邮箱",
        "labelEn": "List mailboxes",
        "descZh": "列出所有邮箱",
        "descEn": "List all mailboxes"
      },
      {
        "name": "search_messages",
        "labelZh": "搜索邮件",
        "labelEn": "Search messages",
        "descZh": "按关键字搜索邮件",
        "descEn": "Search mail messages"
      },
      {
        "name": "read_message",
        "labelZh": "读取邮件",
        "labelEn": "Read message",
        "descZh": "读取指定邮件内容",
        "descEn": "Read a specific message body"
      },
      {
        "name": "create_draft",
        "labelZh": "创建草稿",
        "labelEn": "Create draft",
        "descZh": "创建邮件草稿",
        "descEn": "Create a mail draft"
      },
      {
        "name": "send_message",
        "labelZh": "发送邮件",
        "labelEn": "Send message",
        "descZh": "直接发送一封邮件（跳过草稿）",
        "descEn": "Send an email directly (no draft step)"
      },
      {
        "name": "mark_read",
        "labelZh": "标记已读",
        "labelEn": "Mark read",
        "descZh": "将指定邮件标记为已读或未读",
        "descEn": "Mark a message as read or unread"
      },
      {
        "name": "move_message",
        "labelZh": "移动邮件",
        "labelEn": "Move message",
        "descZh": "把邮件移动到另一个邮箱",
        "descEn": "Move a message to a different mailbox"
      },
      {
        "name": "delete_message",
        "labelZh": "删除邮件",
        "labelEn": "Delete message",
        "descZh": "删除邮件（移到垃圾箱）",
        "descEn": "Delete a message (moves to Trash)"
      }
    ]
  },
  {
    "id": "macos-contacts",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "通讯录",
    "nameEn": "Contacts",
    "descZh": "搜索、读取和创建联系人",
    "descEn": "Search, read and create contacts",
    "icon": "👤",
    "tools": [
      {
        "name": "search_contacts",
        "labelZh": "搜索联系人",
        "labelEn": "Search contacts",
        "descZh": "按关键字搜索联系人",
        "descEn": "Search contacts by keyword"
      },
      {
        "name": "read_contact",
        "labelZh": "读取联系人",
        "labelEn": "Read contact",
        "descZh": "读取联系人详细信息",
        "descEn": "Read contact details"
      },
      {
        "name": "list_groups",
        "labelZh": "列出分组",
        "labelEn": "List groups",
        "descZh": "列出通讯录所有分组",
        "descEn": "List all contact groups"
      },
      {
        "name": "create_contact",
        "labelZh": "创建联系人",
        "labelEn": "Create contact",
        "descZh": "创建新联系人",
        "descEn": "Create a new contact"
      },
      {
        "name": "update_contact",
        "labelZh": "更新联系人",
        "labelEn": "Update contact",
        "descZh": "修改联系人姓名、电话、邮箱等",
        "descEn": "Update contact name, phone, email..."
      },
      {
        "name": "delete_contact",
        "labelZh": "删除联系人",
        "labelEn": "Delete contact",
        "descZh": "删除联系人",
        "descEn": "Delete a contact"
      }
    ]
  },
  {
    "id": "macos-messages",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "信息",
    "nameEn": "Messages",
    "descZh": "读取和发送 iMessage / 短信",
    "descEn": "Read and send iMessage / SMS",
    "icon": "💬",
    "tools": [
      {
        "name": "list_recent_conversations",
        "labelZh": "最近会话",
        "labelEn": "Recent conversations",
        "descZh": "列出最近的会话（按最后一条消息时间排序）",
        "descEn": "List recent conversations ordered by last message"
      },
      {
        "name": "read_conversation",
        "labelZh": "读取会话",
        "labelEn": "Read conversation",
        "descZh": "读取指定联系人的最近消息",
        "descEn": "Read recent messages with a contact"
      },
      {
        "name": "search_messages",
        "labelZh": "搜索消息",
        "labelEn": "Search messages",
        "descZh": "跨所有会话全局搜索消息正文",
        "descEn": "Global full-text search across all conversations"
      },
      {
        "name": "send_message",
        "labelZh": "发送消息",
        "labelEn": "Send message",
        "descZh": "发送 iMessage 到指定手机号/邮箱/联系人",
        "descEn": "Send iMessage to phone / email / buddy"
      }
    ]
  },
  {
    "id": "macos-safari",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "Safari 浏览器",
    "nameEn": "Safari",
    "descZh": "读取 Safari 标签页、页面内容，打开网址",
    "descEn": "Read Safari tabs, page content, open URLs",
    "icon": "🧭",
    "tools": [
      {
        "name": "list_tabs",
        "labelZh": "列出标签页",
        "labelEn": "List tabs",
        "descZh": "列出所有窗口和标签页",
        "descEn": "List all windows and tabs"
      },
      {
        "name": "get_active_tab",
        "labelZh": "当前标签页",
        "labelEn": "Active tab",
        "descZh": "获取当前活动标签页 URL、标题、选中文本",
        "descEn": "Get active tab URL, title and selection"
      },
      {
        "name": "read_tab",
        "labelZh": "读取页面内容",
        "labelEn": "Read page",
        "descZh": "读取指定标签页的纯文本正文",
        "descEn": "Read plain-text body of a tab"
      },
      {
        "name": "list_bookmarks",
        "labelZh": "列出书签",
        "labelEn": "List bookmarks",
        "descZh": "列出 Safari 书签（按文件夹层级）",
        "descEn": "List Safari bookmarks (folder hierarchy)"
      },
      {
        "name": "list_history",
        "labelZh": "列出浏览历史",
        "labelEn": "List history",
        "descZh": "列出最近浏览历史（按时间倒序）",
        "descEn": "List recent browsing history (newest first)"
      },
      {
        "name": "open_url",
        "labelZh": "打开网址",
        "labelEn": "Open URL",
        "descZh": "在新标签页或当前标签页打开 URL",
        "descEn": "Open a URL in a new or current tab"
      },
      {
        "name": "switch_to_tab",
        "labelZh": "切换标签页",
        "labelEn": "Switch to tab",
        "descZh": "切换到指定窗口/标签页并激活",
        "descEn": "Switch to a specific window/tab and activate"
      },
      {
        "name": "close_tab",
        "labelZh": "关闭标签页",
        "labelEn": "Close tab",
        "descZh": "关闭指定标签页",
        "descEn": "Close a specific tab"
      }
    ]
  },
  {
    "id": "macos-shortcuts",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "快捷指令",
    "nameEn": "Shortcuts",
    "descZh": "列出并执行你定义的 Shortcut（macOS 12+）",
    "descEn": "List and run your user-defined Shortcuts (macOS 12+)",
    "icon": "⚡",
    "tools": [
      {
        "name": "list_shortcuts",
        "labelZh": "列出快捷指令",
        "labelEn": "List shortcuts",
        "descZh": "列出所有已安装的快捷指令",
        "descEn": "List all installed Shortcuts"
      },
      {
        "name": "run_shortcut",
        "labelZh": "运行快捷指令",
        "labelEn": "Run shortcut",
        "descZh": "运行指定快捷指令，可传入文本参数",
        "descEn": "Run a shortcut, optionally with text input"
      }
    ]
  },
  {
    "id": "macos-finder",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "访达",
    "nameEn": "Finder",
    "descZh": "读取 Finder 选中项、标签，移动到废纸篓",
    "descEn": "Read Finder selection, tags; move to Trash",
    "icon": "🗂",
    "tools": [
      {
        "name": "get_selection",
        "labelZh": "当前选中项",
        "labelEn": "Current selection",
        "descZh": "读取 Finder 当前选中的文件/文件夹路径",
        "descEn": "Read paths of currently-selected Finder items"
      },
      {
        "name": "get_tags",
        "labelZh": "读取标签",
        "labelEn": "Get tags",
        "descZh": "读取指定路径的 Finder 标签",
        "descEn": "Read Finder tags on a given path"
      },
      {
        "name": "get_comment",
        "labelZh": "读取注释",
        "labelEn": "Get comment",
        "descZh": "读取 Finder 注释（Spotlight comment）",
        "descEn": "Read Finder comment (Spotlight comment)"
      },
      {
        "name": "get_file_info",
        "labelZh": "文件信息",
        "labelEn": "File info",
        "descZh": "读取文件大小、类型、创建/修改时间",
        "descEn": "Read file size, kind, created / modified dates"
      },
      {
        "name": "list_folder",
        "labelZh": "列出文件夹",
        "labelEn": "List folder",
        "descZh": "列出文件夹内容（含 Finder 标签/注释等元数据）",
        "descEn": "List folder contents with Finder tags / comments"
      },
      {
        "name": "reveal_file",
        "labelZh": "显示文件",
        "labelEn": "Reveal file",
        "descZh": "在 Finder 中打开并高亮指定路径",
        "descEn": "Open Finder and highlight the given path"
      },
      {
        "name": "open_file",
        "labelZh": "打开文件",
        "labelEn": "Open file",
        "descZh": "用默认应用打开文件",
        "descEn": "Open file with its default application"
      },
      {
        "name": "set_tags",
        "labelZh": "设置标签",
        "labelEn": "Set tags",
        "descZh": "设置/替换指定路径的 Finder 标签",
        "descEn": "Set or replace Finder tags on a path"
      },
      {
        "name": "set_comment",
        "labelZh": "设置注释",
        "labelEn": "Set comment",
        "descZh": "设置 Finder 注释",
        "descEn": "Set Finder comment"
      },
      {
        "name": "move_to_trash",
        "labelZh": "移到废纸篓",
        "labelEn": "Move to Trash",
        "descZh": "将指定路径移到废纸篓（可恢复）",
        "descEn": "Move a path to the Trash (recoverable)"
      }
    ]
  },
  {
    "id": "macos-photos",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "照片",
    "nameEn": "Photos",
    "descZh": "读取、整理、编辑和操作 macOS 系统照片图库",
    "descEn": "Read, organize, edit, and operate the macOS Photos library",
    "icon": "🖼",
    "tools": [
      {
        "name": "photos_check_permission",
        "labelZh": "检查授权",
        "labelEn": "Check permission",
        "descZh": "检查照片、自动化和辅助功能授权状态",
        "descEn": "Check Photos, Automation, and Accessibility availability"
      },
      {
        "name": "photos_request_permission",
        "labelZh": "请求授权",
        "labelEn": "Request permission",
        "descZh": "打开照片 App 以触发系统授权流程",
        "descEn": "Open Photos.app to trigger macOS permission prompts"
      },
      {
        "name": "photos_prepare_icloud_sync",
        "labelZh": "iCloud 同步",
        "labelEn": "iCloud sync",
        "descZh": "打开照片 iCloud 设置并引导用户开启 iCloud 照片或下载原片",
        "descEn": "Open Photos iCloud settings and guide the user through iCloud Photos or original downloads"
      },
      {
        "name": "photos_list_libraries",
        "labelZh": "列出图库",
        "labelEn": "List libraries",
        "descZh": "查找本机 .photoslibrary 照片图库",
        "descEn": "Find local .photoslibrary bundles"
      },
      {
        "name": "photos_open_library",
        "labelZh": "打开图库",
        "labelEn": "Open library",
        "descZh": "打开或切换到指定照片图库",
        "descEn": "Open or switch to a specific Photos library"
      },
      {
        "name": "photos_get_current_library",
        "labelZh": "当前图库",
        "labelEn": "Current library",
        "descZh": "读取当前照片 App / 图库状态",
        "descEn": "Read current Photos.app/library state"
      },
      {
        "name": "photos_get_library_summary",
        "labelZh": "图库统计",
        "labelEn": "Library summary",
        "descZh": "统计当前照片图库的媒体、收藏、相册和文件夹数量",
        "descEn": "Count media, favorites, albums, and folders in the current Photos library"
      },
      {
        "name": "photos_reveal_in_app",
        "labelZh": "在照片中显示",
        "labelEn": "Reveal in Photos",
        "descZh": "在照片 App 中显示资源或相册",
        "descEn": "Reveal an asset or container in Photos.app"
      },
      {
        "name": "photos_list_albums",
        "labelZh": "列出相册",
        "labelEn": "List albums",
        "descZh": "列出相册、文件夹和可见集合",
        "descEn": "List albums, folders, and visible containers"
      },
      {
        "name": "photos_list_assets",
        "labelZh": "列出照片",
        "labelEn": "List assets",
        "descZh": "列出照片/视频资源和元数据",
        "descEn": "List photo/video assets and metadata"
      },
      {
        "name": "photos_get_asset",
        "labelZh": "读取照片",
        "labelEn": "Get asset",
        "descZh": "读取单个照片/视频的完整元数据",
        "descEn": "Read full metadata for one asset"
      },
      {
        "name": "photos_get_selection",
        "labelZh": "当前选择",
        "labelEn": "Get selection",
        "descZh": "读取照片 App 当前选中的资源",
        "descEn": "Read currently selected Photos.app media items"
      },
      {
        "name": "photos_search",
        "labelZh": "搜索照片",
        "labelEn": "Search Photos",
        "descZh": "使用照片 App 搜索能力查找资源",
        "descEn": "Search assets using Photos.app search"
      },
      {
        "name": "photos_export_preview",
        "labelZh": "导出预览",
        "labelEn": "Export preview",
        "descZh": "导出低风险渲染预览供 Klaus 查看",
        "descEn": "Export rendered previews for inspection"
      },
      {
        "name": "photos_import_files",
        "labelZh": "导入文件",
        "labelEn": "Import files",
        "descZh": "导入图片或视频文件到照片图库",
        "descEn": "Import image/video files into Photos"
      },
      {
        "name": "photos_import_folder",
        "labelZh": "导入文件夹",
        "labelEn": "Import folder",
        "descZh": "从文件夹批量导入媒体文件",
        "descEn": "Bulk import media files from a folder"
      },
      {
        "name": "photos_export_assets",
        "labelZh": "导出资源",
        "labelEn": "Export assets",
        "descZh": "导出原图或渲染版本到本地目录",
        "descEn": "Export originals or rendered versions"
      },
      {
        "name": "photos_export_album",
        "labelZh": "导出相册",
        "labelEn": "Export album",
        "descZh": "导出整个相册到本地目录",
        "descEn": "Export an album to a local directory"
      },
      {
        "name": "photos_create_album",
        "labelZh": "创建相册",
        "labelEn": "Create album",
        "descZh": "创建新的照片相册",
        "descEn": "Create a new Photos album"
      },
      {
        "name": "photos_create_folder",
        "labelZh": "创建文件夹",
        "labelEn": "Create folder",
        "descZh": "创建新的照片文件夹",
        "descEn": "Create a new Photos folder"
      },
      {
        "name": "photos_rename_container",
        "labelZh": "重命名集合",
        "labelEn": "Rename container",
        "descZh": "重命名相册或文件夹",
        "descEn": "Rename an album or folder"
      },
      {
        "name": "photos_delete_container",
        "labelZh": "删除集合",
        "labelEn": "Delete container",
        "descZh": "删除相册或文件夹",
        "descEn": "Delete an album or folder"
      },
      {
        "name": "photos_add_assets_to_album",
        "labelZh": "加入相册",
        "labelEn": "Add to album",
        "descZh": "把照片/视频加入指定相册",
        "descEn": "Add assets to an album"
      },
      {
        "name": "photos_remove_assets_from_album",
        "labelZh": "移出相册",
        "labelEn": "Remove from album",
        "descZh": "从相册移出资源（必要时交接给照片 App）",
        "descEn": "Remove assets from an album with UI handoff when needed"
      },
      {
        "name": "photos_move_assets_in_album",
        "labelZh": "重排相册",
        "labelEn": "Reorder album",
        "descZh": "在相册内移动/重排资源（UI 操作）",
        "descEn": "Move/reorder assets inside an album"
      },
      {
        "name": "photos_duplicate_asset",
        "labelZh": "复制照片",
        "labelEn": "Duplicate asset",
        "descZh": "复制照片或视频资源",
        "descEn": "Duplicate a photo or video asset"
      },
      {
        "name": "photos_set_favorite",
        "labelZh": "收藏状态",
        "labelEn": "Set favorite",
        "descZh": "设置或取消收藏",
        "descEn": "Set or clear favorite state"
      },
      {
        "name": "photos_set_hidden",
        "labelZh": "隐藏状态",
        "labelEn": "Set hidden",
        "descZh": "隐藏或取消隐藏照片/视频",
        "descEn": "Hide or unhide assets"
      },
      {
        "name": "photos_update_metadata",
        "labelZh": "更新元数据",
        "labelEn": "Update metadata",
        "descZh": "更新标题、描述、关键词、日期、地点等",
        "descEn": "Update title, description, keywords, date, location, etc."
      },
      {
        "name": "photos_batch_update_metadata",
        "labelZh": "批量元数据",
        "labelEn": "Batch metadata",
        "descZh": "批量更新多个资源的元数据",
        "descEn": "Batch update metadata across assets"
      },
      {
        "name": "photos_apply_edit",
        "labelZh": "应用编辑",
        "labelEn": "Apply edit",
        "descZh": "执行旋转、增强、裁剪等照片编辑动作",
        "descEn": "Apply edit actions such as rotate, enhance, or crop"
      },
      {
        "name": "photos_revert_edits",
        "labelZh": "还原编辑",
        "labelEn": "Revert edits",
        "descZh": "将照片还原为原始版本",
        "descEn": "Revert an asset to original"
      },
      {
        "name": "photos_run_ui_action",
        "labelZh": "UI 操作",
        "labelEn": "Run UI action",
        "descZh": "控制照片 App 执行 UI 专属动作",
        "descEn": "Control Photos.app for UI-only actions"
      },
      {
        "name": "photos_prepare_handoff",
        "labelZh": "准备接手",
        "labelEn": "Prepare handoff",
        "descZh": "把照片 App 打开到可人工接手的状态",
        "descEn": "Navigate Photos.app to a handoff-ready state"
      },
      {
        "name": "photos_delete_assets",
        "labelZh": "删除照片",
        "labelEn": "Delete assets",
        "descZh": "删除照片/视频（按照片 App 行为进入最近删除等）",
        "descEn": "Delete assets according to Photos.app behavior"
      },
      {
        "name": "photos_recover_recently_deleted",
        "labelZh": "恢复最近删除",
        "labelEn": "Recover deleted",
        "descZh": "恢复最近删除中的资源（必要时 UI 接手）",
        "descEn": "Recover assets from Recently Deleted with UI handoff"
      },
      {
        "name": "photos_permanently_delete_recently_deleted",
        "labelZh": "永久删除",
        "labelEn": "Permanent delete",
        "descZh": "从最近删除中永久删除资源",
        "descEn": "Permanently delete assets from Recently Deleted"
      },
      {
        "name": "photos_batch_destructive_action",
        "labelZh": "批量破坏操作",
        "labelEn": "Batch destructive",
        "descZh": "批量删除/隐藏等高风险操作",
        "descEn": "High-risk batch delete/hide actions"
      }
    ]
  },
  {
    "id": "macos-system",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "系统工具",
    "nameEn": "System Tools",
    "descZh": "剪贴板、截图、Spotlight 搜索、系统通知",
    "descEn": "Clipboard, screenshot, Spotlight search, notifications",
    "icon": "🛠",
    "tools": [
      {
        "name": "read_clipboard",
        "labelZh": "读取剪贴板",
        "labelEn": "Read clipboard",
        "descZh": "读取当前剪贴板的文本内容",
        "descEn": "Read current clipboard text"
      },
      {
        "name": "spotlight_search",
        "labelZh": "Spotlight 搜索",
        "labelEn": "Spotlight search",
        "descZh": "用 Spotlight (mdfind) 搜索本地文件",
        "descEn": "Search local files with Spotlight (mdfind)"
      },
      {
        "name": "list_running_apps",
        "labelZh": "运行中的应用",
        "labelEn": "Running apps",
        "descZh": "列出当前正在运行的应用",
        "descEn": "List currently running applications"
      },
      {
        "name": "write_clipboard",
        "labelZh": "写入剪贴板",
        "labelEn": "Write clipboard",
        "descZh": "把文本写入剪贴板",
        "descEn": "Write text to clipboard"
      },
      {
        "name": "capture_screen",
        "labelZh": "截屏",
        "labelEn": "Capture screen",
        "descZh": "截屏并保存到指定路径（默认桌面，支持区域）",
        "descEn": "Take a screenshot, save to path (supports area)"
      },
      {
        "name": "show_notification",
        "labelZh": "发送系统通知",
        "labelEn": "Show notification",
        "descZh": "通过系统通知中心弹出一条通知",
        "descEn": "Display a macOS system notification"
      },
      {
        "name": "open_app",
        "labelZh": "打开应用",
        "labelEn": "Open app",
        "descZh": "启动或激活指定应用",
        "descEn": "Launch or activate an application"
      },
      {
        "name": "set_volume",
        "labelZh": "设置音量",
        "labelEn": "Set volume",
        "descZh": "设置系统输出音量（0–100）",
        "descEn": "Set system output volume (0–100)"
      },
      {
        "name": "show_dialog",
        "labelZh": "系统弹窗",
        "labelEn": "Show dialog",
        "descZh": "弹出系统对话框（用于提示/确认）",
        "descEn": "Show a system dialog (prompt / confirm)"
      },
      {
        "name": "lock_screen",
        "labelZh": "锁屏",
        "labelEn": "Lock screen",
        "descZh": "立即锁定屏幕",
        "descEn": "Lock the screen immediately"
      }
    ]
  },
  {
    "id": "macos-app-ui",
    "group": "macos",
    "platform": "darwin",
    "nameZh": "App UI",
    "nameEn": "App UI",
    "descZh": "读取和操作任意 macOS 应用的窗口、菜单、按钮、输入框和快捷键",
    "descEn": "Read and operate windows, menus, buttons, fields, and shortcuts in macOS apps",
    "icon": "🕹",
    "tools": [
      {
        "name": "app_ui_check_permission",
        "labelZh": "检查能力",
        "labelEn": "Check capabilities",
        "descZh": "分别检查界面读取和坐标点击能力",
        "descEn": "Check UI-read and coordinate-click capabilities separately"
      },
      {
        "name": "app_ui_list_apps",
        "labelZh": "列出 App",
        "labelEn": "List apps",
        "descZh": "列出当前运行中的可见应用",
        "descEn": "List visible running apps"
      },
      {
        "name": "app_ui_get_front_app",
        "labelZh": "前台 App",
        "labelEn": "Front app",
        "descZh": "读取当前前台应用",
        "descEn": "Read the currently frontmost app"
      },
      {
        "name": "app_ui_activate_app",
        "labelZh": "激活 App",
        "labelEn": "Activate app",
        "descZh": "启动或激活指定应用",
        "descEn": "Launch or activate an app"
      },
      {
        "name": "app_ui_list_windows",
        "labelZh": "列出窗口",
        "labelEn": "List windows",
        "descZh": "列出应用窗口、标题和边界",
        "descEn": "List app windows, titles, and bounds"
      },
      {
        "name": "app_ui_get_tree",
        "labelZh": "读取界面树",
        "labelEn": "Read UI tree",
        "descZh": "读取窗口的辅助功能元素树",
        "descEn": "Read a window Accessibility element tree"
      },
      {
        "name": "app_ui_find_element",
        "labelZh": "查找元素",
        "labelEn": "Find element",
        "descZh": "按文本和角色查找按钮、输入框等界面元素",
        "descEn": "Find UI elements by text and role"
      },
      {
        "name": "app_ui_capture_screen",
        "labelZh": "截取屏幕",
        "labelEn": "Capture screen",
        "descZh": "截屏并返回像素尺寸和屏幕坐标范围",
        "descEn": "Capture the screen and return pixel size plus screen bounds"
      },
      {
        "name": "app_ui_click_at",
        "labelZh": "坐标点击",
        "labelEn": "Click coordinates",
        "descZh": "按屏幕或最近截图坐标点击，用于不暴露界面树的应用",
        "descEn": "Click screen or latest-screenshot coordinates for apps without a usable UI tree"
      },
      {
        "name": "app_ui_click_element",
        "labelZh": "点击元素",
        "labelEn": "Click element",
        "descZh": "点击指定界面元素",
        "descEn": "Click a UI element"
      },
      {
        "name": "app_ui_set_value",
        "labelZh": "设置输入值",
        "labelEn": "Set value",
        "descZh": "设置或替换输入框等元素的值",
        "descEn": "Set or replace an element value"
      },
      {
        "name": "app_ui_type_text",
        "labelZh": "输入文本",
        "labelEn": "Type text",
        "descZh": "向当前焦点输入文本",
        "descEn": "Type text into the current focus"
      },
      {
        "name": "app_ui_press_key",
        "labelZh": "按键/快捷键",
        "labelEn": "Press key",
        "descZh": "按键或执行快捷键组合",
        "descEn": "Press a key or keyboard shortcut"
      },
      {
        "name": "app_ui_select_menu_item",
        "labelZh": "选择菜单项",
        "labelEn": "Select menu",
        "descZh": "选择应用菜单栏中的菜单项",
        "descEn": "Select an app menu bar item"
      },
      {
        "name": "app_ui_wait_for",
        "labelZh": "等待界面",
        "labelEn": "Wait for UI",
        "descZh": "等待窗口或界面元素出现",
        "descEn": "Wait for a window or UI element to appear"
      },
      {
        "name": "app_ui_handoff",
        "labelZh": "交给用户",
        "labelEn": "Handoff",
        "descZh": "打开应用并返回需要用户手动完成的步骤",
        "descEn": "Open an app and return manual handoff instructions"
      }
    ]
  }
];
