/** A question keeps its original index while partial answers arrive. */
export interface AsyncUserQuestion {
  id?: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect?: boolean;
}

export interface QuestionAnswerMetadata {
  requestId: string;
  turnId: string;
  toolCallId: string;
  clientResponseId: string;
  questions: AsyncUserQuestion[];
  answers: Record<string, string>;
}

export interface AsyncQuestionRequest {
  requestId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: 'ask_user_async';
  responseChannel: 'async-question';
  prompt?: string;
  attachmentsSupported: boolean;
  state: 'pending' | 'submitting';
  answers: Record<string, string>;
  toolInput: { questions: AsyncUserQuestion[]; metadata?: unknown };
}

export interface AsyncQuestionResolution {
  sessionId: string;
  requestId: string;
  turnId: string;
  state: 'pending' | 'answered' | 'expired' | 'cancelled';
  answers: Record<string, string>;
  userMessageId?: string;
  clientResponseId?: string;
}

export interface AsyncQuestionAnswerReply {
  accepted: true;
  requestId: string;
  turnId: string;
  userMessageId: string;
  clientResponseId: string;
  state: 'pending' | 'answered' | 'expired' | 'cancelled';
}
