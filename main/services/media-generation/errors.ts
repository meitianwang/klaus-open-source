/** Only host-authored failures may cross the media tool boundary. */
export class MediaGenerationError extends Error {}

export function mediaGenerationErrorText(error: unknown): string {
  return error instanceof MediaGenerationError
    ? error.message
    : 'Media generation failed. Check the generation settings and try again.';
}
