import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Local usage ledger file; JSON lines, bounded, never uploaded anywhere. */
export const COMPUTER_USE_TELEMETRY_FILE = 'computer-use-telemetry.jsonl';
/** Setting this environment variable to `1` skips every ledger write. */
export const COMPUTER_USE_TELEMETRY_DISABLED_ENV = 'KLAUS_COMPUTER_USE_DISABLE_TELEMETRY';
export const COMPUTER_USE_TELEMETRY_MAX_BYTES = 512 * 1024;
/** The aligned usage-event surface: server launch, app approval request and resolution, tool call. */
export const COMPUTER_USE_TELEMETRY_EVENTS = {
  serverLaunched: 'computer_use_server_launched',
  appApprovalRequested: 'computer_use_app_approval_requested',
  appApprovalResolved: 'computer_use_app_approval_resolved',
  toolCalled: 'computer_use_tool_called',
} as const;

/** The narrow write side policy and runtime hooks consume; keeps producers testable. */
export interface ComputerUseTelemetrySink {
  record(fields: Record<string, unknown>): void;
}

export interface ComputerUseTelemetryOptions {
  maxBytes?: number;
  log?: (message: string) => void;
}

/**
 * A local-only usage ledger for Computer Use. Events are appended as JSON lines
 * under the config root so diagnostics stay on this machine; the ledger never
 * contacts a network and never throws into a tool path. When the file exceeds
 * its byte cap it rotates to a single `.previous` generation, bounding disk use.
 */
export class ComputerUseTelemetry implements ComputerUseTelemetrySink {
  private failed = false;
  constructor(private readonly root: string, private readonly options: ComputerUseTelemetryOptions = {}) {}

  record(fields: Record<string, unknown>): void {
    if (this.failed || process.env[COMPUTER_USE_TELEMETRY_DISABLED_ENV] === '1') return;
    try {
      mkdirSync(this.root, { recursive: true });
      const path = join(this.root, COMPUTER_USE_TELEMETRY_FILE);
      const maxBytes = this.options.maxBytes ?? COMPUTER_USE_TELEMETRY_MAX_BYTES;
      let size = 0;
      try { size = statSync(path).size; } catch { /* A missing ledger simply starts empty. */ }
      if (size >= maxBytes) {
        try { renameSync(path, `${path}.previous`); } catch { /* Rotation is best-effort. */ }
      }
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`);
    } catch (error) {
      // A broken ledger must never break Computer Use; report once and stay silent.
      this.failed = true;
      try { this.options.log?.(`telemetry ledger write failed: ${String(error)}`); } catch { /* logging is best-effort */ }
    }
  }
}
