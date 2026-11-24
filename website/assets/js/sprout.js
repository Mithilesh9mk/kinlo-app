/* Sprout reactions. Plain script, no inline code. Swaps between poses that already sit in the page (all the same size, so nothing shifts).
   Reduced motion: this file does nothing and Sprout stays on its first pose. */
(function () {
  try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch (e) {}
  var els = document.querySelectorAll('[data-sprout]');
  if (!els.length) return;
  // Warm every pose so the first swap never flashes an undecoded image, and pause the breathing while off-screen.
  Array.prototype.forEach.call(document.querySelectorAll('[data-sprout] [data-pose]'), function (img) { var im = new Image(); im.src = img.currentSrc || img.src; });
  if ('IntersectionObserver' in window) {
    var vis = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { en.target.classList.toggle('is-paused', !en.isIntersecting); });
    });
    Array.prototype.forEach.call(els, function (el) { vis.observe(el); });
  }
  Array.prototype.forEach.call(els, function (el) {
    var poses = {};
    Array.prototype.forEach.call(el.querySelectorAll('[data-pose]'), function (img) { poses[img.getAttribute('data-pose')] = img; });
    var say = el.querySelector('.sprout__say');
    var words = { wave: 'Hi! I’m Sprout.', curious: 'Ooh, let me see…', celebrate: 'Yay!', proud: 'See you there!' };
    var base = 'idle', cur = 'idle', timer = 0, hopTimer = 0;
    function set(name) {
      if (!poses[name] || name === cur) return;
      poses[cur].classList.remove('is-on');
      poses[name].classList.add('is-on');
      cur = name;
      if (say) { if (words[name]) { say.textContent = words[name]; say.classList.add('is-on'); } else say.classList.remove('is-on'); }
    }
    function pulse(name, ms) {
      set(name);
      clearTimeout(timer);
      timer = setTimeout(function () { set(base); }, ms);
    }
    function hop() {
      el.classList.remove('is-hop');
      void el.offsetWidth;
      el.classList.add('is-hop');
      clearTimeout(hopTimer);
      hopTimer = setTimeout(function () { el.classList.remove('is-hop'); }, 700);
    }
    function cheer() { hop(); pulse('celebrate', 1400); }
    el.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') cheer(); });
    el.addEventListener('click', cheer);

    var kind = el.getAttribute('data-sprout');
    if (kind === 'hero') {
      // Says hello once after the hero has assembled, then gets curious while someone types in the calculator.
      var idleTimer = 0;
      setTimeout(function () { if (cur === 'idle') pulse('wave', 2200); }, 2600);
      var form = document.getElementById('calc-form');
      if (form) {
        var look = function () { clearTimeout(timer); clearTimeout(idleTimer); set('curious'); };
        var rest = function () { clearTimeout(idleTimer); idleTimer = setTimeout(function () { set(base); }, 1400); };
        form.addEventListener('focusin', look);
        form.addEventListener('input', function () { look(); rest(); });
        form.addEventListener('focusout', rest);
      }
    } else if (kind === 'band') {
      // Waves when the download section scrolls into view; looks proud while someone points at the install button.
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) { io.disconnect(); setTimeout(function () { pulse('wave', 2200); }, 500); }
          });
        }, { threshold: 0.6 });
        io.observe(el);
      }
      var btn = document.querySelector('#download .btn:not([disabled])');
      if (btn) {
        var proud = function () { clearTimeout(timer); set('proud'); };
        var calm = function () { clearTimeout(timer); timer = setTimeout(function () { set(base); }, 900); };
        btn.addEventListener('pointerenter', proud);
        btn.addEventListener('focus', proud);
        btn.addEventListener('pointerleave', calm);
        btn.addEventListener('blur', calm);
      }
    }
  });
})();
