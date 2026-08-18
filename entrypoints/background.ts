import {
  SUMMARIZE_MESSAGE,
  performSummaryFetch,
  type SummarizeRequest,
} from '@/lib/cloud-summarizer';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('type' in message) ||
      (message as SummarizeRequest).type !== SUMMARIZE_MESSAGE
    ) {
      return undefined;
    }

    const request = message as SummarizeRequest;
    void performSummaryFetch(
      request.comments,
      request.videoId,
      request.videoTitle,
    )
      .then((summary) => {
        sendResponse({ ok: true, summary });
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          errorMessage:
            error instanceof Error
              ? error.message
              : 'The comments could not be summarized.',
          errorName: error instanceof Error ? error.name : undefined,
          status:
            error &&
            typeof error === 'object' &&
            'status' in error &&
            typeof error.status === 'number'
              ? error.status
              : undefined,
        });
      });

    return true;
  });
});
