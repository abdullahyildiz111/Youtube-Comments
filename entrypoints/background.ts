import {
  cancelCommentCrawl,
  ensureYoutubeRequestHeaders,
  runCommentCrawl,
} from '@/lib/comment-crawl';
import {
  CHAT_MESSAGE,
  SUMMARIZE_MESSAGE,
  SUMMARY_UPLOAD_MESSAGE,
  performChatFetch,
  performSummaryFetch,
  type ChatRequest,
  type ChatTurn,
  type SummarizeRequest,
  type SummaryUploadMessage,
} from '@/lib/cloud-summarizer';
import { COMMENT_MESSAGES, CRAWL_MESSAGES } from '@/lib/comments';
import type { InnertubeSession } from '@/lib/innertube-comments';
import {
  OPEN_DETACHED_MESSAGE,
  POPUP_RETARGET_MESSAGE,
  POPUP_WINDOW_ID_KEY,
  readPopupSize,
} from '@/entrypoints/popup/popup-size';

interface CommentUpload {
  kind: 'summary' | 'chat';
  videoId: string;
  videoTitle: string;
  language: string;
  question: string;
  history: ChatTurn[];
  comments: Array<{ text: string; isReply: boolean }>;
  createdAt: number;
}

const UPLOAD_TTL_MS = 20 * 60_000;

function pruneCommentUploads(): void {
  const now = Date.now();
  for (const [id, upload] of commentUploads) {
    if (now - upload.createdAt > UPLOAD_TTL_MS) commentUploads.delete(id);
  }
}

const commentUploads = new Map<string, CommentUpload>();

export default defineBackground(() => {
  void ensureYoutubeRequestHeaders().catch(() => undefined);

  browser.tabs.onActivated.addListener((info) => {
    void browser.tabs
      .sendMessage(info.tabId, { type: COMMENT_MESSAGES.wake })
      .catch(() => {
        // A discarded tab reloads on its own and starts the collector again.
      });
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return undefined;
    }

    if ((message as { type?: string }).type === OPEN_DETACHED_MESSAGE) {
      const request = message as { windowId?: unknown; tabId?: unknown };
      void openCatcherWindow({
        windowId: typeof request.windowId === 'number' ? request.windowId : undefined,
        id: typeof request.tabId === 'number' ? request.tabId : undefined,
      });
      return undefined;
    }

    if ((message as { type?: string }).type === CRAWL_MESSAGES.cancel) {
      const request = message as { requestId?: string };
      const tabId = sender.tab?.id;
      if (tabId != null) cancelCommentCrawl(tabId, request.requestId);
      return undefined;
    }

    if ((message as { type?: string }).type === CRAWL_MESSAGES.start) {
      const request = message as {
        requestId?: string;
        videoId?: string;
        session?: InnertubeSession;
      };
      const tabId = sender.tab?.id;
      if (tabId == null || !request.requestId || !request.videoId || !request.session) {
        sendResponse({
          ok: false,
          count: 0,
          truncated: false,
          totalCommentsLabel: null,
          error: 'Open a YouTube video first.',
        });
        return true;
      }
      void runCommentCrawl({
        tabId,
        requestId: request.requestId,
        videoId: request.videoId,
        session: request.session,
      }).then(sendResponse);
      return true;
    }

    if ((message as { type?: string }).type === SUMMARY_UPLOAD_MESSAGE) {
      const request = message as SummaryUploadMessage;
      pruneCommentUploads();
      if (request.phase === 'begin') {
        commentUploads.set(request.uploadId, {
          kind: request.kind,
          videoId: request.videoId ?? '',
          videoTitle: request.videoTitle ?? '',
          language: request.language ?? 'en',
          question: request.question ?? '',
          history: request.history ?? [],
          comments: [],
          createdAt: Date.now(),
        });
        sendResponse({ ok: true });
        return true;
      }

      const upload = commentUploads.get(request.uploadId);
      if (!upload) {
        sendResponse({
          ok: false,
          errorMessage: 'The summary upload expired. Please try again.',
        });
        return true;
      }

      if (request.phase === 'chunk') {
        if (request.comments?.length) upload.comments.push(...request.comments);
        sendResponse({ ok: true });
        return true;
      }

      commentUploads.delete(request.uploadId);
      const run =
        upload.kind === 'chat'
          ? performChatFetch(
              upload.comments,
              upload.videoId,
              upload.videoTitle,
              upload.question,
              upload.history,
              upload.language,
            ).then((answer) => ({ ok: true as const, answer }))
          : performSummaryFetch(
              upload.comments,
              upload.videoId,
              upload.videoTitle,
              upload.language,
            ).then((summary) => ({ ok: true as const, summary }));
      void run
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse(
            toErrorResponse(
              error,
              upload.kind === 'chat'
                ? 'The comments could not be asked about.'
                : 'The comments could not be summarized.',
            ),
          );
        });
      return true;
    }

    if ((message as SummarizeRequest).type === SUMMARIZE_MESSAGE) {
      const request = message as SummarizeRequest;
      void performSummaryFetch(
        request.comments,
        request.videoId,
        request.videoTitle,
        request.language,
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
        request.language,
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

async function openCatcherWindow(tab: { id?: number; windowId?: number }) {
  const size = await readPopupSize();
  const stored = await browser.storage.local.get(POPUP_WINDOW_ID_KEY);
  const existingId = stored[POPUP_WINDOW_ID_KEY];

  if (typeof existingId === 'number') {
    try {
      await browser.windows.update(existingId, { focused: true });
      await browser.runtime
        .sendMessage({
          type: POPUP_RETARGET_MESSAGE,
          windowId: tab.windowId,
          tabId: tab.id,
        })
        .catch(() => undefined);
      return;
    } catch {
      // The previous window was closed.
    }
  }

  const params = new URLSearchParams({ detached: '1' });
  if (tab.windowId != null) params.set('windowId', String(tab.windowId));
  if (tab.id != null) params.set('tabId', String(tab.id));
  const created = await browser.windows.create({
    url: browser.runtime.getURL(`/popup.html?${params.toString()}`),
    type: 'popup',
    width: size.width,
    height: size.height,
    focused: true,
  });

  if (created?.id != null) {
    await browser.storage.local.set({ [POPUP_WINDOW_ID_KEY]: created.id });
  }
}

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
