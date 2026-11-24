import {
  type CommentSortOrder,
  type YouTubeComment,
  threadParentId,
} from '@/lib/comments';

// Ranks arrive in order, so each comment is placed by the position YouTube
// already assigned. Reading a page is then a slice, not a sort of the corpus.
export class CommentOrder {
  private topSlots: Array<string | undefined> = [];
  private newestSlots: Array<string | undefined> = [];
  private unranked: string[] = [];
  private readonly unrankedSet = new Set<string>();
  private readonly seenRoots = new Set<string>();
  private rootCount = 0;
  private readonly replySlots = new Map<string, Array<string | undefined>>();
  private readonly replyExtras = new Map<string, string[]>();

  reset(): void {
    this.topSlots = [];
    this.newestSlots = [];
    this.unranked = [];
    this.unrankedSet.clear();
    this.seenRoots.clear();
    this.rootCount = 0;
    this.replySlots.clear();
    this.replyExtras.clear();
  }

  countRoots(): number {
    return this.rootCount;
  }

  note(comment: YouTubeComment): void {
    const parentId = threadParentId(comment);
    if (comment.isReply && parentId) {
      if (this.seenRoots.delete(comment.id)) this.rootCount -= 1;
      this.unrankedSet.delete(comment.id);
      if (typeof comment.replyRank === 'number') {
        const slots = this.replySlots.get(parentId) ?? [];
        slots[comment.replyRank] = comment.id;
        this.replySlots.set(parentId, slots);
        return;
      }
      const extras = this.replyExtras.get(parentId) ?? [];
      if (!extras.includes(comment.id)) extras.push(comment.id);
      this.replyExtras.set(parentId, extras);
      return;
    }

    if (!this.seenRoots.has(comment.id)) {
      this.seenRoots.add(comment.id);
      this.rootCount += 1;
    }
    if (typeof comment.topRank === 'number') this.topSlots[comment.topRank] = comment.id;
    if (typeof comment.newestRank === 'number') {
      this.newestSlots[comment.newestRank] = comment.id;
    }
    const ranked =
      typeof comment.topRank === 'number' || typeof comment.newestRank === 'number';
    if (ranked) {
      if (this.unrankedSet.delete(comment.id)) {
        this.unranked = this.unranked.filter((id) => id !== comment.id);
      }
      return;
    }
    if (!this.unrankedSet.has(comment.id)) {
      this.unrankedSet.add(comment.id);
      this.unranked.push(comment.id);
    }
  }

  rootIds(
    order: CommentSortOrder,
    isRoot: (id: string) => boolean,
    limit = Number.POSITIVE_INFINITY,
  ): string[] {
    const primary = order === 'top' ? this.topSlots : this.newestSlots;
    const secondary = order === 'top' ? this.newestSlots : this.topSlots;
    const ids: string[] = [];
    const seen = new Set<string>();
    const push = (id: string | undefined) => {
      if (ids.length >= limit || !id || seen.has(id) || !isRoot(id)) return;
      seen.add(id);
      ids.push(id);
    };
    for (const id of primary) {
      push(id);
      if (ids.length >= limit) return ids;
    }
    for (const id of secondary) {
      push(id);
      if (ids.length >= limit) return ids;
    }
    for (const id of this.unranked) {
      push(id);
      if (ids.length >= limit) return ids;
    }
    return ids;
  }

  replies(parentId: string, comments: Map<string, YouTubeComment>): YouTubeComment[] {
    const out: YouTubeComment[] = [];
    const seen = new Set<string>();
    const push = (id: string | undefined) => {
      if (!id || seen.has(id)) return;
      const comment = comments.get(id);
      if (!comment) return;
      seen.add(id);
      out.push(comment);
    };
    const ranked = this.replySlots.get(parentId);
    if (ranked) {
      for (const id of ranked) push(id);
    }
    const extras = this.replyExtras.get(parentId);
    if (extras) {
      for (const id of extras) push(id);
    }
    return out;
  }
}
