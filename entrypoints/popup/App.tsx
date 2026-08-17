import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMENT_MESSAGES,
  type CommentsSnapshot,
  type CommentsUpdatedMessage,
  type ScrollToCommentsResponse,
  getYouTubeVideoId,
} from '@/lib/comments';
import {
  getCloudSummaryErrorMessage,
  summarizeCommentsInCloud,
} from '@/lib/cloud-summarizer';
import './App.css';

const MAX_VISIBLE_COMMENTS = 100;
const MAX_CACHED_SUMMARIES = 20;
const SUMMARY_CACHE_KEY = 'comment-catcher:summaries';

type PopupState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; snapshot: CommentsSnapshot; tabId: number };

interface SavedSummary {
  videoId: string;
  text: string;
  commentCount: number;
  generatedAt: string;
  model?: string;
}

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

function CommentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5.4 3.6A1 1 0 0 1 2 20.77V5a2 2 0 0 1 2-2Zm0 2v13.9L8.4 16H20V5H4Zm3 3h10v2H7V8Zm0 4h7v2H7v-2Z" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2 1.45 4.55L18 8l-4.55 1.45L12 14l-1.45-4.55L6 8l4.55-1.45L12 2Zm6 10 .95 3.05L22 16l-3.05.95L18 20l-.95-3.05L14 16l3.05-.95L18 12ZM5 13l1.2 3.8L10 18l-3.8 1.2L5 23l-1.2-3.8L0 18l3.8-1.2L5 13Z" />
    </svg>
  );
}

async function readSummaryCache(): Promise<Record<string, SavedSummary>> {
  const stored = await browser.storage.local.get(SUMMARY_CACHE_KEY);
  const cache = stored[SUMMARY_CACHE_KEY];

  return cache && typeof cache === 'object'
    ? (cache as Record<string, SavedSummary>)
    : {};
}

async function saveSummary(summary: SavedSummary): Promise<void> {
  const cache = await readSummaryCache();
  cache[summary.videoId] = summary;

  const trimmedCache = Object.fromEntries(
    Object.values(cache)
      .sort(
        (first, second) =>
          Date.parse(second.generatedAt) - Date.parse(first.generatedAt),
      )
      .slice(0, MAX_CACHED_SUMMARIES)
      .map((entry) => [entry.videoId, entry]),
  );

  await browser.storage.local.set({
    [SUMMARY_CACHE_KEY]: trimmedCache,
  });
}

function statusLabel(status: CommentsSnapshot['status']): string {
  switch (status) {
    case 'ready':
      return 'Collecting live';
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
  const summaryRunId = useRef(0);
  const activeVideoId =
    state.kind === 'ready' ? state.snapshot.videoId : null;

  const loadSnapshot = useCallback(async (silent = false) => {
    if (!silent) setIsRefreshing(true);

    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (
        !tab?.id ||
        !tab.url ||
        getYouTubeVideoId(tab.url) === null
      ) {
        setState({ kind: 'unsupported' });
        return;
      }

      const snapshot = (await browser.tabs.sendMessage(tab.id, {
        type: COMMENT_MESSAGES.getSnapshot,
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

    const handleMessage = (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        (message as CommentsUpdatedMessage).type ===
          COMMENT_MESSAGES.commentsUpdated
      ) {
        void loadSnapshot(true);
      }
    };

    browser.runtime.onMessage.addListener(handleMessage);
    return () => browser.runtime.onMessage.removeListener(handleMessage);
  }, [loadSnapshot]);

  useEffect(() => {
    const runId = ++summaryRunId.current;
    setSummaryState({ kind: 'idle' });

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

  const summarizeAllComments = () => {
    if (state.kind !== 'ready') {
      return;
    }

    const { snapshot } = state;
    const videoId = snapshot.videoId;
    if (!videoId || snapshot.comments.length === 0) return;

    const runId = ++summaryRunId.current;
    setSummaryState({
      kind: 'working',
      message: 'Sending comments to the secure summary service…',
    });

    void summarizeCommentsInCloud(
      snapshot.comments,
      videoId,
      snapshot.videoTitle,
    )
      .then((result) => {
        const summary: SavedSummary = {
          videoId,
          text: result.text,
          commentCount: result.commentCount,
          generatedAt: new Date().toISOString(),
          model: result.model,
        };

        if (summaryRunId.current === runId) {
          setSummaryState({ kind: 'success', value: summary });
        }

        void saveSummary(summary).catch(() => {
          // The generated summary can still be shown if caching fails.
        });
      })
      .catch((error: unknown) => {
        if (summaryRunId.current === runId) {
          setSummaryState({
            kind: 'error',
            message: getCloudSummaryErrorMessage(error),
          });
        }
      });
  };

  const visibleComments = useMemo(() => {
    if (state.kind !== 'ready') return [];
    return state.snapshot.comments.slice(0, MAX_VISIBLE_COMMENTS);
  }, [state]);

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
                  <strong>{state.snapshot.comments.length}</strong>
                  <span>captured</span>
                </div>
                <div className="metric-divider" />
                <div>
                  <strong className="total-label">
                    {state.snapshot.totalCommentsLabel || '—'}
                  </strong>
                  <span>on this video</span>
                </div>
              </div>
            </section>

            {state.snapshot.comments.length === 0 &&
              renderEmptyState(
                state.snapshot.status === 'no-comments'
                  ? 'Comments are unavailable'
                  : 'Comments have not loaded yet',
                state.snapshot.status === 'no-comments'
                  ? 'This video may have comments disabled.'
                  : 'YouTube loads comments only when you reach the comments section.',
                state.snapshot.status !== 'no-comments',
              )}

            {state.snapshot.comments.length > 0 && (
              <>
                <section className="summary-card">
                  <div className="summary-heading">
                    <div className="summary-title">
                      <span className="summary-icon">
                        <SparklesIcon />
                      </span>
                      <div>
                        <h2>AI summary</h2>
                        <p>One paragraph from every captured comment</p>
                      </div>
                    </div>
                    <span className="ai-badge">Cloud AI</span>
                  </div>

                  {summaryState.kind === 'idle' && (
                    <div className="summary-intro">
                      <p>
                        Summarize all {state.snapshot.comments.length} captured
                        comments quickly with Gemini&apos;s free-tier cloud AI.
                      </p>
                      <button
                        className="summary-button"
                        onClick={summarizeAllComments}
                      >
                        <SparklesIcon />
                        Summarize all comments
                      </button>
                      <small>
                        Comment text is sent to Gemini through your secure
                        backend.
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
                        <span>This normally takes only a few seconds.</span>
                      </div>
                    </div>
                  )}

                  {summaryState.kind === 'error' && (
                    <div className="summary-error" role="alert">
                      <p>{summaryState.message}</p>
                      <button
                        className="secondary-button"
                        onClick={summarizeAllComments}
                      >
                        Try again
                      </button>
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
                            state.snapshot.comments.length &&
                            ' • New comments are available'}
                        </span>
                        <button
                          className="text-button"
                          onClick={summarizeAllComments}
                        >
                          Update
                        </button>
                      </div>
                    </div>
                  )}
                </section>

                <section className="comments-section">
                  <div className="section-heading">
                    <div>
                      <h2>Captured comments</h2>
                      <p>
                        {formatCapturedAt(state.snapshot.capturedAt)
                          ? `Updated ${formatCapturedAt(state.snapshot.capturedAt)}`
                          : 'Updates as comments load'}
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={jumpToComments}
                    >
                      Jump to page
                    </button>
                  </div>

                  <div className="comment-list">
                    {visibleComments.map((comment) => (
                      <article
                        className={`comment-card${
                          comment.isReply ? ' is-reply' : ''
                        }`}
                        key={comment.id}
                      >
                        <div className="avatar" aria-hidden="true">
                          {comment.avatarUrl ? (
                            <img src={comment.avatarUrl} alt="" />
                          ) : (
                            comment.author.slice(0, 1).toUpperCase()
                          )}
                        </div>
                        <div className="comment-body">
                          <div className="comment-meta">
                            <strong>{comment.author}</strong>
                            {comment.publishedAt && (
                              <span>{comment.publishedAt}</span>
                            )}
                          </div>
                          <div className="badges">
                            {comment.isPinned && <span>Pinned</span>}
                            {comment.isCreatorHearted && (
                              <span>Creator heart</span>
                            )}
                            {comment.isReply && <span>Reply</span>}
                          </div>
                          <p>{comment.text}</p>
                          {comment.likeCount && (
                            <span className="like-count">
                              ▲ {comment.likeCount}
                            </span>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>

                  {state.snapshot.comments.length > MAX_VISIBLE_COMMENTS && (
                    <p className="list-limit">
                      Showing the first {MAX_VISIBLE_COMMENTS} of{' '}
                      {state.snapshot.comments.length} captured comments.
                    </p>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </main>

      <footer>
        <span>Fast summaries powered by Gemini</span>
        <span className="footer-dot">•</span>
        <span>Search is next</span>
      </footer>
    </div>
  );
}

export default App;
