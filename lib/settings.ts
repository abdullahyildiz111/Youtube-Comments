export const AUTO_SUMMARIZE_KEY = 'comment-catcher:auto-summarize';

export async function getAutoSummarizeEnabled(): Promise<boolean> {
  const stored = await browser.storage.local.get(AUTO_SUMMARIZE_KEY);
  return stored[AUTO_SUMMARIZE_KEY] === true;
}

export async function setAutoSummarizeEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({
    [AUTO_SUMMARIZE_KEY]: enabled,
  });
}
