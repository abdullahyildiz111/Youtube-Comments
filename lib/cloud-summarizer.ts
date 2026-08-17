import type { YouTubeComment } from '@/lib/comments';

const LOCAL_API_URL = 'http://localhost:3000/summarize';
const REQUEST_TIMEOUT_MS = 60_000;

interface SummaryApiResponse {
  summary?: string;
  commentCount?: number;
  model?: string;
  error?: string;
}

export interface CloudSummary {
  text: string;
  commentCount: number;
  model: string;
}

export class SummaryBackendNotConfiguredError extends Error {
  constructor() {
    super('The summary backend URL is not configured.');
    this.name = 'SummaryBackendNotConfiguredError';
  }
}

function getSummaryApiUrl(): string {
  const configuredUrl = import.meta.env.WXT_SUMMARY_API_URL?.trim();
  const rawUrl = configuredUrl || (import.meta.env.DEV ? LOCAL_API_URL : '');

  if (!rawUrl) throw new SummaryBackendNotConfiguredError();

  try {
    const url = new URL(rawUrl);
    if (url.pathname === '/') url.pathname = '/summarize';
    return url.href;
  } catch {
    throw new SummaryBackendNotConfiguredError();
  }
}

export async function summarizeCommentsInCloud(
  comments: YouTubeComment[],
  videoId: string,
  videoTitle: string,
): Promise<CloudSummary> {
  if (comments.length === 0) {
    throw new Error('There are no captured comments to summarize.');
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const apiToken = import.meta.env.WXT_SUMMARY_API_TOKEN?.trim();
    if (apiToken) {
      headers.Authorization = `Bearer ${apiToken}`;
    }

    const response = await fetch(getSummaryApiUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        videoId,
        videoTitle,
        comments: comments.map((comment) => ({
          text: comment.text,
          isReply: comment.isReply,
        })),
      }),
      signal: controller.signal,
    });

    let payload: SummaryApiResponse = {};
    try {
      payload = (await response.json()) as SummaryApiResponse;
    } catch {
      // The status-specific message below is more useful than a JSON error.
    }

    if (!response.ok) {
      throw new CloudSummaryRequestError(
        response.status,
        payload.error || 'The summary service returned an error.',
      );
    }

    if (
      typeof payload.summary !== 'string' ||
      !payload.summary.trim() ||
      typeof payload.commentCount !== 'number'
    ) {
      throw new Error('The summary service returned an invalid response.');
    }

    return {
      text: payload.summary.trim(),
      commentCount: payload.commentCount,
      model: payload.model || 'Gemini Flash-Lite',
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

class CloudSummaryRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CloudSummaryRequestError';
  }
}

export function getCloudSummaryErrorMessage(error: unknown): string {
  if (error instanceof SummaryBackendNotConfiguredError) {
    return 'The cloud summary service is not configured. Set WXT_SUMMARY_API_URL to your Coolify backend and rebuild the extension.';
  }

  if (error instanceof CloudSummaryRequestError) {
    if (error.status === 401) {
      return 'The summary backend rejected this extension. Check WXT_SUMMARY_API_TOKEN.';
    }

    if (error.status === 429) {
      return 'The free AI service is busy or rate-limited. Please wait a minute and try again.';
    }

    if (error.status === 413) {
      return 'The captured comments are too large for one summary request.';
    }

    return error.message;
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The cloud AI took too long to respond. Please try again.';
  }

  if (error instanceof TypeError) {
    return 'The summary backend could not be reached. Check its URL and your internet connection.';
  }

  return error instanceof Error
    ? error.message
    : 'The comments could not be summarized.';
}
