const alerts: string[] = [], focuses: unknown[] = [], sources: AudioContext[] = []
let delay = false, release: (() => void) | undefined, stream: MediaStream | undefined
const page = window as any
page.alert = (message: unknown) => { alerts.push(String(message)) }
page.klausQuickInput.onFocus((value: unknown) => { focuses.push(value) })
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
  const context = new AudioContext(), oscillator = context.createOscillator(), destination = context.createMediaStreamDestination()
  sources.push(context); oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start(); await context.resume()
  stream = destination.stream
  if (delay) await new Promise<void>(resolve => { release = resolve })
  return destination.stream
} })
page.quickFixture = {
  alerts, focuses,
  state: () => document.getElementById('qi-mic')?.dataset.voiceState,
  clickMic: () => document.getElementById('qi-mic')?.click(),
  delay: () => { delay = true }, release: () => { delay = false; release?.() },
  hasPendingStream: () => !!release, trackState: () => stream?.getAudioTracks()[0]?.readyState,
  close: () => Promise.all(sources.map(context => context.close())),
}
