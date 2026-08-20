import type { SavedSummary } from '@/lib/summary-cache';

export const MAX_FETCHED_COMMENTS = 10_000;
export const MAX_SNAPSHOT_COMMENTS = 50;

export const COMMENT_MESSAGES = {
  getSnapshot: 'youtube-comments:get-snapshot',
  getCommentsPage: 'youtube-comments:get-comments-page',
  scrollToComments: 'youtube-comments:scroll-to-comments',
  loadAllComments: 'youtube-comments:load-all',
  commentsUpdated: 'youtube-comments:updated',
  summaryReady: 'youtube-comments:summary-ready',
  summarizeLoaded: 'youtube-comments:summarize-loaded',
  chatAboutComments: 'youtube-comments:chat',
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
  replyCount: string | null;
  parentId: string | null;
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
  threadCount: number;
  capturedAt: string | null;
  fetchedAll: boolean;
  truncated: boolean;
  loadAllCount: number | null;
  autoPhase: AutoSummarizePhase;
  autoError: string | null;
}

export type CollectorRequest =
  | { type: typeof COMMENT_MESSAGES.getSnapshot }
  | {
      type: typeof COMMENT_MESSAGES.getCommentsPage;
      offset: number;
      limit?: number;
    }
  | { type: typeof COMMENT_MESSAGES.scrollToComments }
  | { type: typeof COMMENT_MESSAGES.loadAllComments }
  | { type: typeof COMMENT_MESSAGES.summarizeLoaded }
  | {
      type: typeof COMMENT_MESSAGES.chatAboutComments;
      question: string;
      history: Array<{ role: 'user' | 'assistant'; text: string }>;
    };

export interface CommentsPageResponse {
  videoId: string | null;
  offset: number;
  comments: YouTubeComment[];
  total: number;
}

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

export interface ChatAboutCommentsResponse {
  ok: boolean;
  answer?: string;
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

export function canonicalYouTubeCommentId(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Replies use parentId.replyId (the '.' used to get stripped, collapsing every
  // reply onto its parent and dropping roughly half the comment list).
  const encoded = trimmed.match(/Ug[\w-]+(?:\.[\w-]+)*/);
  return encoded ? encoded[0] : trimmed;
}

export function parentCommentId(id: string): string | null {
  const separator = id.indexOf('.');
  return separator > 0 ? id.slice(0, separator) : null;
}

export function threadParentId(comment: YouTubeComment): string | null {
  return comment.parentId || parentCommentId(comment.id);
}

function likeCountValue(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.replace(/\s+/g, '').replace(',', '.');
  const match = normalized.match(/^([\d.]+)([KMB])?$/i);
  if (!match) return Number.parseInt(value.replace(/[^\d]/g, ''), 10) || 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const suffix = (match[2] || '').toUpperCase();
  return amount * (suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1);
}

export interface CommentThread {
  parent: YouTubeComment;
  replies: YouTubeComment[];
}

export function groupCommentsForDisplay(
  comments: YouTubeComment[],
): CommentThread[] {
  const threads: CommentThread[] = [];

  for (const comment of orderCommentsForDisplay(comments)) {
    if (!comment.isReply) {
      threads.push({ parent: comment, replies: [] });
      continue;
    }

    const current = threads[threads.length - 1];
    if (current) current.replies.push(comment);
  }

  return threads;
}

export function flattenCommentThreads(threads: CommentThread[]): YouTubeComment[] {
  const flattened: YouTubeComment[] = [];
  for (const thread of threads) {
    flattened.push(thread.parent, ...thread.replies);
  }
  return flattened;
}

export function orderCommentsForDisplay(
  comments: YouTubeComment[],
): YouTubeComment[] {
  const repliesByParent = new Map<string, YouTubeComment[]>();
  const roots: YouTubeComment[] = [];

  for (const comment of comments) {
    const parentId = threadParentId(comment);
    const flagged =
      comment.isReply || parentId
        ? comment.isReply
          ? comment
          : { ...comment, isReply: true }
        : comment;

    if (flagged.isReply && parentId) {
      const replies = repliesByParent.get(parentId);
      if (replies) replies.push(flagged);
      else repliesByParent.set(parentId, [flagged]);
      continue;
    }

    roots.push(flagged);
  }

  roots.sort((first, second) => {
    if (first.isPinned !== second.isPinned) return first.isPinned ? -1 : 1;
    return likeCountValue(second.likeCount) - likeCountValue(first.likeCount);
  });

  const ordered: YouTubeComment[] = [];
  const seen = new Set<string>();

  const push = (comment: YouTubeComment) => {
    if (seen.has(comment.id)) return;
    seen.add(comment.id);
    ordered.push(comment);
    const replies = repliesByParent.get(comment.id);
    if (!replies) return;
    repliesByParent.delete(comment.id);
    for (const reply of replies) push(reply);
  };

  for (const root of roots) push(root);
  for (const replies of repliesByParent.values()) {
    for (const reply of replies) push(reply);
  }

  return ordered;
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
