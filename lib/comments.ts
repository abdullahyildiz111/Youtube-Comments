import type { SavedSummary } from '@/lib/summary-cache';

export const MAX_FETCHED_COMMENTS = 10_000;
export const MAX_SNAPSHOT_COMMENTS = 50;

// YouTube's comments header offers exactly two orders. The labels and
// descriptions below are the strings YouTube renders in its own sort menu.
export type CommentSortOrder = 'top' | 'newest';

export const DEFAULT_COMMENT_SORT_ORDER: CommentSortOrder = 'top';

export const COMMENT_SORT_OPTIONS: ReadonlyArray<{
  value: CommentSortOrder;
  label: string;
  description: string;
}> = [
  { value: 'top', label: 'Top', description: 'Show featured comments' },
  {
    value: 'newest',
    label: 'Newest',
    description: 'Show recent comments, including potential spam',
  },
];

// A comment YouTube served through its "Top" listing. Anything reachable only
// through "Newest" is what YouTube keeps out of the moderated view, which is
// where banned and spam comments end up.
export function isFeaturedByYouTube(comment: YouTubeComment): boolean {
  return comment.featured === true;
}

export function isCommentSortOrder(value: unknown): value is CommentSortOrder {
  return value === 'top' || value === 'newest';
}

export function toCommentSortOrder(value: unknown): CommentSortOrder {
  return isCommentSortOrder(value) ? value : DEFAULT_COMMENT_SORT_ORDER;
}

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
  // The comment this reply is actually attached to. YouTube nests that in
  // subThreads, and it can be another reply. parentId stays the top-level
  // comment so the whole thread still groups together.
  replyToId?: string | null;
  isReply: boolean;
  isPinned: boolean;
  // YouTube's own wording, e.g. "Pinned by @RickAstleyYT".
  pinnedLabel?: string | null;
  isCreatorHearted: boolean;
  isVerified?: boolean;
  isChannelOwner?: boolean;
  // The position YouTube itself gave the comment in each order. These are the
  // only way to reproduce "Top", which is a server-side ranking and not a
  // like-count sort.
  topRank?: number | null;
  newestRank?: number | null;
  // Position inside its own thread, in the order YouTube returns replies.
  replyRank?: number | null;
  // How deep the reply sits. YouTube returns a thread as a flat list in
  // display order with a depth on each entry, so the nesting is rebuilt from
  // the two together. A top-level comment is 0.
  replyLevel?: number;
  // True when the comment came back through YouTube's "Top" listing, which is
  // its moderated set. Replies reached through "Newest" only are the ones
  // YouTube describes as "including potential spam" - banned and held-for-
  // review comments arrive on that path and on no other.
  featured?: boolean;
  // The reply count YouTube reports in its Top listing, which excludes banned
  // and held replies. Only set on top-level comments the Top listing served.
  featuredReplyCount?: string | null;
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
  sortOrder: CommentSortOrder;
  hideFilteredComments: boolean;
  // Threads YouTube's Top ranking leaves out, whether or not they are hidden.
  filteredCount: number;
}

export type CollectorRequest =
  | {
      type: typeof COMMENT_MESSAGES.getSnapshot;
      sortOrder?: CommentSortOrder;
      hideFilteredComments?: boolean;
    }
  | {
      type: typeof COMMENT_MESSAGES.getCommentsPage;
      offset: number;
      limit?: number;
      sortOrder?: CommentSortOrder;
      hideFilteredComments?: boolean;
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
  sortOrder: CommentSortOrder;
  hideFilteredComments: boolean;
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

const RELATIVE_TIME_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  month: 2_629_800,
  year: 31_557_600,
};

// "3 weeks ago" -> 1814400. Only a fallback for comments YouTube has not
// ranked for us yet (a DOM scrape before "Load all" has run).
function publishedSecondsAgo(value: string | null | undefined): number | null {
  if (!value) return null;

  const match = value.match(
    /(\d[\d.,]*)\s*(second|minute|hour|day|week|month|year)/i,
  );
  const unit = match?.[2] ? RELATIVE_TIME_SECONDS[match[2].toLowerCase()] : undefined;
  if (!match?.[1] || unit === undefined) return null;

  const amount = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;

  return amount * unit;
}

function serverRank(
  comment: YouTubeComment,
  order: CommentSortOrder,
): number | null {
  const rank = order === 'newest' ? comment.newestRank : comment.topRank;
  return typeof rank === 'number' && Number.isFinite(rank) ? rank : null;
}

// Reached only for comments YouTube never ranked. "Top" approximates the
// ranking with like counts; "Newest" reads the relative timestamp.
function compareUnranked(
  first: YouTubeComment,
  second: YouTubeComment,
  order: CommentSortOrder,
): number {
  if (first.isPinned !== second.isPinned) return first.isPinned ? -1 : 1;

  if (order === 'newest') {
    const firstAge = publishedSecondsAgo(first.publishedAt);
    const secondAge = publishedSecondsAgo(second.publishedAt);
    if (firstAge === null || secondAge === null) {
      if (firstAge !== secondAge) return firstAge === null ? 1 : -1;
      return 0;
    }
    return firstAge - secondAge;
  }

  return likeCountValue(second.likeCount) - likeCountValue(first.likeCount);
}

export interface CommentNode {
  comment: YouTubeComment;
  children: CommentNode[];
}

export interface CommentThread {
  parent: YouTubeComment;
  // Every reply in the thread, flat and in YouTube's order.
  replies: YouTubeComment[];
  // The same replies nested for display.
  tree: CommentNode[];
}

interface PlacedReply {
  node: CommentNode;
  depth: number;
}

// Used only when YouTube did not say which comment a reply belongs to (a DOM
// scrape). A reply that opens with a handle is attached to that person.
function mentionedParent(
  text: string,
  placed: PlacedReply[],
): PlacedReply | null {
  const opening = text.replace(/^[\s\u200B-\u200D\uFEFF]+/, '');
  if (!opening.startsWith('@')) return null;

  // Most recent first, so a repeated handle attaches to the latest reply.
  for (let index = placed.length - 1; index >= 0; index -= 1) {
    const author = placed[index]?.node.comment.author;
    if (!author || !author.startsWith('@') || !opening.startsWith(author)) continue;

    // "@bob" must not swallow a reply addressed to "@bobby".
    const next = opening.charAt(author.length);
    if (next === '' || !/[\p{L}\p{N}._-]/u.test(next)) return placed[index] ?? null;
  }

  return null;
}

// Fallback for threads where YouTube states a depth instead.
function statedParent(
  replyLevel: number | undefined,
  placed: PlacedReply[],
): PlacedReply | null {
  const stated =
    typeof replyLevel === 'number' && Number.isFinite(replyLevel)
      ? Math.floor(replyLevel)
      : 1;
  if (stated <= 1 || placed.length === 0) return null;

  for (let index = placed.length - 1; index >= 0; index -= 1) {
    if (placed[index]?.depth === stated - 1) return placed[index] ?? null;
  }

  // A depth that skips a level hangs off the most recent reply rather than
  // being orphaned at the top of the thread.
  return placed[placed.length - 1] ?? null;
}

// YouTube's reply payload nests each response under the comment it answers.
// That parent is another reply for anything deeper than a direct response.
function buildStructuredReplyTree(replies: YouTubeComment[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const reply of replies) {
    nodes.set(reply.id, { comment: reply, children: [] });
  }

  const roots: CommentNode[] = [];
  for (const reply of replies) {
    const node = nodes.get(reply.id);
    if (!node) continue;
    const parent = reply.replyToId ? nodes.get(reply.replyToId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

// Fallback when the payload did not name a parent. Depth comes from YouTube's
// replyLevel; a leading @handle is only used when even that is missing.
function buildInferredReplyTree(replies: YouTubeComment[]): CommentNode[] {
  const roots: CommentNode[] = [];
  const placed: PlacedReply[] = [];

  for (const reply of replies) {
    const node: CommentNode = { comment: reply, children: [] };
    const levelKnown =
      typeof reply.replyLevel === 'number' && Number.isFinite(reply.replyLevel);
    const parent = levelKnown
      ? statedParent(reply.replyLevel, placed)
      : mentionedParent(reply.text, placed);

    if (parent) parent.node.children.push(node);
    else roots.push(node);

    placed.push({ node, depth: parent ? parent.depth + 1 : 1 });
  }

  return roots;
}

export function buildReplyTree(replies: YouTubeComment[]): CommentNode[] {
  if (replies.some((reply) => reply.replyToId)) {
    return buildStructuredReplyTree(replies);
  }
  return buildInferredReplyTree(replies);
}
export function makeCommentThread(
  parent: YouTubeComment,
  replies: YouTubeComment[],
): CommentThread {
  return { parent, replies, tree: buildReplyTree(replies) };
}

export function groupCommentsForDisplay(
  comments: YouTubeComment[],
  order: CommentSortOrder = DEFAULT_COMMENT_SORT_ORDER,
): CommentThread[] {
  const grouped: Array<{ parent: YouTubeComment; replies: YouTubeComment[] }> = [];

  for (const comment of orderCommentsForDisplay(comments, order)) {
    if (!comment.isReply) {
      grouped.push({ parent: comment, replies: [] });
      continue;
    }

    const current = grouped[grouped.length - 1];
    if (current) current.replies.push(comment);
  }

  return grouped.map((thread) => makeCommentThread(thread.parent, thread.replies));
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
  order: CommentSortOrder = DEFAULT_COMMENT_SORT_ORDER,
): YouTubeComment[] {
  const repliesByParent = new Map<string, YouTubeComment[]>();
  const roots: YouTubeComment[] = [];
  const arrivalIndex = new Map<string, number>();

  for (const comment of comments) {
    if (!arrivalIndex.has(comment.id)) arrivalIndex.set(comment.id, arrivalIndex.size);

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

  const arrivalOf = (comment: YouTubeComment) =>
    arrivalIndex.get(comment.id) ?? Number.MAX_SAFE_INTEGER;

  // YouTube's own position wins whenever we have it, so the list matches the
  // page exactly. Anything it never ranked falls in behind, ordered by the
  // closest local approximation of the same rule.
  roots.sort((first, second) => {
    const firstRank = serverRank(first, order);
    const secondRank = serverRank(second, order);

    if (firstRank !== null && secondRank !== null) {
      if (firstRank !== secondRank) return firstRank - secondRank;
    } else if (firstRank !== null || secondRank !== null) {
      return firstRank !== null ? -1 : 1;
    } else {
      const fallback = compareUnranked(first, second, order);
      if (fallback !== 0) return fallback;
    }

    return arrivalOf(first) - arrivalOf(second);
  });

  // Replies always keep the order YouTube returns them in, which does not
  // change with the header's sort. The sort only reorders top-level threads.
  for (const replies of repliesByParent.values()) {
    replies.sort((first, second) => {
      const firstRank =
        typeof first.replyRank === 'number' ? first.replyRank : null;
      const secondRank =
        typeof second.replyRank === 'number' ? second.replyRank : null;

      if (firstRank !== null && secondRank !== null) {
        if (firstRank !== secondRank) return firstRank - secondRank;
      } else if (firstRank !== null || secondRank !== null) {
        return firstRank !== null ? -1 : 1;
      }

      return arrivalOf(first) - arrivalOf(second);
    });
  }

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
