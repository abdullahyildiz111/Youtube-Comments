import { selectShownReplies, type YouTubeComment } from '../lib/comments.ts';

function reply(
  id: string,
  featured: boolean,
  replyRank: number | null = null,
): YouTubeComment {
  return {
    id,
    author: id,
    authorUrl: null,
    avatarUrl: null,
    text: id,
    publishedAt: '',
    permalink: '',
    likeCount: null,
    replyCount: null,
    parentId: 'root',
    isReply: true,
    isPinned: false,
    pinnedLabel: null,
    isCreatorHearted: false,
    isVerified: false,
    isChannelOwner: false,
    replyLevel: 0,
    featured,
    replyRank,
  };
}

const replies = [
  ...Array.from({ length: 141 }, (_, index) => reply(`top-${index}`, true, index)),
  ...Array.from({ length: 75 }, (_, index) => reply(`new-${index}`, false, null)),
];

const kept = selectShownReplies(replies, 182);
const featuredKept = kept.filter((item) => item.featured).length;
const newestKept = kept.length - featuredKept;
if (kept.length !== 182) {
  throw new Error(`expected 182 kept, got ${kept.length}`);
}
if (featuredKept !== 141) {
  throw new Error(`expected all 141 featured kept, got ${featuredKept}`);
}
if (newestKept !== 41) {
  throw new Error(`expected 41 newest pad, got ${newestKept}`);
}

const trimmed = selectShownReplies(replies, 100);
if (trimmed.length !== 100 || trimmed.some((item) => !item.featured)) {
  throw new Error('target below featured count should keep featured only');
}

const noButton = selectShownReplies(replies, null);
if (noButton.length !== 141 || noButton.some((item) => !item.featured)) {
  throw new Error('no button should keep featured only');
}

console.log('selectShownReplies ok', {
  padToButton: kept.length,
  featuredKept,
  newestKept,
  trimmed: trimmed.length,
  noButton: noButton.length,
});
