import {
  CHAT_MESSAGE,
  SUMMARIZE_MESSAGE,
  performChatFetch,
  performSummaryFetch,
  type ChatRequest,
  type SummarizeRequest,
} from '@/lib/cloud-summarizer';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return undefined;
    }

    if ((message as SummarizeRequest).type === SUMMARIZE_MESSAGE) {
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
          sendResponse(toErrorResponse(error, 'The comments could not be summarized.'));
        });
      return true;
    }

    if ((message as ChatRequest).type === CHAT_MESSAGE) {
      const request = message as ChatRequest;
      void performChatFetch(
        request.comments,
        request.videoId,
        request.videoTitle,
        request.question,
        request.history,
      )
        .then((answer) => {
          sendResponse({ ok: true, answer });
        })
        .catch((error: unknown) => {
          sendResponse(toErrorResponse(error, 'The comments could not be asked about.'));
        });
      return true;
    }

    return undefined;
  });
});

function toErrorResponse(error: unknown, fallback: string) {
  return {
    ok: false as const,
    errorMessage: error instanceof Error ? error.message : fallback,
    errorName: error instanceof Error ? error.name : undefined,
    status:
      error &&
      typeof error === 'object' &&
      'status' in error &&
      typeof error.status === 'number'
        ? error.status
        : undefined,
  };
}
