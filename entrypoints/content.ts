import {
  COMMENT_MESSAGES,
  MAX_SNAPSHOT_COMMENTS,
  type AutoSummarizePhase,
  type CollectorRequest,
  type CollectorStatus,
  type CommentsSnapshot,
  type CommentsUpdatedMessage,
  type LoadAllCommentsResponse,
  type ScrollToCommentsResponse,
  type SummarizeLoadedResponse,
  type YouTubeComment,
  getYouTubeVideoId,
} from '@/lib/comments';
import {
  INNERTUBE_BRIDGE,
  type CommentCountResult,
  type LoadAllProgress,
  type LoadAllResult,
} from '@/lib/innertube-comments';
import {
  getCloudSummaryErrorMessage,
  summarizeCommentsInCloud,
} from '@/lib/cloud-summarizer';
import { AUTO_SUMMARIZE_KEY, getAutoSummarizeEnabled } from '@/lib/settings';
import { readSummaryCache, saveSummary } from '@/lib/summary-cache';

const COMMENT_RENDERER_SELECTOR = [
  'ytd-comment-thread-renderer ytd-comment-view-model',
  'ytd-comment-thread-renderer ytd-comment-renderer',
  'ytd-comments ytd-comment-view-model',
  'ytd-comments ytd-comment-renderer',
].join(',');

const COMMENTS_ROOT_SELECTOR = 'ytd-comments#comments, ytd-comments';

function normalizeText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function readText(root: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const value = normalizeText(root.querySelector(selector)?.textContent);
    if (value) return value;
  }

  return '';
}

function resolveUrl(value: string | null): string | null {
  if (!value) return null;

  try {
    return new URL(value, window.location.origin).href;
  } catch {
    return null;
  }
}

function areCommentsEqual(
  first: YouTubeComment,
  second: YouTubeComment,
): boolean {
  return (
    first.id === second.id &&
    first.author === second.author &&
    first.authorUrl === second.authorUrl &&
    first.avatarUrl === second.avatarUrl &&
    first.text === second.text &&
    first.publishedAt === second.publishedAt &&
    first.permalink === second.permalink &&
    first.likeCount === second.likeCount &&
    first.isReply === second.isReply &&
    first.isPinned === second.isPinned &&
    first.isCreatorHearted === second.isCreatorHearted
  );
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',

  main(ctx) {
    let activeVideoId = getYouTubeVideoId(window.location.href);
    let videoTitle = '';
    let channelName = '';
    let totalCommentsLabel: string | null = null;
    let status: CollectorStatus = activeVideoId
      ? 'waiting-for-comments'
      : 'not-video';
    let capturedAt: string | null = null;
    let fetchedAll = false;
    let truncated = false;
    let loadAllCount: number | null = null;
    let autoEnabled = false;
    let autoPhase: AutoSummarizePhase = 'off';
    let autoError: string | null = null;
    let autoRunId = 0;
    let autoTimer: number | undefined;
    let loadGeneration = 0;
    let loadAllInFlight: Promise<LoadAllCommentsResponse> | null = null;
    let loadAllForVideoId: string | null = null;
    let lastCountRequestAt = 0;
    let lastCountRequestVideoId = '';
    let scanTimeout: number | undefined;
    let fallbackId = 0;
    let lastPublishedSignature = '';

    const comments = new Map<string, YouTubeComment>();
    let fallbackIds = new WeakMap<Element, string>();
    let scheduleAutoSummarize = () => {};

    const getFallbackId = (renderer: Element): string => {
      const existingId = fallbackIds.get(renderer);
      if (existingId) return existingId;

      fallbackId += 1;
      const id = `${activeVideoId ?? 'unknown'}-dom-${fallbackId}`;
      fallbackIds.set(renderer, id);
      return id;
    };

    const extractComment = (renderer: Element): YouTubeComment | null => {
      const text = readText(renderer, [
        '#content-text',
        'yt-attributed-string#content-text',
      ]);

      if (!text) return null;

      const author = readText(renderer, [
        '#author-text span',
        '#author-text',
        '#header-author h3',
      ]);
      const publishedAt = readText(renderer, [
        '#published-time-text',
        'a[href*="lc="]',
      ]);
      const permalinkElement = renderer.querySelector<HTMLAnchorElement>(
        '#published-time-text a[href], a[href*="lc="]',
      );
      const permalink = resolveUrl(permalinkElement?.getAttribute('href') ?? null);
      let permalinkId: string | null = null;

      if (permalink) {
        try {
          permalinkId = new URL(permalink).searchParams.get('lc');
        } catch {
          permalinkId = null;
        }
      }

      const explicitId =
        renderer.getAttribute('comment-id') ??
        renderer.getAttribute('data-comment-id');
      const authorElement =
        renderer.querySelector<HTMLAnchorElement>('#author-text[href]');
      const avatarElement = renderer.querySelector<HTMLImageElement>(
        '#author-thumbnail img, #avatar img',
      );
      const avatarUrl =
        avatarElement?.currentSrc ||
        avatarElement?.getAttribute('src') ||
        avatarElement?.getAttribute('data-thumb');

      return {
        id: permalinkId ?? explicitId ?? getFallbackId(renderer),
        author: author || 'Unknown author',
        authorUrl: resolveUrl(authorElement?.getAttribute('href') ?? null),
        avatarUrl: resolveUrl(avatarUrl ?? null),
        text,
        publishedAt,
        permalink,
        likeCount:
          readText(renderer, ['#vote-count-middle', '#like-count']) || null,
        isReply: Boolean(
          renderer.closest('ytd-comment-replies-renderer, #replies'),
        ),
        isPinned: Boolean(
          renderer.querySelector(
            'ytd-pinned-comment-badge-renderer, #pinned-comment-badge',
          ),
        ),
        isCreatorHearted: Boolean(
          renderer.querySelector('#creator-heart, ytd-creator-heart-renderer'),
        ),
      };
    };

    const getSnapshot = (): CommentsSnapshot => ({
      videoId: activeVideoId,
      videoTitle,
      channelName,
      pageUrl: window.location.href,
      totalCommentsLabel,
      status,
      comments: Array.from(comments.values()).slice(0, MAX_SNAPSHOT_COMMENTS),
      capturedCount: comments.size,
      capturedAt,
      fetchedAll,
      truncated,
      loadAllCount,
      autoPhase,
      autoError,
    });

    const publishUpdate = () => {
      const signature = [
        activeVideoId,
        status,
        comments.size,
        videoTitle,
        channelName,
        totalCommentsLabel,
        capturedAt,
        fetchedAll,
        truncated,
        loadAllCount,
        autoPhase,
        autoError,
      ].join('|');

      if (signature === lastPublishedSignature) return;
      lastPublishedSignature = signature;

      const message: CommentsUpdatedMessage = {
        type: COMMENT_MESSAGES.commentsUpdated,
        videoId: activeVideoId,
        count: comments.size,
        status,
      };

      void browser.runtime.sendMessage(message).catch(() => {
        // The popup is normally closed, so there may be no message receiver.
      });
    };

    const resetForVideo = (nextVideoId: string | null) => {
      activeVideoId = nextVideoId;
      videoTitle = '';
      channelName = '';
      totalCommentsLabel = null;
      status = nextVideoId ? 'waiting-for-comments' : 'not-video';
      capturedAt = null;
      fetchedAll = false;
      truncated = false;
      loadAllCount = null;
      autoPhase = autoEnabled ? 'idle' : 'off';
      autoError = null;
      autoRunId += 1;
      loadGeneration += 1;
      comments.clear();
      fallbackId = 0;
      fallbackIds = new WeakMap<Element, string>();
      lastPublishedSignature = '';
      lastCountRequestAt = 0;
      lastCountRequestVideoId = '';
    };

    const isLoadingAll = () =>
      status === 'loading-all' || loadAllInFlight !== null;

    const applyListedCommentCount = (label: string | null | undefined) => {
      const nextLabel = label?.trim();
      if (!nextLabel || !/\d/.test(nextLabel) || nextLabel === totalCommentsLabel) {
        return;
      }
      totalCommentsLabel = nextLabel;
      publishUpdate();
    };

    const requestListedCommentCount = (videoId: string, force = false) => {
      const now = Date.now();
      if (
        !force &&
        lastCountRequestVideoId === videoId &&
        now - lastCountRequestAt < 1_000
      ) {
        return;
      }

      lastCountRequestAt = now;
      lastCountRequestVideoId = videoId;
      window.postMessage(
        {
          type: INNERTUBE_BRIDGE.countRequest,
          requestId: crypto.randomUUID(),
          videoId,
        },
        window.location.origin,
      );
    };

    const onPageCountMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as CommentCountResult | { type?: string } | null;
      if (!data || typeof data !== 'object' || !('type' in data)) return;

      if (data.type === INNERTUBE_BRIDGE.ready && activeVideoId && !totalCommentsLabel) {
        requestListedCommentCount(activeVideoId, true);
        return;
      }

      if (data.type !== INNERTUBE_BRIDGE.countResult) return;
      const result = data as CommentCountResult;
      if (result.videoId !== activeVideoId) return;
      applyListedCommentCount(result.totalCommentsLabel);
    };

    window.addEventListener('message', onPageCountMessage);

    const scan = () => {
      const nextVideoId = getYouTubeVideoId(window.location.href);
      if (nextVideoId !== activeVideoId) {
        resetForVideo(nextVideoId);
        scheduleAutoSummarize();
      }

      if (!activeVideoId) {
        status = 'not-video';
        publishUpdate();
        return;
      }

      const renderedVideoId = document
        .querySelector('ytd-watch-flexy')
        ?.getAttribute('video-id');

      if (renderedVideoId && renderedVideoId !== activeVideoId) {
        if (!isLoadingAll()) status = 'loading';
        publishUpdate();
        return;
      }

      const nextVideoTitle =
        readText(document, [
          'ytd-watch-metadata #title h1 yt-formatted-string',
          'ytd-watch-metadata h1 yt-formatted-string',
        ]) ||
        document
          .querySelector<HTMLMetaElement>('meta[name="title"]')
          ?.content.trim() ||
        normalizeText(document.title.replace(/\s+-\s+YouTube$/, ''));
      const nextChannelName = readText(document, [
        'ytd-watch-metadata ytd-video-owner-renderer #channel-name a',
        'ytd-video-owner-renderer #channel-name',
      ]);

      if (nextVideoTitle) videoTitle = nextVideoTitle;
      if (nextChannelName) channelName = nextChannelName;

      if (!totalCommentsLabel && activeVideoId) {
        requestListedCommentCount(activeVideoId);
      }

      const commentsRoot = document.querySelector(COMMENTS_ROOT_SELECTOR);
      if (!commentsRoot) {
        if (!isLoadingAll()) status = 'waiting-for-comments';
        publishUpdate();
        return;
      }

      const nextTotalCommentsLabel =
        readText(document, [
          'ytd-comments-header-renderer #count .count-text',
          'ytd-comments-header-renderer #count',
          'ytd-comments-entry-point-header-renderer #comment-count',
        ]) || null;

      if (nextTotalCommentsLabel) {
        applyListedCommentCount(nextTotalCommentsLabel);
      }

      let commentsChanged = false;
      const renderers =
        commentsRoot.querySelectorAll<Element>(COMMENT_RENDERER_SELECTOR);

      for (const renderer of renderers) {
        const comment = extractComment(renderer);
        if (!comment) continue;

        const existingComment = comments.get(comment.id);
        if (!existingComment || !areCommentsEqual(existingComment, comment)) {
          comments.set(comment.id, comment);
          commentsChanged = true;
        }
      }

      if (commentsChanged) {
        capturedAt = new Date().toISOString();
      }

      if (!isLoadingAll()) {
        if (comments.size > 0) {
          status = 'ready';
        } else if (
          commentsRoot.querySelector(
            'tp-yt-paper-spinner[active], ytd-continuation-item-renderer',
          )
        ) {
          status = 'loading';
        } else if (commentsRoot.querySelector('ytd-message-renderer')) {
          status = 'no-comments';
        } else {
          status = 'waiting-for-comments';
        }
      }

      publishUpdate();
    };

    const scheduleScan = (delay = 180) => {
      if (scanTimeout !== undefined) {
        window.clearTimeout(scanTimeout);
      }

      scanTimeout = ctx.setTimeout(() => {
        scanTimeout = undefined;
        scan();
      }, delay);
    };

    const mutationTouchesComments = (mutation: MutationRecord): boolean => {
      const target =
        mutation.target instanceof Element
          ? mutation.target
          : mutation.target.parentElement;

      if (
        mutation.type === 'attributes' &&
        target?.matches('ytd-watch-flexy')
      ) {
        return true;
      }

      if (target?.closest('ytd-comments')) return true;

      return Array.from(mutation.addedNodes).some((node) => {
        if (!(node instanceof Element)) return false;

        return (
          node.matches('ytd-comments') ||
          node.matches(COMMENT_RENDERER_SELECTOR) ||
          Boolean(
            node.querySelector(
              `ytd-comments, ${COMMENT_RENDERER_SELECTOR}`,
            ),
          )
        );
      });
    };

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesComments)) {
        scheduleScan();
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['video-id'],
      childList: true,
      subtree: true,
    });

    const waitForRenderedVideo = async (videoId: string): Promise<boolean> => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (getYouTubeVideoId(window.location.href) !== videoId) return false;
        const rendered = document
          .querySelector('ytd-watch-flexy')
          ?.getAttribute('video-id');
        if (!rendered || rendered === videoId) return true;
        await new Promise((resolve) => {
          ctx.setTimeout(() => resolve(undefined), 150);
        });
      }
      return getYouTubeVideoId(window.location.href) === videoId;
    };

    const requestAllComments = (): Promise<LoadAllCommentsResponse> => {
      if (loadAllInFlight && loadAllForVideoId === activeVideoId) {
        return loadAllInFlight;
      }

      const generation = loadGeneration;
      const videoId = activeVideoId;
      const requestId = crypto.randomUUID();

      if (!videoId) {
        return Promise.resolve({
          ok: false,
          count: 0,
          truncated: false,
          error: 'Open a YouTube video first.',
        });
      }

      loadAllForVideoId = videoId;
      const flight = (async () => {
        const ready = await waitForRenderedVideo(videoId);
        if (!ready || generation !== loadGeneration || activeVideoId !== videoId) {
          return {
            ok: false,
            count: comments.size,
            truncated: false,
            error: 'The video changed before comments finished loading.',
          };
        }

        return new Promise<LoadAllCommentsResponse>((resolve) => {
          let settled = false;
          let heardFromPage = false;

          const finish = (response: LoadAllCommentsResponse) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(readyTimeout);
            window.clearTimeout(overallTimeout);
            window.removeEventListener('message', onPageMessage);
            resolve(response);
          };

          const onPageMessage = (event: MessageEvent) => {
            if (event.source !== window || event.origin !== window.location.origin) {
              return;
            }

            const data = event.data as LoadAllProgress | LoadAllResult | null;
            if (!data || data.requestId !== requestId) return;

            heardFromPage = true;
            window.clearTimeout(readyTimeout);

            if (generation !== loadGeneration || activeVideoId !== videoId) {
              finish({
                ok: false,
                count: comments.size,
                truncated: false,
                error: 'The video changed before comments finished loading.',
              });
              return;
            }

            if (data.type === INNERTUBE_BRIDGE.progress) {
              status = 'loading-all';
              loadAllCount = data.count;
              applyListedCommentCount(data.totalCommentsLabel);
              publishUpdate();
              return;
            }

            if (data.type !== INNERTUBE_BRIDGE.result) return;

            if (data.error) {
              loadAllCount = null;
              status = comments.size > 0 ? 'ready' : 'waiting-for-comments';
              publishUpdate();
              finish({
                ok: false,
                count: comments.size,
                truncated: false,
                error: data.error,
              });
              return;
            }

            for (const comment of data.comments) {
              comments.set(comment.id, comment);
            }

            capturedAt = new Date().toISOString();
            fetchedAll = true;
            truncated = data.truncated;
            loadAllCount = null;
            applyListedCommentCount(data.totalCommentsLabel);
            status = comments.size > 0 ? 'ready' : 'no-comments';
            publishUpdate();
            finish({
              ok: true,
              count: comments.size,
              truncated: data.truncated,
            });
          };

          const readyTimeout = window.setTimeout(() => {
            if (!heardFromPage) {
              loadAllCount = null;
              status = comments.size > 0 ? 'ready' : 'waiting-for-comments';
              publishUpdate();
              finish({
                ok: false,
                count: comments.size,
                truncated: false,
                error:
                  'Refresh the YouTube tab after updating the extension, then try again.',
              });
            }
          }, 12_000);

          const overallTimeout = window.setTimeout(() => {
            loadAllCount = null;
            status = comments.size > 0 ? 'ready' : 'waiting-for-comments';
            publishUpdate();
            finish({
              ok: false,
              count: comments.size,
              truncated: false,
              error: 'Timed out while loading comments from YouTube.',
            });
          }, 600_000);

          window.addEventListener('message', onPageMessage);
          status = 'loading-all';
          loadAllCount = comments.size;
          fetchedAll = false;
          publishUpdate();
          window.postMessage(
            { type: INNERTUBE_BRIDGE.request, requestId, videoId },
            window.location.origin,
          );
        });
      })();

      loadAllInFlight = flight;
      void flight.finally(() => {
        if (loadAllInFlight === flight) {
          loadAllInFlight = null;
          loadAllForVideoId = null;
        }
      });

      return loadAllInFlight;
    };

    const publishSummary = (summary: {
      videoId: string;
      text: string;
      commentCount: number;
      generatedAt: string;
      model?: string;
    }) => {
      void browser.runtime.sendMessage({
        type: COMMENT_MESSAGES.summaryReady,
        videoId: summary.videoId,
        summary,
      }).catch(() => {
        // The popup is often closed.
      });
    };

    const summarizeLoadedComments = async (): Promise<SummarizeLoadedResponse> => {
      if (!activeVideoId || comments.size === 0) {
        return {
          ok: false,
          error: 'No comments were found to summarize.',
        };
      }

      try {
        const result = await summarizeCommentsInCloud(
          Array.from(comments.values()),
          activeVideoId,
          videoTitle,
        );
        const summary = {
          videoId: activeVideoId,
          text: result.text,
          commentCount: result.commentCount,
          generatedAt: new Date().toISOString(),
          model: result.model,
        };
        await saveSummary(summary);
        publishSummary(summary);
        return { ok: true, summary };
      } catch (error: unknown) {
        return {
          ok: false,
          error: getCloudSummaryErrorMessage(error),
        };
      }
    };

    const setAutoPhase = (phase: AutoSummarizePhase, error: string | null = null) => {
      autoPhase = phase;
      autoError = error;
      publishUpdate();
    };

    const runAutoSummarize = async (runId: number) => {
      if (!autoEnabled || !activeVideoId) return;

      const videoId = activeVideoId;
      const cached = (await readSummaryCache())[videoId];
      if (runId !== autoRunId || !autoEnabled || activeVideoId !== videoId) return;

      setAutoPhase('fetching');

      let loaded = await requestAllComments();
      if (runId !== autoRunId || !autoEnabled || activeVideoId !== videoId) return;

      if (!loaded.ok) {
        await new Promise((resolve) => {
          ctx.setTimeout(() => resolve(undefined), 1_500);
        });
        if (runId !== autoRunId || !autoEnabled || activeVideoId !== videoId) return;
        loaded = await requestAllComments();
      }

      if (runId !== autoRunId || !autoEnabled || activeVideoId !== videoId) return;

      if (!loaded.ok || comments.size === 0) {
        if (cached) {
          setAutoPhase('idle');
          return;
        }
        const message =
          loaded.error || 'No comments were found to summarize.';
        setAutoPhase('idle', message);
        return;
      }

      if (cached) {
        setAutoPhase('idle');
        return;
      }

      setAutoPhase('summarizing');

      try {
        const summarized = await summarizeLoadedComments();
        if (runId !== autoRunId || activeVideoId !== videoId) return;

        if (!summarized.ok) {
          setAutoPhase('idle', summarized.error || null);
          return;
        }

        setAutoPhase('idle');
      } catch (error: unknown) {
        if (runId !== autoRunId) return;
        const message = getCloudSummaryErrorMessage(error);
        setAutoPhase('idle', message);
      }
    };

    scheduleAutoSummarize = () => {
      if (autoTimer !== undefined) {
        window.clearTimeout(autoTimer);
        autoTimer = undefined;
      }

      if (!autoEnabled || !activeVideoId) {
        setAutoPhase(autoEnabled ? 'idle' : 'off');
        return;
      }

      const runId = ++autoRunId;
      autoTimer = ctx.setTimeout(() => {
        autoTimer = undefined;
        void runAutoSummarize(runId);
      }, 900);
    };

    const handleMessage = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) {
        return undefined;
      }

      const request = message as CollectorRequest;

      if (request.type === COMMENT_MESSAGES.getSnapshot) {
        scan();
        return Promise.resolve(getSnapshot());
      }

      if (request.type === COMMENT_MESSAGES.scrollToComments) {
        const commentsSection = document.querySelector<HTMLElement>(
          `${COMMENTS_ROOT_SELECTOR}, ytd-watch-flexy #comments`,
        );

        commentsSection?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
        scheduleScan(500);

        const response: ScrollToCommentsResponse = {
          ok: Boolean(commentsSection),
        };
        return Promise.resolve(response);
      }

      if (request.type === COMMENT_MESSAGES.loadAllComments) {
        if (!activeVideoId) {
          const response: LoadAllCommentsResponse = {
            ok: false,
            count: 0,
            truncated: false,
            error: 'Open a YouTube video first.',
          };
          return Promise.resolve(response);
        }

        return requestAllComments();
      }

      if (request.type === COMMENT_MESSAGES.summarizeLoaded) {
        return summarizeLoadedComments();
      }

      return undefined;
    };

    browser.runtime.onMessage.addListener(handleMessage);

    const handleStorageChange = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !(AUTO_SUMMARIZE_KEY in changes)) return;
      autoEnabled = changes[AUTO_SUMMARIZE_KEY]?.newValue === true;
      scheduleAutoSummarize();
    };

    browser.storage.onChanged.addListener(handleStorageChange);

    ctx.onInvalidated(() => {
      observer.disconnect();
      window.removeEventListener('message', onPageCountMessage);
      browser.runtime.onMessage.removeListener(handleMessage);
      browser.storage.onChanged.removeListener(handleStorageChange);
    });

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      const nextVideoId = getYouTubeVideoId(window.location.href);
      if (nextVideoId !== activeVideoId) {
        resetForVideo(nextVideoId);
        scheduleAutoSummarize();
      }
      scheduleScan(50);
    });

    ctx.setInterval(() => {
      if (!activeVideoId) return;
      if (!totalCommentsLabel) {
        requestListedCommentCount(activeVideoId);
        scheduleScan(0);
        return;
      }
      if (status !== 'ready' && status !== 'loading-all') scheduleScan(0);
    }, 1_500);

    scan();
    void getAutoSummarizeEnabled().then((enabled) => {
      autoEnabled = enabled;
      scheduleAutoSummarize();
    });
  },
});
