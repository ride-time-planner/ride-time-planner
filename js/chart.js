/* chart.js — 標高プロファイル(canvas)描画とホバーツールチップ */
const Chart = (() => {
  let cv, ctx, tip, model = null, onHover = null, onFocus = null, view = null;
  const pad = { l: 44, r: 12, t: 12, b: 22 };

  function init(onHoverCb, onFocusCb) {
    cv = document.getElementById('profile');
    ctx = cv.getContext('2d');
    tip = document.getElementById('tooltip');
    onHover = onHoverCb; onFocus = onFocusCb;
    cv.addEventListener('mousemove', handleMove);
    cv.addEventListener('mouseleave', () => { tip.classList.add('hidden'); onHover && onHover(null); });
    cv.addEventListener('click', handleClick); // クリック地点を地図で拡大
    // タッチ操作: なぞってツールチップ、指を置いた地点を地図で拡大
    cv.addEventListener('touchstart', e => { if (e.touches[0]) { handleMove(e.touches[0]); handleClick(e.touches[0]); } }, { passive: true });
    cv.addEventListener('touchmove', e => { if (e.touches[0]) { handleMove(e.touches[0]); e.preventDefault(); } }, { passive: false });
    cv.addEventListener('touchend', () => { tip.classList.add('hidden'); onHover && onHover(null); });
    cv.style.cursor = 'crosshair';
    window.addEventListener('resize', () => { resize(); render(); });
    resize();
  }

  function resize() {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv._w = r.width; cv._h = r.height;
  }

  // model: {points, arrive, startSec} を受け取り保持
  function setData(m) {
    const key = m && m.points && m.points.length ? m.points.length + ':' + m.points[m.points.length - 1].dist.toFixed(1) : null;
    if (key !== dataKey) { view = null; dataKey = key; } // ルートが変わったらズーム解除
    model = m; render();
  }
  let dataKey = null;

  // クリックした地点に対応する座標を地図へ通知（地図側で拡大）
  function handleClick(e) {
    if (!model || !model.points || model.points.length < 2 || !onFocus) return;
    const b = bounds(), rect = cv.getBoundingClientRect();
    const dist = Math.max(b.distMin, Math.min(b.distMax,
      b.distMin + (e.clientX - rect.left - pad.l) / (cv._w - pad.l - pad.r) * (b.distMax - b.distMin)));
    const pts = model.points;
    let i = 1; while (i < pts.length && pts[i].dist < dist) i++;
    const p0 = pts[i - 1], p1 = pts[Math.min(i, pts.length - 1)];
    const r = p1.dist > p0.dist ? (dist - p0.dist) / (p1.dist - p0.dist) : 0;
    onFocus({ lat: p0.lat + r * (p1.lat - p0.lat), lng: p0.lng + r * (p1.lng - p0.lng) });
  }

  function viewRange() {
    const dm = model.points[model.points.length - 1].dist;
    if (!view) return [0, dm];
    return [Math.max(0, view.min), Math.min(dm, view.max)];
  }
  function bounds() {
    const pts = model.points;
    const [lo, hi] = viewRange();
    let eMin = Infinity, eMax = -Infinity;
    for (const p of pts) { if (p.dist >= lo && p.dist <= hi) { eMin = Math.min(eMin, p.ele); eMax = Math.max(eMax, p.ele); } }
    if (!isFinite(eMin)) { eMin = 0; eMax = 10; }
    if (eMax - eMin < 10) eMax = eMin + 10;
    // 上部に少し余白（ピークがラベルや上端に被らないよう）
    eMax += (eMax - eMin) * 0.10;
    return { distMin: lo, distMax: hi, eMin, eMax };
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function themeColors() {
    return {
      route: cssVar('--route') || '#ff5a1f',
      climb: cssVar('--climb') || '#7c5cff',
      poi: cssVar('--poi') || '#2563eb',
      brand: cssVar('--brand') || '#12b981',
      muted: cssVar('--muted') || '#8a8578',
      line: cssVar('--line') || '#e7e3d8'
    };
  }
  function xOf(dist, b) { return pad.l + ((dist - b.distMin) / (b.distMax - b.distMin)) * (cv._w - pad.l - pad.r); }
  function yOf(ele, b) { return cv._h - pad.b - ((ele - b.eMin) / (b.eMax - b.eMin)) * (cv._h - pad.t - pad.b); }

  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, cv._w, cv._h);
    const T = themeColors();
    if (!model || !model.points || model.points.length < 2) {
      ctx.fillStyle = T.muted; ctx.font = '13px ' + (cssVar('--font-body') || 'system-ui');
      ctx.fillText('GPXを読み込むと標高プロファイルを表示します', pad.l, cv._h / 2);
      return;
    }
    const b = bounds(), pts = model.points;

    // 塗り
    ctx.beginPath();
    ctx.moveTo(xOf(b.distMin, b), cv._h - pad.b);
    for (const p of pts) ctx.lineTo(xOf(p.dist, b), yOf(p.ele, b));
    ctx.lineTo(xOf(b.distMax, b), cv._h - pad.b);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.t, 0, cv._h - pad.b);
    grad.addColorStop(0, T.route + '55'); grad.addColorStop(1, T.route + '12');
    ctx.fillStyle = grad; ctx.fill();

    // 稜線
    ctx.beginPath();
    pts.forEach((p, i) => { const x = xOf(p.dist, b), y = yOf(p.ele, b); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = T.route; ctx.lineWidth = 1.8; ctx.stroke();

    // 主要クライム強調（赤）
    (model.climbs || []).forEach((c, idx) => {
      const seg = pts.filter(p => p.dist >= c.startKm && p.dist <= c.endKm);
      if (seg.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(xOf(seg[0].dist, b), cv._h - pad.b);
      for (const p of seg) ctx.lineTo(xOf(p.dist, b), yOf(p.ele, b));
      ctx.lineTo(xOf(seg[seg.length - 1].dist, b), cv._h - pad.b);
      ctx.closePath();
      ctx.fillStyle = '#15803d33'; ctx.fill();
      // 白フチ→緑で稜線と区別（主要クライム）
      ctx.beginPath();
      seg.forEach((p, i) => { const x = xOf(p.dist, b), y = yOf(p.ele, b); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5; ctx.stroke();
      ctx.beginPath();
      seg.forEach((p, i) => { const x = xOf(p.dist, b), y = yOf(p.ele, b); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = '#15803d'; ctx.lineWidth = 3; ctx.stroke();
      // 番号バッジ
      const mid = seg[Math.floor(seg.length / 2)];
      const bx = xOf(mid.dist, b), by = yOf(mid.ele, b) - 10;
      ctx.fillStyle = '#15803d'; ctx.beginPath(); ctx.arc(bx, by, 7, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), bx, by); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    });

    // 軸ラベル
    ctx.fillStyle = T.muted; ctx.font = '10px system-ui'; ctx.textBaseline = 'middle';
    for (let k = 0; k <= 4; k++) {
      const ele = b.eMin + (b.eMax - b.eMin) * k / 4, y = yOf(ele, b);
      ctx.fillText(Math.round(ele) + 'm', 4, y);
      ctx.strokeStyle = T.line; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(cv._w - pad.r, y); ctx.stroke();
    }
    ctx.textBaseline = 'alphabetic';
    for (let k = 0; k <= 5; k++) {
      const d = b.distMin + (b.distMax - b.distMin) * k / 5, x = xOf(d, b);
      ctx.fillText(d.toFixed(0) + 'km', x - 8, cv._h - 6);
    }

    // 経過時間マーカー（○分おき）: 縦線＋時刻ラベル（下側）
    (model.markers || []).forEach(m => {
      if (m.distKm < b.distMin || m.distKm > b.distMax) return;
      const x = xOf(m.distKm, b);
      const col = m.kind === 'start' ? '#16a34a' : m.kind === 'goal' ? '#dc2626' : (T.brand || '#0f766e');
      ctx.strokeStyle = col + (m.kind === 'time' ? '66' : 'aa'); ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, cv._h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.font = (m.kind === 'time' ? '9px' : 'bold 9px') + ' system-ui'; ctx.textAlign = 'center';
      if (m.name) ctx.fillText(m.name, x, cv._h - pad.b - 24);
      ctx.fillText(m.clock, x, cv._h - pad.b - 14);
      ctx.fillStyle = col + '99'; ctx.font = '9px system-ui'; ctx.fillText(m.elapsedStr, x, cv._h - pad.b - 4);
      ctx.textAlign = 'left';
    });

    // 日の出☀/日の入り🌙（ライドが該当時刻を通過する距離に描画）
    (model.sun || []).forEach(ev => {
      if (ev.distKm < b.distMin || ev.distKm > b.distMax) return;
      const x = xOf(ev.distKm, b);
      ctx.strokeStyle = (ev.kind === 'sunrise' ? '#f59e0b' : '#475569') + 'aa'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.t + 14); ctx.lineTo(x, cv._h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ev.kind === 'sunrise' ? '☀' : '🌙', x, pad.t + 8);
      ctx.fillStyle = ev.kind === 'sunrise' ? '#b45309' : '#334155'; ctx.font = '9px system-ui';
      ctx.fillText((ev.kind === 'sunrise' ? '日の出 ' : '日の入り ') + ev.clock, x, pad.t + 20);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    });

    // 滞在ポイント縦線＋ラベル
    (model.stops || []).forEach((s, idx) => {
      if (s.distKm >= 0 && s.distKm <= b.distMax) {
        const x = xOf(s.distKm, b);
        ctx.strokeStyle = T.poi + '99'; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, cv._h - pad.b); ctx.stroke();
        ctx.setLineDash([]);
        const label = (s.label && s.label.trim()) || `P${idx + 1}`;
        ctx.font = '10px system-ui'; ctx.textAlign = 'center';
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = T.poi; roundRect(ctx, x - tw / 2, pad.t, tw, 14, 3); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
        ctx.fillText(label, x, pad.t + 7);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      }
    });
  }

  function handleMove(e) {
    if (!model || !model.points || model.points.length < 2) return;
    const b = bounds();
    const rect = cv.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const dist = Math.max(b.distMin, Math.min(b.distMax, b.distMin + (px - pad.l) / (cv._w - pad.l - pad.r) * (b.distMax - b.distMin)));

    // 距離→点(補間)
    const pts = model.points;
    let i = 1; while (i < pts.length && pts[i].dist < dist) i++;
    const p0 = pts[i - 1], p1 = pts[Math.min(i, pts.length - 1)];
    const r = p1.dist > p0.dist ? (dist - p0.dist) / (p1.dist - p0.dist) : 0;
    const lat = p0.lat + r * (p1.lat - p0.lat);
    const lng = p0.lng + r * (p1.lng - p0.lng);
    const ele = p0.ele + r * (p1.ele - p0.ele);
    const grade = (p1.dist > p0.dist) ? (p1.ele - p0.ele) / ((p1.dist - p0.dist) * 1000) : 0;
    const elapsed = Schedule.timeAtDist(pts, model.arrive, dist);
    const clock = Schedule.fmtClock(model.startSec, elapsed);
    const elapsedStr = Schedule.fmtDur(elapsed);

    // 縦カーソル再描画
    render();
    const cur = cssVar('--brand') || '#2563eb';
    const x = xOf(dist, b), y = yOf(ele, b);
    ctx.strokeStyle = cur; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, cv._h - pad.b); ctx.stroke();
    ctx.fillStyle = cur; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();

    tip.innerHTML = `${dist.toFixed(1)}km ／ 標高 ${Math.round(ele)}m ／ 勾配 ${(grade * 100).toFixed(1)}%<br><b>到達 ${clock}</b> ／ 経過 ${elapsedStr}`;
    tip.classList.remove('hidden');
    // はみ出し防止: 上に余裕がなければ下側に反転、左右は枠内にクランプ
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const below = (y - th - 12) < 0;
    tip.classList.toggle('below', below);
    const left = Math.max(tw / 2 + 2, Math.min(cv._w - tw / 2 - 2, x));
    tip.style.left = left + 'px';
    tip.style.top = y + 'px';
    onHover && onHover({ lat, lng });
  }

  return { init, setData, render, resize };
})();
