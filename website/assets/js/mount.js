/* Starts the scroll scenes (home page only). If the engine did not load, the page stays a plain, complete layout. */
(function () {
  var root = document.documentElement;
  // Reduced motion gets the plain layout: no pinning, no parallax, nothing scroll-driven.
  try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch (e) {}
  if (!window.ScrollCraft) { root.classList.remove('sc-wait'); return; }
  var api;
  try { api = window.ScrollCraft.mount(document.body); } catch (e) { root.classList.remove('sc-wait'); return; }
  // The engine measures once and on resize. Late layout changes (images, fonts, the journey ledger) move the acts, so measure again.
  var queued = false;
  function remeasure() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; api.layout(); });
  }
  window.addEventListener('load', remeasure);
  if (window.ResizeObserver) {
    var main = document.getElementById('main');
    if (main) new ResizeObserver(remeasure).observe(main);
  }
})();
