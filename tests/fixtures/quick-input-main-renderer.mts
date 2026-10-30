import '../../frontend/bridge/klaus-api'
const page = window as any
const received: Array<{ text: string; submissionId: string }> = [], ids = new Set<string>()
page.klaus.on.quickInputSubmit((value: { text: string; submissionId: string }) => {
  if (ids.has(value.submissionId)) return
  ids.add(value.submissionId); received.push(value)
  document.getElementById('submitted')!.textContent = value.text
})
page.mainFixture = { received }
