import {
  MAX_FETCHED_COMMENTS,
  canonicalYouTubeCommentId,
  getYouTubeVideoId,
  type CommentSortOrder,
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

const MAX_CONTINUATION_PAGES = 2_000;
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
  parentId?: string;
  // Set on top-level pages so every comment on the page can be given the
  // position YouTube gave it in that order.
  sort?: CommentSortOrder;
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
  comments?: YouTubeComment[];
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
  const parentId =
    readString(properties?.parentCommentId, payload.parentCommentId) ||
    dottedParent ||
    (inheritedParentId && inheritedParentId !== id ? inheritedParentId : '');
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
): {
  comments: YouTubeComment[];
  pageTokens: QueuedToken[];
  replyTokens: QueuedToken[];
  sortToken: QueuedToken | null;
  totalCommentsLabel: string | null;
  orderedRootIds: string[];
  orderedReplyIds: string[];
} {
  const comments = new Map<string, YouTubeComment>(
    parseEntities(data, isReply, parentId),
  );
  const pageTokens: QueuedToken[] = [];
  const replyTokens: QueuedToken[] = [];
  const orderedRootIds: string[] = [];
  const orderedReplyIds: string[] = [];
  const pinnedLabels = new Map<string, string>();
  let sortToken = extractSortToken(data);
  let totalCommentsLabel = extractCommentsCountLabel(data);

  for (const list of continuationLists(data)) {
    const items = flattenItems(list);
    const rendered = commentsFromItems(items, isReply);
    const headerToken = extractSortToken(items);

    if (headerToken) sortToken = headerToken;
    for (const comment of rendered) comments.set(comment.id, comment);
    for (const [id, label] of pinnedLabelsFromItems(items)) {
      const comment = comments.get(id);
      if (comment) comments.set(id, { ...comment, isPinned: true, pinnedLabel: label });
      else pinnedLabels.set(id, label);
    }
    for (const id of orderedIdsFromItems(items)) {
      if (id.includes('.')) orderedReplyIds.push(id);
      else orderedRootIds.push(id);
    }
    collectReplyTokens(items, replyTokens);
    for (const token of extractPageTokens(items, isReply)) {
      pushToken(pageTokens, token);
    }
  }

  for (const [id, label] of pinnedLabels) {
    const comment = comments.get(id);
    if (comment) comments.set(id, { ...comment, isPinned: true, pinnedLabel: label });
  }

  if (parentId) {
    for (const [id, comment] of comments) {
      if (id === parentId || comment.parentId) continue;
      comments.set(id, { ...comment, parentId, isReply: true });
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

  const authorization = await sapisidAuthorization();
  if (authorization) {
    headers.Authorization = authorization;
    headers['X-Origin'] = window.location.origin;
    headers['X-Goog-AuthUser'] = readString(getYtcfgValue('SESSION_INDEX')) || '0';
  }

  const send = () =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: 'same-origin',
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
    // Fall through to the comments continuation, which has the header count.
  }

  const generated = generateCommentContinuation(videoId, 'newest');
  if (!generated) return null;

  const data = await fetchInnertube(context, { continuation: generated });
  if (isCancelled?.() || getYouTubeVideoId(window.location.href) !== videoId) {
    return null;
  }

  return parseNextResponse(data, false).totalCommentsLabel;
}

export async function fetchAllVideoComments(
  onProgress: (
    count: number,
    totalCommentsLabel?: string | null,
    added?: YouTubeComment[],
  ) => void,
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

  // Positions YouTube gave each comment, per order. Walking both listings is
  // the only way to reproduce "Top", and it also tells us which comments
  // YouTube's ranking leaves out.
  const topRanks = new Map<string, number>();
  const newestRanks = new Map<string, number>();
  const replyRanks = new Map<string, number>();
  // Every comment YouTube served through the Top listing, replies included.
  // Reply continuations carry the sort of the page they were found on, so the
  // Top chain returns the moderated set and the Newest chain returns the same
  // thread plus whatever YouTube keeps out of it.
  const featuredIds = new Set<string>();
  // Reply totals as the Top listing reports them, used to confirm we have the
  // whole moderated thread before hiding anything from it.
  const featuredReplyCounts = new Map<string, string>();
  const replyCursors = new Map<string, number>();
  let topCursor = 0;
  let newestCursor = 0;

  for (const order of ['top', 'newest'] as const) {
    const generated = generateCommentContinuation(videoId, order);
    if (generated) {
      pushToken(pageQueue, { token: generated, isReply: false, sort: order });
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

  // Replies keep the order YouTube returns them in. Pages for one thread are
  // walked in sequence, so a per-thread cursor stays in step with them.
  const rankReplies = (orderedReplyIds: string[]) => {
    for (const id of orderedReplyIds) {
      if (replyRanks.has(id)) continue;
      const parent = id.slice(0, id.indexOf('.'));
      const cursor = replyCursors.get(parent) ?? 0;
      replyCursors.set(parent, cursor + 1);
      replyRanks.set(id, cursor);
    }
  };

  const withRanks = (comment: YouTubeComment): YouTubeComment => ({
    ...comment,
    topRank: topRanks.get(comment.id) ?? comment.topRank ?? null,
    newestRank: newestRanks.get(comment.id) ?? comment.newestRank ?? null,
    replyRank: replyRanks.get(comment.id) ?? comment.replyRank ?? null,
    featured: featuredIds.has(comment.id) || comment.featured === true,
    featuredReplyCount:
      featuredReplyCounts.get(comment.id) ?? comment.featuredReplyCount ?? null,
  });

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
    if (seenTokens.has(tokenChainKey(next)) || collected.size >= maxComments) return;
    if (pages >= MAX_CONTINUATION_PAGES || rateLimited) return;
    seenTokens.add(tokenChainKey(next));
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
      const parsed = parseNextResponse(data, next.isReply, next.parentId);
      if (!totalCommentsLabel && parsed.totalCommentsLabel) {
        totalCommentsLabel = parsed.totalCommentsLabel;
      }

      rankPage(next.sort, parsed.orderedRootIds);
      if (next.isReply) rankReplies(parsed.orderedReplyIds);

      // Everything this page carried is part of the listing it came from.
      if (next.sort === 'top') {
        for (const comment of parsed.comments) {
          featuredIds.add(comment.id);
          if (!comment.isReply && comment.replyCount) {
            featuredReplyCounts.set(comment.id, comment.replyCount);
          }
        }
      }

      const added: YouTubeComment[] = [];
      for (const comment of parsed.comments) {
        if (collected.size >= maxComments) break;
        if (collected.has(comment.id)) {
          collected.set(comment.id, comment);
          continue;
        }
        collected.set(comment.id, comment);
        added.push(comment);
      }

      // A page's own continuation stays inside the same sort chain, so the
      // ranking cursor keeps counting in YouTube's order.
      for (const token of parsed.pageTokens) {
        const tagged = next.sort ? { ...token, sort: next.sort } : token;
        if (tagged.isReply) replyQueue.push(tagged);
        else pageQueue.push(tagged);
      }
      for (const token of parsed.replyTokens) {
        replyQueue.push(next.sort ? { ...token, sort: next.sort } : token);
      }
      onProgress(collected.size, totalCommentsLabel, added.map(withRanks));
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
  const chainActive = new Map<string, number>();
  const running = new Set<Promise<void>>();
  const chainOf = (next: QueuedToken) => next.sort ?? 'unsorted';

  const startToken = (next: QueuedToken, kind: 'page' | 'reply') => {
    if (kind === 'page') {
      pageActive += 1;
      chainActive.set(chainOf(next), (chainActive.get(chainOf(next)) ?? 0) + 1);
    } else {
      replyActive += 1;
    }

    const task = fetchToken(next).finally(() => {
      if (kind === 'page') {
        pageActive -= 1;
        chainActive.set(chainOf(next), (chainActive.get(chainOf(next)) ?? 1) - 1);
      } else {
        replyActive -= 1;
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

      const [next] = pageQueue.splice(index, 1);
      if (!next) break;
      startToken(next, 'page');
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
    comments: [...collected.values()].map(withRanks),
    truncated:
      rateLimited ||
      pageQueue.length > 0 ||
      replyQueue.length > 0 ||
      pages >= MAX_CONTINUATION_PAGES ||
      collected.size >= maxComments,
    totalCommentsLabel,
  };
}
