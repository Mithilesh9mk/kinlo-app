/* Marks the page as script-enabled before first paint so CSS can stage reveals. Without this file running, everything stays visible. */
document.documentElement.classList.add('js');
try { if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) document.documentElement.classList.add('launching'); } catch (e) {}
