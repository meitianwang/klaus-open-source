import { createRoot } from 'react-dom/client'
import { GoalEditor, GoalProgressRow } from './components'
import { GoalEditorController } from './editor-state'
import { reviewGoalResume } from './draft-review'
import type { GoalSnapshot } from './types'
import { mountSlashMenu } from '../composer/slash-menu'
import { queryClient } from '../../app/query-client'
import { activateGoalShortcut, withGoalShortcut } from '../composer/goal-shortcut'
import { goalSurfaceEligible, removeSideWorkflowControls } from '../composer/workflow-surface'
import { t } from '../../i18n'

const fixtureWindow = window as typeof window & { tt: typeof t; goalInteractionFixture: unknown; currentLang: string }
fixtureWindow.currentLang = 'en'
fixtureWindow.tt = t
document.body.innerHTML = `<main><div id="editor"></div><div id="resume-fixture"></div><div id="restricted-goal"></div><div id="restricted-editor"></div><section id="input-wrapper"><button id="composer-plus-btn">+</button><textarea id="input"></textarea><div id="slash-menu"></div><div id="goal-indicator">Current goal</div><button id="goal-mode-badge">Goal</button><div id="planning-input-panel"></div></section><section id="side-host"></section></main>`
const goal: GoalSnapshot = { goalId: 'fixture-goal', threadId: 'fixture-thread', objective: 'Original objective', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAtMs: 1, updatedAtMs: Date.now() }
const controller = new GoalEditorController(goal)
const saves: string[] = []
const root = createRoot(document.getElementById('editor')!)
root.render(<GoalEditor goal={goal} controller={controller} onSave={async (objective, target) => {
  saves.push(objective)
  return { ...target, objective, updatedAtMs: Date.now() }
}} />)

const savedReference = 'Read the complete goal objective from this Klaus-owned file: /owned/goal/objective.md'
const fullResumeObjective = 'Saved complete objective\nReview every acceptance criterion before continuing.'
let resumeGoal: GoalSnapshot = { ...goal, goalId: 'resume-goal', objective: savedReference, status: 'paused', objectiveMaterialized: true, revision: 4 }
let resumes = 0
const resumeRoot = createRoot(document.getElementById('resume-fixture')!)
function renderResume() {
  resumeRoot.render(<GoalProgressRow goal={resumeGoal} onOpen={() => {}} onPause={async () => {}} onClear={async () => {}}
    onReviewResume={target => reviewGoalResume({ goal: target, valid: () => true, readGoal: async () => resumeGoal,
      currentGoal: () => resumeGoal, readObjective: async source => {
        if (source.objective !== savedReference) throw new Error('The saved objective binding changed')
        return fullResumeObjective
      },
    })}
    onResume={async target => {
      if (target.objective !== savedReference) throw new Error('The reviewed source binding was replaced by display text')
      resumes++; resumeGoal = { ...resumeGoal, status: 'active' }; renderResume()
    }} />)
}
renderResume()

const restrictedController = new GoalEditorController({ ...goal, goalId: 'restricted-goal', objective: 'Legacy saved objective' })
const restrictedSaves: string[] = []
let restrictedPauses = 0, restrictedClears = 0, restrictedResumes = 0, restrictedOpens = 0
const restrictedEditorRoot = createRoot(document.getElementById('restricted-editor')!)
restrictedEditorRoot.render(<GoalEditor goal={restrictedController.getSnapshot().goal!} controller={restrictedController} readOnly onSave={async (objective, target) => {
  restrictedSaves.push(objective); return { ...target, objective }
}} />)
let restrictedGoal = restrictedController.getSnapshot().goal!
const restrictedRoot = createRoot(document.getElementById('restricted-goal')!)
function renderRestrictedGoal() {
  restrictedRoot.render(<GoalProgressRow goal={restrictedGoal} canPursue={false} onOpen={() => { restrictedOpens++ }}
    onPause={async () => { restrictedPauses++; restrictedGoal = { ...restrictedGoal, status: 'paused' }; renderRestrictedGoal() }}
    onResume={async () => { restrictedResumes++ }} onClear={async () => { restrictedClears++; restrictedRoot.render(null) }} />)
}
renderRestrictedGoal()
let menuEligible = true

const side = document.getElementById('input-wrapper')!.cloneNode(true) as HTMLElement
side.id = 'side-input-wrapper'
side.querySelectorAll<HTMLElement>('[id]').forEach(element => { element.id = `side-${element.id}` })
removeSideWorkflowControls(side)
document.getElementById('side-host')!.append(side)
let goalEnabled = false, toggles = 0
const menu = mountSlashMenu(document.getElementById('slash-menu'), {
  commandIconSvg: () => '', slashCommandDescription: () => '', slashCommandDisplayName: command => command.name === 'goal' ? t('composer_goal') : command.displayName || command.name,
  slashCommandGroupLabel: key => key, commandGroupKey: () => 'shortcuts', folderIconSvg: () => '', fileIconSvg: () => '',
  pluginIconSvg: () => '', deviceIconHtml: () => '', categoryIconHtml: () => '', conversationIconHtml: () => '',
  openFileSearchSession: () => null,
  contextCommands: async () => goalSurfaceEligible({ threadSource: menuEligible ? 'user' : 'friend' }, false) ? withGoalShortcut([], t('composer_goal')) : [],
  onMentionMenuEmpty: () => {}, onSelectCommand: () => {},
  onSelectMention: entry => { if (entry.command) { toggles++; goalEnabled = !goalEnabled; menu?.hide() } },
}, { wrapper: document.getElementById('input-wrapper')!, input: document.getElementById('input')! })
if (!menu) throw new Error('Composer menu fixture did not mount')
fixtureWindow.goalInteractionFixture = {
  snapshot: () => ({ restrictedText: restrictedController.getSnapshot().text, restrictedSaves: [...restrictedSaves], restrictedPauses, restrictedClears, restrictedResumes, restrictedOpens, resumes, fullResumeObjective, text: controller.getSnapshot().text, saves: [...saves], toggles, goalEnabled, menuOpen: menu.isOpen(),
    editorMenus: document.querySelectorAll('#editor [role="listbox"], #editor .cm-tooltip-autocomplete, #editor input[type="file"]').length,
    sideWorkflowControls: side.querySelectorAll('#side-slash-menu, #side-composer-plus-menu, #side-goal-indicator, #side-goal-mode-badge, #side-planning-input-panel').length,
  }),
  restrictMenu: () => { menuEligible = false; queryClient.removeQueries({ queryKey: ['composer-context-commands'] }) },
  advanceResumeAccounting: () => { resumeGoal = { ...resumeGoal, tokensUsed: 99, revision: 5 }; renderResume() },
  openMenu: () => menu.showMention({ sessionId: 'fixture-menu', query: '', scope: null, activation: 'synthetic' }), closeMenu: () => menu.hide(),
  activateSlash: async (sessionId: string | null) => {
    fixtureWindow.currentSessionId = sessionId
    let draft = '/goal Complete the authored objective', armed = false, enableCalls = 0
    const activated = await activateGoalShortcut({ sessionId: () => fixtureWindow.currentSessionId, enabled: () => armed,
      enable: async () => { enableCalls++; armed = true; return true }, readDraft: () => draft,
      replaceDraft: value => { draft = value },
    }, { start: 0, end: 5 })
    return { activated, draft, armed, enableCalls, sessionId: fixtureWindow.currentSessionId }
  },
}
