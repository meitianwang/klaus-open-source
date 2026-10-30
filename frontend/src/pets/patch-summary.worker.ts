import type { PetAttention } from "../../../contracts/desktop-pet-attention";
import { patchSummary } from "./patch-summary";

self.onmessage = (
  event: MessageEvent<Extract<PetAttention, { kind: "approval" }>>,
) => {
  try {
    self.postMessage({ summary: patchSummary(event.data) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
