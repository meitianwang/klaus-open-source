import { useEffect, useState } from "react";
import type { PetAttention } from "../../../contracts/desktop-pet-attention";
import {
  needsPatchWorker,
  patchSummary,
  type PatchSummary,
} from "./patch-summary";

export function usePatchSummary(attention: PetAttention) {
  const requestKey = `${attention.kind}:${attention.id}`;
  const [result, setResult] = useState<{
    requestKey: string;
    summary: PatchSummary | null;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (attention.kind !== "approval") {
      setResult({ requestKey, summary: null });
      return;
    }
    if (!needsPatchWorker(attention)) {
      setResult({ requestKey, summary: patchSummary(attention) });
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL("./patch-summary.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (error) {
      setResult({ requestKey, summary: null, error: String(error) });
      return;
    }
    let current = true;
    worker.onmessage = (
      event: MessageEvent<{ summary?: PatchSummary | null; error?: string }>,
    ) => {
      if (current)
        setResult({
          requestKey,
          summary: event.data.summary ?? null,
          error: event.data.error,
        });
      worker.terminate();
    };
    worker.onerror = (event) => {
      if (current) setResult({ requestKey, summary: null, error: event.message });
      worker.terminate();
    };
    worker.postMessage(attention);
    return () => {
      current = false;
      worker.terminate();
    };
    // Request payloads are immutable; task state pushes must not restart large calculations.
  }, [requestKey]);
  return {
    summary: result?.requestKey === requestKey ? result.summary : null,
    error: result?.requestKey === requestKey ? result.error : undefined,
    pending:
      attention.kind === "approval" &&
      Boolean(attention.patch || attention.fileChanges?.length) &&
      result?.requestKey !== requestKey,
  };
}
