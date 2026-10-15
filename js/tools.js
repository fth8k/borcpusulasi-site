// Borç Pusulası web hesaplayıcıları. Hesaplar uygulamadaki ile aynı mantıktır (lib/loanCalculator.ts, lib/accumulationCalculator.ts).
// Veri dosyası kullanmaz; her şey tarayıcıda hesaplanır.
(function () {
  'use strict';
  var BP = (window.BP = {});

  /* ---------- Biçimlendirme ---------- */
  BP.fmt = function (n, d) {
    d = d == null ? 0 : d;
    return n.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  BP.tl = function (n, d) {
    return BP.fmt(n, d == null ? 0 : d) + ' TL';
  };
  BP.pct = function (n, d) {
    return '%' + BP.fmt(n, d == null ? 2 : d);
  };

  // "1.250.000", "3,29", "3.29" → sayı. Boş/geçersizse NaN.
  BP.num = function (s) {
    if (s == null) return NaN;
    s = String(s).replace(/[\s ]/g, '');
    if (!s) return NaN;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d+\.\d{1,2}$/.test(s)) s = s; // 3.29 → ondalık
    else s = s.replace(/\./g, ''); // 1.250.000 → binlik
    var v = Number(s);
    return isFinite(v) ? v : NaN;
  };

  // Tutar kutusu: yazarken binlik nokta ekler (imleç yerinde kalır). data-dec="1" ise virgülle ondalık kabul eder.
  BP.money = function (el) {
    var allowDec = el.getAttribute('data-dec') === '1';
    el.addEventListener('input', function () {
      var pos = el.selectionStart;
      var raw = el.value;
      var before = raw.slice(0, pos).replace(/[^\d,]/g, '').length;
      var clean = raw.replace(allowDec ? /[^\d,]/g : /[^\d]/g, '');
      var parts = clean.split(',');
      var intPart = parts[0].replace(/^0+(?=\d)/, '');
      var dec = parts.length > 1 ? ',' + parts.slice(1).join('').slice(0, 2) : '';
      var grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      el.value = grouped + dec;
      // imleci, soldaki rakam sayısına göre geri koy
      var count = 0, i = 0;
      while (i < el.value.length && count < before) {
        if (/[\d,]/.test(el.value[i])) count++;
        i++;
      }
      try { el.setSelectionRange(i, i); } catch (e) {}
    });
  };

  /* ---------- Kredi ---------- */
  function installment(principal, rate, n) {
    if (rate === 0) return principal / n;
    var f = Math.pow(1 + rate, n);
    return (principal * rate * f) / (f - 1);
  }
  function pvAnnuity(inst, rate, n) {
    if (rate === 0) return inst * n;
    return (inst * (1 - Math.pow(1 + rate, -n))) / rate;
  }
  function solveMonthly(inst, net, n) {
    var lo = 0, hi = 5;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (pvAnnuity(inst, mid, n) > net) lo = mid; else hi = mid;
      if (hi - lo < 1e-9) break;
    }
    return (lo + hi) / 2;
  }
  // in: principal, monthlyRatePercent, termMonths, kkdfPercent, bsmvPercent, originationFee, insuranceFee
  BP.loan = function (inp) {
    var k = inp.kkdfPercent / 100, b = inp.bsmvPercent / 100;
    var r = (inp.monthlyRatePercent / 100) * (1 + k + b);
    var inst = installment(inp.principal, r, inp.termMonths);
    var total = inst * inp.termMonths;
    var cashCost = total - inp.principal;
    var interest = cashCost / (1 + k + b);
    var net = inp.principal - inp.originationFee - inp.insuranceFee;
    var effM = solveMonthly(inst, net, inp.termMonths);
    var ymoM = inp.insuranceFee > 0 ? solveMonthly(inst, inp.principal - inp.originationFee, inp.termMonths) : effM;
    var rows = [], bal = inp.principal;
    for (var m = 1; m <= inp.termMonths; m++) {
      var charge = bal * r;
      var princ = inst - charge;
      bal = m === inp.termMonths ? 0 : bal - princ;
      rows.push({ m: m, inst: inst, principal: princ, charge: charge, balance: Math.max(0, bal) });
    }
    return {
      installment: inst, total: total, cashCost: cashCost, interest: interest, taxes: cashCost - interest,
      net: net, upfront: inp.originationFee + inp.insuranceFee,
      effectiveAnnual: (Math.pow(1 + effM, 12) - 1) * 100, ymoAnnual: (Math.pow(1 + ymoM, 12) - 1) * 100,
      taxInclMonthlyPercent: r * 100, rows: rows
    };
  };

  /* ---------- Birikim ---------- */
  var PER_YEAR = { daily: 365, weekly: 52, monthly: 12 };
  BP.accumulate = function (amount, period, returnPercent, growthPercent, years) {
    var ppy = PER_YEAR[period];
    var rate = returnPercent / 100 / ppy, growth = growthPercent / 100, total = years * ppy;
    var bal = 0, contributed = 0, pts = [{ year: 0, balance: 0, contributed: 0 }];
    for (var i = 0; i < total; i++) {
      var c = amount * Math.pow(1 + growth, Math.floor(i / ppy));
      bal = bal * (1 + rate) + c;
      contributed += c;
      if ((i + 1) % ppy === 0 || (period !== 'monthly' && (i + 1) % Math.round(ppy / 12) === 0)) {
        pts.push({ year: (i + 1) / ppy, balance: bal, contributed: contributed });
      }
    }
    return { futureValue: bal, contributed: contributed, growth: bal - contributed, series: pts };
  };

  /* ---------- Çizgi grafik (SVG) ---------- */
  // series: [{color, points:[[x,y],...]}], opts: {xTicks:[{x,label}], yFmt:function, W, H}
  BP.lineChart = function (svg, series, opts) {
    var W = opts.W || 640, H = opts.H || 260, L = 56, R = 14, T = 12, B = 30;
    var all = [].concat.apply([], series.map(function (s) { return s.points; }));
    var minX = Math.min.apply(null, all.map(function (p) { return p[0]; })), maxX = Math.max.apply(null, all.map(function (p) { return p[0]; }));
    var minY = opts.yMin != null ? opts.yMin : Math.min.apply(null, all.map(function (p) { return p[1]; }));
    var maxY = Math.max.apply(null, all.map(function (p) { return p[1]; }));
    var pad = (maxY - minY || 1) * 0.06;
    if (opts.yMin == null) minY -= pad;
    maxY += pad;
    var sx = function (x) { return L + ((x - minX) / (maxX - minX || 1)) * (W - L - R); };
    var sy = function (y) { return T + (1 - (y - minY) / (maxY - minY || 1)) * (H - T - B); };
    var out = '';
    for (var i = 0; i <= 4; i++) {
      var yv = minY + ((maxY - minY) * i) / 4, y = sy(yv);
      out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" style="stroke:var(--line)" stroke-width="1"/>';
      out += '<text x="' + (L - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + opts.yFmt(yv) + '</text>';
    }
    (opts.xTicks(minX, maxX) || []).forEach(function (t) {
      out += '<text x="' + sx(t.x) + '" y="' + (H - 8) + '" text-anchor="middle">' + t.label + '</text>';
    });
    series.forEach(function (s) {
      out += '<polyline fill="none" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" style="stroke:' + s.color + '" points="' +
        s.points.map(function (p) { return sx(p[0]).toFixed(1) + ',' + sy(p[1]).toFixed(1); }).join(' ') + '"/>';
    });
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = out;
  };

  /* ---------- Yardımcılar ---------- */
  BP.byId = function (id) { return document.getElementById(id); };
  BP.parseDate = function (s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  BP.MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  BP.monthLabel = function (idx) { return BP.MONTHS[idx % 12] + ' ' + Math.floor(idx / 12); };
  BP.dateLabel = function (d) { return d.getDate() + ' ' + BP.MONTHS[d.getMonth()] + ' ' + d.getFullYear(); };
  BP.seg = function (root, onChange) {
    var btns = root.querySelectorAll('button');
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        btns.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        onChange(b.getAttribute('data-v'));
      });
    });
  };
})();
