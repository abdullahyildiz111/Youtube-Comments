import {
  COMMENT_MESSAGES,
  MAX_FETCHED_COMMENTS,
  MAX_SNAPSHOT_COMMENTS,
  type AutoSummarizePhase,
  type ChatAboutCommentsResponse,
  type CollectorRequest,
  type CollectorStatus,
  type CommentThread,
  type CommentsSnapshot,
  type CommentsPageResponse,
  type CommentsUpdatedMessage,
  type LoadAllCommentsResponse,
  type ScrollToCommentsResponse,
  type SummarizeLoadedResponse,
  type CommentSortOrder,
  type YouTubeComment,
  DEFAULT_COMMENT_SORT_ORDER,
  canonicalYouTubeCommentId,
  flattenCommentThreads,
  getYouTubeVideoId,
  groupCommentsForDisplay,
  isFeaturedByYouTube,
  makeCommentThread,
  orderCommentsForDisplay,
  threadParentId,
  toCommentSortOrder,
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
  askCommentsInCloud,
} from '@/lib/cloud-summarizer';
import {
  AUTO_SUMMARIZE_KEY,
  HIDE_FILTERED_KEY,
  getAutoSummarizeEnabled,
  getHideFilteredComments,
} from '@/lib/settings';
import { readSummaryCache, saveSummary } from '@/lib/summary-cache';

const COMMENT_RENDERER_SELECTOR = [
  'ytd-comment-thread-renderer ytd-comment-view-model',
  'ytd-comment-thread-renderer ytd-comment-renderer',
  'ytd-comments#comments ytd-comment-view-model',
  'ytd-comments#comments ytd-comment-renderer',
].join(',');

const COMMENTS_ROOT_SELECTOR = 'ytd-comments#comments';

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

function extractLabeledCount(
  renderer: Element,
  unit: 'like' | 'reply',
): string | null {
  const pattern =
    unit === 'like'
      ? /([\d.,]+(?:\s*[KMB])?)\s+likes?/i
      : /([\d.,]+(?:\s*[KMB])?)\s+repl(?:y|ies)/i;

  for (const element of renderer.querySelectorAll('[aria-label]')) {
    const match = element.getAttribute('aria-label')?.match(pattern);
    if (match?.[1]) return match[1].replace(/\s+/g, '');
  }

  const thread = renderer.closest('ytd-comment-thread-renderer');
  if (unit === 'reply' && thread && thread !== renderer) {
    for (const element of thread.querySelectorAll('[aria-label], #more-replies, #more-replies-button')) {
      const match = `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`.match(
        pattern,
      );
      if (match?.[1]) return match[1].replace(/\s+/g, '');
    }
  }

  return null;
}

function canonicalDomCommentId(value: string | null): string | null {
  return canonicalYouTubeCommentId(value) || null;
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
    first.replyCount === second.replyCount &&
    first.parentId === second.parentId &&
    first.isReply === second.isReply &&
    first.isPinned === second.isPinned &&
    first.pinnedLabel === second.pinnedLabel &&
    first.isCreatorHearted === second.isCreatorHearted &&
    first.isVerified === second.isVerified &&
    first.isChannelOwner === second.isChannelOwner &&
    first.topRank === second.topRank &&
    first.newestRank === second.newestRank &&
    first.replyRank === second.replyRank
  );
}

// YouTube's sort menu always lists Top first and Newest second, so the
// selected index survives translation. It renders lazily, and YouTube opens
// every video on Top, which is the right assumption until it appears.
function pageSortOrder(): CommentSortOrder {
  const options = document.querySelectorAll(
    `${COMMENTS_ROOT_SELECTOR} #sort-menu a.yt-dropdown-menu`,
  );
  const selected = Array.from(options).findIndex(
    (option) => option.getAttribute('aria-selected') === 'true',
  );
  return selected === 1 ? 'newest' : 'top';
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
    // The order the popup is showing. YouTube resets to "Top" on every video,
    // so this does too.
    let sortOrder: CommentSortOrder = DEFAULT_COMMENT_SORT_ORDER;
    let hideFilteredComments = false;
    // True once YouTube's own ranking is in the store. Page order is only a
    // stand-in until then, and mixing the two scales would scramble the list.
    let hasFetchedRanks = false;

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

    const extractComment = (
      renderer: Element,
      rank: { order: CommentSortOrder; root: number | null; reply: number | null },
    ): YouTubeComment | null => {
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
      const id =
        canonicalDomCommentId(permalinkId) ??
        canonicalDomCommentId(explicitId) ??
        getFallbackId(renderer);
      const pinnedBadge = renderer.querySelector(
        'ytd-pinned-comment-badge-renderer, #pinned-comment-badge',
      );
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
        id,
        author: author || 'Unknown author',
        authorUrl: resolveUrl(authorElement?.getAttribute('href') ?? null),
        avatarUrl: resolveUrl(avatarUrl ?? null),
        text,
        publishedAt,
        permalink,
        likeCount:
          readText(renderer, ['#vote-count-middle', '#like-count']) ||
          extractLabeledCount(renderer, 'like'),
        replyCount: extractLabeledCount(renderer, 'reply'),
        parentId: null,
        isReply: Boolean(
          renderer.closest('ytd-comment-replies-renderer, #replies'),
        ),
        isPinned: Boolean(pinnedBadge),
        pinnedLabel: normalizeText(pinnedBadge?.textContent) || null,
        isCreatorHearted: Boolean(
          renderer.querySelector('#creator-heart, ytd-creator-heart-renderer'),
        ),
        isVerified: Boolean(
          renderer.querySelector(
            '#author-text ytd-badge-supported-renderer, .badge-style-type-verified, [aria-label="Verified"]',
          ),
        ),
        isChannelOwner:
          renderer.hasAttribute('author-is-uploader') ||
          Boolean(renderer.querySelector('#author-comment-badge')),
        // The page is already showing YouTube's order, so its own layout is
        // the ranking until the full thread is fetched.
        topRank: rank.order === 'top' ? rank.root : null,
        newestRank: rank.order === 'newest' ? rank.root : null,
        replyRank: rank.reply,
      };
    };

    const allThreads = (order: CommentSortOrder = sortOrder) =>
      groupCommentsForDisplay(Array.from(comments.values()), order);

    // A comment counts as unfeatured only once the whole thread has been
    // walked. On a partial or capped load a missing Top listing just means the
    // Top pass never reached it, so filtering is held back until then.
    const canFilterByRanking = () => fetchedAll && !truncated;

    const filteredThreadCount = (order: CommentSortOrder = sortOrder) => {
      if (!canFilterByRanking()) return 0;

      let hidden = 0;
      for (const thread of allThreads(order)) {
        if (!isFeaturedByYouTube(thread.parent)) {
          hidden += 1 + thread.replies.length;
          continue;
        }
        hidden += thread.replies.length - withFeaturedReplies(thread).replies.length;
      }
      return hidden;
    };

    // Replies are only hidden when what is left matches the reply total
    // YouTube's own Top listing reports. A long thread can outrun the Top
    // pass, and dropping replies on an unconfirmed count would hide ordinary
    // comments, so those threads are left whole.
    const withFeaturedReplies = (thread: CommentThread): CommentThread => {
      const replies = thread.replies.filter((reply) => isFeaturedByYouTube(reply));
      if (replies.length === thread.replies.length) return thread;

      const listed = Number(thread.parent.featuredReplyCount);
      if (!Number.isFinite(listed) || listed !== replies.length) return thread;

      return makeCommentThread(
        { ...thread.parent, replyCount: String(listed) },
        replies,
      );
    };

    const listedThreads = (order: CommentSortOrder = sortOrder) => {
      const threads = allThreads(order);
      if (!hideFilteredComments || !canFilterByRanking()) return threads;

      const featured = threads
        .filter((thread) => isFeaturedByYouTube(thread.parent))
        .map(withFeaturedReplies);

      return featured.length > 0 ? featured : threads;
    };

    const listedComments = () =>
      hideFilteredComments && canFilterByRanking()
        ? flattenCommentThreads(listedThreads())
        : orderCommentsForDisplay(Array.from(comments.values()), sortOrder);

    const getSnapshot = (): CommentsSnapshot => {
      const threads = listedThreads();
      return {
        videoId: activeVideoId,
        videoTitle,
        channelName,
        pageUrl: window.location.href,
        totalCommentsLabel,
        status,
        comments: flattenCommentThreads(threads.slice(0, MAX_SNAPSHOT_COMMENTS)),
        capturedCount: comments.size,
        threadCount: threads.length,
        capturedAt,
        fetchedAll,
        truncated,
        loadAllCount,
        autoPhase,
        autoError,
        sortOrder,
        hideFilteredComments,
        filteredCount: filteredThreadCount(),
      };
    };

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
        sortOrder,
        hideFilteredComments,
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
      sortOrder = DEFAULT_COMMENT_SORT_ORDER;
      hasFetchedRanks = false;
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

      const innertubeOwnsComments = fetchedAll || isLoadingAll();
      let commentsChanged = false;

      if (!innertubeOwnsComments) {
        const renderers =
          commentsRoot.querySelectorAll<Element>(COMMENT_RENDERER_SELECTOR);
        const order = pageSortOrder();
        const rankFromPage = !hasFetchedRanks;
        const replyCursors = new Map<string, number>();
        let rootCursor = 0;

        for (const renderer of renderers) {
          const isReply = Boolean(
            renderer.closest('ytd-comment-replies-renderer, #replies'),
          );
          const probe = extractComment(renderer, {
            order,
            root: null,
            reply: null,
          });
          if (!probe) continue;

          const parentId = isReply ? threadParentId(probe) : null;
          let replyRank: number | null = null;

          if (isReply && parentId) {
            replyRank = replyCursors.get(parentId) ?? 0;
            replyCursors.set(parentId, replyRank + 1);
          }

          const comment = extractComment(renderer, {
            order,
            root: rankFromPage && !isReply ? rootCursor : null,
            reply: rankFromPage ? replyRank : null,
          });
          if (!comment) continue;
          if (!isReply) rootCursor += 1;
          if (comment.id.includes('-dom-')) {
            const duplicate = Array.from(comments.values()).some(
              (existing) =>
                existing.author === comment.author && existing.text === comment.text,
            );
            if (duplicate || fetchedAll) continue;
          }

          const existingComment = comments.get(comment.id);
          if (!existingComment || !areCommentsEqual(existingComment, comment)) {
            comments.set(comment.id, comment);
            commentsChanged = true;
          }
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
              if (data.comments?.length) {
                hasFetchedRanks = true;
                for (const comment of data.comments) {
                  comments.set(comment.id, comment);
                }
                capturedAt = new Date().toISOString();
              }
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

            comments.clear();
            hasFetchedRanks = true;
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
          comments.clear();
          loadAllCount = 0;
          fetchedAll = false;
          capturedAt = null;
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
          listedComments(),
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

    const chatAboutLoadedComments = async (
      question: string,
      history: Array<{ role: 'user' | 'assistant'; text: string }>,
    ): Promise<ChatAboutCommentsResponse> => {
      if (!activeVideoId || comments.size === 0) {
        return {
          ok: false,
          error: 'Load comments first, then ask a question.',
        };
      }

      try {
        const result = await askCommentsInCloud(
          listedComments(),
          activeVideoId,
          videoTitle,
          question,
          history,
        );
        return { ok: true, answer: result.text };
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

      if (cached && cached.commentCount === comments.size) {
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
        if (request.sortOrder) sortOrder = toCommentSortOrder(request.sortOrder);
        if (typeof request.hideFilteredComments === 'boolean') {
          hideFilteredComments = request.hideFilteredComments;
        }
        scan();
        return Promise.resolve(getSnapshot());
      }

      if (request.type === COMMENT_MESSAGES.getCommentsPage) {
        if (request.sortOrder) sortOrder = toCommentSortOrder(request.sortOrder);
        if (typeof request.hideFilteredComments === 'boolean') {
          hideFilteredComments = request.hideFilteredComments;
        }
        const threads = listedThreads();
        const offset = Math.max(0, Math.floor(request.offset) || 0);
        const limit = Math.min(
          MAX_FETCHED_COMMENTS,
          Math.max(1, Math.floor(request.limit ?? MAX_SNAPSHOT_COMMENTS) || MAX_SNAPSHOT_COMMENTS),
        );
        const response: CommentsPageResponse = {
          videoId: activeVideoId,
          offset,
          comments: flattenCommentThreads(threads.slice(offset, offset + limit)),
          total: threads.length,
          sortOrder,
          hideFilteredComments,
        };
        return Promise.resolve(response);
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

      if (request.type === COMMENT_MESSAGES.chatAboutComments) {
        return chatAboutLoadedComments(request.question, request.history);
      }

      return undefined;
    };

    browser.runtime.onMessage.addListener(handleMessage);

    const handleStorageChange = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;

      if (HIDE_FILTERED_KEY in changes) {
        hideFilteredComments = changes[HIDE_FILTERED_KEY]?.newValue === true;
        publishUpdate();
      }

      if (!(AUTO_SUMMARIZE_KEY in changes)) return;
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
    void getHideFilteredComments().then((enabled) => {
      hideFilteredComments = enabled;
    });
  },
});
