import { CommentStore, type CommentView } from '@/lib/comment-store';
import {
  COMMENT_MESSAGES,
  CRAWL_MESSAGES,
  MAX_COMMENT_PAGE_THREADS,
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
  type SearchCommentsResponse,
  type SummarizeLoadedResponse,
  type CommentPatch,
  type CommentSortOrder,
  type YouTubeComment,
  DEFAULT_COMMENT_SORT_ORDER,
  canonicalYouTubeCommentId,
  flattenCommentThreads,
  getYouTubeVideoId,
  pageReplyCount,
  replyButtonCountFromText,
  threadParentId,
  toCommentSortOrder,
} from '@/lib/comments';
import {
  INNERTUBE_BRIDGE,
  type CommentCountResult,
  type InnertubeSession,
  type LoadAllProgress,
  type LoadAllResult,
} from '@/lib/innertube-comments';
import {
  getCloudSummaryErrorMessage,
  uploadCommentsForModel,
  type CloudChatAnswer,
  type CloudSummary,
} from '@/lib/cloud-summarizer';
import { isReplyLanguageCode } from '@/lib/languages';
import {
  AUTO_SUMMARIZE_KEY,
  SHOW_SPAM_KEY,
  getAutoSummarizeEnabled,
  getShowSpamComments,
  getReplyLanguage,
} from '@/lib/settings';
import {
  readSummaryCache,
  saveSummary,
  findCachedSummary,
} from '@/lib/summary-cache';

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

// YouTube draws the reply total inside an open shadow root (yt-button-shape).
// textContent on the light-DOM host does not include that label.
function accessibleText(root: Element): string {
  const parts: string[] = [];
  const visit = (node: Node) => {
    if (node instanceof Element) {
      const label = node.getAttribute('aria-label');
      if (label) parts.push(label);
      if (node.shadowRoot) {
        for (const child of node.shadowRoot.childNodes) visit(child);
      }
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      parts.push(node.textContent);
    }
    if (node instanceof Element || node instanceof ShadowRoot) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(root);
  return normalizeText(parts.join(' '));
}

function queryDeep(root: ParentNode, selector: string): Element[] {
  const found: Element[] = [];
  const visit = (node: ParentNode) => {
    node.querySelectorAll(selector).forEach((element) => found.push(element));
    node.querySelectorAll('*').forEach((element) => {
      if (element.shadowRoot) visit(element.shadowRoot);
    });
  };
  visit(root);
  return found;
}

function shadowHost(node: Node): Element | null {
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

// closest() stops at a shadow root, and the reply expander is not a direct
// child of the thread. Walk the real tree so a nested reply's own button is
// not read as the thread total.
function enclosingReplies(element: Element, thread: Element): Element | null {
  let node: Node | null = element;
  while (node && node !== thread) {
    if (
      node instanceof Element &&
      (node.matches('ytd-comment-replies-renderer') || node.id === 'replies')
    ) {
      return node;
    }
    const host = shadowHost(node);
    node = host && host !== node ? host : node.parentNode;
  }
  return null;
}

function insideNestedReply(element: Element): boolean {
  let node: Node | null = element;
  let crossedReplyBody = false;
  while (node) {
    if (node instanceof Element) {
      if (node.matches('ytd-comment-thread-renderer')) return false;
      if (node.matches('ytd-comment-view-model, ytd-comment-renderer')) {
        crossedReplyBody = true;
      }
      if (
        crossedReplyBody &&
        (node.matches('ytd-comment-replies-renderer') || node.id === 'replies')
      ) {
        return true;
      }
    }
    const host = shadowHost(node);
    node = host && host !== node ? host : node.parentNode;
  }
  return false;
}

function commentIdFromThread(thread: Element): string | null {
  const owned = (element: Element) => !enclosingReplies(element, thread);
  for (const link of queryDeep(thread, 'a[href*="lc="]')) {
    if (!owned(link)) continue;
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      const id = canonicalDomCommentId(
        new URL(href, window.location.origin).searchParams.get('lc'),
      );
      if (id) return id;
    } catch {
      // A malformed permalink is skipped; the next link may still be valid.
    }
  }
  for (const node of queryDeep(thread, '[comment-id], [data-comment-id]')) {
    if (!owned(node)) continue;
    const id = canonicalDomCommentId(
      node.getAttribute('comment-id') || node.getAttribute('data-comment-id'),
    );
    if (id) return id;
  }
  return null;
}

function visibleReplyCount(thread: Element): string | null {
  let best = 0;
  let bestLabel: string | null = null;
  const consider = (host: Element, allowBare: boolean) => {
    // A nested reply has its own expander. The thread total is the button
    // on the thread itself.
    if (insideNestedReply(host)) return;
    const count = replyButtonCountFromText(accessibleText(host), allowBare);
    const value = pageReplyCount(count);
    if (value == null || value <= best) return;
    best = value;
    bestLabel = count;
  };

  // The expander YouTube draws under the comment is the total Hide spam
  // must match. A later, larger control must not replace it.
  const repliesRoot =
    thread.querySelector('ytd-comment-replies-renderer, #replies') ?? thread;
  for (const host of queryDeep(repliesRoot, '#more-replies, #more-replies-button')) {
    consider(host, true);
  }
  if (bestLabel) return bestLabel;

  for (const host of queryDeep(
    repliesRoot,
    'button, ytd-button-renderer, button-view-model, yt-button-shape',
  )) {
    consider(host, false);
  }
  if (bestLabel) return bestLabel;

  // innerText still contains "229 yanıt" when the expander's nodes sit in a
  // shadow root this walk did not reach. The like count beside Reply is not
  // a reply total; replyButtonCountFromText leaves that pair out.
  const fallbackText = thread instanceof HTMLElement ? thread.innerText : thread.textContent;
  const fallback = replyButtonCountFromText(fallbackText, false);
  return pageReplyCount(fallback) != null ? fallback : null;
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
    first.replyToId === second.replyToId &&
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
    let activeCrawlRequestId = '';
    let loadAllForVideoId: string | null = null;
    let loadAllStartedAt = 0;
    let lastCrawlProgressAt = 0;
    let hiddenAt = 0;
    let lastCountRequestAt = 0;
    let lastCountRequestVideoId = '';
    let scanTimeout: number | undefined;
    let fallbackId = 0;
    let lastPublishedSignature = '';
    let replyStamp = 0;
    let publishTimer: number | undefined;
    // The order the popup is showing. YouTube resets to "Top" on every video,
    // so this does too.
    let sortOrder: CommentSortOrder = DEFAULT_COMMENT_SORT_ORDER;
    // Default matches the watch page (extras hidden). Show spam turns this off.
    let hideFilteredComments = true;
    // True once YouTube's own ranking is in the store. Page order is only a
    // stand-in until then, and mixing the two scales would scramble the list.
    let hasFetchedRanks = false;
    let searchGeneration = 0;
    let searchIndex: { key: string; entries: Array<{ id: string; hay: string }> } | null = null;
    let searchMatches: { key: string; ids: string[] } | null = null;

    const store = new CommentStore();
    const comments = store.comments;
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

    const remember = (comment: YouTubeComment, fromPage = false) => {
      store.remember(comment, fromPage);
    };

    // Copies the reply totals currently drawn under each visible thread.
    // The comment renderer is nested inside #comment-container, so a direct
    // child lookup never saw the button and Hide spam kept the featured set
    // instead of the number on the page.
    const refreshPageReplyCounts = (): boolean => {
      const root = document.querySelector(COMMENTS_ROOT_SELECTOR);
      if (!root) return false;
      let changed = false;
      for (const thread of root.querySelectorAll('ytd-comment-thread-renderer')) {
        const count = visibleReplyCount(thread);
        const id = commentIdFromThread(thread);
        if (!count || !id) continue;
        if (!store.notePageReplyCount(id, count)) continue;
        replyStamp += 1;
        changed = true;
      }
      return changed;
    };

    const applyPatch = (patch: CommentPatch) => {
      store.applyPatch(patch);
    };

    const currentView = (): CommentView => ({
      sortOrder,
      hideFiltered: hideFilteredComments,
      canFilter: fetchedAll && !truncated,
    });

    const threadFor = (id: string): CommentThread | null => store.thread(id, currentView());

    const threadsFrom = (offset: number, limit: number): CommentThread[] =>
      store.threads(offset, limit, currentView());

    const collectListedComments = async (): Promise<YouTubeComment[]> => {
      const view = currentView();
      const ids = store.rootIds(view);
      const listed: YouTubeComment[] = [];
      for (let index = 0; index < ids.length; index += 1) {
        const thread = store.thread(ids[index] ?? '', view);
        if (!thread) continue;
        listed.push(thread.parent, ...thread.replies);
        if (index > 0 && index % 300 === 0) await yieldToUi();
      }
      return listed;
    };

    const getSnapshot = (): CommentsSnapshot => {
      const threads = threadsFrom(0, MAX_SNAPSHOT_COMMENTS);
      return {
        videoId: activeVideoId,
        videoTitle,
        channelName,
        pageUrl: window.location.href,
        totalCommentsLabel,
        status,
        comments: flattenCommentThreads(threads),
        capturedCount: comments.size,
        threadCount: store.countRoots(),
        capturedAt,
        fetchedAll,
        truncated,
        loadAllCount,
        autoPhase,
        autoError,
        sortOrder,
        hideFilteredComments,
        filteredCount: store.hiddenCount(currentView()),
      };
    };

    const publishUpdateNow = () => {
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
        replyStamp,
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

    const publishUpdate = () => {
      if (status !== 'loading-all') {
        if (publishTimer !== undefined) {
          window.clearTimeout(publishTimer);
          publishTimer = undefined;
        }
        publishUpdateNow();
        return;
      }
      if (publishTimer !== undefined) return;
      publishTimer = ctx.setTimeout(() => {
        publishTimer = undefined;
        publishUpdateNow();
      }, 700);
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
      if (activeCrawlRequestId) {
        void browser.runtime
          .sendMessage({
            type: CRAWL_MESSAGES.cancel,
            requestId: activeCrawlRequestId,
          })
          .catch(() => undefined);
        activeCrawlRequestId = '';
      }
      store.clear();
      replyStamp = 0;
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
            remember(comment);
            commentsChanged = true;
          }
        }
      }

      if (refreshPageReplyCounts()) commentsChanged = true;

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

    const requestPageSession = (videoId: string) =>
      new Promise<InnertubeSession>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timer = window.setTimeout(() => {
          window.removeEventListener('message', onMessage);
          reject(new Error('YouTube client data is not ready. Refresh the video page.'));
        }, 12_000);
        const onMessage = (event: MessageEvent) => {
          if (event.source !== window || event.origin !== window.location.origin) return;
          const data = event.data as {
            type?: string;
            requestId?: string;
            session?: InnertubeSession;
            error?: string;
          } | null;
          if (!data || data.type !== INNERTUBE_BRIDGE.sessionResult || data.requestId !== requestId) {
            return;
          }
          window.clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (data.session) resolve(data.session);
          else reject(new Error(data.error || 'YouTube client data is not ready.'));
        };
        window.addEventListener('message', onMessage);
        window.postMessage(
          { type: INNERTUBE_BRIDGE.sessionRequest, requestId, videoId },
          window.location.origin,
        );
      });

    const fetchRawFromPage = (
      token: string,
      clickTrackingParams?: string,
      authorize = true,
    ) =>
      new Promise<{ body?: string; error?: string; rateLimited?: boolean }>((resolve) => {
        const requestId = crypto.randomUUID();
        const timer = window.setTimeout(() => {
          window.removeEventListener('message', onMessage);
          resolve({ error: 'The YouTube tab could not load the next comment page.' });
        }, 25_000);
        const onMessage = (event: MessageEvent) => {
          if (event.source !== window || event.origin !== window.location.origin) return;
          const data = event.data as {
            type?: string;
            requestId?: string;
            body?: string;
            error?: string;
            rateLimited?: boolean;
          } | null;
          if (!data || data.type !== INNERTUBE_BRIDGE.rawResult || data.requestId !== requestId) {
            return;
          }
          window.clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve({
            body: typeof data.body === 'string' ? data.body : undefined,
            error: typeof data.error === 'string' ? data.error : undefined,
            rateLimited: data.rateLimited === true,
          });
        };
        window.addEventListener('message', onMessage);
        window.postMessage(
          {
            type: INNERTUBE_BRIDGE.rawFetch,
            requestId,
            token,
            clickTrackingParams,
            authorize,
          },
          window.location.origin,
        );
      });

    const crawlFromBackground = async (
      videoId: string,
      generation: number,
      session: InnertubeSession,
    ): Promise<LoadAllCommentsResponse | null> => {
      const requestId = crypto.randomUUID();
      activeCrawlRequestId = requestId;
      status = 'loading-all';
      store.clear();
      hasFetchedRanks = false;
      fetchedAll = false;
      truncated = false;
      loadAllCount = 0;
      capturedAt = null;
      publishUpdateNow();

      try {
        const result = (await browser.runtime.sendMessage({
          type: CRAWL_MESSAGES.start,
          requestId,
          videoId,
          session,
        })) as {
          ok?: boolean;
          count?: number;
          truncated?: boolean;
          totalCommentsLabel?: string | null;
          error?: string;
        } | undefined;

        if (generation !== loadGeneration || activeVideoId !== videoId) {
          return {
            ok: false,
            count: comments.size,
            truncated: false,
            error: 'The video changed before comments finished loading.',
          };
        }

        if (!result?.ok && comments.size === 0) return null;

        if (refreshPageReplyCounts()) capturedAt = new Date().toISOString();
        hasFetchedRanks = comments.size > 0;
        fetchedAll = true;
        truncated = Boolean(result?.truncated || !result?.ok);
        loadAllCount = null;
        applyListedCommentCount(result?.totalCommentsLabel);
        capturedAt = comments.size > 0 ? new Date().toISOString() : capturedAt;
        status = comments.size > 0 ? 'ready' : 'no-comments';
        publishUpdateNow();
        return {
          ok: comments.size > 0 || Boolean(result?.ok),
          count: comments.size,
          truncated,
          error: result?.ok ? undefined : result?.error,
        };
      } catch {
        if (comments.size > 0) {
          fetchedAll = true;
          truncated = true;
          loadAllCount = null;
          status = 'ready';
          publishUpdateNow();
          return { ok: true, count: comments.size, truncated: true };
        }
        return null;
      } finally {
        if (activeCrawlRequestId === requestId) activeCrawlRequestId = '';
      }
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
      loadAllStartedAt = Date.now();
      lastCrawlProgressAt = Date.now();
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

        const session = await requestPageSession(videoId).catch(() => null);
        if (session && generation === loadGeneration && activeVideoId === videoId) {
          const background = await crawlFromBackground(videoId, generation, session);
          if (background) return background;
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
              lastCrawlProgressAt = Date.now();
              status = 'loading-all';
              loadAllCount = data.count;
              applyListedCommentCount(data.totalCommentsLabel);
              if (data.comments?.length || data.patches?.length) {
                hasFetchedRanks = true;
                for (const comment of data.comments ?? []) remember(comment);
                for (const patch of data.patches ?? []) applyPatch(patch);
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

            if (data.comments.length > 0) {
              store.clear();
              for (const comment of data.comments) remember(comment);
            }
            hasFetchedRanks = true;

            refreshPageReplyCounts();
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
          }, 1_800_000);

          window.addEventListener('message', onPageMessage);
          status = 'loading-all';
          store.clear();
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
          loadAllStartedAt = 0;
          lastCrawlProgressAt = 0;
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

    const summarizeLoadedComments = async (
      language?: string,
    ): Promise<SummarizeLoadedResponse> => {
      if (!activeVideoId || comments.size === 0) {
        return {
          ok: false,
          error: 'No comments were found to summarize.',
        };
      }

      const replyLanguage = isReplyLanguageCode(language)
        ? language
        : await getReplyLanguage();

      try {
        const result = (await uploadCommentsForModel({
          kind: 'summary',
          videoId: activeVideoId,
          videoTitle,
          language: replyLanguage,
          comments: await collectListedComments(),
          yieldBetween: yieldToUi,
        })) as CloudSummary;
        const summary = {
          videoId: activeVideoId,
          text: result.text,
          commentCount: result.commentCount,
          generatedAt: new Date().toISOString(),
          model: result.model,
          language: replyLanguage,
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
      language?: string,
    ): Promise<ChatAboutCommentsResponse> => {
      if (!activeVideoId || comments.size === 0) {
        return {
          ok: false,
          error: 'Load comments first, then ask a question.',
        };
      }

      try {
        const replyLanguage = isReplyLanguageCode(language)
          ? language
          : await getReplyLanguage();
        const result = (await uploadCommentsForModel({
          kind: 'chat',
          videoId: activeVideoId,
          videoTitle,
          language: replyLanguage,
          question,
          history,
          comments: await collectListedComments(),
          yieldBetween: yieldToUi,
        })) as CloudChatAnswer;
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
      const replyLanguage = await getReplyLanguage();
      const cached = findCachedSummary(
        await readSummaryCache(),
        videoId,
        replyLanguage,
      );
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
          publishSummary(cached);
          setAutoPhase('idle');
          return;
        }
        const message =
          loaded.error || 'No comments were found to summarize.';
        setAutoPhase('idle', message);
        return;
      }

      if (cached && cached.commentCount === comments.size) {
        publishSummary(cached);
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

    const yieldToUi = () =>
      new Promise<void>((resolve) => {
        ctx.setTimeout(() => resolve(), 0);
      });

    const searchIndexKey = () =>
      [
        activeVideoId,
        comments.size,
        capturedAt,
        hideFilteredComments,
        sortOrder,
        fetchedAll,
        truncated,
      ].join('|');

    const ensureSearchIndex = async (generation: number) => {
      const key = searchIndexKey();
      if (searchIndex?.key === key) return searchIndex.entries;
      if (generation !== searchGeneration) return null;

      // Same set the list shows. Hide spam's fallback keeps every comment when
      // YouTube's Top marks are missing, and search has to follow that.
      const source = await collectListedComments();
      const entries: Array<{ id: string; hay: string }> = [];
      for (let indexCursor = 0; indexCursor < source.length; indexCursor += 1) {
        if (generation !== searchGeneration) return null;
        const comment = source[indexCursor];
        if (!comment) continue;
        entries.push({
          id: comment.id,
          hay: `${comment.author}\n${comment.text}`.toLocaleLowerCase(),
        });
        if (indexCursor > 0 && indexCursor % 2_500 === 0) await yieldToUi();
      }

      if (generation !== searchGeneration) return null;
      searchIndex = { key, entries };
      searchMatches = null;
      return entries;
    };

    const searchLoadedComments = async (
      query: string,
      offset: number,
      limit: number,
    ): Promise<SearchCommentsResponse> => {
      const generation = ++searchGeneration;
      const needle = query.trim().toLocaleLowerCase();
      const empty: SearchCommentsResponse = {
        videoId: activeVideoId,
        query,
        offset,
        matchCount: 0,
        comments: [],
        total: 0,
      };
      if (!needle) return empty;

      const index = await ensureSearchIndex(generation);
      if (!index || generation !== searchGeneration) return empty;

      const matchKey = `${searchIndexKey()}|${needle}`;
      let ids = searchMatches?.key === matchKey ? searchMatches.ids : null;
      if (!ids) {
        ids = [];
        for (let indexCursor = 0; indexCursor < index.length; indexCursor += 1) {
          if (generation !== searchGeneration) return empty;
          const entry = index[indexCursor];
          if (entry && entry.hay.includes(needle)) ids.push(entry.id);
          if (indexCursor > 0 && indexCursor % 4_000 === 0) await yieldToUi();
        }
        if (generation !== searchGeneration) return empty;
        searchMatches = { key: matchKey, ids };
      }

      const start = Math.max(0, offset);
      const page = ids.slice(start, start + limit);
      const out: YouTubeComment[] = [];
      const seenIds = new Set<string>();
      for (const id of page) {
        const comment = comments.get(id);
        if (!comment) continue;
        const rootId = threadParentId(comment) ?? comment.id;
        const parent = comments.get(rootId);
        if (parent && !seenIds.has(parent.id)) {
          seenIds.add(parent.id);
          out.push(parent);
        }
        if (comment.isReply && !seenIds.has(comment.id)) {
          seenIds.add(comment.id);
          out.push(comment);
        }
      }

      return {
        videoId: activeVideoId,
        query,
        offset: start,
        matchCount: page.length,
        comments: out,
        total: ids.length,
      };
    };

    const handleMessage = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) {
        return undefined;
      }

      const messageType = (message as { type?: string }).type;
      if (messageType === CRAWL_MESSAGES.pageFetch) {
        if (window !== window.top) return undefined;
        const request = message as {
          token?: string;
          clickTrackingParams?: string;
          authorize?: boolean;
        };
        if (typeof request.token !== 'string') {
          return { error: 'Missing continuation.' };
        }
        return fetchRawFromPage(
          request.token,
          request.clickTrackingParams,
          request.authorize !== false,
        );
      }

      if (messageType === CRAWL_MESSAGES.batch) {
        if (window !== window.top) return undefined;
        const batch = message as {
          requestId?: string;
          videoId?: string;
          count?: number;
          comments?: YouTubeComment[];
          patches?: CommentPatch[];
          totalCommentsLabel?: string | null;
        };
        if (
          batch.requestId &&
          batch.requestId === activeCrawlRequestId &&
          batch.videoId === activeVideoId
        ) {
          lastCrawlProgressAt = Date.now();
          status = 'loading-all';
          loadAllCount = typeof batch.count === 'number' ? batch.count : comments.size;
          applyListedCommentCount(batch.totalCommentsLabel);
          if (batch.comments?.length || batch.patches?.length) {
            hasFetchedRanks = true;
            for (const comment of batch.comments ?? []) remember(comment);
            for (const patch of batch.patches ?? []) applyPatch(patch);
            capturedAt = new Date().toISOString();
          }
          publishUpdate();
        }
        return { ok: true };
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
        refreshPageReplyCounts();
        const offset = Math.max(0, Math.floor(request.offset) || 0);
        const limit = Math.min(
          MAX_COMMENT_PAGE_THREADS,
          Math.max(1, Math.floor(request.limit ?? MAX_SNAPSHOT_COMMENTS) || MAX_SNAPSHOT_COMMENTS),
        );
        const threads = threadsFrom(offset, limit);
        const response: CommentsPageResponse = {
          videoId: activeVideoId,
          offset,
          comments: flattenCommentThreads(threads),
          total: store.countRoots(),
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

      if (request.type === COMMENT_MESSAGES.searchComments) {
        // Embedded YouTube frames also run this script and have no comments.
        // Replying from one of them would win the race with an empty result.
        if (window !== window.top) return undefined;
        if (request.sortOrder) sortOrder = toCommentSortOrder(request.sortOrder);
        if (typeof request.hideFilteredComments === 'boolean') {
          hideFilteredComments = request.hideFilteredComments;
        }
        return searchLoadedComments(
          request.query,
          request.offset,
          Math.min(200, Math.max(1, request.limit ?? 60)),
        );
      }

      if (request.type === COMMENT_MESSAGES.wake) {
        wakeCollector();
        return Promise.resolve({ ok: true });
      }

      if (request.type === COMMENT_MESSAGES.summarizeLoaded) {
        return summarizeLoadedComments(request.language);
      }

      if (request.type === COMMENT_MESSAGES.chatAboutComments) {
        return chatAboutLoadedComments(
          request.question,
          request.history,
          request.language,
        );
      }

      return undefined;
    };

    browser.runtime.onMessage.addListener(handleMessage);

    const handleStorageChange = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;

      if (SHOW_SPAM_KEY in changes) {
        hideFilteredComments = changes[SHOW_SPAM_KEY]?.newValue !== true;
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

    // Chrome freezes inactive tabs and aborts their network calls. The
    // in-flight comment request then never settles, so coming back does
    // nothing until the page is reloaded. A full crawl of a few thousand
    // comments takes minutes, so "hung" means no progress for a while, not
    // that the load has simply run longer than 45 seconds.
    const HIDDEN_REFETCH_MS = 20_000;
    const NO_PROGRESS_MS = 90_000;

    const dropHungLoad = (force: boolean) => {
      if (!loadAllInFlight) return false;
      const hiddenLong = hiddenAt > 0 && Date.now() - hiddenAt >= HIDDEN_REFETCH_MS;
      const hung =
        lastCrawlProgressAt > 0 && Date.now() - lastCrawlProgressAt > NO_PROGRESS_MS;
      if (!force && !hiddenLong && !hung) return false;

      if (activeCrawlRequestId) {
        void browser.runtime
          .sendMessage({
            type: CRAWL_MESSAGES.cancel,
            requestId: activeCrawlRequestId,
          })
          .catch(() => undefined);
        activeCrawlRequestId = '';
      }
      loadGeneration += 1;
      loadAllInFlight = null;
      loadAllForVideoId = null;
      loadAllStartedAt = 0;
      lastCrawlProgressAt = 0;
      if (status === 'loading-all') {
        loadAllCount = null;
        status = comments.size > 0 ? 'ready' : 'waiting-for-comments';
        publishUpdate();
      }
      return true;
    };

    const wakeCollector = () => {
      if (document.visibilityState === 'hidden') return;

      const away = hiddenAt > 0 ? Date.now() - hiddenAt : 0;
      const dropped = dropHungLoad(away >= HIDDEN_REFETCH_MS);
      hiddenAt = 0;

      const videoId = getYouTubeVideoId(window.location.href);
      if (videoId !== activeVideoId) {
        resetForVideo(videoId);
        scheduleScan(0);
        scheduleAutoSummarize();
        return;
      }

      scheduleScan(0);
      if (!activeVideoId) return;
      requestListedCommentCount(activeVideoId, true);
      publishUpdate();

      if (!autoEnabled) return;
      if (isLoadingAll() && !dropped) return;
      if (!dropped && fetchedAll && comments.size > 0 && away < HIDDEN_REFETCH_MS) {
        return;
      }

      if (dropped || !fetchedAll || comments.size === 0) {
        scheduleAutoSummarize();
      }
    };

    const onHidden = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else wakeCollector();
    };

    ctx.addEventListener(document, 'visibilitychange', onHidden);
    ctx.addEventListener(document, 'resume', () => {
      dropHungLoad(true);
      hiddenAt = Date.now() - HIDDEN_REFETCH_MS;
      wakeCollector();
    });
    ctx.addEventListener(window, 'pageshow', () => {
      hiddenAt = Date.now() - HIDDEN_REFETCH_MS;
      wakeCollector();
    });
    ctx.addEventListener(window, 'focus', () => {
      if (hiddenAt > 0) wakeCollector();
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
    void getShowSpamComments().then((showSpam) => {
      hideFilteredComments = !showSpam;
      publishUpdate();
    });
  },
});
