import type { SavedSummary } from '@/lib/summary-cache';

export const MAX_FETCHED_COMMENTS = 10_000;
export const MAX_SNAPSHOT_COMMENTS = 100;

export const COMMENT_MESSAGES = {
  getSnapshot: 'youtube-comments:get-snapshot',
  scrollToComments: 'youtube-comments:scroll-to-comments',
  loadAllComments: 'youtube-comments:load-all',
  commentsUpdated: 'youtube-comments:updated',
  summaryReady: 'youtube-comments:summary-ready',
  summarizeLoaded: 'youtube-comments:summarize-loaded',
} as const;

export type AutoSummarizePhase = 'off' | 'idle' | 'fetching' | 'summarizing';

export type CollectorStatus =
  | 'not-video'
  | 'waiting-for-comments'
  | 'loading'
  | 'loading-all'
  | 'ready'
  | 'no-comments';

export interface YouTubeComment {
  id: string;
  author: string;
  authorUrl: string | null;
  avatarUrl: string | null;
  text: string;
  publishedAt: string;
  permalink: string | null;
  likeCount: string | null;
  isReply: boolean;
  isPinned: boolean;
  isCreatorHearted: boolean;
}

export interface CommentsSnapshot {
  videoId: string | null;
  videoTitle: string;
  channelName: string;
  pageUrl: string;
  totalCommentsLabel: string | null;
  status: CollectorStatus;
  comments: YouTubeComment[];
  capturedCount: number;
  capturedAt: string | null;
  fetchedAll: boolean;
  truncated: boolean;
  loadAllCount: number | null;
  autoPhase: AutoSummarizePhase;
  autoError: string | null;
}

export type CollectorRequest =
  | { type: typeof COMMENT_MESSAGES.getSnapshot }
  | { type: typeof COMMENT_MESSAGES.scrollToComments }
  | { type: typeof COMMENT_MESSAGES.loadAllComments }
  | { type: typeof COMMENT_MESSAGES.summarizeLoaded };

export interface LoadAllCommentsResponse {
  ok: boolean;
  count: number;
  truncated: boolean;
  error?: string;
}

export interface SummarizeLoadedResponse {
  ok: boolean;
  summary?: SavedSummary;
  error?: string;
}

export interface CommentsUpdatedMessage {
  type: typeof COMMENT_MESSAGES.commentsUpdated;
  videoId: string | null;
  count: number;
  status: CollectorStatus;
}

export interface SummaryReadyMessage {
  type: typeof COMMENT_MESSAGES.summaryReady;
  videoId: string;
  summary: SavedSummary;
}

export interface ScrollToCommentsResponse {
  ok: boolean;
}

export function getYouTubeVideoId(url: string): string | null {
  try {
    const parsedUrl = new URL(url);

    if (!/(^|\.)youtube\.com$/i.test(parsedUrl.hostname)) {
      return null;
    }

    if (parsedUrl.pathname === '/watch') {
      return parsedUrl.searchParams.get('v');
    }

    const routeMatch = parsedUrl.pathname.match(/^\/(?:live|shorts)\/([^/?]+)/);
    return routeMatch?.[1] ?? null;
  } catch {
    return null;
  }
}
