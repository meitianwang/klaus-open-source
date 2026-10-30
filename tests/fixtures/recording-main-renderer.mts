import '../../frontend/bridge/klaus-api'
import { createRecordingHandoff } from '../../frontend/src/chat/recording-handoff'
const page = window as any
const sends: string[] = [], failures: string[] = [], completed: string[] = [], discards: string[] = []
const handoff = createRecordingHandoff({
  hasSession: id => id === 'creator',
  send: async id => { await new Promise(resolve => setTimeout(resolve, 30)); sends.push(id) },
  discarded: () => { discards.push('discarded') },
  failed: message => { failures.push(message) },
})
page.klaus.on.recordEnded(async (value: any) => {
  try { await handoff(value); completed.push(value.recordingId) }
  catch (error) { failures.push(String(error)) }
})
page.recordingFixture = { sends, failures, completed, discards, currentSessionId: 'different-active-session', handoff }
