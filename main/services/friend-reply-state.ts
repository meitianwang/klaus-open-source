import type { FriendMessage, FriendOutgoingStatus } from '../../shared/friends';
import type { FriendOutboxRequest } from './friend-task-store';

const terminal = (type: string) => ['completed', 'rejected', 'failed', 'cancelled'].includes(type);

/** Each receiving device owns one result; the sending turn never waits for the set. */
export function applyFriendReply(outbox: FriendOutboxRequest, message: FriendMessage): FriendOutboxRequest {
  const replies = { ...outbox.deviceReplies };
  const previous = replies[message.senderDeviceId];
  const stale = previous && ((terminal(previous.replyType) && !terminal(message.replyType!))
    || (typeof previous.stateRevision === 'number' && typeof message.stateRevision === 'number' && previous.stateRevision > message.stateRevision));
  if (!stale) {
    const retainQuestion = previous?.replyType === 'needs_input' && message.replyType === 'progress' && !message.requestState;
    replies[message.senderDeviceId] = {
      messageId: message.requestId,
      replyType: retainQuestion ? 'needs_input' : message.replyType!,
      prompt: retainQuestion ? previous.prompt : message.prompt,
      ...(message.requestState ? { requestState: message.requestState } : retainQuestion ? { requestState: 'needs_input' as const } : {}),
      ...(message.stateRevision !== undefined ? { stateRevision: message.stateRevision } : {}),
      ...(message.questionId ? { questionId: message.questionId } : retainQuestion && previous.questionId ? { questionId: previous.questionId } : {}),
    };
  }
  const devices = outbox.receiverDeviceIds?.length ? outbox.receiverDeviceIds : outbox.receiverDeviceId ? [outbox.receiverDeviceId] : [];
  const complete = devices.length > 0 && devices.every(device => replies[device] && terminal(replies[device]!.replyType));
  const values = devices.flatMap(device => replies[device] ? [replies[device]!] : []);
  let status: FriendOutgoingStatus;
  if (outbox.cancelled) status = 'cancelled';
  else if (complete) status = values.some(value => value.replyType === 'completed') ? 'replied'
    : values.some(value => value.replyType === 'failed') ? 'failed'
    : values.some(value => value.replyType === 'rejected') ? 'rejected' : 'cancelled';
  else if (values.some(value => value.replyType === 'needs_input' || value.requestState === 'needs_input')) status = 'needs_input';
  else if (values.some(value => terminal(value.replyType) || value.requestState === 'processing' || value.replyType === 'progress' && !value.requestState)) status = 'processing';
  else if (values.some(value => value.requestState === 'awaiting_authorization')) status = 'awaiting_authorization';
  else status = 'delivered';
  const question = values.find(value => value.replyType === 'needs_input' && value.questionId)?.questionId;
  return { ...outbox, deviceReplies: replies, status, questionId: question, sendError: '', sendAccepted: true,
    replyCompleted: outbox.replyCompleted || complete };
}
