import type { PlanDocument, PlanIdentity, PlanningSnapshot } from '../../../../contracts/planning-goals'
export type { CollaborationMode, ProposedPlan, ProgressPlan, PlanningSnapshot, PlanIdentity, PlanDocument } from '../../../../contracts/planning-goals'
export interface PlanningApi {
  get(sessionId: string): Promise<{ planning: PlanningSnapshot }>
  readDocument(sessionId: string, identity: PlanIdentity): Promise<{ planning: PlanningSnapshot; document: PlanDocument }>
  saveDocument(sessionId: string, document: PlanIdentity & { content: string; expectedContent?: string }): Promise<{ planning: PlanningSnapshot; document: PlanDocument }>
  accept(sessionId: string, document: PlanIdentity & { content: string; clientRequestId: string }): Promise<{ planning: PlanningSnapshot; accepted?: boolean }>
  feedback(sessionId: string, feedback: PlanIdentity & { feedback: string; clientRequestId: string }): Promise<{ planning: PlanningSnapshot; accepted?: boolean }>
  cancel(sessionId: string, identity: PlanIdentity): Promise<{ planning: PlanningSnapshot }>
}
