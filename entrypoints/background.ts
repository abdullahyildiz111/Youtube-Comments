import {
  CHAT_MESSAGE,
  SUMMARIZE_MESSAGE,
  performChatFetch,
  performSummaryFetch,
  type ChatRequest,
  type SummarizeRequest,
} from '@/lib/cloud-summarizer';
import {
  OPEN_DETACHED_MESSAGE,
  POPUP_RETARGET_MESSAGE,
  POPUP_WINDOW_ID_KEY,
  readPopupSize,
} from '@/entrypoints/popup/popup-size';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
