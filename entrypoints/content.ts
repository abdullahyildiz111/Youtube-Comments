import {
  COMMENT_MESSAGES,
  type CollectorRequest,
  type CollectorStatus,
  type CommentsSnapshot,
  type CommentsUpdatedMessage,
  type ScrollToCommentsResponse,
  type YouTubeComment,
  getYouTubeVideoId,
} from '@/lib/comments';

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
    let scanTimeout: number | undefined;
    let fallbackId = 0;
    let lastPublishedSignature = '';

    const comments = new Map<string, YouTubeComment>();
    let fallbackIds = new WeakMap<Element, string>();

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
      comments: Array.from(comments.values()),
      capturedAt,
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
      comments.clear();
      fallbackId = 0;
      fallbackIds = new WeakMap<Element, string>();
      lastPublishedSignature = '';
    };

    const scan = () => {
      const nextVideoId = getYouTubeVideoId(window.location.href);
      if (nextVideoId !== activeVideoId) {
        resetForVideo(nextVideoId);
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
        status = 'loading';
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

      const commentsRoot = document.querySelector(COMMENTS_ROOT_SELECTOR);
      if (!commentsRoot) {
        status = 'waiting-for-comments';
        publishUpdate();
        return;
      }

      const nextTotalCommentsLabel =
        readText(commentsRoot, [
          'ytd-comments-header-renderer #count .count-text',
          'ytd-comments-header-renderer #count',
        ]) || null;

      if (nextTotalCommentsLabel) {
        totalCommentsLabel = nextTotalCommentsLabel;
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

      return undefined;
    };

    browser.runtime.onMessage.addListener(handleMessage);
    ctx.onInvalidated(() => {
      observer.disconnect();
      browser.runtime.onMessage.removeListener(handleMessage);
    });

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      const nextVideoId = getYouTubeVideoId(window.location.href);
      if (nextVideoId !== activeVideoId) {
        resetForVideo(nextVideoId);
      }
      scheduleScan(50);
    });

    ctx.setInterval(() => {
      if (status !== 'ready') scheduleScan(0);
    }, 2_000);

    scan();
  },
});
