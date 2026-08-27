export const AUTO_SUMMARIZE_KEY = 'comment-catcher:auto-summarize';
export const HIDE_FILTERED_KEY = 'comment-catcher:hide-filtered-comments';

export async function getAutoSummarizeEnabled(): Promise<boolean> {
  const stored = await browser.storage.local.get(AUTO_SUMMARIZE_KEY);
  return stored[AUTO_SUMMARIZE_KEY] === true;
}

export async function setAutoSummarizeEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({
    [AUTO_SUMMARIZE_KEY]: enabled,
  });
}

export async function getHideFilteredComments(): Promise<boolean> {
  const stored = await browser.storage.local.get(HIDE_FILTERED_KEY);
  return stored[HIDE_FILTERED_KEY] === true;
}

export async function setHideFilteredComments(enabled: boolean): Promise<void> {
  await browser.storage.local.set({
    [HIDE_FILTERED_KEY]: enabled,
  });
}
