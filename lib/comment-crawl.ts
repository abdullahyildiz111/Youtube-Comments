import {
  CRAWL_MESSAGES,
  type CommentPatch,
  type CommentSortOrder,
  type YouTubeComment,
} from '@/lib/comments';
import {
  fetchAllVideoComments,
  InnertubeRateLimitError,
  parseInnertubeText,
  type InnertubeSession,
} from '@/lib/innertube-comments';

class InnertubeAuthError extends Error {
  constructor() {
    super('YouTube rejected the extension request.');
    this.name = 'InnertubeAuthError';
  }
}

let cachedAuthorization: { value: string; expiresAt: number } | null = null;

async function extensionAuthorization(): Promise<string | null> {
  if (cachedAuthorization && cachedAuthorization.expiresAt > Date.now()) {
    return cachedAuthorization.value;
  }

  const names = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'] as const;
  let sapisid = '';
  for (const name of names) {
    const cookie = await browser.cookies.get({
      url: 'https://www.youtube.com/',
      name,
    });
    if (cookie?.value) {
      sapisid = cookie.value;
      break;
    }
  }
  if (!sapisid || !crypto?.subtle) return null;

  const timestamp = Math.floor(Date.now() / 1000);
  const origin = 'https://www.youtube.com';
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${timestamp} ${sapisid} ${origin}`),
  );
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const value = `SAPISIDHASH ${timestamp}_${hash}`;
  cachedAuthorization = { value, expiresAt: Date.now() + 240_000 };
  return value;
}

async function fetchContinuationFromExtension(
  session: InnertubeSession,
  token: string,
  clickTrackingParams?: string,
  sort?: CommentSortOrder,
): Promise<unknown> {
  const url = new URL('https://www.youtube.com/youtubei/v1/next');
  url.searchParams.set('prettyPrint', 'false');
  if (session.apiKey) url.searchParams.set('key', session.apiKey);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-YouTube-Client-Name': session.clientName,
    'X-YouTube-Client-Version': session.clientVersion,
    'X-Origin': 'https://www.youtube.com',
    'X-Goog-AuthUser': session.sessionIndex || '0',
  };
  if (session.visitorId) headers['X-Goog-Visitor-Id'] = session.visitorId;
  // An authenticated Newest continuation is what the sort menu sends, and
  // YouTube then keeps Newest selected after a refresh.
  const authorize = sort !== 'newest';
  const authorization = authorize ? await extensionAuthorization() : null;
  if (authorization) headers.Authorization = authorization;

  const payload: Record<string, unknown> = {
    context: session.context,
    continuation: token,
  };
  if (clickTrackingParams) payload.clickTracking = { clickTrackingParams };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    credentials: authorize ? 'include' : 'omit',
  });

  if (response.status === 401) {
    if (authorize) throw new InnertubeAuthError();
    throw new Error('YouTube returned 401 while loading comments.');
  }
  if (response.status === 429 || response.status === 403) throw new InnertubeRateLimitError();
  if (!response.ok) {
    throw new Error(`YouTube returned ${response.status} while loading comments.`);
  }
  return parseInnertubeText(await response.text());
}

interface CrawlJob {
  requestId: string;
  cancelled: boolean;
  usePage: boolean;
}

const jobs = new Map<number, CrawlJob>();
const ORIGIN_RULE_ID = 1;

export interface CrawlRunResult {
  ok: boolean;
  count: number;
  truncated: boolean;
  totalCommentsLabel: string | null;
  error?: string;
}

export function cancelCommentCrawl(tabId: number, requestId?: string): void {
  const job = jobs.get(tabId);
  if (!job) return;
  if (!requestId || job.requestId === requestId) job.cancelled = true;
}

export async function ensureYoutubeRequestHeaders(): Promise<void> {
  const rules = browser.declarativeNetRequest;
  if (!rules?.updateDynamicRules) return;
  await rules.updateDynamicRules({
    removeRuleIds: [ORIGIN_RULE_ID],
    addRules: [
      {
        id: ORIGIN_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'origin', operation: 'set', value: 'https://www.youtube.com' },
            { header: 'referer', operation: 'set', value: 'https://www.youtube.com/' },
          ],
        },
        condition: {
          initiatorDomains: [browser.runtime.id],
          urlFilter: '||youtube.com/youtubei/',
          resourceTypes: ['xmlhttprequest', 'other'],
          requestMethods: ['post'],
        },
      },
    ],
  });
}

async function fetchContinuationFromPage(
  tabId: number,
  requestId: string,
  token: string,
  clickTrackingParams?: string,
  sort?: CommentSortOrder,
): Promise<unknown> {
  const response = (await browser.tabs.sendMessage(
    tabId,
    {
      type: CRAWL_MESSAGES.pageFetch,
      requestId,
      token,
      clickTrackingParams,
      // Newest must stay unsigned so YouTube does not save it as the page sort.
      authorize: sort !== 'newest',
    },
    { frameId: 0 },
  )) as { body?: string; error?: string; rateLimited?: boolean } | undefined;

  if (response?.rateLimited) throw new InnertubeRateLimitError();
  if (!response?.body) {
    throw new Error(response?.error || 'The YouTube tab could not load the next comment page.');
  }
  return parseInnertubeText(response.body);
}

export async function runCommentCrawl(options: {
  tabId: number;
  requestId: string;
  videoId: string;
  session: InnertubeSession;
}): Promise<CrawlRunResult> {
  const previous = jobs.get(options.tabId);
  if (previous) previous.cancelled = true;
  const job: CrawlJob = {
    requestId: options.requestId,
    cancelled: false,
    usePage: false,
  };
  jobs.set(options.tabId, job);

  const cancelled = () => job.cancelled || jobs.get(options.tabId) !== job;

  try {
    await ensureYoutubeRequestHeaders().catch(() => undefined);
    const result = await fetchAllVideoComments(
      async (count, totalCommentsLabel, added, patches) => {
        if (cancelled()) return;
        const message: {
          type: typeof CRAWL_MESSAGES.batch;
          requestId: string;
          videoId: string;
          count: number;
          totalCommentsLabel?: string | null;
          comments?: YouTubeComment[];
          patches?: CommentPatch[];
        } = {
          type: CRAWL_MESSAGES.batch,
          requestId: options.requestId,
          videoId: options.videoId,
          count,
          totalCommentsLabel,
          comments: added && added.length > 0 ? added : undefined,
          patches: patches && patches.length > 0 ? patches : undefined,
        };
        await browser.tabs.sendMessage(options.tabId, message, { frameId: 0 });
      },
      undefined,
      options.videoId,
      cancelled,
      async (token, clickTrackingParams, sort) => {
        if (!job.usePage) {
          try {
            return await fetchContinuationFromExtension(
              options.session,
              token,
              clickTrackingParams,
              sort,
            );
          } catch (error) {
            if (!(error instanceof InnertubeAuthError)) throw error;
            job.usePage = true;
          }
        }
        return fetchContinuationFromPage(
          options.tabId,
          options.requestId,
          token,
          clickTrackingParams,
          sort,
        );
      },
    );

    return {
      ok: true,
      count: result.count,
      truncated: result.truncated,
      totalCommentsLabel: result.totalCommentsLabel,
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      truncated: false,
      totalCommentsLabel: null,
      error:
        error instanceof Error ? error.message : 'Failed to load comments from YouTube.',
    };
  } finally {
    if (jobs.get(options.tabId) === job) jobs.delete(options.tabId);
  }
}
