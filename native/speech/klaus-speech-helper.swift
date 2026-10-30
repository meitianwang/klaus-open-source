// Narrow macOS ASR helper. The renderer owns microphone capture; stdin is
// 16 kHz mono s16le PCM and stdout is bounded NDJSON. EOF drains recognition,
// SIGTERM cancels, and a terminal event seals all subsequent callbacks.
import Foundation
import Speech
import AVFoundation
import Darwin

let stateLock = NSLock()
let done = DispatchSemaphore(value: 0)
var finished = false
var lastPartial = ""
var endedInput = false
var status: Int32 = 0
var sequence = 0
var recognitionTask: SFSpeechRecognitionTask?

func emitLocked(_ event: [String: Any]) {
    var payload = event
    sequence += 1
    payload["seq"] = sequence
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

func finish(_ event: [String: Any]?, code: Int32) {
    stateLock.lock()
    guard !finished else { stateLock.unlock(); return }
    finished = true
    status = code
    if let event { emitLocked(event) }
    stateLock.unlock()
    done.signal()
}

func fail(_ code: String, _ message: String) {
    finish(["type": "error", "code": code, "message": String(message.prefix(500))], code: 1)
}

func waitWithRunLoop(_ semaphore: DispatchSemaphore, timeout: TimeInterval) -> Bool {
    // Speech delivers recognition callbacks on the main queue by default.
    // Blocking that queue also blocks every partial and final result.
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while semaphore.wait(timeout: .now()) == .timedOut {
        if ProcessInfo.processInfo.systemUptime >= deadline { return false }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
    }
    return true
}

var localeArgument = ""
var hotwords: [String] = []
var preferOnDevice = false
var probe = false
var arguments = Array(CommandLine.arguments.dropFirst())
while !arguments.isEmpty {
    switch arguments.removeFirst() {
    case "--locale":
        guard !arguments.isEmpty else { fail("invalid-arguments", "Missing locale"); exit(1) }
        localeArgument = arguments.removeFirst()
    case "--hotwords":
        guard !arguments.isEmpty,
              let data = arguments.removeFirst().data(using: .utf8),
              let parsed = try? JSONDecoder().decode([String].self, from: data),
              parsed.count <= 50, parsed.allSatisfy({ $0.count <= 48 }) else {
            fail("invalid-arguments", "Invalid hotwords"); exit(1)
        }
        hotwords = parsed
    case "--prefer-on-device": preferOnDevice = true
    case "--probe": probe = true
    default: fail("invalid-arguments", "Unknown argument"); exit(1)
    }
}

let recognizer = localeArgument.isEmpty ? SFSpeechRecognizer() : SFSpeechRecognizer(locale: Locale(identifier: localeArgument))
let authorization = SFSpeechRecognizer.authorizationStatus()
if probe {
    finish(["type": "capabilities", "authorization": authorization.rawValue,
            "available": recognizer?.isAvailable ?? false,
            "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
            "sampleRate": 16000, "channels": 1, "format": "s16le"], code: 0)
    exit(0)
}

signal(SIGTERM, SIG_IGN)
signal(SIGPIPE, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .userInitiated))
termination.setEventHandler {
    finish(nil, code: 2)
    recognitionTask?.cancel()
    // This also interrupts a pending authorization dialog or a blocked stdin read.
    exit(2)
}
termination.resume()

if authorization != .authorized {
    let authorizationDone = DispatchSemaphore(value: 0)
    let authorizationLock = NSLock()
    var granted = false
    if authorization == .notDetermined {
        SFSpeechRecognizer.requestAuthorization { value in
            authorizationLock.lock(); granted = value == .authorized; authorizationLock.unlock()
            authorizationDone.signal()
        }
        _ = waitWithRunLoop(authorizationDone, timeout: 60)
    }
    authorizationLock.lock(); let allowed = granted; authorizationLock.unlock()
    guard allowed else { fail("speech-permission-denied", "Speech recognition permission is unavailable"); exit(1) }
}
guard let recognizer, recognizer.isAvailable else {
    fail("recognizer-unavailable", "System speech recognition is unavailable for this locale"); exit(1)
}
guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true) else {
    fail("format-unavailable", "Cannot create 16 kHz mono Int16 audio"); exit(1)
}
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.contextualStrings = hotwords
if preferOnDevice && recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
recognitionTask = recognizer.recognitionTask(with: request) { result, error in
    if let result {
        let transcript = String(result.bestTranscription.formattedString.prefix(12000))
        if result.isFinal { finish(["type": "final", "text": transcript], code: 0) }
        else {
            stateLock.lock()
            if !finished { lastPartial = transcript; emitLocked(["type": "partial", "text": transcript]) }
            stateLock.unlock()
        }
    } else if error != nil {
        stateLock.lock(); let fallback = endedInput ? lastPartial : ""; stateLock.unlock()
        if fallback.isEmpty { fail("recognition-failed", "System speech recognition failed") }
        else { finish(["type": "final", "text": fallback], code: 0) }
    }
}
stateLock.lock()
if !finished { emitLocked(["type": "ready"]) }
stateLock.unlock()

func appendAudio(_ data: Data) {
    guard data.count % 2 == 0 else { fail("invalid-pcm", "PCM ends with an incomplete sample"); return }
    let frames = AVAudioFrameCount(data.count / 2)
    guard frames > 0 else { return }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
          let destination = buffer.int16ChannelData?[0] else { fail("audio-buffer-failed", "Cannot allocate PCM buffer"); return }
    buffer.frameLength = frames
    data.withUnsafeBytes { raw in
        if let source = raw.baseAddress { memcpy(destination, source, data.count) }
    }
    stateLock.lock()
    if !finished { request.append(buffer) }
    stateLock.unlock()
}

DispatchQueue(label: "ai.klaus.speech.pcm").async {
    var pending = Data()
    var total = 0
    while true {
        stateLock.lock(); let stopped = finished; stateLock.unlock()
        if stopped { return }
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { break }
        total += chunk.count
        if total > 16000 * 2 * 5 * 60 { fail("audio-overflow", "Recording exceeds five minutes"); return }
        pending.append(chunk)
        while pending.count >= 3200 {
            appendAudio(Data(pending.prefix(3200))); pending.removeFirst(3200)
        }
    }
    if !pending.isEmpty { appendAudio(pending) }
    stateLock.lock(); endedInput = true; let stopped = finished; stateLock.unlock()
    if stopped { return }
    request.endAudio()
    DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
        stateLock.lock(); let fallback = lastPartial; stateLock.unlock()
        if fallback.isEmpty { fail("no-final-result", "Recognizer produced no final result before timeout") }
        else { finish(["type": "final", "text": fallback], code: 0) }
    }
}
if !waitWithRunLoop(done, timeout: 315) { fail("recognition-timeout", "Recognition exceeded its deadline") }
recognitionTask?.cancel()
stateLock.lock(); let exitStatus = status; stateLock.unlock()
exit(exitStatus)
