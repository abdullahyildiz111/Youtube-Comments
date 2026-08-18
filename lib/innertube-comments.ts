import {
  MAX_FETCHED_COMMENTS,
  getYouTubeVideoId,
  type YouTubeComment,
} from '@/lib/comments';

export { MAX_FETCHED_COMMENTS };

export const INNERTUBE_BRIDGE = {
  request: 'comment-catcher:load-all',
  progress: 'comment-catcher:load-all-progress',
  result: 'comment-catcher:load-all-result',
  countRequest: 'comment-catcher:comment-count',
  countResult: 'comment-catcher:comment-count-result',
  ready: 'comment-catcher:bridge-ready',
} as const;

const MAX_CONTINUATION_PAGES = 1_000;
const PAGE_CONCURRENCY = 2;
const REPLY_CONCURRENCY = 8;

interface InnertubeContext {
  client: Record<string, unknown>;
  user?: Record<string, unknown>;
  request?: Record<string, unknown>;
}

interface QueuedToken {
  token: string;
  isReply: boolean;
  clickTrackingParams?: string;
}

export interface LoadAllRequest {
  type: typeof INNERTUBE_BRIDGE.request;
  requestId: string;
  videoId: string;
}

export interface LoadAllProgress {
  type: typeof INNERTUBE_BRIDGE.progress;
  requestId: string;
  count: number;
  totalCommentsLabel?: string | null;
}

export interface LoadAllResult {
  type: typeof INNERTUBE_BRIDGE.result;
  requestId: string;
  comments: YouTubeComment[];
  truncated: boolean;
  totalCommentsLabel?: string | null;
  error?: string;
}

export interface CommentCountRequest {
  type: typeof INNERTUBE_BRIDGE.countRequest;
  requestId: string;
  videoId: string;
}

export interface CommentCountResult {
  type: typeof INNERTUBE_BRIDGE.countResult;
  requestId: string;
  videoId: string;
  totalCommentsLabel: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function runsToText(value: unknown): string {
  const record = asRecord(value);
  const runs = record?.runs;
  if (!Array.isArray(runs)) {
    return readString(record?.content, record?.simpleText, value);
  }

  return runs
    .map((run) => readString(asRecord(run)?.text, run))
    .join('')
    .trim();
}

function getYtcfgValue(key: string): unknown {
  const ytcfg = (
    window as unknown as {
      ytcfg?: {
        get?: (name: string) => unknown;
        data_?: Record<string, unknown>;
      };
    }
  ).ytcfg;

  return ytcfg?.get?.(key) ?? ytcfg?.data_?.[key];
}

function getInnertubeContext(): InnertubeContext {
  const context = asRecord(getYtcfgValue('INNERTUBE_CONTEXT'));
  if (context?.client) return context as unknown as InnertubeContext;

  throw new Error('YouTube client data is not ready. Refresh the video page.');
}

function getYtInitialData(): unknown {
  return (window as unknown as { ytInitialData?: unknown }).ytInitialData;
}

let activeFetchVideoId = '';

function getWatchId(): string {
  return activeFetchVideoId || getYouTubeVideoId(window.location.href) || '';
}

function videoIdFromPayload(payload: unknown): string | null {
  const record = asRecord(payload);
  const fromEndpoint = readString(
    asRecord(asRecord(record?.currentVideoEndpoint)?.watchEndpoint)?.videoId,
  );
  if (fromEndpoint) return fromEndpoint;

  const playerResponse = asRecord(
    (window as unknown as { ytInitialPlayerResponse?: unknown })
      .ytInitialPlayerResponse,
  );
  return (
    readString(asRecord(playerResponse?.videoDetails)?.videoId) || null
  );
}

async function waitForWatchId(videoId: string, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (getYouTubeVideoId(window.location.href) === videoId) {
      try {
        getInnertubeContext();
        return;
      } catch {
        // YouTube client data is still hydrating after a SPA navigation.
      }
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 120);
    });
  }

  if (getYouTubeVideoId(window.location.href) !== videoId) {
    throw new Error('The video changed before comments finished loading.');
  }
}

function bytesToBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

function encodeUtf8(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function decodeBase64Bytes(value: string): number[] {
  return Array.from(atob(value), (char) => char.charCodeAt(0));
}

function generateCommentContinuation(videoId: string): string | null {
  if (!videoId) return null;

  // Same construction yt-dlp uses to open the comments section without scrolling.
  const bytes = [
    ...decodeBase64Bytes('Eg0SCw=='),
    ...encodeUtf8(videoId),
    ...decodeBase64Bytes('GAYyJyIRIgs='),
    ...encodeUtf8(videoId),
    ...decodeBase64Bytes('MAF4AjAAQhBjb21tZW50cy1zZWN0aW9u'),
  ];

  return bytesToBase64(bytes);
}

function pushToken(tokens: QueuedToken[], next: QueuedToken | null): void {
  if (!next?.token || next.token.length < 16) return;
  if (tokens.some((item) => item.token === next.token)) return;
  tokens.push(next);
}

function continuationFrom(node: unknown): QueuedToken | null {
  const record = asRecord(node);
  if (!record) return null;

  const continuations = Array.isArray(record.continuations)
    ? record.continuations
    : [];
  const legacy =
    asRecord(asRecord(continuations[0])?.nextContinuationData) ??
    asRecord(asRecord(record.continuation)?.reloadContinuationData) ??
    asRecord(record.nextContinuationData);
  const legacyToken = readString(legacy?.continuation);
  if (legacyToken) {
    return {
      token: legacyToken,
      isReply: false,
      clickTrackingParams: readString(legacy?.clickTrackingParams),
    };
  }

  const command = asRecord(record.continuationCommand);
  const token = readString(command?.token);
  if (token) {
    return {
      token,
      isReply: false,
      clickTrackingParams: readString(
        record.clickTrackingParams,
        command?.clickTrackingParams,
      ),
    };
  }

  const nested = [
    record.continuationEndpoint,
    record.serviceEndpoint,
    asRecord(asRecord(record.button)?.buttonRenderer)?.command,
    asRecord(asRecord(record.button)?.buttonRenderer)?.navigationEndpoint,
  ];

  for (const child of nested) {
    const found = continuationFrom(child);
    if (found) return found;
  }

  const executor = asRecord(record.commandExecutorCommand);
  if (Array.isArray(executor?.commands)) {
    for (const child of executor.commands) {
      const found = continuationFrom(child);
      if (found) return found;
    }
  }

  return null;
}

function continuationItem(node: unknown): Record<string, unknown> | null {
  const record = asRecord(node);
  if (!record) return null;
  return (
    asRecord(record.continuationItemRenderer) ??
    continuationItem(asRecord(record.richItemRenderer)?.content)
  );
}

function flattenItems(items: unknown[]): Record<string, unknown>[] {
  const flattened: Record<string, unknown>[] = [];

  const visit = (node: unknown) => {
    const record = asRecord(node);
    if (!record) return;

    if (record.richItemRenderer) {
      visit(asRecord(record.richItemRenderer)?.content);
      return;
    }

    if (record.itemSectionRenderer) {
      const contents = asRecord(record.itemSectionRenderer)?.contents;
      if (Array.isArray(contents)) contents.forEach(visit);
      return;
    }

    flattened.push(record);
  };

  for (const item of items) visit(item);
  return flattened;
}

function continuationLists(data: unknown): unknown[][] {
  const lists: unknown[][] = [];
  const payload = asRecord(data);
  const roots = [
    payload?.onResponseReceivedEndpoints,
    payload?.onResponseReceivedActions,
    payload?.onResponseReceivedCommands,
  ];

  for (const root of roots) {
    if (!Array.isArray(root)) continue;
    for (const endpoint of root) {
      const record = asRecord(endpoint);
      const items =
        asRecord(record?.appendContinuationItemsAction)?.continuationItems ??
        asRecord(record?.reloadContinuationItemsCommand)?.continuationItems;
      if (Array.isArray(items)) lists.push(items);
    }
  }

  const continuationContents = asRecord(payload?.continuationContents);
  if (continuationContents) {
    for (const value of Object.values(continuationContents)) {
      const section = asRecord(value);
      if (Array.isArray(section?.contents)) lists.push(section.contents);
      if (Array.isArray(section?.continuations)) lists.push(section.continuations);
    }
  }

  return lists;
}

function accessibilityLabel(value: unknown): string {
  const record = asRecord(value);
  return readString(
    asRecord(asRecord(record?.accessibility)?.accessibilityData)?.label,
    asRecord(record?.accessibilityData)?.label,
  );
}

function commentsCountFromHeader(
  header: Record<string, unknown> | null,
): string | null {
  if (!header) return null;

  const nested =
    asRecord(header.commentsHeaderViewModel) ??
    asRecord(header.commentHeaderViewModel) ??
    header;

  const candidates = [
    nested.countText,
    nested.commentsCount,
    nested.commentCount,
    nested.countTeaser,
    nested.contextualInfo,
  ];

  for (const candidate of candidates) {
    const label = readString(
      runsToText(candidate),
      accessibilityLabel(candidate),
    );
    if (label && /\d/.test(label)) return label;
  }

  return null;
}

function findFirstByKey(
  node: unknown,
  key: string,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 40 || !node || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstByKey(item, key, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = node as Record<string, unknown>;
  const match = asRecord(record[key]);
  if (match) return match;

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const found = findFirstByKey(value, key, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function payloadWatchVideoId(payload: unknown): string | null {
  const record = asRecord(payload);
  return (
    readString(
      asRecord(asRecord(record?.currentVideoEndpoint)?.watchEndpoint)?.videoId,
    ) || null
  );
}

export function extractCommentsCountLabel(payload: unknown): string | null {
  const fromHeader =
    commentsCountFromHeader(findFirstByKey(payload, 'commentsHeaderRenderer')) ??
    commentsCountFromHeader(findFirstByKey(payload, 'commentsHeaderViewModel'));
  if (fromHeader) return fromHeader;

  const fromEntry = commentsCountFromHeader(
    findFirstByKey(payload, 'commentsEntryPointHeaderRenderer'),
  );
  if (fromEntry) return fromEntry;

  const sections: unknown[] = [];
  findCommentSections(payload, sections);
  for (const section of sections) {
    const record = asRecord(section);
    const panelHeader = asRecord(
      asRecord(record?.header)?.engagementPanelTitleHeaderRenderer,
    );
    const contextual = readString(
      runsToText(panelHeader?.contextualInfo),
      asRecord(panelHeader?.contextualInfo)?.simpleText,
      accessibilityLabel(panelHeader?.contextualInfo),
    );
    if (contextual && /\d/.test(contextual)) return contextual;
  }

  return null;
}

function extractSortToken(items: Record<string, unknown>[]): QueuedToken | null {
  for (const item of items) {
    const header = asRecord(item.commentsHeaderRenderer);
    if (!header) continue;

    const menuItems = asRecord(asRecord(header.sortMenu)?.sortFilterSubMenuRenderer)
      ?.subMenuItems;
    if (!Array.isArray(menuItems) || menuItems.length === 0) continue;

    const ranked = menuItems.map((entry) => asRecord(entry));
    const newest = ranked.find((entry) =>
      /new/i.test(readString(entry?.title, runsToText(entry?.title))),
    );
    const chosen =
      newest ?? ranked[Math.min(1, ranked.length - 1)] ?? ranked[0];
    return continuationFrom(chosen?.serviceEndpoint ?? chosen);
  }

  return null;
}

function extractNextPageToken(items: Record<string, unknown>[]): QueuedToken | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const renderer = continuationItem(items[index]);
    if (!renderer) continue;
    const token = continuationFrom(renderer);
    if (token) return { ...token, isReply: false };
  }

  return null;
}

function collectReplyTokensFromNode(
  node: unknown,
  tokens: QueuedToken[],
  depth = 0,
): void {
  if (depth > 10 || !node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectReplyTokensFromNode(item, tokens, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  const renderer = continuationItem(record);
  if (renderer) {
    const token = continuationFrom(renderer);
    if (token) pushToken(tokens, { ...token, isReply: true });
  }

  const viewReplies = asRecord(asRecord(record.viewReplies)?.buttonRenderer);
  if (viewReplies) {
    const token = continuationFrom(viewReplies.command ?? viewReplies);
    if (token) pushToken(tokens, { ...token, isReply: true });
  }

  for (const key of [
    'replies',
    'commentRepliesRenderer',
    'contents',
    'subThreads',
    'continuations',
    'commentThreadRenderer',
    'commentViewModel',
  ]) {
    if (record[key]) collectReplyTokensFromNode(record[key], tokens, depth + 1);
  }
}

function collectReplyTokens(
  items: Record<string, unknown>[],
  tokens: QueuedToken[],
): void {
  for (const item of items) {
    const thread = asRecord(item.commentThreadRenderer) ?? item;
    collectReplyTokensFromNode(thread, tokens);
  }
}

function isCommentSection(record: Record<string, unknown>): boolean {
  const header = asRecord(record.header);
  const identifier = readString(
    record.sectionIdentifier,
    record.targetId,
    record.panelIdentifier,
    header?.commentsHeaderRenderer ? 'comments' : '',
    asRecord(header?.title)?.simpleText,
    runsToText(header?.title),
  );
  return /comment/i.test(identifier);
}

function findCommentSections(node: unknown, sections: unknown[]): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) findCommentSections(item, sections);
    return;
  }

  const record = node as Record<string, unknown>;
  const panel = asRecord(record.engagementPanelSectionListRenderer);
  if (panel && isCommentSection(panel)) sections.push(panel);

  const section = asRecord(record.itemSectionRenderer);
  if (section && isCommentSection(section)) {
    sections.push(section);
    return;
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') findCommentSections(value, sections);
  }
}

function commentFromEntity(
  payload: Record<string, unknown>,
  isReply: boolean,
): YouTubeComment | null {
  const properties = asRecord(payload.properties);
  const author = asRecord(payload.author);
  const toolbar = asRecord(payload.toolbar);
  const text = runsToText(properties?.content);
  const id = readString(properties?.commentId, payload.key);
  if (!text || !id) return null;

  const channelId = readString(author?.channelId, author?.canonicalChannelId);
  const replyLevel = Number(properties?.replyLevel ?? 0);

  return {
    id,
    author: readString(author?.displayName) || 'Unknown author',
    authorUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : null,
    avatarUrl: readString(author?.avatarThumbnailUrl) || null,
    text,
    publishedAt: readString(properties?.publishedTime),
    permalink: `https://www.youtube.com/watch?v=${getWatchId()}&lc=${id}`,
    likeCount:
      readString(
        toolbar?.likeCountNotliked,
        toolbar?.likeCountLiked,
        toolbar?.likeCountA11y,
      ) || null,
    isReply: isReply || replyLevel > 0,
    isPinned: Boolean(properties?.pinned),
    isCreatorHearted: Boolean(
      asRecord(toolbar?.creatorHeart)?.isHearted || toolbar?.heartActive,
    ),
  };
}

function commentFromRenderer(
  renderer: Record<string, unknown>,
  isReply: boolean,
): YouTubeComment | null {
  const text = runsToText(renderer.contentText) || runsToText(renderer.expansionText);
  const id = readString(renderer.commentId);
  if (!text || !id) return null;

  const authorEndpoint = asRecord(
    asRecord(renderer.authorEndpoint)?.browseEndpoint,
  );
  const thumbnails = asRecord(renderer.authorThumbnail)?.thumbnails;
  const lastThumbnail = Array.isArray(thumbnails)
    ? thumbnails[thumbnails.length - 1]
    : null;
  const avatarUrl = readString(asRecord(lastThumbnail)?.url);

  return {
    id,
    author:
      readString(asRecord(renderer.authorText)?.simpleText) || 'Unknown author',
    authorUrl: authorEndpoint?.browseId
      ? `https://www.youtube.com/channel/${String(authorEndpoint.browseId)}`
      : null,
    avatarUrl: avatarUrl || null,
    text,
    publishedAt: runsToText(renderer.publishedTimeText),
    permalink: `https://www.youtube.com/watch?v=${getWatchId()}&lc=${id}`,
    likeCount:
      readString(renderer.voteCount, asRecord(renderer.voteCount)?.simpleText) ||
      null,
    isReply,
    isPinned: Boolean(renderer.pinnedCommentBadge),
    isCreatorHearted: Boolean(
      asRecord(renderer.creatorHeart)?.creatorHeartRenderer,
    ),
  };
}

function parseEntities(data: unknown): Map<string, YouTubeComment> {
  const comments = new Map<string, YouTubeComment>();
  const mutations =
    asRecord(asRecord(asRecord(data)?.frameworkUpdates)?.entityBatchUpdate)
      ?.mutations;

  if (!Array.isArray(mutations)) return comments;

  for (const mutation of mutations) {
    const payload = asRecord(
      asRecord(asRecord(mutation)?.payload)?.commentEntityPayload,
    );
    if (!payload) continue;
    const comment = commentFromEntity(payload, false);
    if (comment) comments.set(comment.id, comment);
  }

  return comments;
}

function commentsFromItems(
  items: Record<string, unknown>[],
  isReply: boolean,
): YouTubeComment[] {
  const comments: YouTubeComment[] = [];

  for (const item of items) {
    const thread = asRecord(item.commentThreadRenderer);
    if (thread) {
      const nested = asRecord(thread.comment);
      const renderer = asRecord(nested?.commentRenderer) ?? nested;
      if (renderer) {
        const comment = commentFromRenderer(renderer, false);
        if (comment) comments.push(comment);
      }
      continue;
    }

    const renderer = asRecord(item.commentRenderer);
    if (renderer) {
      const comment = commentFromRenderer(renderer, isReply);
      if (comment) comments.push(comment);
    }
  }

  return comments;
}

function isCommentItem(item: Record<string, unknown>): boolean {
  return Boolean(
    item.commentThreadRenderer || item.commentViewModel || item.commentRenderer,
  );
}

function parseNextResponse(
  data: unknown,
  isReply: boolean,
): {
  comments: YouTubeComment[];
  pageTokens: QueuedToken[];
  replyTokens: QueuedToken[];
  totalCommentsLabel: string | null;
} {
  const comments = new Map<string, YouTubeComment>(parseEntities(data));
  const pageTokens: QueuedToken[] = [];
  const replyTokens: QueuedToken[] = [];
  const bodyItems: Record<string, unknown>[] = [];
  let sortToken: QueuedToken | null = null;
  let sawCommentItems = false;
  let totalCommentsLabel = extractCommentsCountLabel(data);

  for (const list of continuationLists(data)) {
    const items = flattenItems(list);
    const rendered = commentsFromItems(items, isReply);
    const headerToken = extractSortToken(items);

    if (headerToken) sortToken = headerToken;
    if (items.some(isCommentItem)) {
      sawCommentItems = true;
      bodyItems.push(...items);
    } else if (bodyItems.length === 0 && items.some((item) => continuationItem(item))) {
      bodyItems.push(...items);
    }

    for (const comment of rendered) comments.set(comment.id, comment);
    collectReplyTokens(items, replyTokens);
  }

  if (sortToken) {
    pushToken(pageTokens, sortToken);
  }
  pushToken(pageTokens, extractNextPageToken(bodyItems));

  if (isReply) {
    for (const comment of comments.values()) comment.isReply = true;
  }

  return {
    comments: [...comments.values()],
    pageTokens,
    replyTokens,
    totalCommentsLabel,
  };
}

async function fetchInnertube(
  context: InnertubeContext,
  body: Record<string, unknown>,
  clickTrackingParams?: string,
): Promise<unknown> {
  const apiKey = readString(getYtcfgValue('INNERTUBE_API_KEY'));
  const visitorId = readString(
    getYtcfgValue('VISITOR_DATA'),
    asRecord(context.client)?.visitorData,
  );
  const url = new URL('https://www.youtube.com/youtubei/v1/next');
  url.searchParams.set('prettyPrint', 'false');
  if (apiKey) url.searchParams.set('key', apiKey);

  const payload: Record<string, unknown> = {
    context,
    ...body,
  };
  if (clickTrackingParams) {
    payload.clickTracking = { clickTrackingParams };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-YouTube-Client-Name': String(
      getYtcfgValue('INNERTUBE_CONTEXT_CLIENT_NAME') ?? '1',
    ),
    'X-YouTube-Client-Version': String(
      getYtcfgValue('INNERTUBE_CLIENT_VERSION') ?? '',
    ),
  };
  if (visitorId) headers['X-Goog-Visitor-Id'] = visitorId;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  });

  if (!response.ok) {
    if (response.status === 429 || response.status === 403) {
      throw new Error(
        'YouTube rate-limited comment loading. Wait a minute, then try again.',
      );
    }
    throw new Error(`YouTube returned ${response.status} while loading comments.`);
  }

  const raw = await response.text();
  return JSON.parse(raw.replace(/^\)\]\}'/, ''));
}

function sectionContents(section: unknown): unknown[] {
  const record = asRecord(section);
  if (!record) return [];
  if (Array.isArray(record.contents)) return record.contents;

  const content = asRecord(record.content);
  const nested =
    asRecord(content?.sectionListRenderer)?.contents ?? content?.contents;
  return Array.isArray(nested) ? nested : [];
}

function seedFromPayload(
  payload: unknown,
  collected: Map<string, YouTubeComment>,
  pageQueue: QueuedToken[],
  replyQueue: QueuedToken[],
): void {
  const sections: unknown[] = [];
  findCommentSections(payload, sections);

  for (const comment of parseEntities(payload).values()) {
    collected.set(comment.id, comment);
  }

  for (const section of sections) {
    const items = flattenItems(sectionContents(section));
    for (const comment of commentsFromItems(items, false)) {
      collected.set(comment.id, comment);
    }
    pushToken(pageQueue, extractSortToken(items));
    pushToken(pageQueue, extractNextPageToken(items));
    collectReplyTokens(items, replyQueue);
    pushToken(pageQueue, continuationFrom(section));
  }
}

export async function fetchVideoCommentCount(
  expectedVideoId: string,
  isCancelled?: () => boolean,
): Promise<string | null> {
  const videoId = expectedVideoId || getYouTubeVideoId(window.location.href) || '';
  if (!videoId) return null;

  await waitForWatchId(videoId, 12_000);
  if (isCancelled?.()) return null;

  const initial = getYtInitialData();
  if (payloadWatchVideoId(initial) === videoId) {
    const fromInitial = extractCommentsCountLabel(initial);
    if (fromInitial) return fromInitial;
  }

  const context = getInnertubeContext();

  try {
    const watchNext = await fetchInnertube(context, { videoId });
    if (isCancelled?.() || getYouTubeVideoId(window.location.href) !== videoId) {
      return null;
    }
    const fromWatch = extractCommentsCountLabel(watchNext);
    if (fromWatch) return fromWatch;
  } catch {
    // Fall through to the comments continuation, which has the header count.
  }

  const generated = generateCommentContinuation(videoId);
  if (!generated) return null;

  const data = await fetchInnertube(context, { continuation: generated });
  if (isCancelled?.() || getYouTubeVideoId(window.location.href) !== videoId) {
    return null;
  }

  return parseNextResponse(data, false).totalCommentsLabel;
}

export async function fetchAllVideoComments(
  onProgress: (count: number, totalCommentsLabel?: string | null) => void,
  maxComments = MAX_FETCHED_COMMENTS,
  expectedVideoId?: string,
  isCancelled?: () => boolean,
): Promise<{
  comments: YouTubeComment[];
  truncated: boolean;
  totalCommentsLabel: string | null;
}> {
  const videoId = expectedVideoId || getYouTubeVideoId(window.location.href) || '';
  if (!videoId) {
    throw new Error('Open a YouTube video first.');
  }

  await waitForWatchId(videoId);
  if (isCancelled?.()) {
    return { comments: [], truncated: false, totalCommentsLabel: null };
  }

  activeFetchVideoId = videoId;
  const context = getInnertubeContext();
  const collected = new Map<string, YouTubeComment>();
  const seenTokens = new Set<string>();
  const pageQueue: QueuedToken[] = [];
  const replyQueue: QueuedToken[] = [];
  let totalCommentsLabel: string | null = null;

  const generated = generateCommentContinuation(videoId);
  if (generated) {
    pushToken(pageQueue, { token: generated, isReply: false });
  }

  if (pageQueue.length === 0 && replyQueue.length === 0) {
    throw new Error(
      'Could not find YouTube comment data. Refresh the video page, then try again.',
    );
  }

  onProgress(collected.size, totalCommentsLabel);

  let pages = 0;
  let rateLimited = false;

  const fetchToken = async (next: QueuedToken): Promise<void> => {
    if (isCancelled?.()) return;
    if (getYouTubeVideoId(window.location.href) !== videoId) return;
    if (seenTokens.has(next.token) || collected.size >= maxComments) return;
    if (pages >= MAX_CONTINUATION_PAGES || rateLimited) return;
    seenTokens.add(next.token);
    pages += 1;

    try {
      const data = await fetchInnertube(
        context,
        { continuation: next.token },
        next.clickTrackingParams,
      );
      if (isCancelled?.() || getYouTubeVideoId(window.location.href) !== videoId) {
        return;
      }
      const parsed = parseNextResponse(data, next.isReply);
      if (!totalCommentsLabel && parsed.totalCommentsLabel) {
        totalCommentsLabel = parsed.totalCommentsLabel;
      }

      for (const comment of parsed.comments) {
        if (collected.size >= maxComments) break;
        collected.set(comment.id, comment);
      }

      for (const token of parsed.pageTokens) pageQueue.push(token);
      for (const token of parsed.replyTokens) replyQueue.push(token);
      onProgress(collected.size, totalCommentsLabel);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('rate-limited')) {
        rateLimited = true;
        return;
      }
      // Skip a single failed reply thread and keep the rest.
    }
  };

  const canContinue = () =>
    collected.size < maxComments &&
    pages < MAX_CONTINUATION_PAGES &&
    !rateLimited &&
    !isCancelled?.() &&
    getYouTubeVideoId(window.location.href) === videoId;

  let pageActive = 0;
  let replyActive = 0;
  const running = new Set<Promise<void>>();

  const startToken = (next: QueuedToken, kind: 'page' | 'reply') => {
    if (kind === 'page') pageActive += 1;
    else replyActive += 1;

    const task = fetchToken(next).finally(() => {
      if (kind === 'page') pageActive -= 1;
      else replyActive -= 1;
      running.delete(task);
    });
    running.add(task);
  };

  const pump = () => {
    while (pageActive < PAGE_CONCURRENCY && pageQueue.length > 0 && canContinue()) {
      const next = pageQueue.shift();
      if (next) startToken(next, 'page');
    }

    while (
      replyActive < REPLY_CONCURRENCY &&
      replyQueue.length > 0 &&
      canContinue()
    ) {
      const next = replyQueue.shift();
      if (next) startToken(next, 'reply');
    }
  };

  pump();
  while (running.size > 0) {
    await Promise.race(running);
    pump();
  }

  if (rateLimited && collected.size === 0) {
    throw new Error(
      'YouTube rate-limited comment loading. Wait a minute, then try again.',
    );
  }

  return {
    comments: [...collected.values()],
    truncated:
      rateLimited ||
      pageQueue.length > 0 ||
      replyQueue.length > 0 ||
      pages >= MAX_CONTINUATION_PAGES ||
      collected.size >= maxComments,
    totalCommentsLabel,
  };
}
