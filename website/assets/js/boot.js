/* Marks the page as script-enabled before first paint so CSS can stage reveals. Without this file running, everything stays visible. */
document.documentElement.classList.add('js');
try {
  if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    document.documentElement.classList.add('launching', 'sc-wait');
    // If the scene engine has not started within 4 s, drop the hidden state so nothing stays invisible.
    setTimeout(function () { if (!document.documentElement.classList.contains('sc-ready')) document.documentElement.classList.remove('sc-wait'); }, 4000);
  }
} catch (e) {}
