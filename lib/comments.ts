export const COMMENT_MESSAGES = {
  getSnapshot: 'youtube-comments:get-snapshot',
  scrollToComments: 'youtube-comments:scroll-to-comments',
  commentsUpdated: 'youtube-comments:updated',
} as const;

export type CollectorStatus =
  | 'not-video'
  | 'waiting-for-comments'
  | 'loading'
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
  capturedAt: string | null;
}

export type CollectorRequest =
  | { type: typeof COMMENT_MESSAGES.getSnapshot }
  | { type: typeof COMMENT_MESSAGES.scrollToComments };

export interface CommentsUpdatedMessage {
  type: typeof COMMENT_MESSAGES.commentsUpdated;
  videoId: string | null;
  count: number;
  status: CollectorStatus;
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
