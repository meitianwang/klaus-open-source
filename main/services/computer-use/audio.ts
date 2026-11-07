import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deadline, number, object, string } from './types';
import type { ComputerUseHelperCommand } from '../../native/computer-use';

export interface AudioRecording {
  path: string; durationMs: number; sampleRate: number; channels: number; bytes: number; limitReached: boolean;
}
export interface CapturedAudio { recording: AudioRecording; data: Buffer; }
interface Active {
  sessionId: string; path: string; child: ChildProcessWithoutNullStreams; resourceId: string; operationId: string;
  started: Promise<void>; finished: Promise<AudioRecording>; settled: boolean; watchdog?: NodeJS.Timeout;
}
export interface ComputerUseAudioDependencies {
  command?: ComputerUseHelperCommand; root: string; available(): boolean; log(message: string): void;
}
const STARTED_MARKER = 'klaus-audio-recording-started';

/**
 * One host-owned capture child records system audio across two tool calls.
 * The helper finalizes a bounded WAV on its duration limit, on the framed
 * stop request, or on cancellation; a cancelled capture deletes its partial
 * file instead of leaving one behind. Only one recording can be active.
 */
export class ComputerUseAudioRecorder {
  private active?: Active;
  private readonly draining = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private readonly deps: ComputerUseAudioDependencies) {}

  start(sessionId: string, maxDurationMs: number, signal: AbortSignal): Promise<void> {
    string(sessionId, 'sessionId');
    number(maxDurationMs, 'max_duration_ms', 100, 300000, true);
    if (this.closing) return Promise.reject(new Error('Computer Use is shutting down'));
    if (!this.deps.available()) return Promise.reject(new Error('System audio recording requires the current native helper on this platform'));
    if (this.active) return Promise.reject(new Error('An audio recording is already active; call stop_audio_recording to retrieve it'));
    const command = this.deps.command;
    if (!command) return Promise.reject(new Error('Computer Use helper is missing'));
    let path: string;
    try { mkdirSync(this.deps.root, { recursive: true }); path = join(this.deps.root, `${randomUUID()}.wav`); }
    catch { return Promise.reject(new Error('Audio recording output could not be created')); }
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(command.executable, command.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: command.env ?? process.env }); }
    catch { rmSync(path, { force: true }); return Promise.reject(new Error('Computer Use helper failed to spawn')); }
    const resourceId = randomUUID(), operationId = randomUUID();
    let resolveStarted!: () => void, rejectStarted!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    let resolveFinished!: (value: AudioRecording) => void, rejectFinished!: (error: Error) => void;
    const finished = new Promise<AudioRecording>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
    const active: Active = { sessionId, path, child, resourceId, operationId, started, finished, settled: false };
    // A dead capture must not strand the single-active slot or reject unhandled.
    void finished.catch(() => { if (this.active === active) this.active = undefined; });
    let stderrBytes = 0, startedSettled = false;
    const failStart = (error: Error) => {
      if (startedSettled) return; startedSettled = true;
      signal.removeEventListener('abort', abortStart); clearTimeout(startTimer);
      child.kill('SIGKILL'); rmSync(path, { force: true });
      if (this.active === active) this.active = undefined;
      rejectStarted(error);
    };
    const abortStart = () => failStart(new Error('Audio recording start was cancelled'));
    const startTimer = setTimeout(() => failStart(new Error('System audio capture did not start in time')), 10_000);
    signal.addEventListener('abort', abortStart, { once: true });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) { child.stderr.removeAllListeners('data'); return; }
      if (!startedSettled && String(chunk).includes(STARTED_MARKER)) {
        startedSettled = true; signal.removeEventListener('abort', abortStart); clearTimeout(startTimer); resolveStarted();
      }
    });
    child.once('error', () => failStart(new Error('Computer Use helper failed to spawn')));
    child.once('close', () => failStart(new Error('System audio capture ended before it started')));
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
      if (stdout.length > 1024 * 1024) { stdout = ''; child.kill('SIGKILL'); }
    });
    child.once('close', () => {
      active.settled = true;
      if (active.watchdog) clearTimeout(active.watchdog);
      try {
        const response = object(JSON.parse(stdout), 'native audio response');
        if (response.resourceId !== resourceId || response.operationId !== operationId
          || response.generation !== 1 || response.sequence !== 1) throw new Error('Computer Use native response identity mismatch');
        if (response.ok !== true) throw new Error(typeof response.error === 'string' ? response.error.slice(0, 2048) : 'Computer Use native operation failed');
        const result = object(response.result, 'audio recording result');
        if (string(result.path, 'audio path') !== path) throw new Error('Audio recording returned an unexpected file');
        resolveFinished({ path,
          durationMs: number(result.durationMs, 'audio duration', 0, 300_000, true),
          sampleRate: number(result.sampleRate, 'audio sample rate', 1, 1_000_000, true),
          channels: number(result.channels, 'audio channels', 1, 8, true),
          bytes: number(result.bytes, 'audio size', 44, 64 * 1024 * 1024, true),
          limitReached: result.limitReached === true });
      } catch (error) {
        rmSync(path, { force: true });
        rejectFinished(error instanceof Error ? error : new Error('Computer Use native audio result is invalid'));
      }
    });
    child.once('error', () => { /* close settles the result */ });
    active.watchdog = setTimeout(() => {
      this.deps.log('audio capture watchdog killed the helper child');
      child.kill('SIGKILL');
    }, maxDurationMs + 20_000);
    this.active = active;
    const payload = JSON.stringify({ resourceId, operationId, generation: 1, sequence: 1,
      method: 'recordAudio', args: { path, maxDurationMs } });
    child.stdin.on('error', () => { /* a broken pipe settles through close */ });
    child.stdin.write(payload + '\n');
    const tracked = started.catch(error => { this.deps.log(String(error)); throw error; });
    this.draining.add(tracked); void tracked.catch(() => {}).finally(() => this.draining.delete(tracked));
    return started;
  }

  async stop(sessionId: string, signal: AbortSignal): Promise<CapturedAudio> {
    const active = this.active;
    if (!active) throw new Error('No audio recording is active; call start_audio_recording first');
    if (active.sessionId !== sessionId) throw new Error('The audio recording belongs to another session');
    signal.throwIfAborted();
    if (!active.settled && active.child.stdin.writable) active.child.stdin.write('{"stop":true}\n');
    let recording: AudioRecording;
    try {
      recording = await this.race(active.finished, signal, active);
    } catch (error) {
      // A cancelled retrieval must not strand the capture child or its file.
      void this.discard(active);
      throw error;
    }
    if (this.active === active) this.active = undefined;
    let data: Buffer;
    try {
      data = readFileSync(recording.path);
      if (data.length !== recording.bytes) throw new Error('Audio recording file does not match its reported size');
    } catch (error) {
      rmSync(recording.path, { force: true });
      throw error instanceof Error ? error : new Error('Audio recording could not be read');
    }
    rmSync(recording.path, { force: true });
    return { recording, data };
  }

  /** Best-effort graceful stop used when the owning session goes away. */
  async release(sessionId: string): Promise<void> {
    const active = this.active;
    if (!active || active.sessionId !== sessionId) return;
    await this.discard(active);
  }

  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closing = true;
    const active = this.active;
    if (active) await this.discard(active).catch(() => {});
    const drained = await deadline(Promise.allSettled([...this.draining]), deadlineMs);
    return { complete: drained && !this.active && !this.draining.size };
  }

  private async race(task: Promise<AudioRecording>, signal: AbortSignal, active: Active): Promise<AudioRecording> {
    if (signal.aborted) throw new Error('Audio recording retrieval was cancelled');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([task, new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('Audio recording retrieval was cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { signal.removeEventListener('abort', abort); reject(new Error('Audio recording did not finish in time')); }, 20_000);
        void active;
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async discard(active: Active): Promise<void> {
    if (this.active === active) this.active = undefined;
    if (!active.settled && active.child.stdin.writable) active.child.stdin.write('{"stop":true}\n');
    const settled = await deadline(active.finished.then(() => undefined, () => undefined), 10_000);
    if (!settled) active.child.kill('SIGKILL');
    if (active.watchdog) clearTimeout(active.watchdog);
    rmSync(active.path, { force: true });
  }
}
