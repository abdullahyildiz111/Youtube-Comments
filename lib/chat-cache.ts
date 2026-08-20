import type { ChatTurn } from '@/lib/cloud-summarizer';

export const CHAT_CACHE_KEY = 'comment-catcher:chats';
export const MAX_CACHED_CHATS = 20;
export const MAX_CHAT_MESSAGES = 40;

export interface ChatMessage extends ChatTurn {
  id: string;
  createdAt: string;
}

export interface SavedChat {
  videoId: string;
  messages: ChatMessage[];
  updatedAt: string;
}

export async function readChatCache(): Promise<Record<string, SavedChat>> {
  const stored = await browser.storage.local.get(CHAT_CACHE_KEY);
  const cache = stored[CHAT_CACHE_KEY];

  return cache && typeof cache === 'object'
    ? (cache as Record<string, SavedChat>)
    : {};
}

export async function readVideoChat(videoId: string): Promise<ChatMessage[]> {
  const cache = await readChatCache();
  return cache[videoId]?.messages ?? [];
}

export async function saveVideoChat(
  videoId: string,
  messages: ChatMessage[],
): Promise<void> {
  const cache = await readChatCache();
  cache[videoId] = {
    videoId,
    messages: messages.slice(-MAX_CHAT_MESSAGES),
    updatedAt: new Date().toISOString(),
  };

  const trimmedCache = Object.fromEntries(
    Object.values(cache)
      .sort(
        (first, second) =>
          Date.parse(second.updatedAt) - Date.parse(first.updatedAt),
      )
      .slice(0, MAX_CACHED_CHATS)
      .map((entry) => [entry.videoId, entry]),
  );

  await browser.storage.local.set({
    [CHAT_CACHE_KEY]: trimmedCache,
  });
}

export async function clearVideoChat(videoId: string): Promise<void> {
  const cache = await readChatCache();
  delete cache[videoId];
  await browser.storage.local.set({
    [CHAT_CACHE_KEY]: cache,
  });
}
