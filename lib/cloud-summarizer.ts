import type { YouTubeComment } from '@/lib/comments';

const LOCAL_API_ORIGIN = 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 180_000;

export const SUMMARIZE_MESSAGE = 'comment-catcher:summarize' as const;
export const CHAT_MESSAGE = 'comment-catcher:chat' as const;

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

export interface SummarizeRequest {
  type: typeof SUMMARIZE_MESSAGE;
  videoId: string;
  videoTitle: string;
  comments: Array<{ text: string; isReply: boolean }>;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatRequest {
  type: typeof CHAT_MESSAGE;
  videoId: string;
  videoTitle: string;
  question: string;
  history: ChatTurn[];
  comments: Array<{ text: string; isReply: boolean }>;
}

export interface CloudChatAnswer {
  text: string;
  commentCount: number;
  model: string;
}

type SummarizeResponse =
  | { ok: true; summary: CloudSummary }
  | {
      ok: false;
      errorMessage: string;
      errorName?: string;
      status?: number;
    };

export class SummaryBackendNotConfiguredError extends Error {
  constructor() {
    super('The summary backend URL is not configured.');
    this.name = 'SummaryBackendNotConfiguredError';
  }
}

export class CloudSummaryRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CloudSummaryRequestError';
  }
}

function getBackendUrl(path: '/summarize' | '/chat'): string {
  const configuredUrl = import.meta.env.WXT_SUMMARY_API_URL?.trim();
  const rawUrl = configuredUrl || (import.meta.env.DEV ? LOCAL_API_ORIGIN : '');

  if (!rawUrl) throw new SummaryBackendNotConfiguredError();

  try {
    const url = new URL(rawUrl);
    if (
      url.pathname === '/' ||
      url.pathname === '/summarize' ||
      url.pathname === '/chat'
    ) {
      url.pathname = path;
    } else {
      url.pathname = path;
    }
    return url.href;
  } catch {
    throw new SummaryBackendNotConfiguredError();
  }
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiToken = import.meta.env.WXT_SUMMARY_API_TOKEN?.trim();
  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`;
  }
  return headers;
}

export async function performSummaryFetch(
  comments: Array<{ text: string; isReply: boolean }>,
  videoId: string,
  videoTitle: string,
): Promise<CloudSummary> {
  if (comments.length === 0) {
    throw new Error('There are no captured comments to summarize.');
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(getBackendUrl('/summarize'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        videoId,
        videoTitle,
        comments,
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
    globalThis.clearTimeout(timeout);
  }
}

export async function summarizeCommentsInCloud(
  comments: YouTubeComment[],
  videoId: string,
  videoTitle: string,
): Promise<CloudSummary> {
  const request: SummarizeRequest = {
    type: SUMMARIZE_MESSAGE,
    videoId,
    videoTitle,
    comments: comments.map((comment) => ({
      text: comment.text,
      isReply: comment.isReply,
    })),
  };

  const response = (await browser.runtime.sendMessage(
    request,
  )) as SummarizeResponse | undefined;

  if (!response) {
    throw new TypeError('The summary backend could not be reached.');
  }

  if (response.ok) return response.summary;

  if (response.errorName === 'SummaryBackendNotConfiguredError') {
    throw new SummaryBackendNotConfiguredError();
  }

  if (typeof response.status === 'number') {
    throw new CloudSummaryRequestError(response.status, response.errorMessage);
  }

  if (response.errorName === 'AbortError') {
    const error = new DOMException(response.errorMessage, 'AbortError');
    throw error;
  }

  throw new Error(response.errorMessage);
}

interface ChatApiResponse {
  answer?: string;
  commentCount?: number;
  model?: string;
  error?: string;
}

type ChatResponse =
  | { ok: true; answer: CloudChatAnswer }
  | {
      ok: false;
      errorMessage: string;
      errorName?: string;
      status?: number;
    };

export async function performChatFetch(
  comments: Array<{ text: string; isReply: boolean }>,
  videoId: string,
  videoTitle: string,
  question: string,
  history: ChatTurn[],
): Promise<CloudChatAnswer> {
  if (comments.length === 0) {
    throw new Error('There are no captured comments to ask about.');
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(getBackendUrl('/chat'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        videoId,
        videoTitle,
        question,
        history,
        comments,
      }),
      signal: controller.signal,
    });

    let payload: ChatApiResponse = {};
    try {
      payload = (await response.json()) as ChatApiResponse;
    } catch {
      // The status-specific message below is more useful than a JSON error.
    }

    if (!response.ok) {
      throw new CloudSummaryRequestError(
        response.status,
        payload.error || 'The chat service returned an error.',
      );
    }

    if (
      typeof payload.answer !== 'string' ||
      !payload.answer.trim() ||
      typeof payload.commentCount !== 'number'
    ) {
      throw new Error('The chat service returned an invalid response.');
    }

    return {
      text: payload.answer.trim(),
      commentCount: payload.commentCount,
      model: payload.model || 'Gemini Flash-Lite',
    };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function askCommentsInCloud(
  comments: YouTubeComment[],
  videoId: string,
  videoTitle: string,
  question: string,
  history: ChatTurn[],
): Promise<CloudChatAnswer> {
  const request: ChatRequest = {
    type: CHAT_MESSAGE,
    videoId,
    videoTitle,
    question,
    history,
    comments: comments.map((comment) => ({
      text: comment.text,
      isReply: comment.isReply,
    })),
  };

  const response = (await browser.runtime.sendMessage(
    request,
  )) as ChatResponse | undefined;

  if (!response) {
    throw new TypeError('The summary backend could not be reached.');
  }

  if (response.ok) return response.answer;

  if (response.errorName === 'SummaryBackendNotConfiguredError') {
    throw new SummaryBackendNotConfiguredError();
  }

  if (typeof response.status === 'number') {
    throw new CloudSummaryRequestError(response.status, response.errorMessage);
  }

  if (response.errorName === 'AbortError') {
    const error = new DOMException(response.errorMessage, 'AbortError');
    throw error;
  }

  throw new Error(response.errorMessage);
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
