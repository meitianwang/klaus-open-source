import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import type { FeedbackService } from '../../feedback/service';

export const FEEDBACK_CHANNELS = ['feedback:submit', 'feedback:suggestion-submit', 'feedback:pick-attachments', 'feedback:capture-screenshot'] as const;
export function registerFeedbackHandlers(registry: ChannelRegistry, service: FeedbackService): void {
  registry.register('feedback:submit', ctx => service.submitFeedback(object(ctx.args[0]), ctx.senderId, ctx.signal), 'feedback');
  registry.register('feedback:suggestion-submit', ctx => service.submitSuggestion(object(ctx.args[0]), ctx.senderId), 'feedback');
  registry.register('feedback:pick-attachments', ctx => service.pickAttachments(ctx.senderId), 'feedback');
  registry.register('feedback:capture-screenshot', ctx => service.captureScreenshot(ctx.senderId), 'feedback');
}
