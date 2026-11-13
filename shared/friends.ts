import { isDesktopProtocol } from './desktop-edition';

export interface FriendProfile {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface FriendSummary {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  status: 'pending-incoming' | 'pending-outgoing' | 'accepted';
  allowIncomingAgentTasks: boolean;
  peerAllowsAgentTasks: boolean;
  online: boolean;
  /** The owner's private note for this friend, stored on this computer only.
   *  Absent when the owner never set one; an empty string clears it. */
  remark?: string;
}

export interface FriendsSnapshot {
  signedIn: boolean;
  selfUserId?: string;
  friends: FriendSummary[];
}

export type FriendMessageIntent = 'request' | 'notice';
export type FriendOnReply = 'display' | 'follow_up';
export type FriendReplyType = 'completed' | 'needs_input' | 'progress' | 'rejected' | 'failed' | 'cancelled';
export type FriendRequestState = 'awaiting_authorization' | 'processing' | 'needs_input';

export interface FriendMessage {
  protocolVersion?: 3;
  intent?: FriendMessageIntent;
  onReply?: FriendOnReply;
  replyType?: FriendReplyType;
  requestState?: FriendRequestState;
  stateRevision?: number;
  supplementToRequestId?: string;
  replyToMessageId?: string;
  questionId?: string;
  kind: 'task' | 'reply' | 'cancel';
  requestId: string;
  friendshipId: string;
  senderUserId: string;
  senderDisplayName: string;
  senderDeviceId: string;
  sourceThreadId: string;
  prompt: string;
  sentAt: number;
  replyToRequestId?: string;
  targetDeviceId?: string;
  targetThreadId?: string;
}

/** What the owner wants to happen when a friend's task arrives: review each one,
 *  run it inside the granted scope, or refuse it outright. */
export type FriendTaskPolicy = 'approve' | 'auto' | 'reject';
/** Where an authorized friend task conversation runs on the receiving computer.
 *  `none` keeps it an ordinary projectless conversation; a project or workspace
 *  target binds the conversation to that container and adds the target's roots
 *  to its initial writable roots. Absent on stored rows written before the
 *  choice existed; those behave as `none`. */
export type FriendTaskTarget =
  | { kind: 'none' }
  | { kind: 'project'; root: string }
  | { kind: 'workspace'; id: string };
/** The initial execution permission for a friend task conversation. It is the
 *  same three-preset policy an ordinary conversation offers; after it seeds the
 *  conversation's own policy row, later grant changes do not overwrite that
 *  choice. The stored grant mode remains as the seed for legacy and new rows. */
export type FriendExecutionPreset = 'default' | 'auto' | 'bypassPermissions';
export const FRIEND_EXECUTION_PRESETS: FriendExecutionPreset[] = ['default', 'auto', 'bypassPermissions'];
export function friendExecutionPreset(mode: FriendTaskGrant['mode']): FriendExecutionPreset {
  return mode === 'scoped-auto' ? 'bypassPermissions' : mode === 'auto-edit' ? 'auto' : 'default';
}
export function friendGrantMode(preset: FriendExecutionPreset): FriendTaskGrant['mode'] {
  return preset === 'bypassPermissions' ? 'scoped-auto' : preset === 'auto' ? 'auto-edit' : 'manual';
}

export interface FriendTaskGrant {
  deviceId: string;
  mode: 'manual' | 'auto-edit' | 'scoped-auto';
  computerUse: boolean;
  apps: string[];
  directories: Array<{ path: string; access: 'read' | 'write' }>;
  remember: boolean;
  network?: boolean;
  /** Absent on stored rows written before the policy existed; those review. */
  policy?: FriendTaskPolicy;
  target?: FriendTaskTarget;
}

export interface FriendReceiveReceipt { accepted: true; taskId: string; awaitingAuthorization: boolean; threadId?: string }

export interface FriendAppChoice { id: string; name: string }
export interface FriendAppsSnapshot { available: boolean; apps: FriendAppChoice[]; error?: string; taskCommands?: boolean }
/** The execution locations this computer offers a friend task: its registered
 *  single-folder projects and its multi-folder workspaces. The authorization
 *  dialog lists them; the grant validator checks a chosen target against them. */
export interface FriendExecutionTargets {
  projects: Array<{ root: string; name: string }>;
  workspaces: Array<{ id: string; name: string; roots: string[] }>;
}
export interface FriendReceivingDevice {
  id: string; name: string; platform: string; online: boolean;
  supportsFriendsMessaging: boolean; isCurrent: boolean;
}
export interface FriendReceiverSnapshot { selectedDeviceId: string | null; devices: FriendReceivingDevice[] }
/** Persisted on this computer; controls local work after forwarding a friend mention. */
export const FRIEND_LOCAL_ASSIST_KEY = 'friends_local_assist';
/** Persisted on this computer; the friends feature master switch. Absent means off. */
export const FRIENDS_ENABLED_KEY = 'friends.enabled';
export type FriendOutgoingStatus = 'sent' | 'delivered' | 'awaiting_authorization' | 'processing' | 'needs_input' | 'replied' | 'rejected' | 'cancelled' | 'failed';
/** System rows a friend conversation shows instead of a message bubble.
 *  `ended`: the friend's Klaus finished without a result. `unreplied`: this
 *  computer's Klaus finished a friend task without replying. `moved`: the
 *  conversation a pair used to live in was deleted. */
export type FriendReplyStatus = 'rejected' | 'cancelled' | 'failed' | 'ended' | 'unreplied' | 'moved';
export interface FriendOutgoingSummary {
  requestId: string; friendId: string; friendDisplayName: string; friendAvatarUrl: string | null;
  sourceThreadId: string; prompt: string; intent?: FriendMessageIntent; onReply?: FriendOnReply;
  createdAt: number; updatedAt: number; status: FriendOutgoingStatus;
  dispatchId?: string;
  canCancel?: boolean;
  canRetry?: boolean;
  error?: string;
}
export type FriendTaskStatus = 'pending' | 'starting' | 'running' | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'ignored' | 'needs-input';
export interface FriendTaskSummary {
  id: string; friendId: string; senderUserId: string; senderDisplayName: string; senderAvatarUrl: string | null;
  requestId: string; prompt: string; status: FriendTaskStatus;
  receiverDeviceId: string; threadId: string | null; createdAt: number; updatedAt: number;
  error?: string; errorCode?: string; ignoredAt?: number; replyError?: string; grant?: FriendTaskGrant;
  /** True once the task delivered its result through reply_to_friend. A task that
   *  finished without one shows the owner an action to ask Klaus to reply. */
  replied?: boolean;
  /** Set when the request arrived in one of the owner's own conversations. It is
   *  answered there by the owner (or Klaus acting for the owner), never run as a
   *  scoped friend task over that conversation's private history. */
  ownerChatThreadId?: string;
  /** When the owner last handed this ordinary-conversation request to their Klaus. */
  ownerHandoffAt?: number;
}
export interface FriendGrantTemplate {
  id: string; friendId: string; deviceId: string; grant: FriendTaskGrant; updatedAt: number;
}
/** A directory a running friend task asked the receiving owner to add to its
 *  grant while the task is in flight. The card is answered on the receiving
 *  computer only; an approved row is merged into the task's live grant and,
 *  when `remember` was ticked, into this friendship's standing template. */
export interface FriendAccessRequest {
  id: string; taskId: string; friendId: string; sessionId: string;
  path: string; access: 'read' | 'write'; reason: string; remember: boolean;
  createdAt: number;
}
export interface FriendsRuntimeSnapshot {
  signedIn: boolean; currentDeviceId: string | null; receiver: FriendReceiverSnapshot | null;
  tasks: FriendTaskSummary[]; templates: FriendGrantTemplate[]; outgoing: FriendOutgoingSummary[];
  /** The account-wide grant new friendships start from; the add-friend dialog
   *  prefills from it and the owner may adjust per friend at that moment. */
  defaultGrant: FriendTaskGrant;
  /** The product-owned directory every friendship shares on this computer; each
   *  accepted friendship owns one subdirectory of it. Null while signed out. */
  friendFilesRoot: string | null;
  /** The execution locations a friend task may be authorized into on this
   *  computer; empty lists mean the task can only run as a plain conversation. */
  executionTargets: FriendExecutionTargets;
  /** Directory requests running friend tasks are parked on, awaiting this
   *  computer's owner; empty unless a task asked and nobody answered yet. */
  accessRequests?: FriendAccessRequest[];
  error?: string;
}

/** The owner's own add-me card: identity plus a scannable invite payload.
 *  `payload` is the text another Klaus install resolves back to this account;
 *  `qrDataUrl` renders it as a PNG data URL so the friends page can show and
 *  save the code without a second round trip. */
export interface FriendCard {
  signedIn: boolean;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  payload: string;
  qrDataUrl: string;
}

export const FRIEND_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
export function friendMentionValue(id: string): string { return '@friend-' + id; }

const FRIEND_INVITE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Resolve a scanned add-me payload back to the registered email the add-friend
 *  lookup accepts. Accepts the versioned `klaus:friend?v=1&email=…` envelope the
 *  owner card encodes and, for plain camera scans, a bare email address.
 *  Returns null for anything else, so a mis-scanned code never prefills the
 *  lookup with a stranger's text. */
export function parseFriendInvite(text: string, protocol = 'klaus'): { email: string } | null {
  if (!isDesktopProtocol(protocol)) return null;
  const trimmed = text.trim();
  let url: URL | null = null;
  try { url = new URL(trimmed); } catch { url = null; }
  // Anything that parses as a URL must be the versioned envelope; a bare email
  // is only accepted from plain text, so a foreign link carrying an email in
  // its query can never prefill the lookup.
  if (url) {
    if (url.protocol !== protocol + ':' || url.username || url.password || url.port || url.hash
      || url.hostname !== 'friend' && url.pathname !== 'friend') return null;
    const email = url.searchParams.get('email')?.trim().toLowerCase() ?? '';
    return FRIEND_INVITE_EMAIL.test(email) ? { email } : null;
  }
  return FRIEND_INVITE_EMAIL.test(trimmed) ? { email: trimmed.toLowerCase() } : null;
}
