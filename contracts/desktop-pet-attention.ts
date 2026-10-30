export interface PetQuestionOption { label: string; description?: string; preview?: string }
export interface PetQuestion {
  question: string;
  header?: string;
  options: PetQuestionOption[];
  multiSelect?: boolean;
  allowFreeform?: boolean;
}
export interface PetPermissionSuggestion {
  index: number;
  kind: string;
  label: string;
  destination?: string;
  rules?: Array<{ toolName: string; ruleContent?: string }>;
}
export interface PetFileChange { path: string; oldText?: string; newText?: string; diff?: string }
export interface PetFormField {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  format?: string;
  default?: string | number | boolean | string[];
  enum?: Array<string | number>;
  enumNames?: string[];
  oneOf?: Array<{ const: string | number; title?: string }>;
  items?: { type: 'string'; enum?: string[]; oneOf?: Array<{ const: string; title?: string }> };
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}
interface PetAttentionIdentity { id: string; turnId?: string; toolCallId?: string; message?: string }
export interface PetApprovalAttention extends PetAttentionIdentity {
  kind: 'approval';
  toolName: string;
  category: 'command' | 'patch' | 'filesystem' | 'network' | 'plan' | 'tool';
  command?: string;
  patch?: string;
  cwd?: string;
  paths?: string[];
  domains?: string[];
  fileChanges?: PetFileChange[];
  plan?: string;
  suggestions?: PetPermissionSuggestion[];
}
export interface PetQuestionAttention extends PetAttentionIdentity {
  kind: 'question';
  responseChannel: 'permission' | 'elicit' | 'async-question';
  responseMode?: 'answers' | 'values';
  questions: PetQuestion[];
  answers?: Record<string, string>;
  attachmentsSupported?: boolean;
  state?: 'pending' | 'submitting';
}
export interface PetFormAttention extends PetAttentionIdentity {
  kind: 'mcp-form';
  serverName?: string;
  computerUseApp?: string;
  schema: { properties: Record<string, PetFormField>; required?: string[] };
}
export interface PetUrlAttention extends PetAttentionIdentity {
  kind: 'mcp-url';
  serverName?: string;
  url: string;
}
export interface PetReviewAttention extends PetAttentionIdentity {
  kind: 'review';
  reason: 'unsupported-schema' | 'high-risk' | 'verification';
}
export type PetAttention = PetApprovalAttention | PetQuestionAttention | PetFormAttention | PetUrlAttention | PetReviewAttention;
export type PetFormValue = string | number | boolean | string[];
export type PetAttentionResponse =
  | { decision: 'allow' | 'deny'; acceptedSuggestionIndices?: number[] }
  | { kind: 'answers'; answers: Record<string, string>; attachments?: Record<string, string[]> }
  | { kind: 'accept'; values: string[] | Record<string, PetFormValue>; persistApp?: boolean }
  | { kind: 'decline' | 'cancel' }
  | { kind: 'open' };
export interface PetTaskResponse { taskId: string; requestId: string; response: PetAttentionResponse }
