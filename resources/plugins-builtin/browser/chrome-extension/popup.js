const statusPill = document.getElementById('status-pill')
const statusLabel = document.getElementById('status-label')
const statusMessage = document.getElementById('status-message')
const statusDetails = document.getElementById('status-details')

refreshStatus()

chrome.storage?.local?.get?.('NATIVE_HOST_STATUS')
  .then(value => {
    if (value?.NATIVE_HOST_STATUS) renderStatus(value.NATIVE_HOST_STATUS)
  })
  .catch(() => {})

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area === 'local' && changes.NATIVE_HOST_STATUS?.newValue) {
    renderStatus(changes.NATIVE_HOST_STATUS.newValue)
  }
})

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'GET_NATIVE_HOST_STATUS' })
    .then(response => {
      if (response?.status) renderStatus(response.status)
      else renderStatus({ state: 'disconnected', error: response?.error })
    })
    .catch(error => {
      renderStatus({ state: 'disconnected', error: normalizeError(error) })
    })
}

function renderStatus(status) {
  const connected = status?.state === 'connected'
  statusPill.classList.toggle('connected', connected)
  statusPill.classList.toggle('disconnected', !connected)
  statusLabel.textContent = connected ? 'Connected' : 'Disconnected'
  statusMessage.textContent = connected ? 'Control Chrome with Klaus.' : 'Use the Chrome plugin in Klaus to connect.'
  const version = chrome.runtime.getManifest().version
  const host = typeof status?.hostName === 'string' ? status.hostName : 'Not available'
  statusDetails.textContent = `Host: ${host} - Version v${version}`
}

function normalizeError(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error ?? 'Unknown error')
}
