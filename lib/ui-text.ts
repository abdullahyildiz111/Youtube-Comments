import { createContext, createElement, useContext, type ReactNode } from 'react';
import { UI_CHROME } from '@/lib/ui-chrome';
import { UI_PACKS } from '@/lib/ui-translations';

export interface UiCopy {
  brandKicker: string;
  auto: string;
  autoTitle: string;
  refresh: string;
  refreshTitle: string;
  openWindow: string;
  openWindowTitle: string;
  resize: string;
  resizeTitle: string;
  sortBy: string;
  sortComments: string;
  sortTop: string;
  sortTopHint: string;
  sortNewest: string;
  sortNewestHint: string;
  collectingLive: string;
  loadingAllStatus: string;
  youtubeLoading: string;
  noCommentsFound: string;
  waitingForComments: string;
  openAVideo: string;
  listedByYouTube: string;
  metricLoaded: string;
  metricCaptured: string;
  metricLoading: string;
  countTooltip: string;
  commentsUnavailable: string;
  commentsDisabledHint: string;
  openYouTubeVideo: string;
  openYouTubeVideoHint: string;
  refreshYouTubeTab: string;
  collectorHint: string;
  aiSummary: string;
  aiSummaryHint: string;
  cloudAi: string;
  autoSummarizeOn: string;
  summarizeIntro: string;
  summarizeNow: string;
  summarizeAll: string;
  privacyNote: string;
  runsInTab: string;
  keepPopupOpen: string;
  takesSeconds: string;
  tryAgain: string;
  basedOn: string;
  newComments: string;
  cappedAt: string;
  update: string;
  updateTitle: string;
  askComments: string;
  answersIn: string;
  clear: string;
  askAnything: string;
  suggestionSentiment: string;
  suggestionComplaints: string;
  suggestionQuestions: string;
  readingComments: string;
  askPlaceholder: string;
  ask: string;
  loadCommentsFirst: string;
  waitUntilLoaded: string;
  loadWithoutScrolling: string;
  loadWithoutScrollingHint: string;
  loadAllComments: string;
  jumpToComments: string;
  loadedComments: string;
  capturedComments: string;
  stoppedAt: string;
  updatedAt: string;
  updatesAsLoad: string;
  hideSpam: string;
  hideSpamTitle: string;
  hideSpamUnavailable: string;
  spamHidden: string;
  exportCsv: string;
  exportPdf: string;
  exporting: string;
  exportCsvTitle: string;
  exportPdfTitle: string;
  loadAll: string;
  loadingShort: string;
  jumpToPage: string;
  searchPlaceholder: string;
  searchEmpty: string;
  searching: string;
  searchMatches: string;
  commentsArriving: string;
  hideReplies: string;
  viewReplies: string;
  oneReply: string;
  manyReplies: string;
  pinned: string;
  verified: string;
  lovedByCreator: string;
  footerSummaries: string;
  footerAsk: string;
  noCommentsToSummarize: string;
  refreshThenSummarize: string;
  sendingComments: string;
  loadingFromYouTube: string;
  loadingCount: string;
  noCommentsToExport: string;
  refreshThenLoad: string;
  refreshThenAsk: string;
  couldNotSummarize: string;
  connectingToPage: string;
  languageMenu: string;
  youtubeVideo: string;
  couldNotExport: string;
  couldNotLoadComments: string;
  couldNotAsk: string;
  couldNotLoadThread: string;
  canStillSummarize: string;
  openVideoFirst: string;
  videoChanged: string;
  loadTimedOut: string;
  loadCommentsThenAsk: string;
  backendNotConfigured: string;
  backendRejected: string;
  rateLimited: string;
  dailyQuota: string;
  commentsTooLarge: string;
  cloudTooSlow: string;
  backendUnreachable: string;
  bodyTooLarge: string;
  invalidJson: string;
  notFound: string;
  summaryNotConfigured: string;
  unauthorized: string;
  tooManyRequests: string;
  aiBusy: string;
  aiTimeout: string;
}

const EN: UiCopy = {
  brandKicker: 'YOUTUBE TOOL',
  auto: 'Auto',
  autoTitle: 'Fetch and summarize comments when a video opens',
  refresh: 'Refresh',
  refreshTitle: 'Refresh captured comments',
  openWindow: 'Open in a window',
  openWindowTitle: 'Open in a resizable window',
  resize: 'Resize popup',
  resizeTitle: 'Drag to resize',
  sortBy: 'Sort by',
  sortComments: 'Sort comments',
  sortTop: 'Top',
  sortTopHint: 'Show featured comments',
  sortNewest: 'Newest',
  sortNewestHint: 'Show recent comments, including potential spam',
  collectingLive: 'Collecting live',
  loadingAllStatus: 'Loading all comments',
  youtubeLoading: 'YouTube is loading',
  noCommentsFound: 'No comments found',
  waitingForComments: 'Waiting for comments',
  openAVideo: 'Open a video',
  listedByYouTube: 'listed by YouTube',
  metricLoaded: 'loaded',
  metricCaptured: 'captured',
  metricLoading: 'loading',
  countTooltip:
    "YouTube's total is an estimate and includes replies. Some comments are hidden or never returned by YouTube.",
  commentsUnavailable: 'Comments are unavailable',
  commentsDisabledHint: 'This video may have comments disabled.',
  openYouTubeVideo: 'Open a YouTube video',
  openYouTubeVideoHint:
    'This extension collects comments from standard YouTube video pages.',
  refreshYouTubeTab: 'Refresh the YouTube tab',
  collectorHint:
    'The collector could not connect. Refresh the video page once, then open this popup again.',
  aiSummary: 'AI summary',
  aiSummaryHint: 'One paragraph from the full comment thread',
  cloudAi: 'Cloud AI',
  autoSummarizeOn:
    'Auto summarize is on. Opening a video loads comments and saves the paragraph here.',
  summarizeIntro:
    'Load the comment thread from YouTube, then summarize it with Gemini. You do not need to scroll the page.',
  summarizeNow: 'Summarize this video now',
  summarizeAll: 'Summarize all comments',
  privacyNote:
    'Comment text is sent to Gemini through your secure backend. Most videos load in a few seconds.',
  runsInTab: 'This runs in the tab. You can close the popup.',
  keepPopupOpen: 'Fetching the thread in the background. Keep this popup open.',
  takesSeconds: 'Long threads can take several minutes.',
  tryAgain: 'Try again',
  basedOn: 'Based on {count} comments',
  newComments: 'New comments are available',
  cappedAt: 'Stopped early at {count}',
  update: 'Update',
  updateTitle: 'Summarize the comments already loaded',
  askComments: 'Ask the comments',
  answersIn: 'Answers are in {language}',
  clear: 'Clear',
  askAnything: 'Ask anything about this discussion.',
  suggestionSentiment: 'What is the overall sentiment?',
  suggestionComplaints: 'What are people complaining about?',
  suggestionQuestions: 'What questions keep coming up?',
  readingComments: 'Reading the comments…',
  askPlaceholder: 'Ask about these comments',
  ask: 'Ask',
  loadCommentsFirst: 'Load comments first to ask about this video.',
  waitUntilLoaded: 'Wait until comments finish loading or summarizing.',
  loadWithoutScrolling: 'Load comments without scrolling',
  loadWithoutScrollingHint:
    'The extension can request the comment thread from YouTube instead of waiting for comments to appear on the page.',
  loadAllComments: 'Load all comments',
  jumpToComments: 'Jump to comments',
  loadedComments: 'Loaded comments',
  capturedComments: 'Captured comments',
  stoppedAt: 'Stopped at {count} comments',
  updatedAt: 'Updated {time}',
  updatesAsLoad: 'Updates as comments load',
  hideSpam: 'Hide spam',
  hideSpamTitle:
    'Hide everything YouTube keeps out of its Top listing. Its own Newest option calls that set potential spam, and it is where banned and held-for-review replies show up.',
  hideSpamUnavailable:
    'Load the whole thread first. Until then a comment missing from Top may simply be one the Top pass has not reached yet.',
  spamHidden: '{count} spam hidden',
  exportCsv: 'Export CSV',
  exportPdf: 'Export PDF',
  exporting: 'Exporting…',
  exportCsvTitle:
    'Download the loaded comments as a spreadsheet. Hide spam applies.',
  exportPdfTitle: 'Download the loaded comments as a PDF. Hide spam applies.',
  loadAll: 'Load all',
  loadingShort: 'Loading…',
  jumpToPage: 'Jump to page',
  searchPlaceholder: 'Search comments',
  searchEmpty: 'No matching comments',
  searching: 'Searching…',
  searchMatches: '{count} matches',
  commentsArriving:
    'YouTube is sending the thread in pages. Comments will appear here as they arrive.',
  hideReplies: 'Hide replies',
  viewReplies: 'View {label}',
  oneReply: '1 reply',
  manyReplies: '{count} replies',
  pinned: 'Pinned',
  verified: 'Verified',
  lovedByCreator: 'Loved by the creator',
  footerSummaries: 'Fast summaries powered by Gemini',
  footerAsk: 'Ask the comments anything',
  noCommentsToSummarize: 'No comments were found to summarize.',
  refreshThenSummarize: 'Refresh the YouTube tab, then try summarizing again.',
  sendingComments: 'Sending {count} comments to the secure summary service…',
  loadingFromYouTube: 'Loading all comments from YouTube…',
  loadingCount: 'Loading comments from YouTube… {count}',
  noCommentsToExport: 'No comments to export with the current filter.',
  refreshThenLoad: 'Refresh the YouTube tab, then try loading comments again.',
  refreshThenAsk: 'Refresh the YouTube tab, then try asking again.',
  couldNotSummarize: 'The comments could not be summarized.',
  connectingToPage: 'Connecting to this page…',
  languageMenu: 'Summary and chat language',
  youtubeVideo: 'YouTube video',
  couldNotExport: 'Could not export comments. Refresh the YouTube tab, then try again.',
  couldNotLoadComments:
    'Could not load comments. Scroll to the comments section once, then try again.',
  couldNotAsk: 'The comments could not be asked about.',
  couldNotLoadThread: 'Could not load the full comment thread.',
  canStillSummarize: 'You can still summarize the {count} comments already captured.',
  openVideoFirst: 'Open a YouTube video first.',
  videoChanged: 'The video changed before comments finished loading.',
  loadTimedOut: 'Timed out while loading comments from YouTube.',
  loadCommentsThenAsk: 'Load comments first, then ask a question.',
  backendNotConfigured:
    'The cloud summary service is not configured. Set WXT_SUMMARY_API_URL to your Coolify backend and rebuild the extension.',
  backendRejected: 'The summary backend rejected this extension. Check WXT_SUMMARY_API_TOKEN.',
  rateLimited: 'The free AI service is busy or rate-limited. Please wait a minute and try again.',
  dailyQuota: 'The free AI quota for today is used up. Please try again tomorrow.',
  commentsTooLarge: 'The captured comments are too large for one summary request.',
  cloudTooSlow: 'The cloud AI took too long to respond. Please try again.',
  backendUnreachable:
    'The summary backend could not be reached. Check its URL and your internet connection.',
  bodyTooLarge: 'Request body is too large.',
  invalidJson: 'Request body must be valid JSON.',
  notFound: 'Not found.',
  summaryNotConfigured: 'Summary service is not configured.',
  unauthorized: 'Unauthorized.',
  tooManyRequests: 'Too many summary requests. Please wait a minute.',
  aiBusy: 'The free AI service is busy. Please try again shortly.',
  aiTimeout: 'The AI service took too long to respond.',
};

const KNOWN_MESSAGES: Record<string, keyof UiCopy> = {
  'Open a YouTube video first.': 'openVideoFirst',
  'The video changed before comments finished loading.': 'videoChanged',
  'Timed out while loading comments from YouTube.': 'loadTimedOut',
  'No comments were found to summarize.': 'noCommentsToSummarize',
  'Load comments first, then ask a question.': 'loadCommentsThenAsk',
  'The comments could not be summarized.': 'couldNotSummarize',
  'The cloud summary service is not configured. Set WXT_SUMMARY_API_URL to your Coolify backend and rebuild the extension.':
    'backendNotConfigured',
  'The summary backend rejected this extension. Check WXT_SUMMARY_API_TOKEN.':
    'backendRejected',
  'The free AI service is busy or rate-limited. Please wait a minute and try again.':
    'rateLimited',
  'The free AI quota for today is used up. Please try again tomorrow.': 'dailyQuota',
  'The captured comments are too large for one summary request.': 'commentsTooLarge',
  'The cloud AI took too long to respond. Please try again.': 'cloudTooSlow',
  'The summary backend could not be reached. Check its URL and your internet connection.':
    'backendUnreachable',
  'Request body is too large.': 'bodyTooLarge',
  'Request body must be valid JSON.': 'invalidJson',
  'Not found.': 'notFound',
  'Summary service is not configured.': 'summaryNotConfigured',
  Unauthorized: 'unauthorized',
  'Unauthorized.': 'unauthorized',
  'Too many summary requests. Please wait a minute.': 'tooManyRequests',
  'The free AI service is busy. Please try again shortly.': 'aiBusy',
  'The AI service took too long to respond.': 'aiTimeout',
};

export function localizeMessage(message: string, copy: UiCopy): string {
  const key = KNOWN_MESSAGES[message.trim()];
  return key ? copy[key] : message;
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    values[key] == null ? '' : String(values[key]),
  );
}

export function languageName(code: string, inLanguage: string): string {
  try {
    return (
      new Intl.DisplayNames([inLanguage, 'en'], { type: 'language' }).of(code) ??
      code
    );
  } catch {
    return code;
  }
}

const LANGUAGE_ALIASES: Record<string, string> = {
  'zh-Hans': 'zh',
  'zh-Hant': 'zh',
  'pt-BR': 'pt',
  nb: 'no',
  nn: 'no',
};

const SEARCH_COPY: Record<string, Pick<UiCopy, 'searchPlaceholder' | 'searchEmpty' | 'searching' | 'searchMatches'>> = {
  tr: {
    searchPlaceholder: 'Yorumlarda ara',
    searchEmpty: 'Eşleşen yorum yok',
    searching: 'Aranıyor…',
    searchMatches: '{count} eşleşme',
  },
  ar: {
    searchPlaceholder: 'ابحث في التعليقات',
    searchEmpty: 'لا توجد تعليقات مطابقة',
    searching: 'جارٍ البحث…',
    searchMatches: '{count} نتيجة',
  },
  de: {
    searchPlaceholder: 'Kommentare durchsuchen',
    searchEmpty: 'Keine passenden Kommentare',
    searching: 'Suche…',
    searchMatches: '{count} Treffer',
  },
  es: {
    searchPlaceholder: 'Buscar comentarios',
    searchEmpty: 'No hay comentarios coincidentes',
    searching: 'Buscando…',
    searchMatches: '{count} coincidencias',
  },
  fr: {
    searchPlaceholder: 'Rechercher dans les commentaires',
    searchEmpty: 'Aucun commentaire correspondant',
    searching: 'Recherche…',
    searchMatches: '{count} résultats',
  },
  ru: {
    searchPlaceholder: 'Искать в комментариях',
    searchEmpty: 'Нет совпадений',
    searching: 'Поиск…',
    searchMatches: '{count} совпадений',
  },
  zh: {
    searchPlaceholder: '搜索评论',
    searchEmpty: '没有匹配的评论',
    searching: '正在搜索…',
    searchMatches: '{count} 条结果',
  },
  ja: {
    searchPlaceholder: 'コメントを検索',
    searchEmpty: '一致するコメントはありません',
    searching: '検索中…',
    searchMatches: '{count} 件',
  },
  ko: {
    searchPlaceholder: '댓글 검색',
    searchEmpty: '일치하는 댓글 없음',
    searching: '검색 중…',
    searchMatches: '{count}개 결과',
  },
  pt: {
    searchPlaceholder: 'Pesquisar comentários',
    searchEmpty: 'Nenhum comentário correspondente',
    searching: 'A pesquisar…',
    searchMatches: '{count} resultados',
  },
  it: {
    searchPlaceholder: 'Cerca nei commenti',
    searchEmpty: 'Nessun commento corrispondente',
    searching: 'Ricerca…',
    searchMatches: '{count} risultati',
  },
  hi: {
    searchPlaceholder: 'टिप्पणियाँ खोजें',
    searchEmpty: 'कोई मेल खाती टिप्पणी नहीं',
    searching: 'खोज रहे हैं…',
    searchMatches: '{count} परिणाम',
  },
  id: {
    searchPlaceholder: 'Cari komentar',
    searchEmpty: 'Tidak ada komentar yang cocok',
    searching: 'Mencari…',
    searchMatches: '{count} hasil',
  },
  vi: {
    searchPlaceholder: 'Tìm trong bình luận',
    searchEmpty: 'Không có bình luận khớp',
    searching: 'Đang tìm…',
    searchMatches: '{count} kết quả',
  },
  uk: {
    searchPlaceholder: 'Шукати в коментарях',
    searchEmpty: 'Немає збігів',
    searching: 'Пошук…',
    searchMatches: '{count} збігів',
  },
  pl: {
    searchPlaceholder: 'Szukaj w komentarzach',
    searchEmpty: 'Brak pasujących komentarzy',
    searching: 'Szukanie…',
    searchMatches: '{count} wyników',
  },
  nl: {
    searchPlaceholder: 'Zoek in reacties',
    searchEmpty: 'Geen overeenkomende reacties',
    searching: 'Zoeken…',
    searchMatches: '{count} resultaten',
  },
  fa: {
    searchPlaceholder: 'جستجو در دیدگاه‌ها',
    searchEmpty: 'دیدگاهی پیدا نشد',
    searching: 'در حال جستجو…',
    searchMatches: '{count} نتیجه',
  },
  he: {
    searchPlaceholder: 'חיפוש בתגובות',
    searchEmpty: 'אין תגובות תואמות',
    searching: 'מחפש…',
    searchMatches: '{count} תוצאות',
  },
};

export function uiText(language: string): UiCopy {
  const alias = LANGUAGE_ALIASES[language];
  const base = language.split('-')[0] ?? language;
  const pack = UI_PACKS[language] ?? (alias ? UI_PACKS[alias] : undefined) ?? UI_PACKS[base];
  const chrome =
    UI_CHROME[language] ?? (alias ? UI_CHROME[alias] : undefined) ?? UI_CHROME[base];
  const search =
    SEARCH_COPY[language] ??
    (alias ? SEARCH_COPY[alias] : undefined) ??
    SEARCH_COPY[base];
  if (!pack && !chrome && !search) return EN;
  const copy = { ...EN, ...pack, ...chrome, ...search };
  // Older translations still mention a fixed comment cap in this sentence.
  if (copy.summarizeIntro.includes('{count}')) copy.summarizeIntro = EN.summarizeIntro;
  return copy;
}

const UiTextContext = createContext({ language: 'en', copy: EN });

export function UiTextProvider({
  language,
  children,
}: {
  language: string;
  children: ReactNode;
}) {
  return createElement(
    UiTextContext.Provider,
    { value: { language, copy: uiText(language) } },
    children,
  );
}

export function useUiText(): { language: string; copy: UiCopy } {
  return useContext(UiTextContext);
}
