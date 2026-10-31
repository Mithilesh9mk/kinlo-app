/* Kinlo site script: split calculator, two staged demos, a split-types demo, a scroll-stepped ledger, one reveal. No dependencies, nothing is sent anywhere. */
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- money in integer paise ---------- */
  var MAX_PAISE = 1000000000; /* Rs 1,00,00,000 */
  var NAMES = ['Asha', 'Ravi', 'Meera', 'Dev', 'Isha', 'Kabir', 'Nila', 'Om', 'Pari', 'Rohan', 'Sana', 'Tara'];

  function normaliseDigits(s) {
    return s
      .replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x6f0); })
      .replace(/[०-९]/g, function (c) { return String(c.charCodeAt(0) - 0x966); })
      .replace(/٫/g, '.')
      .replace(/[٬  \s]/g, '');
  }

  /* Reads text, never a float, so 0.1 + 0.2 style drift cannot happen. */
  function parseMoney(raw) {
    var s = normaliseDigits(String(raw == null ? '' : raw)).replace(/[₹,]/g, '').replace(/^(rs\.?|inr)/i, '').replace(/(rs|inr)$/i, '');
    if (s === '') return { ok: false, code: 'empty' };
    if (!/^\d*\.?\d*$/.test(s) || s === '.') return { ok: false, code: 'invalid' };
    var parts = s.split('.');
    var whole = (parts[0] || '0').replace(/^0+(?=\d)/, '');
    var frac = parts[1] || '';
    if (frac.length > 2) return { ok: false, code: 'decimals' };
    if (whole.length > 10) return { ok: false, code: 'big' };
    var paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
    if (paise > MAX_PAISE) return { ok: false, code: 'big' };
    return { ok: true, paise: paise };
  }

  /* en-IN grouping done by hand so it never depends on the browser's locale data. */
  function fmt(paise) {
    var neg = paise < 0;
    if (neg) paise = -paise;
    var r = Math.floor(paise / 100);
    var f = paise % 100;
    var s = String(r);
    var last = s.slice(-3);
    var rest = s.slice(0, -3);
    if (rest) rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',';
    return (neg ? '-' : '') + '₹' + rest + last + '.' + (f < 10 ? '0' : '') + f;
  }

  function plain(paise) {
    var f = paise % 100;
    return Math.floor(paise / 100) + '.' + (f < 10 ? '0' : '') + f;
  }

  /* Same rule as the app: the extra paise go to the first people in the list. */
  function equalSplit(total, n) {
    var base = Math.floor(total / n);
    var rem = total % n;
    var out = [];
    for (var i = 0; i < n; i++) out.push(base + (i < rem ? 1 : 0));
    return out;
  }

  var isolate = function (s) { return '⁨' + s + '⁩'; };

  /* ---------- calculator ---------- */
  var form = document.getElementById('calc-form');
  if (form) {
    var el = {
      total: document.getElementById('total'),
      totalHelp: document.getElementById('total-help'),
      count: document.getElementById('count'),
      stepper: document.getElementById('stepper'),
      payer: document.getElementById('payer'),
      rows: document.getElementById('rows'),
      status: document.getElementById('calc-status'),
      sum: document.getElementById('calc-sum'),
      stepDown: document.getElementById('step-down'),
      stepUp: document.getElementById('step-up')
    };
    var state = { n: 3, mode: 'equal', payer: 0, names: NAMES.slice(), custom: [] };
    var built = { n: 0, mode: '' };

    var peopleRadio = function () { return form.querySelector('input[name="people"]:checked').value; };
    var modeRadio = function () { return form.querySelector('input[name="mode"]:checked').value; };
    var nameOf = function (i) { return (state.names[i] || '').trim() || 'Person ' + (i + 1); };

    var totalMessages = {
      empty: 'Enter the bill total.',
      invalid: 'Use numbers only, like 1,250.50.',
      decimals: 'Rupees and paise only: two decimal places at most.',
      big: 'This calculator stops at ₹1,00,00,000.',
      zero: 'The total must be more than ₹0.'
    };

    function setStatus(kind, lead, rest) {
      el.status.setAttribute('data-state', kind);
      el.status.textContent = '';
      var strong = document.createElement('strong');
      strong.textContent = lead;
      el.status.appendChild(strong);
      if (rest) el.status.appendChild(document.createTextNode(' ' + rest));
    }

    function readCount() {
      var which = peopleRadio();
      if (which !== 'more') return { ok: true, n: Number(which) };
      var raw = String(el.count.value).trim();
      if (!/^\d+$/.test(raw)) return { ok: false };
      var n = Number(raw);
      if (n < 4 || n > 12) return { ok: false };
      return { ok: true, n: n };
    }

    function buildPayer() {
      var keep = el.payer.value;
      el.payer.textContent = '';
      for (var i = 0; i < state.n; i++) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = nameOf(i);
        el.payer.appendChild(o);
      }
      var none = document.createElement('option');
      none.value = '-1';
      none.textContent = 'Not set';
      el.payer.appendChild(none);
      if (keep === '-1') el.payer.value = '-1';
      else el.payer.value = String(Math.min(state.payer, state.n - 1));
      state.payer = Number(el.payer.value);
    }

    function prefillCustom(total) {
      var base = total.ok && total.paise > 0 ? equalSplit(total.paise, state.n) : [];
      state.custom = [];
      for (var i = 0; i < state.n; i++) state.custom.push(base.length ? plain(base[i]) : '');
    }

    function buildRows() {
      el.rows.textContent = '';
      for (var i = 0; i < state.n; i++) {
        var li = document.createElement('li');
        li.className = 'row';
        var name = document.createElement('input');
        name.className = 'row__name';
        name.type = 'text';
        name.value = state.names[i];
        name.maxLength = 24;
        name.setAttribute('dir', 'auto');
        name.setAttribute('autocomplete', 'off');
        name.setAttribute('aria-label', 'Name of person ' + (i + 1));
        name.setAttribute('data-i', String(i));
        li.appendChild(name);
        var amt;
        if (state.mode === 'custom') {
          amt = document.createElement('input');
          amt.className = 'input row__amt';
          amt.type = 'text';
          amt.inputMode = 'decimal';
          amt.setAttribute('autocomplete', 'off');
          amt.setAttribute('dir', 'auto');
          amt.value = state.custom[i] || '';
          amt.setAttribute('data-i', String(i));
          amt.setAttribute('aria-label', 'Share of person ' + (i + 1) + ' in rupees');
        } else {
          amt = document.createElement('output');
          amt.className = 'row__amt num';
        }
        li.appendChild(amt);
        var note = document.createElement('span');
        note.className = 'row__note';
        li.appendChild(note);
        el.rows.appendChild(li);
      }
      built.n = state.n;
      built.mode = state.mode;
    }

    function noteFor(li, parts) {
      var note = li.querySelector('.row__note');
      note.textContent = '';
      parts.forEach(function (p) {
        if (p && p.name) {
          var b = document.createElement('bdi');
          b.textContent = p.name;
          note.appendChild(b);
        } else if (p) {
          note.appendChild(document.createTextNode(p));
        }
      });
    }

    function update() {
      var total = parseMoney(el.total.value);
      var code = total.ok ? (total.paise > 0 ? 'ok' : 'zero') : total.code;
      var okTotal = code === 'ok';
      el.total.setAttribute('aria-invalid', okTotal || code === 'empty' ? 'false' : 'true');
      el.totalHelp.textContent = okTotal ? '' : totalMessages[code];
      el.totalHelp.setAttribute('data-state', okTotal || code === 'empty' ? 'ok' : 'error');

      var T = okTotal ? total.paise : 0;
      var shares = [];
      var bad = -1;
      if (state.mode === 'equal') {
        shares = okTotal ? equalSplit(T, state.n) : new Array(state.n).fill(0);
      } else {
        for (var i = 0; i < state.n; i++) {
          var inp = el.rows.querySelectorAll('input.row__amt')[i];
          var v = parseMoney(inp ? inp.value : '');
          var empty = !v.ok && v.code === 'empty';
          var good = v.ok || empty;
          if (inp) inp.setAttribute('aria-invalid', good ? 'false' : 'true');
          if (!good && bad < 0) bad = i;
          shares.push(v.ok ? v.paise : 0);
        }
      }
      var sum = shares.reduce(function (a, b) { return a + b; }, 0);
      var matched = okTotal && sum === T && bad < 0;
      /* the addition itself, so the last paisa can be checked by eye */
      el.sum.textContent = okTotal && bad < 0 ? (state.n <= 4 ? shares.map(fmt).join(' + ') : state.n + ' shares') + ' = ' + fmt(sum) : '';
      var payer = state.payer;
      var hasPayer = payer >= 0 && payer < state.n;
      var lis = el.rows.children;

      for (var k = 0; k < state.n; k++) {
        var li = lis[k];
        if (state.mode === 'equal') li.querySelector('output').textContent = fmt(shares[k]);
        if (!okTotal || !hasPayer) { noteFor(li, []); continue; }
        if (k === payer) {
          noteFor(li, matched ? ['paid ' + fmt(T) + ', gets back ' + fmt(T - shares[k])] : ['paid ' + fmt(T)]);
        } else if (matched) {
          noteFor(li, shares[k] > 0 ? ['pays ', { name: nameOf(payer) }, ' ' + fmt(shares[k])] : ['owes nothing']);
        } else {
          noteFor(li, []);
        }
      }

      /* the sentence screen readers hear, and the one that blocks a false "settled" */
      if (!okTotal) {
        setStatus('invalid', 'Waiting for a total.', 'Enter an amount above ₹0 to see the split.');
        return;
      }
      if (bad >= 0) {
        setStatus('invalid', 'Check ' + isolate(nameOf(bad)) + '’s amount.', 'Use numbers with up to two decimals.');
        return;
      }
      if (!matched) {
        var diff = T - sum;
        setStatus('mismatch', 'Not settled.', 'Shares are ' + fmt(Math.abs(diff)) + (diff > 0 ? ' short of ' : ' over ') + fmt(T) + '. Change a share until the difference is ₹0.00.');
        return;
      }
      var lead = 'Shares add up to ' + fmt(T) + '.';
      if (!hasPayer) { setStatus('ok', lead, 'Pick who paid to see who owes whom.'); return; }
      var owing = [];
      for (var j = 0; j < state.n; j++) if (j !== payer && shares[j] > 0) owing.push(j);
      var payerName = isolate(nameOf(payer));
      if (owing.length === 0) { setStatus('ok', lead, 'Nothing to settle: ' + payerName + ' covers it.'); return; }
      if (owing.length <= 3) {
        setStatus('ok', lead, owing.map(function (j) { return isolate(nameOf(j)) + ' pays ' + payerName + ' ' + fmt(shares[j]) + '.'; }).join(' '));
      } else {
        var vals = owing.map(function (j) { return shares[j]; });
        var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
        setStatus('ok', lead, owing.length + ' people pay ' + payerName + ', ' + (lo === hi ? fmt(lo) + ' each.' : fmt(lo) + ' to ' + fmt(hi) + ' each.'));
      }
    }

    function sync(full) {
      var c = readCount();
      if (!c.ok) {
        el.sum.textContent = '';
        setStatus('invalid', 'Choose 4 to 12 people here.', 'Pick 2 or 3 above for smaller groups.');
        return;
      }
      var modeNow = modeRadio();
      var changed = c.n !== state.n || modeNow !== state.mode;
      state.n = c.n;
      state.mode = modeNow;
      if (changed || full) {
        if (state.mode === 'custom' && (built.mode !== 'custom' || built.n !== state.n)) prefillCustom(parseMoney(el.total.value));
        buildPayer();
        buildRows();
      }
      var more = peopleRadio() === 'more';
      el.stepper.classList.toggle('is-off', !more);
      if (more) el.stepper.removeAttribute('inert'); else el.stepper.setAttribute('inert', '');
      el.stepDown.disabled = !more || state.n <= 4;
      el.stepUp.disabled = !more || state.n >= 12;
      update();
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); });
    el.total.addEventListener('input', update);
    form.addEventListener('change', function (e) {
      var t = e.target;
      if (t.name === 'people' || t.name === 'mode') {
        if (t.name === 'people' && t.value === 'more' && !/^\d+$/.test(el.count.value)) el.count.value = '4';
        sync(false);
      } else if (t === el.payer) {
        state.payer = Number(el.payer.value);
        update();
      }
    });
    el.count.addEventListener('input', function () { sync(false); });
    el.count.addEventListener('blur', function () { if (!readCount().ok) { el.count.value = String(Math.min(12, Math.max(4, state.n))); sync(false); } });
    el.stepDown.addEventListener('click', function () { el.count.value = String(Math.max(4, state.n - 1)); sync(false); });
    el.stepUp.addEventListener('click', function () { el.count.value = String(Math.min(12, state.n + 1)); sync(false); });
    el.rows.addEventListener('input', function (e) {
      var t = e.target;
      var i = Number(t.getAttribute('data-i'));
      if (t.classList.contains('row__name')) {
        state.names[i] = t.value;
        if (el.payer.options[i]) el.payer.options[i].textContent = nameOf(i);
      } else if (t.classList.contains('row__amt')) {
        state.custom[i] = t.value;
      }
      update();
    });

    /* enable the controls: they ship disabled so the page is honest without script */
    Array.prototype.forEach.call(form.querySelectorAll('[data-needs-js]'), function (n) { n.disabled = false; });
    sync(true);
  }

  /* ---------- staged demos: they play only when the visitor asks, once per press ---------- */
  var demos = document.querySelectorAll('.demo');
  Array.prototype.forEach.call(demos, function (d) {
    var play = d.querySelector('[data-demo-play]');
    var last = d.querySelector('[data-demo-last]');
    if (last) last.addEventListener('animationend', function () {
      if (d.getAttribute('data-state') === 'playing') d.setAttribute('data-state', 'done');
    });
    if (play) play.addEventListener('click', function () {
      if (reduce) return;
      d.setAttribute('data-state', 'ready');
      void d.offsetWidth;
      d.setAttribute('data-state', 'playing');
      play.textContent = 'Replay';
    });
  });

  /* ---------- four ways to share one bill ---------- */
  var ways = document.querySelector('[data-ways]');
  if (ways) {
    var WTOTAL = 100000; /* Rs 1,000.00 in paise */
    var byWeight = function (w) {
      var W = w.reduce(function (a, b) { return a + b; }, 0);
      var out = w.map(function (x) { return Math.floor(WTOTAL * x / W); });
      var left = WTOTAL - out.reduce(function (a, b) { return a + b; }, 0);
      for (var i = 0; left > 0; i++, left--) out[i % out.length]++;
      return out;
    };
    var MODES = {
      equal: { why: 'Everyone pays the same. The extra paisa goes to the first people in the list.', ins: ['equal', 'equal', 'equal'], amt: equalSplit(WTOTAL, 3) },
      exact: { why: 'You enter each amount. The amounts must add up to the bill.', ins: ['entered ' + fmt(60000), 'entered ' + fmt(25000), 'entered ' + fmt(15000)], amt: [60000, 25000, 15000] },
      percent: { why: 'You give each person a percentage. The percentages must add up to 100.', ins: ['45%', '35%', '20%'], amt: byWeight([45, 35, 20]) },
      shares: { why: 'You give each person a number of shares. Asha has 2 of the 4 shares, so she pays half.', ins: ['2 shares', '1 share', '1 share'], amt: byWeight([2, 1, 1]) }
    };
    var wRows = ways.querySelectorAll('.wrows li');
    var wWhy = ways.querySelector('.ways__why');
    var wSum = ways.querySelector('.ways__sum');
    var showWay = function (key) {
      var m = MODES[key];
      wWhy.textContent = m.why;
      Array.prototype.forEach.call(wRows, function (li, i) {
        li.querySelector('.w__in').textContent = m.ins[i];
        li.querySelector('.w__amt').textContent = fmt(m.amt[i]);
        li.querySelector('.w__bar i').style.setProperty('--w', (m.amt[i] / WTOTAL).toFixed(4));
      });
      var total = m.amt.reduce(function (a, b) { return a + b; }, 0);
      wSum.textContent = m.amt.map(fmt).join(' + ') + ' = ' + fmt(total);
    };
    ways.addEventListener('change', function (e) { if (e.target.name === 'way') showWay(e.target.value); });
    Array.prototype.forEach.call(ways.querySelectorAll('[data-needs-js]'), function (n) { n.disabled = false; });
    showWay('equal');
  }

  /* ---------- one bill, from entry to settled: scroll moves the steps, buttons do the same ---------- */
  var jr = document.querySelector('[data-journey]');
  if (jr) {
    var ledger = jr.querySelector('[data-ledger]');
    var jbtns = jr.querySelectorAll('[data-jsteps] button');
    var jnext = jr.querySelector('[data-journey-next]');
    var track = jr.querySelector('.journey__track');
    var FOCUS = { 1: 'exp', 2: 'exp', 3: 'bal', 4: 'pay', 5: 'pay' };
    var step = 5;
    var mode = '';
    var mq = window.matchMedia ? window.matchMedia('(min-width: 60rem) and (min-height: 46rem)') : null;
    var setStep = function (n) {
      step = n;
      ledger.setAttribute('data-step', String(n));
      ledger.setAttribute('data-focus', FOCUS[n]);
      Array.prototype.forEach.call(jbtns, function (b) {
        if (Number(b.getAttribute('data-step')) === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      });
      if (jnext) jnext.textContent = n === 5 ? 'Start over' : 'Next step';
    };
    var span = function () { return track.offsetHeight - window.innerHeight; };
    var fromScroll = function () {
      var s = span();
      if (s <= 0) return;
      var p = Math.min(1, Math.max(0, -track.getBoundingClientRect().top / s));
      var n = Math.min(5, Math.floor(p * 5) + 1);
      if (n !== step) setStep(n);
    };
    var ticking = false;
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; fromScroll(); });
    };
    var apply = function () {
      var m = !('IntersectionObserver' in window) || reduce ? 'static' : (mq && mq.matches ? 'scroll' : 'tap');
      if (m === mode) return;
      mode = m;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      jr.classList.toggle('is-stepped', m !== 'static');
      jr.classList.toggle('is-scroll', m === 'scroll');
      if (jnext) jnext.hidden = m !== 'tap';
      Array.prototype.forEach.call(jbtns, function (b) { b.disabled = m === 'static'; });
      if (m === 'static') {
        ledger.setAttribute('data-step', '5');
        ledger.removeAttribute('data-focus');
        Array.prototype.forEach.call(jbtns, function (b) { b.removeAttribute('aria-current'); });
        step = 5;
      } else {
        setStep(1);
        if (m === 'scroll') {
          window.addEventListener('scroll', onScroll, { passive: true });
          window.addEventListener('resize', onScroll);
          requestAnimationFrame(fromScroll);
        }
      }
    };
    Array.prototype.forEach.call(jbtns, function (b) {
      b.addEventListener('click', function () {
        var n = Number(b.getAttribute('data-step'));
        if (mode === 'scroll') {
          var top = track.getBoundingClientRect().top + window.pageYOffset + ((n - 1) / 5 + 0.02) * span();
          window.scrollTo({ top: top, behavior: 'smooth' });
        } else if (mode === 'tap') {
          setStep(n);
        }
      });
    });
    if (jnext) jnext.addEventListener('click', function () { setStep(step === 5 ? 1 : step + 1); });
    if (mq && mq.addEventListener) mq.addEventListener('change', apply);
    apply();
  }

  /* ---------- hero: the paper sheets behind the calculator drift a few pixels with a mouse; touch and reduced motion get none ---------- */
  var sheets = document.querySelector('[data-sheets]');
  var heroEl = document.querySelector('.hero');
  if (sheets && heroEl && !reduce && window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    var tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    var glide = function () {
      cx += (tx - cx) * 0.12;
      cy += (ty - cy) * 0.12;
      sheets.style.setProperty('--px', cx.toFixed(3));
      sheets.style.setProperty('--py', cy.toFixed(3));
      raf = Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002 ? requestAnimationFrame(glide) : 0;
    };
    heroEl.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      var r = heroEl.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(glide);
    });
    heroEl.addEventListener('pointerleave', function () {
      tx = 0; ty = 0;
      if (!raf) raf = requestAnimationFrame(glide);
    });
  }

  /* ---------- contents list: open on wide screens, closed on phones ---------- */
  var toc = document.querySelector('[data-toc]');
  if (toc && window.matchMedia && window.matchMedia('(min-width: 60rem)').matches) toc.open = true;

  /* ---------- one reveal ---------- */
  var reveals = document.querySelectorAll('[data-reveal]');
  if (reduce || !('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(reveals, function (n) { n.classList.add('is-in'); });
  } else {
    var rio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-in'); rio.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    Array.prototype.forEach.call(reveals, function (n) { rio.observe(n); });
  }
})();
