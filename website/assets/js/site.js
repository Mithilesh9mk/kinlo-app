/* Kinlo site script: split calculator, two staged demos, one reveal. No dependencies, nothing is sent anywhere. */
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

  /* ---------- staged demos ---------- */
  var demos = document.querySelectorAll('.demo');
  Array.prototype.forEach.call(demos, function (d) {
    var pause = d.querySelector('[data-demo-pause]');
    var replay = d.querySelector('[data-demo-replay]');
    var last = d.querySelector('[data-demo-last]');
    var paused = false;
    var visible = false;
    var timer = 0;

    function set(s) { d.setAttribute('data-state', s); }
    function setPaused(p) {
      paused = p;
      d.setAttribute('data-paused', p ? 'true' : 'false');
      if (p) clearTimeout(timer);
      if (pause) { pause.textContent = p ? 'Play' : 'Stop'; pause.setAttribute('aria-pressed', p ? 'true' : 'false'); }
    }
    function play() {
      clearTimeout(timer);
      setPaused(false);
      set('ready');
      void d.offsetWidth;
      set('playing');
    }
    /* the demo loops: after the last frame it rests a moment, then starts again, until the visitor presses Stop */
    function loopSoon() {
      clearTimeout(timer);
      if (paused || !visible) return;
      timer = setTimeout(function () { if (!paused && visible) play(); }, 2400);
    }
    if (last) last.addEventListener('animationend', function () {
      if (d.getAttribute('data-state') === 'playing') { set('done'); loopSoon(); }
    });
    if (pause) pause.addEventListener('click', function () {
      if (paused) {
        setPaused(false);
        if (d.getAttribute('data-state') !== 'playing') play();
      } else {
        setPaused(true);
      }
    });
    if (replay) replay.addEventListener('click', play);

    /* with reduced motion, or no way to tell when it is on screen, show the finished frame and do not animate */
    if (reduce || !('IntersectionObserver' in window)) { set('done'); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        visible = en.isIntersecting;
        if (!visible) { clearTimeout(timer); return; }
        if (!paused && d.getAttribute('data-state') !== 'playing') play();
      });
    }, { threshold: 0.5 });
    io.observe(d);
  });

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
