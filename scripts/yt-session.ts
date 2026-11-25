// Minimal signed-out WEB innertube session for running the crawler outside a
// browser. Only used by the verification scripts.

import { InnertubeRateLimitError } from '../lib/innertube-comments.ts';

export interface NodeSession {
  apiKey: string;
  clientVersion: string;
  visitorData: string;
  initialData: unknown;
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function extractJsonAfter(html: string, marker: string): unknown {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let index = html.indexOf('{', start);
  const begin = index;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(begin, index + 1));
    }
  }
  return null;
}

export async function openSession(videoId: string, hl = 'en'): Promise<NodeSession> {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=${hl}&persist_hl=1`, {
    headers: { 'User-Agent': UA, 'Accept-Language': `${hl},en;q=0.8` },
  });
  if (!response.ok) throw new Error(`watch page returned ${response.status}`);
  const html = await response.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? '';
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? '';
  const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] ?? '';
  if (!clientVersion) throw new Error('watch page had no INNERTUBE_CLIENT_VERSION (consent wall?)');
  return {
    apiKey,
    clientVersion,
    visitorData,
    initialData: extractJsonAfter(html, 'var ytInitialData = '),
  };
}

// Requests are spaced out because a burst from one IP gets it blocked
// ("Sorry..." page on every endpoint) for a long while. About 3,500 requests
// in 25 minutes at 150ms spacing was enough to trigger it.
export function makeNext(
  session: NodeSession,
  hl = 'en',
  minIntervalMs = 400,
  gl = 'US',
) {
  let requests = 0;
  let refused = 0;
  let nextSlot = 0;
  const next = async (body: Record<string, unknown>): Promise<unknown> => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + minIntervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
    const url = new URL('https://www.youtube.com/youtubei/v1/next');
    url.searchParams.set('prettyPrint', 'false');
    if (session.apiKey) url.searchParams.set('key', session.apiKey);
    for (let attempt = 0; ; attempt += 1) {
      requests += 1;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': session.clientVersion,
          'X-Goog-Visitor-Id': session.visitorData,
          Origin: 'https://www.youtube.com',
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: session.clientVersion,
              hl,
              gl,
              visitorData: session.visitorData,
            },
          },
          ...body,
        }),
      });
      if (response.status === 429 || response.status === 403) {
        refused += 1;
        if (refused === 1 || refused % 10 === 0) {
          const sorry = (await response.clone().text()).includes('<title>Sorry...</title>');
          console.error(
            `${new Date().toISOString()} next ${response.status}${sorry ? ' "Sorry..." page' : ''} after ${requests} requests (${refused} refused)`,
          );
        }
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 6) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
        continue;
      }
      if (response.status === 429 || response.status === 403) throw new InnertubeRateLimitError();
      if (!response.ok) throw new Error(`next returned ${response.status}`);
      return JSON.parse((await response.text()).replace(/^\)\]\}'/, ''));
    }
  };
  return { next, requestCount: () => requests };
}
