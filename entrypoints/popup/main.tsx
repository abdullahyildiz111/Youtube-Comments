import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import {
  applyActionPopupSize,
  currentPopupWindowId,
  isDetachedPopup,
  readActionPopupSize,
  readPopupSize,
  resizePopupWindow,
  savePopupSize,
} from './popup-size';
import './style.css';

if (!isDetachedPopup()) {
  applyActionPopupSize(readActionPopupSize());
} else {
  document.documentElement.classList.add('is-detached');
  void currentPopupWindowId();

  void (async () => {
    const size = await readPopupSize();
    const win = await browser.windows.getCurrent();
    if (win.id == null || win.width == null || win.height == null) return;

    const widthDiffers = Math.abs(win.width - size.width) > 4;
    const heightDiffers = Math.abs(win.height - size.height) > 4;
    if (widthDiffers || heightDiffers) {
      await resizePopupWindow(size, win.id);
    }
  })();

  let persistTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      void browser.windows.getCurrent().then((win) => {
        if (win.width == null || win.height == null) return;
        return savePopupSize({ width: win.width, height: win.height });
      });
    }, 200);
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
