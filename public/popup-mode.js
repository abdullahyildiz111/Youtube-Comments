// Applies the saved toolbar-popup size before first paint.
// Keep the key and limits in sync with entrypoints/popup/popup-size.ts.
(function () {
  if (new URLSearchParams(location.search).get('detached') === '1') {
    document.documentElement.classList.add('is-detached');
    return;
  }

  try {
    var raw = localStorage.getItem('comment-catcher:action-popup-size');
    if (!raw) return;
    var size = JSON.parse(raw);
    if (!size || typeof size.width !== 'number' || typeof size.height !== 'number') return;
    var width = Math.min(800, Math.max(380, Math.round(size.width)));
    var height = Math.min(600, Math.max(460, Math.round(size.height)));
    var widthPx = width + 'px';
    var heightPx = height + 'px';
    document.documentElement.style.width = widthPx;
    document.documentElement.style.height = heightPx;
    document.body.style.width = widthPx;
    document.body.style.height = heightPx;
  } catch {
    // Ignore unreadable storage and keep the default stylesheet size.
  }
})();
