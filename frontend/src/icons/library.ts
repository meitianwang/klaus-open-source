// 统一图标库——UI chrome 字形的来源。主库 @phosphor-icons/core，phosphor
// 没有等价字形时取另一个正式社区库（lucide-static，ISC），二者都算「库字形」。
//
// 原则：不手绘 UI 字形。原 registry 三张网格表 + raw-glyphs 里的手绘/逐字
// 收编字形，凡是通用 UI 语义（关闭/加号/文件夹/齿轮/箭头…）一律换成
// 库字形；仅品牌标（Claude logo、browser-use logo、Apple 标、Klaus
// 自家盾形标）、多元素动画字形（neuron 记忆动画、s-lead 双层 spinner）和
// 两个库都没有等价物的个别字形（slash 命令斜杠、装饰性标注箭头）留在
// raw-glyphs.ts。映射注释里写清语义，改图标 = 改一行 import。
//
// 尺寸契约：phosphor 原始 svg 只有 viewBox（256 网格）+ fill=currentColor，
// 不带 width/height——与收编前「无显式尺寸、CSS 控大小」的行为一致。少数
// 调用点依赖字形自带的固有尺寸/类名/属性（收编前的 shell 属性），在条目上
// 用 size/cls/attrs 烤进去，保证替换零布局位移。lucide 字形走 lucideShell
// 归一到同一契约（见下）。
//
// 权重：默认 regular；侧栏 path-fill 同款的强调位用 fill；个别原字形为
// 加粗线条（9–10px 小尺寸状态标）用 bold，对应原 stroke-width 2.4。
//
// per-icon `?raw` 导入 + Vite 打包 = 只有用到的字形进产物。
import { projectCoverIconCatalog } from '../pages/team-collaboration/project-cover-icons'
import xSvg from '@phosphor-icons/core/assets/regular/x.svg?raw'
import plusSvg from '@phosphor-icons/core/assets/regular/plus.svg?raw'
import minusSvg from '@phosphor-icons/core/assets/regular/minus.svg?raw'
import arrowClockwiseSvg from '@phosphor-icons/core/assets/regular/arrow-clockwise.svg?raw'
import pencilSimpleLightSvg from '@phosphor-icons/core/assets/light/pencil-simple-light.svg?raw'
import trashLightSvg from '@phosphor-icons/core/assets/light/trash-light.svg?raw'
import arrowUUpLeftLightSvg from '@phosphor-icons/core/assets/light/arrow-u-up-left-light.svg?raw'
import keyboardLightSvg from '@phosphor-icons/core/assets/light/keyboard-light.svg?raw'
import pawPrintSvg from '@phosphor-icons/core/assets/regular/paw-print.svg?raw'
import sunSvg from '@phosphor-icons/core/assets/regular/sun.svg?raw'
import moonSvg from '@phosphor-icons/core/assets/regular/moon.svg?raw'
import folderSvg from '@phosphor-icons/core/assets/regular/folder.svg?raw'
import foldersSvg from '@phosphor-icons/core/assets/regular/folders.svg?raw'
import folderPlusSvg from '@phosphor-icons/core/assets/regular/folder-plus.svg?raw'
import folderDashedSvg from '@phosphor-icons/core/assets/regular/folder-dashed.svg?raw'
import folderOpenSvg from '@phosphor-icons/core/assets/regular/folder-open.svg?raw'
import trashSvg from '@phosphor-icons/core/assets/regular/trash.svg?raw'
import magnifyingGlassSvg from '@phosphor-icons/core/assets/regular/magnifying-glass.svg?raw'
import checkSvg from '@phosphor-icons/core/assets/regular/check.svg?raw'
import caretRightSvg from '@phosphor-icons/core/assets/regular/caret-right.svg?raw'
import caretDownSvg from '@phosphor-icons/core/assets/regular/caret-down.svg?raw'
import caretLeftSvg from '@phosphor-icons/core/assets/regular/caret-left.svg?raw'
import caretLeftLightSvg from '@phosphor-icons/core/assets/light/caret-left-light.svg?raw'
import arrowDownSvg from '@phosphor-icons/core/assets/regular/arrow-down.svg?raw'
import notePencilSvg from '@phosphor-icons/core/assets/regular/note-pencil.svg?raw'
import pencilSimpleSvg from '@phosphor-icons/core/assets/regular/pencil-simple.svg?raw'
import textboxSvg from '@phosphor-icons/core/assets/regular/textbox.svg?raw'
import recordSvg from '@phosphor-icons/core/assets/regular/record.svg?raw'
import codeSvg from '@phosphor-icons/core/assets/regular/code.svg?raw'
import bracketsCurlySvg from '@phosphor-icons/core/assets/regular/brackets-curly.svg?raw'
import uploadSimpleSvg from '@phosphor-icons/core/assets/regular/upload-simple.svg?raw'
import downloadSimpleSvg from '@phosphor-icons/core/assets/regular/download-simple.svg?raw'
import listSvg from '@phosphor-icons/core/assets/regular/list.svg?raw'
import listChecksSvg from '@phosphor-icons/core/assets/regular/list-checks.svg?raw'
import gitDiffSvg from '@phosphor-icons/core/assets/regular/git-diff.svg?raw'
import arrowUpRightSvg from '@phosphor-icons/core/assets/regular/arrow-up-right.svg?raw'
import gitBranchSvg from '@phosphor-icons/core/assets/regular/git-branch.svg?raw'
import gitForkSvg from '@phosphor-icons/core/assets/regular/git-fork.svg?raw'
import gitCommitSvg from '@phosphor-icons/core/assets/regular/git-commit.svg?raw'
import terminalWindowSvg from '@phosphor-icons/core/assets/regular/terminal-window.svg?raw'
import terminalSvg from '@phosphor-icons/core/assets/regular/terminal.svg?raw'
import chatsSvg from '@phosphor-icons/core/assets/regular/chats.svg?raw'
import chatCircleSvg from '@phosphor-icons/core/assets/regular/chat-circle.svg?raw'
import chatCircleTextSvg from '@phosphor-icons/core/assets/regular/chat-circle-text.svg?raw'
import arrowBendUpLeftSvg from '@phosphor-icons/core/assets/regular/arrow-bend-up-left.svg?raw'
import chatSvg from '@phosphor-icons/core/assets/regular/chat.svg?raw'
import fileSvg from '@phosphor-icons/core/assets/regular/file.svg?raw'
import fileTextSvg from '@phosphor-icons/core/assets/regular/file-text.svg?raw'
import filePdfSvg from '@phosphor-icons/core/assets/regular/file-pdf.svg?raw'
import fileDocSvg from '@phosphor-icons/core/assets/regular/file-doc.svg?raw'
import fileXlsSvg from '@phosphor-icons/core/assets/regular/file-xls.svg?raw'
import filePptSvg from '@phosphor-icons/core/assets/regular/file-ppt.svg?raw'
import fileCsvSvg from '@phosphor-icons/core/assets/regular/file-csv.svg?raw'
import fileCodeSvg from '@phosphor-icons/core/assets/regular/file-code.svg?raw'
import fileHtmlSvg from '@phosphor-icons/core/assets/regular/file-html.svg?raw'
import fileAudioSvg from '@phosphor-icons/core/assets/regular/file-audio.svg?raw'
import fileImageSvg from '@phosphor-icons/core/assets/regular/file-image.svg?raw'
import filePlusSvg from '@phosphor-icons/core/assets/regular/file-plus.svg?raw'
import treeStructureSvg from '@phosphor-icons/core/assets/regular/tree-structure.svg?raw'
import clipboardTextSvg from '@phosphor-icons/core/assets/regular/clipboard-text.svg?raw'
import gearSvg from '@phosphor-icons/core/assets/regular/gear.svg?raw'
import dotsThreeSvg from '@phosphor-icons/core/assets/regular/dots-three.svg?raw'
import dotsSixVerticalSvg from '@phosphor-icons/core/assets/regular/dots-six-vertical.svg?raw'
import hardDrivesSvg from '@phosphor-icons/core/assets/regular/hard-drives.svg?raw'
import arrowUpSvg from '@phosphor-icons/core/assets/regular/arrow-up.svg?raw'
import arrowSquareOutSvg from '@phosphor-icons/core/assets/regular/arrow-square-out.svg?raw'
import houseSvg from '@phosphor-icons/core/assets/regular/house.svg?raw'
import lockSvg from '@phosphor-icons/core/assets/regular/lock.svg?raw'
import globeSvg from '@phosphor-icons/core/assets/regular/globe.svg?raw'
import desktopSvg from '@phosphor-icons/core/assets/regular/desktop.svg?raw'
import monitorSvg from '@phosphor-icons/core/assets/regular/monitor.svg?raw'
import monitorPlaySvg from '@phosphor-icons/core/assets/regular/monitor-play.svg?raw'
import pictureInPictureSvg from '@phosphor-icons/core/assets/regular/picture-in-picture.svg?raw'
import presentationChartSvg from '@phosphor-icons/core/assets/regular/presentation-chart.svg?raw'
import deviceMobileSvg from '@phosphor-icons/core/assets/regular/device-mobile.svg?raw'
import copySvg from '@phosphor-icons/core/assets/regular/copy.svg?raw'
import clockSvg from '@phosphor-icons/core/assets/regular/clock.svg?raw'
import arrowUUpLeftSvg from '@phosphor-icons/core/assets/regular/arrow-u-up-left.svg?raw'
import arrowArcLeftSvg from '@phosphor-icons/core/assets/regular/arrow-arc-left.svg?raw'
import arrowArcRightSvg from '@phosphor-icons/core/assets/regular/arrow-arc-right.svg?raw'
import graphSvg from '@phosphor-icons/core/assets/regular/graph.svg?raw'
import calendarBlankSvg from '@phosphor-icons/core/assets/regular/calendar-blank.svg?raw'
import playSvg from '@phosphor-icons/core/assets/regular/play.svg?raw'
import pauseSvg from '@phosphor-icons/core/assets/regular/pause.svg?raw'
import playCircleSvg from '@phosphor-icons/core/assets/regular/play-circle.svg?raw'
import pauseCircleSvg from '@phosphor-icons/core/assets/regular/pause-circle.svg?raw'
import queuedMessageSvg from './queued-message.svg?raw'
import steerMessageSvg from './steer-message.svg?raw'
import archiveSvg from '@phosphor-icons/core/assets/regular/archive.svg?raw'
import pushPinSvg from '@phosphor-icons/core/assets/regular/push-pin.svg?raw'
import pushPinSlashSvg from '@phosphor-icons/core/assets/regular/push-pin-slash.svg?raw'
import exportSvg from '@phosphor-icons/core/assets/regular/export.svg?raw'
import bugSvg from '@phosphor-icons/core/assets/regular/bug.svg?raw'
import infoSvg from '@phosphor-icons/core/assets/regular/info.svg?raw'
import questionSvg from '@phosphor-icons/core/assets/regular/question.svg?raw'
import chatQuestionSvg from 'lucide-static/icons/message-circle-question.svg?raw'
import exclamationMarkSvg from '@phosphor-icons/core/assets/regular/exclamation-mark.svg?raw'
import warningSvg from '@phosphor-icons/core/assets/regular/warning.svg?raw'
import warningCircleSvg from '@phosphor-icons/core/assets/regular/warning-circle.svg?raw'
import xCircleSvg from '@phosphor-icons/core/assets/regular/x-circle.svg?raw'
import circleDashedSvg from '@phosphor-icons/core/assets/regular/circle-dashed.svg?raw'
import swapSvg from '@phosphor-icons/core/assets/regular/swap.svg?raw'
import imageSvg from '@phosphor-icons/core/assets/regular/image.svg?raw'
import imageBrokenSvg from '@phosphor-icons/core/assets/regular/image-broken.svg?raw'
import imagesSvg from '@phosphor-icons/core/assets/regular/images.svg?raw'
import filmStripSvg from '@phosphor-icons/core/assets/regular/film-strip.svg?raw'
import musicNotesSvg from '@phosphor-icons/core/assets/regular/music-notes.svg?raw'
import paperclipSvg from '@phosphor-icons/core/assets/regular/paperclip.svg?raw'
import lightbulbSvg from '@phosphor-icons/core/assets/regular/lightbulb.svg?raw'
import asteriskSvg from '@phosphor-icons/core/assets/regular/asterisk.svg?raw'
import userSvg from '@phosphor-icons/core/assets/regular/user.svg?raw'
import usersThreeSvg from '@phosphor-icons/core/assets/regular/users-three.svg?raw'
import userPlusSvg from '@phosphor-icons/core/assets/regular/user-plus.svg?raw'
import scanSvg from '@phosphor-icons/core/assets/regular/scan.svg?raw'
import rocketLaunchSvg from '@phosphor-icons/core/assets/regular/rocket-launch.svg?raw'
import starSvg from '@phosphor-icons/core/assets/regular/star.svg?raw'
import starFillSvg from '@phosphor-icons/core/assets/fill/star-fill.svg?raw'
import lightningFillSvg from '@phosphor-icons/core/assets/fill/lightning-fill.svg?raw'
import funnelSvg from '@phosphor-icons/core/assets/regular/funnel.svg?raw'
import arrowsDownUpSvg from '@phosphor-icons/core/assets/regular/arrows-down-up.svg?raw'
import diceFiveSvg from '@phosphor-icons/core/assets/regular/dice-five.svg?raw'
import userSquareSvg from '@phosphor-icons/core/assets/regular/user-square.svg?raw'
import bookOpenSvg from '@phosphor-icons/core/assets/regular/book-open.svg?raw'
import bellSvg from '@phosphor-icons/core/assets/regular/bell.svg?raw'
import pulseSvg from '@phosphor-icons/core/assets/regular/pulse.svg?raw'
import plugSvg from '@phosphor-icons/core/assets/regular/plug.svg?raw'
import wrenchSvg from '@phosphor-icons/core/assets/regular/wrench.svg?raw'
import shieldCheckSvg from '@phosphor-icons/core/assets/regular/shield-check.svg?raw'
import shieldWarningSvg from '@phosphor-icons/core/assets/regular/shield-warning.svg?raw'
import handPalmSvg from '@phosphor-icons/core/assets/regular/hand-palm.svg?raw'
import shieldSvg from '@phosphor-icons/core/assets/regular/shield.svg?raw'
import signOutSvg from '@phosphor-icons/core/assets/regular/sign-out.svg?raw'
import signInSvg from '@phosphor-icons/core/assets/regular/sign-in.svg?raw'
import spinnerGapSvg from '@phosphor-icons/core/assets/regular/spinner-gap.svg?raw'
import wifiHighSvg from '@phosphor-icons/core/assets/regular/wifi-high.svg?raw'
import smileySvg from '@phosphor-icons/core/assets/regular/smiley.svg?raw'
import compassSvg from '@phosphor-icons/core/assets/regular/compass.svg?raw'
import envelopeSimpleSvg from '@phosphor-icons/core/assets/regular/envelope-simple.svg?raw'
import noteSvg from '@phosphor-icons/core/assets/regular/note.svg?raw'
import addressBookSvg from '@phosphor-icons/core/assets/regular/address-book.svg?raw'
import lightningSvg from '@phosphor-icons/core/assets/regular/lightning.svg?raw'
import cursorClickSvg from '@phosphor-icons/core/assets/regular/cursor-click.svg?raw'
import googleChromeLogoSvg from '@phosphor-icons/core/assets/regular/google-chrome-logo.svg?raw'
import maskHappySvg from '@phosphor-icons/core/assets/regular/mask-happy.svg?raw'
import slidersHorizontalSvg from '@phosphor-icons/core/assets/regular/sliders-horizontal.svg?raw'
import sidebarSimpleSvg from '@phosphor-icons/core/assets/regular/sidebar-simple.svg?raw'
import puzzlePieceSvg from '@phosphor-icons/core/assets/regular/puzzle-piece.svg?raw'
import sparkleSvg from '@phosphor-icons/core/assets/regular/sparkle.svg?raw'
import paperPlaneTiltSvg from '@phosphor-icons/core/assets/regular/paper-plane-tilt.svg?raw'
import stairsSvg from '@phosphor-icons/core/assets/regular/stairs.svg?raw'
import squaresFourSvg from '@phosphor-icons/core/assets/regular/squares-four.svg?raw'
import robotSvg from '@phosphor-icons/core/assets/regular/robot.svg?raw'
import circleHalfSvg from '@phosphor-icons/core/assets/regular/circle-half.svg?raw'
import textAaSvg from '@phosphor-icons/core/assets/regular/text-aa.svg?raw'
import cameraSvg from '@phosphor-icons/core/assets/regular/camera.svg?raw'
import eyeSvg from '@phosphor-icons/core/assets/regular/eye.svg?raw'
import magnifyingGlassPlusSvg from '@phosphor-icons/core/assets/regular/magnifying-glass-plus.svg?raw'
import magnifyingGlassMinusSvg from '@phosphor-icons/core/assets/regular/magnifying-glass-minus.svg?raw'
import cornersOutSvg from '@phosphor-icons/core/assets/regular/corners-out.svg?raw'
import cornersInSvg from '@phosphor-icons/core/assets/regular/corners-in.svg?raw'
import circleNotchSvg from '@phosphor-icons/core/assets/regular/circle-notch.svg?raw'
import packageSvg from '@phosphor-icons/core/assets/regular/package.svg?raw'
import arrowSquareInSvg from '@phosphor-icons/core/assets/regular/arrow-square-in.svg?raw'
import keySvg from '@phosphor-icons/core/assets/regular/key.svg?raw'
import cubeSvg from '@phosphor-icons/core/assets/regular/cube.svg?raw'
import cubeFocusSvg from '@phosphor-icons/core/assets/regular/cube-focus.svg?raw'
import gridFourSvg from '@phosphor-icons/core/assets/regular/grid-four.svg?raw'
import webhooksLogoSvg from '@phosphor-icons/core/assets/regular/webhooks-logo.svg?raw'
import microphoneSvg from '@phosphor-icons/core/assets/regular/microphone.svg?raw'
import waveformSvg from '@phosphor-icons/core/assets/regular/waveform.svg?raw'
import brainSvg from '@phosphor-icons/core/assets/regular/brain.svg?raw'
import stackSvg from '@phosphor-icons/core/assets/regular/stack.svg?raw'
import chatTeardropSvg from '@phosphor-icons/core/assets/regular/chat-teardrop.svg?raw'
import sparkleFillSvg from '@phosphor-icons/core/assets/fill/sparkle-fill.svg?raw'
import puzzlePieceFillSvg from '@phosphor-icons/core/assets/fill/puzzle-piece-fill.svg?raw'
import squaresFourFillSvg from '@phosphor-icons/core/assets/fill/squares-four-fill.svg?raw'
import qrCodeFillSvg from '@phosphor-icons/core/assets/fill/qr-code-fill.svg?raw'
import chatTeardropFillSvg from '@phosphor-icons/core/assets/fill/chat-teardrop-fill.svg?raw'
import trashFillSvg from '@phosphor-icons/core/assets/fill/trash-fill.svg?raw'
import pencilSimpleFillSvg from '@phosphor-icons/core/assets/fill/pencil-simple-fill.svg?raw'
import stopFillSvg from '@phosphor-icons/core/assets/fill/stop-fill.svg?raw'
import xBoldSvg from '@phosphor-icons/core/assets/bold/x-bold.svg?raw'
import checkBoldSvg from '@phosphor-icons/core/assets/bold/check-bold.svg?raw'
// —— 补库：lucide-static（ISC）——phosphor 无等价字形的条目从这里取。
// phosphor 的表盘族（gauge / speedometer）都是开口半穹顶，没有整圆表盘。
import circleGaugeSvg from 'lucide-static/icons/circle-gauge.svg?raw'

// Website resource card glyph: a two-tone globe that reads as "a page".
const resourceGlobeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="#CDF3FF"/><path fill="#41CEF9" fill-rule="evenodd" clip-rule="evenodd" d="M12 2c5.522 0 10 4.478 10 10s-4.478 10-10 10S2 17.522 2 12 6.478 2 12 2ZM9.172 13c.146 4.477 1.284 7 2.828 7 1.544 0 2.682-2.523 2.828-7H9.172Zm-5.108 0a7.994 7.994 0 0 0 4.313 6.134C7.686 17.622 7.261 15.549 7.174 13h-3.11Zm12.762 0c-.087 2.55-.512 4.622-1.204 6.134A7.994 7.994 0 0 0 19.936 13h-3.11Zm-8.45-8.135A7.995 7.995 0 0 0 4.065 11h3.11c.087-2.55.511-4.623 1.203-6.135ZM12.001 4c-1.544 0-2.682 2.523-2.828 7h5.656C14.682 6.523 13.544 4 12 4Zm3.622.865C16.314 6.377 16.74 8.45 16.826 11h3.11a7.995 7.995 0 0 0-4.314-6.135Z"/></svg>'

// 收编前 shell 属性（尺寸/类名/零散根属性）烤进 svg 根节点，保证替换后布局不动。
function shell(svg: string, opts: { size?: number; cls?: string; attrs?: Record<string, string> } = {}): string {
  let out = svg.replace('<svg ', '<svg aria-hidden="true" ')
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) out = out.replace('<svg ', `<svg ${k}="${v}" `)
  }
  if (opts.cls) out = out.replace('<svg ', `<svg class="${opts.cls}" `)
  if (opts.size) out = out.replace('<svg ', `<svg width="${opts.size}" height="${opts.size}" `)
  return out
}

// lucide 字形归一到 phosphor 那套尺寸契约后再进 shell：
//   - 原文件是 license 注释 + 多行属性，根标签是 `<svg\n`，shell 的 `'<svg '`
//     匹配不上，必须先压成单行；license 注释留在 bundle 字符串里（ISC 的
//     notice 保留），只是不进 DOM。
//   - 去掉库自带的 class 与 width/height=24，交回 CSS 控尺寸。
//   - 线宽 2 → 1.5：phosphor regular 是 256 网格 16px 线宽，换算到 24 网格正好
//     1.5，这样 lucide 描边字形和相邻 phosphor 填充字形视重一致。
function lucideShell(svg: string, opts: { size?: number; cls?: string; attrs?: Record<string, string> } = {}): string {
  const normalized = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ class="[^"]*"/, '')
    .replace(/ (?:width|height)="[^"]*"/g, '')
    .replace('stroke-width="2"', 'stroke-width="1.5"')
    .trim()
  return shell(normalized, opts)
}

export const LIBRARY: Record<string, string> = {
  ...Object.fromEntries(projectCoverIconCatalog.map(icon => [`tc-cover-${icon.id}`, shell(icon.svg)])),
  // —— 回合末资源卡 ——
  'resource-globe': shell(resourceGlobeSvg),
  'resource-file-pdf': shell(filePdfSvg),
  'resource-file-word': shell(fileDocSvg),
  'resource-file-excel': shell(fileXlsSvg),
  'resource-file-powerpoint': shell(filePptSvg),
  'resource-file-spreadsheet': shell(fileCsvSvg),
  'resource-file-presentation': shell(presentationChartSvg),
  'resource-file-code': shell(fileCodeSvg),
  'resource-file-html': shell(fileHtmlSvg),
  'resource-file-audio': shell(fileAudioSvg),
  'resource-file-image': shell(fileImageSvg),
  'resource-file-document': shell(fileTextSvg),
  'resource-file': shell(fileSvg),
  'resource-external': shell(arrowSquareOutSvg),
  // —— 通用基元 ——
  'close': shell(xSvg),
  'plus': shell(plusSvg),
  'minus': shell(minusSvg),
  'refresh': shell(arrowClockwiseSvg),
  // Transcript reconnect line: the stream-error row shows a static Wi-Fi
  // signal glyph, not a spinner or refresh arrow.
  'wifi': shell(wifiHighSvg),
  'folder': shell(folderSvg),
  'trash': shell(trashSvg),
  // Keyboard-shortcut row controls, all in the light weight
  // (pencil / trash / u-turn); phosphor's
  // closest U-turn is arrow-u-up-left, so the reset glyph uses that.
  'kb-edit': shell(pencilSimpleLightSvg, { size: 16 }),
  'kb-clear': shell(trashLightSvg, { size: 16 }),
  'kb-reset': shell(arrowUUpLeftLightSvg, { size: 16 }),
  'search': shell(magnifyingGlassSvg),
  'check': shell(checkSvg),
  'chevron-right': shell(caretRightSvg),
  'chevron-down': shell(caretDownSvg),
  // 会话滚动吸底按钮：回到最新消息（chat-timeline 浮控）。
  'chat-scroll-to-bottom': shell(arrowDownSvg),
  // 同一按钮在回合运行中的 glyph：spinner-gap 旋转，读作「下面还有 live 输出」。
  // class 烤进 svg：static-mount 以 outerHTML 原位替换槽位，slot 上的 class 不会留存。
  'chat-scroll-to-bottom-spin': shell(spinnerGapSvg, { cls: 'scroll-to-bottom-spin' }),
  'edit': shell(notePencilSvg),
  'chat-bubble': shell(chatTeardropFillSvg),
  'copy': shell(copySvg),
  'chevron': shell(caretRightSvg),                  // 通用右向 caret（ssh 路径导航等）
  'up': shell(arrowUpSvg),                          // 上一级目录
  'home': shell(houseSvg),                          // 主目录
  'lock': shell(lockSvg),                           // 密码/凭据
  'server': shell(hardDrivesSvg),                   // 远程主机
  'check-glyph': shell(checkSvg),                   // 对话框复选框勾
  'klaus-dialog-title': shell(exclamationMarkSvg),  // 对话框错误标
  'row-close-x': shell(xSvg),
  'image-lightbox-close': shell(xSvg),
  'archived-search': shell(magnifyingGlassSvg),
  'task-check': shell(checkSvg),
  'task-empty': shell(listChecksSvg, { size: 20 }), // 任务列表空态
  'ws-empty': shell(folderSvg),                     // 工作区空态
  'failed': shell(xCircleSvg, { size: 16 }),
  'failed-2': shell(xBoldSvg, { size: 9 }),
  'on': shell(checkSvg, { size: 16 }),
  'on-2': shell(checkBoldSvg, { size: 10 }),
  'off': shell(circleDashedSvg, { size: 16 }),
  'off-2': shell(circleDashedSvg, { size: 14 }),
  'install-2': shell(plusSvg, { size: 16 }),        // MCP 安装入口（加号）
  'install-3': shell(swapSvg, { size: 14 }),        // MCP 弹窗安装/切换
  'img': shell(imageSvg, { size: 14 }),             // 附件缩略图（图片）
  // 转录产物图加载失败（源文件被清理/移动后转录仍引用）的缺省卡字形。
  'image-broken': shell(imageBrokenSvg, { size: 16 }),
  'file-2': shell(fileSvg, { size: 14 }),           // 附件缩略图（文件）
  // 粘贴附件字形住 raw-glyphs（pasted-text）：库中无等价形态。
  'quoted-text': shell(chatSvg, { size: 14 }),

  // —— 页面顶栏（刷新·搜索·添加）创建菜单 ——
  'form': shell(textboxSvg, { size: 16 }),          // 手填表单
  'sparkle': shell(sparkleFillSvg, { size: 16 }),   // 让 Klaus 代写
  'code': shell(codeSvg, { size: 16 }),             // 贴原始配置
  'upload': shell(uploadSimpleSvg, { size: 16 }),   // 本地包导入
  'install': shell(downloadSimpleSvg, { size: 16 }), // 从源安装
  'record': shell(recordSvg, { size: 16 }),          // 录制演示
  'topbar-add-caret': shell(caretDownSvg, { size: 12 }),

  // —— 右侧面板 tab 条 + `+`/more 菜单 ——
  'monitor': shell(pulseSvg),                       // 活动监控面板
  'workspace': shell(folderSvg),
  'browser': shell(compassSvg),
  'diff': shell(gitDiffSvg),
  'terminal': shell(terminalWindowSvg),
  'side-task': shell(chatsSvg),
  'digram': shell(graphSvg),
  'model3d': shell(cubeSvg),
  'canvas': shell(presentationChartSvg),

  // —— composer `+` 菜单 ——
  'file': shell(fileTextSvg),
  'workflow': shell(treeStructureSvg),
  'spec': shell(clipboardTextSvg),
  'plan': shell(lightbulbSvg),
  'check-2': shell(checkSvg),
  'manage': shell(gearSvg),
  'chevron-2': shell(caretRightSvg),
  'back': shell(caretLeftSvg),
  // Light-weight back glyph for hover-revealed controls that must stay
  // visually quiet until the pointer lands on them.
  'back-light': shell(caretLeftLightSvg),
  'skill-sparkle-fill': shell(sparkleFillSvg),
  'plugin-fill': shell(puzzlePieceFillSvg),
  'mcp-grid-fill': shell(squaresFourFillSvg),
  'qr-code-fill': shell(qrCodeFillSvg),
  'user-plus': shell(userPlusSvg),
  'scan': shell(scanSvg),
  // slash-command-fill 留在 raw-glyphs：phosphor 没有裸斜杠字形。

  // —— 会话/项目侧栏 ——
  'project-sb': shell(folderSvg, { cls: 'project-sb-icon' }),
  // Open-folder variant: a project row has no chevron, so it signals group
  // expansion by swapping folder → folder-open.
  'project-sb-open': shell(folderOpenSvg, { cls: 'project-sb-icon' }),
  // Stacked-folder glyph marks a MULTI-folder workspace container apart from a
  // single-folder project (both in the sidebar and the project picker).
  'project-sb-workspace': shell(foldersSvg, { cls: 'project-sb-icon' }),
  'project-sb-2': shell(gitBranchSvg, { cls: 'project-sb-icon' }),
  'project-sb-3': shell(hardDrivesSvg, { cls: 'project-sb-icon' }),
  'chat-project-new-chat': shell(notePencilSvg),
  'chat-project-add': shell(folderPlusSvg),
  'chat-project-more': shell(dotsThreeSvg),
  'chat-project-search': shell(magnifyingGlassSvg),
  'chat-project-picker-check': shell(checkSvg),
  'chat-project-no-project': shell(folderDashedSvg),
  'chat-sidebar-chevron': shell(caretDownSvg),
  'chat-session-menu': shell(dotsThreeSvg),

  // —— 会话行菜单（session-menu-${action} 动态拼接） ——
  'session-menu-rename': shell(pencilSimpleSvg),
  'session-menu-pin': shell(pushPinSvg),
  'session-menu-unpin': shell(pushPinSlashSvg),
  'session-menu-export': shell(exportSvg),
  'session-menu-copy-id': shell(copySvg),
  'session-menu-fork': shell(gitForkSvg),
  'session-menu-worktree-reveal': shell(folderOpenSvg),
  'session-menu-report': shell(bugSvg),             // 提交调试报告
  'session-menu-archive': shell(archiveSvg),
  'session-menu-delete': shell(trashSvg),

  // —— transcript 消息动作/结构卡片 ——
  'rewind': shell(arrowUUpLeftSvg),                 // 撤销这条消息
  'branch': shell(gitBranchSvg),                    // 从此分叉
  'session-branch': shell(gitBranchSvg),
  'fork': shell(gitForkSvg, { cls: 'fork-icon' }),  // 分叉边界标
  'compaction': shell(archiveSvg, { cls: 'compaction-icon' }),
  'compact-summary': shell(fileTextSvg, { cls: 'compact-summary-icon' }),
  // 待办三态标（侧边栏 Plan 区与 composer 胶囊的 hover 清单共用一套字形，
  // 两处同一个待办不能长得不一样）。in-progress 的旋转由各自 CSS 接。
  'plan-mark-completed': shell(checkSvg),
  'plan-mark-in-progress': shell(circleNotchSvg),
  'plan-mark-pending': shell(circleDashedSvg),
  // Per-turn change card header glyph: a rounded square holding a plus over a
  // minus, drawn here because no bundled set carries that composite mark.
  'turn-changes-title': shell('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.75" y="3.75" width="16.5" height="16.5" rx="4.5"/><path d="M9 9.75h6"/><path d="M12 6.75v6"/><path d="M9 15.75h6"/></svg>'),
  'arrow-up-right': shell(arrowUpRightSvg),
  'permission-header': shell(lockSvg),
  'suggestion-action-btn': shell(paperclipSvg),     // 建议弹窗：加附件
  'suggestion-action-btn-2': shell(monitorSvg),     // 建议弹窗：截屏
  'spec-panel': shell(arrowSquareOutSvg, { size: 12 }),

  // —— follow-up 队列 ——
  'follow-up-queue': shell(queuedMessageSvg),
  'follow-up-steer': shell(steerMessageSvg),
  'follow-up-sending': shell(circleNotchSvg),
  'follow-up-queue-grip': shell(dotsSixVerticalSvg),
  'follow-up-paused': shell(warningSvg),
  
  'follow-up-delete': shell(trashFillSvg),
  'follow-up-delete-full': shell(trashSvg),
  'follow-up-edit': shell(pencilSimpleFillSvg),
  'follow-up-edit-full': shell(pencilSimpleSvg),
  // Row overflow menu: edit / open in side chat / turn queueing on or off.
  'follow-up-more': shell(dotsThreeSvg),
  'follow-up-side-chat': shell(chatCircleSvg),
  'follow-up-queueing': shell(listChecksSvg),

  // —— 工具行图标族（transcript 工具执行行，CSS 控大小） ——
  'tool-think': shell(lightbulbSvg, { cls: 'tool-item-icon' }),
  'tool-bash': shell(terminalSvg, { cls: 'tool-item-icon' }),
  'tool-read': shell(bookOpenSvg, { cls: 'tool-item-icon' }),
  'tool-image': shell(imagesSvg, { cls: 'tool-item-icon' }),
  'tool-generate-image': shell(imageSvg, { cls: 'tool-item-icon' }),
  'tool-generate-video': shell(filmStripSvg, { cls: 'tool-item-icon' }),
  'tool-generate-audio': shell(waveformSvg, { cls: 'tool-item-icon' }),
  'tool-generate-music': shell(musicNotesSvg, { cls: 'tool-item-icon' }),
  'tool-list': shell(folderSvg, { cls: 'tool-item-icon' }),
  'tool-write': shell(filePlusSvg, { cls: 'tool-item-icon' }),
  'tool-edit': shell(pencilSimpleSvg, { cls: 'tool-item-icon' }),
  'tool-glob': shell(asteriskSvg, { cls: 'tool-item-icon' }),
  'tool-grep': shell(magnifyingGlassSvg, { cls: 'tool-item-icon' }),
  'tool-web': shell(globeSvg, { cls: 'tool-item-icon' }),
  'tool-browser': shell(compassSvg, { cls: 'tool-item-icon' }),
  'tool-browser-click': shell(cursorClickSvg, { cls: 'tool-item-icon' }),
  'tool-memory': shell(brainSvg, { cls: 'tool-item-icon' }),
  'tool-dependencies': shell(packageSvg, { cls: 'tool-item-icon' }),
  'tool-design': shell(pencilSimpleSvg, { cls: 'tool-item-icon' }),
  'tool-diagram': shell(squaresFourSvg, { cls: 'tool-item-icon' }),
  'tool-advisor': shell(chatCircleTextSvg, { cls: 'tool-item-icon' }),
  'tool-friends': shell(usersThreeSvg, { cls: 'tool-item-icon' }),
  'tool-friend-send': shell(chatCircleTextSvg, { cls: 'tool-item-icon' }),
  'tool-friend-reply': shell(arrowBendUpLeftSvg, { cls: 'tool-item-icon' }),
  // Friend message action bar: send an answer back to the sender, or add the
  // information they asked for. Handing a message to this computer's Klaus uses
  // the Klaus mark (raw-glyphs `friend-handoff`).
  'friend-reply': shell(paperPlaneTiltSvg),
  'friend-supplement': shell(chatCircleTextSvg),
  // Title glyph of the card for a friend's request in the owner's own conversation.
  'friend-request': shell(usersThreeSvg),
  'tool-agent': shell(userSvg, { cls: 'tool-item-icon' }),
  'tool-ask-user': shell(questionSvg, { cls: 'tool-item-icon' }),
  'chat-question': shell(chatQuestionSvg),
  'tool-plan-mode': shell(clipboardTextSvg, { cls: 'tool-item-icon' }),
  'tool-notebook': shell(bookOpenSvg, { cls: 'tool-item-icon' }),
  'tool-clock': shell(clockSvg, { cls: 'tool-item-icon' }),
  'tool-bell': shell(bellSvg, { cls: 'tool-item-icon' }),
  'tool-monitor': shell(pulseSvg, { cls: 'tool-item-icon' }),
  'tool-worktree': shell(gitBranchSvg, { cls: 'tool-item-icon' }),
  'tool-mcp-plug': shell(plugSvg, { cls: 'tool-item-icon' }),
  'tool-wrench': shell(wrenchSvg, { cls: 'tool-item-icon' }),
  'tool-check': shell(checkSvg, { cls: 'tool-check' }),
  'tool-chevron': shell(caretRightSvg, { cls: 'tool-chevron' }),

  // —— 认证（auth pill / 认证卡片） ——
  'auth-mode-2': shell(globeSvg),                   // 自定义 API 端点
  'auth-mode-3': shell(desktopSvg),                 // 端侧模型
  'chat-append-auth-required': shell(lockSvg, { size: 22, attrs: { style: 'flex-shrink:0' } }),
  'chat-append-auth-required-2': shell(spinnerGapSvg, { size: 22, attrs: { style: 'flex-shrink:0' } }),

  // —— 主题选择（暗/跟随系统/亮） ——
  'chat-theme-choice': shell(moonSvg),
  'chat-theme-choice-2': shell(desktopSvg),
  'chat-theme-choice-3': shell(sunSvg),

  // —— 工作区/文件面板 ——
  'chat-file': shell(fileTextSvg),
  'chat-file-2': shell(bracketsCurlySvg),           // 数据/配置类文件
  'chat-file-3': shell(terminalSvg),                // 脚本类文件
  'chat-file-code': shell(codeSvg),
  'chat-file-plain': shell(fileSvg),
  'chat-folder': shell(folderSvg),
  'chat-chevron': shell(caretRightSvg),
  'chat-workspace-close': shell(xSvg),
  'chat-init-monitor-section-collapse': shell(caretDownSvg),
  // Reference rows carry the icon of the page they open, at row scale.
  'overview-ref-skill': shell(sparkleSvg, { size: 14 }),
  'overview-ref-memory': shell(moonSvg, { size: 14 }),
  'overview-ref-mcp': shell(squaresFourSvg, { size: 14 }),
  'workspace-dir-pill': shell(folderSvg, { cls: 'slash-pill-icon workspace-mention-pill-icon' }),
  'workspace-file-pill': shell(fileSvg, { cls: 'slash-pill-icon workspace-mention-pill-icon' }),
  'workspace-file-empty': shell(foldersSvg),
  // Command menu quick actions / file rows (search panel).
  'folder-open': shell(folderOpenSvg),
  'workspace-file': shell(fileSvg),
  'run-mode-local': shell(desktopSvg),              // 本机直跑
  'run-mode-worktree': shell(treeStructureSvg),     // worktree 隔离跑

  // —— diff 页 ——
  'diff-clear': shell(xSvg, { cls: 'diff-clear-icon' }),
  'diff-commit-btn': shell(gitCommitSvg),
  'kls-icon-btn': shell(copySvg),                   // 复制路径
  'kls-icon-btn-2': shell(folderOpenSvg),           // 在访达显示
  'kls-icon-btn-3': shell(arrowSquareOutSvg),       // 外部打开
  'kls-icon-btn-4': shell(arrowClockwiseSvg),       // 刷新
  'kls-btn': shell(playSvg),                        // 立即执行
  'kls-pill-btn': shell(folderSvg),                 // 打开目录

  // —— 定时任务页 ——
  'cron-date-icon': shell(calendarBlankSvg, { size: 14 }),
  'cron-time-icon': shell(clockSvg, { size: 14 }),
  'cron-dd-caret': shell(caretDownSvg, { size: 12, cls: 'cron-dd-caret' }),
  'cron-date-nav-prev': shell(caretLeftSvg, { size: 14 }),
  'cron-date-nav-next': shell(caretRightSvg, { size: 14 }),
  'cron-empty-new': shell(plusSvg),
  'cron-empty-runs': shell(listSvg, { size: 40, attrs: { opacity: '0.3' } }),
  'cron-empty-tasks': shell(clockSvg, { size: 40, attrs: { opacity: '0.3' } }),
  'cron-empty-via-klaus': shell(sparkleFillSvg),    // 让 Klaus 创建
  'cron-row-menu': shell(dotsThreeSvg, { size: 16 }),
  'cron-runs-prune': shell(trashSvg),
  'cron-run-chevron': shell(caretRightSvg, { size: 12, cls: 'cron-run-chevron' }),
  'cron-sb-caret': shell(caretRightSvg, { cls: 'cron-sb-caret' }),
  'cron-sb-task': shell(clockSvg, { cls: 'cron-sb-task-icon' }),
  'cron-toggle-play': shell(playCircleSvg, { size: 16 }),
  'cron-toggle-pause': shell(pauseCircleSvg, { size: 16 }),
  'chat-render-cron-channel-banner': shell(downloadSimpleSvg, { size: 12 }),

  // —— 记忆页 ——
  'memory-empty-crescent': shell(moonSvg, { size: 40, attrs: { opacity: '0.3' } }),

  // —— MCP 页 ——
  'mcp-icon-btn': shell(plusSvg, { size: 14 }),
  'mcp-handle-mcp-market-action': shell(wrenchSvg, { size: 18 }),
  'mcp-handle-mcp-market-action-2': shell(shieldCheckSvg, { size: 18 }),
  'mcp-assure-person': shell(userSquareSvg, { size: 18 }),

  // —— 设置页（浏览器/能力/系统授权/账号） ——
  'settings-browser-chevron': shell(caretDownSvg),
  'settings-browser-plus': shell(plusSvg),
  'settings-browser-trash': shell(trashSvg),
  'browser-use-logo-2': shell(googleChromeLogoSvg, { cls: 'browser-use-logo' }),  // Chrome 接管
  'browser-use-logo-3': shell(maskHappySvg, { cls: 'browser-use-logo' }),         // Playwright MCP
  'browser-use-logo-5': shell(monitorPlaySvg, { cls: 'browser-use-logo' }),       // Computer Use
  'computer-use-pip': shell(pictureInPictureSvg),
  'browser-use-logo-6': shell(deviceMobileSvg, { cls: 'browser-use-logo' }),      // Mobile Bridge
  'sys-auth-shield-ok': shell(shieldCheckSvg, { size: 22 }),
  'sys-auth-shield-warn': shell(shieldWarningSvg, { size: 22 }),
  'permission-request': shell(handPalmSvg),
  'permission-review': shell(shieldSvg).replace('</svg>', `<g transform="translate(60 64) scale(.53125)">${terminalSvg.replace(/^.*?<svg[^>]*>/s, '').replace(/<\/svg>\s*$/, '')}</g></svg>`),
  'profile-logout-btn': shell(signOutSvg),
  'auth-mode-menu-manage': shell(gearSvg),
  'btw-close': shell(xSvg),

  // —— macOS 系统授权应用列表（Apple 标 group-macos 留在 raw-glyphs） ——
  'macos-finder': shell(smileySvg, { size: 22 }),
  'macos-safari': shell(compassSvg, { size: 22 }),
  'macos-mail': shell(envelopeSimpleSvg, { size: 22 }),
  'macos-messages': shell(chatCircleSvg, { size: 22 }),
  'macos-calendar': shell(calendarBlankSvg, { size: 22 }),
  'macos-contacts': shell(addressBookSvg, { size: 22 }),
  'macos-notes': shell(noteSvg, { size: 22 }),
  'macos-photos': shell(imagesSvg, { size: 22 }),
  'macos-reminders': shell(listChecksSvg, { size: 22 }),
  'macos-shortcuts': shell(lightningSvg, { size: 22 }),
  'macos-system': shell(wrenchSvg, { size: 22 }),
  'macos-app-ui': shell(cursorClickSvg, { size: 22 }),

  // —— 设置页侧栏导航（尺寸由 .settings-nav-item svg / .settings-back svg 控） ——
  'settings-back': shell(caretLeftSvg),
  'settings-nav-profile': shell(userSvg),
  'settings-nav-friends': shell(usersThreeSvg),
  'settings-nav-preferences': shell(slidersHorizontalSvg),
  'settings-nav-keyboard': shell(keyboardLightSvg),
  'settings-nav-pets': shell(pawPrintSvg),
  'settings-nav-external-import': shell(arrowSquareInSvg),
  'settings-nav-archived-sessions': shell(archiveSvg),
  'settings-nav-storage': shell(folderSvg),
  'settings-nav-worktrees': shell(treeStructureSvg),
  'settings-nav-permissions': shell(keySvg),
  'settings-nav-hooks': shell(webhooksLogoSvg),
  'settings-nav-mobile': shell(deviceMobileSvg),
  'settings-nav-models': shell(stackSvg),
  'settings-nav-model-tiers': shell(stairsSvg),
  'settings-nav-multimodal': shell(sparkleSvg),
  'settings-nav-engine-web': shell(globeSvg),
  'settings-nav-voice-input': shell(microphoneSvg),
  'settings-nav-engine-memory': shell(brainSvg),
  'settings-nav-system-auth': shell(shieldCheckSvg),
  'settings-nav-about': shell(infoSvg),
  'approval-review-info': shell(infoSvg),
  // Circled exclamation beside a settings section title: the section's long
  // explanation lives in its hover tooltip instead of a visible hint line.
  'settings-section-info': shell(warningCircleSvg),

  // —— 欢迎页 / 面板 tab 条零散件 ——
  'welcome-chip': shell(chatTeardropSvg),
  'panel-tab-more': shell(dotsThreeSvg),
  'panel-tab-new': shell(plusSvg),

  // —— 静态骨架（index.html/artifact.html，由 static-mount 填入 [data-kls-icon] 槽位） ——
  // titlebar / 登录屏 / 右缘 rail
  'login-lang-caret': shell(caretDownSvg, { size: 10 }),
  'titlebar-sidebar-toggle': shell(sidebarSimpleSvg, { size: 18, cls: 'sidebar-toggle-icon-expanded' }),
  'titlebar-panel-toggle': shell(sidebarSimpleSvg, { size: 18 }),
  'titlebar-search': shell(magnifyingGlassSvg, { size: 18 }),
  'rail-side-task-new': shell(chatsSvg),
  'rail-monitor': shell(pulseSvg),
  'rail-workspace': shell(folderSvg),
  'rail-browser': shell(compassSvg),
  'rail-diff': shell(gitDiffSvg),
  'rail-terminal': shell(terminalWindowSvg),
  // 主侧栏导航（尺寸由 .sidebar-nav-item svg 控）
  'sb-nav-team-collaboration': shell(usersThreeSvg),
  'tc-team': shell(usersThreeSvg),
  'tc-projects': shell(foldersSvg),
  'tc-add': shell(plusSvg),
  'tc-close': shell(xSvg),
  'tc-warning': shell(warningSvg),
  'tc-more': shell(dotsThreeSvg),
  'tc-search': shell(magnifyingGlassSvg),
  'tc-refresh': shell(arrowClockwiseSvg),
  'tc-star': shell(starSvg),
  'tc-star-fill': shell(starFillSvg),
  'tc-filter': shell(funnelSvg),
  'tc-sort': shell(arrowsDownUpSvg),
  'tc-dice': shell(diceFiveSvg),
  'tc-check': shell(checkSvg),
  'tc-edit': shell(pencilSimpleSvg),
  'tc-attachment': shell(paperclipSvg),
  'tc-stop': shell(stopFillSvg),
  'tc-send': shell(arrowUpSvg),
  'tc-archive': shell(archiveSvg),
  'tc-folder': shell(folderSvg),
  'tc-code': shell(codeSvg),
  'tc-rocket': shell(rocketLaunchSvg),
  'tc-cube': shell(cubeSvg),
  'tc-sparkle': shell(sparkleSvg),
  'tc-globe': shell(globeSvg),
  'tc-book': shell(bookOpenSvg),
  'tc-lightning': shell(lightningSvg),
  'tc-lightning-fill': shell(lightningFillSvg),
  'tc-robot': shell(robotSvg),
  'tc-compass': shell(compassSvg),
  'tc-graph': shell(graphSvg),
  'tc-chat': shell(chatCircleSvg),
  'sb-nav-new-chat': shell(notePencilSvg),
  // Sidebar header controls (priority threads + sort menu): the activity
  // view toggle (bell = "needs attention") and the sort entry (arrows-down-up
  // = ordering) on a section head. Both are icon-only buttons sized by their
  // host surface (.artifacts-toggle-btn svg / .sidebar-section-action svg),
  // so the entries carry no sizing class of their own.
  'sidebar-activity': shell(bellSvg),
  'sidebar-sort': shell(arrowsDownUpSvg),
  'sb-nav-extensions': shell(puzzlePieceSvg, { cls: 'sidebar-nav-glyph' }),
  'sb-nav-extensions-caret': shell(caretRightSvg, { cls: 'sidebar-nav-caret' }),
  'sb-nav-mcp': shell(squaresFourSvg),
  'sb-nav-skills': shell(sparkleSvg),
  'sb-nav-plugins': shell(plugSvg),
  'sb-nav-agents': shell(robotSvg),
  'sb-nav-channels': shell(chatsSvg),
  'sb-nav-cron': shell(clockSvg),
  'sb-nav-memory': shell(moonSvg),
  'sb-nav-friends': shell(usersThreeSvg),
  // 用户区菜单
  'user-menu-settings': shell(gearSvg),
  'user-menu-theme': shell(circleHalfSvg),
  'user-menu-font': shell(textAaSvg),
  'user-menu-language': shell(globeSvg),
  'user-menu-logout': shell(signOutSvg),
  // Guest sign-in rows: the mirror of sign-out for the account door, plus the
  // two in-flight affordances (link copy / cancel) reusing the login screen's glyphs.
  'user-menu-login': shell(signInSvg),
  'user-menu-login-copy': shell(copySvg),
  'user-menu-login-cancel': shell(xSvg),
  'user-menu-arrow': shell(caretRightSvg, { cls: 'menu-arrow' }),
  // 整圆表盘（lucide circle-gauge）：缺口圆环 + 圆头指针 + 轴心。
  'sidebar-user-update': shell(downloadSimpleSvg),
  'sidebar-user-usage': lucideShell(circleGaugeSvg),
  'sidebar-user-gear': shell(gearSvg),
  // 主区 / composer
  'subagent-banner': shell(treeStructureSvg, { size: 13, cls: 'subagent-banner-icon' }),
  // 子智能体图标条：一格一个智能体，字形按派生方式区分（常驻队友 / fork /
  // 后台），颜色由渲染层按 agent 配色注入。
  'subagent-kind-teammate': shell(userSvg),
  'subagent-kind-fork': shell(gitForkSvg),
  'subagent-kind-background': shell(robotSvg),
  'workdir-folder': shell(folderSvg, { cls: 'workdir-icon' }),
  'workdir-caret': shell(caretDownSvg, { cls: 'workdir-caret' }),
  'workdir-clear': shell(xSvg),
  'composer-branch': shell(gitBranchSvg, { cls: 'branch-icon' }),
  'composer-branch-caret': shell(caretDownSvg, { cls: 'branch-caret' }),
  'slash-token': shell(packageSvg, { cls: 'slash-token-icon' }),
  'composer-plus': shell(plusSvg),
  // 回合胶囊的审查段：点下去就是 Changes 面板，所以跟面板 tab 的 diff 同一个字形。
  'action-dots-review': shell(gitDiffSvg, { size: 13 }),
  // 目标标识条的四颗动作键。裸形而非带圆圈版：这一行只有 12px，套上圆圈后
  // 内部的暂停/三角只剩几个像素，运行态与暂停态近看分不出来；清除用垃圾桶
  // 而不是 ×，因为这颗键删的是目标本身，不是“关掉这条提示”。
  'goal-edit': shell(pencilSimpleSvg, { size: 12 }),
  'goal-pause': shell(pauseSvg, { size: 12 }),
  'goal-resume': shell(playSvg, { size: 12 }),
  'goal-clear': shell(trashSvg, { size: 12 }),
  'goal-expand': shell(caretRightSvg, { size: 12 }),
  'voice-mic': shell(microphoneSvg, { cls: 'voice-icon-mic' }),
  'voice-waveform': shell(waveformSvg),
  'voice-stop': shell(stopFillSvg, { cls: 'voice-icon-stop' }),
  'voice-busy': shell(circleNotchSvg, { cls: 'voice-icon-busy' }),
  'send-arrow': shell(arrowUpSvg, { cls: 'icon-send' }),
  'send-stop': shell(stopFillSvg, { cls: 'icon-stop' }),
  // Composer primary button while the stop request is outstanding. The glyph
  // becomes a spinner and the button is disabled, so the second click of a
  // double-click cannot land as a second interrupt.
  'send-stopping': shell(circleNotchSvg, { cls: 'icon-stopping' }),
  // Composer primary button in continue mode: a stopped or failed Turn picks
  // back up. A play glyph, not the send arrow, so continuing never reads as
  // sending the draft again.
  'send-continue': shell(playSvg, { cls: 'icon-continue' }),
  'drop-overlay': shell(uploadSimpleSvg, { size: 48 }),
  // 右侧面板 chrome
  'panel-maximize-expand': shell(cornersOutSvg, { size: 18, cls: 'artifacts-maximize-icon artifacts-maximize-icon-expand' }),
  'panel-maximize-restore': shell(cornersInSvg, { size: 18, cls: 'artifacts-maximize-icon artifacts-maximize-icon-restore' }),
  'browser-nav-back': shell(caretLeftSvg),
  'browser-nav-forward': shell(caretRightSvg),
  'browser-nav-reload': shell(arrowClockwiseSvg),
  'browser-nav-screenshot': shell(cameraSvg),
  'ws-file-preview': shell(eyeSvg),
  'ws-file-source': shell(codeSvg),
  'ws-file-zoom-out': shell(magnifyingGlassMinusSvg),
  'ws-file-zoom-in': shell(magnifyingGlassPlusSvg),
  'ws-file-copy': shell(copySvg),
  'ws-file-reveal': shell(folderOpenSvg),
  // digram 面板工具栏：撚销/重做走弧形箭（与消息 rewind 的 u-turn 区分），缩放复用
  // 工作区那套放大镜，导出用 export 字形。
  'digram-undo': shell(arrowArcLeftSvg),
  'digram-redo': shell(arrowArcRightSvg),
  'digram-zoom-out': shell(magnifyingGlassMinusSvg),
  'digram-zoom-in': shell(magnifyingGlassPlusSvg),
  'digram-export': shell(exportSvg),
  // model3d 面板：取景复用 cube-focus（框住全部对象），网格复用 grid-four，
  // 大纲里相机/灯光/网格的字形分别用相机、灯泡、立方体——都是库字形，不手绘。
  'model3d-fit': shell(cubeFocusSvg),
  'model3d-grid': shell(gridFourSvg),
  'model3d-render': shell(cameraSvg),
  'model3d-light': shell(lightbulbSvg),
  'terminal-list-new': shell(plusSvg),
  // artifact 预览窗
  'aw-view-source': shell(codeSvg, { size: 14 }),
  'aw-view-preview': shell(eyeSvg, { size: 14 }),
  'aw-fileicon': shell(fileSvg, { size: 14, cls: 'aw-fileicon' }),
  'aw-copy': shell(copySvg),
  'aw-reveal': shell(folderOpenSvg),

  // —— 外部会话导入 ——
  'external-import-external-import-chats': shell(chatsSvg),
  'external-import-external-import-check': shell(checkSvg),
  'external-import-external-import-fallback-provider': shell(codeSvg),
  'external-import-external-import-folder': shell(folderSvg),
  'external-import-external-import-info': shell(infoSvg),
  'external-import-external-import-settings': shell(gearSvg),
}
