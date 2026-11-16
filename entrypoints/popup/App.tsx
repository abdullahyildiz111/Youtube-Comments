import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react';
import {
  commentExportFileName,
  commentsToCsv,
  commentsToPdf,
  downloadBlob,
  rowsForExport,
  type CommentExportMeta,
} from '@/lib/export-comments';
import {
  COMMENT_MESSAGES,
  MAX_FETCHED_COMMENTS,
  MAX_SNAPSHOT_COMMENTS,
  type ChatAboutCommentsResponse,
  type CommentsPageResponse,
  type CommentsSnapshot,
  type CommentsUpdatedMessage,
  type LoadAllCommentsResponse,
  type SummaryReadyMessage,
  type ScrollToCommentsResponse,
  type SearchCommentsResponse,
  type SummarizeLoadedResponse,
  DEFAULT_COMMENT_SORT_ORDER,
  getYouTubeVideoId,
  groupCommentsForDisplay,
  type CommentSortOrder,
  type CommentNode,
  type CommentThread,
  type YouTubeComment,
} from '@/lib/comments';
import { languageLabel, REPLY_LANGUAGES } from '@/lib/languages';
import {
  AUTO_SUMMARIZE_KEY,
  DEFAULT_REPLY_LANGUAGE,
  HIDE_FILTERED_KEY,
  getReplyLanguage,
  setAutoSummarizeEnabled,
  setHideFilteredComments,
  setReplyLanguage as storeReplyLanguage,
} from '@/lib/settings';
import {
  SUMMARY_CACHE_KEY,
  readSummaryCache,
  findCachedSummary,
  type SavedSummary,
} from '@/lib/summary-cache';
import {
  clearVideoChat,
  readVideoChat,
  saveVideoChat,
  type ChatMessage,
} from '@/lib/chat-cache';
import {
  fill,
  languageName,
  localizeMessage,
  UiTextProvider,
  useUiText,
  uiText,
} from '@/lib/ui-text';
import { ChatPanel } from './ChatPanel';
import { ResizeHandle } from './ResizeHandle';
import {
  OPEN_DETACHED_MESSAGE,
  POPUP_RETARGET_MESSAGE,
  isDetachedPopup,
} from './popup-size';
import './App.css';

const COMMENTS_PAGE_SIZE = MAX_SNAPSHOT_COMMENTS;

type PopupTarget = { windowId?: number; tabId?: number };

function readPopupTarget(): PopupTarget {
  const params = new URLSearchParams(location.search);
  const windowId = Number(params.get('windowId'));
  const tabId = Number(params.get('tabId'));
  return {
    windowId: Number.isInteger(windowId) && windowId > 0 ? windowId : undefined,
    tabId: Number.isInteger(tabId) && tabId > 0 ? tabId : undefined,
  };
}

function rememberPopupTarget(target: PopupTarget) {
  const url = new URL(location.href);
  url.searchParams.set('detached', '1');
  if (target.windowId != null) url.searchParams.set('windowId', String(target.windowId));
  else url.searchParams.delete('windowId');
  if (target.tabId != null) url.searchParams.set('tabId', String(target.tabId));
  else url.searchParams.delete('tabId');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

async function findVideoTab(target: PopupTarget) {
  if (!isDetachedPopup()) {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab;
  }

  if (target.windowId != null) {
    const [active] = await browser.tabs.query({
      active: true,
      windowId: target.windowId,
    });
    if (active?.id) return active;
  }

  if (target.tabId != null) {
    try {
      return await browser.tabs.get(target.tabId);
    } catch {
      // That tab has been closed.
    }
  }

  const windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ['normal'],
  });
  const focused = windows.find((item) => item.focused) ?? windows[0];
  return focused?.tabs?.find((item) => item.active);
}

async function openDetachedWindow() {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  await browser.runtime.sendMessage({
    type: OPEN_DETACHED_MESSAGE,
    windowId: tab?.windowId,
    tabId: tab?.id,
  });
}

type PopupState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; snapshot: CommentsSnapshot; tabId: number };

type SummaryState =
  | { kind: 'idle' }
  | {
      kind: 'working';
      message: string;
      phase?: 'fetching' | 'sending' | 'loading-all';
      previous?: SavedSummary;
    }
  | { kind: 'success'; value: SavedSummary }
  | { kind: 'error'; message: string };

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19.7 7.3A9 9 0 1 0 21 12h-2a7 7 0 1 1-2.05-4.95L14 10h7V3l-1.3 1.3v3Z" />
    </svg>
  );
}

function WindowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3h7v7h-2V6.41l-5.3 5.3-1.4-1.42L17.59 5H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z" />
    </svg>
  );
}

function EarthIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a10 10 0 1 0 .01 20.01A10 10 0 0 0 12 2Zm-1 17.93C7.05 19.44 4 16.08 4 12c0-.62.08-1.21.21-1.79L9 15v1a2 2 0 0 0 2 2v1.93Zm6.9-2.54A2.01 2.01 0 0 0 17 16h-1v-3a1 1 0 0 0-1-1H8v-2h2a1 1 0 0 0 1-1V7h2a2 2 0 0 0 2-2v-.41A8 8 0 0 1 20 12a7.96 7.96 0 0 1-2.1 5.39Z" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5.4 3.6A1 1 0 0 1 2 20.77V5a2 2 0 0 1 2-2Zm0 2v13.9L8.4 16H20V5H4Zm3 3h10v2H7V8Zm0 4h7v2H7v-2Z" />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 5H3a1 1 0 000 2h18a1 1 0 100-2Zm-6 6H3a1 1 0 000 2h12a1 1 0 000-2Zm-6 6H3a1 1 0 000 2h6a1 1 0 000-2Z" />
    </svg>
  );
}

function CommentSortMenu({
  value,
  onChange,
  disabled,
}: {
  value: CommentSortOrder;
  onChange: (next: CommentSortOrder) => void;
  disabled: boolean;
}) {
  const { copy } = useUiText();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="sort-menu" ref={rootRef}>
      <button
        type="button"
        className="sort-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={copy.sortComments}
        title={copy.sortComments}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <SortIcon />
        <span>{copy.sortBy}</span>
      </button>

      {open && (
        <div className="sort-options" role="listbox" aria-label={copy.sortComments}>
          {([
            { value: 'top' as const, label: copy.sortTop, description: copy.sortTopHint },
            { value: 'newest' as const, label: copy.sortNewest, description: copy.sortNewestHint },
          ]).map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`sort-option${option.value === value ? ' is-selected' : ''}`}
              onClick={() => {
                setOpen(false);
                onChange(option.value);
              }}
            >
              <span className="sort-option-title">{option.label}</span>
              <span className="sort-option-subtitle">{option.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SparklesIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2 1.45 4.55L18 8l-4.55 1.45L12 14l-1.45-4.55L6 8l4.55-1.45L12 2Zm6 10 .95 3.05L22 16l-3.05.95L18 20l-.95-3.05L14 16l3.05-.95L18 12ZM5 13l1.2 3.8L10 18l-3.8 1.2L5 23l-1.2-3.8L0 18l3.8-1.2L5 13Z" />
    </svg>
  );
}

function statusLabel(
  status: CommentsSnapshot['status'],
  copy: ReturnType<typeof uiText>,
): string {
  switch (status) {
    case 'ready':
      return copy.collectingLive;
    case 'loading-all':
      return copy.loadingAllStatus;
    case 'loading':
      return copy.youtubeLoading;
    case 'no-comments':
      return copy.noCommentsFound;
    case 'waiting-for-comments':
      return copy.waitingForComments;
    default:
      return copy.openAVideo;
  }
}

function capturedCount(snapshot: CommentsSnapshot): number {
  return snapshot.capturedCount ?? snapshot.comments.length;
}

function listedThreadCount(
  snapshot: CommentsSnapshot,
  order: CommentSortOrder,
): number {
  return typeof snapshot.threadCount === 'number'
    ? snapshot.threadCount
    : groupCommentsForDisplay(snapshot.comments, order).length;
}

function repliesLabel(thread: CommentThread, copy: ReturnType<typeof uiText>): string {
  const listed = thread.parent.replyCount;
  const count = listed && listed !== '0' ? listed : String(thread.replies.length);
  return count === '1' ? copy.oneReply : fill(copy.manyReplies, { count });
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 3v2h-1v6l2 2v2h-5v5l-1 1-1-1v-5H5v-2l2-2V5H6V3h10Z" />
    </svg>
  );
}

function VerifiedIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.4 14.6L6.4 12.4l1.4-1.4 2.8 2.8 5.6-5.6 1.4 1.4-7 7Z" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z" />
    </svg>
  );
}

function ThumbUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 21h2.5V9H2v12Zm19.8-9.1c.13-.26.2-.55.2-.85V10c0-1.1-.9-2-2-2h-5.6l.94-4.5a1 1 0 0 0-.26-.9L14 1.5 7.6 7.9c-.38.38-.6.9-.6 1.44V19c0 1.1.9 2 2 2h8.2c.78 0 1.47-.45 1.79-1.14L21.8 11.9Z" />
    </svg>
  );
}

function highlightMatch(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return text;
  const hay = text.toLocaleLowerCase();
  const look = needle.toLocaleLowerCase();
  if (!look) return text;

  const parts: Array<string | ReactElement> = [];
  let cursor = 0;
  let index = hay.indexOf(look);
  let key = 0;
  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    const end = index + look.length;
    parts.push(
      <mark key={key} className="search-hit">
        {text.slice(index, end)}
      </mark>,
    );
    key += 1;
    cursor = end;
    index = hay.indexOf(look, cursor);
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function CommentCard({
  comment,
  query = '',
}: {
  comment: YouTubeComment;
  query?: string;
}) {
  const { copy } = useUiText();
  return (
    <article
      className={`comment-card${comment.isReply ? ' is-reply' : ''}`}
    >
      <div className="avatar" aria-hidden="true">
        {comment.avatarUrl ? (
          <img src={comment.avatarUrl} alt="" />
        ) : (
          comment.author.slice(0, 1).toUpperCase()
        )}
      </div>
      <div className="comment-body">
        {comment.isPinned && (
          <div className="pinned-row">
            <PinIcon />
            <span>{comment.pinnedLabel || copy.pinned}</span>
          </div>
        )}
        <div className="comment-meta">
          <strong className={comment.isChannelOwner ? 'is-owner' : undefined}>
            {highlightMatch(comment.author, query)}
          </strong>
          {comment.isVerified && (
            <span className="verified" title={copy.verified}>
              <VerifiedIcon />
            </span>
          )}
          {comment.publishedAt && <span>{comment.publishedAt}</span>}
        </div>
        <p>{highlightMatch(comment.text, query)}</p>
        <div className="comment-stats">
          <span className="stat-likes">
            <ThumbUpIcon />
            {comment.likeCount ?? '0'}
          </span>
          {comment.isCreatorHearted && (
            <span className="stat-heart" title={copy.lovedByCreator}>
              <HeartIcon />
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

// One nested reply: a gutter holding YouTube's elbow and continuation lines,
// then the comment and any replies below it. Depth is not capped.
function ReplyBranch({
  nodes,
  depth,
  query = '',
}: {
  nodes: CommentNode[];
  depth: number;
  query?: string;
}) {
  return (
    <>
      {nodes.map((node, index) => (
        <div
          className={[
            'sub-thread',
            index === nodes.length - 1 ? 'is-last' : '',
            // A 420px popup cannot afford YouTube's full indent at every
            // level, so deep branches keep the connector but narrow the step.
            depth > 8 ? 'is-flush' : depth > 4 ? 'is-tight' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          key={node.comment.id}
        >
          <div className="threadline" aria-hidden="true">
            <span className="thread-connection" />
            <span className="thread-continuation" />
          </div>
          <div className="sub-thread-content">
            <CommentCard comment={node.comment} query={query} />
            {node.children.length > 0 && (
              <ReplyBranch nodes={node.children} depth={depth + 1} query={query} />
            )}
          </div>
        </div>
      ))}
    </>
  );
}

const CommentThreadList = memo(function CommentThreadList({
  threads,
  query,
  expandedThreadIds,
  emptyLabel,
  onToggle,
  canLoadMore,
  sentinelRef,
}: {
  threads: CommentThread[];
  query: string;
  expandedThreadIds: Set<string>;
  emptyLabel: string;
  onToggle: (id: string) => void;
  canLoadMore: boolean;
  sentinelRef: RefObject<HTMLDivElement | null>;
}) {
  const { copy } = useUiText();
  return (
    <>
      {threads.length === 0 && <p className="comment-list-empty">{emptyLabel}</p>}
      {threads.map((thread) => {
        const expanded = expandedThreadIds.has(thread.parent.id);
        const canShowReplies = thread.replies.length > 0;
        return (
          <div className="comment-thread" key={thread.parent.id}>
            <CommentCard comment={thread.parent} query={query} />
            {canShowReplies && (
              <button
                type="button"
                className="replies-toggle"
                onClick={() => onToggle(thread.parent.id)}
              >
                {expanded
                  ? copy.hideReplies
                  : fill(copy.viewReplies, { label: repliesLabel(thread, copy) })}
              </button>
            )}
            {expanded && <ReplyBranch nodes={thread.tree} depth={1} query={query} />}
          </div>
        );
      })}
      {canLoadMore && <div ref={sentinelRef} className="list-sentinel" />}
    </>
  );
});

function CommentSearchField({
  onQuery,
}: {
  onQuery: (query: string) => void;
}) {
  const { copy } = useUiText();
  const labelRef = useRef<HTMLLabelElement>(null);
  const timerRef = useRef(0);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const schedule = (value: string) => {
    labelRef.current?.classList.toggle('has-text', value.length > 0);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => onQuery(value.trim()), 180);
  };

  return (
    <label className="comment-search" ref={labelRef}>
      <input
        type="search"
        placeholder={copy.searchPlaceholder}
        aria-label={copy.searchPlaceholder}
        onChange={(event) => schedule(event.currentTarget.value)}
      />
      <button
        type="button"
        className="comment-search-clear"
        aria-label={copy.clear}
        tabIndex={-1}
        onClick={() => {
          const input = labelRef.current?.querySelector('input');
          if (!input) return;
          input.value = '';
          schedule('');
          input.focus();
        }}
      >
        ×
      </button>
    </label>
  );
}

function CommentsPane({
  snapshot,
  tabId,
  pageComments,
  visibleCount,
  sortOrder,
  hideFiltered,
  threadError,
  isLoadingAll,
  isBusy,
  filterUnavailable,
  exportKind,
  onSortChange,
  onToggleHideSpam,
  onExport,
  onLoadAll,
  onLoadMore,
  pageCanLoadMore,
}: {
  snapshot: CommentsSnapshot;
  tabId: number;
  pageComments: YouTubeComment[];
  visibleCount: number;
  sortOrder: CommentSortOrder;
  hideFiltered: boolean;
  threadError: string | null;
  isLoadingAll: boolean;
  isBusy: boolean;
  filterUnavailable: boolean;
  exportKind: 'csv' | 'pdf' | null;
  onSortChange: (next: CommentSortOrder) => void;
  onToggleHideSpam: () => void;
  onExport: (kind: 'csv' | 'pdf') => void;
  onLoadAll: () => void;
  onLoadMore: () => void;
  pageCanLoadMore: boolean;
}) {
  const { copy, language } = useUiText();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<YouTubeComment[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(
    () => new Set(),
  );
  const searchRun = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const tabIdRef = useRef(tabId);
  const sortOrderRef = useRef(sortOrder);
  const hideFilteredRef = useRef(hideFiltered);
  tabIdRef.current = tabId;
  sortOrderRef.current = sortOrder;
  hideFilteredRef.current = hideFiltered;

  const queryRef = useRef('');
  const seenVideo = useRef(snapshot.videoId);
  useEffect(() => {
    if (seenVideo.current === snapshot.videoId) return;
    seenVideo.current = snapshot.videoId;
    setExpandedThreadIds(new Set());
  }, [snapshot.videoId]);

  const seenSort = useRef(sortOrder);
  useEffect(() => {
    if (seenSort.current === sortOrder) return;
    seenSort.current = sortOrder;
    setExpandedThreadIds(new Set());
    listRef.current?.scrollTo({ top: 0 });
  }, [sortOrder]);

  const requestSearch = useCallback(async (query: string, offset: number, append: boolean) => {
    const activeTabId = tabIdRef.current;
    const run = append ? searchRun.current : ++searchRun.current;
    if (!append) setSearchLoading(true);

    try {
      const response = (await browser.tabs.sendMessage(
        activeTabId,
        {
          type: COMMENT_MESSAGES.searchComments,
          query,
          offset,
          limit: 80,
          sortOrder: sortOrderRef.current,
          hideFilteredComments: hideFilteredRef.current,
        },
        { frameId: 0 },
      )) as SearchCommentsResponse;
      if (searchRun.current !== run || response.query !== query) return;

      if (!append) setSearchQuery(query);
      setSearchHits((current) => {
        const incoming = append ? [...current, ...response.comments] : response.comments;
        const seen = new Set<string>();
        return incoming.filter((comment) => {
          if (seen.has(comment.id)) return false;
          seen.add(comment.id);
          return true;
        });
      });
      setSearchTotal(response.total);
      setSearchOffset(response.offset + response.matchCount);
      setExpandedThreadIds((current) => {
        let changed = false;
        const next = new Set(current);
        for (const comment of response.comments) {
          if (!comment.isReply) continue;
          const root =
            comment.parentId ||
            (comment.id.includes('.') ? comment.id.slice(0, comment.id.indexOf('.')) : '');
          if (root && !next.has(root)) {
            next.add(root);
            changed = true;
          }
        }
        return changed ? next : current;
      });
    } catch {
      if (searchRun.current !== run || append) return;
      setSearchQuery(query);
      setSearchHits([]);
      setSearchTotal(0);
      setSearchOffset(0);
    } finally {
      if (searchRun.current === run) setSearchLoading(false);
    }
  }, []);

  const publishQuery = useCallback((next: string) => {
    queryRef.current = next;
    if (!next) {
      searchRun.current += 1;
      setSearchQuery('');
      setSearchHits([]);
      setSearchTotal(0);
      setSearchOffset(0);
      setSearchLoading(false);
      return;
    }
    void requestSearch(next, 0, false);
  }, [requestSearch]);

  const commentRevision = `${snapshot.videoId ?? ''}:${snapshot.capturedCount}:${snapshot.fetchedAll}`;

  useEffect(() => {
    if (!queryRef.current) return;
    void requestSearch(queryRef.current, 0, false);
  }, [hideFiltered, sortOrder, commentRevision, requestSearch]);

  const canLoadMore = searchQuery ? searchOffset < searchTotal : pageCanLoadMore;

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) return;
    if (searchQuery) {
      if (searchLoading || searchOffset >= searchTotal) return;
      loadingMoreRef.current = true;
      void requestSearch(searchQuery, searchOffset, true).finally(() => {
        loadingMoreRef.current = false;
      });
      return;
    }
    onLoadMore();
  }, [searchQuery, searchLoading, searchOffset, searchTotal, requestSearch, onLoadMore]);

  useEffect(() => {
    const list = listRef.current;
    const sentinel = sentinelRef.current;
    if (!list || !sentinel || !canLoadMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: list, rootMargin: '120px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore, loadMore, pageComments.length, visibleCount, searchHits.length]);

  const visibleThreads = useMemo(() => {
    if (searchQuery) return groupCommentsForDisplay(searchHits, sortOrder);
    const source = pageComments.length > 0 ? pageComments : snapshot.comments;
    return groupCommentsForDisplay(source, sortOrder).slice(0, visibleCount);
  }, [searchQuery, searchHits, pageComments, visibleCount, snapshot, sortOrder]);

  const toggleThread = useCallback((id: string) => {
    setExpandedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <section className="comments-section">
      <div className="section-heading">
        <div>
          <div className="section-title-row">
            <h2>{snapshot.fetchedAll ? copy.loadedComments : copy.capturedComments}</h2>
            <CommentSortMenu
              value={sortOrder}
              onChange={onSortChange}
              disabled={isLoadingAll}
            />
          </div>
          <p>
            {searchLoading && searchHits.length === 0
              ? copy.searching
              : searchQuery
                ? fill(copy.searchMatches, {
                    count: searchTotal.toLocaleString(language),
                  })
                : snapshot.truncated
                  ? fill(copy.stoppedAt, {
                      count: MAX_FETCHED_COMMENTS.toLocaleString(language),
                    })
                  : formatCapturedAt(snapshot.capturedAt, language)
                    ? fill(copy.updatedAt, {
                        time: formatCapturedAt(snapshot.capturedAt, language) ?? '',
                      })
                    : copy.updatesAsLoad}
          </p>
        </div>
        <div className="section-actions">
          <div className="filter-control">
            <label
              className={`auto-switch filter-switch${filterUnavailable ? ' is-unavailable' : ''}`}
              title={filterUnavailable ? copy.hideSpamUnavailable : copy.hideSpamTitle}
            >
              <span>{copy.hideSpam}</span>
              <input
                type="checkbox"
                checked={hideFiltered}
                disabled={filterUnavailable}
                onChange={onToggleHideSpam}
              />
              <span className="switch-track" />
            </label>
            <p className="filter-count">
              {hideFiltered &&
              !filterUnavailable &&
              snapshot.fetchedAll &&
              snapshot.filteredCount > 0
                ? fill(copy.spamHidden, {
                    count: snapshot.filteredCount.toLocaleString(language),
                  })
                : ''}
            </p>
          </div>
        </div>
      </div>
      {threadError && <p className="thread-error">{threadError}</p>}

      <div className="comment-toolbar">
        <div className="toolbar-actions">
          <CommentSearchField onQuery={publishQuery} />
          <button
            type="button"
            className="toolbar-button"
            onClick={() => onExport('csv')}
            disabled={isLoadingAll || exportKind !== null}
            title={copy.exportCsvTitle}
          >
            {exportKind === 'csv' ? copy.exporting : copy.exportCsv}
          </button>
          <button
            type="button"
            className="toolbar-button"
            onClick={() => onExport('pdf')}
            disabled={isLoadingAll || exportKind !== null}
            title={copy.exportPdfTitle}
          >
            {exportKind === 'pdf' ? copy.exporting : copy.exportPdf}
          </button>
          <button
            type="button"
            className="toolbar-button"
            onClick={onLoadAll}
            disabled={isBusy}
          >
            {isLoadingAll ? copy.loadingShort : copy.loadAll}
          </button>
        </div>
      </div>

      <div className="comment-list" ref={listRef}>
        <CommentThreadList
          threads={visibleThreads}
          query={searchQuery}
          expandedThreadIds={expandedThreadIds}
          emptyLabel={searchQuery ? copy.searchEmpty : copy.commentsArriving}
          onToggle={toggleThread}
          canLoadMore={canLoadMore}
          sentinelRef={sentinelRef}
        />
      </div>
    </section>
  );
}

function formatCapturedAt(value: string | null, locale: string): string | null {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function App() {
  const [state, setState] = useState<PopupState>({ kind: 'loading' });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [summaryState, setSummaryState] = useState<SummaryState>({
    kind: 'idle',
  });
  const [threadError, setThreadError] = useState<string | null>(null);
  const [exportKind, setExportKind] = useState<'csv' | 'pdf' | null>(null);
  const [autoSummarize, setAutoSummarize] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const summaryRunId = useRef(0);
  const summaryInFlightRef = useRef(false);
  const summaryStartedAt = useRef(0);
  const autoSummaryKick = useRef('');
  const loadingMoreRef = useRef(false);
  const visibleCountRef = useRef(COMMENTS_PAGE_SIZE);
  const [pageComments, setPageComments] = useState<YouTubeComment[]>([]);
  const [visibleCount, setVisibleCount] = useState(COMMENTS_PAGE_SIZE);
  // YouTube opens every video on "Top", so the popup does too.
  const [sortOrder, setSortOrder] = useState<CommentSortOrder>(
    DEFAULT_COMMENT_SORT_ORDER,
  );
  const sortOrderRef = useRef(sortOrder);
  sortOrderRef.current = sortOrder;
  const [hideFiltered, setHideFiltered] = useState(false);
  const hideFilteredRef = useRef(hideFiltered);
  hideFilteredRef.current = hideFiltered;
  const settingsReady = useRef(false);
  const [replyLanguage, setReplyLanguage] = useState(DEFAULT_REPLY_LANGUAGE);
  const [languageOpen, setLanguageOpen] = useState(false);
  const languageAnchorRef = useRef<HTMLDivElement>(null);
  const replyLanguageRef = useRef(replyLanguage);
  replyLanguageRef.current = replyLanguage;
  const copy = useMemo(() => uiText(replyLanguage), [replyLanguage]);
  const activeVideoId =
    state.kind === 'ready' ? state.snapshot.videoId : null;
  const activeVideoIdRef = useRef(activeVideoId);
  activeVideoIdRef.current = activeVideoId;
  const targetRef = useRef(readPopupTarget());

  const loadSnapshot = useCallback(async (silent = false) => {
    if (!settingsReady.current) return;
    if (!silent) setIsRefreshing(true);

    try {
      const tab = await findVideoTab(targetRef.current);

      if (!tab?.id || (tab.url != null && getYouTubeVideoId(tab.url) === null)) {
        setState({ kind: 'unsupported' });
        return;
      }

      const snapshot = (await browser.tabs.sendMessage(tab.id, {
        type: COMMENT_MESSAGES.getSnapshot,
        sortOrder: sortOrderRef.current,
        hideFilteredComments: hideFilteredRef.current,
      })) as CommentsSnapshot;

      setState({ kind: 'ready', snapshot, tabId: tab.id });
    } catch {
      setState({ kind: 'unavailable' });
    } finally {
      if (!silent) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void browser.storage.local
      .get([AUTO_SUMMARIZE_KEY, HIDE_FILTERED_KEY])
      .then((stored) => {
        const hide = stored[HIDE_FILTERED_KEY] === true;
        hideFilteredRef.current = hide;
        setHideFiltered(hide);
        setAutoSummarize(stored[AUTO_SUMMARIZE_KEY] === true);
        settingsReady.current = true;
        void loadSnapshot(true);
      });
    void getReplyLanguage().then((language) => {
      setReplyLanguage(language);
    });

    const applySummary = (summary: SavedSummary | undefined) => {
      if (!summary || summary.videoId !== activeVideoIdRef.current) return;
      if (summary.language && summary.language !== replyLanguageRef.current) return;
      const started = summaryStartedAt.current;
      if (started && Date.parse(summary.generatedAt) + 1_500 < started) return;
      summaryInFlightRef.current = false;
      summaryStartedAt.current = 0;
      setSummaryState({ kind: 'success', value: summary });
    };

    const handleMessage = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) {
        return;
      }

      if (
        (message as { type?: string }).type === POPUP_RETARGET_MESSAGE &&
        isDetachedPopup()
      ) {
        const next = message as { windowId?: unknown; tabId?: unknown };
        const target: PopupTarget = {
          windowId: typeof next.windowId === 'number' ? next.windowId : undefined,
          tabId: typeof next.tabId === 'number' ? next.tabId : undefined,
        };
        targetRef.current = target;
        rememberPopupTarget(target);
        void loadSnapshot(true);
        return;
      }

      if (
        (message as CommentsUpdatedMessage).type ===
        COMMENT_MESSAGES.commentsUpdated
      ) {
        void loadSnapshot(true);
        return;
      }

      if (
        (message as SummaryReadyMessage).type === COMMENT_MESSAGES.summaryReady
      ) {
        applySummary((message as SummaryReadyMessage).summary);
      }
    };

    const handleStorageChange = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;

      if (AUTO_SUMMARIZE_KEY in changes) {
        setAutoSummarize(changes[AUTO_SUMMARIZE_KEY]?.newValue === true);
      }

      if (SUMMARY_CACHE_KEY in changes) {
        const cache = changes[SUMMARY_CACHE_KEY]?.newValue;
        if (!cache || typeof cache !== 'object') return;
        const videoId = activeVideoIdRef.current;
        if (!videoId) return;
        applySummary(
          findCachedSummary(
            cache as Record<string, SavedSummary>,
            videoId,
            replyLanguageRef.current,
          ),
        );
      }
    };

    browser.runtime.onMessage.addListener(handleMessage);
    browser.storage.onChanged.addListener(handleStorageChange);
    return () => {
      browser.runtime.onMessage.removeListener(handleMessage);
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [loadSnapshot]);

  useEffect(() => {
    if (!languageOpen) return;

    languageAnchorRef.current
      ?.querySelector<HTMLButtonElement>('.language-menu .is-selected')
      ?.scrollIntoView({ block: 'nearest' });

    const close = (event: MouseEvent) => {
      const anchor = languageAnchorRef.current;
      if (anchor && event.target instanceof Node && anchor.contains(event.target)) {
        return;
      }
      setLanguageOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLanguageOpen(false);
    };

    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [languageOpen]);

  useEffect(() => {
    const runId = ++summaryRunId.current;
    setSummaryState({ kind: 'idle' });
    setThreadError(null);

    if (!activeVideoId) return;

    void readSummaryCache()
      .then((cache) => {
        const cachedSummary = findCachedSummary(
          cache,
          activeVideoId,
          replyLanguage,
        );
        if (
          cachedSummary?.language === replyLanguage &&
          summaryRunId.current === runId
        ) {
          setSummaryState({ kind: 'success', value: cachedSummary });
        }
      })
      .catch(() => {
        // A failed cache read should not block a new summary.
      });
  }, [activeVideoId, replyLanguage]);

  useEffect(() => {
    setSortOrder(DEFAULT_COMMENT_SORT_ORDER);
  }, [activeVideoId]);

  useEffect(() => {
    if (!activeVideoId) {
      setChatMessages([]);
      setChatError(null);
      return;
    }

    void readVideoChat(activeVideoId).then((messages) => {
      setChatMessages(messages);
      setChatError(null);
    });
  }, [activeVideoId]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    if (
      summaryState.kind === 'working' &&
      summaryState.previous &&
      summaryStartedAt.current > 0
    ) {
      return;
    }
    if (summaryInFlightRef.current) return;

    const { snapshot } = state;
    const videoId = snapshot.videoId;

    if (summaryState.kind === 'success' && summaryState.value.videoId === videoId) {
      return;
    }

    if (snapshot.autoPhase === 'fetching') {
      const count = snapshot.loadAllCount ?? capturedCount(snapshot);
      const message = fill(copy.loadingCount, { count });
      if (
        summaryState.kind !== 'working' ||
        summaryState.message !== message ||
        summaryState.phase !== 'fetching'
      ) {
        setSummaryState({ kind: 'working', message, phase: 'fetching' });
      }
      return;
    }

    if (snapshot.autoPhase === 'summarizing') {
      const message = fill(copy.sendingComments, {
        count: capturedCount(snapshot),
      });
      if (
        summaryState.kind !== 'working' ||
        summaryState.message !== message ||
        summaryState.phase !== 'sending'
      ) {
        setSummaryState({ kind: 'working', message, phase: 'sending' });
      }
      return;
    }

    if (summaryState.kind === 'working' && snapshot.status === 'loading-all') {
      const count = snapshot.loadAllCount ?? capturedCount(snapshot);
      const message = fill(copy.loadingCount, { count });
      if (summaryState.message !== message || summaryState.phase !== 'loading-all') {
        setSummaryState({ kind: 'working', message, phase: 'loading-all' });
      }
      return;
    }

    if (snapshot.autoError) {
      const message = localizeMessage(snapshot.autoError, copy);
      if (summaryState.kind !== 'error' || summaryState.message !== message) {
        setSummaryState({ kind: 'error', message });
      }
      return;
    }

    if (
      summaryState.kind === 'working' &&
      snapshot.autoPhase === 'idle' &&
      videoId &&
      (summaryState.phase === 'fetching' ||
        summaryState.phase === 'sending' ||
        summaryState.phase === 'loading-all')
    ) {
      void readSummaryCache().then((cache) => {
        if (summaryInFlightRef.current || summaryStartedAt.current > 0) return;
        const cachedSummary = findCachedSummary(
          cache,
          videoId,
          replyLanguageRef.current,
        );
        if (cachedSummary?.language === replyLanguageRef.current) {
          setSummaryState({ kind: 'success', value: cachedSummary });
        }
      });
    }
  }, [state, summaryState, copy]);

  const jumpToComments = async () => {
    if (state.kind !== 'ready') return;

    try {
      const response = (await browser.tabs.sendMessage(state.tabId, {
        type: COMMENT_MESSAGES.scrollToComments,
      })) as ScrollToCommentsResponse;

      if (!response.ok) {
        setState({ kind: 'unavailable' });
        return;
      }

      window.setTimeout(() => void loadSnapshot(true), 700);
    } catch {
      setState({ kind: 'unavailable' });
    }
  };

  const refreshFromYouTube = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setThreadError(null);

    try {
      if (state.kind !== 'ready') {
        await loadSnapshot(true);
        return;
      }

      const response = await loadAllComments();
      if (response && !response.ok) {
        setThreadError(localizeMessage(response.error ?? copy.refreshThenLoad, copy));
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const loadAllComments = async (): Promise<LoadAllCommentsResponse | null> => {
    if (state.kind !== 'ready') return null;

    try {
      const response = (await browser.tabs.sendMessage(state.tabId, {
        type: COMMENT_MESSAGES.loadAllComments,
      })) as LoadAllCommentsResponse;

      await loadSnapshot(true);
      return response;
    } catch {
      setState({ kind: 'unavailable' });
      return null;
    }
  };

  const summarizeFromPage = (
    runId: number,
    count: number,
    previous?: SavedSummary,
  ) => {
    if (state.kind !== 'ready') return;

    if (count === 0) {
      summaryInFlightRef.current = false;
      setSummaryState({
        kind: 'error',
        message: copy.noCommentsToSummarize,
      });
      return;
    }

    summaryInFlightRef.current = true;
    summaryStartedAt.current = Date.now();
    const requestedLanguage = replyLanguageRef.current;
    setSummaryState({
      kind: 'working',
      message: fill(copy.sendingComments, { count }),
      phase: 'sending',
      previous,
    });

    void browser.tabs
      .sendMessage(state.tabId, {
        type: COMMENT_MESSAGES.summarizeLoaded,
        language: requestedLanguage,
      })
      .then((response) => {
        if (summaryRunId.current !== runId) return;
        const result = response as SummarizeLoadedResponse;
        const summary = result?.summary;
        if (result?.ok && summary?.text && summary.videoId === activeVideoIdRef.current) {
          summaryInFlightRef.current = false;
          summaryStartedAt.current = 0;
          setSummaryState({
            kind: 'success',
            value: { ...summary, language: summary.language || requestedLanguage },
          });
          return;
        }

        if (result && result.ok === false) {
          summaryStartedAt.current = 0;
          setSummaryState({
            kind: 'error',
            message: localizeMessage(result.error || copy.couldNotSummarize, copy),
          });
        }
      })
      .catch(() => {
        if (summaryRunId.current !== runId) return;
        void readSummaryCache().then((cache) => {
          if (summaryRunId.current !== runId) return;
          const videoId = activeVideoIdRef.current;
          const cached = videoId
            ? findCachedSummary(cache, videoId, requestedLanguage)
            : undefined;
          if (
            cached &&
            Date.parse(cached.generatedAt) + 1_500 >= summaryStartedAt.current
          ) {
            summaryInFlightRef.current = false;
            summaryStartedAt.current = 0;
            setSummaryState({ kind: 'success', value: cached });
          }
        });
      })
      .finally(() => {
        if (summaryRunId.current === runId) {
          summaryInFlightRef.current = false;
        }
      });
  };

  const summarizeAllComments = () => {
    if (state.kind !== 'ready') return;

    const { snapshot } = state;
    const videoId = snapshot.videoId;
    if (!videoId) return;

    if (capturedCount(snapshot) > 0) {
      summarizeCapturedComments();
      return;
    }

    const runId = ++summaryRunId.current;
    setSummaryState({
      kind: 'working',
      message: copy.loadingFromYouTube,
      phase: 'loading-all',
    });

    void loadAllComments()
      .then(async (response) => {
        if (summaryRunId.current !== runId) return;

        if (!response) {
          setSummaryState({
            kind: 'error',
            message: copy.refreshThenSummarize,
          });
          return;
        }

        if (!response.ok) {
          const latest = (await browser.tabs.sendMessage(state.tabId, {
            type: COMMENT_MESSAGES.getSnapshot,
          })) as CommentsSnapshot;

          if (capturedCount(latest) > 0) {
            setSummaryState({
              kind: 'error',
              message: `${localizeMessage(response.error ?? copy.couldNotLoadThread, copy)} ${fill(copy.canStillSummarize, { count: capturedCount(latest) })}`,
            });
            return;
          }

          setSummaryState({
            kind: 'error',
            message: localizeMessage(response.error ?? copy.couldNotLoadComments, copy),
          });
          return;
        }

        summarizeFromPage(runId, response.count);
      })
      .catch(() => {
        if (summaryRunId.current === runId) {
          setSummaryState({
            kind: 'error',
            message: copy.refreshThenSummarize,
          });
        }
      });
  };

  const exportComments = async (kind: 'csv' | 'pdf') => {
    if (state.kind !== 'ready' || exportKind) return;

    const { snapshot, tabId } = state;
    const spamHidden =
      hideFilteredRef.current &&
      state.snapshot.fetchedAll &&
      !state.snapshot.truncated;
    setExportKind(kind);
    setThreadError(null);

    try {
      const response = (await browser.tabs.sendMessage(tabId, {
        type: COMMENT_MESSAGES.getCommentsPage,
        offset: 0,
        limit: MAX_FETCHED_COMMENTS,
        sortOrder: sortOrderRef.current,
        hideFilteredComments: spamHidden,
      })) as CommentsPageResponse;

      if (response.videoId !== snapshot.videoId) return;

      const rows = rowsForExport(
        groupCommentsForDisplay(response.comments, sortOrderRef.current),
      );
      if (rows.length === 0) {
        setThreadError(copy.noCommentsToExport);
        return;
      }

      const sortLabel =
        sortOrderRef.current === 'newest' ? copy.sortNewest : copy.sortTop;
      const meta: CommentExportMeta = {
        videoTitle: snapshot.videoTitle,
        channelName: snapshot.channelName,
        pageUrl: snapshot.pageUrl,
        sortLabel,
        spamHidden,
        fetchedAll: snapshot.fetchedAll,
        truncated: snapshot.truncated,
        exportedAt: new Date(),
      };
      const filename = commentExportFileName(snapshot.videoTitle, kind);
      const blob =
        kind === 'csv'
          ? new Blob([commentsToCsv(rows, meta)], {
              type: 'text/csv;charset=utf-8',
            })
          : await commentsToPdf(rows, meta);
      downloadBlob(blob, filename);
    } catch {
      setThreadError(copy.couldNotExport);
    } finally {
      setExportKind(null);
    }
  };

  const handleLoadAll = () => {
    if (state.kind !== 'ready') return;
    setThreadError(null);

    void loadAllComments().then((response) => {
      if (!response) {
        setThreadError(copy.refreshThenLoad);
        return;
      }

      if (!response.ok) {
        setThreadError(localizeMessage(response.error ?? copy.couldNotLoadComments, copy));
      }
    });
  };

  const summarizeCapturedComments = () => {
    if (state.kind !== 'ready') return;
    if (summaryState.kind === 'working') return;

    const { snapshot } = state;
    const videoId = snapshot.videoId;
    const count = capturedCount(snapshot);
    if (!videoId || count === 0) return;

    summaryInFlightRef.current = false;
    const previous = summaryState.kind === 'success' ? summaryState.value : undefined;
    summarizeFromPage(++summaryRunId.current, count, previous);
  };

  useEffect(() => {
    if (summaryState.kind !== 'working' || summaryStartedAt.current === 0) return;

    let cancelled = false;
    const startedAt = summaryStartedAt.current;
    const look = async () => {
      const videoId = activeVideoIdRef.current;
      const language = replyLanguageRef.current;
      if (!videoId) return;
      const cached = findCachedSummary(await readSummaryCache(), videoId, language);
      if (cancelled || !cached) return;
      if (Date.parse(cached.generatedAt) + 1_500 < startedAt) return;
      summaryInFlightRef.current = false;
      summaryStartedAt.current = 0;
      setSummaryState({ kind: 'success', value: cached });
    };

    void look();
    const timer = window.setInterval(() => void look(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [summaryState]);

  useEffect(() => {
    if (!autoSummarize || state.kind !== 'ready') return;
    if (summaryState.kind !== 'idle' || summaryInFlightRef.current) return;

    const snapshot = state.snapshot;
    if (!snapshot.fetchedAll || snapshot.autoError || !snapshot.videoId) return;
    if (snapshot.autoPhase === 'fetching' || snapshot.autoPhase === 'summarizing') return;
    if (capturedCount(snapshot) === 0) return;

    const kick = `${snapshot.videoId}:${replyLanguage}`;
    if (autoSummaryKick.current === kick) return;
    autoSummaryKick.current = kick;

    const videoId = snapshot.videoId;
    void readSummaryCache().then((cache) => {
      if (autoSummaryKick.current !== kick || summaryInFlightRef.current) return;
      const cached = findCachedSummary(cache, videoId, replyLanguage);
      if (cached) {
        setSummaryState({ kind: 'success', value: cached });
        return;
      }
      summarizeCapturedComments();
    });
  }, [autoSummarize, replyLanguage, state, summaryState.kind]);

  const sendChatQuestion = async (question: string) => {
    if (state.kind !== 'ready' || chatSending) return;
    if (summaryState.kind === 'working') return;

    const videoId = state.snapshot.videoId;
    if (!videoId || capturedCount(state.snapshot) === 0) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: question,
      createdAt: new Date().toISOString(),
    };
    const pending = [...chatMessages, userMessage];
    setChatMessages(pending);
    setChatSending(true);
    setChatError(null);

    try {
      const response = (await browser.tabs.sendMessage(state.tabId, {
        type: COMMENT_MESSAGES.chatAboutComments,
        question,
        history: chatMessages.map(({ role, text }) => ({ role, text })),
        language: replyLanguageRef.current,
      })) as ChatAboutCommentsResponse;

      if (!response?.ok || !response.answer) {
        setChatError(
          localizeMessage(response?.error || copy.couldNotAsk, copy),
        );
        return;
      }

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: response.answer,
        createdAt: new Date().toISOString(),
      };
      const next = [...pending, assistantMessage];
      setChatMessages(next);
      await saveVideoChat(videoId, next);
    } catch {
      setChatError(copy.refreshThenAsk);
    } finally {
      setChatSending(false);
    }
  };

  const clearChat = () => {
    if (state.kind !== 'ready' || !state.snapshot.videoId || chatSending) return;
    setChatMessages([]);
    setChatError(null);
    void clearVideoChat(state.snapshot.videoId);
  };

  const streamKey =
    state.kind === 'ready'
      ? `${state.snapshot.videoId ?? ''}:${state.snapshot.comments[0]?.id ?? ''}`
      : '';

  useEffect(() => {
    if (state.kind !== 'ready') {
      setPageComments([]);
      setVisibleCount(COMMENTS_PAGE_SIZE);
      return;
    }

    setPageComments(state.snapshot.comments);
    setVisibleCount(COMMENTS_PAGE_SIZE);
  }, [streamKey]);

  visibleCountRef.current = visibleCount;

  const refreshVisibleComments = useCallback(
    async (limit: number, order: CommentSortOrder = sortOrderRef.current) => {
      if (state.kind !== 'ready') return;

      try {
        const response = (await browser.tabs.sendMessage(state.tabId, {
          type: COMMENT_MESSAGES.getCommentsPage,
          offset: 0,
          limit,
          sortOrder: order,
          hideFilteredComments: hideFilteredRef.current,
        })) as CommentsPageResponse;
        if (response.videoId !== state.snapshot.videoId) return;
        if (response.sortOrder !== sortOrderRef.current) return;
        setPageComments(response.comments);
      } catch {
        // The popup can close or the tab can change while a page request is in flight.
      }
    },
    [state],
  );

  useEffect(() => {
    if (state.kind !== 'ready') return;
    // A snapshot that started before the switch moved still carries the old
    // filter. Applying it would put the hidden comments back on screen.
    if (state.snapshot.hideFilteredComments !== hideFilteredRef.current) {
      void refreshVisibleComments(visibleCountRef.current);
      return;
    }
    if (visibleCountRef.current > COMMENTS_PAGE_SIZE) {
      void refreshVisibleComments(visibleCountRef.current);
      return;
    }
    setPageComments(state.snapshot.comments);
  }, [state, refreshVisibleComments, hideFiltered]);

  const loadMoreComments = useCallback(async () => {
    if (state.kind !== 'ready' || loadingMoreRef.current) return;

    const total = listedThreadCount(state.snapshot, sortOrderRef.current);
    const visible = visibleCountRef.current;
    if (visible >= total) return;

    const nextVisible = Math.min(visible + COMMENTS_PAGE_SIZE, total);
    loadingMoreRef.current = true;
    try {
      const response = (await browser.tabs.sendMessage(state.tabId, {
        type: COMMENT_MESSAGES.getCommentsPage,
        offset: 0,
        limit: nextVisible,
        sortOrder: sortOrderRef.current,
        hideFilteredComments: hideFilteredRef.current,
      })) as CommentsPageResponse;

      if (response.videoId !== state.snapshot.videoId) return;
      if (response.sortOrder !== sortOrderRef.current) return;
      if (response.comments.length === 0) {
        setVisibleCount(Math.min(visible, total));
        return;
      }

      setPageComments(response.comments);
      setVisibleCount(Math.min(nextVisible, response.total));
    } catch {
      // The popup can close or the tab can change while a page request is in flight.
    } finally {
      loadingMoreRef.current = false;
    }
  }, [state]);

  const pageCanLoadMore =
    state.kind === 'ready' &&
    visibleCount < listedThreadCount(state.snapshot, sortOrder);

  // Switching order rewinds the list to the top, the way YouTube reloads the
  // thread when you pick a different sort.
  const changeSortOrder = (next: CommentSortOrder) => {
    if (next === sortOrder) return;

    sortOrderRef.current = next;
    setSortOrder(next);
    setVisibleCount(COMMENTS_PAGE_SIZE);
    void refreshVisibleComments(COMMENTS_PAGE_SIZE, next);
  };

  const isLoadingAll =
    state.kind === 'ready' && state.snapshot.status === 'loading-all';
  // A capped thread cannot tell held comments from ones the Top pass never
  // reached. Until the first full load, the switch itself starts that load.
  const filterUnavailable =
    state.kind === 'ready' &&
    state.snapshot.fetchedAll &&
    state.snapshot.truncated;
  const isBusy = isLoadingAll || summaryState.kind === 'working' || chatSending;
  const toggleHideSpam = () => {
    const next = !hideFiltered;
    hideFilteredRef.current = next;
    setHideFiltered(next);
    setVisibleCount(COMMENTS_PAGE_SIZE);
    void setHideFilteredComments(next);

    const needsFetch =
      next &&
      state.kind === 'ready' &&
      !state.snapshot.fetchedAll &&
      !isLoadingAll;
    if (needsFetch) {
      void loadAllComments().finally(() => {
        void refreshVisibleComments(COMMENTS_PAGE_SIZE);
      });
      return;
    }

    void refreshVisibleComments(COMMENTS_PAGE_SIZE);
  };
  const shownSummary =
    summaryState.kind === 'success'
      ? summaryState.value
      : summaryState.kind === 'working'
        ? summaryState.previous
        : undefined;
  const summaryUpdating = summaryState.kind === 'working' && Boolean(shownSummary);
  const commentsDisabled =
    state.kind === 'ready' && state.snapshot.status === 'no-comments';
  const renderEmptyState = (
    title: string,
    description: string,
    showJumpButton = false,
  ) => (
    <section className="empty-state">
      <div className="empty-icon">
        <CommentIcon />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {showJumpButton && (
        <button className="primary-button" onClick={jumpToComments}>
          {copy.jumpToComments}
        </button>
      )}
    </section>
  );

  return (
    <UiTextProvider language={replyLanguage}>
    <div className="app-shell" lang={replyLanguage}>
      <header className="app-header">
        <div className="brand-mark">
          <CommentIcon />
        </div>
        <div className="brand-copy">
          <h1>Comment Catcher</h1>
        </div>
        <div className="language-anchor" ref={languageAnchorRef}>
          <button
            type="button"
            className="icon-button"
            aria-label={`${copy.languageMenu}, ${languageLabel(replyLanguage)}`}
            aria-expanded={languageOpen}
            aria-haspopup="listbox"
            title={languageLabel(replyLanguage)}
            onClick={() => setLanguageOpen((open) => !open)}
          >
            <EarthIcon />
          </button>
          {languageOpen && (
            <ul className="language-menu" role="listbox" aria-label={copy.languageMenu}>
              {[...REPLY_LANGUAGES]
                .sort((first, second) =>
                  first.label.localeCompare(second.label, 'en', {
                    sensitivity: 'base',
                  }),
                )
                .map((language) => (
                <li key={language.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={language.code === replyLanguage}
                    className={language.code === replyLanguage ? 'is-selected' : undefined}
                    onClick={() => {
                      setReplyLanguage(language.code);
                      void storeReplyLanguage(language.code);
                      setLanguageOpen(false);
                    }}
                  >
                    {language.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label
          className="auto-switch"
          title={copy.autoTitle}
        >
          <span>{copy.auto}</span>
          <input
            type="checkbox"
            checked={autoSummarize}
            onChange={() => {
              const next = !autoSummarize;
              setAutoSummarize(next);
              void setAutoSummarizeEnabled(next);
            }}
          />
          <span className="switch-track" />
        </label>
        {!isDetachedPopup() && (
          <button
            type="button"
            className="icon-button"
            aria-label={copy.openWindow}
            title={copy.openWindowTitle}
            onClick={() => void openDetachedWindow()}
          >
            <WindowIcon />
          </button>
        )}
        <button
          className="icon-button"
          aria-label={copy.refreshTitle}
          title={copy.refresh}
          onClick={() => void refreshFromYouTube()}
          disabled={isRefreshing}
        >
          <RefreshIcon />
        </button>
      </header>

      <main>
        {state.kind === 'loading' && (
          <section className="loading-state" aria-live="polite">
            <span className="spinner" />
            <p>{copy.connectingToPage}</p>
          </section>
        )}

        {state.kind === 'unsupported' &&
          renderEmptyState(copy.openYouTubeVideo, copy.openYouTubeVideoHint)}

        {state.kind === 'unavailable' &&
          renderEmptyState(copy.refreshYouTubeTab, copy.collectorHint)}

        {state.kind === 'ready' && (
          <>
            <section className="video-card">
              <div className={`status status-${state.snapshot.status}`}>
                <span className="status-dot" />
                {statusLabel(state.snapshot.status, copy)}
              </div>
              <h2>{state.snapshot.videoTitle || copy.youtubeVideo}</h2>
              {state.snapshot.channelName && (
                <p className="channel-name">{state.snapshot.channelName}</p>
              )}

              <div
                className="metrics"
                title={copy.countTooltip}
              >
                <div>
                  <strong>
                    {isLoadingAll
                      ? (state.snapshot.loadAllCount ??
                        capturedCount(state.snapshot))
                      : capturedCount(state.snapshot)}
                  </strong>
                  <span>
                    {isLoadingAll
                      ? copy.metricLoading
                      : state.snapshot.fetchedAll
                        ? copy.metricLoaded
                        : copy.metricCaptured}
                  </span>
                </div>
                <div className="metric-divider" />
                <div>
                  <strong className="total-label">
                    {state.snapshot.totalCommentsLabel || '—'}
                  </strong>
                  <span>{copy.listedByYouTube}</span>
                </div>
              </div>
            </section>

            {commentsDisabled &&
              renderEmptyState(copy.commentsUnavailable, copy.commentsDisabledHint)}

            {!commentsDisabled && (
              <>
                <section className="summary-card">
                  <div className="summary-heading">
                    <div className="summary-title">
                      <span className="summary-icon">
                        <SparklesIcon />
                      </span>
                      <div>
                        <h2>{copy.aiSummary}</h2>
                        <p>{copy.aiSummaryHint}</p>
                      </div>
                    </div>
                    <span className="ai-badge">{copy.cloudAi}</span>
                  </div>

                  {summaryState.kind === 'idle' && (
                    <div className="summary-intro">
                      <p>
                        {autoSummarize
                          ? copy.autoSummarizeOn
                          : fill(copy.summarizeIntro, {
                              count: MAX_FETCHED_COMMENTS.toLocaleString(replyLanguage),
                            })}
                      </p>
                      <button
                        className="summary-button"
                        onClick={summarizeAllComments}
                        disabled={isBusy}
                      >
                        <SparklesIcon />
                        {autoSummarize ? copy.summarizeNow : copy.summarizeAll}
                      </button>
                      <small>{copy.privacyNote}</small>
                    </div>
                  )}

                  {summaryState.kind === 'working' && !summaryState.previous && (
                    <div
                      className="summary-working"
                      role="status"
                      aria-live="polite"
                    >
                      <span className="summary-spinner" />
                      <div>
                        <strong>{summaryState.message}</strong>
                        <span>
                          {isLoadingAll ||
                          (state.kind === 'ready' &&
                            (state.snapshot.autoPhase === 'fetching' ||
                              state.snapshot.autoPhase === 'summarizing'))
                            ? autoSummarize
                              ? copy.runsInTab
                              : copy.keepPopupOpen
                            : copy.takesSeconds}
                        </span>
                      </div>
                    </div>
                  )}

                  {summaryState.kind === 'error' && (
                    <div className="summary-error" role="alert">
                      <p>{summaryState.message}</p>
                      <div className="summary-error-actions">
                        <button
                          className="secondary-button"
                          onClick={
                            capturedCount(state.snapshot) > 0
                              ? summarizeCapturedComments
                              : summarizeAllComments
                          }
                          disabled={isBusy}
                        >
                          {copy.tryAgain}
                        </button>
                      </div>
                    </div>
                  )}

                  {(shownSummary) && (
                    <div className={`summary-result${summaryUpdating ? ' is-updating' : ''}`}>
                      <p className="summary-text">{shownSummary.text}</p>
                      <div className="summary-result-footer">
                        <span>
                          {summaryUpdating
                            ? summaryState.kind === 'working'
                              ? summaryState.message
                              : ''
                            : fill(copy.basedOn, {
                                count: shownSummary.commentCount.toLocaleString(replyLanguage),
                              })}
                          {!summaryUpdating &&
                            shownSummary.language &&
                            ` • ${languageName(shownSummary.language, replyLanguage)}`}
                          {!summaryUpdating &&
                            shownSummary.model &&
                            ` • ${shownSummary.model}`}
                          {!summaryUpdating &&
                            shownSummary.commentCount !== capturedCount(state.snapshot) &&
                            ` • ${copy.newComments}`}
                          {!summaryUpdating &&
                            state.snapshot.truncated &&
                            ` • ${fill(copy.cappedAt, {
                              count: MAX_FETCHED_COMMENTS.toLocaleString(replyLanguage),
                            })}`}
                        </span>
                        <button
                          className="text-button"
                          onClick={summarizeCapturedComments}
                          disabled={isBusy || capturedCount(state.snapshot) === 0}
                          title={copy.updateTitle}
                        >
                          {summaryUpdating && <span className="summary-spinner is-inline" />}
                          {copy.update}
                        </button>
                      </div>
                    </div>
                  )}
                </section>

                <ChatPanel
                  disabled={
                    capturedCount(state.snapshot) === 0 ||
                    (summaryState.kind === 'working' && !summaryState.previous) ||
                    isLoadingAll
                  }
                  disabledReason={
                    capturedCount(state.snapshot) === 0
                      ? copy.loadCommentsFirst
                      : isLoadingAll ||
                          (summaryState.kind === 'working' && !summaryState.previous)
                        ? copy.waitUntilLoaded
                        : ''
                  }
                  sending={chatSending}
                  error={chatError}
                  messages={chatMessages}
                  onSend={(question) => void sendChatQuestion(question)}
                  onClear={clearChat}
                />

                {capturedCount(state.snapshot) === 0 && !isLoadingAll && (
                  <section className="empty-state">
                    <div className="empty-icon">
                      <CommentIcon />
                    </div>
                    <h2>{copy.loadWithoutScrolling}</h2>
                    <p>{copy.loadWithoutScrollingHint}</p>
                    {threadError && <p className="thread-error">{threadError}</p>}
                    <div className="empty-actions">
                      <button
                        className="primary-button"
                        onClick={handleLoadAll}
                        disabled={isBusy}
                      >
                        {copy.loadAllComments}
                      </button>
                      <button
                        className="text-button"
                        onClick={jumpToComments}
                        disabled={isBusy}
                      >
                        {copy.jumpToComments}
                      </button>
                    </div>
                  </section>
                )}

                {(capturedCount(state.snapshot) > 0 || isLoadingAll) && (
                  <CommentsPane
                    snapshot={state.snapshot}
                    tabId={state.tabId}
                    pageComments={pageComments}
                    visibleCount={visibleCount}
                    sortOrder={sortOrder}
                    hideFiltered={hideFiltered}
                    threadError={threadError}
                    isLoadingAll={isLoadingAll}
                    isBusy={isBusy}
                    filterUnavailable={filterUnavailable}
                    exportKind={exportKind}
                    onSortChange={changeSortOrder}
                    onToggleHideSpam={toggleHideSpam}
                    onExport={(kind) => void exportComments(kind)}
                    onLoadAll={handleLoadAll}
                    onLoadMore={() => void loadMoreComments()}
                    pageCanLoadMore={pageCanLoadMore}
                  />
                )}
              </>
            )}
          </>
        )}
      </main>

      <footer>
        <span>{copy.footerSummaries}</span>
        <span className="footer-dot">•</span>
        <span>{copy.footerAsk}</span>
      </footer>
      <ResizeHandle />
    </div>
    </UiTextProvider>
  );
}

export default App;
