import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import {
  POPUP_DEFAULT_SIZE,
  clampActionPopupSize,
  clampPopupSize,
  currentPopupWindowId,
  isDetachedPopup,
  resizePopupWindow,
  saveActionPopupSize,
  savePopupSize,
  TOOLBAR_POPUP_ANCHOR,
  type PopupAnchor,
  type PopupSize,
} from './popup-size';

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
  anchor: PopupAnchor;
  windowId?: number;
};

const fixedAnchor: PopupAnchor = { growsLeft: false, growsUp: false };

function documentSize(): PopupSize {
  const rect = document.documentElement.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function resizeCursor(anchor: PopupAnchor): 'nwse' | 'nesw' {
  return anchor.growsLeft === anchor.growsUp ? 'nwse' : 'nesw';
}

export function ResizeHandle() {
  const detached = isDetachedPopup();
  const dragRef = useRef<DragState | null>(null);
  const pendingSize = useRef<PopupSize | null>(null);
  const applyingSize = useRef(false);
  const anchor = detached ? fixedAnchor : TOOLBAR_POPUP_ANCHOR;

  const applyDetachedSize = (windowId: number, size: PopupSize) => {
    pendingSize.current = size;
    if (applyingSize.current) return;

    applyingSize.current = true;
    void (async () => {
      try {
        while (pendingSize.current) {
          const next = pendingSize.current;
          pendingSize.current = null;
          await resizePopupWindow(next, windowId);
        }
      } finally {
        applyingSize.current = false;
      }
    })();
  };

  const resizeFromDrag = (drag: DragState, screenX: number, screenY: number) => {
    const widthDelta = drag.anchor.growsLeft
      ? drag.startX - screenX
      : screenX - drag.startX;
    const heightDelta = drag.anchor.growsUp
      ? drag.startY - screenY
      : screenY - drag.startY;
    if (detached) {
      if (drag.windowId == null) return;
      applyDetachedSize(
        drag.windowId,
        clampPopupSize(drag.width + widthDelta, drag.height + heightDelta),
      );
      return;
    }

    saveActionPopupSize(
      clampActionPopupSize(drag.width + widthDelta, drag.height + heightDelta),
    );
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const nextAnchor = anchor;
    document.documentElement.classList.add(
      'is-resizing',
      `is-resizing-${resizeCursor(nextAnchor)}`,
    );

    const pointerId = event.pointerId;
    const startX = event.screenX;
    const startY = event.screenY;
    const size = documentSize();

    if (!detached) {
      dragRef.current = {
        pointerId,
        startX,
        startY,
        width: size.width || POPUP_DEFAULT_SIZE.width,
        height: size.height || POPUP_DEFAULT_SIZE.height,
        anchor: nextAnchor,
      };
      return;
    }

    void currentPopupWindowId().then((windowId) => {
      if (windowId == null) return;
      dragRef.current = {
        pointerId,
        windowId,
        startX,
        startY,
        width: window.outerWidth || POPUP_DEFAULT_SIZE.width,
        height: window.outerHeight || POPUP_DEFAULT_SIZE.height,
        anchor: fixedAnchor,
      };
    });
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    resizeFromDrag(drag, event.screenX, event.screenY);
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    dragRef.current = null;
    document.documentElement.classList.remove(
      'is-resizing',
      'is-resizing-nwse',
      'is-resizing-nesw',
    );

    if (!detached) {
      resizeFromDrag(drag, event.screenX, event.screenY);
      return;
    }

    void browser.windows.getCurrent().then((win) => {
      if (win.width == null || win.height == null) return;
      return savePopupSize({ width: win.width, height: win.height });
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 48 : 16;
    let widthDelta = 0;
    let heightDelta = 0;

    if (event.key === 'ArrowDown') heightDelta = anchor.growsUp ? -step : step;
    else if (event.key === 'ArrowUp') heightDelta = anchor.growsUp ? step : -step;
    else if (event.key === 'ArrowRight') widthDelta = anchor.growsLeft ? -step : step;
    else if (event.key === 'ArrowLeft') widthDelta = anchor.growsLeft ? step : -step;
    else return;

    event.preventDefault();

    if (!detached) {
      const size = documentSize();
      saveActionPopupSize(
        clampActionPopupSize(size.width + widthDelta, size.height + heightDelta),
      );
      return;
    }

    void browser.windows.getCurrent().then(async (win) => {
      if (win.id == null || win.width == null || win.height == null) return;
      const next = clampPopupSize(win.width + widthDelta, win.height + heightDelta);
      await resizePopupWindow(next, win.id);
      await savePopupSize(next);
    });
  };

  const corner = [
    'resize-handle',
    anchor.growsLeft ? 'is-left' : 'is-right',
    anchor.growsUp ? 'is-top' : 'is-bottom',
  ].join(' ');

  return (
    <button
      type="button"
      className={corner}
      aria-label="Resize popup"
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
    >
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4 11 11 4M7 11l4-4M10 11l1-1" />
      </svg>
    </button>
  );
}
