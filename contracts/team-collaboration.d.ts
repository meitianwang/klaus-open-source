export type CollaborationRole = "owner" | "admin" | "member";
export type CollaborationIssueStatus = "backlog" | "todo" | "active" | "review" | "done" | "cancelled";
export type CollaborationPriority = "none" | "urgent" | "high" | "medium" | "low";
export type CollaborationExecutionStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type CollaborationMessageSource = "human" | "agent" | "execution";
export interface CollaborationUser { id: string; displayName: string; avatarUrl: string | null }
export interface CollaborationProject {
  id: string; name: string; description: string; identifier: string; coverIcon: string; coverColor: string;
  repositoryUrl: string | null; createdBy: string; createdAt: string; updatedAt: string; archivedAt: string | null;
  version: number; role: CollaborationRole; memberCount: number;
}
export interface CollaborationAgent {
  id: string; ownerId: string; name: string; description: string; avatarUrl: string | null;
  runtimeReference: string | null;
  createdAt: string; updatedAt: string; version: number;
}
export interface CollaborationMember {
  id: string; projectId: string; kind: "human" | "agent"; userId: string; agentId: string | null;
  role: CollaborationRole; joinedAt: string; user: CollaborationUser; agent: CollaborationAgent | null;
}
export interface CollaborationInvitation {
  id: string; projectId: string; createdBy: string; createdAt: string; expiresAt: string; revokedAt: string | null;
}
export interface CollaborationInvitationSettings { enabled: boolean; version: number; canManage: boolean }
export interface CollaborationInvitationPreview {
  project: Pick<CollaborationProject, "id" | "name" | "identifier" | "coverIcon" | "coverColor">;
  expiresAt: string; alreadyMember: boolean;
}
export interface CollaborationIssue {
  id: string; projectId: string; number: number; identifier: string; title: string; description: string;
  status: CollaborationIssueStatus; priority: CollaborationPriority; assigneeMemberId: string | null;
  sortOrder: number; cycle: string | null; createdBy: string; createdAt: string; updatedAt: string;
  archivedAt: string | null; version: number;
}
export interface CollaborationDiscussion {
  id: string; projectId: string | null; originalProject: { id: string; identifier: string } | null; title: string; description: string; createdBy: string;
  createdAt: string; updatedAt: string; archivedAt: string | null; version: number;
}
export interface CollaborationDiscussionMember { discussionId: string; memberId: string; userId: string; agentId: string | null; user: CollaborationUser; agent: CollaborationAgent | null; joinedAt: string }
export interface CollaborationMessage {
  id: string; projectId: string | null; discussionId: string; authorId: string; authorMemberId: string;
  source: CollaborationMessageSource; executionId: string | null; content: string; replyToId: string | null;
  mentionMemberIds: string[]; attachmentIds: string[]; reactions: Record<string, string[]>; isKey: boolean;
  createdAt: string; updatedAt: string; version: number; clientMessageId: string;
}
export interface CollaborationIssueLink { discussionId: string; issueId: string; issueIdentifier: string; originalProject: { id: string; identifier: string }; deleted: boolean; createdBy: string; createdAt: string }
export interface CollaborationExecution {
  id: string; projectId: string | null; issueId: string | null; discussionId: string | null; agentId: string;
  ownerId: string; requestedBy: string; status: CollaborationExecutionStatus; prompt: string;
  // Non-owners see shared status/results, never local bindings, prompts, retry keys or raw errors.
  sessionId: string | null; turnId: string | null; error: string | null; result: string | null;
  idempotencyKey: string; createdAt: string; updatedAt: string; startedAt: string | null;
  finishedAt: string | null; version: number;
}
export interface CollaborationEvent {
  id: string; projectId: string | null; actorId: string; type: CollaborationRequest["type"];
  entityId: string; createdAt: string; data: Record<string, unknown>;
}
// A discussion scope is independently authorized; issueId and discussionId are mutually exclusive.
export interface CollaborationFileScope { projectId?: string | null; issueId?: string; discussionId?: string }
export interface CollaborationFile {
  id: string; scope: CollaborationFileScope; name: string; mediaType: string; size: number; sha256: string;
  createdBy: string; createdAt: string; downloadPath: string;
}
export interface CollaborationDiscussionSource { id: string; discussionId: string; kind: "url" | "markdown"; title: string; content: string; createdBy: string; createdAt: string }
export interface CollaborationIssueActivity {
  id: string; projectId: string; issueId: string; actor: CollaborationUser; type: CollaborationRequest["type"];
  changes: Record<string, { before: unknown; after: unknown }>; createdAt: string;
}
export interface CollaborationPage<T> { items: T[]; nextCursor: string | null }
export interface CollaborationProjectInput {
  name: string; description?: string; identifier: string; coverIcon?: string; coverColor?: string; repositoryUrl?: string | null;
}
export interface CollaborationIssueInput {
  title: string; description?: string; status?: CollaborationIssueStatus; priority?: CollaborationPriority;
  assigneeMemberId?: string | null; sortOrder?: number; cycle?: string | null; attachmentIds?: string[];
}
export interface CollaborationAgentInput { name: string; description?: string; avatarUrl?: string | null; runtimeReference?: string | null }
export interface CollaborationOperationMap {
  "projects.list": { request: { archived?: boolean; cursor?: string; limit?: number }; response: CollaborationPage<CollaborationProject> };
  "projects.get": { request: { projectId: string }; response: CollaborationProject };
  "projects.create": { request: CollaborationProjectInput; response: CollaborationProject };
  "projects.update": { request: { projectId: string; version: number; patch: Partial<CollaborationProjectInput> }; response: CollaborationProject };
  "projects.archive": { request: { projectId: string; version: number }; response: CollaborationProject };
  "projects.restore": { request: { projectId: string; version: number }; response: CollaborationProject };
  "projects.delete": { request: { projectId: string; version: number; confirmName: string }; response: { deleted: true; id: string } };
  "project-members.list": { request: { projectId: string; search?: string }; response: CollaborationMember[] };
  "project-members.set-role": { request: { projectId: string; memberId: string; role: CollaborationRole }; response: CollaborationMember };
  "project-members.remove": { request: { projectId: string; memberId: string }; response: { removed: true } };
  "project-members.add-agent": { request: { projectId: string; agentId: string }; response: CollaborationMember };
  "project-invitations.create": { request: { projectId: string }; response: CollaborationInvitation & { token: string; joinPath: string } };
  "project-invitations.list": { request: { projectId: string }; response: CollaborationInvitation[] };
  "project-invitations.revoke": { request: { projectId: string; invitationId: string }; response: CollaborationInvitation };
  "project-invitations.preview": { request: { token: string }; response: CollaborationInvitationPreview };
  "project-invitations.accept": { request: { token: string }; response: { project: CollaborationProject; alreadyMember: boolean } };
  "project-invitation-settings.get": { request: { projectId: string }; response: CollaborationInvitationSettings };
  "project-invitation-settings.update": { request: { projectId: string; version: number; enabled: boolean }; response: CollaborationInvitationSettings };
  "issues.list": { request: { projectId: string; archived?: boolean; status?: CollaborationIssueStatus; priority?: CollaborationPriority; assigneeMemberId?: string | null; cycle?: string | null; search?: string; cursor?: string; limit?: number }; response: CollaborationPage<CollaborationIssue> };
  "issues.get": { request: { projectId: string; issueId: string }; response: CollaborationIssue };
  "issues.create": { request: { projectId: string } & CollaborationIssueInput; response: CollaborationIssue };
  "issues.update": { request: { projectId: string; issueId: string; version: number; patch: Partial<Omit<CollaborationIssueInput, "attachmentIds">> }; response: CollaborationIssue };
  "issues.archive": { request: { projectId: string; issueId: string; version: number }; response: CollaborationIssue };
  "issues.restore": { request: { projectId: string; issueId: string; version: number }; response: CollaborationIssue };
  "issues.delete": { request: { projectId: string; issueId: string; version: number; confirmIdentifier: string }; response: { deleted: true; id: string } };
  "issues.reorder": { request: { projectId: string; items: { issueId: string; version: number; sortOrder: number; status?: CollaborationIssueStatus }[] }; response: CollaborationIssue[] };
  "issue-reactions.list": { request: { projectId: string; issueId: string }; response: Record<string, string[]> };
  "issue-reactions.toggle": { request: { projectId: string; issueId: string; reaction: string; active: boolean }; response: Record<string, string[]> };
  "issue-activity.list": { request: { projectId: string; issueId: string; cursor?: string; limit?: number }; response: CollaborationPage<CollaborationIssueActivity> };
  // Canonical Base64 of at most 8 MiB. Extensions and MIME must match the server allowlist.
  "files.upload": { request: { scope: CollaborationFileScope; name: string; mediaType: string; dataBase64: string }; response: CollaborationFile };
  "files.get": { request: { scope: CollaborationFileScope; fileId: string }; response: CollaborationFile };
  "files.remove": { request: { scope: CollaborationFileScope; fileId: string }; response: { removed: true } };
  "files.list": { request: { scope: CollaborationFileScope }; response: CollaborationFile[] };
  "discussions.list": { request: { projectId?: string | null; archived?: boolean; issueId?: string; cursor?: string; limit?: number }; response: CollaborationPage<CollaborationDiscussion> };
  "discussions.get": { request: { projectId?: string | null; discussionId: string }; response: CollaborationDiscussion };
  "discussions.create": { request: { projectId: string; title: string; description?: string; memberIds?: string[]; issueIds?: string[]; initialMessage?: string; clientMessageId?: string }; response: CollaborationDiscussion };
  "discussions.update": { request: { projectId?: string | null; discussionId: string; version: number; patch: { title?: string; description?: string } }; response: CollaborationDiscussion };
  "discussions.archive": { request: { projectId?: string | null; discussionId: string; version: number }; response: CollaborationDiscussion };
  "discussions.restore": { request: { projectId?: string | null; discussionId: string; version: number }; response: CollaborationDiscussion };
  "discussion-members.list": { request: { projectId?: string | null; discussionId: string }; response: CollaborationDiscussionMember[] };
  "discussion-members.add": { request: { projectId?: string | null; discussionId: string; memberIds?: string[]; userIds?: string[]; agentIds?: string[] }; response: CollaborationDiscussionMember[] };
  "discussion-members.remove": { request: { projectId?: string | null; discussionId: string; memberId: string }; response: { removed: true } };
  "discussion-messages.list": { request: { projectId?: string | null; discussionId: string; cursor?: string; limit?: number; keyOnly?: boolean }; response: CollaborationPage<CollaborationMessage> };
  "discussion-messages.send": { request: { projectId?: string | null; discussionId: string; content: string; clientMessageId: string; replyToId?: string | null; mentionMemberIds?: string[]; attachmentIds?: string[] }; response: CollaborationMessage };
  "discussion-messages.update": { request: { projectId?: string | null; discussionId: string; messageId: string; version: number; content: string; mentionMemberIds?: string[] }; response: CollaborationMessage };
  "discussion-messages.react": { request: { projectId?: string | null; discussionId: string; messageId: string; reaction: string; active: boolean }; response: CollaborationMessage };
  "discussion-messages.set-key": { request: { projectId?: string | null; discussionId: string; messageId: string; version: number; isKey: boolean }; response: CollaborationMessage };
  "discussion-issue-links.list": { request: { projectId?: string | null; discussionId: string }; response: CollaborationIssueLink[] };
  "discussion-issue-links.add": { request: { projectId?: string | null; discussionId: string; issueId: string }; response: CollaborationIssueLink };
  "discussion-issue-links.remove": { request: { projectId?: string | null; discussionId: string; issueId: string }; response: { removed: true } };
  "discussion-sources.list": { request: { projectId?: string | null; discussionId: string }; response: CollaborationDiscussionSource[] };
  "discussion-sources.add": { request: { projectId?: string | null; discussionId: string; kind: "url" | "markdown"; title: string; content: string }; response: CollaborationDiscussionSource };
  "discussion-sources.remove": { request: { projectId?: string | null; discussionId: string; sourceId: string }; response: { removed: true } };
  "agents.list": { request: { projectId?: string }; response: CollaborationAgent[] };
  "agents.register": { request: CollaborationAgentInput; response: CollaborationAgent };
  "agents.update": { request: { agentId: string; version: number; patch: Partial<CollaborationAgentInput> }; response: CollaborationAgent };
  "agents.remove": { request: { agentId: string; version: number }; response: { removed: true } };
  "executions.list": { request: { projectId?: string | null; issueId?: string; discussionId?: string; agentId?: string; cursor?: string; limit?: number }; response: CollaborationPage<CollaborationExecution> };
  "executions.create": { request: { projectId?: string | null; agentId: string; issueId?: string; discussionId?: string; discussionVersion?: number; prompt: string; idempotencyKey: string; ownerConfirmed: true }; response: CollaborationExecution };
  // Completion atomically publishes result to the discussion as the registered Agent, once.
  "executions.update": { request: { projectId?: string | null; executionId: string; version: number; status: "running" | "completed" | "failed"; sessionId?: string; turnId?: string; result?: string; error?: string }; response: CollaborationExecution };
  "executions.complete": { request: { projectId?: string | null; executionId: string; version: number; resultText: string }; response: CollaborationExecution };
  "executions.cancel": { request: { projectId?: string | null; executionId: string; version: number }; response: CollaborationExecution };
}
export type CollaborationRequest = { [K in keyof CollaborationOperationMap]: { type: K } & CollaborationOperationMap[K]["request"] }[keyof CollaborationOperationMap];
export type CollaborationResponseMap = { [K in keyof CollaborationOperationMap]: CollaborationOperationMap[K]["response"] };
export type CollaborationResponse<T extends CollaborationRequest["type"]> = CollaborationResponseMap[T];
export interface CollaborationError { error: { code: string; message: string; currentVersion?: number } }
