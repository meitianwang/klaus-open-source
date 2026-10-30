import type { AgentTask } from './engine-events'

/** Fold an early lifecycle-discovered identity into its later task-call key. */
export function coalesceSubagentTaskAliases(tasks: Record<string, AgentTask>): Record<string, AgentTask> {
  const result = { ...tasks }
  for (const [taskId, task] of Object.entries(result)) {
    const agentId = task.agentId
    const alias = agentId && result[agentId]
    if (agentId && taskId !== agentId && alias && (!alias.agentId || alias.agentId === agentId)) {
      result[taskId] = { ...alias, ...task }
      delete result[agentId]
    }
  }
  return result
}

type ConversationNavigation = {
  selectedSessionId: () => string
  tasks: (sessionId: string) => Record<string, AgentTask>
  snapshot: (sessionId: string) => Promise<{ tasks?: Record<string, AgentTask> } | null | undefined>
  merge: (sessionId: string, tasks: Record<string, AgentTask>) => void
  open: (taskId: string) => void
  unavailable: () => void
}

/** A real child can precede the task cache. Hydrate through the existing facade. */
export async function navigateToSubagentConversation(conversationId: string, navigation: ConversationNavigation): Promise<void> {
  const sessionId = navigation.selectedSessionId()
  if (!sessionId || !conversationId) return
  const find = () => Object.entries(navigation.tasks(sessionId)).find(([taskId, task]) => (task.agentId || taskId) === conversationId)
  const registered = find()
  if (registered) { navigation.open(registered[0]); return }
  try {
    const snapshot = await navigation.snapshot(sessionId)
    if (navigation.selectedSessionId() !== sessionId) return
    navigation.merge(sessionId, snapshot?.tasks || {})
    const discovered = find()
    if (discovered) navigation.open(discovered[0])
    else navigation.unavailable()
  } catch {
    if (navigation.selectedSessionId() === sessionId) navigation.unavailable()
  }
}
