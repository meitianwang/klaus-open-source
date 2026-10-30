# Voice input slice

`main/services/voice/service.ts` owns voice business work. Register it with
`registerVoiceHandlers(registry, service)`, then attach the trusted main or
quick-input WebContents id with `attachOwner(id)`. The existing role contract
still restricts quick-input to its two voice calls.

Required main-process dependencies are `configRoot`, `listModels(signal)`,
`readModelCredential(id, signal)`, `micPermission(ownerId, signal)`, and
`deliver(ownerId, 'voice:session:event', payload)`. The model credential resolver
uses the engine's named `model/credential/read` facade and returns only the key
to this main-process service. Metadata must retain its `authType`/provider; only
API-key BYO records qualify. The service never writes model credentials. It
reads an existing dedicated `voice.transcribe.apiKey` setting for compatibility.

Use `microphonePermission(systemPreferences, signal)` for OS permission. The
application's Chromium permission handlers must separately restrict `media` to
audio requested by an attached trusted top frame. Do not allow camera or remote
content. Windows checks its actual OS privacy status and uses cloud transcription;
no Windows system-ASR capability is claimed. macOS calls `askForMediaAccess` only
when microphone access has not been decided. OS dialogs cannot be forcibly
dismissed: cancellation seals the result and reports incomplete until their
actual promise settles. The main executable needs microphone and speech usage
descriptions and the audio-input signing entitlement. The helper also embeds its
speech usage description and preserves `ai.klaus.desktop.speech-helper`.

The sixteen existing channels keep their names and data shapes. New optional
`operationId` binds microphone/start/transcribe requests to cancellation;
`session:audio` now invokes and waits for pipe write completion. Input `seq`
starts at 1. Pushes include `sessionId`, `operationId`, owner `generation`, and
monotonic `seq`, followed by the existing partial/final/error fields. Start
resolves after the helper reports ready. The renderer stops its worklet, flushes
the short final frame, waits for audio acknowledgements, and then closes stdin.
Four outstanding frames bound audio transfer; overflow fails the operation.
No audio bytes are silently omitted. Recognition is limited to five minutes.

`detachOwner(id, deadlineMs)` and `shutdown(deadlineMs)` return `{complete}`.
They seal new work, abort HTTP/model/learning tasks, kill owned helpers, and wait
for physical subprocess exit and all in-flight delivery promises. A false report
must not be treated as successful shutdown or permission to reuse an owner.
Repeated closes resume waiting; reattachment is refused while work remains.
The renderer also cancels on Escape, document hide and pagehide, releasing its
microphone tracks synchronously before asynchronous teardown.

Existing hotwords, memories and `voice_history` remain in `settings.db`. Mutations
use transactions and preserve malformed stores rather than overwriting them as
empty. History uses the existing retention setting (default thirty days).
Learning runs in a tracked bounded task; cancellation before its result prevents
preference writes. Cloud transcription retains its prior direct-text behavior;
system recognition additionally performs optional polish and history recording.

Build the narrow macOS helper with:

```
node apps/desktop/native/speech/build.mjs [absolute-output-directory]
```

Default output is `native/artifacts/speech/darwin-<arch>/klaus-speech-helper`.
The build uses Swift warnings as errors, re-signs the embedded plist, verifies the
signature, and writes SHA256/source/compiler/Git metadata. The integration and
packaging layer supplies the resulting absolute `helperPath`; this script does
not modify the shared engine staging directory. `--probe` reports actual Speech
framework capabilities and authorization status without prompting or capturing
audio. On-device recognition is preferred when supported; system recognition
may otherwise use Apple's network service.

Validation commands (after both desktop/frontend dependencies are installed):

```
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
npm run typecheck --prefix apps/tauri
npm run build:frontend --prefix apps/tauri
node apps/desktop/scripts/run-voice-test.mjs
npm run desktop:audit:command-map
```

The test helper is a separate fixture subprocess supplied only by main-process
dependency injection. The normal Electron gate uses the production renderer
voice module, bridge, sandboxed preload, router, handlers and AudioWorklet with a
synthetic oscillator stream. It never records the user's microphone or triggers
an OS permission prompt. Live spoken recognition under the final signed product
remains a manual permission/device acceptance check; the synthetic fixture does
not claim to validate Apple's recognition quality.

Record & Replay's computer-use recording panel and the global quick-input window
are separate pending slices. This slice does not claim all of P2 is complete.
