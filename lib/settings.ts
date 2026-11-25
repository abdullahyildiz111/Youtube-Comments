import { isReplyLanguageCode } from '@/lib/languages';

export const DEFAULT_REPLY_LANGUAGE = 'en';

export const AUTO_SUMMARIZE_KEY = 'comment-catcher:auto-summarize';
// Fresh key: ON shows replies YouTube's Top view leaves out. Default OFF
// matches the counts on the watch page.
export const SHOW_SPAM_KEY = 'comment-catcher:show-spam-comments';
export const REPLY_LANGUAGE_KEY = 'comment-catcher:reply-language';

export async function getAutoSummarizeEnabled(): Promise<boolean> {
  const stored = await browser.storage.local.get(AUTO_SUMMARIZE_KEY);
  return stored[AUTO_SUMMARIZE_KEY] === true;
}

export async function setAutoSummarizeEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({
    [AUTO_SUMMARIZE_KEY]: enabled,
  });
}

export async function getShowSpamComments(): Promise<boolean> {
  const stored = await browser.storage.local.get(SHOW_SPAM_KEY);
  return stored[SHOW_SPAM_KEY] === true;
}

export async function setShowSpamComments(enabled: boolean): Promise<void> {
  await browser.storage.local.set({
    [SHOW_SPAM_KEY]: enabled,
  });
}

export async function getReplyLanguage(): Promise<string> {
  const stored = await browser.storage.local.get(REPLY_LANGUAGE_KEY);
  const value = stored[REPLY_LANGUAGE_KEY];
  if (isReplyLanguageCode(value)) return value;
  await setReplyLanguage(DEFAULT_REPLY_LANGUAGE);
  return DEFAULT_REPLY_LANGUAGE;
}

export async function setReplyLanguage(language: string): Promise<void> {
  if (!isReplyLanguageCode(language)) return;
  await browser.storage.local.set({
    [REPLY_LANGUAGE_KEY]: language,
  });
}
