export const POPUP_SIZE_STORAGE_KEY = 'comment-catcher:popup-size';
export const POPUP_WINDOW_ID_KEY = 'comment-catcher:popup-window-id';
export const POPUP_RETARGET_MESSAGE = 'comment-catcher:retarget-popup';
export const OPEN_DETACHED_MESSAGE = 'comment-catcher:open-detached';

export const ACTION_POPUP_SIZE_KEY = 'comment-catcher:action-popup-size';

export const POPUP_DEFAULT_SIZE = { width: 420, height: 580 };
/** Smallest size the corner drag will shrink to. */
export const POPUP_MIN_SIZE = { width: 380, height: 460 };
/** Chrome and Firefox will not draw a toolbar popup larger than this. */
export const ACTION_POPUP_MAX_SIZE = { width: 800, height: 600 };

export type PopupSize = { width: number; height: number };

export function isDetachedPopup(): boolean {
  return new URLSearchParams(location.search).get('detached') === '1';
}

export function clampPopupSize(width: number, height: number): PopupSize {
  return {
    width: Math.max(POPUP_MIN_SIZE.width, Math.round(width)),
    height: Math.max(POPUP_MIN_SIZE.height, Math.round(height)),
  };
}

export function clampActionPopupSize(width: number, height: number): PopupSize {
  return {
    width: Math.min(
      ACTION_POPUP_MAX_SIZE.width,
      Math.max(POPUP_MIN_SIZE.width, Math.round(width)),
    ),
    height: Math.min(
      ACTION_POPUP_MAX_SIZE.height,
      Math.max(POPUP_MIN_SIZE.height, Math.round(height)),
    ),
  };
}

export function readActionPopupSize(): PopupSize {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACTION_POPUP_SIZE_KEY) ?? 'null') as {
      width?: unknown;
      height?: unknown;
    } | null;
    if (!parsed || typeof parsed.width !== 'number' || typeof parsed.height !== 'number') {
      return { ...POPUP_DEFAULT_SIZE };
    }
    return clampActionPopupSize(parsed.width, parsed.height);
  } catch {
    return { ...POPUP_DEFAULT_SIZE };
  }
}

export function applyActionPopupSize(size: PopupSize): PopupSize {
  const next = clampActionPopupSize(size.width, size.height);
  const width = `${next.width}px`;
  const height = `${next.height}px`;
  document.documentElement.style.width = width;
  document.documentElement.style.height = height;
  document.body.style.width = width;
  document.body.style.height = height;
  return next;
}

export function saveActionPopupSize(size: PopupSize): PopupSize {
  const next = applyActionPopupSize(size);
  localStorage.setItem(ACTION_POPUP_SIZE_KEY, JSON.stringify(next));
  return next;
}

export type PopupAnchor = {
  /** The left edge moves, so extra width grows left. */
  growsLeft: boolean;
  /** The top edge moves, so extra height grows up. */
  growsUp: boolean;
};

/** Toolbar icons sit on the right, so the popup's free corner is the bottom-left. */
export const TOOLBAR_POPUP_ANCHOR: PopupAnchor = { growsLeft: true, growsUp: false };

export function parsePopupSize(value: unknown): PopupSize | null {
  if (!value || typeof value !== 'object') return null;

  const size = value as { width?: unknown; height?: unknown };
  if (typeof size.width !== 'number' || typeof size.height !== 'number') return null;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;

  return {
    width: Math.max(1, Math.round(size.width)),
    height: Math.max(1, Math.round(size.height)),
  };
}

function readLegacyPopupSize(): PopupSize | null {
  try {
    return parsePopupSize(
      JSON.parse(localStorage.getItem(POPUP_SIZE_STORAGE_KEY) ?? 'null'),
    );
  } catch {
    return null;
  }
}

export async function readPopupSize(): Promise<PopupSize> {
  const stored = await browser.storage.local.get(POPUP_SIZE_STORAGE_KEY);
  const saved = parsePopupSize(stored[POPUP_SIZE_STORAGE_KEY]);
  if (saved) return saved;

  const legacy = readLegacyPopupSize();
  if (!legacy) return { ...POPUP_DEFAULT_SIZE };

  await savePopupSize(legacy);
  try {
    localStorage.removeItem(POPUP_SIZE_STORAGE_KEY);
  } catch {
    // Service workers have no localStorage.
  }
  return legacy;
}

export async function savePopupSize(size: PopupSize): Promise<PopupSize> {
  const next = parsePopupSize(size) ?? { ...POPUP_DEFAULT_SIZE };
  await browser.storage.local.set({ [POPUP_SIZE_STORAGE_KEY]: next });
  return next;
}

let cachedWindowId: number | undefined;

export async function currentPopupWindowId(): Promise<number | undefined> {
  if (cachedWindowId != null) return cachedWindowId;
  const win = await browser.windows.getCurrent();
  cachedWindowId = win.id;
  return win.id;
}

export async function resizePopupWindow(
  size: PopupSize,
  windowId?: number,
): Promise<void> {
  const id = windowId ?? (await currentPopupWindowId());
  if (id == null) return;
  cachedWindowId = id;
  await browser.windows.update(id, {
    width: size.width,
    height: size.height,
  });
}
