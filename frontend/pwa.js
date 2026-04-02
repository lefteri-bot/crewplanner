/* PWA helper: registers service worker (safe no-op if unsupported). */
(() => {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => {
        // ok
      })
      .catch(() => {
        // ignore
      });
  });
})();
