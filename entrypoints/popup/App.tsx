import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type SummarizeLoadedResponse,
  COMMENT_SORT_OPTIONS,
  DEFAULT_COMMENT_SORT_ORDER,
  getYouTubeVideoId,
  groupCommentsForDisplay,
  type CommentSortOrder,
  type CommentNode,
  type CommentThread,
  type YouTubeComment,
} from '@/lib/comments';
import {
  AUTO_SUMMARIZE_KEY,
  HIDE_FILTERED_KEY,
  setAutoSummarizeEnabled,
  setHideFilteredComments,
} from '@/lib/settings';
import {
  SUMMARY_CACHE_KEY,
  readSummaryCache,
  type SavedSummary,
} from '@/lib/summary-cache';
import {
  clearVideoChat,
  readVideoChat,
  saveVideoChat,
  type ChatMessage,
} from '@/lib/chat-cache';
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
  | { kind: 'working'; message: string }
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
        aria-label="Sort comments"
        title="Sort comments"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <SortIcon />
        <span>Sort by</span>
      </button>

      {open && (
        <div className="sort-options" role="listbox" aria-label="Sort comments">
          {COMMENT_SORT_OPTIONS.map((option) => (
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

function statusLabel(status: CommentsSnapshot['status']): string {
  switch (status) {
    case 'ready':
      return 'Collecting live';
    case 'loading-all':
      return 'Loading all comments';
    case 'loading':
      return 'YouTube is loading';
    case 'no-comments':
      return 'No comments found';
    case 'waiting-for-comments':
      return 'Waiting for comments';
    default:
      return 'Open a video';
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

function repliesLabel(thread: CommentThread): string {
  const listed = thread.parent.replyCount;
  if (listed && listed !== '0') {
    return listed === '1' ? '1 reply' : `${listed} replies`;
  }
  return thread.replies.length === 1
    ? '1 reply'
    : `${thread.replies.length} replies`;
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

function CommentCard({ comment }: { comment: YouTubeComment }) {
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
            <span>{comment.pinnedLabel || 'Pinned'}</span>
          </div>
        )}
        <div className="comment-meta">
          <strong className={comment.isChannelOwner ? 'is-owner' : undefined}>
            {comment.author}
          </strong>
          {comment.isVerified && (
            <span className="verified" title="Verified">
              <VerifiedIcon />
            </span>
          )}
          {comment.publishedAt && <span>{comment.publishedAt}</span>}
        </div>
        <p>{comment.text}</p>
        <div className="comment-stats">
          <span className="stat-likes">
            <ThumbUpIcon />
            {comment.likeCount ?? '0'}
          </span>
          {comment.isCreatorHearted && (
            <span className="stat-heart" title="Loved by the creator">
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
}: {
  nodes: CommentNode[];
  depth: number;
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
            <CommentCard comment={node.comment} />
            {node.children.length > 0 && (
              <ReplyBranch nodes={node.children} depth={depth + 1} />
            )}
          </div>
        </div>
      ))}
    </>
  );
}

function formatCapturedAt(value: string | null): string | null {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleTimeString([], {
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
  const [autoSummarize, setAutoSummarize] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const summaryRunId = useRef(0);
  const summaryInFlightRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const pageCommentsRef = useRef<YouTubeComment[]>([]);
  const visibleCountRef = useRef(COMMENTS_PAGE_SIZE);
  const [pageComments, setPageComments] = useState<YouTubeComment[]>([]);
  const [visibleCount, setVisibleCount] = useState(COMMENTS_PAGE_SIZE);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(
    () => new Set(),
  );
  // YouTube opens every video on "Top", so the popup does too.
  const [sortOrder, setSortOrder] = useState<CommentSortOrder>(
    DEFAULT_COMMENT_SORT_ORDER,
  );
  const sortOrderRef = useRef(sortOrder);
  sortOrderRef.current = sortOrder;
  const [hideFiltered, setHideFiltered] = useState(false);
  const hideFilteredRef = useRef(hideFiltered);
  hideFilteredRef.current = hideFiltered;
  const activeVideoId =
    state.kind === 'ready' ? state.snapshot.videoId : null;
  const activeVideoIdRef = useRef(activeVideoId);
  activeVideoIdRef.current = activeVideoId;
  const targetRef = useRef(readPopupTarget());

  const loadSnapshot = useCallback(async (silent = false) => {
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
    void loadSnapshot(true);
    void browser.storage.local
      .get([AUTO_SUMMARIZE_KEY, HIDE_FILTERED_KEY])
      .then((stored) => {
        setAutoSummarize(stored[AUTO_SUMMARIZE_KEY] === true);
        setHideFiltered(stored[HIDE_FILTERED_KEY] === true);
      });

    const applySummary = (summary: SavedSummary | undefined) => {
      if (!summary || summary.videoId !== activeVideoIdRef.current) return;
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
        applySummary((cache as Record<string, SavedSummary>)[videoId]);
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
    const runId = ++summaryRunId.current;
    setSummaryState({ kind: 'idle' });
    setThreadError(null);

    if (!activeVideoId) return;

    void readSummaryCache()
      .then((cache) => {
        const cachedSummary = cache[activeVideoId];
        if (cachedSummary && summaryRunId.current === runId) {
          setSummaryState({ kind: 'success', value: cachedSummary });
        }
      })
      .catch(() => {
        // A failed cache read should not block a new summary.
      });
  }, [activeVideoId]);

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
    if (summaryInFlightRef.current) return;

    const { snapshot } = state;
    const videoId = snapshot.videoId;

    if (summaryState.kind === 'success' && summaryState.value.videoId === videoId) {
      return;
    }

    if (snapshot.autoPhase === 'fetching') {
      const count = snapshot.loadAllCount ?? capturedCount(snapshot);
      const message = `Loading comments from YouTube… ${count}`;
      if (summaryState.kind !== 'working' || summaryState.message !== message) {
        setSummaryState({ kind: 'working', message });
      }
      return;
    }

    if (snapshot.autoPhase === 'summarizing') {
      const message = 'Sending comments to the secure summary service…';
      if (summaryState.kind !== 'working' || summaryState.message !== message) {
        setSummaryState({ kind: 'working', message });
      }
      return;
    }

    if (summaryState.kind === 'working' && snapshot.status === 'loading-all') {
      const count = snapshot.loadAllCount ?? capturedCount(snapshot);
      const message = `Loading comments from YouTube… ${count}`;
      if (summaryState.message !== message) {
        setSummaryState({ kind: 'working', message });
      }
      return;
    }

    if (snapshot.autoError) {
      if (
        summaryState.kind !== 'error' ||
        summaryState.message !== snapshot.autoError
      ) {
        setSummaryState({ kind: 'error', message: snapshot.autoError });
      }
      return;
    }

    if (
      summaryState.kind === 'working' &&
      snapshot.autoPhase === 'idle' &&
      videoId &&
      summaryState.message.startsWith('Loading comments from YouTube')
    ) {
      void readSummaryCache().then((cache) => {
        if (summaryInFlightRef.current) return;
        const cachedSummary = cache[videoId];
        if (cachedSummary) {
          setSummaryState({ kind: 'success', value: cachedSummary });
        }
      });
    }
  }, [state, summaryState]);

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

  const summarizeFromPage = (runId: number, count: number) => {
    if (state.kind !== 'ready') return;

    if (count === 0) {
      summaryInFlightRef.current = false;
      setSummaryState({
        kind: 'error',
        message: 'No comments were found to summarize.',
      });
      return;
    }

    summaryInFlightRef.current = true;
    setSummaryState({
      kind: 'working',
      message: `Sending ${count} comments to the secure summary service…`,
    });

    void browser.tabs
      .sendMessage(state.tabId, {
        type: COMMENT_MESSAGES.summarizeLoaded,
      })
      .then((response) => {
        if (summaryRunId.current !== runId) return;
        const result = response as SummarizeLoadedResponse;
        if (result?.ok && result.summary) {
          setSummaryState({ kind: 'success', value: result.summary });
          return;
        }

        setSummaryState({
          kind: 'error',
          message: result?.error || 'The comments could not be summarized.',
        });
      })
      .catch(() => {
        if (summaryRunId.current !== runId) return;
        setSummaryState({
          kind: 'error',
          message: 'Refresh the YouTube tab, then try summarizing again.',
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
      message: 'Loading all comments from YouTube…',
    });

    void loadAllComments()
      .then(async (response) => {
        if (summaryRunId.current !== runId) return;

        if (!response) {
          setSummaryState({
            kind: 'error',
            message: 'Refresh the YouTube tab, then try summarizing again.',
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
              message: `${response.error ?? 'Could not load the full comment thread.'} You can still summarize the ${capturedCount(latest)} comments already captured.`,
            });
            return;
          }

          setSummaryState({
            kind: 'error',
            message:
              response.error ??
              'Could not load comments. Scroll to the comments section once, then try again.',
          });
          return;
        }

        summarizeFromPage(runId, response.count);
      })
      .catch(() => {
        if (summaryRunId.current === runId) {
          setSummaryState({
            kind: 'error',
            message: 'Refresh the YouTube tab, then try summarizing again.',
          });
        }
      });
  };

  const handleLoadAll = () => {
    if (state.kind !== 'ready') return;
    setThreadError(null);

    void loadAllComments().then((response) => {
      if (!response) {
        setThreadError('Refresh the YouTube tab, then try loading comments again.');
        return;
      }

      if (!response.ok) {
        setThreadError(
          response.error ??
            'Could not load comments. Scroll to the comments section once, then try again.',
        );
      }
    });
  };

  const summarizeCapturedComments = () => {
    if (state.kind !== 'ready') return;
    if (summaryInFlightRef.current || summaryState.kind === 'working') return;

    const { snapshot } = state;
    const videoId = snapshot.videoId;
    const count = capturedCount(snapshot);
    if (!videoId || count === 0) return;

    summarizeFromPage(++summaryRunId.current, count);
  };

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
      })) as ChatAboutCommentsResponse;

      if (!response?.ok || !response.answer) {
        setChatError(
          response?.error || 'The comments could not be asked about.',
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
      setChatError('Refresh the YouTube tab, then try asking again.');
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
      setExpandedThreadIds(new Set());
      return;
    }

    setPageComments(state.snapshot.comments);
    setVisibleCount(COMMENTS_PAGE_SIZE);
    setExpandedThreadIds(new Set());
  }, [streamKey]);

  pageCommentsRef.current = pageComments;
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
    if (visibleCountRef.current > COMMENTS_PAGE_SIZE) {
      void refreshVisibleComments(visibleCountRef.current);
      return;
    }
    setPageComments(state.snapshot.comments);
  }, [state, refreshVisibleComments]);

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

  const canLoadMore =
    state.kind === 'ready' &&
    visibleCount < listedThreadCount(state.snapshot, sortOrder);

  useEffect(() => {
    const list = listRef.current;
    const sentinel = sentinelRef.current;
    if (!list || !sentinel || !canLoadMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreComments();
        }
      },
      { root: list, rootMargin: '120px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore, loadMoreComments, pageComments.length, visibleCount]);

  const visibleThreads = useMemo(() => {
    const source =
      pageComments.length > 0
        ? pageComments
        : state.kind === 'ready'
          ? state.snapshot.comments
          : [];
    return groupCommentsForDisplay(source, sortOrder).slice(0, visibleCount);
  }, [pageComments, visibleCount, state, sortOrder]);

  // Switching order rewinds the list to the top, the way YouTube reloads the
  // thread when you pick a different sort.
  const changeSortOrder = (next: CommentSortOrder) => {
    if (next === sortOrder) return;

    sortOrderRef.current = next;
    setSortOrder(next);
    setVisibleCount(COMMENTS_PAGE_SIZE);
    setExpandedThreadIds(new Set());
    listRef.current?.scrollTo({ top: 0 });
    void refreshVisibleComments(COMMENTS_PAGE_SIZE, next);
  };

  const toggleThread = (id: string) => {
    setExpandedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isLoadingAll =
    state.kind === 'ready' && state.snapshot.status === 'loading-all';
  // Only a complete walk of the thread can tell a filtered comment apart from
  // one that simply has not been fetched.
  const canFilter =
    state.kind === 'ready' &&
    state.snapshot.fetchedAll &&
    !state.snapshot.truncated;
  const isBusy = isLoadingAll || summaryState.kind === 'working' || chatSending;
  const commentsDisabled =
    state.kind === 'ready' && state.snapshot.status === 'no-comments';
  const loadedCountLabel =
    state.kind === 'ready' && state.snapshot.fetchedAll
      ? state.snapshot.truncated
        ? `loaded (first ${MAX_FETCHED_COMMENTS})`
        : 'loaded'
      : 'captured';

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
          Jump to comments
        </button>
      )}
    </section>
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark">
          <CommentIcon />
        </div>
        <div className="brand-copy">
          <span>YOUTUBE TOOL</span>
          <h1>Comment Catcher</h1>
        </div>
        <label
          className="auto-switch"
          title="Fetch and summarize comments when a video opens"
        >
          <span>Auto</span>
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
            aria-label="Open in a window"
            title="Open in a resizable window"
            onClick={() => void openDetachedWindow()}
          >
            <WindowIcon />
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Refresh captured comments"
          title="Refresh"
          onClick={() => void loadSnapshot()}
          disabled={isRefreshing}
        >
          <RefreshIcon />
        </button>
      </header>

      <main>
        {state.kind === 'loading' && (
          <section className="loading-state" aria-live="polite">
            <span className="spinner" />
            <p>Connecting to this page…</p>
          </section>
        )}

        {state.kind === 'unsupported' &&
          renderEmptyState(
            'Open a YouTube video',
            'This extension collects comments from standard YouTube video pages.',
          )}

        {state.kind === 'unavailable' &&
          renderEmptyState(
            'Refresh the YouTube tab',
            'The collector could not connect. Refresh the video page once, then open this popup again.',
          )}

        {state.kind === 'ready' && (
          <>
            <section className="video-card">
              <div className={`status status-${state.snapshot.status}`}>
                <span className="status-dot" />
                {statusLabel(state.snapshot.status)}
              </div>
              <h2>{state.snapshot.videoTitle || 'YouTube video'}</h2>
              {state.snapshot.channelName && (
                <p className="channel-name">{state.snapshot.channelName}</p>
              )}

              <div className="metrics">
                <div>
                  <strong>
                    {isLoadingAll
                      ? (state.snapshot.loadAllCount ??
                        capturedCount(state.snapshot))
                      : capturedCount(state.snapshot)}
                  </strong>
                  <span>{isLoadingAll ? 'loading' : loadedCountLabel}</span>
                </div>
                <div className="metric-divider" />
                <div>
                  <strong className="total-label">
                    {state.snapshot.totalCommentsLabel || '—'}
                  </strong>
                  <span>listed by YouTube</span>
                </div>
              </div>
              <p className="count-note">
                YouTube&apos;s total is an estimate and includes replies. Some
                comments are hidden or never returned by YouTube.
              </p>
            </section>

            {commentsDisabled &&
              renderEmptyState(
                'Comments are unavailable',
                'This video may have comments disabled.',
              )}

            {!commentsDisabled && (
              <>
                <section className="summary-card">
                  <div className="summary-heading">
                    <div className="summary-title">
                      <span className="summary-icon">
                        <SparklesIcon />
                      </span>
                      <div>
                        <h2>AI summary</h2>
                        <p>One paragraph from the full comment thread</p>
                      </div>
                    </div>
                    <span className="ai-badge">Cloud AI</span>
                  </div>

                  {summaryState.kind === 'idle' && (
                    <div className="summary-intro">
                      <p>
                        {autoSummarize
                          ? 'Auto summarize is on. Opening a video loads comments and saves the paragraph here.'
                          : `Load the comment thread from YouTube, then summarize up to ${MAX_FETCHED_COMMENTS.toLocaleString()} comments with Gemini. You do not need to scroll the page.`}
                      </p>
                      <button
                        className="summary-button"
                        onClick={summarizeAllComments}
                        disabled={isBusy}
                      >
                        <SparklesIcon />
                        {autoSummarize
                          ? 'Summarize this video now'
                          : 'Summarize all comments'}
                      </button>
                      <small>
                        Comment text is sent to Gemini through your secure
                        backend. Most videos load in a few seconds.
                      </small>
                    </div>
                  )}

                  {summaryState.kind === 'working' && (
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
                              ? 'This runs in the tab. You can close the popup.'
                              : 'Fetching the thread in the background. Keep this popup open.'
                            : 'This normally takes only a few seconds.'}
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
                          Try again
                        </button>
                      </div>
                    </div>
                  )}

                  {summaryState.kind === 'success' && (
                    <div className="summary-result">
                      <p className="summary-text">
                        {summaryState.value.text}
                      </p>
                      <div className="summary-result-footer">
                        <span>
                          Based on {summaryState.value.commentCount} comments
                          {summaryState.value.model &&
                            ` • ${summaryState.value.model}`}
                          {summaryState.value.commentCount !==
                            capturedCount(state.snapshot) &&
                            ' • New comments are available'}
                          {state.snapshot.truncated &&
                            ` • Capped at ${MAX_FETCHED_COMMENTS.toLocaleString()}`}
                        </span>
                        <button
                          className="text-button"
                          onClick={summarizeCapturedComments}
                          disabled={isBusy || capturedCount(state.snapshot) === 0}
                          title="Summarize the comments already loaded"
                        >
                          Update
                        </button>
                      </div>
                    </div>
                  )}
                </section>

                <ChatPanel
                  disabled={
                    capturedCount(state.snapshot) === 0 ||
                    summaryState.kind === 'working' ||
                    isLoadingAll
                  }
                  disabledReason={
                    capturedCount(state.snapshot) === 0
                      ? 'Load comments first to ask about this video.'
                      : isLoadingAll || summaryState.kind === 'working'
                        ? 'Wait until comments finish loading or summarizing.'
                        : ''
                  }
                  sending={chatSending}
                  error={chatError}
                  messages={chatMessages}
                  onSend={(question) => void sendChatQuestion(question)}
                  onClear={clearChat}
                />

                {capturedCount(state.snapshot) === 0 && (
                  <section className="empty-state">
                    <div className="empty-icon">
                      <CommentIcon />
                    </div>
                    <h2>
                      {isLoadingAll
                        ? 'Loading the comment thread'
                        : 'Load comments without scrolling'}
                    </h2>
                    <p>
                      {isLoadingAll
                        ? 'YouTube is sending the full thread in pages. This can take a little while on busy videos.'
                        : 'The extension can request the comment thread from YouTube instead of waiting for comments to appear on the page.'}
                    </p>
                    {threadError && <p className="thread-error">{threadError}</p>}
                    <div className="empty-actions">
                      <button
                        className="primary-button"
                        onClick={handleLoadAll}
                        disabled={isBusy}
                      >
                        {isLoadingAll ? 'Loading…' : 'Load all comments'}
                      </button>
                      <button
                        className="text-button"
                        onClick={jumpToComments}
                        disabled={isBusy}
                      >
                        Jump to comments
                      </button>
                    </div>
                  </section>
                )}

                {capturedCount(state.snapshot) > 0 && (
                <section className="comments-section">
                  <div className="section-heading">
                    <div>
                      <div className="section-title-row">
                        <h2>
                          {state.snapshot.fetchedAll
                            ? 'Loaded comments'
                            : 'Captured comments'}
                        </h2>
                        <CommentSortMenu
                          value={sortOrder}
                          onChange={changeSortOrder}
                          disabled={isLoadingAll}
                        />
                      </div>
                      <p>
                        {state.snapshot.truncated
                          ? `Stopped at ${MAX_FETCHED_COMMENTS.toLocaleString()} comments`
                          : formatCapturedAt(state.snapshot.capturedAt)
                            ? `Updated ${formatCapturedAt(state.snapshot.capturedAt)}`
                            : 'Updates as comments load'}
                      </p>
                    </div>
                      <div className="section-actions">
                        <label
                          className={`auto-switch filter-switch${canFilter ? '' : ' is-unavailable'}`}
                          title={
                            canFilter
                              ? "Hide everything YouTube keeps out of its Top listing. Its own Newest option calls that set potential spam, and it is where banned and held-for-review replies show up."
                              : 'Load the whole thread first. Until then a comment missing from Top may simply be one the Top pass has not reached yet.'
                          }
                        >
                          <span>Hide spam</span>
                          <input
                            type="checkbox"
                            checked={hideFiltered}
                            disabled={isBusy || !canFilter}
                            onChange={() => {
                              const next = !hideFiltered;
                              hideFilteredRef.current = next;
                              setHideFiltered(next);
                              setVisibleCount(COMMENTS_PAGE_SIZE);
                              void setHideFilteredComments(next);
                              void refreshVisibleComments(COMMENTS_PAGE_SIZE);
                            }}
                          />
                          <span className="switch-track" />
                        </label>
                      </div>
                  </div>
                  {threadError && <p className="thread-error">{threadError}</p>}

                  <div className="section-subactions">
                    {canFilter && state.snapshot.filteredCount > 0 && (
                      <span className="filter-note">
                        {state.snapshot.filteredCount}{' '}
                        {hideFiltered ? 'spam hidden' : 'flagged by YouTube'}
                      </span>
                    )}
                    <button
                      className="text-button"
                      onClick={handleLoadAll}
                      disabled={isBusy}
                    >
                      {isLoadingAll ? 'Loading…' : 'Load all'}
                    </button>
                    <button
                      className="text-button"
                      onClick={jumpToComments}
                      disabled={isBusy}
                    >
                      Jump to page
                    </button>
                  </div>

                  <div className="comment-list" ref={listRef}>
                    {visibleThreads.map((thread) => {
                      const expanded = expandedThreadIds.has(thread.parent.id);
                      const canShowReplies = thread.replies.length > 0;

                      return (
                        <div className="comment-thread" key={thread.parent.id}>
                          <CommentCard comment={thread.parent} />
                          {canShowReplies && (
                            <button
                              type="button"
                              className="replies-toggle"
                              onClick={() => toggleThread(thread.parent.id)}
                            >
                              {expanded
                                ? 'Hide replies'
                                : `View ${repliesLabel(thread)}`}
                            </button>
                          )}
                          {expanded && (
                            <ReplyBranch nodes={thread.tree} depth={1} />
                          )}
                        </div>
                      );
                    })}
                    {canLoadMore && (
                      <div ref={sentinelRef} className="list-sentinel" />
                    )}
                  </div>
                </section>
                )}
              </>
            )}
          </>
        )}
      </main>

      <footer>
        <span>Fast summaries powered by Gemini</span>
        <span className="footer-dot">•</span>
        <span>Ask the comments anything</span>
      </footer>
      <ResizeHandle />
    </div>
  );
}

export default App;
