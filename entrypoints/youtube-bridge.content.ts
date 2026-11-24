import { getYouTubeVideoId } from '@/lib/comments';
import {
  INNERTUBE_BRIDGE,
  InnertubeRateLimitError,
  fetchAllVideoComments,
  fetchContinuationText,
  fetchVideoCommentCount,
  readInnertubeSession,
  type CommentCountRequest,
  type CommentCountResult,
  type LoadAllProgress,
  type LoadAllRequest,
  type LoadAllResult,
} from '@/lib/innertube-comments';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',

  main() {
    let activeRequestId = '';
    let activeCountVideoId = '';
    let countInFlightVideoId = '';
    let countInFlight: Promise<string | null> | null = null;
    const publishedCounts = new Map<string, string>();

    const postCount = (videoId: string, totalCommentsLabel: string | null) => {
      const message: CommentCountResult = {
        type: INNERTUBE_BRIDGE.countResult,
        requestId: videoId,
        videoId,
        totalCommentsLabel,
      };
      window.postMessage(message, window.location.origin);
    };

    const loadListedCount = (videoId: string) => {
      if (!videoId) return;

      const cached = publishedCounts.get(videoId);
      if (cached) {
        postCount(videoId, cached);
        return;
      }

      if (countInFlight && countInFlightVideoId === videoId) {
        void countInFlight.then((label) => {
          if (label && getYouTubeVideoId(window.location.href) === videoId) {
            postCount(videoId, label);
          }
        });
        return;
      }

      activeCountVideoId = videoId;
      countInFlightVideoId = videoId;
      const isCancelled = () =>
        activeCountVideoId !== videoId ||
        getYouTubeVideoId(window.location.href) !== videoId;

      const pending = fetchVideoCommentCount(videoId, isCancelled)
        .then((totalCommentsLabel) => {
          if (totalCommentsLabel) publishedCounts.set(videoId, totalCommentsLabel);
          if (!isCancelled()) postCount(videoId, totalCommentsLabel);
          return totalCommentsLabel;
        })
        .catch(() => {
          if (!isCancelled()) postCount(videoId, null);
          return null;
        })
        .finally(() => {
          if (countInFlight === pending) countInFlight = null;
        });

      countInFlight = pending;
    };

    const publishReady = () => {
      window.postMessage(
        { type: INNERTUBE_BRIDGE.ready },
        window.location.origin,
      );
    };

    const currentVideoId = () => getYouTubeVideoId(window.location.href);

    let lastCountVideoId = '';
    const syncListedCount = () => {
      const videoId = currentVideoId();
      if (!videoId || videoId === lastCountVideoId) return;
      lastCountVideoId = videoId;
      loadListedCount(videoId);
    };

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as
        | LoadAllRequest
        | CommentCountRequest
        | {
            type?: string;
            requestId?: string;
            videoId?: string;
            token?: string;
            clickTrackingParams?: string;
          }
        | null;
      if (!data || typeof data !== 'object' || !('type' in data) || typeof data.type !== 'string') {
        return;
      }

      if (data.type === INNERTUBE_BRIDGE.sessionRequest) {
        const requestId = (data as { requestId?: string }).requestId;
        if (typeof requestId !== 'string') return;
        try {
          const session = JSON.parse(JSON.stringify(readInnertubeSession())) as ReturnType<
            typeof readInnertubeSession
          >;
          window.postMessage(
            { type: INNERTUBE_BRIDGE.sessionResult, requestId, session },
            window.location.origin,
          );
        } catch (error) {
          window.postMessage(
            {
              type: INNERTUBE_BRIDGE.sessionResult,
              requestId,
              error:
                error instanceof Error
                  ? error.message
                  : 'YouTube client data is not ready. Refresh the video page.',
            },
            window.location.origin,
          );
        }
        return;
      }

      if (data.type === INNERTUBE_BRIDGE.rawFetch) {
        const request = data as {
          requestId?: string;
          token?: string;
          clickTrackingParams?: string;
          authorize?: boolean;
        };
        if (typeof request.requestId !== 'string' || typeof request.token !== 'string') {
          return;
        }
        const { requestId, token, clickTrackingParams } = request;
        void fetchContinuationText(token, clickTrackingParams, request.authorize !== false)
          .then((body) => {
            window.postMessage(
              { type: INNERTUBE_BRIDGE.rawResult, requestId, body },
              window.location.origin,
            );
          })
          .catch((error: unknown) => {
            window.postMessage(
              {
                type: INNERTUBE_BRIDGE.rawResult,
                requestId,
                rateLimited: error instanceof InnertubeRateLimitError,
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to load comments from YouTube.',
              },
              window.location.origin,
            );
          });
        return;
      }

      if (data.type === INNERTUBE_BRIDGE.countRequest) {
        if (typeof data.videoId !== 'string' || !data.videoId) return;
        if (data.videoId !== lastCountVideoId) {
          lastCountVideoId = data.videoId;
        }
        loadListedCount(data.videoId);
        return;
      }

      if (data.type !== INNERTUBE_BRIDGE.request) return;
      if (typeof data.requestId !== 'string' || typeof data.videoId !== 'string') {
        return;
      }

      const { requestId, videoId } = data;
      activeRequestId = requestId;
      const isCancelled = () => activeRequestId !== requestId;

      void fetchAllVideoComments(
        (count, totalCommentsLabel, added, patches) => {
          if (isCancelled()) return;
          if (totalCommentsLabel) postCount(videoId, totalCommentsLabel);
          const progress: LoadAllProgress = {
            type: INNERTUBE_BRIDGE.progress,
            requestId,
            count,
            comments: added && added.length > 0 ? added : undefined,
            patches: patches && patches.length > 0 ? patches : undefined,
            totalCommentsLabel,
          };
          window.postMessage(progress, window.location.origin);
        },
        undefined,
        videoId,
        isCancelled,
      )
        .then((result) => {
          if (isCancelled()) return;
          if (result.totalCommentsLabel) {
            postCount(videoId, result.totalCommentsLabel);
          }
          const message: LoadAllResult = {
            type: INNERTUBE_BRIDGE.result,
            requestId,
            comments: [],
            count: result.count,
            truncated: result.truncated,
            totalCommentsLabel: result.totalCommentsLabel,
          };
          window.postMessage(message, window.location.origin);
        })
        .catch((error: unknown) => {
          if (isCancelled()) return;
          const message: LoadAllResult = {
            type: INNERTUBE_BRIDGE.result,
            requestId,
            comments: [],
            truncated: false,
            error:
              error instanceof Error
                ? error.message
                : 'Failed to load comments from YouTube.',
          };
          window.postMessage(message, window.location.origin);
        });
    });

    publishReady();
    syncListedCount();

    let hiddenAt = 0;
    const wakeBridge = (cancelLoad: boolean) => {
      if (document.visibilityState === 'hidden') return;
      if (cancelLoad) {
        activeRequestId = '';
        lastCountVideoId = '';
      }
      publishReady();
      syncListedCount();
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      wakeBridge(hiddenAt > 0 && Date.now() - hiddenAt >= 20_000);
      hiddenAt = 0;
    });
    document.addEventListener('resume', () => wakeBridge(true));
    window.addEventListener('pageshow', () => wakeBridge(true));

    document.addEventListener('yt-navigate-finish', () => {
      lastCountVideoId = '';
      syncListedCount();
    });
    document.addEventListener('yt-page-data-updated', () => {
      lastCountVideoId = '';
      syncListedCount();
    });

    const observer = new MutationObserver(() => {
      syncListedCount();
    });

    const observeFlexy = () => {
      const flexy = document.querySelector('ytd-watch-flexy');
      if (!flexy) return;
      observer.observe(flexy, {
        attributes: true,
        attributeFilter: ['video-id'],
      });
      syncListedCount();
    };

    observeFlexy();
    document.addEventListener('yt-navigate-finish', observeFlexy);
    window.setTimeout(observeFlexy, 500);
    window.setTimeout(syncListedCount, 1_200);
  },
});
