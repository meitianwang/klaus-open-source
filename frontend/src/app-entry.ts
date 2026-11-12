// Preserve the main window's module order after the bootstrap storage barrier.
import './app/code-token-themes'
import './app/i18n'
import './app/tooltip'
import './icons'
import './icons/static-mount'
import './app/ui-select'
import './app/ui-topbar'
import './app/ui-page-header'
import './app/page-view'
import './chat/follow-up'
import './app/dialog'
import './app/browser-permission'
import './app/native-overlay-guard'
import './app/ssh-connect'
import './app/ui-shared'
import './pages/settings'
import './pages/external-import'
import './pages/channels'
import './pages/mcp'
import './pages/team-collaboration'
import './pages/skills'
import './pages/plugins'
import './pages/slash-commands'
import './pages/agents'
import './pages/cron'
import './pages/memory'
import './pages/friends'
import './pages/profile'
import './pages/diff'
// Vendor globals retain their original position in the module sequence.
import './vendor-globals'
import './chat/agent-status'
import './chat/turn-navigation'
// Panel globals are consumed by side tasks and chat initialization.
import './chat/panels/panel-tabs'
import './chat/panels/side-tasks'
import './chat/chat'
// React chat islands depend on the globals installed by chat.ts.
import './chat'
// Keybindings come last: the fallback command handlers call into
// `window.klausKeybindingActions`, which chat.ts populates, and into the
// command-menu host that './chat' mounts. Import order alone would not be
// enough — booting is a call, so it runs after every module above has been
// evaluated.
import { bootKeybindings } from './app/keybindings/boot'
import { bootPowerSavePolicy } from './app/power-save'
import { mountUpdateNotices } from './app/update/mount'

bootKeybindings()
bootPowerSavePolicy()
// One store owns every update surface, so the sidebar card and the modal
// surfaces always describe the same transfer.
mountUpdateNotices()
