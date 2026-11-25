// Crawls a real video with the extension's own crawler and comment store, and
// prints what the panel lists with Hide spam on and off next to the reply
// counts YouTube's own Top listing reports.
//
//   npx tsx scripts/verify-replies.mts <videoId> [--hl=en] [--threads=5]
//     [--record=file.json] [--replay=file.json] [--flaky=0.05] [--dead=0.01]
//
// --record saves every raw /next response so --replay can rerun the store
// logic offline. --flaky fails that share of continuations once each, which
// the crawl must recover from. --dead fails that share every time, which
// the crawl must report as truncated.
import { readFileSync, writeFileSync } from 'node:fs';
import { CommentStore, type CommentView } from '../lib/comment-store.ts';
import type { CommentPatch, YouTubeComment } from '../lib/comments.ts';
import { fetchAllVideoComments } from '../lib/innertube-comments.ts';
import { makeNext, openSession } from './yt-session.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
const videoId = args.find((arg) => !arg.startsWith('--'));
if (!videoId) throw new Error('usage: verify-replies.mts <videoId> [--hl=en] [--threads=5]');
const hl = flag('hl') ?? 'en';
const threadLimit = Number(flag('threads') ?? 5);
const recordPath = flag('record');
const replayPath = flag('replay');
const flakyRate = Number(flag('flaky') ?? 0);
const deadRate = Number(flag('dead') ?? 0);

type Sort = 'top' | 'newest' | 'none';
const recorded: Record<string, unknown> = replayPath
  ? JSON.parse(readFileSync(replayPath, 'utf8'))
  : {};
let fetchPage: (token: string, ctp?: string, sort?: Sort) => Promise<unknown>;
let requestCount = () => 0;
if (replayPath) {
  fetchPage = async (token, _ctp, sort) => {
    const data = recorded[`${sort ?? 'none'}|${token}`];
    if (data === undefined) throw new Error('not in recording');
    return data;
  };
} else {
  const session = await openSession(videoId, hl);
  const client = makeNext(session, hl);
  requestCount = client.requestCount;
  fetchPage = async (token, ctp, sort) => {
    const data = await client.next({
      continuation: token,
      ...(ctp ? { clickTracking: { clickTrackingParams: ctp } } : {}),
    });
    recorded[`${sort ?? 'none'}|${token}`] = data;
    return data;
  };
}

// YouTube's reply totals, read straight off the raw Top pages rather than
// through the extension's parser.
const buttonTotals = new Map<string, string>();
const moderated = { top: 0, newest: 0, none: 0 };
const walk = (value: unknown, sort: Sort): void => {
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, any>;
  const thread = node.commentThreadRenderer;
  if (thread) {
    if (thread.isModeratedElqComment) moderated[sort] += 1;
    const id = thread.commentViewModel?.commentViewModel?.commentId;
    const text = thread.replies?.commentRepliesRenderer?.viewReplies?.buttonRenderer?.text;
    const label = text?.simpleText ?? text?.runs?.map((run: { text: string }) => run.text).join('');
    if (sort === 'top' && id && label) buttonTotals.set(id, label);
  }
  for (const child of Object.values(node)) walk(child, sort);
};

const failedOnce = new Set<string>();
const dead = new Set<string>();
const attempts = new Map<string, number>();
let injected = 0;
const store = new CommentStore();
const delivered = new Map<string, number>();
const started = Date.now();
const result = await fetchAllVideoComments(
  (_count, _label, added?: YouTubeComment[], patches?: CommentPatch[]) => {
    for (const comment of added ?? []) {
      delivered.set(comment.id, (delivered.get(comment.id) ?? 0) + 1);
      store.remember(comment);
    }
    for (const patch of patches ?? []) store.applyPatch(patch);
  },
  undefined,
  videoId,
  undefined,
  async (token, ctp, sort) => {
    const key = `${sort ?? 'none'}|${token}`;
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    if (dead.has(key) || (deadRate > 0 && !attempts.has(`seen|${key}`) && Math.random() < deadRate)) {
      dead.add(key);
      injected += 1;
      throw new Error('injected permanent failure');
    }
    attempts.set(`seen|${key}`, 1);
    if (flakyRate > 0 && !failedOnce.has(key) && Math.random() < flakyRate) {
      failedOnce.add(key);
      injected += 1;
      throw new Error('injected failure');
    }
    const data = await fetchPage(token, ctp, sort ?? 'none');
    walk(data, sort ?? 'none');
    return data;
  },
);
if (recordPath) writeFileSync(recordPath, JSON.stringify(recorded));

const all = [...store.comments.values()];
const roots = all.filter((comment) => !comment.isReply);
const on: CommentView = { sortOrder: 'top', hideFiltered: true, canFilter: !result.truncated };
const off: CommentView = { ...on, hideFiltered: false };
const listed = (view: CommentView) => {
  let replies = 0;
  const seen = new Set<string>();
  let repeats = 0;
  const ids = store.rootIds(view);
  for (const id of ids) {
    const thread = store.thread(id, view);
    if (!thread) continue;
    for (const reply of thread.replies) {
      if (seen.has(reply.id)) repeats += 1;
      seen.add(reply.id);
    }
    replies += thread.replies.length;
  }
  return { roots: ids.length, replies, total: ids.length + replies, repeats };
};
const onListed = listed(on);
const offListed = listed(off);
const doubleDelivered = [...delivered.values()].filter((times) => times > 1).length;

console.log(`## ${videoId} (hl=${hl})`);
console.log(
  JSON.stringify({
    header: result.totalCommentsLabel,
    loaded: result.count,
    truncated: result.truncated,
    requests: requestCount(),
    injectedFailures: injected,
    deadTokens: dead.size,
    maxFetchesPerToken: Math.max(0, ...[...attempts].filter(([key]) => !key.startsWith('seen|')).map(([, count]) => count)),
    seconds: Math.round((Date.now() - started) / 1000),
    roots: roots.length,
    replies: all.length - roots.length,
    topServedRoots: roots.filter((comment) => comment.featured).length,
    moderatedFlagThreads: moderated,
    doubleDelivered,
    repeatedRepliesOn: onListed.repeats,
    repeatedRepliesOff: offListed.repeats,
  }),
);
console.log('');
console.log('| Thread | YouTube (Top button) | Newest toolbar | Hide spam ON | Hide spam OFF |');
console.log('|---|---:|---:|---:|---:|');
const byButton = roots
  .map((root) => ({ root, total: Number((buttonTotals.get(root.id) ?? '').replace(/[^\d]/g, '')) || 0 }))
  .sort((left, right) => right.total - left.total)
  .slice(0, threadLimit);
for (const { root } of byButton) {
  const name = `${root.author} ${root.id.slice(0, 8)}`;
  console.log(
    `| ${name} | ${buttonTotals.get(root.id) ?? '-'} | ${root.replyCount ?? '-'} | ${store.thread(root.id, on)?.replies.length ?? 0} | ${store.thread(root.id, off)?.replies.length ?? 0} |`,
  );
}
console.log('');
console.log(
  `Top-level: ON ${onListed.roots} / OFF ${offListed.roots}. Comments listed: ON ${onListed.total} / OFF ${offListed.total}. Spam hidden: ${store.hiddenCount(on)}.`,
);
