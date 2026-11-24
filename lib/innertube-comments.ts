import {
  CRAWL_COMMENT_FUSE,
  CRAWL_PAGE_FUSE,
  canonicalYouTubeCommentId,
  getYouTubeVideoId,
  parentCommentId,
  replyButtonCountFromText,
  type CommentPatch,
  type CommentSortOrder,
  type YouTubeComment,
} from '@/lib/comments';

export const INNERTUBE_BRIDGE = {
  request: 'comment-catcher:load-all',
  progress: 'comment-catcher:load-all-progress',
  result: 'comment-catcher:load-all-result',
  countRequest: 'comment-catcher:comment-count',
  countResult: 'comment-catcher:comment-count-result',
  ready: 'comment-catcher:bridge-ready',
  sessionRequest: 'comment-catcher:session',
  sessionResult: 'comment-catcher:session-result',
  rawFetch: 'comment-catcher:raw-fetch',
  rawResult: 'comment-catcher:raw-result',
} as const;

const PAGE_CONCURRENCY = 2;
const REPLY_CONCURRENCY = 6;
const RATE_LIMIT_ATTEMPTS = 12;

// Captured before YouTube wraps fetch. A wrapped fetch applies the response
// to the open comments section, so a Newest request would switch the page's
// own sort control.
const innertubeFetch = globalThis.fetch.bind(globalThis);

interface InnertubeContext {
  client: Record<string, unknown>;
  user?: Record<string, unknown>;
  request?: Record<string, unknown>;
}

export interface InnertubeSession {
  context: InnertubeContext;
  apiKey: string;
  clientName: string;
  clientVersion: string;
  visitorId: string;
  sessionIndex: string;
}

export class InnertubeRateLimitError extends Error {
  constructor() {
    super('YouTube rate-limited comment loading. Wait a minute, then try again.');
    this.name = 'InnertubeRateLimitError';
  }
}

interface QueuedToken {
  token: string;
  isReply: boolean;
  clickTrackingParams?: string;
  parentId?: string;
  // Set on top-level pages so every comment on the page can be given the
  // position YouTube gave it in that order.
  sort?: CommentSortOrder;
  attempt?: number;
}

export type ContinuationFetcher = (
  token: string,
  clickTrackingParams?: string,
  sort?: CommentSortOrder,
) => Promise<unknown>;

export interface LoadAllRequest {
  type: typeof INNERTUBE_BRIDGE.request;
  requestId: string;
  videoId: string;
}

export interface LoadAllProgress {
  type: typeof INNERTUBE_BRIDGE.progress;
  requestId: string;
  count: number;
  comments?: YouTubeComment[];
  patches?: CommentPatch[];
  totalCommentsLabel?: string | null;
}

export interface LoadAllResult {
  type: typeof INNERTUBE_BRIDGE.result;
  requestId: string;
  comments: YouTubeComment[];
  count?: number;
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
  if (activeFetchVideoId) return activeFetchVideoId;
  if (typeof window === 'undefined') return '';
  return getYouTubeVideoId(window.location.href) || '';
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

function generateCommentContinuation(
  videoId: string,
  order: CommentSortOrder,
): string | null {
  if (!videoId) return null;

  // yt-dlp-style comments-section token. Field 6 of the protobuf is the sort
  // selector YouTube's own header sends: 0 is "Top", 1 is "Newest". Asking
  // YouTube for each order is what makes the list match the page, because
  // "Top" is a server-side ranking rather than a like-count sort.
  const bytes = [
    ...decodeBase64Bytes('Eg0SCw=='),
    ...encodeUtf8(videoId),
    ...decodeBase64Bytes('GAYyJyIRIgs='),
    ...encodeUtf8(videoId),
    0x30,
    order === 'newest' ? 0x01 : 0x00,
    ...decodeBase64Bytes('eAIwAEIQY29tbWVudHMtc2VjdGlvbg=='),
  ];

  return bytesToBase64(bytes);
}

// Each sort chain walks its own copy of a continuation. The two listings hand
// back different tokens for the same thread, and collapsing them would let one
// chain's pages be credited to the other.
function tokenChainKey(token: QueuedToken): string {
  return `${token.sort ?? ''}|${token.token}`;
}

function pushToken(tokens: QueuedToken[], next: QueuedToken | null): void {
  if (!next?.token || next.token.length < 16) return;
  if (tokens.some((item) => tokenChainKey(item) === tokenChainKey(next))) return;
  tokens.push(next);
}

function continuationFrom(node: unknown, depth = 0): QueuedToken | null {
  const record = asRecord(node);
  if (!record || depth > 8) return null;

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
    record.onTap,
    record.innertubeCommand,
    record.command,
    command,
    asRecord(command)?.innertubeCommand,
    asRecord(record.continuationItemViewModel)?.continuationCommand,
    asRecord(asRecord(record.button)?.buttonRenderer)?.command,
    asRecord(asRecord(record.button)?.buttonRenderer)?.navigationEndpoint,
    asRecord(asRecord(record.button)?.buttonRenderer)?.onTap,
    asRecord(record.buttonRenderer)?.command,
    asRecord(record.buttonRenderer)?.onTap,
    asRecord(record.buttonViewModel)?.onTap,
  ];

  for (const child of nested) {
    const found = continuationFrom(child, depth + 1);
    if (found) return found;
  }

  const executor = asRecord(record.commandExecutorCommand);
  if (Array.isArray(executor?.commands)) {
    for (const child of executor.commands) {
      const found = continuationFrom(child, depth + 1);
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
    asRecord(record.continuationItemViewModel) ??
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

    if (record.commentRepliesRenderer) {
      const replies = asRecord(record.commentRepliesRenderer);
      if (Array.isArray(replies?.contents)) replies.contents.forEach(visit);
      if (Array.isArray(replies?.subThreads)) replies.subThreads.forEach(visit);
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

function isNewestSortLabel(label: string): boolean {
  return /new|yeni|neueste|r[eé]cents?|recientes|recenti|recentes|nieuw|нов|najnowsze|nyeste|nyaste|uudet|חדש|الأحدث|最新|최신/i.test(
    label,
  );
}

function sortTokenFromMenuItems(menuItems: unknown): QueuedToken | null {
  if (!Array.isArray(menuItems) || menuItems.length === 0) return null;

  const ranked = menuItems.map((entry) => asRecord(entry));
  const newest = ranked.find((entry) =>
    isNewestSortLabel(readString(entry?.title, runsToText(entry?.title))),
  );
  if (!newest) return null;

  return continuationFrom(
    newest.serviceEndpoint ?? newest.command ?? newest.onTap ?? newest,
  );
}

function extractSortToken(node: unknown): QueuedToken | null {
  const header =
    findFirstByKey(node, 'commentsHeaderRenderer') ??
    findFirstByKey(node, 'commentsHeaderViewModel');
  const menu =
    findFirstByKey(header ?? node, 'sortFilterSubMenuRenderer') ??
    findFirstByKey(node, 'sortFilterSubMenuRenderer');
  return sortTokenFromMenuItems(menu?.subMenuItems);
}

function extractPageTokens(
  items: Record<string, unknown>[],
  isReply: boolean,
): QueuedToken[] {
  const tokens: QueuedToken[] = [];

  for (const item of items) {
    if (!isReply && isCommentItem(item)) continue;
    if (!isReply && continuationLooksLikeReplies(item)) continue;
    const renderer = continuationItem(item);
    if (!renderer) continue;
    const token = continuationFrom(renderer);
    if (token) pushToken(tokens, { ...token, isReply });
  }

  return tokens;
}

function collectReplyTokensFromNode(
  node: unknown,
  tokens: QueuedToken[],
  depth = 0,
): void {
  if (depth > 18 || !node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectReplyTokensFromNode(item, tokens, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  if (Array.isArray(record.subThreads)) {
    collectReplyTokensFromNode(record.subThreads, tokens, depth + 1);
  }

  const renderer = continuationItem(record);
  if (renderer) {
    const token = continuationFrom(renderer);
    if (token) pushToken(tokens, { ...token, isReply: true });
  }

  const viewReplies = asRecord(asRecord(record.viewReplies)?.buttonRenderer);
  if (viewReplies) {
    const token = continuationFrom(
      viewReplies.command ?? viewReplies.onTap ?? viewReplies,
    );
    if (token) pushToken(tokens, { ...token, isReply: true });
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      collectReplyTokensFromNode(value, tokens, depth + 1);
    }
  }
}

function collectReplyTokens(
  items: Record<string, unknown>[],
  tokens: QueuedToken[],
): void {
  let lastRootId = '';

  for (const item of items) {
    if (item.commentsHeaderRenderer || item.commentsHeaderViewModel) continue;

    const itemId = commentIdFromItem(item);
    if (itemId && !itemId.includes('.')) lastRootId = itemId;

    if (
      continuationItem(item) &&
      !isCommentItem(item) &&
      !continuationLooksLikeReplies(item)
    ) {
      continue;
    }

    const before = tokens.length;
    const thread = asRecord(item.commentThreadRenderer) ?? item;
    collectReplyTokensFromNode(thread, tokens);
    for (let index = before; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token && !token.parentId && lastRootId) {
        token.parentId = lastRootId;
      }
    }
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

function canonicalCommentId(...values: unknown[]): string {
  for (const value of values) {
    const id = canonicalYouTubeCommentId(readString(value));
    if (id) return id;
  }
  return '';
}

function formatCountLabel(value: unknown, unit: 'like' | 'reply'): string | null {
  const text = readString(
    value,
    asRecord(value)?.simpleText,
    asRecord(asRecord(asRecord(value)?.accessibility)?.accessibilityData)?.label,
  );
  if (!text) return null;

  const unitPattern = unit === 'like' ? 'likes?' : 'replies|reply';
  const fromSentence = text.match(
    new RegExp(`([\\d.,]+\\s*[KMB]?)\\s+(?:${unitPattern})`, 'i'),
  )?.[1];
  if (fromSentence) return fromSentence.replace(/\s+/g, '');

  const compact = text.match(/^([\d.,]+\s*[KMB]?)$/i)?.[1];
  if (compact) return compact.replace(/\s+/g, '');

  return null;
}

function toolbarLikeCount(toolbar: Record<string, unknown> | null): string | null {
  if (!toolbar) return null;

  const fromA11y = formatCountLabel(toolbar.likeCountA11y, 'like');
  if (fromA11y) return fromA11y;

  const notLiked = readString(toolbar.likeCountNotliked);
  if (notLiked && /\d/.test(notLiked)) return notLiked;
  if (typeof toolbar.likeCountNotliked === 'string') return '0';

  return formatCountLabel(toolbar.likeButtonA11y, 'like') ?? '0';
}

function toolbarReplyCount(toolbar: Record<string, unknown> | null): string | null {
  if (!toolbar) return null;

  const fromA11y = formatCountLabel(toolbar.replyCountA11y, 'reply');
  if (fromA11y) return fromA11y;

  const raw = readString(toolbar.replyCount);
  if (raw && /\d/.test(raw)) return raw.replace(/[^\d.,KMB]/gi, '') || raw;
  return '0';
}

function commentFromEntity(
  payload: Record<string, unknown>,
  isReply: boolean,
  inheritedParentId?: string,
  heartedToolbarKeys?: Set<string>,
): YouTubeComment | null {
  const properties = asRecord(payload.properties);
  const author = asRecord(payload.author);
  const toolbar = asRecord(payload.toolbar);
  const content = properties?.content;
  const text =
    runsToText(content) ||
    readString(asRecord(content)?.content, asRecord(asRecord(content)?.content)?.content);
  const id = canonicalCommentId(properties?.commentId, payload.commentId, payload.key, payload.entityKey);
  if (!text || !id) return null;

  const channelId = readString(author?.channelId, author?.canonicalChannelId);
  const toolbarStateKey = readString(properties?.toolbarStateKey, payload.toolbarStateKey);
  const replyLevel = Number(properties?.replyLevel ?? 0);
  const dottedParent = id.includes('.') ? id.slice(0, id.indexOf('.')) : '';
  // A reply page's entity batch also carries comments from other threads.
  // The inherited parent applies only when this id already belongs to it.
  const belongsToInherited = Boolean(
    inheritedParentId &&
      inheritedParentId !== id &&
      (id.startsWith(`${inheritedParentId}.`) || parentCommentId(id) === inheritedParentId),
  );
  const parentId =
    readString(properties?.parentCommentId, payload.parentCommentId) ||
    dottedParent ||
    (belongsToInherited ? inheritedParentId ?? '' : '');
  const commentIsReply =
    isReply || replyLevel > 0 || Boolean(parentId) || id.includes('.');

  return {
    id,
    author: readString(author?.displayName) || 'Unknown author',
    authorUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : null,
    avatarUrl: readString(author?.avatarThumbnailUrl) || null,
    text,
    publishedAt: readString(properties?.publishedTime),
    permalink: `https://www.youtube.com/watch?v=${getWatchId()}&lc=${id}`,
    likeCount: toolbarLikeCount(toolbar),
    replyCount: commentIsReply ? null : toolbarReplyCount(toolbar),
    parentId: parentId || null,
    isReply: commentIsReply,
    // Pinned never appears on the entity; parseNextResponse merges it in from
    // the rendered thread.
    isPinned: false,
    pinnedLabel: null,
    isCreatorHearted: Boolean(
      toolbarStateKey && heartedToolbarKeys?.has(toolbarStateKey),
    ),
    isVerified: Boolean(author?.isVerified || author?.isArtist),
    isChannelOwner: Boolean(author?.isCreator),
    replyLevel: commentIsReply ? Math.max(1, replyLevel || 1) : 0,
  };
}

function commentFromRenderer(
  renderer: Record<string, unknown>,
  isReply: boolean,
): YouTubeComment | null {
  const text = runsToText(renderer.contentText) || runsToText(renderer.expansionText);
  const id = canonicalCommentId(renderer.commentId);
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
      formatCountLabel(renderer.voteCount, 'like') ??
      formatCountLabel(asRecord(renderer.voteCount)?.simpleText, 'like') ??
      '0',
    replyCount: isReply ? null : formatCountLabel(renderer.replyCount, 'reply'),
    parentId: readString(renderer.parentCommentId) || null,
    isReply,
    isPinned: Boolean(renderer.pinnedCommentBadge),
    isCreatorHearted: Boolean(
      asRecord(renderer.creatorHeart)?.creatorHeartRenderer,
    ),
    replyLevel: isReply ? 1 : 0,
  };
}

function parseEntities(
  data: unknown,
  isReply = false,
  parentId?: string,
): Map<string, YouTubeComment> {
  const comments = new Map<string, YouTubeComment>();
  const mutations =
    asRecord(asRecord(asRecord(data)?.frameworkUpdates)?.entityBatchUpdate)
      ?.mutations;

  if (!Array.isArray(mutations)) return comments;

  // The creator heart lives in its own entity, keyed by the comment's
  // toolbarStateKey, so it has to be gathered before the comments are built.
  const heartedToolbarKeys = new Set<string>();
  for (const mutation of mutations) {
    const state = asRecord(
      asRecord(asRecord(mutation)?.payload)?.engagementToolbarStateEntityPayload,
    );
    if (!state) continue;
    if (/HEARTED/i.test(readString(state.heartState)) &&
        !/UNHEARTED/i.test(readString(state.heartState))) {
      const key = readString(state.key, asRecord(mutation)?.entityKey);
      if (key) heartedToolbarKeys.add(key);
    }
  }

  for (const mutation of mutations) {
    const record = asRecord(mutation);
    const payload = asRecord(asRecord(record?.payload)?.commentEntityPayload);
    if (!payload) continue;
    const comment = commentFromEntity(
      {
        ...payload,
        key: payload.key ?? record?.entityKey,
        entityKey: record?.entityKey,
      },
      isReply,
      parentId,
      heartedToolbarKeys,
    );
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

function commentIdFromItem(item: Record<string, unknown>): string {
  const thread = asRecord(item.commentThreadRenderer);
  const nested = asRecord(thread?.comment);
  const renderer = asRecord(nested?.commentRenderer) ?? nested ?? asRecord(item.commentRenderer);
  const outerViewModel = asRecord(item.commentViewModel) ?? asRecord(thread?.commentViewModel);
  const viewModel = asRecord(outerViewModel?.commentViewModel) ?? outerViewModel;
  return canonicalCommentId(
    renderer?.commentId,
    asRecord(renderer?.properties)?.commentId,
    viewModel?.commentId,
    asRecord(viewModel?.properties)?.commentId,
  );
}

function continuationLooksLikeReplies(node: unknown, depth = 0): boolean {
  const record = asRecord(node);
  if (!record || depth > 6) return false;
  if (record.commentRepliesRenderer) return true;

  const targetId = readString(record.targetId);
  if (/repl/i.test(targetId)) return true;

  const label = readString(
    accessibilityLabel(record),
    runsToText(record.text),
    asRecord(record.text)?.simpleText,
    runsToText(record.title),
    record.title,
  );
  if (/\b(?:view\s+)?\d[\d.,KMB]*\s*repl(?:y|ies)\b|\bview replies\b/i.test(label)) {
    return true;
  }

  const renderer = continuationItem(record);
  if (renderer && renderer !== record && continuationLooksLikeReplies(renderer, depth + 1)) {
    return true;
  }

  for (const key of ['button', 'buttonRenderer', 'buttonViewModel', 'viewReplies', 'replies']) {
    if (record[key] && continuationLooksLikeReplies(record[key], depth + 1)) return true;
  }

  return false;
}

function threadViewModel(item: Record<string, unknown>): Record<string, unknown> | null {
  const thread = asRecord(item.commentThreadRenderer);
  const outer = asRecord(item.commentViewModel) ?? asRecord(thread?.commentViewModel);
  return asRecord(outer?.commentViewModel) ?? outer;
}

// "Pinned by @channel" is only ever sent on the rendered thread, never on the
// comment entity, so it has to be read here and merged onto the comment.
function pinnedLabelsFromItems(
  items: Record<string, unknown>[],
): Map<string, string> {
  const pinned = new Map<string, string>();

  for (const item of items) {
    const viewModel = threadViewModel(item);
    if (!viewModel) continue;

    const label = readString(
      viewModel.pinnedText,
      runsToText(viewModel.pinnedText),
      asRecord(viewModel.pinnedText)?.simpleText,
    );
    const id = canonicalCommentId(viewModel.commentId);
    if (label && id) pinned.set(id, label);
  }

  return pinned;
}

function commentIdsByEntityKey(data: unknown): Map<string, string> {
  const byKey = new Map<string, string>();
  const mutations =
    asRecord(asRecord(asRecord(data)?.frameworkUpdates)?.entityBatchUpdate)
      ?.mutations;
  if (!Array.isArray(mutations)) return byKey;

  for (const mutation of mutations) {
    const record = asRecord(mutation);
    const payload = asRecord(asRecord(record?.payload)?.commentEntityPayload);
    if (!payload) continue;
    const id = canonicalCommentId(
      asRecord(payload.properties)?.commentId,
      payload.commentId,
    );
    const key = readString(payload.key, record?.entityKey);
    if (id && key) byKey.set(key, id);
  }

  return byKey;
}

function unwrapCommentNode(node: unknown): Record<string, unknown> | null {
  const record = asRecord(node);
  if (!record) return null;
  if (record.richItemRenderer) {
    return unwrapCommentNode(asRecord(record.richItemRenderer)?.content);
  }
  return record;
}

function commentViewModelOf(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const thread = asRecord(record.commentThreadRenderer);
  const source = thread ?? record;
  const outer =
    asRecord(source.commentViewModel) ??
    asRecord(asRecord(source.comment)?.commentViewModel);
  return asRecord(outer?.commentViewModel) ?? outer;
}

function walkedCommentId(
  record: Record<string, unknown>,
  byKey: Map<string, string>,
): string {
  const thread = asRecord(record.commentThreadRenderer);
  const source = thread ?? record;
  const renderer =
    asRecord(asRecord(source.comment)?.commentRenderer) ??
    asRecord(source.commentRenderer);
  const viewModel = commentViewModelOf(record);
  const direct = canonicalCommentId(renderer?.commentId, viewModel?.commentId);
  if (direct) return direct;
  const key = readString(viewModel?.commentKey);
  return key ? byKey.get(key) ?? '' : '';
}

function countFromReplyLabel(value: string): string | null {
  // The view-replies control is the number on the watch page. Bare digits are
  // accepted because that button is often just "229".
  return replyButtonCountFromText(value, true);
}

function buttonLabel(node: unknown): string {
  if (typeof node === 'string') return node;
  const record = asRecord(node);
  if (!record) return '';
  const accessible = asRecord(asRecord(record.accessibility)?.accessibilityData)?.label;
  const title = asRecord(record.title);
  const text = asRecord(record.text);
  return [
    runsToText(record.text),
    runsToText(record.title),
    readString(
      record.title,
      record.text,
      record.accessibilityText,
      record.label,
      record.simpleText,
      record.content,
      title?.simpleText,
      title?.content,
      text?.simpleText,
      text?.content,
      accessible,
    ),
    runsToText(accessible),
  ]
    .filter(Boolean)
    .join(' ');
}

// The expand button is the count YouTube draws on the watch page. The comment
// toolbar's replyCount is a different total (it includes replies the button
// leaves out) and must not be used in its place.
function replyButtonCount(replies: Record<string, unknown>): string | null {
  // Only the expand button. Reading the whole replies renderer picks up a
  // nested count or the toolbar total, which is not the number on the page.
  const view = asRecord(replies.viewReplies);
  if (!view) return null;
  const candidates = [
    view.buttonRenderer,
    view.buttonViewModel,
    asRecord(view.button)?.buttonRenderer,
    asRecord(view.button)?.buttonViewModel,
  ];
  for (const candidate of candidates) {
    const count = countFromReplyLabel(buttonLabel(candidate));
    if (count) return count;
  }
  return null;
}

function repliesRendererOf(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const thread = asRecord(record.commentThreadRenderer);
  return (
    asRecord(asRecord(thread?.replies)?.commentRepliesRenderer) ??
    asRecord(asRecord(record.replies)?.commentRepliesRenderer) ??
    asRecord(record.commentRepliesRenderer)
  );
}

interface WalkedComment {
  id: string;
  replyToId: string | null;
}

// YouTube returns a reply thread as a tree: each commentThreadRenderer carries
// the responses to that comment in replies.commentRepliesRenderer.subThreads.
// Flattening that list drops the parent, so a reply to a reply is drawn as if
// it answered whoever happened to be written above it.
function walkCommentItems(
  nodes: unknown[],
  byKey: Map<string, string>,
  parentId: string | null,
  into: WalkedComment[],
  replyTokens: QueuedToken[],
  comments: Map<string, YouTubeComment>,
  seen: Set<string>,
  replyButtonCounts: Map<string, string>,
  depth = 0,
): void {
  if (depth > 30) return;

  for (const node of nodes) {
    const record = unwrapCommentNode(node);
    if (!record) continue;

    if (record.itemSectionRenderer) {
      const contents = asRecord(record.itemSectionRenderer)?.contents;
      if (Array.isArray(contents)) {
        walkCommentItems(
          contents,
          byKey,
          parentId,
          into,
          replyTokens,
          comments,
          seen,
          replyButtonCounts,
          depth + 1,
        );
      }
      continue;
    }

    if (record.continuationItemRenderer || record.continuationItemViewModel) {
      if (parentId) {
        const token = continuationFrom(continuationItem(record) ?? record);
        if (token) {
          pushToken(replyTokens, { ...token, isReply: true, parentId });
        }
      }
      continue;
    }

    const id = walkedCommentId(record, byKey);
    if (id && !seen.has(id)) {
      // Top-level items on a reply continuation are not all replies of the
      // thread being fetched. The parent itself stays so its replies renderer
      // is still walked. A nested node (depth > 0) was found inside that
      // comment's replies renderer, so it does belong there.
      const isParent = Boolean(parentId) && id === parentId;
      const childOfParent =
        !parentId ||
        depth > 0 ||
        isParent ||
        id.startsWith(`${parentId}.`) ||
        parentCommentId(id) === parentId;
      if (!childOfParent) continue;
      seen.add(id);
      if (!isParent) {
        into.push({ id, replyToId: parentId || null });
        for (const comment of commentsFromItems([record], Boolean(parentId))) {
          if (!comments.has(comment.id)) comments.set(comment.id, comment);
        }
      }
    }

    const replies = repliesRendererOf(record);
    const ownerId = id || parentId;
    if (!replies || !ownerId) continue;

    for (const key of ['contents', 'subThreads', 'continuations'] as const) {
      const nested = replies[key];
      if (!Array.isArray(nested)) continue;
      walkCommentItems(
        nested,
        byKey,
        ownerId,
        into,
        replyTokens,
        comments,
        seen,
        replyButtonCounts,
        depth + 1,
      );
    }

    // Only the comment that owns this expander. Falling back to the parent
    // would replace that parent's button total with a nested reply's.
    const buttonCount = replyButtonCount(replies);
    if (buttonCount && id) {
      const next = parseCompactCount(buttonCount);
      const prev = parseCompactCount(replyButtonCounts.get(id));
      if (prev == null || (next != null && next >= prev)) {
        replyButtonCounts.set(id, buttonCount);
      }
    }

    const viewToken = continuationFrom(replies.viewReplies);
    if (viewToken) {
      pushToken(replyTokens, {
        ...viewToken,
        isReply: true,
        parentId: ownerId,
      });
    }
  }
}

function orderedIdsFromItems(items: Record<string, unknown>[]): string[] {
  const ids: string[] = [];

  for (const item of items) {
    if (!isCommentItem(item)) continue;
    const id = commentIdFromItem(item);
    if (id) ids.push(id);
  }

  return ids;
}

function parseNextResponse(
  data: unknown,
  isReply: boolean,
  parentId?: string,
  scanHeader = true,
): {
  comments: YouTubeComment[];
  pageTokens: QueuedToken[];
  replyTokens: QueuedToken[];
  sortToken: QueuedToken | null;
  totalCommentsLabel: string | null;
  orderedRootIds: string[];
  orderedReplyIds: string[];
  replyButtonCounts: Map<string, string>;
} {
  const comments = new Map<string, YouTubeComment>(
    parseEntities(data, isReply, parentId),
  );
  const pageTokens: QueuedToken[] = [];
  const replyTokens: QueuedToken[] = [];
  const orderedRootIds: string[] = [];
  const orderedReplyIds: string[] = [];
  const replyButtonCounts = new Map<string, string>();
  const pinnedLabels = new Map<string, string>();
  const walked: WalkedComment[] = [];
  const seenWalked = new Set<string>();
  const byKey = commentIdsByEntityKey(data);
  // Continuation pages do not carry the comments header. Walking the whole
  // payload to look for it is most of the main-thread cost of a long crawl.
  let sortToken = scanHeader ? extractSortToken(data) : null;
  let totalCommentsLabel = scanHeader ? extractCommentsCountLabel(data) : null;

  for (const list of continuationLists(data)) {
    const items = flattenItems(list);
    const rendered = commentsFromItems(items, isReply);
    const headerToken = scanHeader ? extractSortToken(items) : null;

    if (headerToken) sortToken = headerToken;
    for (const comment of rendered) comments.set(comment.id, comment);
    for (const [id, label] of pinnedLabelsFromItems(items)) {
      const comment = comments.get(id);
      if (comment) comments.set(id, { ...comment, isPinned: true, pinnedLabel: label });
      else pinnedLabels.set(id, label);
    }
    walkCommentItems(
      list,
      byKey,
      isReply ? parentId ?? null : null,
      walked,
      replyTokens,
      comments,
      seenWalked,
      replyButtonCounts,
    );
    const seenRoot = new Set(orderedRootIds);
    const seenReply = new Set(orderedReplyIds);
    for (const entry of walked) {
      const isNestedReply = Boolean(entry.replyToId) || entry.id.includes('.');
      if (isNestedReply) {
        if (seenReply.has(entry.id)) continue;
        seenReply.add(entry.id);
        orderedReplyIds.push(entry.id);
      } else if (!seenRoot.has(entry.id)) {
        seenRoot.add(entry.id);
        orderedRootIds.push(entry.id);
      }
    }
    for (const id of orderedIdsFromItems(items)) {
      if (isReply && parentId && id !== parentId && !id.startsWith(`${parentId}.`)) continue;
      if (id.includes('.')) {
        if (seenReply.has(id)) continue;
        seenReply.add(id);
        orderedReplyIds.push(id);
      } else if (!seenRoot.has(id)) {
        seenRoot.add(id);
        orderedRootIds.push(id);
      }
    }
    for (const token of extractPageTokens(items, isReply)) {
      pushToken(pageTokens, token);
    }
  }

  for (const [id, label] of pinnedLabels) {
    const comment = comments.get(id);
    if (comment) comments.set(id, { ...comment, isPinned: true, pinnedLabel: label });
  }

  for (const entry of walked) {
    if (!entry.replyToId) continue;
    const comment = comments.get(entry.id);
    if (!comment) continue;
    comments.set(entry.id, {
      ...comment,
      parentId: comment.parentId || entry.replyToId,
      replyToId: entry.replyToId,
      isReply: true,
    });
  }

  if (parentId) {
    const prefix = `${parentId}.`;
    for (const [id, comment] of comments) {
      if (id === parentId || comment.parentId) continue;
      if (!id.startsWith(prefix)) continue;
      comments.set(id, { ...comment, parentId, isReply: true });
    }
    for (const token of pageTokens) {
      if (token.isReply && !token.parentId) token.parentId = parentId;
    }
    for (const token of replyTokens) {
      if (!token.parentId) token.parentId = parentId;
    }
  }

  return {
    comments: [...comments.values()],
    pageTokens,
    replyTokens,
    sortToken,
    totalCommentsLabel,
    orderedRootIds,
    orderedReplyIds,
    replyButtonCounts,
  };
}

// YouTube signs its own API calls with a hash of the SAPISID cookie. Without
// it the endpoint answers as though nobody is signed in, and "Top" comes back
// in the signed-out ranking instead of the one the page is showing. The hash
// is built and sent in the page, to the same origin the cookie belongs to,
// exactly as youtube.com does it.
let cachedAuthorization: { value: string; expiresAt: number } | null = null;
let authorizationRejected = false;

async function sapisidAuthorization(): Promise<string | null> {
  if (authorizationRejected) return null;
  if (cachedAuthorization && cachedAuthorization.expiresAt > Date.now()) {
    return cachedAuthorization.value;
  }

  try {
    const cookie = document.cookie.match(
      /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID|__Secure-1PAPISID)=([^;]+)/,
    );
    const sapisid = cookie?.[1];
    if (!sapisid || !crypto?.subtle) return null;

    const timestamp = Math.floor(Date.now() / 1000);
    const origin = window.location.origin;
    const digest = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(`${timestamp} ${sapisid} ${origin}`),
    );
    const hash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const value = `SAPISIDHASH ${timestamp}_${hash}`;
    cachedAuthorization = { value, expiresAt: Date.now() + 300_000 };
    return value;
  } catch {
    // Signing is best effort. Without it the thread still loads, just in the
    // signed-out ranking.
    return null;
  }
}

async function requestInnertube(
  context: InnertubeContext,
  body: Record<string, unknown>,
  clickTrackingParams?: string,
  authorize = true,
): Promise<Response> {
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

  // Newest is fetched unsigned. An authenticated Newest continuation is the
  // same call as picking "Newest" in the header, and YouTube saves it as the
  // sort used the next time the page loads.
  const authorization = authorize ? await sapisidAuthorization() : null;
  if (authorization) {
    headers.Authorization = authorization;
    headers['X-Origin'] = window.location.origin;
    headers['X-Goog-AuthUser'] = readString(getYtcfgValue('SESSION_INDEX')) || '0';
  }

  const send = () =>
    innertubeFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: authorize ? 'same-origin' : 'omit',
    });

  let response = await send();

  // If YouTube will not take the signature, fall back to unsigned requests for
  // the rest of the session rather than failing the load.
  if (response.status === 401 && authorization) {
    authorizationRejected = true;
    cachedAuthorization = null;
    delete headers.Authorization;
    delete headers['X-Origin'];
    delete headers['X-Goog-AuthUser'];
    response = await send();
  }

  return response;
}

async function fetchInnertube(
  context: InnertubeContext,
  body: Record<string, unknown>,
  clickTrackingParams?: string,
  authorize = true,
): Promise<unknown> {
  const response = await requestInnertube(context, body, clickTrackingParams, authorize);
  if (response.status === 429 || response.status === 403) {
    throw new InnertubeRateLimitError();
  }
  if (!response.ok) {
    throw new Error(`YouTube returned ${response.status} while loading comments.`);
  }
  return parseInnertubeText(await response.text());
}

export function parseInnertubeText(raw: string): unknown {
  return JSON.parse(raw.replace(/^\)\]\}'/, ''));
}

export function readInnertubeSession(): InnertubeSession {
  const context = getInnertubeContext();
  const client = asRecord(context.client);
  return {
    context,
    apiKey: readString(getYtcfgValue('INNERTUBE_API_KEY')),
    clientName: String(getYtcfgValue('INNERTUBE_CONTEXT_CLIENT_NAME') ?? '1'),
    clientVersion: String(getYtcfgValue('INNERTUBE_CLIENT_VERSION') ?? ''),
    visitorId: readString(getYtcfgValue('VISITOR_DATA'), client?.visitorData),
    sessionIndex: readString(getYtcfgValue('SESSION_INDEX')) || '0',
  };
}

export async function fetchContinuationText(
  token: string,
  clickTrackingParams?: string,
  authorize = true,
): Promise<string> {
  const response = await requestInnertube(
    getInnertubeContext(),
    { continuation: token },
    clickTrackingParams,
    authorize,
  );
  if (response.status === 429 || response.status === 403) {
    throw new InnertubeRateLimitError();
  }
  if (!response.ok) {
    throw new Error(`YouTube returned ${response.status} while loading comments.`);
  }
  return response.text();
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
    for (const token of extractPageTokens(items, false)) {
      pushToken(pageQueue, token);
    }
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
    // The comments header on the watch page is read separately.
  }

  return null;
}

function parseCompactCount(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.replace(/[,\s]/g, '').match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match?.[1]) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const suffix = (match[2] || '').toUpperCase();
  const scale =
    suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
  return Math.round(amount * scale);
}

function preferReplyTotal(
  previous: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const prev = parseCompactCount(previous);
  const next = parseCompactCount(incoming);
  if (prev == null) return incoming ?? previous ?? null;
  if (next == null || next < prev) return previous ?? null;
  return incoming ?? null;
}

async function pauseCrawl(ms: number, stillHere: () => boolean): Promise<void> {
  const step = 4_000;
  let left = ms;
  while (left > 0 && stillHere()) {
    const slice = Math.min(step, left);
    await new Promise((resolve) => setTimeout(resolve, slice));
    left -= slice;
    if (typeof document === 'undefined') {
      const runtime = (
        globalThis as {
          chrome?: { runtime?: { getPlatformInfo?: () => Promise<unknown> } };
        }
      ).chrome?.runtime;
      await runtime?.getPlatformInfo?.().catch(() => undefined);
    }
  }
}

interface HeldComment {
  replyToId: string | null;
  topRank: number | null;
  newestRank: number | null;
  replyRank: number | null;
  featured: boolean;
  featuredReplyCount: string | null;
  isPinned: boolean;
  pinnedLabel: string | null;
  likeCount: string | null;
  replyCount: string | null;
}

export async function fetchAllVideoComments(
  onProgress: (
    count: number,
    totalCommentsLabel?: string | null,
    added?: YouTubeComment[],
    patches?: CommentPatch[],
  ) => void | Promise<void>,
  maxComments = Number.POSITIVE_INFINITY,
  expectedVideoId?: string,
  isCancelled?: () => boolean,
  fetchPage?: ContinuationFetcher,
): Promise<{
  count: number;
  truncated: boolean;
  totalCommentsLabel: string | null;
}> {
  const videoId =
    expectedVideoId ||
    (typeof window === 'undefined' ? '' : getYouTubeVideoId(window.location.href) || '');
  if (!videoId) {
    throw new Error('Open a YouTube video first.');
  }

  const onPage = !fetchPage;
  const stillHere = () => {
    if (isCancelled?.()) return false;
    if (!onPage || typeof window === 'undefined') return true;
    return getYouTubeVideoId(window.location.href) === videoId;
  };

  if (onPage) {
    await waitForWatchId(videoId);
    if (!stillHere()) {
      return { count: 0, truncated: false, totalCommentsLabel: null };
    }
  }

  activeFetchVideoId = videoId;
  const commentCap = Math.min(
    Number.isFinite(maxComments) ? maxComments : CRAWL_COMMENT_FUSE,
    CRAWL_COMMENT_FUSE,
  );
  const held = new Map<string, HeldComment>();
  const seenTokens = new Set<string>();
  const queuedKeys = new Set<string>();
  const pageQueue: QueuedToken[] = [];
  const replyQueue: QueuedToken[] = [];
  const topReplySeen = new Map<string, number>();
  const topReplyCounted = new Set<string>();
  let totalCommentsLabel: string | null = null;
  let gaveUp = false;
  let rateStrikes = 0;
  let pausedUntil = 0;

  // Positions YouTube gave each comment, per order. Walking both listings is
  // the only way to reproduce "Top", and it also tells us which comments
  // YouTube's ranking leaves out.
  const topRanks = new Map<string, number>();
  const newestRanks = new Map<string, number>();
  // Reply order is recorded per listing. Top is what the page shows by
  // default, so it wins; Newest only places replies Top never returned.
  const topReplyRanks = new Map<string, number>();
  const newestReplyRanks = new Map<string, number>();
  // Every comment YouTube served through the Top listing, replies included.
  // Reply continuations carry the sort of the page they were found on, so the
  // Top chain returns the moderated set and the Newest chain returns the same
  // thread plus whatever YouTube keeps out of it.
  const featuredIds = new Set<string>();
  // Reply totals as the Top listing reports them, used to confirm we have the
  // whole moderated thread before hiding anything from it.
  const featuredReplyCounts = new Map<string, string>();
  const topReplyCursors = new Map<string, number>();
  const newestReplyCursors = new Map<string, number>();
  let topCursor = 0;
  let newestCursor = 0;

  // Nested replies share the root id before the dot, and the button total
  // counts them too. A cap stored on the root applies to every continuation
  // of that thread, including "View reply" pages.
  const replyRoot = (id: string | undefined): string => {
    if (!id) return '';
    return parentCommentId(id) || id;
  };

  const topReplyCapped = (parentId: string | undefined): boolean => {
    const root = replyRoot(parentId);
    if (!root) return false;
    const cap = parseCompactCount(featuredReplyCounts.get(root));
    if (cap == null) return false;
    return (topReplySeen.get(root) ?? 0) >= cap;
  };

  const noteTopReply = (id: string): void => {
    if (!id || topReplyCounted.has(id)) return;
    const root = parentCommentId(id);
    if (!root) return;
    topReplyCounted.add(id);
    topReplySeen.set(root, (topReplySeen.get(root) ?? 0) + 1);
  };

  const enqueue = (queue: QueuedToken[], next: QueuedToken | null): void => {
    if (!next?.token || next.token.length < 16) return;
    if (next.sort === 'top' && next.isReply && topReplyCapped(next.parentId)) return;
    const key = tokenChainKey(next);
    if (seenTokens.has(key) || queuedKeys.has(key)) return;
    queuedKeys.add(key);
    queue.push(next);
  };

  const requeue = (next: QueuedToken): void => {
    const key = tokenChainKey(next);
    seenTokens.delete(key);
    if (queuedKeys.has(key)) return;
    queuedKeys.add(key);
    const queue = next.isReply ? replyQueue : pageQueue;
    queue.unshift(next);
  };

  const take = (queue: QueuedToken[], index: number): QueuedToken | undefined => {
    const [next] = queue.splice(index, 1);
    if (next) queuedKeys.delete(tokenChainKey(next));
    return next;
  };

  for (const order of ['top', 'newest'] as const) {
    const generated = generateCommentContinuation(videoId, order);
    if (generated) {
      enqueue(pageQueue, { token: generated, isReply: false, sort: order });
    }
  }

  const rankPage = (
    order: CommentSortOrder | undefined,
    orderedRootIds: string[],
  ) => {
    if (!order) return;

    const ranks = order === 'newest' ? newestRanks : topRanks;
    for (const id of orderedRootIds) {
      if (ranks.has(id)) continue;
      ranks.set(id, order === 'newest' ? newestCursor++ : topCursor++);
    }
  };

  // Replies keep the order YouTube returns them in, including replies that
  // sit inside another reply. Pages for one thread are walked in sequence,
  // so a per-thread cursor stays in step with them.
  const rankReplies = (
    orderedReplyIds: string[],
    sort?: CommentSortOrder,
  ) => {
    const ranks = sort === 'newest' ? newestReplyRanks : topReplyRanks;
    const cursors = sort === 'newest' ? newestReplyCursors : topReplyCursors;
    for (const id of orderedReplyIds) {
      if (ranks.has(id)) continue;
      const separator = id.indexOf('.');
      const parent = separator > 0 ? id.slice(0, separator) : id;
      const cursor = cursors.get(parent) ?? 0;
      cursors.set(parent, cursor + 1);
      ranks.set(id, cursor);
    }
  };

  const heldFrom = (comment: YouTubeComment): HeldComment => ({
    replyToId: comment.replyToId ?? null,
    topRank: topRanks.get(comment.id) ?? null,
    newestRank: newestRanks.get(comment.id) ?? null,
    // Newest ranks are not the order behind the reply button. Leaving them
    // off replyRank keeps those replies behind the Top set when Hide spam
    // has to fill up to the button total.
    replyRank: topReplyRanks.get(comment.id) ?? null,
    featured: featuredIds.has(comment.id),
    featuredReplyCount: featuredReplyCounts.get(comment.id) ?? null,
    isPinned: comment.isPinned,
    pinnedLabel: comment.pinnedLabel ?? null,
    likeCount: comment.likeCount,
    replyCount: comment.replyCount,
  });

  const mergeHeld = (prev: HeldComment, comment: YouTubeComment): HeldComment => {
    const next = heldFrom(comment);
    return {
      replyToId: prev.replyToId || next.replyToId,
      topRank: next.topRank ?? prev.topRank,
      newestRank: next.newestRank ?? prev.newestRank,
      replyRank: next.replyRank ?? prev.replyRank,
      featured: prev.featured || next.featured,
      featuredReplyCount: preferReplyTotal(prev.featuredReplyCount, next.featuredReplyCount),
      isPinned: prev.isPinned || next.isPinned,
      pinnedLabel: next.pinnedLabel || prev.pinnedLabel,
      likeCount: next.likeCount ?? prev.likeCount,
      replyCount: next.replyCount ?? prev.replyCount,
    };
  };

  const materialize = (comment: YouTubeComment, state: HeldComment): YouTubeComment => ({
    ...comment,
    replyToId: state.replyToId,
    topRank: state.topRank,
    newestRank: state.newestRank,
    replyRank: state.replyRank,
    featured: state.featured,
    featuredReplyCount: state.featuredReplyCount,
    isPinned: state.isPinned,
    pinnedLabel: state.pinnedLabel,
    likeCount: state.likeCount,
    replyCount: state.replyCount,
  });

  const toPatch = (id: string, prev: HeldComment, next: HeldComment): CommentPatch | null => {
    const patch: CommentPatch = { id };
    let changed = false;
    const assign = <K extends keyof HeldComment>(key: K) => {
      if (prev[key] === next[key]) return;
      patch[key] = next[key] as never;
      changed = true;
    };
    assign('topRank');
    assign('newestRank');
    assign('replyRank');
    assign('featured');
    assign('featuredReplyCount');
    assign('replyToId');
    assign('isPinned');
    assign('pinnedLabel');
    assign('likeCount');
    assign('replyCount');
    return changed ? patch : null;
  };

  if (pageQueue.length === 0 && replyQueue.length === 0) {
    throw new Error(
      'Could not find YouTube comment data. Refresh the video page, then try again.',
    );
  }

  await onProgress(held.size, totalCommentsLabel);

  let pages = 0;

  const fetchToken = async (next: QueuedToken): Promise<void> => {
    if (!stillHere() || gaveUp || held.size >= commentCap || pages >= CRAWL_PAGE_FUSE) {
      return;
    }
    const key = tokenChainKey(next);
    if (seenTokens.has(key)) return;
    seenTokens.add(key);

    const wait = pausedUntil - Date.now();
    if (wait > 0) await pauseCrawl(wait, stillHere);
    if (!stillHere() || gaveUp) return;

    let data: unknown;
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      data = fetchPage
        ? await fetchPage(next.token, next.clickTrackingParams, next.sort)
        : await fetchInnertube(
            getInnertubeContext(),
            { continuation: next.token },
            next.clickTrackingParams,
            next.sort !== 'newest',
          );
    } catch (error) {
      if (error instanceof InnertubeRateLimitError) {
        // Several pages can fail together. Count that as one pause, or a
        // short burst of 429s ends the crawl while comments are still arriving.
        const alreadyPausing = pausedUntil > Date.now();
        if (!alreadyPausing) {
          rateStrikes += 1;
          if (rateStrikes > RATE_LIMIT_ATTEMPTS) {
            gaveUp = true;
            return;
          }
        }
        const delay = Math.min(8_000, 1_000 * 2 ** Math.min(rateStrikes, 3));
        pausedUntil = Math.max(pausedUntil, Date.now() + delay);
        requeue(next);
        await pauseCrawl(Math.max(0, pausedUntil - Date.now()), stillHere);
        return;
      }
      if ((next.attempt ?? 0) < 1) {
        requeue({ ...next, attempt: (next.attempt ?? 0) + 1 });
      }
      return;
    }

    if (!stillHere()) return;
    rateStrikes = Math.max(0, rateStrikes - 1);
    pages += 1;

    let parsed: ReturnType<typeof parseNextResponse>;
    try {
      activeFetchVideoId = videoId;
      parsed = parseNextResponse(
        data,
        next.isReply,
        next.parentId,
        !next.isReply && !totalCommentsLabel,
      );
    } catch {
      return;
    }

    if (!totalCommentsLabel && parsed.totalCommentsLabel) {
      totalCommentsLabel = parsed.totalCommentsLabel;
    }

    rankPage(next.sort, parsed.orderedRootIds);
    if (parsed.orderedReplyIds.length > 0) {
      rankReplies(parsed.orderedReplyIds, next.sort);
    }

    // Only comments YouTube actually rendered on this Top page. The entity
    // batch also carries replies that are not part of that listing, and
    // marking those featured makes Hide spam keep comments the page hides.
    if (next.sort === 'top') {
      const rendered = new Set<string>([
        ...parsed.orderedRootIds,
        ...parsed.orderedReplyIds,
      ]);
      if (rendered.size === 0) {
        for (const comment of parsed.comments) {
          if (!comment.isReply) rendered.add(comment.id);
        }
      }
      for (const id of rendered) featuredIds.add(id);
      for (const [id, count] of parsed.replyButtonCounts) {
        const nextCount = parseCompactCount(count);
        const prevCount = parseCompactCount(featuredReplyCounts.get(id));
        if (prevCount == null || (nextCount != null && nextCount > prevCount)) {
          featuredReplyCounts.set(id, count);
        }
      }
    }

    if (next.sort === 'top') {
      // Only replies YouTube actually listed. The entity batch on a reply
      // page also carries comments the button does not count; counting those
      // hits the cap early and the rest of the public thread never loads.
      const pageRoot = next.isReply ? replyRoot(next.parentId) : '';
      for (const id of parsed.orderedReplyIds) {
        const root = parentCommentId(id);
        if (!root) continue;
        if (pageRoot && root !== pageRoot) continue;
        noteTopReply(id);
      }
    }

    const added: YouTubeComment[] = [];
    const patches: CommentPatch[] = [];
    for (const comment of parsed.comments) {
      const previous = held.get(comment.id);
      if (previous) {
        const merged = mergeHeld(previous, comment);
        const patch = toPatch(comment.id, previous, merged);
        held.set(comment.id, merged);
        if (patch) patches.push(patch);
        continue;
      }
      if (held.size >= commentCap) break;
      const state = heldFrom(comment);
      held.set(comment.id, state);
      added.push(materialize(comment, state));
    }

    const stopTopReplies =
      next.sort === 'top' && next.isReply && topReplyCapped(next.parentId);
    // Nested "View reply" continuations sit inside this page's button total,
    // so they are walked before the next page of the same thread.
    const continuations = next.isReply
      ? [...parsed.replyTokens, ...(stopTopReplies ? [] : parsed.pageTokens)]
      : [...(stopTopReplies ? [] : parsed.pageTokens), ...parsed.replyTokens];
    for (const token of continuations) {
      const tagged = next.sort ? { ...token, sort: next.sort } : token;
      enqueue(tagged.isReply ? replyQueue : pageQueue, tagged);
    }

    if (added.length > 0 || patches.length > 0 || parsed.totalCommentsLabel) {
      await onProgress(held.size, totalCommentsLabel, added, patches);
    }
  };

  const canContinue = () =>
    held.size < commentCap &&
    pages < CRAWL_PAGE_FUSE &&
    !gaveUp &&
    stillHere();

  let pageActive = 0;
  let replyActive = 0;
  const chainActive = new Map<string, number>();
  const replyChainActive = new Map<string, number>();
  const running = new Set<Promise<void>>();
  const chainOf = (next: QueuedToken) => next.sort ?? 'unsorted';
  const replyChainOf = (next: QueuedToken) => replyRoot(next.parentId) || next.parentId || next.token;

  const startToken = (next: QueuedToken, kind: 'page' | 'reply') => {
    if (kind === 'page') {
      pageActive += 1;
      chainActive.set(chainOf(next), (chainActive.get(chainOf(next)) ?? 0) + 1);
    } else {
      replyActive += 1;
      const chain = replyChainOf(next);
      replyChainActive.set(chain, (replyChainActive.get(chain) ?? 0) + 1);
    }

    const task = fetchToken(next).finally(() => {
      if (kind === 'page') {
        pageActive -= 1;
        chainActive.set(chainOf(next), (chainActive.get(chainOf(next)) ?? 1) - 1);
      } else {
        replyActive -= 1;
        const chain = replyChainOf(next);
        replyChainActive.set(chain, (replyChainActive.get(chain) ?? 1) - 1);
      }
      running.delete(task);
    });
    running.add(task);
  };

  const pump = () => {
    // One page at a time per sort chain. Pages have to be walked in sequence
    // for the recorded positions to stay in YouTube's order, and it keeps both
    // orders advancing together instead of one starving the other.
    while (pageActive < PAGE_CONCURRENCY && pageQueue.length > 0 && canContinue()) {
      const index = pageQueue.findIndex(
        (item) => (chainActive.get(chainOf(item)) ?? 0) === 0,
      );
      if (index === -1) break;

      const next = take(pageQueue, index);
      if (!next) break;
      startToken(next, 'page');
    }

    while (
      replyActive < REPLY_CONCURRENCY &&
      replyQueue.length > 0 &&
      canContinue()
    ) {
      // One page at a time for a thread, in the order the tokens were queued,
      // so the reply ranks stay in YouTube's order. A Top token queued before
      // the button total was reached is dropped once that total is in.
      const index = replyQueue.findIndex(
        (item) => (replyChainActive.get(replyChainOf(item)) ?? 0) === 0,
      );
      if (index === -1) break;
      const next = take(replyQueue, index);
      if (!next) break;
      if (next.sort === 'top' && next.isReply && topReplyCapped(next.parentId)) continue;
      startToken(next, 'reply');
    }
  };

  pump();
  while (running.size > 0) {
    await Promise.race(running);
    pump();
  }

  if (gaveUp && held.size === 0) {
    throw new InnertubeRateLimitError();
  }

  const hitFuse = held.size >= commentCap || pages >= CRAWL_PAGE_FUSE;
  return {
    count: held.size,
    truncated: gaveUp || hitFuse || pageQueue.length > 0 || replyQueue.length > 0,
    totalCommentsLabel,
  };
}
