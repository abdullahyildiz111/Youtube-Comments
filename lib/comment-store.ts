import { CommentOrder } from '@/lib/comment-index';
import {
  type CommentPatch,
  type CommentSortOrder,
  type CommentThread,
  type YouTubeComment,
  makeCommentThread,
  pageReplyCount,
  selectShownReplies,
  threadParentId,
} from '@/lib/comments';

export interface CommentView {
  sortOrder: CommentSortOrder;
  // True when Show spam is off: trim each thread to YouTube's Top view.
  hideFiltered: boolean;
  // Trimming needs both listings walked to the end. On a partial or truncated
  // load a reply missing from Top may just be one the Top pass never reached.
  canFilter: boolean;
}

export interface ThreadReplyDiagnostics {
  id: string;
  author: string;
  button: string | null;
  buttonCount: number | null;
  toolbar: string | null;
  loaded: number;
  topServed: number;
  newestOnly: number;
  keptOff: number;
  hiddenOff: number;
  parentFeatured: boolean;
}

// The comments collected for one video, and the threads the panel lists from
// them. With Show spam off (hideFiltered), each thread matches YouTube's Top
// reply button. With Show spam on, Newest extras stay. Top-level comments are
// never removed: Top's top-level listing is a ranking that stops early.
export class CommentStore {
  readonly comments = new Map<string, YouTubeComment>();
  // Reply totals read off the watch page. The crawl must not replace them
  // with the toolbar total, which counts a different set of replies.
  private readonly pageReplyCounts = new Set<string>();
  private readonly order = new CommentOrder();
  private revision = 0;
  private hiddenCache: { key: string; count: number } | null = null;

  get size(): number {
    return this.comments.size;
  }

  clear(): void {
    this.comments.clear();
    this.pageReplyCounts.clear();
    this.order.reset();
    this.revision += 1;
    this.hiddenCache = null;
  }

  remember(comment: YouTubeComment, fromPage = false): void {
    const previous = this.comments.get(comment.id);
    if (!previous) {
      this.comments.set(comment.id, comment);
    } else {
      // A page total locks out a later toolbar-sized count. A lock with no
      // number yet must not freeze the thread at "unknown" and hide the
      // real button total when it arrives.
      const locked =
        this.pageReplyCounts.has(previous.id) &&
        !fromPage &&
        pageReplyCount(previous.featuredReplyCount) != null;
      const prevTotal = pageReplyCount(previous.featuredReplyCount);
      const nextTotal = pageReplyCount(comment.featuredReplyCount);
      let featuredReplyCount = previous.featuredReplyCount ?? null;
      if (fromPage) {
        featuredReplyCount = comment.featuredReplyCount ?? previous.featuredReplyCount ?? null;
      } else if (!locked && (prevTotal == null || (nextTotal != null && nextTotal > prevTotal))) {
        featuredReplyCount = comment.featuredReplyCount ?? previous.featuredReplyCount ?? null;
      }
      this.comments.set(comment.id, {
        ...previous,
        ...comment,
        parentId: comment.parentId || previous.parentId,
        isReply: previous.isReply || comment.isReply,
        featured: Boolean(previous.featured || comment.featured),
        featuredReplyCount,
        topRank: comment.topRank ?? previous.topRank,
        newestRank: comment.newestRank ?? previous.newestRank,
        replyRank: comment.replyRank ?? previous.replyRank,
        replyToId: comment.replyToId || previous.replyToId,
        likeCount: comment.likeCount ?? previous.likeCount,
        replyCount: comment.replyCount ?? previous.replyCount,
        isPinned: previous.isPinned || comment.isPinned,
        pinnedLabel: comment.pinnedLabel || previous.pinnedLabel,
        isCreatorHearted: previous.isCreatorHearted || comment.isCreatorHearted,
        isVerified: previous.isVerified || comment.isVerified,
        isChannelOwner: previous.isChannelOwner || comment.isChannelOwner,
      });
    }
    const stored = this.comments.get(comment.id);
    if (stored) this.order.note(stored);
    this.revision += 1;
    this.hiddenCache = null;
  }

  applyPatch(patch: CommentPatch): void {
    const existing = this.comments.get(patch.id);
    if (!existing) return;
    this.remember({
      ...existing,
      topRank: 'topRank' in patch ? patch.topRank : existing.topRank,
      newestRank: 'newestRank' in patch ? patch.newestRank : existing.newestRank,
      replyRank: 'replyRank' in patch ? patch.replyRank : existing.replyRank,
      featured: 'featured' in patch ? patch.featured : existing.featured,
      replyToId: 'replyToId' in patch ? patch.replyToId : existing.replyToId,
      isPinned: 'isPinned' in patch ? Boolean(patch.isPinned) : existing.isPinned,
      pinnedLabel: 'pinnedLabel' in patch ? patch.pinnedLabel : existing.pinnedLabel,
      likeCount: 'likeCount' in patch ? patch.likeCount ?? null : existing.likeCount,
      // Toolbar replyCount includes replies the watch-page button leaves out.
      // The button total stays in featuredReplyCount and must not be replaced
      // once the page has shown it.
      replyCount: 'replyCount' in patch ? patch.replyCount ?? null : existing.replyCount,
      featuredReplyCount:
        this.pageReplyCounts.has(existing.id) &&
        pageReplyCount(existing.featuredReplyCount) != null
          ? existing.featuredReplyCount
          : 'featuredReplyCount' in patch
            ? patch.featuredReplyCount ?? existing.featuredReplyCount
            : existing.featuredReplyCount,
    });
  }

  // Records the reply total drawn under a thread on the watch page. Returns
  // true when the stored total changed.
  notePageReplyCount(id: string, count: string): boolean {
    let existing = this.comments.get(id);
    if (existing?.isReply) {
      const rootId = threadParentId(existing);
      existing = rootId ? this.comments.get(rootId) : undefined;
    }
    if (!existing || existing.isReply) return false;
    this.pageReplyCounts.add(existing.id);
    if (pageReplyCount(existing.featuredReplyCount) === pageReplyCount(count)) return false;
    this.remember({ ...existing, featuredReplyCount: count }, true);
    return true;
  }

  countRoots(): number {
    return this.order.countRoots();
  }

  rootIds(view: CommentView, limit = Number.POSITIVE_INFINITY): string[] {
    return this.order.rootIds(view.sortOrder, this.isRoot, limit);
  }

  thread(id: string, view: CommentView): CommentThread | null {
    const parent = this.comments.get(id);
    if (!parent || parent.isReply) return null;
    const replies = this.order.replies(parent.id, this.comments);
    if (!view.hideFiltered || !view.canFilter) return makeCommentThread(parent, replies);
    return makeCommentThread(parent, this.shownReplies(parent, replies));
  }

  threads(offset: number, limit: number, view: CommentView): CommentThread[] {
    const threads: CommentThread[] = [];
    for (const id of this.rootIds(view, offset + limit).slice(offset)) {
      const thread = this.thread(id, view);
      if (thread) threads.push(thread);
    }
    return threads;
  }

  // How many loaded comments Show spam off takes out of the list.
  hiddenCount(view: CommentView): number {
    if (!view.canFilter) return 0;
    const key = `${this.revision}`;
    if (this.hiddenCache?.key === key) return this.hiddenCache.count;
    let hidden = 0;
    for (const id of this.order.rootIds(view.sortOrder, this.isRoot)) {
      const parent = this.comments.get(id);
      if (!parent) continue;
      const replies = this.order.replies(id, this.comments);
      hidden += replies.length - this.shownReplies(parent, replies).length;
    }
    this.hiddenCache = { key, count: hidden };
    return hidden;
  }

  // Per-thread reply membership for debugging Show spam / YouTube parity.
  replyDiagnostics(limit = 12): ThreadReplyDiagnostics[] {
    const out: ThreadReplyDiagnostics[] = [];
    for (const id of this.order.rootIds('top', this.isRoot, limit)) {
      const parent = this.comments.get(id);
      if (!parent) continue;
      const replies = this.order.replies(id, this.comments);
      const topServed = replies.filter((reply) => reply.featured === true).length;
      const kept = this.shownReplies(parent, replies);
      out.push({
        id: parent.id,
        author: parent.author,
        button: parent.featuredReplyCount ?? null,
        buttonCount: pageReplyCount(parent.featuredReplyCount),
        toolbar: parent.replyCount ?? null,
        loaded: replies.length,
        topServed,
        newestOnly: replies.length - topServed,
        keptOff: kept.length,
        hiddenOff: replies.length - kept.length,
        parentFeatured: parent.featured === true,
      });
    }
    return out;
  }

  private readonly isRoot = (id: string): boolean => {
    const comment = this.comments.get(id);
    return Boolean(comment && !comment.isReply);
  };

  // A thread Top never served has no Top view to match, so all of its
  // replies stay. Otherwise match the watch-page button total.
  private shownReplies(parent: YouTubeComment, replies: YouTubeComment[]): YouTubeComment[] {
    if (!parent.featured) return replies;
    return selectShownReplies(replies, pageReplyCount(parent.featuredReplyCount));
  }
}
