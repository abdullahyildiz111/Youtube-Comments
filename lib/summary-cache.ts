export const SUMMARY_CACHE_KEY = 'comment-catcher:summaries';
export const MAX_CACHED_SUMMARIES = 20;

export interface SavedSummary {
  videoId: string;
  text: string;
  commentCount: number;
  generatedAt: string;
  model?: string;
}

export async function readSummaryCache(): Promise<Record<string, SavedSummary>> {
  const stored = await browser.storage.local.get(SUMMARY_CACHE_KEY);
  const cache = stored[SUMMARY_CACHE_KEY];

  return cache && typeof cache === 'object'
    ? (cache as Record<string, SavedSummary>)
    : {};
}

export async function saveSummary(summary: SavedSummary): Promise<void> {
  const cache = await readSummaryCache();
  cache[summary.videoId] = summary;

  const trimmedCache = Object.fromEntries(
    Object.values(cache)
      .sort(
        (first, second) =>
          Date.parse(second.generatedAt) - Date.parse(first.generatedAt),
      )
      .slice(0, MAX_CACHED_SUMMARIES)
      .map((entry) => [entry.videoId, entry]),
  );

  await browser.storage.local.set({
    [SUMMARY_CACHE_KEY]: trimmedCache,
  });
}
